# Neptune — JavaScript 3D Game Engine
## Design Document v0.2

---

## 1. Overview

Neptune is a lightweight JavaScript game engine for building small-to-medium 3D indie games in the browser. It wraps Three.js entirely, exposing a clean, PICO-8-inspired API so that a developer can build a complete game in a single `main.js` file without ever touching Three.js directly.

**Core design values:**
- **Simple by default.** The happy path is very short. A working game loop is a dozen lines.
- **Opinionated structure.** Neptune makes architectural decisions for the developer (scene graph management, camera setup, asset pipeline) so they don't have to.
- **60 FPS contract.** All update logic runs against a fixed 60 Hz timestep. Neptune handles the accumulator; the developer writes deterministic update functions.
- **Escape hatches are explicit.** Raw Three.js access is intentionally absent from the public API. If it is later deemed necessary, it will be exposed through a single, clearly-marked `Neptune._three` namespace so misuse is obvious.

---

## 2. Dependencies

| Package | Role | Notes |
|---|---|---|
| `three` | Scene rendering, geometry, materials, lighting | Sole required peer dependency |

Neptune targets **ESM only**. Three.js is a **peer dependency** — the developer installs it separately, ensuring they control its version.

```
npm install neptune-engine three
```

```js
// main.js
import Neptune from 'neptune-engine';
```

---

## 3. Project Structure (Developer Side)

A minimal Neptune project:

```
my-game/
├── index.html        ← contains a single <canvas> element
├── main.js           ← the entire game
└── assets/
    ├── sprites.png
    ├── tileset.png
    ├── theme.ogg
    └── player.glb
```

Neptune auto-discovers the first `<canvas>` element on the page, or accepts a CSS selector. The developer writes everything in `main.js`.

---

## 4. Engine Initialization — `Neptune.init(config)`

Called once, before anything else. This is the only global configuration call.

```js
Neptune.init({
  canvas: '#game',       // CSS selector or HTMLCanvasElement. Defaults to first <canvas> found.
  width: 320,            // Internal render resolution width
  height: 240,           // Internal render resolution height
  scale: 'fit',          // 'fit' | 'stretch' | 'pixel' (integer scaling, nearest-neighbor)
  antialias: false,      // Defaults to false for pixel-art style
  pixelArt: true,        // Enables nearest-neighbor texture filtering globally
  fps: 60,               // Target fixed timestep. Defaults to 60.
  background: '#1a1a2e', // Default clear color (CSS string)
  debug: false,          // Enables FPS counter, collider wireframes, etc.
});
```

`Neptune.init()` sets up the Three.js renderer, scene, and default camera internally. Nothing is drawn until `Neptune.start()` is called.

---

## 5. The Game Loop — Callbacks

Neptune uses three lifecycle callbacks modeled after PICO-8. The developer provides them as plain functions assigned to properties on the Neptune object.

```js
Neptune.init({ ... });

Neptune.load({
  sprites: {
    tiles: { src: 'assets/tileset.png', cellW: 16, cellH: 16 },
  },
  sounds: {
    bgm: { src: 'assets/theme.ogg', loop: true },
  },
}, () => {
  Neptune.update = titleUpdate;
  Neptune.draw   = titleDraw;
});

Neptune.start(); // Loop begins. Loading screen is shown immediately.
```

### 5.1 The Three Callbacks

**`Neptune.setup`** — Called once by the developer to initialise a game state. Not called automatically by Neptune; the developer calls it explicitly when transitioning states. Synchronous.

```js
function setupGame() {
  score = 0;
  player = Neptune.createBillboard({ ... });
  Neptune.camera.setPosition(0, 4, 8);
  Neptune.camera.lookAt(0, 0, 0);
}
```

**`Neptune.update(dt)`** — Called at a fixed 60 Hz by the engine. `dt` is the fixed timestep in seconds (`1/60`). All game logic, physics, and input polling live here.

