import re

file_path = '/Users/quantan/Desktop/work/code/osm2street/MVP-3D-MAP/index.html'
with open(file_path, 'r') as f:
    content = f.read()

# 1. Update CSS
css_old = r'''  <link href="https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.css" rel="stylesheet" />
  <style>.*?</style>'''

css_new = '''  <link href="https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.css" rel="stylesheet" />
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    html, body { margin: 0; height: 100%; font-family: 'Inter', system-ui, -apple-system, sans-serif; }
    #map { position: absolute; inset: 0; }

    /* Glassmorphism helpers */
    .glass-panel {
      background: rgba(255, 255, 255, 0.75);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid rgba(255, 255, 255, 0.4);
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    }
    .glass-panel-dark {
      background: rgba(18, 22, 30, 0.75);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid rgba(255, 255, 255, 0.1);
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
    }

    /* --- floating search bar --- */
    #search {
      position: absolute; top: 16px; left: 16px; z-index: 5;
      display: flex; gap: 8px; align-items: center;
      border-radius: 24px; padding: 6px 8px 6px 20px;
      width: min(360px, calc(100vw - 32px));
    }
    #search:hover { box-shadow: 0 12px 36px rgba(0, 0, 0, 0.15); transform: translateY(-1px); }
    #search input { border: 0; outline: 0; flex: 1; font-size: 15px; font-weight: 500; background: transparent; color: #1a2430; }
    #search button {
      border: 0; background: linear-gradient(135deg, #2f6bd6, #4f85e5); color: #fff; width: 34px; height: 34px;
      border-radius: 50%; cursor: pointer; font-size: 16px; line-height: 1;
      transition: transform 0.2s, box-shadow 0.2s;
    }
    #search button:hover { transform: scale(1.05); box-shadow: 0 4px 12px rgba(47, 107, 214, 0.4); }
    #search .hint { color: #8a94a3; font-size: 12px; font-weight: 500; }

    /* --- bottom-right view controls --- */
    #controls {
      position: absolute; bottom: 32px; right: 16px; z-index: 5;
      display: flex; flex-direction: column; gap: 10px; align-items: stretch;
    }
    #controls button {
      border: 0; border-radius: 12px; padding: 10px 14px;
      cursor: pointer; font-size: 14px; color: #23303f; font-weight: 600; white-space: nowrap;
    }
    #controls button:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(0,0,0,.15); }
    #controls button.on { background: linear-gradient(135deg, #2f6bd6, #4f85e5); color: #fff; border: none; }

    /* --- navigation: pick-mode hint pill + snapped-point markers --- */
    #nav-hint {
      position: absolute; top: 20px; left: 50%; transform: translateX(-50%);
      z-index: 6; display: none; color: #eef1f6;
      padding: 10px 20px; border-radius: 24px; font-size: 14px; font-weight: 600;
      white-space: nowrap;
    }
    #nav-hint.on { display: block; animation: slideDown 0.3s cubic-bezier(0.4, 0, 0.2, 1); }
    @keyframes slideDown { from { opacity: 0; transform: translate(-50%, -10px); } to { opacity: 1; transform: translate(-50%, 0); } }
    
    #nav-summary {
      position: absolute; bottom: 80px; left: 50%; transform: translateX(-50%);
      z-index: 6; display: none; align-items: center; gap: 12px;
      color: #16202c; border-radius: 16px; padding: 12px 20px;
      font-size: 16px; font-weight: 700; white-space: nowrap;
    }
    #nav-summary.on { display: flex; animation: slideUp 0.3s cubic-bezier(0.4, 0, 0.2, 1); }
    @keyframes slideUp { from { opacity: 0; transform: translate(-50%, 10px); } to { opacity: 1; transform: translate(-50%, 0); } }
    #nav-summary .dist { color: #2f6bd6; font-weight: 800; }
    #nav-summary .sep { opacity: .3; font-weight: 400; }
    #nav-summary .clear { cursor: pointer; color: #8a94a3; border-left: 1px solid rgba(0,0,0,0.1); padding-left: 14px; transition: color 0.2s; }
    #nav-summary .clear:hover { color: #e5484d; }

    /* --- directions panel --- */
    #nav-panel {
      position: absolute; top: 82px; left: 16px; z-index: 7; width: 340px;
      max-height: calc(100% - 210px); display: none; flex-direction: column;
      border-radius: 20px; overflow: hidden; color: #1a2430; font-size: 14px;
    }
    #nav-panel.on { display: flex; animation: slideRight 0.3s cubic-bezier(0.4, 0, 0.2, 1); }
    @keyframes slideRight { from { opacity: 0; transform: translateX(-10px); } to { opacity: 1; transform: translateX(0); } }
    #nav-panel .np-head { padding: 18px 20px 16px; border-bottom: 1px solid rgba(0,0,0,0.06); position: relative; }
    #nav-panel .np-eta { font-size: 26px; font-weight: 800; color: #2f6bd6; background: -webkit-linear-gradient(45deg, #2f6bd6, #00d2ff); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    #nav-panel .np-eta small { font-size: 14px; font-weight: 600; color: #5b6470; margin-left: 8px; -webkit-text-fill-color: #5b6470; }
    #nav-panel .np-sub { margin-top: 4px; color: #5b6470; font-size: 13px; font-weight: 500; }
    #nav-panel .np-hide {
      position: absolute; top: 16px; right: 16px; cursor: pointer; border: 0;
      background: rgba(0,0,0,0.05); width: 30px; height: 30px; border-radius: 50%;
      font-size: 18px; line-height: 1; color: #43506a; font-weight: 700; transition: background 0.2s, transform 0.2s;
    }
    #nav-panel .np-hide:hover { background: rgba(0,0,0,0.1); transform: scale(1.1); }
    #nav-panel .np-od { padding: 12px 20px; border-bottom: 1px solid rgba(0,0,0,0.06); }
    #nav-panel .np-od .row { display: flex; align-items: center; gap: 10px; padding: 4px 0; }
    #nav-panel .np-od .dot { width: 10px; height: 10px; border-radius: 50%; flex: none; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    #nav-panel .np-od .dot.a { background: #22c55e; }
    #nav-panel .np-od .dot.b { background: #ef4444; }
    #nav-panel .np-od .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
    #nav-panel .np-swap { margin-left: auto; cursor: pointer; border: 0; background: none; font-size: 18px; color: #5b6470; transition: transform 0.2s, color 0.2s; }
    #nav-panel .np-swap:hover { color: #2f6bd6; transform: rotate(180deg); }
    #nav-panel .np-steps { overflow-y: auto; padding: 4px 0; }
    #nav-panel .step { display: flex; gap: 14px; padding: 14px 20px; border-bottom: 1px solid rgba(0,0,0,0.03); transition: background 0.2s; }
    #nav-panel .step:hover { background: rgba(0,0,0,0.02); }
    #nav-panel .step .ic { font-size: 20px; line-height: 1.1; color: #2f6bd6; flex: none; width: 24px; text-align: center; }
    #nav-panel .step .tx { flex: 1; line-height: 1.4; font-weight: 500; }
    #nav-panel .step .ds { color: #8a94a3; font-size: 13px; margin-top: 4px; font-weight: 600; }
    #nav-panel .step.arrive .ic { color: #e5484d; }
    #nav-steps-btn {
      position: absolute; top: 82px; left: 16px; z-index: 7; display: none;
      background: linear-gradient(135deg, #2f6bd6, #4f85e5); color: #fff; border: 0; border-radius: 12px;
      padding: 10px 16px; font-weight: 700; font-size: 14px; cursor: pointer;
      box-shadow: 0 4px 14px rgba(47, 107, 214, 0.4); transition: transform 0.2s, box-shadow 0.2s;
    }
    #nav-steps-btn:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(47, 107, 214, 0.5); }
    #nav-steps-btn.on { display: block; animation: slideRight 0.3s ease; }
    #nav-panel .np-go {
      display: block; width: 100%; margin-top: 16px; padding: 12px; border: 0;
      border-radius: 12px; background: linear-gradient(135deg, #10b981, #059669); color: #fff; font-size: 16px;
      font-weight: 800; cursor: pointer; letter-spacing: 0.5px; transition: transform 0.2s, box-shadow 0.2s;
      box-shadow: 0 4px 12px rgba(16, 185, 129, 0.3);
    }
    #nav-panel .np-go:hover { transform: translateY(-2px) scale(1.02); box-shadow: 0 6px 16px rgba(16, 185, 129, 0.4); }

    /* --- 3D drive mode --- */
    #drive-ui { display: none; }
    #drive-ui.on { display: block; }
    #drive-banner {
      position: absolute; top: 20px; left: 50%; transform: translateX(-50%);
      z-index: 8; display: flex; align-items: center; gap: 16px; max-width: 82vw;
      color: #fff; padding: 14px 24px 14px 20px;
      border-radius: 20px;
    }
    #drive-banner .b-ic { font-size: 38px; line-height: 1; color: #4da3ff; flex: none; text-shadow: 0 0 12px rgba(77,163,255,0.4); }
    #drive-banner .b-dist { font-size: 30px; font-weight: 800; flex: none; }
    #drive-banner .b-dist small { font-size: 16px; font-weight: 700; opacity: .85; margin-left: 3px; }
    #drive-banner .b-road { font-size: 19px; font-weight: 700; opacity: .95; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    
    #drive-speed {
      position: absolute; left: 24px; bottom: 100px; z-index: 8; width: 84px; height: 84px;
      border-radius: 50%; color: #16202c;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
    }
    #drive-speed b { font-size: 28px; font-weight: 800; line-height: 1; }
    #drive-speed span { font-size: 11px; font-weight: 700; color: #6b7684; margin-top: 2px; }
    
    #drive-bottom {
      position: absolute; bottom: 24px; left: 50%; transform: translateX(-50%);
      z-index: 8; display: flex; align-items: center; gap: 20px;
      color: #16202c; padding: 12px 18px;
      border-radius: 20px; font-size: 14px;
    }
    #drive-bottom .big { font-size: 20px; font-weight: 800; }
    #drive-bottom .muted { color: #6b7684; font-weight: 500; }
    #drive-bottom button {
      border: 0; background: rgba(0,0,0,0.05); color: #23303f; width: 44px; height: 44px;
      border-radius: 50%; cursor: pointer; font-size: 18px; font-weight: 700;
      transition: background 0.2s, transform 0.2s;
    }
    #drive-bottom button.exit { background: rgba(239, 68, 68, 0.1); color: #ef4444; }
    #drive-bottom button:hover { transform: scale(1.1); background: rgba(0,0,0,0.1); }
    #drive-bottom button.exit:hover { background: rgba(239, 68, 68, 0.2); }
    
    .drive-car { filter: drop-shadow(0 4px 8px rgba(0,0,0,.4)); }
    .nav-pin {
      width: 28px; height: 28px; border-radius: 50% 50% 50% 0;
      transform: rotate(-45deg); border: 2.5px solid #fff;
      box-shadow: 0 2px 8px rgba(0,0,0,.3); cursor: pointer;
      display: grid; place-items: center; transition: transform 0.2s;
    }
    .nav-pin:hover { transform: rotate(-45deg) scale(1.15); }
    .nav-pin b { transform: rotate(45deg); color: #fff; font-size: 13px; font-weight: 800; }
    .nav-pin.a { background: #22c55e; }
    .nav-pin.b { background: #ef4444; }

    /* --- legend / layers card --- */
    #legend {
      position: absolute; bottom: 32px; left: 16px; z-index: 5;
      border-radius: 16px; padding: 14px 16px;
      font-size: 13px; color: #23303f; max-width: 220px; font-weight: 500;
    }
    #legend b { display: block; margin-bottom: 8px; font-size: 13px; font-weight: 700; }
    #legend label { display: flex; align-items: center; gap: 8px; padding: 4px 0; cursor: pointer; transition: opacity 0.2s; }
    #legend label:hover { opacity: 0.8; }
    #legend .sw { width: 14px; height: 14px; border-radius: 4px; flex: none; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }

    /* --- live camera readout --- */
    #readout {
      position: absolute; bottom: 36px; left: 50%; transform: translateX(-50%); z-index: 5;
      color: #e7ecf3; border-radius: 12px;
      padding: 8px 14px; font: 12px/1.4 'Inter', ui-monospace, SFMono-Regular, Menlo, monospace;
      white-space: nowrap; pointer-events: none;
    }
    #readout b { color: #9ec5f0; font-weight: 700; }
    @media (max-width: 640px) { #readout { display: none; } }

    .maplibregl-ctrl-attrib { font-size: 11px; font-family: 'Inter', sans-serif; }

    /* --- dark-mode starfield --- */
    #stars {
      position: absolute; top: 0; left: 0; right: 0; height: 55%; z-index: 1;
      pointer-events: none; opacity: 0; transition: opacity .6s ease;
      -webkit-mask-image: linear-gradient(to bottom, #000 0%, #000 55%, transparent 100%);
      mask-image: linear-gradient(to bottom, #000 0%, #000 55%, transparent 100%);
    }
    #stars.on { opacity: 1; }
    #stars i {
      position: absolute; display: block; background: #eaf6ff; border-radius: 50%;
      box-shadow: 0 0 5px 1px rgba(180,230,255,.8);
    }
  </style>'''
