# Neptune API Guide

Neptune is a lightweight JavaScript 3D game engine that wraps Three.js behind a clean, PICO-8-inspired API. You write everything in a single `main.js` file and never touch Three.js directly.

---

## Contents

1. [Setup](#1-setup)
2. [The Game Loop](#2-the-game-loop)
3. [Asset Loading](#3-asset-loading)
4. [Scene Objects](#4-scene-objects)
5. [NObject — the object interface](#5-nobject--the-object-interface)
6. [Lighting](#6-lighting)
7. [Toon Shading](#7-toon-shading)
8. [Camera](#8-camera)
9. [Input](#9-input)
10. [2D Overlay Drawing](#10-2d-overlay-drawing)
11. [Audio](#11-audio)
12. [Persistence](#12-persistence)
13. [Math & Scene Queries](#13-math--scene-queries)
14. [Advanced Rendering](#14-advanced-rendering)
15. [Escape Hatch](#15-escape-hatch)

---

## 1. Setup

### Installation

```
npm install neptune-engine three
```

Neptune targets **ESM only**. Three.js is a peer dependency — install it separately so you control its version.

### index.html

Provide a single `<canvas>` element. Neptune takes it over.

```html
<!DOCTYPE html>
<html>
  <body>
    <canvas id="game"></canvas>
    <script type="module" src="main.js"></script>
  </body>
</html>
```

For browser-only use (no bundler), add an import map:

```html
<script type="importmap">
{
  "imports": {
    "three":         "https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js",
    "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/",
    "neptune-engine": "./src/neptune.js"
  }
}
</script>
```

### `Neptune.init(config)`

Call once, before anything else.

```js
import Neptune from 'neptune-engine';

Neptune.init({
  canvas:     '#game',    // CSS selector or HTMLCanvasElement. Default: first <canvas> found.
  width:      320,        // Internal render resolution width.
  height:     240,        // Internal render resolution height.
  scale:      'fit',      // 'fit' | 'stretch' | 'pixel'  (see below)
  antialias:  false,      // Smooth edges. Default: false (good for pixel art).
  pixelArt:   true,       // Enables nearest-neighbor texture filtering globally.
  fps:        60,         // Fixed timestep target. Default: 60.
  background: '#1a1a2e',  // Clear color (CSS string).
  debug:      false,      // Enables console warnings for API misuse.
  manualRender: false,    // Set true for split-screen / custom render order.
});
```

**Scale modes:**

| Mode | Behaviour |
|---|---|
| `'fit'` | Scales proportionally to fill the viewport (letterboxed). Default. |
| `'stretch'` | Stretches to fill the viewport exactly. |
| `'pixel'` | Largest integer scale that fits; enables `image-rendering: pixelated`. |

`Neptune.init()` sets up the renderer, scene, and a default perspective camera. Nothing is drawn until `Neptune.start()` is called.

---

## 2. The Game Loop

### `Neptune.start()`

Begins the render/update loop. Call after `init()` (and optionally after `load()`).

```js
Neptune.start();
```

### The Three Callbacks

Assign plain functions to these properties. Neptune calls them for you.

```js
// Called at a fixed 60 Hz. dt is the fixed timestep in seconds (1/60).
Neptune.update = function(dt) {
  // All game logic, physics, and input polling lives here.
};

// Called once per rendered frame, after update.
// Used for 2D overlay drawing (HUD, text, UI).
// The 3D scene renders automatically before draw() unless manualRender is set.
Neptune.draw = function() {
  Neptune.print('SCORE: 0', 4, 4, '#fff');
};
```

`Neptune.setup` is **not called by Neptune** — it is a convention. Define your own setup function and call it explicitly when transitioning game states:

```js
function setupGame() {
  score  = 0;
  player = Neptune.createBox({ w: 1, h: 1, d: 1, color: '#e04040', position: [0, 0.5, 0] });
}
```

### State Machine via Callback Reassignment

Any callback can be replaced at runtime. This is how you switch between title screen, gameplay, pause, etc.

```js
function titleUpdate(dt) {
  if (Neptune.keyPress('Enter')) goToGame();
}
function titleDraw() {
  Neptune.print('PRESS ENTER', 80, 112, '#fff');
}

function gameUpdate(dt) { /* ... */ }
function gameDraw()     { /* ... */ }

function goToGame() {
  setupGame();
  Neptune.update = gameUpdate;
  Neptune.draw   = gameDraw;
}

// Start on the title screen
Neptune.update = titleUpdate;
Neptune.draw   = titleDraw;
Neptune.start();
```

---

## 3. Asset Loading

### `Neptune.load(manifest, onComplete)`

Fetches all assets in the manifest in parallel, then calls `onComplete`. Can be called before `Neptune.start()` or mid-game between levels. The game loop is blocked during loading; a built-in loading screen is shown.

```js
Neptune.load({
  sprites: {
    tiles: { src: 'assets/tileset.png', cellW: 16, cellH: 16 },
    ui:    {
      src: 'assets/ui.png', cellW: 8, cellH: 8,
      regions: {
        healthbar: { x: 0, y: 0, w: 48, h: 8 },
        coin:      { x: 48, y: 0, w: 8,  h: 8 },
      },
    },
  },
  models: {
    player: 'assets/player.glb',
    tree:   { src: 'assets/tree.glb', animations: true },
  },
  sounds: {
    jump: 'assets/jump.wav',
    bgm:  { src: 'assets/theme.ogg', loop: true },
  },
}, () => {
  // All assets ready.
  setupGame();
  Neptune.update = gameUpdate;
  Neptune.draw   = gameDraw;
});

Neptune.start();
```

**Asset types:**

| Key in manifest | Loaded as | Notes |
|---|---|---|
| `sprites.*` | Three.js `Texture` + metadata | Used by `spr()`, `sprRegion()`, `createBillboard()`, materials |
| `models.*`  | GLTF scene + animations | Used by `createModel()` |
| `sounds.*`  | Web Audio `AudioBuffer` | Used by `audio.play()` |

**Rules:**
- Assets are cached by key. Loading an already-loaded key is a no-op.
- If any asset fails (404, parse error), the loop halts and a full-screen error is shown.
- `Neptune.load()` can be called multiple times (e.g., per-level loading).

### Custom Loading Screen

```js
Neptune.loadScreen = () => {
  Neptune.cls('#000');
  Neptune.print('NOW LOADING...', 100, 112, '#fff');
};
```

If not set, Neptune draws a minimal default ("NOW LOADING...").

---

## 4. Scene Objects

All objects are created via Neptune factory functions. You never instantiate `THREE.Mesh` directly.

### `Neptune.createBox(opts)` → `NObject`

```js
const box = Neptune.createBox({
  w: 1, h: 1, d: 1,       // dimensions in world units. Default: 1.
  color:         '#e04040', // flat color. Ignored if spriteSheet is set.
  spriteSheet:   'tiles',   // key of a loaded sprite sheet.
  sprite:        0,         // sprite index within the sheet.
  position:      [0, 0.5, 0],
  rotation:      [0, 45, 0],  // degrees, YXZ order.
  scale:         [1, 1, 1],
  castShadow:    true,
  receiveShadow: true,
});
```

### `Neptune.createSphere(opts)` → `NObject`

```js
const ball = Neptune.createSphere({
  radius: 0.5,
  color:  '#4488cc',
  position: [0, 3, 0],
  castShadow: true,
});
```

### `Neptune.createPlane(opts)` → `NObject`

Creates a flat horizontal plane (rotated -90° on X internally).

```js
const floor = Neptune.createPlane({
  w: 50, h: 50,
  color:         '#888888',
  receiveShadow: true,
});
```

### `Neptune.createModel(key, opts)` → `NObject`

Instantiates a previously loaded GLTF model.

```js
const player = Neptune.createModel('player', {
  position: [0, 0, 0],
  scale:    [1, 1, 1],
});
```

### `Neptune.createBillboard(opts)` → `NObject`

A sprite-textured flat quad that always faces the camera.

```js
// Static billboard
const tree = Neptune.createBillboard({
  spriteSheet: 'sprites',
  sprite:      12,
  width:       1,
  height:      2,
  position:    [5, 1, -3],
  axisLock:    'y',   // 'y' = cylindrical (stays upright). 'none' = full spherical.
});

// Animated billboard — cycles through sprite indices at given fps
const flame = Neptune.createBillboard({
  spriteSheet: 'sprites',
  sprite:      [0, 1, 2, 3],   // frame indices
  fps:         8,
  position:    [0, 0.5, 0],
  axisLock:    'y',
});
```

### `Neptune.createTileSet(definitions)` → tileSet

Defines the visual appearance of tile types for use with `createTilemap`.

```js
const overworldTiles = Neptune.createTileSet({
  1: { color: '#4a7c59' },           // flat color
  2: {
    top:    { sheet: 'tiles', sprite: 4 },  // per-face sprite
    sides:  { sheet: 'tiles', sprite: 5 },
    bottom: { sheet: 'tiles', sprite: 6 },
  },
  3: {
    top:   { sheet: 'tiles', sprite: 7 },
    sides: { color: '#8b6914' },     // mix of sprite and color is valid
  },
});
```

### `Neptune.createTilemap(opts)` → `NObject`

Creates a 3D heightmap from a 2D grid.

```js
Neptune.createTilemap({
  position: [0, 0, 0],  // world-space origin of the map
  tileSize: 1,           // world units per cell

  // Required. 0 = empty cell. Positive = extrude up, negative = extrude down.
  geometry: [
    [0, 1, 1, 2, 0],
    [1, 2, 3, 2, 1],
    [0, 1, 2, 1, 0],
  ],

  // Optional. Same dimensions as geometry. Values are tile type keys in tileSet.
  // If omitted, geometry integer values are used as tile type keys directly.
  appearance: [
    [0, 1, 1, 2, 0],
    [1, 2, 3, 2, 1],
    [0, 1, 2, 1, 0],
  ],

  tileSet: overworldTiles,

  // false   → tiles fill solidly from the base plane up to geometry height.
  // integer → each box is exactly N units thick (good for platforms, overhangs).
  height: false,
});
```

The returned `NObject` represents the whole map — you can reposition, hide, or destroy it like any other object.

---

## 5. NObject — the Object Interface

Every factory function returns an `NObject`. Its `position`, `rotation`, and `scale` are plain JavaScript arrays that write through to Three.js automatically.

### Properties

```js
obj.position        // [x, y, z] — read/write individual indices or assign a new array
obj.rotation        // [x, y, z] in degrees (YXZ Euler) — read/write
obj.scale           // [x, y, z] — read/write
obj.visible         // boolean
obj.tag             // string — used with Neptune.findByTag()

obj.castShadow    = true;
obj.receiveShadow = true;
```

### Modifying position

Both styles work:

```js
// Modify a single axis in-place (common in update loops)
player.position[0] += speed * dt;
player.position[1]  = 0;

// Assign a new position wholesale
player.position = [10, 0, 5];
```

### Methods

```js
// Parenting — child transforms are relative to parent
parent.add(child);
parent.remove(child);

// Sprite swap — changes the displayed sprite cell (for objects using a sprite sheet)
obj.setSprite('tiles', 8);

// Model animation
obj.setAnimation('run', { loop: true });
obj.setAnimation('jump', { loop: false, clampWhenFinished: true });

// Remove from scene and dispose GPU resources
obj.destroy();
```

### Scene Queries

```js
// Find all NObjects with a matching tag
const enemies = Neptune.findByTag('enemy');

// All NObjects currently in the scene
const all = Neptune.findAll();
```

### Tagging Example

```js
const enemy = Neptune.createBox({ color: '#ff0000', position: [5, 0, 0] });
enemy.tag = 'enemy';

// Later, in update():
const enemies = Neptune.findByTag('enemy');
for (const e of enemies) {
  e.position[2] += speed * dt;
}
```

---

## 6. Lighting

### `Neptune.addLight(type, opts)`

```js
// Ambient — uniform fill light, no shadows
Neptune.addLight('ambient', {
  color:     '#ffffff',
  intensity: 0.4,
});

// Directional — parallel rays, good for sunlight
Neptune.addLight('directional', {
  color:      '#ffeedd',
  intensity:  1.0,
  position:   [10, 20, 10],   // direction is from position toward origin
  castShadow: true,
});

// Point — omnidirectional light from a point in space
Neptune.addLight('point', {
  color:     '#ff4400',
  intensity: 2.0,
  position:  [0, 3, 0],
  distance:  10,    // 0 = infinite range
  decay:     2,     // physically-based: use 2
  castShadow: true,
});

// Spot — cone-shaped light
Neptune.addLight('spot', {
  color:     '#ffffff',
  intensity: 1.5,
  position:  [0, 8, 0],
  castShadow: true,
});
```

Shadows are opt-in per light and per object:

```js
const crate = Neptune.createBox({ w: 1, h: 1, d: 1, color: '#886644' });
crate.castShadow    = true;
crate.receiveShadow = true;
```

---

## 7. Toon Shading

Neptune supports cel-shaded rendering via `Neptune.addToonShader()`. It uses Two.js's `MeshToonMaterial` for quantized lighting bands and attaches a back-face hull mesh to each object for silhouette outlines.

> **Note on outlines:** The hull technique draws outlines on the visible silhouette border of each object. Interior face edges (e.g. the crease between the top and front face of a box) are not outlined — that requires screen-space post-processing, which is not currently implemented.

### `Neptune.addToonShader(opts)` → shader descriptor

Creates a reusable shader descriptor. One descriptor can be shared across many objects.

```js
const toon = Neptune.addToonShader({
  outlineColor: '#000000',  // CSS color for the silhouette outline (default: '#000000')
  outlineWidth: 0.04,       // hull inflation as a fraction of object size (default: 0.04)
                            // try 0.02 (subtle) → 0.10 (thick comic-book lines)
  steps: 3,                 // lighting quantization bands (default: 3)
                            // 2 = shadow / highlight only
                            // 3 = shadow / midtone / highlight
                            // 4 = four bands (smoother cel look)
});
```

### `nobj.setShader(shader)`

Applies the descriptor to an NObject. Works on all factory types (`createBox`, `createSphere`, `createModel`, etc.). Existing object color and texture map are preserved.

```js
box.setShader(toon);
```

`setShader` is chainable:

```js
Neptune.createBox({ w: 1, h: 1, d: 1, color: '#e04040', position: [0, 0.5, 0] })
  .setShader(toon);
```

### Full example

```js
// Define shaders once — share across many objects
const toonDefault = Neptune.addToonShader();
const toonBold    = Neptune.addToonShader({ outlineWidth: 0.10, steps: 2 });
const toonSubtle  = Neptune.addToonShader({ outlineWidth: 0.02, steps: 4 });
const toonColored = Neptune.addToonShader({ outlineColor: '#1a0a00', outlineWidth: 0.05, steps: 3 });

// Apply per-object
hero.setShader(toonDefault);
boulder.setShader(toonBold);
foliage.setShader(toonSubtle);
chest.setShader(toonColored);
```

> `MeshToonMaterial` requires scene lighting to show shading bands. Add at least one ambient or directional light, or objects will appear solid black.

---

## 8. Camera

Neptune manages a single camera. You never construct a Three.js camera directly.

### Camera Mode

```js
Neptune.camera.setMode('perspective',  { fov: 75, near: 0.1, far: 1000 });
Neptune.camera.setMode('orthographic', { size: 10, near: 0.1, far: 1000 });
```

### Positioning

```js
Neptune.camera.setPosition(0, 8, 12);
Neptune.camera.lookAt(0, 0, 0);
```

### Direction Helpers

```js
// Yaw-only forward vector [x, 0, z], useful for movement relative to camera facing
const forward = Neptune.camera.forward();
player.position[0] += forward[0] * speed * dt;
player.position[2] += forward[2] * speed * dt;

// Vector to the camera's right
const right = Neptune.camera.right();
```

### Attaching to an Object

```js
// First-person: camera follows object with an offset
Neptune.camera.attachTo(playerObj, { offset: [0, 1.7, 0] });

Neptune.camera.detach();
```

---

## 9. Input

All input is **polled** inside `update()`, not handled via event listeners.

### Keyboard

Key strings follow the Web standard `KeyboardEvent.key` naming.

```js
Neptune.keyDown('ArrowLeft')   // true while the key is held
Neptune.keyPress('Space')      // true on the single frame the key was first pressed
Neptune.keyRelease('Space')    // true on the single frame the key was released
```

Common key names: `'ArrowLeft'`, `'ArrowRight'`, `'ArrowUp'`, `'ArrowDown'`, `'Enter'`, `'Space'` (note: it's `' '` for the literal spacebar — use `' '` or `'Space'` depending on your browser), `'Escape'`, `'Shift'`, `'Control'`, `'a'`–`'z'`.

> **Tip:** Use `keyDown` for continuous movement, `keyPress` for one-shot actions (jump, fire, menu select).

### Gamepad

```js
Neptune.btn(0)       // D-pad left — true while held
Neptune.btn(1)       // D-pad right
Neptune.btn(2)       // D-pad up
Neptune.btn(3)       // D-pad down
Neptune.btn(4)       // A / Cross
Neptune.btn(5)       // B / Circle
Neptune.btn(6)       // X / Square
Neptune.btn(7)       // Y / Triangle
Neptune.btnPress(4)  // true on the single frame button was first pressed
Neptune.btnRelease(4)
```

### Mouse

Mouse behavior is controlled by a **mode**. Set it with `Neptune.mouse.setMode()`.

#### Properties (all modes)

```js
Neptune.mouse.x            // cursor X in internal resolution space
Neptune.mouse.y            // cursor Y in internal resolution space
Neptune.mouse.dx           // raw delta this frame, X
Neptune.mouse.dy           // raw delta this frame, Y
Neptune.mouse.btn(0)       // left button held (0=left, 1=middle, 2=right)
Neptune.mouse.btnPress(0)  // true on the frame the button was first pressed
Neptune.mouse.btnRelease(0)
```

#### Mode: `'gui'` (default)

Standard visible cursor. Use for menus and 2D UI.

```js
Neptune.mouse.setMode('gui');

// Convenience hit-test: true if cursor is in rect AND left-clicked this frame
if (Neptune.mouse.clicked(120, 100, 80, 20)) goToGame();
```

#### Mode: `'firstPerson'`

Neptune requests pointer lock. Mouse delta drives camera yaw and pitch. Do not call `camera.lookAt()` in this mode.

```js
Neptune.mouse.setMode('firstPerson', {
  sensitivity: 1.0,
  invertY:     false,
  pitchLimit:  85,    // degrees — prevents flipping over the pole
});

// Drive movement in update():
const forward = Neptune.camera.forward();
if (Neptune.keyDown('w')) {
  player.position[0] += forward[0] * speed * dt;
  player.position[2] += forward[2] * speed * dt;
}
```

Neptune shows a "CLICK TO CAPTURE MOUSE" prompt until pointer lock is granted. Override it:

```js
Neptune.mouse.capturePrompt = () => {
  Neptune.print('CLICK TO PLAY', 100, 112, '#fff');
};
```

#### Mode: `'thirdPerson'`

Neptune orbits the camera around a target. Mouse movement controls the orbit; scroll wheel zooms.

```js
Neptune.mouse.setMode('thirdPerson', {
  target:      playerObj,   // NObject to orbit, or a fixed [x, y, z]
  distance:    6,
  minDistance: 2,
  maxDistance: 20,
  sensitivity: 1.0,
  invertY:     false,
  pitchLimit:  [5, 80],    // [min, max] degrees from horizontal
  scrollToZoom: true,
});

// In update(), just move the object — the camera follows automatically:
if (Neptune.keyDown('ArrowUp')) {
  const fwd = Neptune.camera.forward();
  player.position[0] += fwd[0] * speed * dt;
  player.position[2] += fwd[2] * speed * dt;
}
```

#### Switching Modes at Runtime

```js
function goToGame()  { Neptune.mouse.setMode('thirdPerson', { target: player }); }
function goToPause() { Neptune.mouse.setMode('gui'); }
```

Neptune handles releasing and re-requesting pointer lock across transitions automatically.

---

## 10. 2D Overlay Drawing

All 2D calls go inside `draw()`. They render onto a canvas composited on top of the 3D scene. Coordinates are in **internal resolution space** (e.g. 0–320, 0–240). Colors are CSS strings throughout.

The overlay is automatically cleared to transparent before each `draw()` call.

### Clear

```js
Neptune.cls();            // clear to transparent (default, called automatically each frame)
Neptune.cls('#000000');   // clear to a solid color
```

### Text

Text is rendered using the Cherry bitmap font (7 px wide × 12 px tall per glyph at default scale).

```js
// Simple string form — white text, default scale
Neptune.print('SCORE: 100', x, y, '#ffffff');

// Options form
Neptune.print('SCORE: 100', x, y, {
  color:       '#fff',
  align:       'left',   // 'left' | 'center' | 'right'
  widthScale:  1,        // integer pixel multiplier for glyph width
  heightScale: 1,        // integer pixel multiplier for glyph height
  bold:        false,    // true = Cherry bold variant
});
```

### Shapes

```js
Neptune.rect    (x, y, w, h, '#ffffff');   // outline rectangle
Neptune.rectFill(x, y, w, h, '#ffffff');   // filled rectangle
Neptune.line    (x0, y0, x1, y1, '#fff');  // line segment
Neptune.circ    (x, y, r, '#ffffff');       // outline circle
Neptune.circFill(x, y, r, '#ffffff');      // filled circle
Neptune.pixel   (x, y, '#ffffff');          // single pixel
```

### Sprites onto the 2D Overlay

```js
Neptune.spr('tiles', 4, x, y);                   // draw one sprite cell
Neptune.spr('tiles', 4, x, y, { w: 2, h: 2 });  // span 2×2 cells
Neptune.sprRegion('ui', 'healthbar', x, y);       // draw a named region
```

---

## 11. Audio

All sounds must be loaded via `Neptune.load()` before use.

```js
// Play a sound effect (fire-and-forget; same sound can overlap itself)
Neptune.audio.play('jump');
Neptune.audio.play('jump', { volume: 0.8 });

// Music (looping — defined in the manifest with loop: true)
Neptune.audio.play('bgm');       // no-op if already playing
Neptune.audio.stop('bgm');
Neptune.audio.setVolume('bgm', 0.4);   // 0.0 – 1.0

// Global volume
Neptune.audio.setMasterVolume(0.5);
Neptune.audio.mute();
Neptune.audio.unmute();
```

---

## 12. Persistence

Simple key-value store backed by `localStorage`. Values can be any JSON-serialisable type.

```js
// Write
Neptune.save('highscore', 4200);
Neptune.save('settings', { volume: 0.5, fullscreen: true });

// Read — second argument is the default value if the key does not exist
const hi  = Neptune.loadData('highscore', 0);
const cfg = Neptune.loadData('settings', { volume: 1.0 });

// Delete
Neptune.deleteSave('highscore');

// Check existence
if (Neptune.hasSave('highscore')) { /* ... */ }
```

> **Note:** Use `Neptune.loadData()` (not `Neptune.load()`) to retrieve persisted values. The names are intentionally different to avoid collision with asset loading.

All data is automatically scoped to the page origin by `localStorage`.

---

## 13. Math & Scene Queries

### `Neptune.math`

```js
Neptune.math.lerp (a, b, t)      // linear interpolation
Neptune.math.clamp(v, min, max)  // clamp v between min and max
Neptune.math.rnd  (n)            // random float 0 … n
Neptune.math.rndi (n)            // random integer 0 … n-1
Neptune.math.vec3 (x, y, z)      // returns [x, y, z]
Neptune.math.dist3(a, b)         // distance between two [x,y,z] arrays
```

### `Neptune.raycast(origin, direction, opts)`

Casts a ray from `origin` in `direction` and returns the first hit, or `null`.

```js
const hit = Neptune.raycast(
  [0, 5, 0],        // origin [x, y, z]
  [0, -1, 0],       // direction [x, y, z] (normalised internally)
  {
    maxDist: 20,
    filter: (obj) => obj.tag === 'ground',  // optional — return false to exclude
  }
);

if (hit) {
  console.log(hit.object);    // NObject
  console.log(hit.point);     // [x, y, z] world-space hit position
  console.log(hit.distance);  // number
}
```

### `Neptune.screenToWorld(screenX, screenY, depth)`

Converts a 2D screen point to a 3D world position.

```js
const worldPos = Neptune.screenToWorld(mouse.x, mouse.y, 0);
```

### Scene queries

```js
Neptune.findByTag('enemy')  // → NObject[]
Neptune.findAll()            // → NObject[] (all objects currently in the scene)
```

---

## 14. Advanced Rendering

### Manual 3D Rendering

By default Neptune renders the 3D scene automatically before each `draw()`. For split-screen or custom render order, enable `manualRender` and call `Neptune.render3d()` yourself:

```js
Neptune.init({ width: 320, height: 240, manualRender: true, ... });

Neptune.draw = () => {
  // Player 1 — top half
  Neptune.viewport(0, 0, 320, 120);
  Neptune.camera.setPosition(-5, 4, 8);
  Neptune.render3d();

  // Player 2 — bottom half
  Neptune.viewport(0, 120, 320, 120);
  Neptune.camera.setPosition(5, 4, 8);
  Neptune.render3d();

  // Reset viewport for 2D overlay
  Neptune.viewport(0, 0, 320, 240);
  Neptune.print('P1', 4,   4, '#fff');
  Neptune.print('P2', 4, 124, '#fff');
};
```

### `Neptune.viewport(x, y, w, h)`

Sets the render region and scissor rect. Coordinates are in internal resolution space.

```js
Neptune.viewport(0, 0, 320, 240);   // full canvas (reset)
Neptune.viewport(0, 0, 160, 240);   // left half
```

---

## 15. Escape Hatch

If you need direct Three.js access for something Neptune does not expose, use:

```js
Neptune._three.scene     // THREE.Scene
Neptune._three.renderer  // THREE.WebGLRenderer
Neptune._three.camera    // THREE.Camera (current)
Neptune._three.THREE     // the THREE namespace itself
```

The underscore prefix is intentional — prefer Neptune's API wherever possible. If you find yourself reaching for `_three` frequently, consider opening an issue.

---

## Quick-Start Example

```js
import Neptune from 'neptune-engine';

Neptune.init({
  width: 320, height: 240,
  scale: 'fit',
  background: '#1a1a2e',
  debug: true,
});

let player, score;

function setupGame() {
  score = 0;

  Neptune.addLight('ambient',     { intensity: 0.5 });
  Neptune.addLight('directional', { position: [5, 10, 5], intensity: 1, castShadow: true });

  Neptune.createBox({ w: 20, h: 0.5, d: 20, color: '#334455',
                      position: [0, -0.25, 0], receiveShadow: true });

  player = Neptune.createBox({ w: 1, h: 1, d: 1, color: '#e04040',
                               position: [0, 0.5, 0], castShadow: true });
  player.tag = 'player';

  Neptune.camera.setPosition(0, 8, 12);
  Neptune.camera.lookAt(0, 0, 0);
}

function gameUpdate(dt) {
  const speed = 5;
  if (Neptune.keyDown('ArrowLeft'))  player.position[0] -= speed * dt;
  if (Neptune.keyDown('ArrowRight')) player.position[0] += speed * dt;
  if (Neptune.keyDown('ArrowUp'))    player.position[2] -= speed * dt;
  if (Neptune.keyDown('ArrowDown'))  player.position[2] += speed * dt;

  player.rotation[1] += 90 * dt;
  score++;
}

function gameDraw() {
  Neptune.rectFill(0, 0, 320, 12, 'rgba(0,0,0,0.6)');
  Neptune.print(`SCORE  ${score}`, 4, 2, '#ffdd44');
}

setupGame();
Neptune.update = gameUpdate;
Neptune.draw   = gameDraw;
Neptune.start();
```

---

*Neptune API Guide — corresponds to engine v0.1.0 / design doc v0.2.*