**`Neptune.draw()`** — Called once per rendered frame, after `update`. Used for 2D overlay drawing (HUD, text, UI). The 3D scene is rendered automatically before `draw()` is called, unless `manualRender: true` is set in config.

### 5.2 Callback Reassignment — State Machine Pattern

Any callback can be reassigned at runtime. This is the primary mechanism for managing game states.

```js
function titleUpdate(dt) {
  if (Neptune.keyPress('Enter')) goToGame();
}
function titleDraw() {
  Neptune.print('PRESS ENTER', 80, 112, '#fff');
}

function gameUpdate(dt) { /* ... */ }
function gameDraw()     { /* ... */ }

function goToTitle() {
  Neptune.update = titleUpdate;
  Neptune.draw   = titleDraw;
}

function goToGame() {
  setupGame();
  Neptune.update = gameUpdate;
  Neptune.draw   = gameDraw;
}
```

No state machine class. No event bus. Plain functions and closures.

---

## 6. Asset Loading — `Neptune.load(manifest, onComplete)`

Loading is a managed blocking activity. Neptune pauses the game loop, shows a loading screen, fetches all assets in the manifest in parallel, then calls `onComplete` and resumes.

The developer never touches a Promise.

### 6.1 The Manifest

```js
Neptune.load({
  sprites: {
    tiles:  { src: 'assets/tileset.png', cellW: 16, cellH: 16 },
    ui:     { src: 'assets/ui.png',      cellW: 8,  cellH: 8,
              regions: {
                healthbar: { x: 0, y: 0, w: 48, h: 8 },
                coin:      { x: 48, y: 0, w: 8,  h: 8 },
              }
    },
  },
  models: {
    player: 'assets/player.glb',
    tree:   { src: 'assets/tree.glb', animations: true },
  },
  sounds: {
    jump:   'assets/jump.wav',
    bgm:    { src: 'assets/theme.ogg', loop: true },
  },
}, () => {
  // All assets ready. Transition to your first game state here.
  setupGame();
  Neptune.update = gameUpdate;
  Neptune.draw   = gameDraw;
});
```

### 6.2 Mid-Game Loading

`Neptune.load()` can be called at any time — the API is identical whether called before `Neptune.start()` or mid-game between levels.

```js
function onLevelComplete() {
  Neptune.load({
    sprites: {
      cave_tiles: { src: 'assets/cave.png', cellW: 16, cellH: 16 },
    },
    models: {
      boss: 'assets/boss.glb',
    },
  }, () => {
    setupLevel2();
    Neptune.update = gameUpdate;
    Neptune.draw   = gameDraw;
  });
}
```

### 6.3 Asset Re-use

Assets are stored in the registry by key. Loading an already-loaded key is a no-op — silently skipped, not re-fetched.

### 6.4 Error Handling

If any asset fails to load (404, network error, parse failure), Neptune halts the loop and displays a full-screen error state with the failing asset's key and path. This is always a developer mistake, not a runtime edge case.

### 6.5 Customising the Loading Screen

```js
Neptune.loadScreen = () => {
  // Standard 2D draw calls, executed every frame while loading.
  Neptune.cls('#000');
  Neptune.print('NOW LOADING...', 100, 112, '#fff');
};
```

If not set, Neptune draws its own minimal default (spinner + "NOW LOADING").

---

## 7. Camera

Neptune provides a single managed camera. The developer never constructs a Three.js camera manually.

```js
// Mode
Neptune.camera.setMode('perspective', { fov: 75, near: 0.1, far: 1000 });
Neptune.camera.setMode('orthographic', { size: 10 });

// Positioning
Neptune.camera.setPosition(0, 5, 10);
Neptune.camera.lookAt(0, 0, 0);

// Direction helpers
Neptune.camera.forward()   // [x, y, z] unit vector in the camera's look direction
Neptune.camera.right()     // [x, y, z] unit vector to the camera's right

// Attach to an object (first-person)
Neptune.camera.attachTo(playerObject, { offset: [0, 1.7, 0] });

// Detach
Neptune.camera.detach();
```

