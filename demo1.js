import Neptune from 'neptune-engine';

// ─── Constants ───────────────────────────────────────────────────────────────
const W = 320, H = 240;
// const W = 640, H = 480;
const BOX_SPEED  = 3;     // units / second
const ROT_SPEED  = 90;    // degrees / second

// ─── Game state ──────────────────────────────────────────────────────────────
let box;
let ground;
let score      = 0;
let spinToggle = false;   // 'R' key toggles auto-spin
let flashTimer = 0;       // brief color flash on keyPress demo

// ─── Setup ───────────────────────────────────────────────────────────────────
function setupScene() {
  score      = 0;
  spinToggle = false;

  // Toon shader variants — demonstrating outlineWidth, steps, and outlineColor options
  const toon        = Neptune.addToonShader({ outlineColor: '#e8e836ff', outlineWidth: 0.15, steps: 3 });
  const toonBold    = Neptune.addToonShader({ outlineColor: '#e5fc60ff', outlineWidth: 0.10, steps: 2 });
  const toonSubtle  = Neptune.addToonShader({ outlineColor: '#3766dfff', outlineWidth: 0.02, steps: 4 });
  const toonColored = Neptune.addToonShader({ outlineColor: '#afaf50ff', outlineWidth: 0.06, steps: 3 });

  // Ground plane — no shader (flat, unlit look fits the ground)
  ground = Neptune.createBox({
    w: 20, h: 0.25, d: 20,
    color:         '#334455',
    position:      [0, -0.125, 0],
    receiveShadow: true,
  });

  // Main box — standard toon (black outline, 3 steps)
  box = Neptune.createBox({
    w: 1, h: 1, d: 1,
    color:      '#e04040',
    position:   [0, 0.5, 0],
    castShadow: true,
  });
  box.setShader(toon);

  // Decorative cubes — each with a different shader variant
  const decoShaders = [toonBold, toonSubtle, toonColored, toon];
  const positions = [
    [-4,  0.35, -3], [4,   0.35, -3],
    [-3,  0.35,  3], [3,   0.35,  3],
  ];
  const colors = ['#4488cc', '#44cc88', '#cc8844', '#cc44cc'];
  positions.forEach(([x, y, z], i) => {
    Neptune.createBox({
      w: 0.7, h: 0.7, d: 0.7,
      color:         colors[i],
      position:      [x, y, z],
      castShadow:    true,
      receiveShadow: true,
    }).setShader(decoShaders[i]);
  });

  // Lighting
  Neptune.addLight('ambient',      { color: '#7799bb', intensity: 0.5 });
  Neptune.addLight('directional',  {
    color:       '#fff5e0',
    intensity:   1.2,
    position:    [8, 12, 6],
    castShadow:  true,
  });
  Neptune.addLight('point', {
    color:    '#ff6600',
    intensity: 1.5,
    position:  [0, 3, 0],
    distance:  12,
    decay:     2,
  });

  // Camera — fixed overview angle
  Neptune.camera.setMode('perspective', { fov: 60 });
  Neptune.camera.setPosition(0, 8, 12);
  Neptune.camera.lookAt(0, 0, 0);
}

// ─── Update (fixed 60 Hz) ────────────────────────────────────────────────────
Neptune.update = function update(dt) {
  score++;

  // Movement via arrow keys or WASD
  if (Neptune.keyDown('ArrowLeft')  || Neptune.keyDown('a') || Neptune.keyDown('A'))
    box.position[0] -= BOX_SPEED * dt;
  if (Neptune.keyDown('ArrowRight') || Neptune.keyDown('d') || Neptune.keyDown('D'))
    box.position[0] += BOX_SPEED * dt;
  if (Neptune.keyDown('ArrowUp')    || Neptune.keyDown('w') || Neptune.keyDown('W'))
    box.position[2] -= BOX_SPEED * dt;
  if (Neptune.keyDown('ArrowDown')  || Neptune.keyDown('s') || Neptune.keyDown('S'))
    box.position[2] += BOX_SPEED * dt;

  // Clamp to ground bounds
  box.position[0] = Neptune.math.clamp(box.position[0], -9, 9);
  box.position[2] = Neptune.math.clamp(box.position[2], -9, 9);

  // Toggle auto-spin with R
  if (Neptune.keyPress('r') || Neptune.keyPress('R')) {
    spinToggle = !spinToggle;
    flashTimer = 30; // frames
  }

  if (spinToggle) {
    box.rotation[1] += ROT_SPEED * dt;
  }

  // Space — jump (instant Y pop, purely cosmetic here)
  if (Neptune.keyPress(' ')) {
    flashTimer = 20;
  }

  if (flashTimer > 0) flashTimer--;
};

