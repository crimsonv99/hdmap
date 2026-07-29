import fs from 'fs/promises';
import path from 'path';

// --- turn-by-turn helpers ---
const bearingDeg = (a, b) => {
  const R = Math.PI / 180;
  const y = Math.sin((b[0] - a[0]) * R) * Math.cos(b[1] * R);
  const x = Math.cos(a[1] * R) * Math.sin(b[1] * R) - Math.sin(a[1] * R) * Math.cos(b[1] * R) * Math.cos((b[0] - a[0]) * R);
  return (Math.atan2(y, x) / R + 360) % 360;
};
const COMPASS = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];
const compassDir = (brg) => COMPASS[Math.round(brg / 45) % 8];

const classifyTurn = (delta) => {
  const ad = Math.abs(delta), side = delta > 0 ? "right" : "left";
  if (ad < 20) return { turn: "straight", text: "Continue straight" };
  if (ad < 45) return { turn: "slight-" + side, text: "Slight " + side };
  if (ad <= 135) return { turn: side, text: "Turn " + side };
  if (ad < 160) return { turn: "sharp-" + side, text: "Sharp " + side };
  return { turn: "uturn", text: "Make a U-turn" };
};

const buildManeuvers = (legs) => {
  if (!legs.length) return [];
  const TH = 22;
  const f = legs[0];
  const startBrg = bearingDeg(f.ge[0], f.ge[1]);
  const M = [{ turn: "depart", instruction: `Head ${compassDir(startBrg)}${f.name ? " on " + f.name : ""}`, name: f.name, dist: 0, spd: f.spd }];
  let cur = M[0];
  for (let i = 1; i < legs.length; i++) {
    const prev = legs[i - 1], leg = legs[i], pg = prev.ge, lg = leg.ge;
    const inB = bearingDeg(pg[pg.length - 2], pg[pg.length - 1]);
    const outB = bearingDeg(lg[0], lg[1]);
    const delta = ((outB - inB + 540) % 360) - 180;
    cur.dist += prev.len;
    const bigTurn = Math.abs(delta) >= TH;
    const rename = prev.name && leg.name && prev.name !== leg.name;
    if (bigTurn || rename) {
      const c = classifyTurn(delta);
      const instruction = bigTurn ? `${c.text}${leg.name ? " onto " + leg.name : ""}` : `Continue onto ${leg.name}`;
      cur = { turn: bigTurn ? c.turn : "continue", instruction, name: leg.name, dist: 0, spd: leg.spd };
      M.push(cur);
    }
  }
  cur.dist += legs[legs.length - 1].len;
  M.push({ turn: "arrive", instruction: "Arrive at destination", name: null, dist: 0 });
  return M;
};

class MinHeap {
  constructor() { this.h = []; }
  size() { return this.h.length; }
  push(item, prio) {
    const h = this.h; h.push({ item, prio }); let i = h.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (h[p].prio <= h[i].prio) break; [h[p], h[i]] = [h[i], h[p]]; i = p; }
  }
  pop() {
    const h = this.h, top = h[0], last = h.pop();
    if (h.length) { h[0] = last; let i = 0; const n = h.length;
      for (;;) { let l = 2 * i + 1, r = l + 1, m = i;
        if (l < n && h[l].prio < h[m].prio) m = l;
        if (r < n && h[r].prio < h[m].prio) m = r;
        if (m === i) break; [h[m], h[i]] = [h[i], h[m]]; i = m; } }
    return top.item;
  }
}

const ETA_SPEED_KMH = {
  motorway: 65, trunk: 45, primary: 30, secondary: 26, tertiary: 22,
  unclassified: 20, residential: 18, living_street: 8, service: 10,
  busway: 20, ladder: 6,
  motorway_link: 45, trunk_link: 30, primary_link: 22,
  secondary_link: 20, tertiary_link: 18,
};

export class Router {
  constructor() {
    this.graph = null;
    this.adj = null;
    this.speed = null;
    this.etaSpeed = null;
  }

  async load(graphPath) {
    const data = await fs.readFile(graphPath, 'utf8');
    const g = JSON.parse(data);
    this.graph = g;
    const fallback = (g.meta.speeds_kmh.residential || 30) / 3.6;
    this.speed = g.classes.map((c) => (g.meta.speeds_kmh[c] ? g.meta.speeds_kmh[c] / 3.6 : fallback));
    const etaFallback = ETA_SPEED_KMH.residential / 3.6;
    this.etaSpeed = g.classes.map((c, i) => Math.min(this.speed[i], (ETA_SPEED_KMH[c] || ETA_SPEED_KMH.residential) / 3.6) || etaFallback);
    
    const adj = new Map();
    const link = (from, to, e, len, cls) => {
      let arr = adj.get(from);
      if (!arr) { arr = []; adj.set(from, arr); }
      arr.push({ to, e, len, cls });
    };
    g.edges.forEach((ed, e) => {
      const a = ed[0], b = ed[1], len = ed[2], cls = ed[3], oneway = ed[4];
      if (oneway === 0 || oneway === 1) link(a, b, e, len, cls); // a->b
      if (oneway === 0 || oneway === 2) link(b, a, e, len, cls); // b->a
    });
    this.adj = adj;
  }

  nodeLngLat(i) { return [this.graph.nodes[i * 2], this.graph.nodes[i * 2 + 1]]; }
  
