/**
 * Neptune — JavaScript 3D Game Engine  (v0.1.0)
 * Design doc: neptune-design-doc-v0.2.md
 *
 * Peer dependency: three (>=r150)
 * ESM only — import Neptune from 'neptune-engine'
 */

import * as THREE from 'three';
import { CHERRY_R, CHERRY_B } from './cherry-font.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function warn(msg) {
  if (_config.debug) console.warn('[Neptune]', msg);
}

function assertInit() {
  if (!_initialized) throw new Error('[Neptune] call Neptune.init() before Neptune.start()');
}

/** Returns a Proxy over a 3-element array that keeps a THREE.Vector3/Euler in sync. */
function _makeSyncVec(threeVec, degrees = false) {
  const toN = degrees ? THREE.MathUtils.radToDeg.bind(THREE.MathUtils) : v => v;
  const toT = degrees ? THREE.MathUtils.degToRad.bind(THREE.MathUtils) : v => v;
  // Underlying storage — always mirrors threeVec
  const arr = [toN(threeVec.x), toN(threeVec.y), toN(threeVec.z)];
  return new Proxy(arr, {
    get(target, prop) {
      // Keep array in sync on every read so external THREE mutations are visible
      target[0] = toN(threeVec.x);
      target[1] = toN(threeVec.y);
      target[2] = toN(threeVec.z);
      return target[prop];
    },
    set(target, prop, value) {
      target[prop] = value;
      const i = Number(prop);
      if (i === 0) threeVec.x = toT(value);
      else if (i === 1) threeVec.y = toT(value);
      else if (i === 2) threeVec.z = toT(value);
      return true;
    },
  });
}

/** Apply a [x,y,z] array to a THREE.Vector3/Euler from the given source degrees flag. */
function _applyArr(threeVec, arr, degrees = false) {
  const toT = degrees ? THREE.MathUtils.degToRad.bind(THREE.MathUtils) : v => v;
  threeVec.x = toT(arr[0] ?? 0);
  threeVec.y = toT(arr[1] ?? 0);
  threeVec.z = toT(arr[2] ?? 0);
}

// ─── Module-level state ───────────────────────────────────────────────────────

let _initialized = false;
let _running = false;
let _renderer = null;
let _scene = null;
let _threeCamera = null;
let _overlayCanvas = null;
let _overlayCtx = null;
let _config = {};
let _sceneObjects = [];   // all live NObjects
let _assets = {};          // key → loaded asset data
let _loading = false;
let _loadError = null;
let _lastTime = 0;
let _accumulator = 0;
let _animationFrameId = null;
let _animMixers = [];      // THREE.AnimationMixer instances
let _container = null;

// ─── Input state ─────────────────────────────────────────────────────────────

const _keysDown     = new Set();
const _keysPressed  = new Set();
const _keysReleased = new Set();

const _mouseState = {
  x: 0, y: 0, dx: 0, dy: 0,
  _btnsDown: new Set(),
  _btnsPressed: new Set(),
  _btnsReleased: new Set(),
};

const _gpState = {
  _down:     new Array(16).fill(false),
  _pressed:  new Array(16).fill(false),
  _released: new Array(16).fill(false),
};

// ─── NObject ─────────────────────────────────────────────────────────────────

/**
 * A scene object returned by every Neptune factory function (`createBox`, `createModel`, etc.).
 *
 * `position`, `rotation`, and `scale` are plain JavaScript arrays that write through to
 * Three.js automatically. You can modify individual components (`obj.position[0] += 1`)
 * or assign a whole new array (`obj.position = [0, 5, 0]`).
 *
 * @property {[number, number, number]} position - World-space position [x, y, z].
 * @property {[number, number, number]} rotation - Rotation in degrees, YXZ Euler order [x, y, z].
 * @property {[number, number, number]} scale    - Scale factors [x, y, z].
 * @property {boolean} visible      - Whether the object is rendered.
 * @property {string}  tag          - Arbitrary string used with `Neptune.findByTag()`.
 * @property {boolean} castShadow   - Whether meshes in this object cast shadows.
 * @property {boolean} receiveShadow - Whether meshes in this object receive shadows.
 */
class NObject {
  constructor(threeObj) {
    this._obj    = threeObj;
    this._posP   = _makeSyncVec(threeObj.position);
    this._rotP   = _makeSyncVec(threeObj.rotation, true);
    this._scaleP = _makeSyncVec(threeObj.scale);
    this.tag = '';
    _sceneObjects.push(this);
  }

  // position ----------------------------------------------------------------
  get position() { return this._posP; }
  set position(arr) {
    _applyArr(this._obj.position, arr);
  }

  // rotation (degrees, YXZ) -------------------------------------------------
  get rotation() { return this._rotP; }
  set rotation(arr) {
    this._obj.rotation.order = 'YXZ';
    _applyArr(this._obj.rotation, arr, true);
  }

  // scale -------------------------------------------------------------------
  get scale() { return this._scaleP; }
  set scale(arr) {
    _applyArr(this._obj.scale, arr);
  }

  // visible -----------------------------------------------------------------
  get visible() { return this._obj.visible; }
  set visible(v) { this._obj.visible = v; }

  // shadows -----------------------------------------------------------------
  get castShadow() { return this._obj.castShadow; }
  set castShadow(v) {
    this._obj.traverse(o => { if (o.isMesh) o.castShadow = v; });
  }

  get receiveShadow() { return this._obj.receiveShadow; }
  set receiveShadow(v) {
    this._obj.traverse(o => { if (o.isMesh) o.receiveShadow = v; });
  }

  // parenting ---------------------------------------------------------------
  /**
   * Attaches `child` to this object so its transforms are relative to this object's.
   * @param {NObject} child
   * @returns {NObject} This object (chainable).
   */
  add(child) {
    this._obj.add(child._obj);
    return this;
  }

  /**
   * Detaches a previously added child from this object.
   * @param {NObject} child
   * @returns {NObject} This object (chainable).
   */
  remove(child) {
    this._obj.remove(child._obj);
    return this;
  }

  // sprite swap (for objects using a sprite-sheet material) -----------------
  /**
   * Changes the displayed sprite cell on a mesh that uses a sprite-sheet material.
   * @param {string} sheetKey - Key of the loaded sprite sheet (from the asset manifest).
   * @param {number} index    - Zero-based sprite index within the sheet.
   */
  setSprite(sheetKey, index) {
    const asset = _assets[sheetKey];
    if (!asset) { warn(`setSprite: sheet "${sheetKey}" not loaded`); return; }
    _applySpriteUV(this._obj, asset, index);
  }

  // model animation ---------------------------------------------------------
  /**
   * Plays a named animation clip on a GLTF model.
   * Has no effect if the object was not created with `Neptune.createModel()`.
   * @param {string} name - The animation clip name as defined in the GLTF file.
   * @param {{ loop?: boolean, clampWhenFinished?: boolean }} [options]
   *   - `loop` — repeat indefinitely (default: `true`).
   *   - `clampWhenFinished` — hold the last frame when a non-looping clip ends.
   */
  setAnimation(name, options = {}) {
    if (!this._mixer || !this._clips) return;
    const clip = THREE.AnimationClip.findByName(this._clips, name);
    if (!clip) { warn(`setAnimation: clip "${name}" not found`); return; }
    const action = this._mixer.clipAction(clip);
    action.setLoop(options.loop === false ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
    if (options.clampWhenFinished) action.clampWhenFinished = true;
    action.play();
  }

  // remove from scene and dispose -------------------------------------------
  /**
   * Removes the object from the scene and disposes its geometry and materials.
   * Also stops any running animation mixers attached to this object.
   */
  destroy() {
    if (this._obj.parent) this._obj.parent.remove(this._obj);
    this._obj.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach(m => m.dispose());
      }
    });
    if (this._mixer) {
      this._mixer.stopAllAction();
      const mi = _animMixers.indexOf(this._mixer);
      if (mi !== -1) _animMixers.splice(mi, 1);
    }
    const idx = _sceneObjects.indexOf(this);
    if (idx !== -1) _sceneObjects.splice(idx, 1);
  }

  // toon shading ------------------------------------------------------------
  /**
   * Applies a toon-shading descriptor (from `Neptune.addToonShader()`) to this object.
   * Replaces each mesh's material with `MeshToonMaterial` and attaches a back-face hull
   * mesh for silhouette outlines. Existing color and texture map are preserved.
   * @param {object} shader - Descriptor returned by `Neptune.addToonShader()`.
   * @returns {NObject} This object (chainable).
   */
  setShader(shader) {
    if (!shader || shader._type !== 'toon') {
      warn('setShader: expected a descriptor from Neptune.addToonShader()');
      return this;
    }
    this._obj.traverse(o => {
      if (!o.isMesh || o._isHull) return;
      const old = o.material;
      o.material = new THREE.MeshToonMaterial({
        color:       old.color?.clone() ?? new THREE.Color('#ffffff'),
        map:         old.map ?? null,
        gradientMap: shader._gradientMap,
      });
      old.dispose();

      const hull = new THREE.Mesh(
        o.geometry,
        new THREE.MeshBasicMaterial({
          color: new THREE.Color(shader.outlineColor),
          side:  THREE.BackSide,
        }),
      );
      hull._isHull = true;
      hull.scale.setScalar(1 + shader.outlineWidth);
      o.add(hull);
    });
    return this;
  }
}

// ─── Sprite-sheet helpers ────────────────────────────────────────────────────

