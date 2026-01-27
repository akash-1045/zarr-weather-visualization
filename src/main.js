import { map as Lmap, tileLayer } from "leaflet";
import "leaflet/dist/leaflet.css";
import * as WeatherLayers from "weatherlayers-gl";
import { LeafletLayer } from "deck.gl-leaflet";
import { MapView } from "@deck.gl/core";
import { ClipExtension } from "@deck.gl/extensions";
import {
  TemperaturePalette,
  RainPalette,
  PressurePalette,
} from "./themePalettes";
import * as zarr from "zarrita";

// Initialize the worker from the external file
const windWorker = new Worker(
  new URL('/windWorker.js', import.meta.url),
  { type: 'module' }
)
const pendingRequests = new Map();

const initialView = { lat: 20.5937, lng: 78.9629, zoom: 3 };
const bounds = [-180, -85.051129, 180, 85.051129];

const clipBounds = [-181, -85.051129, 181, 85.051129];

function getDate() {
  const params = new URLSearchParams(window.location.search);
  const dateString = params.get("date");

  return dateString ? dateString : new Date().toISOString().split("T")[0];
}

document.getElementById("date-picker").value = getDate();

const storeUrl =
  "https://storage.googleapis.com/weather-next/input/20251105_00hr_01_preds/predictions.zarr";

let zarrStore,
  zarrRoot,
  zarrData = {};

let availableTimesteps = [];
let availableDates = [];
let currentDatetime;
let scopedTimesteps = [];
let timelineControl;
let selectedVariable = "temperature";
let windEnabled = true;

const zarrCache = {
  temperature: new Map(),
  rain: new Map(),
  wind: new Map(),
  pressure: new Map(),
};

function extractUniqueDates(datetimes) {
  return [...new Set(datetimes.map((dt) => dt.split("T")[0]))];
}


let selectedRangeDays = 1;

function getTimestepsForDate(startDateString) {

  const start = new Date(startDateString);
  const startTime = start.getTime();

  // Calculate the end time based on the range (e.g., 2 days = 48 hours)
  // Formula: start + (days * 24 hours * 60 mins * 60 secs * 1000 ms)
  const endTime = startTime + selectedRangeDays * 24 * 60 * 60 * 1000;


  return availableTimesteps.filter((dt) => {
    const itemTime = new Date(dt).getTime();
    return itemTime >= startTime && itemTime <= endTime;
  });
}

function datetimeToIndex(datetime) {
  return availableTimesteps.indexOf(datetime);
}

function convertDatetimeData(datetimeArray) {
  return Array.from(datetimeArray).map((nanoseconds) => {
    const milliseconds = Number(nanoseconds / BigInt(1000000));
    return new Date(milliseconds).toISOString();
  });
}

// Listen for the results coming BACK from the worker
windWorker.onmessage = (e) => {
  const { buffer, timestepIndex, width, height } = e.data;

  if (pendingRequests.has(timestepIndex)) {
    const resolve = pendingRequests.get(timestepIndex);

    // Send the final texture data back to the calling function
    resolve({
      data: new Uint8Array(buffer),
      width: width,
      height: height,
    });

    pendingRequests.delete(timestepIndex);
  }
};

async function loadZarrData() {
  zarrStore = await zarr.withConsolidated(new zarr.FetchStore(storeUrl));
  zarrRoot = await zarr.open(zarrStore, { kind: "group" });

  for (const variable of ["datetime", "lat", "lon"]) {
    const handle = await zarr.open(zarrRoot.resolve(variable), {
      kind: "array",
    });
    const data = await zarr.get(handle);
    zarrData[variable] = { handle, data: data.data, shape: data.shape };
  }

  availableTimesteps = convertDatetimeData(zarrData.datetime.data);

  availableDates = extractUniqueDates(availableTimesteps);

  const dataVars = [
    "2m_temperature",
    "10m_u_component_of_wind",
    "10m_v_component_of_wind",
    "total_precipitation_6hr",
    "mean_sea_level_pressure",
  ];

  for (const variable of dataVars) {
    const handle = await zarr.open(zarrRoot.resolve(variable), {
      kind: "array",
    });
    zarrData[variable] = {
      handle,
      shape: handle.shape,
      chunks: handle.chunks,
      dtype: handle.dtype,
      attrs: handle.attrs,
    };
  }

}

