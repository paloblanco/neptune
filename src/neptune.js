/**
 * Neptune — JavaScript 3D Game Engine  (v0.1.0)
 * Design doc: neptune-design-doc-v0.2.md
 *
 * Peer dependency: three (>=r150)
 * ESM only — import Neptune from 'neptune-engine'
 */

import * as THREE from 'three';

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
  add(child) {
    this._obj.add(child._obj);
    return this;
  }
  remove(child) {
    this._obj.remove(child._obj);
    return this;
  }

  // sprite swap (for objects using a sprite-sheet material) -----------------
  setSprite(sheetKey, index) {
    const asset = _assets[sheetKey];
    if (!asset) { warn(`setSprite: sheet "${sheetKey}" not loaded`); return; }
    _applySpriteUV(this._obj, asset, index);
  }

  // model animation ---------------------------------------------------------
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

const camera = {
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

  setPosition(x, y, z) {
    _threeCamera.position.set(x, y, z);
  },

  lookAt(x, y, z) {
    _threeCamera.lookAt(x, y, z);
  },

  /** Yaw-only forward unit vector (y = 0, normalised), useful for movement. */
  forward() {
    const dir = new THREE.Vector3();
    _threeCamera.getWorldDirection(dir);
    dir.y = 0;
    dir.normalize();
    return [dir.x, dir.y, dir.z];
  },

  right() {
    const dir = new THREE.Vector3();
    _threeCamera.getWorldDirection(dir);
    dir.y = 0;
    dir.normalize();
    const right = new THREE.Vector3();
    right.crossVectors(dir, new THREE.Vector3(0, 1, 0));
    return [right.x, right.y, right.z];
  },

  attachTo(nobj, opts = {}) {
    _cameraState._attached = nobj;
    _cameraState._attachOffset = opts.offset ?? [0, 0, 0];
  },

  detach() {
    _cameraState._attached = null;
  },
};

// ─── Mouse ───────────────────────────────────────────────────────────────────

