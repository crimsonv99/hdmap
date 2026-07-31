import re

file_path = '/Users/quantan/Desktop/work/code/osm2street/MVP-3D-MAP/index.html'
with open(file_path, 'r') as f:
    content = f.read()

# 1. Add makeCarGeoJSON helper right before // DRIVE STATE
make_car_helper = '''
    // --- 3D Car GeoJSON Generator ---
    const makeCarGeoJSON = (lngLat, heading) => {
      // Dimensions (meters)
      const L = 4.2, W = 1.9; // Chassis
      const cL = 2.2, cW = 1.5, cOffset = -0.4; // Cabin (shifted back)
      
      const rad = heading * Math.PI / 180;
      const fwdX = Math.sin(rad), fwdY = Math.cos(rad);
      const rightX = Math.cos(rad), rightY = -Math.sin(rad);

      // 1 degree of lat is ~111320 meters.
      const latFac = 1 / 111320;
      const lngFac = 1 / (111320 * Math.cos(lngLat[1] * Math.PI / 180));

      const getCoord = (fwdM, rightM) => [
        lngLat[0] + (fwdX * fwdM + rightX * rightM) * lngFac,
        lngLat[1] + (fwdY * fwdM + rightY * rightM) * latFac
      ];

      const makeRect = (len, wid, offFwd) => [[
        getCoord(len/2 + offFwd, wid/2), getCoord(len/2 + offFwd, -wid/2),
        getCoord(-len/2 + offFwd, -wid/2), getCoord(-len/2 + offFwd, wid/2),
        getCoord(len/2 + offFwd, wid/2)
      ]];

      return {
        type: "FeatureCollection",
        features: [
          { type: "Feature", geometry: { type: "Polygon", coordinates: makeRect(L, W, 0) }, properties: { color: "#e81a24", height: 0.65, base: 0 } }, // Body (Red)
          { type: "Feature", geometry: { type: "Polygon", coordinates: makeRect(cL, cW, cOffset) }, properties: { color: "#1a2430", height: 1.35, base: 0.65 } } // Cabin (Dark glass)
        ]
      };
    };

    // DRIVE STATE
'''
content = content.replace('    // DRIVE STATE', make_car_helper)

# 2. Add source and layer setup inside DRIVE init (replace carEl and Marker logic)
car_init_old = '''    const carEl = () => {
      const d = document.createElement("div");
      d.className = "drive-car";
      const img = document.createElement("img");
      // trimmed top-view car (858x1633); keep aspect ratio so it isn't squashed
      img.src = "image/car.png"; img.width = 30; img.height = 57; img.alt = "";
      // fallback to a simple SVG car if car.png isn't present
      img.onerror = () => {
        d.innerHTML = `<svg width="40" height="40" viewBox="0 0 36 36">
          <rect x="11" y="5" width="14" height="26" rx="5" fill="#2f6bd6" stroke="#fff" stroke-width="1.6"/>
          <rect x="13.5" y="8" width="9" height="6" rx="2" fill="#cfe0f7"/>
          <rect x="13.5" y="21" width="9" height="5" rx="2" fill="#1b4a8f"/></svg>`;
      };
      d.appendChild(img);
      return d;
    };'''

car_init_new = '''    const setupCarLayer = (pos, heading) => {
      if (!map.getSource("drive-car-src")) {
        map.addSource("drive-car-src", { type: "geojson", data: makeCarGeoJSON(pos, heading) });
        map.addLayer({
          id: "drive-car-body",
          type: "fill-extrusion",
          source: "drive-car-src",
          paint: {
            "fill-extrusion-color": ["get", "color"],
            "fill-extrusion-height": ["get", "height"],
            "fill-extrusion-base": ["get", "base"],
            "fill-extrusion-opacity": 1.0
          }
        });
      } else {
        map.getSource("drive-car-src").setData(makeCarGeoJSON(pos, heading));
      }
    };'''
content = content.replace(car_init_old, car_init_new)

marker_remove = '      if (DRIVE.car) { DRIVE.car.remove(); DRIVE.car = null; }'
marker_remove_new = '''      // if (DRIVE.car) { DRIVE.car.remove(); DRIVE.car = null; }
      if (map.getLayer("drive-car-body")) map.removeLayer("drive-car-body");
      if (map.getSource("drive-car-src")) map.removeSource("drive-car-src");'''
content = content.replace(marker_remove, marker_remove_new)

# In the tick loop, replace DRIVE.car.setLngLat(s.pos);
tick_update_old = '        DRIVE.car.setLngLat(s.pos);'
tick_update_new = '        map.getSource("drive-car-src").setData(makeCarGeoJSON(s.pos, s.heading));'
content = content.replace(tick_update_old, tick_update_new)

# In btnGo.onclick, replace DRIVE.car = new maplibregl.Marker ...
marker_init_old = '      DRIVE.car = new maplibregl.Marker({ element: carEl(), anchor: "center" }).setLngLat(s0.pos).addTo(map);'
marker_init_new = '      setupCarLayer(s0.pos, s0.heading);'
content = content.replace(marker_init_old, marker_init_new)

with open(file_path, 'w') as f:
    f.write(content)
print("Updated index.html successfully")
