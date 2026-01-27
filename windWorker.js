
self.onmessage = function(e) {
    const { uValues, vValues, numLats, numLons, timestepIndex } = e.data;
    
    // Create a 32-bit buffer (4 bytes per pixel: R, G, B, A)
    const buffer = new ArrayBuffer(numLats * numLons * 4);
    const data32 = new Uint32Array(buffer);
    const halfLons = numLons / 2;
  
   
    for (let lat = 0; lat < numLats; lat++) {
      const flippedLat = numLats - 1 - lat;
      const rowOffset = flippedLat * numLons;
      const srcRowOffset = lat * numLons;
  
      for (let lon = 0; lon < numLons; lon++) {
        const shiftedLon = (lon + halfLons) % numLons;
        const src = srcRowOffset + lon;
        const dst = rowOffset + shiftedLon; 
        
        const u = uValues[src];
        const v = vValues[src];
  
        if (u === undefined || isNaN(u)) {
          data32[dst] = 0x00000000; // Transparent (RGBA: 0,0,0,0)
          continue;
        }
  
       
        const mag = Math.sqrt(u * u + v * v);
  
        // Encode weather data into colors for the GPU
        const r = Math.round(255 * (u + 20) / 40);
        const g = Math.round(255 * (v + 20) / 40);
        const b = Math.round(255 * Math.min(1, mag / 20));
        const a = 255;
  
        // Pack bytes into a single 32-bit integer (ABGR format for Little Endian)
        data32[dst] = (a << 24) | (b << 16) | (g << 8) | r;
      }
    }
  
    // Send the result back. Transferable [buffer] makes this instant.
    self.postMessage({ 
      buffer, 
      timestepIndex, 
      width: numLons, 
      height: numLats 
    }, [buffer]);
  };