/** Compute UV offset/repeat for a given sprite index inside a sheet asset. */
function _spriteUV(asset, index) {
  const cols = Math.floor(asset.texture.image.width  / asset.cellW);
  const rows = Math.floor(asset.texture.image.height / asset.cellH);
  const col  = index % cols;
  const row  = Math.floor(index / cols);
  const repeatX = 1 / cols;
  const repeatY = 1 / rows;
  // Three.js UV origin is bottom-left; image origin is top-left → flip row
  const offsetX = col  * repeatX;
  const offsetY = (rows - 1 - row) * repeatY;
  return { offset: new THREE.Vector2(offsetX, offsetY), repeat: new THREE.Vector2(repeatX, repeatY) };
}

function _applySpriteUV(threeObj, asset, index) {
  const uv = _spriteUV(asset, index);
  threeObj.traverse(o => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    mats.forEach(m => {
      if (m.map) {
        m.map.offset.copy(uv.offset);
        m.map.repeat.copy(uv.repeat);
      }
    });
  });
}

/** Build a MeshLambertMaterial from an opts object: { color, spriteSheet, sprite } */
function _makeMaterial(opts = {}) {
  if (opts.spriteSheet) {
    const asset = _assets[opts.spriteSheet];
    if (!asset) { warn(`material: spriteSheet "${opts.spriteSheet}" not loaded`); }
    const tex = asset ? asset.texture.clone() : null;
    if (tex) {
      tex.needsUpdate = true;
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      const uv = _spriteUV(asset, opts.sprite ?? 0);
      tex.offset.copy(uv.offset);
      tex.repeat.copy(uv.repeat);
    }
    return new THREE.MeshLambertMaterial({ map: tex, transparent: true });
  }
  return new THREE.MeshLambertMaterial({
    color: new THREE.Color(opts.color ?? '#ffffff'),
  });
}

// Builds a DataTexture that quantizes MeshToonMaterial lighting into `steps` discrete bands.
function _makeToonGradientMap(steps) {
  const data = new Uint8Array(steps);
  for (let i = 0; i < steps; i++) {
    data[i] = Math.round(255 * (i + 1) / (steps + 1));
  }
  const tex = new THREE.DataTexture(data, steps, 1, THREE.RedFormat);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

// ─── Camera ──────────────────────────────────────────────────────────────────

const _cameraState = {
  mode: 'perspective',
  _attached: null,        // NObject
  _attachOffset: [0, 0, 0],
  // first-/third-person state
  _fpYaw: 0,
  _fpPitch: 0,
  _tpYaw: 0,
  _tpPitch: 30,
  _tpDist: 6,
  _tpOpts: {},
};

/**
 * Neptune's camera controller. Access via `Neptune.camera`.
 * Neptune manages a single camera — you never construct a Three.js camera directly.
 * @namespace
 */
const camera = {
  /**
   * Switches the camera projection type. Creates a fresh Three.js camera.
   * @param {'perspective'|'orthographic'} type
   * @param {{ fov?: number, size?: number, near?: number, far?: number }} [opts]
   *   - `fov`  — perspective field of view in degrees (default: 75).
   *   - `size` — orthographic half-height in world units (default: 10).
   *   - `near` — near clip plane (default: 0.1).
   *   - `far`  — far clip plane (default: 1000).
   */
  setMode(type, opts = {}) {
    const W = _config.width  ?? 320;
    const H = _config.height ?? 240;
    _cameraState.mode = type;
    if (type === 'perspective') {
      _threeCamera = new THREE.PerspectiveCamera(
        opts.fov ?? 75,
        W / H,
        opts.near ?? 0.1,
        opts.far  ?? 1000,
      );
    } else if (type === 'orthographic') {
      const s = opts.size ?? 10;
      _threeCamera = new THREE.OrthographicCamera(
        -s * W / H, s * W / H, s, -s,
        opts.near ?? 0.1,
        opts.far  ?? 1000,
      );
    }
  },

  /**
   * Moves the camera to the given world-space coordinates.
   * @param {number} x
   * @param {number} y
   * @param {number} z
   */
  setPosition(x, y, z) {
    _threeCamera.position.set(x, y, z);
  },

  /**
   * Rotates the camera to face the given world-space point.
   * Do not call this in `firstPerson` or `thirdPerson` mouse mode — Neptune drives
   * the rotation automatically in those modes.
   * @param {number} x
   * @param {number} y
   * @param {number} z
   */
  lookAt(x, y, z) {
    _threeCamera.lookAt(x, y, z);
  },

  /**
   * Returns the yaw-only (y = 0) forward unit vector of the camera.
   * Useful for moving a character relative to camera facing direction.
   * @returns {[number, number, number]} `[x, 0, z]` normalised.
   */
  forward() {
    const dir = new THREE.Vector3();
    _threeCamera.getWorldDirection(dir);
    dir.y = 0;
    dir.normalize();
    return [dir.x, dir.y, dir.z];
  },

  /**
   * Returns the yaw-only right-hand unit vector of the camera (perpendicular to `forward()`).
   * @returns {[number, number, number]} `[x, 0, z]` normalised.
   */
  right() {
    const dir = new THREE.Vector3();
    _threeCamera.getWorldDirection(dir);
    dir.y = 0;
    dir.normalize();
    const right = new THREE.Vector3();
    right.crossVectors(dir, new THREE.Vector3(0, 1, 0));
    return [right.x, right.y, right.z];
  },

  /**
   * Attaches the camera to an NObject so it follows the object's position each frame.
   * Used with `mouse.setMode('firstPerson')` to implement a first-person view.
   * @param {NObject} nobj - The object to follow.
   * @param {{ offset?: [number, number, number] }} [opts]
   *   - `offset` — local offset from the object's origin (e.g. `[0, 1.7, 0]` for eye height).
   */
  attachTo(nobj, opts = {}) {
    _cameraState._attached = nobj;
    _cameraState._attachOffset = opts.offset ?? [0, 0, 0];
  },

  /**
   * Removes any previously set camera attachment, returning to free camera mode.
   */
  detach() {
    _cameraState._attached = null;
  },
};

// ─── Mouse ───────────────────────────────────────────────────────────────────

/**
 * Neptune's mouse / pointer input controller. Access via `Neptune.mouse`.
 * Mouse behavior is controlled by a mode set with `setMode()`.
 * All state is polled inside `update()` — do not use event listeners.
 * @namespace
 * @property {number} x  - Cursor X in internal resolution space.
 * @property {number} y  - Cursor Y in internal resolution space.
 * @property {number} dx - Raw horizontal delta this frame (pixels).
 * @property {number} dy - Raw vertical delta this frame (pixels).
 * @property {(Function|null)} capturePrompt - Optional callback drawn when pointer lock
 *   is pending. Replaces the default "CLICK TO CAPTURE MOUSE" text.
 */
const mouse = {
  get x() { return _mouseState.x; },
  get y() { return _mouseState.y; },
  get dx() { return _mouseState.dx; },
  get dy() { return _mouseState.dy; },

  _mode: 'gui',
  _modeOpts: {},
  _pointerLocked: false,
  capturePrompt: null,

  /**
   * Sets the mouse interaction mode.
   *
   * - `'gui'`         — Standard visible cursor. Use for menus and 2D UI.
   * - `'firstPerson'` — Requests pointer lock. Mouse delta drives camera yaw/pitch.
   * - `'thirdPerson'` — Orbits the camera around a target. Scroll wheel zooms.
   *
   * @param {'gui'|'firstPerson'|'thirdPerson'} mode
   * @param {object} [opts]
   *   **firstPerson options:**
   *   - `sensitivity` {number}  — Mouse sensitivity multiplier (default: 1).
   *   - `invertY`     {boolean} — Invert vertical look (default: false).
   *   - `pitchLimit`  {number}  — Max pitch in degrees, prevents flipping (default: 85).
   *
   *   **thirdPerson options:**
   *   - `target`       {NObject|[number,number,number]} — Object or point to orbit.
   *   - `distance`     {number} — Initial orbit distance (default: 6).
   *   - `minDistance`  {number} — Minimum zoom distance (default: 2).
   *   - `maxDistance`  {number} — Maximum zoom distance (default: 20).
   *   - `sensitivity`  {number} — Mouse sensitivity multiplier (default: 1).
   *   - `invertY`      {boolean} — Invert vertical orbit (default: false).
   *   - `pitchLimit`   {[number, number]} — `[min, max]` degrees from horizontal (default: [5, 80]).
   *   - `scrollToZoom` {boolean} — Allow scroll-wheel zoom (default: true).
   */
  setMode(mode, opts = {}) {
    this._mode = mode;
    this._modeOpts = opts;

    if (mode === 'firstPerson' || mode === 'thirdPerson') {
      _requestPointerLock();
    } else {
      _releasePointerLock();
    }

    if (mode === 'thirdPerson') {
      _cameraState._tpOpts  = opts;
      _cameraState._tpDist  = opts.distance  ?? 6;
      _cameraState._tpPitch = (opts.pitchLimit?.[0] ?? 10) + 10;
    }
  },

  /**
   * Returns `true` while mouse button `b` is held down.
   * @param {number} b - Button index: 0 = left, 1 = middle, 2 = right.
   * @returns {boolean}
   */
  btn(b) {
    return _mouseState._btnsDown.has(b);
  },

  /**
   * Returns `true` on the single frame a mouse button was first pressed.
   * @param {number} b - Button index: 0 = left, 1 = middle, 2 = right.
   * @returns {boolean}
   */
  btnPress(b) {
    return _mouseState._btnsPressed.has(b);
  },

  /**
   * Returns `true` on the single frame a mouse button was released.
   * @param {number} b - Button index: 0 = left, 1 = middle, 2 = right.
   * @returns {boolean}
   */
  btnRelease(b) {
    return _mouseState._btnsReleased.has(b);
  },

  /**
   * Returns `true` if the cursor is inside the given rectangle **and** the left
   * mouse button was pressed this frame. Convenience for simple UI hit-tests.
   * @param {number} x - Left edge in internal resolution space.
   * @param {number} y - Top edge in internal resolution space.
   * @param {number} w - Width in pixels.
   * @param {number} h - Height in pixels.
   * @returns {boolean}
   */
  clicked(x, y, w, h) {
    return (
      this.btnPress(0) &&
      _mouseState.x >= x && _mouseState.x <= x + w &&
      _mouseState.y >= y && _mouseState.y <= y + h
    );
  },
};

function _requestPointerLock() {
  if (!_renderer) return;
  _renderer.domElement.addEventListener('click', _doPointerLock, { once: true });
}

function _doPointerLock() {
  _renderer.domElement.requestPointerLock();
}

function _releasePointerLock() {
  if (document.pointerLockElement) document.exitPointerLock();
  mouse._pointerLocked = false;
}

// ─── Audio ───────────────────────────────────────────────────────────────────

const _audioCtx = { _ctx: null, _master: null, _gain: 1, _muted: false };

function _getAudioCtx() {
  if (!_audioCtx._ctx) {
    _audioCtx._ctx = new (window.AudioContext || window.webkitAudioContext)();
    _audioCtx._master = _audioCtx._ctx.createGain();
    _audioCtx._master.connect(_audioCtx._ctx.destination);
  }
  return _audioCtx._ctx;
}

/**
 * Neptune's audio system. Access via `Neptune.audio`.
 * All sounds must be loaded via `Neptune.load()` before use.
 * @namespace
 */
const audio = {
  _tracks: {},   // key → { buffer, source, gainNode, opts }

  /**
   * Plays a loaded sound. If a looping track is already playing, this is a no-op.
   * @param {string} key - Asset key from the manifest.
   * @param {{ volume?: number }} [opts]
   *   - `volume` — playback volume 0.0–1.0 (default: 1).
   */
  play(key, opts = {}) {
    const asset = _assets[key];
    if (!asset || asset.type !== 'sound') { warn(`audio.play: "${key}" not loaded`); return; }

    const ctx = _getAudioCtx();

    // If already playing and looping, don't restart
    if (this._tracks[key]?.playing) return;

    const src   = ctx.createBufferSource();
    src.buffer  = asset.buffer;
    src.loop    = asset.loop ?? false;

    const gain = ctx.createGain();
    gain.gain.value = (opts.volume ?? 1) * _audioCtx._gain * (_audioCtx._muted ? 0 : 1);
    src.connect(gain).connect(_audioCtx._master);
    src.start(0);

    const track = { source: src, gainNode: gain, playing: true };
    src.onended = () => { track.playing = false; };
    this._tracks[key] = track;
  },

  /**
   * Stops a currently playing sound immediately.
   * @param {string} key - Asset key from the manifest.
   */
  stop(key) {
    const t = this._tracks[key];
    if (t?.playing) { t.source.stop(); t.playing = false; }
  },

  /**
   * Sets the volume of a specific track without stopping it.
   * @param {string} key - Asset key from the manifest.
   * @param {number} vol - Volume 0.0–1.0.
   */
  setVolume(key, vol) {
    const t = this._tracks[key];
    if (t) t.gainNode.gain.value = vol * _audioCtx._gain;
  },

  /**
   * Sets the master output volume. Applies to all tracks.
   * @param {number} vol - Volume 0.0–1.0.
   */
  setMasterVolume(vol) {
    _audioCtx._gain = vol;
    if (_audioCtx._master) _audioCtx._master.gain.value = _audioCtx._muted ? 0 : vol;
  },

  /**
   * Silences all audio output without changing individual track volumes.
   * Call `unmute()` to restore.
   */
  mute() {
    _audioCtx._muted = true;
    if (_audioCtx._master) _audioCtx._master.gain.value = 0;
  },

  /**
   * Restores audio after a call to `mute()`.
   */
  unmute() {
    _audioCtx._muted = false;
    if (_audioCtx._master) _audioCtx._master.gain.value = _audioCtx._gain;
  },
};

// ─── Math ────────────────────────────────────────────────────────────────────

/**
 * Neptune math utilities. Access via `Neptune.math`.
 * @namespace
 */
const math = {
  /**
   * Linear interpolation between `a` and `b`.
   * @param {number} a - Start value.
   * @param {number} b - End value.
   * @param {number} t - Interpolation factor (0 = `a`, 1 = `b`).
   * @returns {number}
   */
  lerp: (a, b, t) => a + (b - a) * t,

  /**
   * Clamps `v` so it stays between `mn` and `mx`.
   * @param {number} v  - Value to clamp.
   * @param {number} mn - Minimum allowed value.
   * @param {number} mx - Maximum allowed value.
   * @returns {number}
   */
  clamp: (v, mn, mx) => Math.max(mn, Math.min(mx, v)),

  /**
   * Returns a random float in the range [0, n).
   * @param {number} n
   * @returns {number}
   */
  rnd:   (n) => Math.random() * n,

  /**
   * Returns a random integer in the range [0, n).
   * @param {number} n
   * @returns {number}
   */
  rndi:  (n) => Math.floor(Math.random() * n),

  /**
   * Creates a `[x, y, z]` array. Defaults to `[0, 0, 0]`.
   * @param {number} [x=0]
   * @param {number} [y=0]
   * @param {number} [z=0]
   * @returns {[number, number, number]}
   */
  vec3:  (x = 0, y = 0, z = 0) => [x, y, z],

  /**
   * Euclidean distance between two world-space points.
   * @param {[number, number, number]} a
   * @param {[number, number, number]} b
   * @returns {number}
   */
  dist3: (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]),
};

