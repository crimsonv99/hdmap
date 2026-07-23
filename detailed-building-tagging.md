# OSM tags for a detailed (3D) building — mapping guideline

A checklist of the OSM tags to focus on when editing a building so it renders as a
**detailed 3D model** (the F4Map / Simple 3D Buildings look), not a flat box.

Sources:
- Simple 3D Buildings spec — https://wiki.openstreetmap.org/wiki/Simple_3D_Buildings
- F4Map render rules — https://wiki.f4map.com/render

> **Units:** all heights are **metres**, decimals allowed (`height=12.5`). Angles in
> degrees. Colours are a CSS/HTML name (`white`) or hex (`#d9c8a0`).

---

## 0. How a 3D building is built (read this first)

A building = **one outline** + optionally **many parts**:

- **`building=*`** — the whole footprint. Holds the *metadata* (name, address). If any
  parts exist, 3D renderers **ignore the outline shape** and draw the parts instead.
- **`building:part=*`** — sub-polygons inside the outline, each with its own height /
  base / roof / colour. **Stacking parts is how you get tiers, setbacks, a tower on a
  podium, columns.** This is what makes a building "detailed".

So the golden rule: **a plain footprint = a flat box. Detail comes from `building:part`
polygons + roof tags.**

---

## 1. Core tags — every part needs these

| Tag | On | Meaning | Notes / default |
|---|---|---|---|
| `building=*` | outline | The building (e.g. `yes`, `house`, `apartments`, `public`) | Required. Keep name/address here. |
| `building:part=*` | each part | Marks a 3D sub-volume (e.g. `yes`) | Draw one per distinct height/shape/colour. Parts should tile the whole outline. |
| `height=*` | outline or part | Ground → **top of the roof** (metres) | **Best single tag to add.** Excludes antennas/spires. |
| `min_height=*` | part | Height of the part's **bottom** above ground | Use for a part that sits *on top of* another (podium/tower, floating tier). Default `0`. |
| `building:levels=*` | outline or part | Number of floors above ground (façade only, roof floors excluded) | Renderers use **3 m/level** if `height` is absent. Add `height` too when you can. |
| `building:min_level=*` | part | Floors skipped at the bottom (levels analogue of `min_height`) | `min_height` wins if both present. |

**Height math the renderer uses:**
```
total height    = height              (or building:levels × 3 m, else guessed from way id)
wall top        = height − roof:height
part bottom     = min_height          (or building:min_level × 3 m, else 0)
walls           = extruded from part bottom → wall top
roof            = built on top from wall top → height, per roof:shape
```

---

## 2. Roof tags — what turns a box into a shaped roof

| Tag | Meaning | Values / default |
|---|---|---|
| `roof:shape=*` | Roof form | See table below. **Default `flat`.** |
| `roof:height=*` | Height of the roof part alone (m) | Default ≈ **4 m** (skillion = 25% of building height). |
| `roof:angle=*` | Roof pitch in degrees | Alternative to `roof:height`. |
| `roof:levels=*` | Floors *inside* the roof, not counted in `building:levels` | Optional. |
| `roof:orientation=along\|across` | Ridge vs. the **longest side** | `along` = ridge parallel to longest side (**default**); `across` = perpendicular. |
| `roof:direction=*` | Compass bearing the main roof face points (0–360°, or `N`,`SE`…) | For skillion/gabled to aim the slope. |
| `roof:colour=*` | Roof colour | Name or hex. |
| `roof:material=*` | Roof surface | e.g. `roof_tiles`, `metal`, `concrete`, `glass`, `copper`. |

### `roof:shape` values (Simple 3D Buildings)

| Value | Shape |
|---|---|
| `flat` | Level roof (default) |
| `skillion` | Single sloped plane (mono-pitch) |
| `gabled` | Two planes meeting at a ridge |
| `half-hipped` | Gabled with the ends cut back |
| `hipped` | Four slopes to a ridge |
| `pyramidal` | Four+ slopes to a single apex point |
| `gambrel` | Barn roof — two pitches per side |
| `mansard` | Steep lower + shallow upper pitch |
| `dome` | Hemispherical |
| `onion` | Bulbous dome with a point |
| `round` | Cylindrical / barrel |
| `saltbox` | Asymmetric gable, one side longer |

(F4Map also renders `pyramid`, `pitched`, `sawtooth`, and `*_saltbox` variants.)

---

## 3. Appearance tags — colour & material

| Tag | Meaning | Example |
|---|---|---|
| `building:colour=*` | Wall/façade colour | `building:colour=#e8e2d0` or `white` |
| `building:material=*` | Façade material | `brick`, `concrete`, `glass`, `stone`, `wood`, `plaster` |
| `building:facade:material=*` | (F4Map) façade material alias | as above |
| `colour=*` | Generic colour fallback | used if `building:colour` absent |

Special materials that change the look (F4Map): `glass` (reflective), `mirror`, `gold`,
`metal`, `copper`.

Wall suppression: `building=roof` or `wall=no` → renders **roof only, no walls** (canopies,
bandstands, stadium roofs).

---

## 4. Worked examples

**A. Simple house with a pitched roof**
```
building=house
height=8
roof:shape=gabled
roof:height=3
roof:orientation=along
roof:colour=#8b3a2f
building:colour=#e6ddc8
```

**B. Tower on a podium** (two parts — the essential "tiered" pattern)
```
# outline
building=commercial
name=Example Tower

# part 1 — podium (0 → 12 m)
building:part=yes
height=12

# part 2 — tower sitting on the podium (12 → 60 m)
building:part=yes
min_height=12
height=60
roof:shape=flat
```

**C. Monumental tiered building** (mausoleum-style — stacked shrinking parts)
```
# each tier is its own building:part polygon, smaller as it goes up
part A: building:part=yes  height=6                       # base plinth
part B: building:part=yes  min_height=6   height=14       # colonnade body
part C: building:part=yes  min_height=14  height=18  roof:shape=flat   # roof slab
```
Columns = thin `building:part` polygons around the body (min_height/height spanning the
colonnade level). This is why the real mausoleum shows columns in F4Map.

**D. Dome / spire**
```
building:part=yes
min_height=15
height=25
roof:shape=dome        # or onion for a pointed top
roof:material=copper
```

---

## 5. Do / don't (validation checklist)

**Do**
- Prefer a real **`height`** value; use `building:levels` only in addition.
- Give **every part** a `height` (and `min_height` if it's raised).
- Make parts **tile the outline** — no gaps, no overlaps of different heights unless
  intentional (stacked via `min_height`).
- Keep the name/address on the **outline**, not the parts.
- Trace roof shape from imagery; set `roof:orientation`/`roof:direction` so the ridge
  runs the right way.

**Don't**
- Don't put `height` only on the outline when parts exist — parts without height fall
  back to a guess.
- Don't overlap two parts that both start at `min_height=0` — one hides the other.
- Don't use `building:levels` as a substitute for `height` on tall/irregular buildings.
- Don't tag antenna/spire height into `height` (it's roof-top only).

---

## 6. One-line cheat sheet

```
building=*            outline + metadata (name, address)
building:part=*       each 3D sub-volume  ← detail lives here
height=*              ground → roof top (m)      ← add this first
min_height=*          bottom of a raised/stacked part (m)
building:levels=*     floors (×3 m if no height)
roof:shape=*          flat|gabled|hipped|pyramidal|dome|onion|skillion|mansard|…
roof:height=* / roof:angle=*   roof size
roof:orientation=along|across  roof:direction=*   ridge/slope aim
building:colour=* / roof:colour=*   colours (name or #hex)
building:material=* / roof:material=*   surfaces
```