Note: when mouse mode is `'firstPerson'` or `'thirdPerson'`, Neptune manages camera rotation automatically. Manual `lookAt` calls in those modes are ignored.

---

## 8. Manual 3D Rendering — `Neptune.render3d()`

By default Neptune renders the 3D scene automatically before each `draw()` call. For advanced cases such as split-screen, set `manualRender: true` and call `Neptune.render3d()` explicitly inside `draw()`.

`Neptune.viewport(x, y, w, h)` sets the render region and scissor. Coordinates are in **internal resolution space**.

```js
Neptune.init({ width: 320, height: 240, manualRender: true, ... });

Neptune.draw = () => {
  // Top half — player 1 view
  Neptune.viewport(0, 0, 320, 120);
  Neptune.camera.setPosition(-5, 4, 8);
  Neptune.render3d();

  // Bottom half — player 2 view
  Neptune.viewport(0, 120, 320, 120);
  Neptune.camera.setPosition(5, 4, 8);
  Neptune.render3d();

  // Reset viewport for 2D overlay
  Neptune.viewport(0, 0, 320, 240);
  Neptune.print('P1', 4,   4, '#fff');
  Neptune.print('P2', 4, 124, '#fff');
};
```

---

## 9. Scene Objects

Neptune wraps Three.js objects in a lightweight `NObject`. The developer never instantiates `THREE.Mesh` directly.

### 9.1 Creating Objects

```js
// Primitives
const ground = Neptune.createBox({
  w: 20, h: 1, d: 20,
  color: '#557755',
  position: [0, -0.5, 0],
});

const ball = Neptune.createSphere({
  radius: 0.5,
  spriteSheet: 'tiles',
  sprite: 4,
  position: [0, 3, 0],
});

const floor = Neptune.createPlane({
  w: 50, h: 50,
  color: '#888888',
});

// From a loaded model
const player = Neptune.createModel('player', {
  position: [0, 0, 0],
  scale: [1, 1, 1],
});
```

### 9.2 NObject Interface

```js
obj.position        // [x, y, z] — get/set
obj.rotation        // [x, y, z] in degrees — get/set (Euler, YXZ order)
obj.scale           // [x, y, z] — get/set
obj.visible         // boolean
obj.tag             // string, for scene queries

obj.castShadow    = true;
obj.receiveShadow = true;

obj.setSprite(sheet, index)          // swap the displayed sprite cell
obj.setAnimation(name, options)      // play a model animation
obj.destroy()                        // remove from scene
```

### 9.3 Parenting

```js
parent.add(child);     // child transforms are relative to parent
parent.remove(child);
```

---

## 10. Billboard Sprites

Flat sprite-textured quads that always face the camera. First-class citizens in Neptune.

```js
const tree = Neptune.createBillboard({
  spriteSheet: 'sprites',
  sprite: 12,
  width: 1,
  height: 2,
  position: [5, 1, -3],
  axisLock: 'y',      // 'none' | 'y' (cylindrical — stays upright)
  pixelSnap: true,    // snap to pixel grid to prevent sub-pixel shimmer
});

// Animated billboard — array of sprite indices cycles at given fps
Neptune.createBillboard({
  spriteSheet: 'sprites',
  sprite: [0, 1, 2, 3],
  fps: 8,
  position: [0, 0.5, 0],
  axisLock: 'y',
});
```

---

## 11. Tilemaps

Tilemaps provide an accessible way for non-3D programmers to introduce 3D geometry through a familiar grid-based format. A tilemap has a geometry array (heights), an optional appearance array (tile types), and a tile set (visual definitions).

### 11.1 Tile Sets — `Neptune.createTileSet()`

Tile appearances are defined separately so they can be shared across multiple tilemaps. Keys are the tile type identifiers referenced by the appearance array.