// ─── Draw (2D overlay, every rendered frame) ─────────────────────────────────
Neptune.draw = function draw() {
  const isFlashing = flashTimer > 0;

  // ── HUD panel (top-left) — Cherry font is 7×12 px per glyph ─────────
  Neptune.rectFill(2, 2, 112, 56, 'rgba(0,0,0,0.55)');
  Neptune.rect    (2, 2, 112, 56, '#445566');

  Neptune.print('NEPTUNE v0.1', 6, 5, { color: '#88aacc' });
  Neptune.line(4, 19, 110, 19, '#334455');

  Neptune.print('SCORE', 6, 23, { color: '#aaaaaa' });
  Neptune.print(String(score).padStart(6, '0'), 50, 23, { color: '#ffdd44' });

  const spinLabel = spinToggle ? 'ON ' : 'OFF';
  const spinColor = spinToggle ? '#44ff88' : '#ff4444';
  Neptune.print('SPIN',     6, 37, { color: '#aaaaaa' });
  Neptune.print(spinLabel, 50, 37, { color: spinColor });

  if (isFlashing) {
    Neptune.circFill(108, 10, 4, '#ffdd44');
  }

  // ── Controls cheatsheet (bottom-left) ────────────────────────────────
  Neptune.rectFill(2, H - 54, 162, 52, 'rgba(0,0,0,0.55)');
  Neptune.rect    (2, H - 54, 162, 52, '#334455');

  const controls = [
    ['ARROWS/WASD', 'move'],
    ['R',           'spin toggle'],
    ['SPACE',       'flash demo'],
  ];
  controls.forEach(([key, desc], i) => {
    const y = H - 51 + i * 15;
    Neptune.print(key,   6, y, { color: '#88bbff' });
    Neptune.print(desc, 90, y, { color: '#888888' });
  });

  // ── 2D draw call sampler (bottom-right) ──────────────────────────────
  const bx = W - 84, by = H - 98;
  Neptune.rectFill(bx - 2, by - 2, 86, 100, 'rgba(0,0,0,0.55)');
  Neptune.rect    (bx - 2, by - 2, 86, 100, '#445566');

  Neptune.print('DRAW CALLS', bx, by, { color: '#88aacc' });

  // rect outline
  Neptune.rect(bx + 1, by + 14, 14, 10, '#ffdd44');
  Neptune.print('rect', bx + 18, by + 14, { color: '#aaaaaa' });

  // filled rect
  Neptune.rectFill(bx + 1, by + 28, 14, 10, '#44aaff');
  Neptune.print('fill', bx + 18, by + 28, { color: '#aaaaaa' });

  // circle outline
  Neptune.circ(bx + 8, by + 48, 6, '#ff8844');
  Neptune.print('circ', bx + 18, by + 42, { color: '#aaaaaa' });

  // filled circle
  Neptune.circFill(bx + 8, by + 63, 5, '#88cc44');
  Neptune.print('cfill', bx + 18, by + 57, { color: '#aaaaaa' });

  // line
  Neptune.line(bx + 1, by + 72, bx + 15, by + 82, '#cc44cc');
  Neptune.print('line', bx + 18, by + 72, { color: '#aaaaaa' });

  // pixels
  for (let i = 0; i < 7; i++) {
    const hue = (i / 7) * 360;
    Neptune.pixel(bx + 1 + i * 2, by + 86, `hsl(${hue},100%,60%)`);
  }
  Neptune.print('pxl', bx + 18, by + 86, { color: '#aaaaaa' });
};

// ─── Init & start ─────────────────────────────────────────────────────────────
Neptune.init({
  canvas:     '#game',
  width:      W,
  height:     H,
  scale:      'pixel',
  antialias:  false,           // smooth edges for this demo
  pixelArt:   true,
  background: '#0d0d18',
  debug:      true,
  fps:        60,
});

// No external assets for this demo — set up the scene immediately and start.
setupScene();
Neptune.start();
