# hdmap: Staging Editor & JOSM Integration Plan

This plan details the transformation of the `hdmap` tool from an instant-apply live previewer into a professional changeset-based staging editor. It incorporates auto-fetching from Overpass based on map view, staging edits locally in the browser, and automating the push into JOSM for final upload to OpenStreetMap.

## 1. Seed Data via UI (Auto-BBox)
- Add a new "Fetch OSM Data" button in the map's UI panel.
- When clicked, it grabs the map's current bounding box (based on where you have zoomed/panned). - but this will change late when we have internal DB PBF file, saved in postgresql (postgis).
- It sends this to a new backend endpoint (`POST /api/fetch`).
- The backend fetches the raw XML from the Overpass API, saves it to `live/current.osm`, and triggers `osm2streets` to rebuild the HD map layers.

## 2. Staging Edits Locally (Browser State)
- Introduce a `pendingEdits` object in the frontend's JavaScript state to temporarily hold changes.
- Change the existing "Apply & preview" button in the lane tag editor to say **"Stage Edit"**.
- Clicking "Stage Edit" will save the changes into the `pendingEdits` memory and close the editor panel, but it will **not** send an API request to the backend yet.
- *Note: Because the HD geometry is generated on the Node.js backend, staged edits will not visually update on the map until the entire changeset is submitted. Show for the preview to let editor where or which feature they have edited, make those have colorful color*

## 3. Changeset Submission (Batch Write)
- Add a new global button: **"Submit Changeset"** (which shows the count of staged edits).
- Clicking this button bundles all `pendingEdits` into a single JSON payload and sends it to a new backend endpoint (`POST /api/changeset`).
- The backend loops through all edited ways, replaces their tags, adds `action="modify"`, and writes everything to `live/current.osm` in one go.
- The backend then rebuilds the HD map layers, and the browser visually updates.

## 4. JOSM Remote Control Automation
- Expose `live/current.osm` over the local web server so JOSM can fetch it via HTTP.
- As soon as the changeset submission is successful, the browser will automatically execute a background fetch request to JOSM's Remote Control API:
  `http://localhost:8111/import?url=http://localhost:8097/live/current.osm`
- This forces JOSM to instantly open your modified file.
- A success message will appear in the UI reminding you to review the data in JOSM and click "Upload".

*(Note: To use Step 4, you must have JOSM running on your machine with the Remote Control feature enabled in preferences).*
