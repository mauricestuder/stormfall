# Stormfall

A fast-paced browser battle royale built with Three.js and TypeScript: drop from the plane, loot, fight bots
(or friends online) and be the last one standing as the storm closes in. Fast movement (sprint, slide, slide-jump,
grappling hook, ziplines), an all-in-one island with cities, towns, labs, a prison, an airport, a castle, mines
and more.

## Play

Open `Stormfall.html` in a browser — it is the whole game in one file.

## Develop

```bash
npm install
npm run dev        # dev server on http://localhost:5173
npm run share      # build the single-file Stormfall.html
```

Build options:
- `THEME=world|western|military|park|default` picks the island (default: `world`, the all-in-one map).
- `STYLE=ink|toon` builds an art-style test (`Stormfall-style-<style>.html`).
