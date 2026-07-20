# hdmap — Run / Task Log

Chronological record of what was actually changed in the code for the 3D phase.
Newest entries on top. Each entry: date, task id(s) from [`tasks.md`](tasks.md), files
touched, what changed, how it was verified, and anything left open.

Plan: [`plan.md`](plan.md) §5 · Task breakdown: [`tasks.md`](tasks.md)

---

## Template (copy for each work session)

```
## YYYY-MM-DD — <short title>
- Tasks: <e.g. 1.1, 1.2>
- Files: <paths touched>
- Changes:
  - <what changed, in code terms — functions/layers/props>
- Verified:
  - <how it was checked: served locally, orbited camera, clicked a lane, etc.>
- Open / follow-ups:
  - <anything deferred, decisions needed, known artifacts>
```

---

## 2026-07-17 — Planning docs created (no code yet)
- Tasks: —
- Files: `plan.md`, `tasks.md`, `runtasklog.md`
- Changes:
  - Added `plan.md` §5 "3D / 2.5D Visualization (Next Phase)" — strategy, the
    `layer`-is-not-height caveat, tiers, and a risk-ordered sequence.
  - Created `tasks.md` — detailed Phase 0–5 breakdown with acceptance criteria and open
    decisions.
  - Created this log.
- Verified:
  - Docs only; no runtime change. Existing 2D viewer untouched.
- Open / follow-ups:
  - Start Phase 0.1 (confirm `bridge`/`tunnel` reach the GeoJSON) before writing height
    rules.
  - Awaiting go-ahead to implement Phase 1 (pitch/sky) + Phase 2 (building extrusions),
    the low-risk chunk.