const mouse = {
  get x() { return _mouseState.x; },
  get y() { return _mouseState.y; },
  get dx() { return _mouseState.dx; },
  get dy() { return _mouseState.dy; },

  _mode: 'gui',
  _modeOpts: {},
  _pointerLocked: false,
  capturePrompt: null,

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

  btn(b) {
    return _mouseState._btnsDown.has(b);
  },
  btnPress(b) {
    return _mouseState._btnsPressed.has(b);
  },
  btnRelease(b) {
    return _mouseState._btnsReleased.has(b);
  },

  /** True if cursor is inside rect and left-clicked this frame. */
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

const audio = {
  _tracks: {},   // key → { buffer, source, gainNode, opts }

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

  stop(key) {
    const t = this._tracks[key];
    if (t?.playing) { t.source.stop(); t.playing = false; }
  },

  setVolume(key, vol) {
    const t = this._tracks[key];
    if (t) t.gainNode.gain.value = vol * _audioCtx._gain;
  },

  setMasterVolume(vol) {
    _audioCtx._gain = vol;
    if (_audioCtx._master) _audioCtx._master.gain.value = _audioCtx._muted ? 0 : vol;
  },

  mute() {
    _audioCtx._muted = true;
    if (_audioCtx._master) _audioCtx._master.gain.value = 0;
  },

  unmute() {
    _audioCtx._muted = false;
    if (_audioCtx._master) _audioCtx._master.gain.value = _audioCtx._gain;
  },
};

// ─── Math ────────────────────────────────────────────────────────────────────

const math = {
  lerp: (a, b, t) => a + (b - a) * t,
  clamp: (v, mn, mx) => Math.max(mn, Math.min(mx, v)),
  rnd:   (n) => Math.random() * n,
  rndi:  (n) => Math.floor(Math.random() * n),
  vec3:  (x = 0, y = 0, z = 0) => [x, y, z],
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
  _overlayCtx.font = '8px monospace';
  _overlayCtx.textBaseline = 'top';
  _overlayCtx.fillText('NOW LOADING...', W / 2 - 36, H / 2 - 4);
}

function _drawErrorScreen(msg) {
  const W = _config.width;
  const H = _config.height;
  _overlayCtx.fillStyle = '#1a0000';
  _overlayCtx.fillRect(0, 0, W, H);
  _overlayCtx.fillStyle = '#ff4444';
  _overlayCtx.font = '7px monospace';
  _overlayCtx.textBaseline = 'top';
  const lines = msg.split('\n');
  lines.forEach((l, i) => _overlayCtx.fillText(l, 4, 4 + i * 10));
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

// ─── Neptune public API ───────────────────────────────────────────────────────

const Neptune = {
  // Lifecycle callbacks — developer assigns these
  update:     null,
  draw:       null,
  loadScreen: null,

  // Sub-APIs
  camera,
  mouse,
  audio,
  math,

  // ── init ───────────────────────────────────────────────────────────────────
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
  start() {
    assertInit();
    if (_running) return;
    _running = true;
    _lastTime = performance.now();
    _animationFrameId = requestAnimationFrame(_loop);
  },

  // ── load ──────────────────────────────────────────────────────────────────
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

  createTileSet(defs) {
    // Just return the defs object — used as a look-up table by createTilemap
    return defs;
  },

  createTilemap(opts) {
    return _buildTilemap(opts);
  },

  // ── lighting ──────────────────────────────────────────────────────────────
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

  // ── input ─────────────────────────────────────────────────────────────────
  keyDown   (key) { return _keysDown.has(key); },
  keyPress  (key) { return _keysPressed.has(key); },
  keyRelease(key) { return _keysReleased.has(key); },

  btn       (n)   { return _gpState._down[n]     ?? false; },
  btnPress  (n)   { return _gpState._pressed[n]  ?? false; },
  btnRelease(n)   { return _gpState._released[n] ?? false; },

  // ── 2D overlay drawing ────────────────────────────────────────────────────
  cls(color) {
    if (color) {
      _ctx().fillStyle = color;
      _ctx().fillRect(0, 0, _config.width, _config.height);
    } else {
      _ctx().clearRect(0, 0, _config.width, _config.height);
    }
  },

  print(text, x, y, style = {}) {
    const ctx  = _ctx();
    const color = typeof style === 'string' ? style : (style.color ?? '#ffffff');
    const font  = typeof style === 'object' ? (style.font  ?? '8px monospace') : '8px monospace';
    const align = typeof style === 'object' ? (style.align ?? 'left') : 'left';
    ctx.save();
    ctx.fillStyle   = color;
    ctx.font        = font;
    ctx.textAlign   = align;
    ctx.textBaseline = 'top';
    ctx.fillText(String(text), x, y);
    ctx.restore();
  },

  rect(x, y, w, h, color = '#ffffff') {
    const ctx = _ctx();
    ctx.save();
    ctx.strokeStyle = _color(color);
    ctx.lineWidth   = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w, h);
    ctx.restore();
  },

  rectFill(x, y, w, h, color = '#ffffff') {
    const ctx = _ctx();
    ctx.save();
    ctx.fillStyle = _color(color);
    ctx.fillRect(x, y, w, h);
    ctx.restore();
  },

  line(x0, y0, x1, y1, color = '#ffffff') {
    const ctx = _ctx();
    ctx.save();
    ctx.strokeStyle = _color(color);
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(x0 + 0.5, y0 + 0.5);
    ctx.lineTo(x1 + 0.5, y1 + 0.5);
    ctx.stroke();
    ctx.restore();
  },

  circ(x, y, r, color = '#ffffff') {
    const ctx = _ctx();
    ctx.save();
    ctx.strokeStyle = _color(color);
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  },

  circFill(x, y, r, color = '#ffffff') {
    const ctx = _ctx();
    ctx.save();
    ctx.fillStyle = _color(color);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  },

  pixel(x, y, color = '#ffffff') {
    const ctx = _ctx();
    ctx.save();
    ctx.fillStyle = _color(color);
    ctx.fillRect(Math.floor(x), Math.floor(y), 1, 1);
    ctx.restore();
  },

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
  render3d() {
    _renderer.render(_scene, _threeCamera);
  },

  viewport(x, y, w, h) {
    const scaleX = _renderer.domElement.width  / _config.width;
    const scaleY = _renderer.domElement.height / _config.height;
    // Three.js viewport origin is bottom-left; Neptune's is top-left
    _renderer.setViewport(x * scaleX, (_config.height - y - h) * scaleY, w * scaleX, h * scaleY);
    _renderer.setScissor (x * scaleX, (_config.height - y - h) * scaleY, w * scaleX, h * scaleY);
    _renderer.setScissorTest(true);
  },

  // ── raycasting ────────────────────────────────────────────────────────────
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

  screenToWorld(screenX, screenY, depth = 0) {
    const v = new THREE.Vector3(
      (screenX / _config.width)  * 2 - 1,
      -((screenY / _config.height) * 2 - 1),
      depth,
    );
    v.unproject(_threeCamera);
    return [v.x, v.y, v.z];
  },

  findByTag(tag) {
    return _sceneObjects.filter(n => n.tag === tag);
  },

  findAll() {
    return [..._sceneObjects];
  },

  // ── persistence ───────────────────────────────────────────────────────────
  save(key, value) {
    try { localStorage.setItem('neptune:' + key, JSON.stringify(value)); } catch (e) { /* quota */ }
  },

  loadData(key, defaultValue) {
    try {
      const v = localStorage.getItem('neptune:' + key);
      return v !== null ? JSON.parse(v) : defaultValue;
    } catch { return defaultValue; }
  },

  deleteSave(key) {
    localStorage.removeItem('neptune:' + key);
  },

  hasSave(key) {
    return localStorage.getItem('neptune:' + key) !== null;
  },

  // ── Three.js escape hatch ─────────────────────────────────────────────────
  _three: {
    get scene()    { return _scene; },
    get renderer() { return _renderer; },
    get camera()   { return _threeCamera; },
    get THREE()    { return THREE; },
  },
};

export default Neptune;