// ─── Scaling / canvas setup ──────────────────────────────────────────────────

function _setupScaling() {
  const W = _config.width;
  const H = _config.height;

  const isPixelArt = _config.pixelArt || _config.scale === 'pixel';
  if (isPixelArt) {
    [_renderer.domElement, _overlayCanvas].forEach(c => {
      c.style.imageRendering = 'pixelated';
    });
  }

  function resize() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let cssW, cssH;

    if (_config.scale === 'stretch') {
      cssW = vw; cssH = vh;
    } else if (_config.scale === 'pixel') {
      const s = Math.max(1, Math.min(Math.floor(vw / W), Math.floor(vh / H)));
      cssW = W * s; cssH = H * s;
    } else { // 'fit'
      const s = Math.min(vw / W, vh / H);
      cssW = W * s; cssH = H * s;
    }

    _container.style.width  = cssW + 'px';
    _container.style.height = cssH + 'px';
    _container.style.left   = ((vw - cssW) / 2) + 'px';
    _container.style.top    = ((vh - cssH) / 2) + 'px';

    [_renderer.domElement, _overlayCanvas].forEach(c => {
      c.style.width  = cssW + 'px';
      c.style.height = cssH + 'px';
    });
  }

  resize();
  window.addEventListener('resize', resize);
}

// ─── Input setup ─────────────────────────────────────────────────────────────

function _setupInput() {
  // Keyboard
  window.addEventListener('keydown', e => {
    if (!_keysDown.has(e.key)) _keysPressed.add(e.key);
    _keysDown.add(e.key);
  });
  window.addEventListener('keyup', e => {
    _keysDown.delete(e.key);
    _keysReleased.add(e.key);
  });

  // Mouse position (in overlay-canvas / internal resolution space)
  window.addEventListener('mousemove', e => {
    if (mouse._pointerLocked) {
      _mouseState.dx = e.movementX;
      _mouseState.dy = e.movementY;
      return;
    }
    if (!_overlayCanvas) return;
    const rect = _overlayCanvas.getBoundingClientRect();
    const scaleX = _config.width  / rect.width;
    const scaleY = _config.height / rect.height;
    _mouseState.x  = (e.clientX - rect.left) * scaleX;
    _mouseState.y  = (e.clientY - rect.top)  * scaleY;
    _mouseState.dx = e.movementX * scaleX;
    _mouseState.dy = e.movementY * scaleY;
  });

  window.addEventListener('mousedown', e => {
    _mouseState._btnsPressed.add(e.button);
    _mouseState._btnsDown.add(e.button);
  });
  window.addEventListener('mouseup', e => {
    _mouseState._btnsDown.delete(e.button);
    _mouseState._btnsReleased.add(e.button);
  });

  // Pointer lock
  document.addEventListener('pointerlockchange', () => {
    mouse._pointerLocked = (document.pointerLockElement === _renderer?.domElement);
    if (!mouse._pointerLocked) {
      _mouseState.dx = 0;
      _mouseState.dy = 0;
    }
  });

  // Scroll (third-person zoom)
  window.addEventListener('wheel', e => {
    if (mouse._mode === 'thirdPerson') {
      const opts = mouse._modeOpts;
      const min  = opts.minDistance ?? 2;
      const max  = opts.maxDistance ?? 20;
      _cameraState._tpDist = math.clamp(_cameraState._tpDist + e.deltaY * 0.01, min, max);
    }
  });
}

// ─── Camera update (called each frame) ───────────────────────────────────────