```js
const overworldTiles = Neptune.createTileSet({
  // Flat color on all faces
  1: { color: '#4a7c59' },

  // Per-face sprite control
  2: {
    top:    { sheet: 'tiles', sprite: 4 },
    sides:  { sheet: 'tiles', sprite: 5 },
    bottom: { sheet: 'tiles', sprite: 6 },
  },

  // Mix of sprite and color is valid
  3: {
    top:    { sheet: 'tiles', sprite: 7 },
    sides:  { color: '#8b6914' },
    bottom: { color: '#222' },
  },
});
```

### 11.2 Creating a Tilemap — `Neptune.createTilemap()`

```js
Neptune.createTilemap({
  position: [0, 0, 0],   // world-space origin
  tileSize: 1,            // world units per cell

  // Required. 0 = empty.
  // Positive integers/floats = extrude upward by that many units.
  // Negative integers/floats = extrude downward.
  // Non-integer values require a separate appearance array.
  geometry: [
    [0, 1,   1,   2,   0],
    [1, 2,   3,   2,   1],
    [0, 1,   2.5, 1,   0],
  ],

  // Optional. Same dimensions as geometry.
  // Values are keys into the tileSet.
  // If omitted, geometry values are used as tile type keys directly
  // (only valid when geometry contains integers).
  appearance: [
    [0, 1, 1, 2, 0],
    [1, 2, 3, 2, 1],
    [0, 1, 2, 1, 0],
  ],

  tileSet: overworldTiles,

  // false   → tiles fill solidly from the plane down to their base.
  //           geometry value = height of the top surface above the plane.
  // integer → each box is exactly N units thick, open underneath.
  //           Good for floating platforms, staircases, overhangs.
  height: false,
});
```

### 11.3 The `height` Option, Illustrated

```
height: false                  height: 2

plane ─────────────            plane ─────────────
      █ █ ███                         ░ ░ ░░░   ← open underneath
      █ █ ███                         █ █ ███
      █████████                       █████████
      ─────────                       (nothing below)
```

With `height: false`, a geometry value of `3` produces a box whose top is at `plane_y + 3`, filled solidly down to `plane_y`. With `height: 2`, the same box is only 2 units thick — top at `plane_y + 3`, bottom at `plane_y + 1`.

### 11.4 Non-Integer Heights

Fractional geometry values (e.g. `0.5` for a half-step) are supported. However, when any non-integer value is present in the geometry array, a separate `appearance` array is **required**, since fractional values cannot double as tile type keys.

### 11.5 Multi-Tilemap Scene

```js
// Broad heightmap for the level floor
const floor = Neptune.createTilemap({
  position: [0, 0, 0],
  tileSize: 2,
  geometry: [ /* large 2D array */ ],
  tileSet: overworldTiles,
  height: false,
});

// A floating platform, open underneath
const platform = Neptune.createTilemap({
  position: [10, 6, -4],
  tileSize: 1,
  geometry: [
    [1, 1, 1],
    [1, 2, 1],
    [1, 1, 1],
  ],
  tileSet: stoneTiles,
  height: 1,
});

// A sunken pit
const pit = Neptune.createTilemap({
  position: [5, 0, 5],
  tileSize: 1,
  geometry: [
    [ 0, -2, -2,  0],
    [-2, -4, -4, -2],
    [ 0, -2, -2,  0],
  ],
  tileSet: overworldTiles,
  height: false,
});
```

`Neptune.createTilemap()` returns an `NObject`, so the entire map can be repositioned, hidden, or destroyed at runtime:

```js
platform.visible = false;
platform.position = [10, 8, -4];
platform.destroy();
```

---

## 12. Lighting