content = re.sub(css_old, css_new, content, flags=re.DOTALL)

# 2. Add glass-panel classes to HTML elements
html_replacements = [
    ('<div id="nav-hint"></div>', '<div id="nav-hint" class="glass-panel-dark"></div>'),
    ('<div id="nav-summary"></div>', '<div id="nav-summary" class="glass-panel"></div>'),
    ('<div id="nav-panel"></div>', '<div id="nav-panel" class="glass-panel"></div>'),
    ('<div id="drive-banner">', '<div id="drive-banner" class="glass-panel-dark">'),
    ('<div id="drive-speed">', '<div id="drive-speed" class="glass-panel">'),
    ('<div id="drive-bottom">', '<div id="drive-bottom" class="glass-panel">'),
    ('<div id="readout">', '<div id="readout" class="glass-panel-dark">'),
    ('<div id="search">', '<div id="search" class="glass-panel">'),
    ('<div id="legend">', '<div id="legend" class="glass-panel">'),
    ('<button id="btn-3d" class="on">', '<button id="btn-3d" class="on glass-panel">'),
    ('<button id="btn-dark" title="Neon night mode">', '<button id="btn-dark" class="glass-panel" title="Neon night mode">'),
    ('<button id="btn-frame">', '<button id="btn-frame" class="glass-panel">'),
    ('<button id="btn-north" title="Reset bearing to north">', '<button id="btn-north" class="glass-panel" title="Reset bearing to north">'),
    ('<button id="btn-route" title="Pick start &amp; destination on the map">', '<button id="btn-route" class="glass-panel" title="Pick start &amp; destination on the map">'),
]

