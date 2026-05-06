# Neptune.js — Claude working notes

## What this is

A PICO-8-inspired, browser-side 3D game engine. Wraps Three.js with a simple, flat API exposed as a single default export (`Neptune`). ESM only, no build step, no bundler. Peer dep: `three >=r150`.

## File map

| File | Role |
|---|---|
| `src/neptune.js` | Entire engine — ~2000 lines, one ES module |
| `src/cherry-font.js` | **Generated** — do not edit. Re-generate with `node src/parse-bdf.js` |
| `src/parse-bdf.js` | Parses `cherry-12-r.bdf` + `cherry-12-b.bdf` → `cherry-font.js` |
| `src/cherry-12-r.bdf` | Cherry bitmap font source, regular, 7×12 px, 192 glyphs |
| `src/cherry-12-b.bdf` | Cherry bitmap font source, bold |
| `demo1.js` | Demo / manual test harness — update when public API changes |
| `index.html` | Loads Three.js from CDN + `demo1.js` as `type="module"` |

## neptune.js internal layout (by line range)

```
1–11    imports (three, cherry-font)
12–54   helpers: warn(), _vec3(), etc.
55–93   module-level state (_config, _overlayCtx, _threeScene, …)
94–230  NObject class (wraps Three.js objects)
231–280 sprite-sheet helpers
281–400 Camera object
401–525 Mouse object
526–621 Audio object
622–678 Math helpers
679–721 Scaling / canvas setup (_overlayCtx created here)
722–780 Input setup
781–839 Camera update
840–868 Loading / error screens (_drawLoadingScreen, _drawErrorScreen)
866–892 Billboard orientation
893–964 Main loop (requestAnimationFrame, fixed-update, draw callback)
965–1091 Asset loading (Neptune.load)
1020–1091 Tilemap
1092–1165 2D overlay helpers  ← most edits land here
1166+   Neptune public API object
```

## 2D overlay rendering — key facts

Two canvases exist: the Three.js renderer canvas + a transparent overlay canvas on top (`_overlayCtx`). All 2D draw calls write to the overlay. It is cleared to transparent automatically before each `draw()` call.

**Coordinate space:** internal resolution (e.g. 320×240), not screen pixels. CSS scaling handles the physical size.

**Private helpers (1092–1165):**

- `_ctx()` — returns `_overlayCtx`
- `_color(c)` — normalises a color arg (string or `{color}` object) to a CSS string
- `_plotLine(ctx, x0,y0,x1,y1)` — Bresenham line, pixel-perfect
- `_plotCircle(ctx, cx,cy,r)` — midpoint circle outline, pixel-perfect
- `_plotCircleFill(ctx, cx,cy,r)` — scanline-filled circle, pixel-perfect
- `_printBitmap(ctx, text, x, y, widthScale, heightScale, bold)` — Cherry font renderer

**Pattern every 2D public method follows:**
```js
ctx.save();
ctx.fillStyle = _color(color);   // or strokeStyle for rect
// call private helper or fillRect directly
ctx.restore();
```

**Do not** use the Canvas path API (`arc`, `lineTo`, `stroke`) for any primitive — it antialiases. All primitives are pixel-perfect via `fillRect`.

## Cherry font

- 7 px wide × 12 px tall per glyph, monospace
- `CHERRY_R` / `CHERRY_B` from `cherry-font.js`: `{ [codePoint]: [12 row bytes] }`
- Each byte: MSB = leftmost pixel, 7 significant bits, 8th bit is padding
- To test bit at column `c` (0–6) in row byte `b`: `(b >> (7 - c)) & 1`
- Covers code points 0–255 (192 glyphs defined)
- Unknown characters fall back to code point 32 (space)

## `Neptune.print` signature (current)

```js
Neptune.print(text, x, y, style = {})
// style: { color, align ('left'|'center'|'right'), widthScale, heightScale, bold }
// or pass a CSS color string directly as style
// font kwarg does NOT exist — Cherry is the only font
```

## Conventions

- Public API lives on the `Neptune` object literal starting at line 1166.
- Private helpers are module-scope functions above the `Neptune` object.
- `demo1.js` is the manual test — keep its `Neptune.print` calls free of `font:` kwargs.
- `cherry-font.js` is always generated; never edit it by hand.
