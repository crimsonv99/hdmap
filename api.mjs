import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs/promises';

import { Router } from './router.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8100;

// Initialize Router
const navRouter = new Router();
const graphPath = path.join(__dirname, 'data', 'graph.json');
navRouter.load(graphPath).then(() => console.log('[API] Routing graph loaded into memory')).catch(err => console.error('Failed to load routing graph', err));

// API Keys Database (In-Memory MVP)
let apiKeys = {};
const keysPath = path.join(__dirname, 'keys.json');

async function loadKeys() {
  try {
    const data = await fs.readFile(keysPath, 'utf8');
    apiKeys = JSON.parse(data);
    console.log('[API] Loaded API Keys');
  } catch (err) {
    console.error('[API] Failed to load keys.json', err);
  }
}
loadKeys();

// Authentication Middleware
const authenticateKey = async (req, res, next) => {
  // Only protect /api routes
  if (!req.path.startsWith('/api/')) return next();
  if (req.method === 'OPTIONS') return next();

  const key = req.query.key;
  if (!key || !apiKeys[key]) {
    return res.status(401).json({ error: 'Unauthorized: Missing or invalid API key. Pass ?key=YOUR_KEY' });
  }

  const keyData = apiKeys[key];
  if (keyData.usage >= keyData.limit) {
    return res.status(429).json({ error: 'Too Many Requests: Usage limit exceeded for this API key.' });
  }

  keyData.usage += 1;
  
  // Save to disk asynchronously
  fs.writeFile(keysPath, JSON.stringify(apiKeys, null, 2)).catch(err => console.error('Failed to save keys', err));

  next();
};

// Middleware
app.use(cors()); // Allow cross-origin requests for the API
app.use(express.json());
app.use(authenticateKey);

// ----------------------------------------------------------------------------
// TILE MAP API
// ----------------------------------------------------------------------------
// Endpoint to serve uncompressed vector tiles. 
// In the future, you can add authentication middleware here to check API keys.
app.get('/api/tiles/:z/:x/:y', async (req, res) => {
  const { z, x, y } = req.params;
  
  // ensure it ends with .pbf (MapLibre sometimes drops it in the template)
  const filename = y.endsWith('.pbf') ? y : `${y}.pbf`;
  const tilePath = path.join(__dirname, 'tiles', z, x, filename);

  try {
    const stat = await fs.stat(tilePath);
    if (!stat.isFile()) throw new Error('Not a file');

    // Send the uncompressed PBF tile
    res.set({
      'Content-Type': 'application/x-protobuf',
      'Content-Length': stat.size,
      'Cache-Control': 'public, max-age=86400', // Cache for 1 day
      'Access-Control-Allow-Origin': '*'
    });
    
    res.sendFile(tilePath);
  } catch (err) {
    console.error(`[API] Tile not found: ${z}/${x}/${filename}`);
    res.status(404).json({ error: 'Tile not found' });
  }
});

// ----------------------------------------------------------------------------
// NAVIGATION DATA API
// ----------------------------------------------------------------------------
// Endpoint to serve the routing graph.
app.get('/api/graph', async (req, res) => {
  try {
    res.set('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour
    res.sendFile(graphPath);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load graph data' });
  }
});

// ----------------------------------------------------------------------------
// SERVER-SIDE ROUTING
// ----------------------------------------------------------------------------
app.get('/api/route', (req, res) => {
  const { startLat, startLng, endLat, endLng } = req.query;
  
  if (!startLat || !startLng || !endLat || !endLng) {
    return res.status(400).json({ error: 'Missing startLat, startLng, endLat, or endLng parameters' });
  }

  const route = navRouter.route(Number(startLng), Number(startLat), Number(endLng), Number(endLat));
  
  if (route && route.error) {
    return res.status(400).json(route);
  }

  res.json(route);
});

// ----------------------------------------------------------------------------
// SERVE FRONTEND (For testing)
// ----------------------------------------------------------------------------
// We still serve the static files so you can test index.html locally.
app.use(express.static(__dirname));

app.listen(PORT, () => {
  console.log(`=========================================`);
  console.log(`🗺️  Tile Map & Navigation API Started`);
  console.log(`=========================================`);
  console.log(`API Endpoints:`);
  console.log(`  - Tiles: http://localhost:${PORT}/api/tiles/{z}/{x}/{y}.pbf`);
  console.log(`  - Graph: http://localhost:${PORT}/api/graph`);
  console.log(`Frontend running at: http://localhost:${PORT}/index.html`);
});