for old, new in html_replacements:
    content = content.replace(old, new)

# 3. Fix 3D tilt bug on fitRoute
content = content.replace('pitch: 0, duration: 700', 'pitch: map.getPitch(), duration: 700')

# 4. Fix Drive mode end-of-route UI bugs
hud_old = '''      const updateHud = (mi) => {
        const man = mans[mi];
        dBanner.querySelector(".b-ic").textContent = TURN_GLYPH[man.turn] || "↑";
        dBanner.querySelector(".b-dist").textContent = fmtDist(Math.max(0, turnAt[mi] - DRIVE.d));
        dBanner.querySelector(".b-road").textContent = man.name || (man.turn === "arrive" ? "Arrive at destination" : "");
        dSpeedEl.textContent = Math.round((mans[Math.max(0, mi - 1)].spd || 8) * 3.6);
        const remainT = DRIVE.timeS * (1 - DRIVE.d / total);
        dBottom.querySelector(".remain").textContent = fmtDur(remainT);
        dBottom.querySelector(".dist").textContent = fmtDist(total - DRIVE.d);
        dBottom.querySelector(".eta").textContent = "Arrive ~" + clockAfter(remainT);
      };'''

hud_new = '''      const updateHud = (mi) => {
        const man = mans[mi];
        dBanner.querySelector(".b-ic").textContent = TURN_GLYPH[man.turn] || "↑";
        dBanner.querySelector(".b-dist").textContent = fmtDist(Math.max(0, turnAt[mi] - DRIVE.d));
        
        const isFinished = DRIVE.d >= total;
        dBanner.querySelector(".b-road").textContent = isFinished ? "Arrived at destination" : (man.name || (man.turn === "arrive" ? "Arrive at destination" : ""));
        dSpeedEl.textContent = isFinished ? "0" : Math.round((mans[Math.max(0, mi - 1)].spd || 8) * 3.6);
        
        const remainT = Math.max(0, DRIVE.timeS * (1 - DRIVE.d / total));
        dBottom.querySelector(".remain").textContent = fmtDur(remainT);
        dBottom.querySelector(".dist").textContent = fmtDist(Math.max(0, total - DRIVE.d));
        dBottom.querySelector(".eta").textContent = isFinished ? "Arrived" : "Arrive ~" + clockAfter(remainT);
      };'''
content = content.replace(hud_old, hud_new)

tick_old = '''        if (DRIVE.d >= total && !DRIVE.paused) { DRIVE.paused = true; dBottom.querySelector(".pause").textContent = "▶"; }
        DRIVE.raf = requestAnimationFrame(tick);'''

tick_new = '''        if (DRIVE.d >= total && !DRIVE.paused) { 
          DRIVE.paused = true; 
          dBottom.querySelector(".pause").textContent = "↺"; 
        }
        DRIVE.raf = requestAnimationFrame(tick);'''
content = content.replace(tick_old, tick_new)

with open(file_path, 'w') as f:
    f.write(content)
print("Updated index.html successfully")