function _updateCamera() {
  const mode = mouse._mode;

  if (mode === 'firstPerson' && mouse._pointerLocked) {
    const opts = mouse._modeOpts;
    const sens = (opts.sensitivity ?? 1) * 0.1;
    const invertY = opts.invertY ? 1 : -1;
    _cameraState._fpYaw   -= _mouseState.dx * sens;
    _cameraState._fpPitch += _mouseState.dy * sens * invertY;
    const limit = opts.pitchLimit ?? 85;
    _cameraState._fpPitch = math.clamp(_cameraState._fpPitch, -limit, limit);

    _threeCamera.rotation.order = 'YXZ';
    _threeCamera.rotation.y = THREE.MathUtils.degToRad(_cameraState._fpYaw);
    _threeCamera.rotation.x = THREE.MathUtils.degToRad(_cameraState._fpPitch);

    if (_cameraState._attached) {
      const p   = _cameraState._attached._obj.position;
      const off = _cameraState._attachOffset;
      _threeCamera.position.set(p.x + off[0], p.y + off[1], p.z + off[2]);
    }
  } else if (mode === 'thirdPerson') {
    if (mouse._pointerLocked) {
      const opts = mouse._modeOpts;
      const sens = (opts.sensitivity ?? 1) * 0.2;
      const invertY = opts.invertY ? 1 : -1;
      _cameraState._tpYaw   -= _mouseState.dx * sens;
      _cameraState._tpPitch += _mouseState.dy * sens * invertY;
      const [pMin, pMax] = opts.pitchLimit ?? [5, 80];
      _cameraState._tpPitch = math.clamp(_cameraState._tpPitch, pMin, pMax);
    }

    const target = mouse._modeOpts.target;
    let tx = 0, ty = 0, tz = 0;
    if (target && target._obj) {
      tx = target._obj.position.x;
      ty = target._obj.position.y;
      tz = target._obj.position.z;
    } else if (Array.isArray(target)) {
      [tx, ty, tz] = target;
    }

    const yawRad   = THREE.MathUtils.degToRad(_cameraState._tpYaw);
    const pitchRad = THREE.MathUtils.degToRad(_cameraState._tpPitch);
    const d = _cameraState._tpDist;
    const cx = tx + d * Math.cos(pitchRad) * Math.sin(yawRad);
    const cy = ty + d * Math.sin(pitchRad);
    const cz = tz + d * Math.cos(pitchRad) * Math.cos(yawRad);
    _threeCamera.position.set(cx, cy, cz);
    _threeCamera.lookAt(tx, ty, tz);
  } else if (_cameraState._attached) {
    const p   = _cameraState._attached._obj.position;
    const off = _cameraState._attachOffset;
    _threeCamera.position.set(p.x + off[0], p.y + off[1], p.z + off[2]);
  }
}

// ─── Loading screen ───────────────────────────────────────────────────────────

function _drawLoadingScreen() {
  if (Neptune.loadScreen) {
    Neptune.loadScreen();
    return;
  }
  const W = _config.width;
  const H = _config.height;
  _overlayCtx.fillStyle = '#000';
  _overlayCtx.fillRect(0, 0, W, H);
  _overlayCtx.fillStyle = '#fff';
  // "NOW LOADING..." = 14 chars × 7 px, centered
  _printBitmap(_overlayCtx, 'NOW LOADING...', W / 2 - 49, H / 2 - 6, 1, 1, false);
}

function _drawErrorScreen(msg) {
  const W = _config.width;
  const H = _config.height;
  _overlayCtx.fillStyle = '#1a0000';
  _overlayCtx.fillRect(0, 0, W, H);
  _overlayCtx.fillStyle = '#ff4444';
  const lines = msg.split('\n');
  lines.forEach((l, i) => _printBitmap(_overlayCtx, l, 4, 4 + i * 14, 1, 1, false));
}

// ─── Billboard orientation ────────────────────────────────────────────────────

function _updateBillboards(dt) {
  if (!_threeCamera) return;
  const camPos = _threeCamera.position;

  for (const nobj of _sceneObjects) {
    if (!nobj._isBillboard) continue;

    // Sprite animation
    if (nobj._billboardUpdate) nobj._billboardUpdate(dt);

    // Orient toward camera
    const axisLock = nobj._axisLock ?? 'y';
    const obj = nobj._obj;
    if (axisLock === 'y') {
      // Cylindrical: rotate around Y only
      const dx = camPos.x - obj.position.x;
      const dz = camPos.z - obj.position.z;
      obj.rotation.y = Math.atan2(dx, dz);
    } else {
      // Full spherical billboard: always face camera
      obj.lookAt(camPos);
    }
  }
}

// ─── Main loop ───────────────────────────────────────────────────────────────

function _loop(timestamp) {
  _animationFrameId = requestAnimationFrame(_loop);

  const dt = Math.min((timestamp - _lastTime) / 1000, 0.1); // cap at 100 ms
  _lastTime = timestamp;

  // Clear overlay
  _overlayCtx.clearRect(0, 0, _config.width, _config.height);

  if (_loadError) {
    _drawErrorScreen(_loadError);
    return;
  }

  if (_loading) {
    _drawLoadingScreen();
    return;
  }

  // Fixed-timestep updates
  const FIXED_DT = 1 / (_config.fps ?? 60);
  _accumulator += dt;
  while (_accumulator >= FIXED_DT) {
    _accumulator -= FIXED_DT;
    _updateCamera();
    if (Neptune.update) {
      try { Neptune.update(FIXED_DT); } catch (e) {
        if (_config.debug) throw e;
        console.error('[Neptune] update error:', e);
      }
    }
    // Advance animation mixers and billboard orientation
    _animMixers.forEach(m => m.update(FIXED_DT));
    _updateBillboards(FIXED_DT);
    // Clear per-frame edge sets AFTER update
    _keysPressed.clear();
    _keysReleased.clear();
    _mouseState._btnsPressed.clear();
    _mouseState._btnsReleased.clear();
    _mouseState.dx = 0;
    _mouseState.dy = 0;
    _gpState._pressed.fill(false);
    _gpState._released.fill(false);
  }

  // Render 3D (unless manualRender)
  if (!_config.manualRender) {
    _renderer.render(_scene, _threeCamera);
  }

  // 2D draw callback
  if (Neptune.draw) {
    try { Neptune.draw(); } catch (e) {
      if (_config.debug) throw e;
      console.error('[Neptune] draw error:', e);
    }
  }

  // First-person capture prompt
  if ((mouse._mode === 'firstPerson' || mouse._mode === 'thirdPerson') && !mouse._pointerLocked) {
    if (mouse.capturePrompt) {
      mouse.capturePrompt();
    } else {
      Neptune.print('CLICK TO CAPTURE MOUSE', _config.width / 2, _config.height / 2 - 4, {
        color: '#fff', align: 'center',
      });
    }
  }
}

// ─── Asset loading ───────────────────────────────────────────────────────────

async function _loadAssets(manifest) {
  const jobs = [];

  if (manifest.sprites) {
    for (const [key, def] of Object.entries(manifest.sprites)) {
      if (_assets[key]) continue; // already loaded
      const src = typeof def === 'string' ? def : def.src;
      jobs.push((async () => {
        const loader = new THREE.TextureLoader();
        const tex = await loader.loadAsync(src);
        tex.magFilter = _config.pixelArt ? THREE.NearestFilter : THREE.LinearFilter;
        tex.minFilter = _config.pixelArt ? THREE.NearestFilter : THREE.LinearMipmapLinearFilter;
        _assets[key] = {
          type: 'sprite', texture: tex,
          cellW: def.cellW ?? tex.image.width,
          cellH: def.cellH ?? tex.image.height,
          regions: def.regions ?? {},
        };
      })());
    }
  }

  if (manifest.models) {
    for (const [key, def] of Object.entries(manifest.models)) {
      if (_assets[key]) continue;
      const src = typeof def === 'string' ? def : def.src;
      jobs.push((async () => {
        const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
        const loader = new GLTFLoader();
        const gltf   = await loader.loadAsync(src);
        _assets[key] = { type: 'model', gltf, animations: gltf.animations };
      })());
    }
  }

  if (manifest.sounds) {
    for (const [key, def] of Object.entries(manifest.sounds)) {
      if (_assets[key]) continue;
      const src  = typeof def === 'string' ? def : def.src;
      const loop = typeof def === 'string' ? false : (def.loop ?? false);
      jobs.push((async () => {
        const ctx    = _getAudioCtx();
        const resp   = await fetch(src);
        const ab     = await resp.arrayBuffer();
        const buffer = await ctx.decodeAudioData(ab);
        _assets[key] = { type: 'sound', buffer, loop };
      })());
    }
  }

  await Promise.all(jobs);
}

// ─── Tilemap ─────────────────────────────────────────────────────────────────

function _buildTilemap(opts) {
  const { geometry, appearance, tileSet, tileSize = 1, position = [0, 0, 0], height: heightOpt = false } = opts;
  const group = new THREE.Group();

  const rows = geometry.length;
  const cols = geometry[0].length;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const gVal = geometry[r][c];
      if (gVal === 0) continue;

      const tileKey = appearance ? appearance[r][c] : Math.round(gVal);
      const tileDef = tileSet[tileKey];
      if (!tileDef) continue;

      const tileH = heightOpt !== false ? heightOpt : Math.abs(gVal);
      const sign  = gVal >= 0 ? 1 : -1;
      const topY  = gVal * tileSize;
      const botY  = heightOpt !== false ? topY - sign * tileH * tileSize : 0;
      const boxH  = Math.abs(topY - botY);
      const boxY  = (topY + botY) / 2;

      const geo  = new THREE.BoxGeometry(tileSize, boxH, tileSize);
      const mats = _tileMaterials(tileDef);
      const mesh = new THREE.Mesh(geo, mats);
      mesh.position.set(
        (c + 0.5) * tileSize,
        boxY,
        (r + 0.5) * tileSize,
      );
      mesh.receiveShadow = true;
      mesh.castShadow    = true;
      group.add(mesh);
    }
  }

  group.position.set(position[0], position[1], position[2]);
  _scene.add(group);

  const nobj = new NObject(group);
  return nobj;
}