  fullGeom(e) {
    const ed = this.graph.edges[e], n = this.graph.nodes;
    const pts = [[n[ed[0] * 2], n[ed[0] * 2 + 1]]];
    for (let i = 6; i < ed.length; i += 2) pts.push([ed[i], ed[i + 1]]);
    pts.push([n[ed[1] * 2], n[ed[1] * 2 + 1]]);
    return pts;
  }

  snap(lng, lat) {
    const g = this.graph, n = g.nodes, edges = g.edges;
    const mx = Math.cos(lat * Math.PI / 180);
    let bestD2 = Infinity, bE = -1, bLng = 0, bLat = 0;
    for (let e = 0; e < edges.length; e++) {
      const ed = edges[e];
      let plng = n[ed[0] * 2], plat = n[ed[0] * 2 + 1];
      const nInt = (ed.length - 6) / 2;
      for (let k = 0; k <= nInt; k++) {
        const clng = k < nInt ? ed[6 + k * 2] : n[ed[1] * 2];
        const clat = k < nInt ? ed[6 + k * 2 + 1] : n[ed[1] * 2 + 1];
        const ax = (plng - lng) * mx, ay = plat - lat;
        const dx = (clng - plng) * mx, dy = clat - plat;
        const len2 = dx * dx + dy * dy;
        let t = len2 > 0 ? -(ax * dx + ay * dy) / len2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const cx = ax + dx * t, cy = ay + dy * t;
        const d2 = cx * cx + cy * cy;
        if (d2 < bestD2) { bestD2 = d2; bE = e; bLng = plng + (clng - plng) * t; bLat = plat + (clat - plat) * t; }
        plng = clng; plat = clat;
      }
    }
    const ed = edges[bE];
    const da = (n[ed[0] * 2] - bLng) ** 2 + (n[ed[0] * 2 + 1] - bLat) ** 2;
    const db = (n[ed[1] * 2] - bLng) ** 2 + (n[ed[1] * 2 + 1] - bLat) ** 2;
    return { e: bE, lng: bLng, lat: bLat, node: da <= db ? ed[0] : ed[1], distM: Math.round(Math.sqrt(bestD2) * 111320) };
  }

  route(startLng, startLat, endLng, endLat) {
    if (!this.graph) return { error: 'Graph not loaded' };
    
    const sA = this.snap(startLng, startLat);
    const sB = this.snap(endLng, endLat);
    
    if (sA.distM > 150 || sB.distM > 150) {
        return { error: 'Start or end point is too far from a road.' };
    }

    const g = this.graph, adj = this.adj, speed = this.speed, etaSpeed = this.etaSpeed;
    const start = sA.node, goal = sB.node;
    if (start === goal) return { error: 'Start and goal are the same node' };
    const gx = g.nodes[goal * 2], gy = g.nodes[goal * 2 + 1];
    const maxSpeed = Math.max(...speed);
    const serviceIdx = g.classes.indexOf("service");
    const penalty = g.meta.service_penalty || 4;
    const h = (nid) => {
      const x = g.nodes[nid * 2], y = g.nodes[nid * 2 + 1];
      const mx = Math.cos(y * Math.PI / 180);
      const dx = (x - gx) * mx * 111320, dy = (y - gy) * 111320;
      return Math.hypot(dx, dy) / maxSpeed;
    };
    const gScore = new Map([[start, 0]]);
    const came = new Map();
    const closed = new Set();
    const open = new MinHeap();
    open.push(start, h(start));
    let found = false;
    while (open.size()) {
      const cur = open.pop();
      if (cur === goal) { found = true; break; }
      if (closed.has(cur)) continue;
      closed.add(cur);
      const nbrs = adj.get(cur);
      if (!nbrs) continue;
      const gc = gScore.get(cur);
      for (const nb of nbrs) {
        if (closed.has(nb.to)) continue;
        const spd = speed[nb.cls] || maxSpeed;
        let cost = nb.len / spd;
        if (nb.cls === serviceIdx) cost *= penalty;
        const ng = gc + cost;
        if (ng < (gScore.get(nb.to) ?? Infinity)) {
          gScore.set(nb.to, ng);
          came.set(nb.to, { prev: cur, e: nb.e });
          open.push(nb.to, ng + h(nb.to));
        }
      }
    }
    if (!found) return { error: 'No route found' };
    
    const seq = [];
    for (let n = goal; came.has(n); ) { const c = came.get(n); seq.push({ e: c.e, from: c.prev }); n = c.prev; }
    seq.reverse();
    
    const legs = seq.map((s) => {
      const ed = g.edges[s.e];
      const ge = this.fullGeom(s.e);
      if (s.from === ed[1]) ge.reverse();
      return { e: s.e, ge, len: ed[2], cls: ed[3], name: ed[5] >= 0 ? g.names[ed[5]] : null,
               spd: etaSpeed[ed[3]] || speed[ed[3]] || maxSpeed,
               w: g.wayids[s.e], dir: s.from === ed[0] ? "Fwd" : "Back" };
    });
    
    const coords = []; let distM = 0, timeS = 0;
    for (const l of legs) {
      const g2 = coords.length ? l.ge.slice(1) : l.ge;
      for (const p of g2) coords.push(p);
      distM += l.len;
      timeS += l.len / (etaSpeed[l.cls] || speed[l.cls] || maxSpeed);
    }
    
    coords.unshift([sA.lng, sA.lat]);
    coords.push([sB.lng, sB.lat]);
    
    return { nodes: seq.length + 1, coords, distM, timeS: Math.round(timeS), maneuvers: buildManeuvers(legs),
             legWays: legs.map((l) => ({ w: String(l.w), dir: l.dir, len: l.len })) };
  }
}