```js
Neptune.addLight('ambient', { color: '#ffffff', intensity: 0.4 });

Neptune.addLight('directional', {
  color: '#ffeedd',
  intensity: 1.0,
  position: [10, 20, 10],
  castShadow: true,
});

Neptune.addLight('point', {
  color: '#ff4400',
  intensity: 2.0,
  position: [0, 3, 0],
  distance: 10,
  decay: 2,
});
```

Shadows are opt-in per light and per object:

```js
obj.castShadow    = true;
obj.receiveShadow = true;
```

---

## 13. Input

Neptune uses a polling-based input system consistent with PICO-8's philosophy. All queries are made inside `update()`, not via event listeners.

### 13.1 Keyboard

```js
Neptune.keyDown('ArrowLeft')     // true while held
Neptune.keyPress('Space')        // true on the frame the key was first pressed
Neptune.keyRelease('Space')      // true on the frame the key was released
```

Key strings follow the Web standard `KeyboardEvent.key` naming.

### 13.2 Gamepad

```js
Neptune.btn(0)       // D-pad left
Neptune.btn(1)       // D-pad right
Neptune.btn(2)       // D-pad up
Neptune.btn(3)       // D-pad down
Neptune.btn(4)       // A / Cross
Neptune.btn(5)       // B / Circle
Neptune.btn(6)       // X / Square
Neptune.btn(7)       // Y / Triangle
Neptune.btnPress(4)  // true on the frame button was first pressed
Neptune.btnRelease(4)
```

### 13.3 Mouse

Mouse behavior is controlled by a **mode**. The mode is set by calling `Neptune.mouse.setMode()`. Button queries are available in every mode.

#### Common properties — all modes

```js
Neptune.mouse.x            // cursor x in internal resolution space
Neptune.mouse.y            // cursor y in internal resolution space
Neptune.mouse.dx           // raw pixel delta this frame, x
Neptune.mouse.dy           // raw pixel delta this frame, y
Neptune.mouse.btn(0)       // left button held (0=left, 1=middle, 2=right)
Neptune.mouse.btnPress(0)  // rising edge this frame
Neptune.mouse.btnRelease(0)
```

#### Mode: `'gui'` (default)

Standard visible cursor. Useful for menus, HUDs, and any 2D UI.

```js
Neptune.mouse.setMode('gui');

// Convenience hit-test: returns true if cursor is inside rect and left-clicked this frame
Neptune.mouse.clicked(x, y, w, h)
```

Usage example:

```js
function titleUpdate(dt) {
  if (Neptune.mouse.clicked(120, 100, 80, 20)) goToGame();
}

function titleDraw() {
  Neptune.rectFill(120, 100, 80, 20, '#333');
  Neptune.print('START GAME', 124, 108, '#fff');
}
```

#### Mode: `'firstPerson'`

Neptune requests pointer lock automatically. Mouse delta drives camera pitch and yaw. The developer does not manually set camera rotation while this mode is active.

```js
Neptune.mouse.setMode('firstPerson', {
  sensitivity: 1.0,
  invertY: false,
  pitchLimit: 85,    // degrees — prevents flipping over the pole
});
```

Neptune shows a built-in "Click to capture mouse" prompt until pointer lock is granted. Override it:

```js
Neptune.mouse.capturePrompt = () => {
  Neptune.print('CLICK TO START', 100, 112, '#fff');
};
```

Use `Neptune.camera.forward()` to drive movement relative to the look direction:

```js
// In update():
const forward = Neptune.camera.forward();   // yaw-only unit vector [x, 0, z]
player.position[0] += forward[0] * speed * dt;
player.position[2] += forward[2] * speed * dt;
```

#### Mode: `'thirdPerson'`

Neptune orbits the camera around a target. Mouse movement controls the orbit angle. Scroll wheel controls distance.

```js
Neptune.mouse.setMode('thirdPerson', {
  target: playerObject,   // NObject to orbit, or [x, y, z] fixed point
  distance: 6,            // initial orbit radius in world units
  minDistance: 2,
  maxDistance: 20,
  sensitivity: 1.0,
  invertY: false,
  pitchLimit: [5, 80],    // [min, max] degrees from horizontal
  scrollToZoom: true,
});
```

