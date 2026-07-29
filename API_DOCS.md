# 3D Map & Navigation API Documentation

This document outlines the API endpoints available on the backend server (`api.mjs`).

## Base URL
When running locally, the base URL is: `http://localhost:8100`

---

## 1. Vector Tiles API
Serves uncompressed Mapbox Vector Tiles (.pbf) containing the HD lane geometry, markings, and 3D buildings.

**Endpoint:** 
`GET /api/tiles/:z/:x/:y.pbf`

**Parameters:**
- `z`: Zoom level
- `x`: X coordinate
- `y`: Y coordinate

**Response:**
Returns raw binary protocol buffer (`application/x-protobuf`) data for rendering in MapLibre/Mapbox GL JS.

**Example Request:**
```bash
curl -I http://localhost:8100/api/tiles/18/208089/115440.pbf
```

---

## 2. Navigation Route API
Computes the shortest-time path between two coordinates using realistic urban speeds and returns turn-by-turn maneuvers.

**Endpoint:** 
`GET /api/route`

**Query Parameters:**
- `startLng` (float, required): Longitude of the start point
- `startLat` (float, required): Latitude of the start point
- `endLng` (float, required): Longitude of the destination
- `endLat` (float, required): Latitude of the destination

**Response (JSON):**
- `nodes` (int): Number of nodes traversed
- `coords` (array): Array of `[lng, lat]` coordinates for drawing the route line
- `distM` (int): Total route distance in meters
- `timeS` (int): Estimated time of arrival (ETA) in seconds
- `maneuvers` (array): List of turn-by-turn instructions
  - `turn` (string): The type of turn (e.g., "depart", "left", "slight-right", "continue", "arrive")
  - `instruction` (string): Human-readable turn instruction
  - `name` (string | null): The name of the street
  - `dist` (int): Distance to travel on this maneuver before the next turn
  - `spd` (float): Effective speed limit in m/s

**Example Request:**
```bash
curl -s "http://localhost:8100/api/route?startLng=105.852&startLat=21.031&endLng=105.845&endLat=21.025"
```

---

## 3. Raw Graph Data API
Serves the full, unclipped routing graph. This is primarily used by clients that want to execute routing entirely in the browser.

**Endpoint:** 
`GET /api/graph`

**Response (JSON):**
Returns the complete graph data including nodes, edges, street names, and highway classifications.

**Example Request:**
```bash
curl -s http://localhost:8100/api/graph | head -c 200
```