function setupDatePicker() {

  const picker = document.getElementById("date-picker");
  if (!availableDates.length) return;

  picker.min = availableDates[0];
  picker.max = availableDates[availableDates.length - 1];
  picker.value = availableDates[0];

  picker.addEventListener("change", async (e) => {
    const url = new URL(window.location.href);
    url.searchParams.set("date", e.target.value);
    window.history.pushState({}, "", url);
    await onDateChange(e.target.value);
  });
}

async function onDateChange(date) {
  scopedTimesteps = getTimestepsForDate(date);

  if (scopedTimesteps.length === 0) return;

  currentDatetime = scopedTimesteps[0];

  if (timelineControl) {
    timelineControl.remove();
  }

  const start_dt = new Date(scopedTimesteps?.[0]);
  const end_dt = new Date(scopedTimesteps?.at(-1));
  let hourlyDatetimes = [];
  for (
    let d = new Date(start_dt);
    d <= end_dt;
    d.setUTCHours(d.getUTCHours() + 1)
  ) {
    hourlyDatetimes.push(new Date(d).toISOString());
  }

  timelineControl = createTimelineControl(hourlyDatetimes);
  timelineControl.addTo(document.getElementById("timeline-controls"));

  await update();
}

async function zarrDataToRGBA(variableName, timestepIndex = 0) {
  const variable = zarrData[variableName];
  if (!variable?.handle || timestepIndex === -1) return null;

  if (!zarrCache[selectedVariable]) {
    throw new Error(`Unknown variable: ${selectedVariable}`);
  }
  const cache = zarrCache[selectedVariable];

  if (cache.has(timestepIndex)) return cache.get(timestepIndex);

  const lat = zarrData.lat.data;
  const lon = zarrData.lon.data;

  const slice = await zarr.get(variable.handle, [
    zarr.slice(timestepIndex, timestepIndex + 1),
    zarr.slice(null),
    zarr.slice(null),
  ]);

  const values = slice.data;
  const latDim = lat.length;
  const lonDim = lon.length;

  let min = Infinity,
    max = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!isNaN(v)) {
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
  }
  if (min === max) max += 0.001;

  const rgba = new Uint8ClampedArray(latDim * lonDim * 4);
  for (let latIdx = 0; latIdx < latDim; latIdx++) {
    const flippedLat = latDim - 1 - latIdx;
    for (let lonIdx = 0; lonIdx < lonDim; lonIdx++) {
      const shiftedLon = (lonIdx + lonDim / 2) % lonDim;
      const src = latIdx * lonDim + lonIdx;
      const dst = (flippedLat * lonDim + shiftedLon) * 4;

      const v = values[src];
      if (isNaN(v)) {
        rgba[dst + 3] = 0;
        continue;
      }
      const t = (v - min) / (max - min);
      const c = Math.round(t * 255);
      rgba[dst] = c;
      rgba[dst + 1] = 0;
      rgba[dst + 2] = 0;
      rgba[dst + 3] = 255;
    }
  }

  const texture = { data: rgba, width: lonDim, height: latDim };
  cache.set(timestepIndex, texture);
  return texture;
}

async function createWindTexture(timestepIndex = 0) {

  const uField = zarrData["10m_u_component_of_wind"];
  const vField = zarrData["10m_v_component_of_wind"];


  if (!uField?.handle || !vField?.handle || timestepIndex === -1) return null;
  if (zarrCache.wind.has(timestepIndex))
    return zarrCache.wind.get(timestepIndex);

  // Fetch raw Zarr data slices (Fast Network I/O)
  const [uSlice, vSlice] = await Promise.all([
    zarr.get(uField.handle, [
      zarr.slice(timestepIndex, timestepIndex + 1),
      null,
      null,
    ]),
    zarr.get(vField.handle, [
      zarr.slice(timestepIndex, timestepIndex + 1),
      null,
      null,
    ]),
  ]);

  const numLats = uField.shape[1];
  const numLons = uField.shape[2];

  // Delegate the heavy math to the Worker
  const textureData = await new Promise((resolve) => {
    pendingRequests.set(timestepIndex, resolve);

    windWorker.postMessage(
      {
        uValues: uSlice.data,
        vValues: vSlice.data,
        numLats,
        numLons,
        timestepIndex,
      },
      [uSlice.data.buffer, vSlice.data.buffer]
    ); 
  });

  zarrCache.wind.set(timestepIndex, textureData);
  return textureData;
}