If `target` is an `NObject`, the orbit center follows it automatically each frame. The developer simply moves the object; the camera tracks it.

```js
// In update():
const forward = Neptune.camera.forward();
if (Neptune.keyDown('ArrowUp')) {
  player.position[0] += forward[0] * speed * dt;
  player.position[2] += forward[2] * speed * dt;
}
```

#### Switching Mouse Modes at Runtime

```js
function goToGame() {
  Neptune.mouse.setMode('firstPerson', { sensitivity: 0.8 });
  Neptune.update = gameUpdate;
  Neptune.draw   = gameDraw;
}

function goToPause() {
  Neptune.mouse.setMode('gui');
  Neptune.update = pauseUpdate;
  Neptune.draw   = pauseDraw;
}
```

Neptune handles releasing and re-requesting pointer lock across transitions automatically.

---

## 14. 2D Drawing (HUD / Overlay)

All 2D drawing calls are made inside `draw()`. They render onto a 2D canvas overlay composited on top of the 3D scene. Coordinates are in internal resolution space (e.g. 320×240). Colors are CSS strings throughout.

```js
// Clear the overlay. Called automatically each frame; can also be called manually.
Neptune.cls('#000000');   // omit argument for transparent

// Text
Neptune.print('SCORE: 100', x, y, '#ffffff');
Neptune.print('SCORE: 100', x, y, {
  color: '#fff',
  font: '8px monospace',
  align: 'left',          // 'left' | 'center' | 'right'
});

// Shapes
Neptune.rect(x, y, w, h, '#ffffff');      // outline rectangle
Neptune.rectFill(x, y, w, h, '#ffffff'); // filled rectangle
Neptune.line(x0, y0, x1, y1, '#ffffff');
Neptune.circ(x, y, r, '#ffffff');         // outline circle
Neptune.circFill(x, y, r, '#ffffff');    // filled circle
Neptune.pixel(x, y, '#ffffff');           // single pixel

// Sprites onto the 2D overlay
Neptune.spr(sheet, index, x, y);
Neptune.spr(sheet, index, x, y, { w: 2, h: 2 }); // span 2×2 cells
Neptune.sprRegion(sheet, 'healthbar', x, y);       // named region
```

---

## 15. Audio

Neptune provides a simple audio interface for sound effects and music. All sounds must be loaded via `Neptune.load()` before use. No location-based or spatial audio in v1.

```js
// Sounds
Neptune.audio.play('jump');
Neptune.audio.play('jump', { volume: 0.8 });

// Music (typically a looping track defined in the manifest with loop: true)
Neptune.audio.play('bgm');
Neptune.audio.stop('bgm');
Neptune.audio.setVolume('bgm', 0.4);   // 0.0 – 1.0

// Global volume control
Neptune.audio.setMasterVolume(0.5);
Neptune.audio.mute();
Neptune.audio.unmute();
```

Sound effects are fire-and-forget. The same sound can overlap itself (e.g. rapid jump sounds). Music tracks managed by key — calling `play` on an already-playing track is a no-op.

---

## 16. Persistence — `Neptune.save` / `Neptune.load`

Simple key-value persistence backed by `localStorage`. Values can be any JSON-serializable type.

```js
// Save
Neptune.save('highscore', 4200);
Neptune.save('settings', { volume: 0.5, fullscreen: true });

// Load — second argument is the default value if key does not exist
const highscore = Neptune.loadData('highscore', 0);
const settings  = Neptune.loadData('settings', { volume: 1.0, fullscreen: false });

// Delete
Neptune.deleteSave('highscore');

// Check existence
Neptune.hasSave('highscore');  // true | false
```

Note: `Neptune.loadData()` is used for persistence retrieval to avoid collision with `Neptune.load()` (asset loading).