function _tileMaterials(def) {
  // BoxGeometry face order: +X, -X, +Y, -Y, +Z, -Z  (right, left, top, bottom, front, back)
  const faceDefs = [
    def.sides ?? def, // right
    def.sides ?? def, // left
    def.top   ?? def, // top
    def.bottom ?? def.sides ?? def, // bottom
    def.sides ?? def, // front
    def.sides ?? def, // back
  ];
  return faceDefs.map(fd => {
    if (!fd) return new THREE.MeshLambertMaterial({ color: '#ffffff' });
    if (fd.sheet) {
      const asset = _assets[fd.sheet];
      if (!asset) return new THREE.MeshLambertMaterial({ color: '#ff00ff' });
      const tex = asset.texture.clone();
      tex.needsUpdate = true;
      const uv = _spriteUV(asset, fd.sprite ?? 0);
      tex.offset.copy(uv.offset);
      tex.repeat.copy(uv.repeat);
      return new THREE.MeshLambertMaterial({ map: tex });
    }
    return new THREE.MeshLambertMaterial({ color: new THREE.Color(fd.color ?? '#ffffff') });
  });
}

// ─── 2D overlay helpers ───────────────────────────────────────────────────────

function _ctx() { return _overlayCtx; }

function _color(c) {
  return typeof c === 'string' ? c : (c?.color ?? '#ffffff');
}

// Bresenham's line — plots integer pixels with no antialiasing.
function _plotLine(ctx, x0, y0, x1, y1) {
  x0 = Math.round(x0); y0 = Math.round(y0);
  x1 = Math.round(x1); y1 = Math.round(y1);
  const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
  const dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    ctx.fillRect(x0, y0, 1, 1);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

// Midpoint circle algorithm — 1-px outline, no antialiasing.
function _plotCircle(ctx, cx, cy, r) {
  cx = Math.round(cx); cy = Math.round(cy); r = Math.round(r);
  let x = 0, y = r, d = 1 - r;
  while (x <= y) {
    ctx.fillRect(cx + x, cy + y, 1, 1); ctx.fillRect(cx - x, cy + y, 1, 1);
    ctx.fillRect(cx + x, cy - y, 1, 1); ctx.fillRect(cx - x, cy - y, 1, 1);
    ctx.fillRect(cx + y, cy + x, 1, 1); ctx.fillRect(cx - y, cy + x, 1, 1);
    ctx.fillRect(cx + y, cy - x, 1, 1); ctx.fillRect(cx - y, cy - x, 1, 1);
    if (d < 0) { d += 2 * x + 3; } else { d += 2 * (x - y) + 5; y--; }
    x++;
  }
}

// Scanline-filled circle — one fillRect per row, no antialiasing.
function _plotCircleFill(ctx, cx, cy, r) {
  cx = Math.round(cx); cy = Math.round(cy); r = Math.round(r);
  for (let dy = -r; dy <= r; dy++) {
    const dx = Math.floor(Math.sqrt(r * r - dy * dy));
    ctx.fillRect(cx - dx, cy + dy, 2 * dx + 1, 1);
  }
}

// Renders `text` onto ctx using the Cherry bitmap font (7 px wide × 12 px tall).
// widthScale / heightScale stretch each pixel rectangle; bold selects CHERRY_B.
function _printBitmap(ctx, text, x, y, widthScale, heightScale, bold) {
  const glyphs = bold ? CHERRY_B : CHERRY_R;
  const GLYPH_W = 7, GLYPH_H = 12;
  let drawX = x;
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0);
    const rows = glyphs[cp] ?? glyphs[32];
    for (let row = 0; row < GLYPH_H; row++) {
      const b = rows[row];
      if (b === 0) continue;
      for (let col = 0; col < GLYPH_W; col++) {
        if ((b >> (7 - col)) & 1) {
          ctx.fillRect(
            drawX + col * widthScale,
            y     + row * heightScale,
            widthScale,
            heightScale,
          );
        }
      }
    }
    drawX += GLYPH_W * widthScale;
  }
}

// ─── Neptune public API ───────────────────────────────────────────────────────

/**
 * Neptune game engine. The single default export. All engine functionality is
 * accessed through properties and methods on this object.
 *
 * **Typical setup:**
 * ```js
 * import Neptune from 'neptune-engine';
 * Neptune.init({ width: 320, height: 240 });
 * Neptune.update = (dt) => { ... };
 * Neptune.draw   = ()   => { ... };
 * Neptune.start();
 * ```
 */