const map = Lmap(document.getElementById("map"), {
  worldCopyJump: true,
}).setView([initialView.lat, initialView.lng], initialView.zoom);

const deckLayer = new LeafletLayer({
  views: [new MapView({ repeat: true })],
  layers: [],
});
map.addLayer(deckLayer);

map.addLayer(tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"));


async function update() {

  try {
    if (!currentDatetime || availableTimesteps.length === 0) return;

    const startDatetime = WeatherLayers.getClosestStartDatetime(
      availableTimesteps,
      currentDatetime
    );
    const endDatetime = WeatherLayers.getClosestEndDatetime(
      availableTimesteps,
      currentDatetime
    );
    const imageWeight = WeatherLayers.getDatetimeWeight(
      startDatetime,
      endDatetime,
      currentDatetime
    );

    const startIndex = availableTimesteps.indexOf(startDatetime);
    const endIndex = availableTimesteps.indexOf(endDatetime);


    const layers = [];

    if (selectedVariable === "temperature") {
      const t1 = await zarrDataToRGBA("2m_temperature", startIndex);
      const t2 = await zarrDataToRGBA("2m_temperature", endIndex);
      if (t1 && t2)
        layers.push(
          createRasterLayer(t1, t2, imageWeight, TemperaturePalette, "temp")
        );
    }

    if (selectedVariable === "rain") {
      const r1 = await zarrDataToRGBA("total_precipitation_6hr", startIndex);
      const r2 = await zarrDataToRGBA("total_precipitation_6hr", endIndex);
      if (r1 && r2)
        layers.push(
          createRasterLayer(r1, r2, imageWeight, RainPalette, "rain")
        );
    }
    if (selectedVariable === "pressure") {
      const r1 = await zarrDataToRGBA("mean_sea_level_pressure", startIndex);
      const r2 = await zarrDataToRGBA("mean_sea_level_pressure", endIndex);
      if (r1 && r2)
        layers.push(
          createRasterLayer(r1, r2, imageWeight, PressurePalette, "pressure")
        );
    }

    if (windEnabled) {
      const w1 = await createWindTexture(startIndex);
      const w2 = await createWindTexture(endIndex);
      if (w1 && w2) layers.push(createWindLayer(w1, w2, imageWeight));
    }

    deckLayer.setProps({ layers });
  } finally {
    
  }
}

function createRasterLayer(texture, texture2, weight, palette, id) {
  return new WeatherLayers.RasterLayer({
    id: `${id}-raster`,
    image: texture,
    image2: texture2,
    imageWeight: weight,
    bounds,
    palette,
    extensions: [new ClipExtension()],
    clipBounds,
    opacity: 0.8,
  });
}

function createWindLayer(w1, w2, weight) {
  return new WeatherLayers.ParticleLayer({
    id: "wind",
    image: w1,
    image2: w2,
    imageWeight: weight,
    bounds,
    imageType: "VECTOR",
    imageUnscale: [-127, 128],
    fadeIn: true,
    numParticles: 5000,
    maxAge: 15,
    extensions: [new ClipExtension()],
    clipBounds,
  });
}

function createTimelineControl(datetimes) {
  return new WeatherLayers.TimelineControl({
    datetimes,
    datetime: datetimes[0],
    onPreload: (dts) =>
      dts.map(async (dt) => {
        const idx = datetimeToIndex(dt);

        if (selectedVariable === "temperature")
          await zarrDataToRGBA("2m_temperature", idx);
        if (selectedVariable === "rain")
          await zarrDataToRGBA("total_precipitation_6hr", idx);
        if (selectedVariable === "pressure")
          await zarrDataToRGBA("mean_sea_level_pressure", idx);

        if (windEnabled) await createWindTexture(idx);
      }),
    onUpdate: async (dt) => {
      currentDatetime = dt;
      await update();
    },
  });
}

async function init() {
  zarrCache.temperature.clear();
  zarrCache.wind.clear();
  zarrCache.rain.clear();
  zarrCache.pressure.clear();

  await loadZarrData();
  setupDatePicker();

  const params = new URLSearchParams(window.location.search);
  const initialDate = params.get("date") || availableDates[0];

  await onDateChange(initialDate);
}

document.getElementById("variable-selector").addEventListener("change", (e) => {
  selectedVariable = e.target.value;
  update();
});

document.getElementById("wind-checkbox").addEventListener("change", (e) => {
  windEnabled = e.target.checked;
  update();
});

init();