All save data is scoped to the page origin automatically by `localStorage`.

---

## 17. Utility Functions

```js
// Math
Neptune.math.lerp(a, b, t)
Neptune.math.clamp(v, min, max)
Neptune.math.rnd(n)             // random float 0..n
Neptune.math.rndi(n)            // random integer 0..n-1
Neptune.math.vec3(x, y, z)
Neptune.math.dist3(a, b)        // distance between two [x,y,z] arrays

// Raycasting
Neptune.raycast(origin, direction, {
  maxDist: 100,
  filter: (obj) => true,        // optional — exclude objects
})
// Returns { hit: true, object: NObject, point: [x,y,z], distance: n } or null

// Screen-to-world
Neptune.screenToWorld(screenX, screenY, depth)

// Scene queries
Neptune.findByTag('enemy')     // array of NObjects with matching tag
Neptune.findAll()              // all NObjects currently in the scene
```

---

## 18. Error Handling Philosophy

- `Neptune.start()` called before `Neptune.init()` throws a descriptive error immediately.
- Missing assets halt the loop at load time and display a full-screen error with the failing key and path.
- In `debug: true` mode, type mismatches and API misuse produce console warnings rather than silent failures.
- In production mode (`debug: false`), loop-internal errors are caught, logged to console, and the loop continues rather than crashing.

---

## 19. Module Export Shape

Neptune is a singleton exported as the default export. There is no constructor.

```js
// ESM (primary target)
import Neptune from 'neptune-engine';
```

---

## 20. Example: Minimal Complete Game

```js
import Neptune from 'neptune-engine';

Neptune.init({
  width: 320, height: 240,
  scale: 'pixel',
  antialias: false,
  pixelArt: true,
  background: '#1a1a2e',
});

let player, score;

function setupGame() {
  score  = 0;
  player = Neptune.createBillboard({
    spriteSheet: 'sprites',
    sprite: 0,
    width: 1, height: 1,
    position: [0, 0.5, 0],
    axisLock: 'y',
  });
  Neptune.createBox({ w: 20, h: 0.5, d: 20, color: '#334455', position: [0, 0, 0] });
  Neptune.addLight('ambient',     { intensity: 0.6 });
  Neptune.addLight('directional', { position: [5, 10, 5], intensity: 1 });
  Neptune.mouse.setMode('thirdPerson', { target: player, distance: 6 });
}

function gameUpdate(dt) {
  const forward = Neptune.camera.forward();
  const speed   = 4;
  if (Neptune.keyDown('ArrowLeft'))  player.position[0] -= speed * dt;
  if (Neptune.keyDown('ArrowRight')) player.position[0] += speed * dt;
  if (Neptune.keyDown('ArrowUp'))    player.position[2] -= speed * dt;
  if (Neptune.keyDown('ArrowDown'))  player.position[2] += speed * dt;
  score++;
}

function gameDraw() {
  Neptune.print(`SCORE: ${score}`, 4, 4, '#ffffff');
}

Neptune.load({
  sprites: {
    sprites: { src: 'assets/sprites.png', cellW: 16, cellH: 16 },
  },
  sounds: {
    bgm: { src: 'assets/theme.ogg', loop: true },
  },
}, () => {
  setupGame();
  Neptune.audio.play('bgm');
  Neptune.update = gameUpdate;
  Neptune.draw   = gameDraw;
});

Neptune.start();
```

---

## 21. Deferred / Out of Scope for v1

| Item | Status |
|---|---|
| Particle systems | Deferred post-v1 |
| Post-processing | Out of scope |
| Physics engine | Out of scope |
| Spatial / positional audio | Out of scope |
| Multiplayer / WebRTC | Out of scope |
| Browser dev tools extension | Out of scope |
| TypeScript definitions | Out of scope |
| CDN bundle / CJS build | Out of scope |

---

*Neptune Design Document — v0.2. Subject to revision.*