const Neptune = {
  /**
   * Assign a function here to run game logic. Called at the fixed update rate
   * (default 60 Hz). `dt` is the fixed timestep in seconds (e.g. `1/60`).
   * All input polling, physics, and game state changes belong here.
   * @type {((dt: number) => void) | null}
   */
  update:     null,

  /**
   * Assign a function here to draw the 2D overlay (HUD, text, UI).
   * Called once per rendered frame, after `update`. The 3D scene renders
   * automatically before `draw()` unless `manualRender` is set.
   * @type {(() => void) | null}
   */
  draw:       null,

  /**
   * Assign a function here to override the default loading screen.
   * Called every frame while assets are loading. Use Neptune 2D drawing calls
   * to display a custom loading UI.
   * @type {(() => void) | null}
   */
  loadScreen: null,

  // Sub-APIs
  /** @type {typeof camera} */
  camera,
  /** @type {typeof mouse} */
  mouse,
  /** @type {typeof audio} */
  audio,
  /** @type {typeof math} */
  math,

  // ── init ───────────────────────────────────────────────────────────────────
  /**
   * Initialises the engine. Must be called once before any other Neptune function.
   * Sets up the Three.js renderer, scene, default camera, input listeners, and canvas scaling.
   *
   * @param {object} [config]
   * @param {string|HTMLCanvasElement} [config.canvas]   - CSS selector or element. Default: first `<canvas>` found, or a new one appended to `<body>`.
   * @param {number}  [config.width=320]                 - Internal render resolution width in pixels.
   * @param {number}  [config.height=240]                - Internal render resolution height in pixels.
   * @param {'fit'|'stretch'|'pixel'} [config.scale='fit'] - Viewport scaling mode.
   *   - `'fit'`     — scales proportionally to fill the viewport (letterboxed).
   *   - `'stretch'` — stretches to fill the viewport exactly.
   *   - `'pixel'`   — largest integer scale that fits; enables `image-rendering: pixelated`.
   * @param {boolean} [config.antialias=false]           - Enable WebGL anti-aliasing.
   * @param {boolean} [config.pixelArt=false]            - Use nearest-neighbor texture filtering globally.
   * @param {number}  [config.fps=60]                    - Fixed-timestep target in Hz.
   * @param {string}  [config.background='#000000']      - Scene clear color (CSS string).
   * @param {boolean} [config.debug=false]               - Log API misuse warnings to the console.
   * @param {boolean} [config.manualRender=false]        - Disable automatic 3D rendering; call `Neptune.render3d()` yourself.
   */
  init(config = {}) {
    _config = {
      width:       320,
      height:      240,
      scale:       'fit',
      antialias:   false,
      pixelArt:    false,
      fps:         60,
      background:  '#000000',
      debug:       false,
      manualRender: false,
      ...config,
    };

    // Find or create canvas
    let canvas;
    if (_config.canvas instanceof HTMLCanvasElement) {
      canvas = _config.canvas;
    } else if (typeof _config.canvas === 'string') {
      canvas = document.querySelector(_config.canvas);
    } else {
      canvas = document.querySelector('canvas');
    }
    if (!canvas) {
      canvas = document.createElement('canvas');
      document.body.appendChild(canvas);
    }

    // Set canvas internal resolution
    canvas.width  = _config.width;
    canvas.height = _config.height;

    // Three.js renderer on the existing canvas
    _renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: _config.antialias,
    });
    _renderer.setSize(_config.width, _config.height, false); // false = don't set CSS size
    _renderer.setClearColor(new THREE.Color(_config.background));
    _renderer.shadowMap.enabled = true;
    _renderer.shadowMap.type    = THREE.PCFSoftShadowMap;

    // Overlay canvas
    _overlayCanvas = document.createElement('canvas');
    _overlayCanvas.width  = _config.width;
    _overlayCanvas.height = _config.height;
    _overlayCanvas.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;';
    _overlayCtx = _overlayCanvas.getContext('2d');

    // Container
    _container = document.createElement('div');
    _container.style.cssText = 'position:fixed;overflow:hidden;';
    canvas.parentNode.insertBefore(_container, canvas);
    _container.appendChild(canvas);
    _container.appendChild(_overlayCanvas);

    // Scene + camera
    _scene       = new THREE.Scene();
    _threeCamera = new THREE.PerspectiveCamera(75, _config.width / _config.height, 0.1, 1000);
    _threeCamera.position.set(0, 5, 10);
    _threeCamera.lookAt(0, 0, 0);

    _setupInput();
    _setupScaling();
    _initialized = true;
  },

  // ── start ─────────────────────────────────────────────────────────────────
  /**
   * Starts the game loop. Call after `init()`, and optionally after `load()`.
   * Calling `start()` before `init()` throws an error.
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  start() {
    assertInit();
    if (_running) return;
    _running = true;
    _lastTime = performance.now();
    _animationFrameId = requestAnimationFrame(_loop);
  },

  // ── load ──────────────────────────────────────────────────────────────────
  /**
   * Fetches all assets in the manifest in parallel, then calls `onComplete`.
   * The game loop is blocked while loading; the built-in (or custom) loading screen is shown.
   * Can be called before `start()` or mid-game for per-level loading.
   * Assets are cached by key — reloading an already-loaded key is a no-op.
   *
   * @param {object} manifest
   * @param {Object.<string, string|{ src: string, cellW?: number, cellH?: number, regions?: Object.<string,{x:number,y:number,w:number,h:number}> }>} [manifest.sprites]
   *   Sprite sheet definitions. Each value is a URL string or an options object.
   *   - `src`     — image URL.
   *   - `cellW`   — width of one sprite cell in pixels.
   *   - `cellH`   — height of one sprite cell in pixels.
   *   - `regions` — named rectangular sub-regions for use with `sprRegion()`.
   * @param {Object.<string, string|{ src: string }>} [manifest.models]
   *   GLTF model definitions. Each value is a `.glb`/`.gltf` URL or an options object.
   * @param {Object.<string, string|{ src: string, loop?: boolean }>} [manifest.sounds]
   *   Sound definitions. Each value is an audio URL or an options object.
   *   - `loop` — loop the track continuously (default: false).
   * @param {() => void} [onComplete] - Called after all assets have loaded successfully.
   */
  load(manifest, onComplete) {
    _loading = true;
    _loadError = null;
    _loadAssets(manifest).then(() => {
      _loading = false;
      try { onComplete?.(); } catch (e) {
        console.error('[Neptune] load callback error:', e);
      }
    }).catch(err => {
      _loadError = `LOAD ERROR\n${err.message ?? err}`;
      console.error('[Neptune] asset load failed:', err);
    });
  },

  // ── scene objects ─────────────────────────────────────────────────────────
  /**
   * Creates a box (rectangular prism) mesh and adds it to the scene.
   * @param {object} [opts]
   * @param {number}  [opts.w=1]            - Width (X axis).
   * @param {number}  [opts.h=1]            - Height (Y axis).
   * @param {number}  [opts.d=1]            - Depth (Z axis).
   * @param {string}  [opts.color='#ffffff'] - Flat surface color. Ignored when `spriteSheet` is set.
   * @param {string}  [opts.spriteSheet]    - Key of a loaded sprite sheet to use as texture.
   * @param {number}  [opts.sprite=0]       - Sprite index within the sheet.
   * @param {[number,number,number]} [opts.position] - Initial world position.
   * @param {[number,number,number]} [opts.rotation] - Initial rotation in degrees (YXZ).
   * @param {[number,number,number]} [opts.scale]    - Initial scale.
   * @param {boolean} [opts.castShadow=false]
   * @param {boolean} [opts.receiveShadow=false]
   * @returns {NObject}
   */
  createBox(opts = {}) {
    const geo  = new THREE.BoxGeometry(opts.w ?? 1, opts.h ?? 1, opts.d ?? 1);
    const mat  = _makeMaterial(opts);
    const mesh = new THREE.Mesh(geo, mat);
    if (opts.position) _applyArr(mesh.position, opts.position);
    if (opts.rotation) { mesh.rotation.order = 'YXZ'; _applyArr(mesh.rotation, opts.rotation, true); }
    if (opts.scale)    _applyArr(mesh.scale, opts.scale);
    mesh.castShadow    = opts.castShadow    ?? false;
    mesh.receiveShadow = opts.receiveShadow ?? false;
    _scene.add(mesh);
    return new NObject(mesh);
  },

  /**
   * Creates a sphere mesh and adds it to the scene.
   * @param {object} [opts]
   * @param {number}  [opts.radius=0.5]     - Sphere radius.
   * @param {string}  [opts.color='#ffffff'] - Flat surface color.
   * @param {string}  [opts.spriteSheet]    - Key of a loaded sprite sheet.
   * @param {number}  [opts.sprite=0]       - Sprite index within the sheet.
   * @param {[number,number,number]} [opts.position]
   * @param {boolean} [opts.castShadow=false]
   * @param {boolean} [opts.receiveShadow=false]
   * @returns {NObject}
   */
  createSphere(opts = {}) {
    const geo  = new THREE.SphereGeometry(opts.radius ?? 0.5, 32, 16);
    const mat  = _makeMaterial(opts);
    const mesh = new THREE.Mesh(geo, mat);
    if (opts.position) _applyArr(mesh.position, opts.position);
    mesh.castShadow    = opts.castShadow    ?? false;
    mesh.receiveShadow = opts.receiveShadow ?? false;
    _scene.add(mesh);
    return new NObject(mesh);
  },

  /**
   * Creates a flat horizontal plane (internally rotated -90° on X so it lies flat).
   * @param {object} [opts]
   * @param {number}  [opts.w=1]            - Width (X axis).
   * @param {number}  [opts.h=1]            - Height (Z axis).
   * @param {string}  [opts.color='#ffffff'] - Flat surface color.
   * @param {string}  [opts.spriteSheet]    - Key of a loaded sprite sheet.
   * @param {number}  [opts.sprite=0]       - Sprite index within the sheet.
   * @param {[number,number,number]} [opts.position]
   * @param {boolean} [opts.receiveShadow=false]
   * @returns {NObject}
   */
  createPlane(opts = {}) {
    const geo  = new THREE.PlaneGeometry(opts.w ?? 1, opts.h ?? 1);
    const mat  = _makeMaterial(opts);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2; // lay flat
    if (opts.position) _applyArr(mesh.position, opts.position);
    mesh.receiveShadow = opts.receiveShadow ?? false;
    _scene.add(mesh);
    return new NObject(mesh);
  },

  /**
   * Instantiates a previously loaded GLTF model and adds it to the scene.
   * If the model contains animations, they can be played with `nobj.setAnimation()`.
   * Falls back to a magenta box if the key is not loaded (with a debug warning).
   * @param {string} key  - Asset key from the manifest.
   * @param {object} [opts]
   * @param {[number,number,number]} [opts.position]
   * @param {[number,number,number]} [opts.scale]
   * @returns {NObject}
   */
  createModel(key, opts = {}) {
    const asset = _assets[key];
    if (!asset || asset.type !== 'model') {
      warn(`createModel: "${key}" not loaded`);
      return this.createBox({ w: 0.5, h: 0.5, d: 0.5, color: '#ff00ff' });
    }
    const gltf  = asset.gltf;
    const model = gltf.scene.clone();
    if (opts.position) _applyArr(model.position, opts.position);
    if (opts.scale)    _applyArr(model.scale, opts.scale);
    _scene.add(model);
    const nobj = new NObject(model);
    if (asset.animations?.length) {
      const mixer = new THREE.AnimationMixer(model);
      nobj._mixer = mixer;
      nobj._clips = asset.animations;
      _animMixers.push(mixer);
    }
    return nobj;
  },

  /**
   * Creates a sprite-textured flat quad that automatically faces the camera each frame.
   * Supports static and animated sprites (cycling through an array of frame indices).
   * @param {object} [opts]
   * @param {string}  [opts.spriteSheet]         - Key of a loaded sprite sheet.
   * @param {number|number[]} [opts.sprite=0]    - Sprite index, or an array of indices for animation.
   * @param {number}  [opts.fps=8]               - Frame rate for animated sprites.
   * @param {number}  [opts.width=1]             - Quad width in world units.
   * @param {number}  [opts.height=1]            - Quad height in world units.
   * @param {[number,number,number]} [opts.position]
   * @param {'y'|'none'} [opts.axisLock='y']    - `'y'` = cylindrical (stays upright); `'none'` = full spherical.
   * @returns {NObject}
   */
  createBillboard(opts = {}) {
    const w = opts.width  ?? 1;
    const h = opts.height ?? 1;
    const geo = new THREE.PlaneGeometry(w, h);
    const mat = _makeMaterial({ ...opts, spriteSheet: opts.spriteSheet, sprite: typeof opts.sprite === 'number' ? opts.sprite : (Array.isArray(opts.sprite) ? opts.sprite[0] : 0) });
    mat.side        = THREE.DoubleSide;
    mat.transparent = true;
    const mesh = new THREE.Mesh(geo, mat);
    if (opts.position) _applyArr(mesh.position, opts.position);
    _scene.add(mesh);

    const nobj = new NObject(mesh);
    nobj._isBillboard = true;
    nobj._axisLock = opts.axisLock ?? 'y';

    // Animated billboard
    if (Array.isArray(opts.sprite) && opts.sprite.length > 1 && opts.spriteSheet) {
      const frames = opts.sprite;
      const fps    = opts.fps ?? 8;
      let   frame  = 0;
      let   elapsed = 0;
      nobj._billboardUpdate = (dt) => {
        elapsed += dt;
        if (elapsed >= 1 / fps) {
          elapsed = 0;
          frame = (frame + 1) % frames.length;
          nobj.setSprite(opts.spriteSheet, frames[frame]);
        }
      };
    }

    return nobj;
  },

  /**
   * Defines the visual appearance of tile types for use with `createTilemap`.
   * Returns the definitions object as-is; it acts as a lookup table for the tilemap builder.
   *
   * Each key is a tile type identifier (matching values in the `geometry` or `appearance` arrays).
   * Each value is a tile definition object:
   * - `{ color: '#rrggbb' }` — flat-colored tile (all faces).
   * - `{ top, sides, bottom }` — per-face overrides. Each face value can be
   *   `{ sheet: 'key', sprite: N }` or `{ color: '#rrggbb' }`.
   *
   * @param {Object.<number, object>} defs - Tile appearance definitions keyed by tile type ID.
   * @returns {Object.<number, object>} The same `defs` object (used directly by `createTilemap`).
   */
  createTileSet(defs) {
    // Just return the defs object — used as a look-up table by createTilemap
    return defs;
  },

  /**
   * Builds a 3D heightmap from a 2D grid and adds it to the scene.
   * The returned NObject represents the entire map and can be repositioned, hidden, or destroyed.
   *
   * @param {object} opts
   * @param {number[][]} opts.geometry
   *   2D grid of height values. `0` = empty cell. Positive = extrude up, negative = extrude down.
   * @param {number[][]} [opts.appearance]
   *   Optional 2D grid of tile type keys. If omitted, the geometry integer values are used directly.
   * @param {Object.<number, object>} opts.tileSet
   *   Tile definitions returned by `createTileSet()`.
   * @param {number} [opts.tileSize=1]
   *   World units per grid cell.
   * @param {[number,number,number]} [opts.position=[0,0,0]]
   *   World-space origin of the map.
   * @param {number|false} [opts.height=false]
   *   `false` = tiles fill from the base plane up to their geometry height.
   *   A number = each tile box is exactly that many units thick (useful for platforms).
   * @returns {NObject}
   */
  createTilemap(opts) {
    return _buildTilemap(opts);
  },

  // ── lighting ──────────────────────────────────────────────────────────────
  /**
   * Creates a light and adds it to the scene.
   *
   * @param {'ambient'|'directional'|'point'|'spot'} type - Light type.
   * @param {object} [opts]
   * @param {string}  [opts.color='#ffffff']   - Light color (CSS string).
   * @param {number}  [opts.intensity=1]       - Light intensity.
   * @param {[number,number,number]} [opts.position] - World position (not used by `'ambient'`).
   * @param {boolean} [opts.castShadow=false]  - Enable shadow casting for this light.
   * @param {number}  [opts.distance=0]        - `'point'` only — maximum range (0 = infinite).
   * @param {number}  [opts.decay=2]           - `'point'` only — physical attenuation exponent.
   * @returns {THREE.Light|null} The Three.js light object, or `null` for unknown types.
   */
  addLight(type, opts = {}) {
    let light;
    const color     = opts.color     ?? '#ffffff';
    const intensity = opts.intensity ?? 1;

    switch (type) {
      case 'ambient':
        light = new THREE.AmbientLight(new THREE.Color(color), intensity);
        break;
      case 'directional': {
        light = new THREE.DirectionalLight(new THREE.Color(color), intensity);
        if (opts.position) light.position.set(...opts.position);
        if (opts.castShadow) {
          light.castShadow = true;
          light.shadow.mapSize.set(1024, 1024);
        }
        break;
      }
      case 'point': {
        light = new THREE.PointLight(
          new THREE.Color(color), intensity,
          opts.distance ?? 0,
          opts.decay    ?? 2,
        );
        if (opts.position) light.position.set(...opts.position);
        if (opts.castShadow) light.castShadow = true;
        break;
      }
      case 'spot': {
        light = new THREE.SpotLight(new THREE.Color(color), intensity);
        if (opts.position) light.position.set(...opts.position);
        if (opts.castShadow) light.castShadow = true;
        break;
      }
      default:
        warn(`addLight: unknown type "${type}"`);
        return null;
    }

    _scene.add(light);
    return light;
  },

  /**
   * Creates a reusable toon-shading descriptor. Apply it to any NObject with `nobj.setShader()`.
   *
   * Uses `MeshToonMaterial` for cel-shaded fill (quantized lighting bands) and a back-face
   * hull mesh for silhouette outlines. Outlines appear on the visible border of each object;
   * interior face edges are not outlined (that requires post-processing).
   *
   * @param {object} [opts]
   * @param {string} [opts.outlineColor='#000000'] - CSS color for the outline.
   * @param {number} [opts.outlineWidth=0.04]      - Hull inflation as a fraction of object size
   *   (0.04 = 4% larger). Larger values = thicker outline. Try 0.02–0.08.
   * @param {number} [opts.steps=3]                - Number of shading bands.
   *   2 = shadow / highlight only; 3 = shadow / midtone / highlight; 4 = four bands.
   * @returns {{ _type: string, outlineColor: string, outlineWidth: number }}
   *
   * @example
   * const toon = Neptune.addToonShader({ outlineColor: '#1a1a2e', outlineWidth: 0.05 });
   * box.setShader(toon);
   */
  addToonShader(opts = {}) {
    // THREE.Color doesn't parse #RRGGBBAA — strip the alpha byte if present.
    const raw          = opts.outlineColor ?? '#000000';
    const outlineColor = /^#[0-9a-fA-F]{8}$/.test(raw) ? raw.slice(0, 7) : raw;
    return {
      _type:        'toon',
      _gradientMap: _makeToonGradientMap(Math.max(2, Math.round(opts.steps ?? 3))),
      outlineColor,
      outlineWidth: opts.outlineWidth ?? 0.04,
    };
  },

  // ── input ─────────────────────────────────────────────────────────────────
  /**
   * Returns `true` while the key is held down. Use for continuous actions (movement).
   * Key names follow the Web standard `KeyboardEvent.key` (e.g. `'ArrowLeft'`, `'a'`, `' '`).
   * @param {string} key
   * @returns {boolean}
   */
  keyDown   (key) { return _keysDown.has(key); },

  /**
   * Returns `true` on the single frame the key was first pressed. Use for one-shot actions.
   * @param {string} key - `KeyboardEvent.key` name.
   * @returns {boolean}
   */
  keyPress  (key) { return _keysPressed.has(key); },

  /**
   * Returns `true` on the single frame the key was released.
   * @param {string} key - `KeyboardEvent.key` name.
   * @returns {boolean}
   */
  keyRelease(key) { return _keysReleased.has(key); },

  /**
   * Returns `true` while a gamepad button is held.
   * Button mapping: 0=D-left, 1=D-right, 2=D-up, 3=D-down, 4=A/Cross, 5=B/Circle,
   * 6=X/Square, 7=Y/Triangle.
   * @param {number} n - Button index (0–15).
   * @returns {boolean}
   */
  btn       (n)   { return _gpState._down[n]     ?? false; },

  /**
   * Returns `true` on the single frame a gamepad button was first pressed.
   * @param {number} n - Button index (0–15).
   * @returns {boolean}
   */
  btnPress  (n)   { return _gpState._pressed[n]  ?? false; },

  /**
   * Returns `true` on the single frame a gamepad button was released.
   * @param {number} n - Button index (0–15).
   * @returns {boolean}
   */
  btnRelease(n)   { return _gpState._released[n] ?? false; },

  // ── 2D overlay drawing ────────────────────────────────────────────────────
  /**
   * Clears the 2D overlay canvas. Called automatically each frame before `draw()`.
   * @param {string} [color] - If provided, fills the canvas with this solid color.
   *   If omitted, clears to transparent.
   */
  cls(color) {
    if (color) {
      _ctx().fillStyle = color;
      _ctx().fillRect(0, 0, _config.width, _config.height);
    } else {
      _ctx().clearRect(0, 0, _config.width, _config.height);
    }
  },

  /**
   * Draws text onto the 2D overlay using the Cherry bitmap font. Call inside `draw()`.
   * Each glyph is 7 px wide × 12 px tall at default scale.
   * @param {string|number} text - The text to render.
   * @param {number} x - Left edge (or anchor for center/right align) in internal resolution space.
   * @param {number} y - Top edge in internal resolution space.
   * @param {string|{ color?: string, align?: 'left'|'center'|'right', widthScale?: number, heightScale?: number, bold?: boolean }} [style='#ffffff']
   *   Pass a CSS color string for quick use, or an options object for full control.
   *   - `color`       — CSS color string (default: `'#ffffff'`).
   *   - `align`       — `'left'` | `'center'` | `'right'` (default: `'left'`).
   *   - `widthScale`  — integer pixel multiplier for glyph width (default: `1`).
   *   - `heightScale` — integer pixel multiplier for glyph height (default: `1`).
   *   - `bold`        — use the bold Cherry variant (default: `false`).
   */
  print(text, x, y, style = {}) {
    const str         = String(text);
    const color       = typeof style === 'string' ? style : (style.color       ?? '#ffffff');
    const align       = typeof style === 'object' ? (style.align               ?? 'left')  : 'left';
    const widthScale  = typeof style === 'object' ? (style.widthScale          ?? 1)        : 1;
    const heightScale = typeof style === 'object' ? (style.heightScale         ?? 1)        : 1;
    const bold        = typeof style === 'object' ? (style.bold                ?? false)    : false;

    const totalWidth = str.length * 7 * widthScale;
    let drawX = x;
    if (align === 'center') drawX = x - totalWidth / 2;
    else if (align === 'right') drawX = x - totalWidth;

    const ctx = _ctx();
    ctx.save();
    ctx.fillStyle = color;
    _printBitmap(ctx, str, drawX, y, widthScale, heightScale, bold);
    ctx.restore();
  },

  /**
   * Draws a 1 px outline rectangle onto the 2D overlay. Call inside `draw()`.
   * @param {number} x
   * @param {number} y
   * @param {number} w
   * @param {number} h
   * @param {string} [color='#ffffff']
   */
  rect(x, y, w, h, color = '#ffffff') {
    const ctx = _ctx();
    ctx.save();
    ctx.strokeStyle = _color(color);
    ctx.lineWidth   = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w, h);
    ctx.restore();
  },

  /**
   * Draws a filled rectangle onto the 2D overlay. Call inside `draw()`.
   * @param {number} x
   * @param {number} y
   * @param {number} w
   * @param {number} h
   * @param {string} [color='#ffffff']
   */
  rectFill(x, y, w, h, color = '#ffffff') {
    const ctx = _ctx();
    ctx.save();
    ctx.fillStyle = _color(color);
    ctx.fillRect(x, y, w, h);
    ctx.restore();
  },

  /**
   * Draws a 1 px line segment onto the 2D overlay. Call inside `draw()`.
   * @param {number} x0 - Start X.
   * @param {number} y0 - Start Y.
   * @param {number} x1 - End X.
   * @param {number} y1 - End Y.
   * @param {string} [color='#ffffff']
   */
  line(x0, y0, x1, y1, color = '#ffffff') {
    const ctx = _ctx();
    ctx.save();
    ctx.fillStyle = _color(color);
    _plotLine(ctx, x0, y0, x1, y1);
    ctx.restore();
  },

  /**
   * Draws a 1 px outline circle onto the 2D overlay. Call inside `draw()`.
   * @param {number} x - Centre X.
   * @param {number} y - Centre Y.
   * @param {number} r - Radius.
   * @param {string} [color='#ffffff']
   */
  circ(x, y, r, color = '#ffffff') {
    const ctx = _ctx();
    ctx.save();
    ctx.fillStyle = _color(color);
    _plotCircle(ctx, x, y, r);
    ctx.restore();
  },

  /**
   * Draws a filled circle onto the 2D overlay. Call inside `draw()`.
   * @param {number} x - Centre X.
   * @param {number} y - Centre Y.
   * @param {number} r - Radius.
   * @param {string} [color='#ffffff']
   */
  circFill(x, y, r, color = '#ffffff') {
    const ctx = _ctx();
    ctx.save();
    ctx.fillStyle = _color(color);
    _plotCircleFill(ctx, x, y, r);
    ctx.restore();
  },

  /**
   * Draws a single pixel onto the 2D overlay. Call inside `draw()`.
   * @param {number} x
   * @param {number} y
   * @param {string} [color='#ffffff']
   */
  pixel(x, y, color = '#ffffff') {
    const ctx = _ctx();
    ctx.save();
    ctx.fillStyle = _color(color);
    ctx.fillRect(Math.floor(x), Math.floor(y), 1, 1);
    ctx.restore();
  },

  /**
   * Draws a sprite cell from a loaded sprite sheet onto the 2D overlay. Call inside `draw()`.
   * @param {string} sheetKey - Asset key from the manifest.
   * @param {number} index    - Zero-based sprite index within the sheet.
   * @param {number} x        - Destination X in internal resolution space.
   * @param {number} y        - Destination Y in internal resolution space.
   * @param {{ w?: number, h?: number }} [opts]
   *   - `w` — span this many cells horizontally (default: 1).
   *   - `h` — span this many cells vertically (default: 1).
   */
  spr(sheetKey, index, x, y, opts = {}) {
    const asset = _assets[sheetKey];
    if (!asset) { warn(`spr: sheet "${sheetKey}" not loaded`); return; }
    const cw = asset.cellW * (opts.w ?? 1);
    const ch = asset.cellH * (opts.h ?? 1);
    const cols = Math.floor(asset.texture.image.width / asset.cellW);
    const col  = index % cols;
    const row  = Math.floor(index / cols);
    _ctx().drawImage(
      asset.texture.image,
      col * asset.cellW, row * asset.cellH, asset.cellW * (opts.w ?? 1), asset.cellH * (opts.h ?? 1),
      x, y, cw, ch,
    );
  },

  /**
   * Draws a named rectangular region from a sprite sheet onto the 2D overlay. Call inside `draw()`.
   * Regions are defined in the manifest under `sprites.<key>.regions`.
   * @param {string} sheetKey   - Asset key from the manifest.
   * @param {string} regionName - Name of the region as defined in the manifest.
   * @param {number} x          - Destination X in internal resolution space.
   * @param {number} y          - Destination Y in internal resolution space.
   */
  sprRegion(sheetKey, regionName, x, y) {
    const asset = _assets[sheetKey];
    if (!asset) { warn(`sprRegion: sheet "${sheetKey}" not loaded`); return; }
    const region = asset.regions?.[regionName];
    if (!region) { warn(`sprRegion: region "${regionName}" not found in "${sheetKey}"`); return; }
    _ctx().drawImage(
      asset.texture.image,
      region.x, region.y, region.w, region.h,
      x, y, region.w, region.h,
    );
  },

  // ── manual 3D rendering ───────────────────────────────────────────────────
  /**
   * Renders the 3D scene immediately using the current camera.
   * Only needed when `manualRender: true` was passed to `init()`.
   * Call this inside `draw()`, typically after setting `viewport()`.
   */
  render3d() {
    _renderer.render(_scene, _threeCamera);
  },

  /**
   * Sets the 3D render region and scissor rectangle to a sub-area of the canvas.
   * Coordinates are in internal resolution space (top-left origin).
   * Use with `manualRender: true` for split-screen or picture-in-picture effects.
   * @param {number} x - Left edge.
   * @param {number} y - Top edge.
   * @param {number} w - Width.
   * @param {number} h - Height.
   */
  viewport(x, y, w, h) {
    const scaleX = _renderer.domElement.width  / _config.width;
    const scaleY = _renderer.domElement.height / _config.height;
    // Three.js viewport origin is bottom-left; Neptune's is top-left
    _renderer.setViewport(x * scaleX, (_config.height - y - h) * scaleY, w * scaleX, h * scaleY);
    _renderer.setScissor (x * scaleX, (_config.height - y - h) * scaleY, w * scaleX, h * scaleY);
    _renderer.setScissorTest(true);
  },

  // ── raycasting ────────────────────────────────────────────────────────────
  /**
   * Casts a ray from `origin` in `direction` and returns information about the first hit,
   * or `null` if nothing was hit.
   * @param {[number,number,number]} origin    - Ray start point in world space.
   * @param {[number,number,number]} direction - Ray direction (normalised internally).
   * @param {object} [opts]
   * @param {number}  [opts.maxDist]           - Maximum ray travel distance.
   * @param {(obj: NObject) => boolean} [opts.filter] - Return `false` to exclude an object.
   * @returns {{ hit: true, object: NObject, point: [number,number,number], distance: number }|null}
   */
  raycast(origin, direction, opts = {}) {
    const rc  = new THREE.Raycaster();
    const org = new THREE.Vector3(...origin);
    const dir = new THREE.Vector3(...direction).normalize();
    rc.set(org, dir);
    if (opts.maxDist) rc.far = opts.maxDist;

    const candidates = _sceneObjects
      .filter(n => !opts.filter || opts.filter(n))
      .map(n => n._obj);

    const hits = rc.intersectObjects(candidates, true);
    if (!hits.length) return null;

    const hit = hits[0];
    // Walk up to find the NObject
    let obj3 = hit.object;
    let nobj = null;
    while (obj3) {
      nobj = _sceneObjects.find(n => n._obj === obj3);
      if (nobj) break;
      obj3 = obj3.parent;
    }
    return {
      hit: true,
      object:   nobj,
      point:    [hit.point.x, hit.point.y, hit.point.z],
      distance: hit.distance,
    };
  },

  /**
   * Unprojects a 2D screen coordinate to a 3D world-space position using the current camera.
   * @param {number} screenX - X in internal resolution space (0–width).
   * @param {number} screenY - Y in internal resolution space (0–height).
   * @param {number} [depth=0] - NDC depth value (-1 = near plane, 1 = far plane, 0 = mid).
   * @returns {[number, number, number]}
   */
  screenToWorld(screenX, screenY, depth = 0) {
    const v = new THREE.Vector3(
      (screenX / _config.width)  * 2 - 1,
      -((screenY / _config.height) * 2 - 1),
      depth,
    );
    v.unproject(_threeCamera);
    return [v.x, v.y, v.z];
  },

  /**
   * Returns all NObjects whose `tag` property matches the given string.
   * @param {string} tag
   * @returns {NObject[]}
   */
  findByTag(tag) {
    return _sceneObjects.filter(n => n.tag === tag);
  },

  /**
   * Returns a shallow copy of the array of all NObjects currently in the scene.
   * @returns {NObject[]}
   */
  findAll() {
    return [..._sceneObjects];
  },

  // ── persistence ───────────────────────────────────────────────────────────
  /**
   * Persists a JSON-serialisable value to `localStorage`, scoped to this page origin.
   * @param {string} key   - Storage key (automatically namespaced).
   * @param {*}      value - Any JSON-serialisable value.
   */
  save(key, value) {
    try { localStorage.setItem('neptune:' + key, JSON.stringify(value)); } catch (e) { /* quota */ }
  },

  /**
   * Reads a previously saved value from `localStorage`.
   * Returns `defaultValue` if the key does not exist or cannot be parsed.
   * @param {string} key          - Storage key used with `save()`.
   * @param {*}      defaultValue - Fallback when the key is absent.
   * @returns {*}
   */
  loadData(key, defaultValue) {
    try {
      const v = localStorage.getItem('neptune:' + key);
      return v !== null ? JSON.parse(v) : defaultValue;
    } catch { return defaultValue; }
  },

  /**
   * Removes a saved key from `localStorage`.
   * @param {string} key
   */
  deleteSave(key) {
    localStorage.removeItem('neptune:' + key);
  },

  /**
   * Returns `true` if a value has been saved under the given key.
   * @param {string} key
   * @returns {boolean}
   */
  hasSave(key) {
    return localStorage.getItem('neptune:' + key) !== null;
  },

  // ── Three.js escape hatch ─────────────────────────────────────────────────
  /**
   * Direct access to the underlying Three.js objects.
   * Use only when Neptune's API does not cover your use case.
   * @type {{ scene: THREE.Scene, renderer: THREE.WebGLRenderer, camera: THREE.Camera, THREE: typeof THREE }}
   */
  _three: {
    get scene()    { return _scene; },
    get renderer() { return _renderer; },
    get camera()   { return _threeCamera; },
    get THREE()    { return THREE; },
  },
};

export default Neptune;
