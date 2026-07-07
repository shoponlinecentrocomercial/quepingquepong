'use strict';
// Cliente completo del ping pong: estado, modos (1P/local/online), render
// pixel-retro pseudo-3D, IA, red con predicción, efectos y audio.
// Classic script (sin módulos): los tests de Playwright acceden a los
// let/const de nivel superior con page.evaluate directamente.

// ---------------------------------------------------------------- constantes

// Resolución "retro" interna. Todo el juego se dibuja en un canvas offscreen
// de 384 px de ancho y se escala ×3 al canvas visible con el suavizado
// desactivado: el pixelado viene de aquí, no de ningún asset.
// La ALTURA es dinámica: 216 en horizontal (16:9) y más alta en vertical,
// para que en un móvil en retrato la escena llene la pantalla (más pared/
// público arriba y más suelo abajo — la mesa se ve igual).
const LW = 384, SCALE = 3;
let LH = 216;
const CANVAS_W = LW * SCALE;
let CANVAS_H = LH * SCALE;

// Cámara pinhole detrás de la pala propia (vista tipo Punch-Out!!).
const CAM_BACK = 320;  // distancia de la cámara tras la red (y=0)
const CAM_H = 110;     // altura de la cámara sobre la mesa
const F = 260;         // focal
let HORIZON = 30;      // línea de horizonte en px del canvas lowres (dinámica)

// ---------------------------------------------------------------- elementos

const $ = id => document.getElementById(id);
const canvas = $('screen');
const ctx = canvas.getContext('2d');
const low = document.createElement('canvas');
const lctx = low.getContext('2d');

const DPR = Math.min(2, window.devicePixelRatio || 1);

// Recalcula la altura interna según la orientación. Cambiar los atributos del
// canvas resetea su contexto, así que el setTransform/imageSmoothing se
// re-aplican aquí (desviación deliberada del gotcha del billar, que tenía
// tamaño fijo; este es el ÚNICO sitio donde se tocan).
function layout() {
  const portrait = window.innerHeight > window.innerWidth * 1.15;
  const target = portrait
    ? Math.max(300, Math.min(720, Math.round(LW * (window.innerHeight - 160) / Math.max(300, window.innerWidth))))
    : 216;
  if (target === LH && canvas.width > 0 && low.width === LW) return;
  LH = target;
  HORIZON = LH === 216 ? 30 : Math.round(LH * 0.30);
  CANVAS_H = LH * SCALE;
  low.width = LW;
  low.height = LH;
  canvas.width = CANVAS_W * DPR;
  canvas.height = CANVAS_H * DPR;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.imageSmoothingEnabled = false;
}
layout();
window.addEventListener('resize', layout);
window.addEventListener('orientationchange', layout);

// ---------------------------------------------------------------- estado

let mode = null;             // null | '1p' | 'local' | 'online'
let state = null;            // estado de Physics
let sources = [null, null];  // fuentes de pala por asiento
let mySeat = 0;
let viewFlip = false;        // asiento 1 online ve la mesa girada
let names = ['—', '—'];
let cosmetics = [null, null]; // {char, paddle, table} por asiento
let ws = null;
let roomCode = null;
let aiLevel = null;

let betweenT = 0;            // pausa tras un punto (offline la controla el cliente)
let pendingWinner = null;
let serveReadyAt = 0;        // online: momento en que el server acepta el saque
let lastPaddleSend = 0;
let lastSentX = null, lastSentY = null;

let myChar = 0, myPaddle = 0, myTable = 0;

let effects = [];
let shakeT = 0, shakeMag = 0;
let crowdT = 0;
let armHitT = [-9, -9];      // tiempo del último golpe de cada asiento (para poses)
let oppMissT = -9;           // momento en que el rival del fondo perdió un punto (gesto)
let nowT = 0;                // reloj del juego en segundos

function addEffect(fx) { fx.t = 0; effects.push(fx); }
function triggerShake(dur, mag) { shakeT = dur; shakeMag = mag; }

// ---------------------------------------------------------------- fuente pixel 3×5

const FONT = {
  A: ['010','101','111','101','101'], B: ['110','101','110','101','110'],
  C: ['011','100','100','100','011'], D: ['110','101','101','101','110'],
  E: ['111','100','110','100','111'], F: ['111','100','110','100','100'],
  G: ['011','100','101','101','011'], H: ['101','101','111','101','101'],
  I: ['111','010','010','010','111'], J: ['001','001','001','101','010'],
  K: ['101','110','100','110','101'], L: ['100','100','100','100','111'],
  M: ['101','111','101','101','101'], N: ['110','101','101','101','101'],
  O: ['010','101','101','101','010'], P: ['110','101','110','100','100'],
  Q: ['010','101','101','010','001'], R: ['110','101','110','110','101'],
  S: ['011','100','010','001','110'], T: ['111','010','010','010','010'],
  U: ['101','101','101','101','111'], V: ['101','101','101','101','010'],
  W: ['101','101','111','111','101'], X: ['101','101','010','101','101'],
  Y: ['101','101','010','010','010'], Z: ['111','001','010','100','111'],
  0: ['111','101','101','101','111'], 1: ['010','110','010','010','111'],
  2: ['111','001','111','100','111'], 3: ['111','001','011','001','111'],
  4: ['101','101','111','001','001'], 5: ['111','100','111','001','111'],
  6: ['111','100','111','101','111'], 7: ['111','001','001','010','010'],
  8: ['111','101','111','101','111'], 9: ['111','101','111','001','111'],
  '!': ['010','010','010','000','010'], '¡': ['010','000','010','010','010'],
  '-': ['000','000','111','000','000'], '.': ['000','000','000','000','010'],
  ' ': ['000','000','000','000','000'],
};

function drawPixelText(c, text, x, y, scale, color) {
  c.fillStyle = color;
  let cx = x;
  for (const ch of text.toUpperCase()) {
    const g = FONT[ch] || FONT[' '];
    for (let r = 0; r < 5; r++) {
      for (let col = 0; col < 3; col++) {
        if (g[r][col] === '1') c.fillRect(cx + col * scale, y + r * scale, scale, scale);
      }
    }
    cx += 4 * scale;
  }
}
function pixelTextWidth(text, scale) { return text.length * 4 * scale - scale; }

// ---------------------------------------------------------------- sprites procedurales

// Todos los sprites se pre-dibujan en canvases offscreen al elegir modo:
// nunca se regeneran por frame (mismo principio que las partículas cacheadas
// del billar).

function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const ch = s => Math.max(0, Math.min(255, Math.round(((n >> s) & 255) * f)));
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}

// Rival de frente, 52×72 px (el doble de resolución que la primera versión:
// a la distancia a la que se dibuja, cada píxel del sprite cae ~1:1 en el
// canvas lowres, así que este detalle SÍ se ve). 4 poses: reposo, golpe,
// fallo (manos a la cabeza) y derrota (hombros caídos y lágrimas).
function buildOpponentSprites(charDef, paddleDef) {
  const make = (pose) => {
    const c = document.createElement('canvas');
    c.width = 52; c.height = 72;
    const g = c.getContext('2d');
    const P = (x, y, w, h, col) => { g.fillStyle = col; g.fillRect(x, y, w, h); };
    const skin = charDef.skin, dark = shade(charDef.skin, 0.78), hair = charDef.hair, shirt = charDef.shirt;
    const hy = pose === 'lose' ? 3 : 0; // en derrota la cabeza se hunde

    // piernas + zapatillas
    P(18, 55, 6, 11, skin); P(28, 55, 6, 11, skin);
    P(18, 55, 2, 11, dark); P(28, 55, 2, 11, dark);
    P(16, 66, 9, 5, '#e8e8f0'); P(27, 66, 9, 5, '#e8e8f0');
    P(16, 69, 9, 2, '#b8b8c8'); P(27, 69, 9, 2, '#b8b8c8');
    // pantalón
    P(15, 45, 22, 11, charDef.shorts);
    P(15, 45, 22, 2, shade(charDef.shorts, 1.25));
    P(25, 47, 2, 9, shade(charDef.shorts, 0.75));
    // camiseta (hombros más caídos en derrota)
    P(14, 25 + hy, 24, 21 - hy, shirt);
    P(14, 41, 24, 4, shade(shirt, 0.75));
    P(20, 25 + hy, 12, 2, shade(shirt, 0.7)); // cuello
    // brazos + pala según pose
    const back = paddleDef ? paddleDef.back : '#1a1a1a';
    if (pose === 'swing') {
      // brazo de la pala alzado en diagonal, el otro equilibrando
      P(8, 18, 6, 7, skin); P(11, 24, 5, 6, skin);
      P(2, 8, 9, 11, back); P(4, 10, 5, 7, shade(back, 1.3));
      P(38, 30, 6, 13, skin); P(38, 41, 6, 3, dark);
    } else if (pose === 'miss') {
      // ¡las dos manos a la cabeza!
      P(9, 14, 6, 12, skin); P(37, 14, 6, 12, skin);
      P(14, 6, 7, 5, skin); P(31, 6, 7, 5, skin);
      P(2, 40, 9, 10, back); // la pala, caída junto al pie
      P(4, 48, 5, 3, shade(back, 0.7));
    } else if (pose === 'lose') {
      // brazos colgando, largos y rectos
      P(8, 28, 6, 18, skin); P(38, 28, 6, 18, skin);
      P(8, 44, 6, 3, dark); P(38, 44, 6, 3, dark);
      P(2, 52, 9, 10, back); // pala abandonada en el suelo
    } else { // idle
      P(8, 27, 6, 14, skin); P(38, 27, 6, 14, skin);
      P(8, 39, 6, 3, dark); P(38, 39, 6, 3, dark);
      P(1, 33, 9, 11, back); P(3, 35, 5, 7, shade(back, 1.3)); // pala en mano
    }
    // cabeza
    P(16, 8 + hy, 20, 17, skin);
    P(16, 8 + hy, 2, 17, dark); P(34, 8 + hy, 2, 17, dark); // sombra lateral
    // pelo según estilo (con brillo)
    const hairHi = shade(hair, 1.4);
    if (charDef.hairStyle === 'spiky') {
      P(15, 4 + hy, 22, 6, hair);
      P(14, 0 + hy, 4, 6, hair); P(24, 0 + hy, 4, 6, hair); P(33, 0 + hy, 4, 6, hair);
      P(19, 1 + hy, 3, 4, hair); P(29, 1 + hy, 3, 4, hair);
      P(15, 5 + hy, 22, 1, hairHi);
    } else if (charDef.hairStyle === 'bob') {
      P(14, 3 + hy, 24, 8, hair);
      P(14, 11 + hy, 4, 12, hair); P(34, 11 + hy, 4, 12, hair);
      P(16, 4 + hy, 20, 1, hairHi);
    } else if (charDef.hairStyle === 'pony') {
      P(15, 4 + hy, 22, 6, hair); P(22, 1 + hy, 8, 3, hair);
      P(34, 9 + hy, 4, 15, hair); P(35, 24 + hy, 3, 4, hair);
      P(16, 5 + hy, 18, 1, hairHi);
    } else if (charDef.hairStyle === 'cap') {
      const cap = shade(charDef.shirt, 0.8);
      P(14, 3 + hy, 24, 7, cap);
      P(12, 8 + hy, 10, 3, cap); // visera
      P(15, 4 + hy, 22, 1, shade(charDef.shirt, 1.1));
      P(23, 5 + hy, 6, 4, '#e8e8f0'); // parche frontal
    } else { // flat
      P(15, 4 + hy, 22, 6, hair);
      P(16, 5 + hy, 20, 1, hairHi);
    }
    // cara: cejas, ojos con blanco y pupila, nariz, boca, mejillas
    const ink = '#181820';
    const blush = shade(skin, 0.9);
    P(19, 20 + hy, 3, 2, blush); P(30, 20 + hy, 3, 2, blush);
    if (pose === 'miss') {
      // ojos cerrados con fuerza + boca abierta de disgusto
      P(19, 13 + hy, 5, 1, ink); P(28, 13 + hy, 5, 1, ink); // cejas caídas
      P(19, 16 + hy, 5, 2, ink); P(28, 16 + hy, 5, 2, ink); // ><
      P(23, 20 + hy, 6, 4, '#7a2828');
      P(24, 21 + hy, 4, 2, '#3a1414');
    } else if (pose === 'lose') {
      P(19, 14 + hy, 5, 1, ink); P(28, 14 + hy, 5, 1, ink); // cejas tristes
      P(19, 16 + hy, 4, 2, '#f8f8ff'); P(29, 16 + hy, 4, 2, '#f8f8ff');
      P(20, 17 + hy, 2, 1, ink); P(30, 17 + hy, 2, 1, ink); // mirada baja
      P(19, 18 + hy, 2, 3, '#6ab8e8'); P(19, 22 + hy, 2, 2, '#a8d8f8'); // lágrima
      P(22, 22 + hy, 8, 1, ink); P(21, 21 + hy, 1, 1, ink); P(30, 21 + hy, 1, 1, ink); // boca ∩
    } else if (pose === 'swing') {
      P(19, 13 + hy, 5, 1, ink); P(28, 13 + hy, 5, 1, ink);
      P(19, 15 + hy, 5, 3, '#f8f8ff'); P(28, 15 + hy, 5, 3, '#f8f8ff');
      P(21, 16 + hy, 2, 2, ink); P(30, 16 + hy, 2, 2, ink); // concentrado
      P(23, 20 + hy, 6, 3, '#7a2828'); // boca abierta (esfuerzo)
    } else { // idle: media sonrisa
      P(19, 14 + hy, 5, 1, shade(hair, 0.8)); P(28, 14 + hy, 5, 1, shade(hair, 0.8));
      P(19, 15 + hy, 5, 3, '#f8f8ff'); P(28, 15 + hy, 5, 3, '#f8f8ff');
      P(20, 16 + hy, 2, 2, ink); P(29, 16 + hy, 2, 2, ink);
      P(22, 21 + hy, 8, 1, ink); P(21, 20 + hy, 1, 1, ink); P(30, 20 + hy, 1, 1, ink); // sonrisa
    }
    P(25, 17 + hy, 2, 2, dark); // nariz
    return c;
  };
  return { idle: make('idle'), swing: make('swing'), miss: make('miss'), lose: make('lose') };
}

// Juez de silla en su mesita, junto a la red. Dos poses: mira al campo
// cercano o al lejano (sigue la bola durante el rally).
function buildRefereeSprites() {
  const make = (look) => {
    const c = document.createElement('canvas');
    c.width = 30; c.height = 30;
    const g = c.getContext('2d');
    const P = (x, y, w, h, col) => { g.fillStyle = col; g.fillRect(x, y, w, h); };
    const skin = '#e0ab7d', ink = '#181820';
    const dx = look === 'near' ? -1 : 1; // desplaza cara/pupilas hacia donde mira
    // torso con chaqueta oscura + camisa y corbata
    P(7, 12, 16, 10, '#26323e');
    P(13, 12, 4, 8, '#e8e8f0');
    P(14, 13, 2, 5, '#a03030');
    // brazos apoyados en la mesa
    P(5, 16, 4, 6, '#26323e'); P(21, 16, 4, 6, '#26323e');
    P(5, 20, 4, 2, skin); P(21, 20, 4, 2, skin);
    // cabeza (ligeramente girada)
    P(9 + dx, 2, 12, 10, skin);
    P(9 + dx, 2, 12, 3, '#8a8a95'); // pelo cano
    P(8 + dx, 4, 2, 4, '#8a8a95');
    P(11 + dx * 2, 6, 3, 2, '#f8f8ff'); P(16 + dx * 2, 6, 3, 2, '#f8f8ff');
    P(12 + dx * 2, 6, 1, 2, ink); P(17 + dx * 2, 6, 1, 2, ink);
    P(13 + dx, 10, 4, 1, ink);
    // mesita del juez: tablero + faldón con marcador
    P(2, 21, 26, 3, '#6a4a2a');
    P(2, 21, 26, 1, '#8a6a40');
    P(3, 24, 24, 6, '#204060');
    P(6, 25, 8, 4, '#f0f0f8'); P(16, 25, 8, 4, '#f0f0f8'); // cartones de puntos
    P(9, 26, 2, 2, ink); P(19, 26, 2, 2, ink);
    return c;
  };
  return { near: make('near'), far: make('far') };
}
const refSprites = buildRefereeSprites();

// Brazo + pala propios en primer plano (estilo Punch-Out), 64×72, 2 poses.
// Todo conectado en vertical: goma → mango → mano → muñequera → antebrazo
// que sale en diagonal hacia la esquina inferior derecha.
function buildArmSprites(charDef, paddleDef) {
  const make = (pose) => {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 72;
    const g = c.getContext('2d');
    const skin = charDef.skin;
    const sw = pose === 'swing' ? 1 : 0; // en swing la pala se ladea (cizalla)
    // goma de la pala: "elipse" de filas apiladas, centro ~(30,16)
    const rows = [[6, 20], [3, 26], [1, 30], [0, 32], [0, 32], [1, 30], [3, 26], [6, 20]];
    const rx = 14, ry = 4;
    g.fillStyle = paddleDef.rubber;
    rows.forEach((row, i) => g.fillRect(rx + row[0] + sw * (i - 4) * 2, ry + i * 3, row[1], 3));
    g.fillStyle = shade(paddleDef.rubber, 0.7);
    g.fillRect(rx + 6 + sw * 6, ry + 21, 20, 3);
    g.fillStyle = shade(paddleDef.rubber, 1.25);
    g.fillRect(rx + 4 - sw * 6, ry + 3, 10, 3);
    // mango bajo la goma
    g.fillStyle = paddleDef.handle;
    g.fillRect(26 + sw * 7, 28, 8, 12);
    // mano agarrando el mango
    g.fillStyle = skin;
    g.fillRect(23 + sw * 7, 37, 14, 11);
    g.fillStyle = shade(skin, 0.82);
    g.fillRect(23 + sw * 7, 40, 14, 2);
    // muñequera
    g.fillStyle = charDef.shirt;
    g.fillRect(25 + sw * 7, 48, 14, 5);
    // antebrazo en diagonal hacia abajo-derecha
    g.fillStyle = skin;
    for (let i = 0; i < 20; i++) g.fillRect(27 + sw * 7 + i, 53 + i, 13, 2);
    g.fillStyle = shade(skin, 0.8);
    for (let i = 0; i < 20; i++) g.fillRect(38 + sw * 7 + i, 53 + i, 2, 2);
    return c;
  };
  return { idle: make('idle'), swing: make('swing') };
}

// Cara para los avatares del HUD y el picker de personajes.
function drawFace(g, charDef, size) {
  const s = size / 12;
  const px = (x, y, w, h, col) => { g.fillStyle = col; g.fillRect(x * s, y * s, w * s, h * s); };
  px(2, 3, 8, 8, charDef.skin);
  g.fillStyle = charDef.hair;
  if (charDef.hairStyle === 'spiky') { px(2, 1, 8, 2, charDef.hair); px(1, 0, 2, 2, charDef.hair); px(5, 0, 2, 2, charDef.hair); px(9, 0, 2, 2, charDef.hair); }
  else if (charDef.hairStyle === 'bob') { px(1, 1, 10, 3, charDef.hair); px(1, 4, 2, 5, charDef.hair); px(9, 4, 2, 5, charDef.hair); }
  else if (charDef.hairStyle === 'pony') { px(2, 1, 8, 2, charDef.hair); px(4, 0, 4, 1, charDef.hair); px(9, 3, 2, 6, charDef.hair); }
  else if (charDef.hairStyle === 'cap') { px(1, 1, 10, 2, shade(charDef.shirt, 0.8)); px(1, 3, 4, 1, shade(charDef.shirt, 0.8)); }
  else px(2, 1, 8, 2, charDef.hair);
  px(4, 6, 1.5, 1.5, '#181820'); px(7, 6, 1.5, 1.5, '#181820');
  px(5, 9, 3, 1, '#181820');
}

let oppSprites = null;  // sprites del jugador del fondo
let armSprites = null;  // brazo/pala del jugador cercano

function rebuildSprites() {
  const farSeat = viewFlip ? 0 : 1;
  const nearSeat = 1 - farSeat;
  const farCos = cosmetics[farSeat] || { char: 0, paddle: 0 };
  const nearCos = cosmetics[nearSeat] || { char: 0, paddle: 0 };
  oppSprites = buildOpponentSprites(Cosmetics.CHARACTERS[farCos.char], Cosmetics.PADDLES[farCos.paddle]);
  armSprites = buildArmSprites(Cosmetics.CHARACTERS[nearCos.char], Cosmetics.PADDLES[nearCos.paddle]);
}

// ---------------------------------------------------------------- proyección

// Proyección pinhole con el flip de vista aplicado: cada jugador online se ve
// siempre a sí mismo abajo. En 1P/local no hay flip (el J2 juega arriba).
function project(x, y, z) {
  if (viewFlip) { x = -x; y = -y; }
  const d = y + CAM_BACK;
  const s = F / d;
  return { x: LW / 2 + x * s, y: HORIZON + (CAM_H - z) * s, s };
}

// ---------------------------------------------------------------- dibujo

function tableDef() {
  // La mesa la decide el asiento 0 (creador de la sala) — misma regla que el
  // paño del billar. En 1P/local, cosmetics[0] es siempre el jugador local.
  const t = cosmetics[0] ? cosmetics[0].table : 0;
  return Cosmetics.TABLES[t];
}

// --- caché de escena estática ---------------------------------------------
// El fondo del estadio (pared, banderines, público, bandera, suelo, marca) y
// la mesa con su red se pre-renderizan en canvases: regenerarlos con cientos
// de fillRect en cada frame era el mayor coste del bucle en móviles, sobre
// todo en el layout vertical. El público y la bandera tienen una "ola" de dos
// frames → dos variantes de fondo. La clave (LH + mesa de cosmetics[0])
// invalida la caché sola al cambiar layout() o los cosméticos.
let sceneCache = null; // { LH, T, bg: [canvas, canvas], table: canvas }

function sceneCanvases() {
  const T = tableDef();
  if (sceneCache && sceneCache.LH === LH && sceneCache.T === T) return sceneCache;
  const mk = () => { const c = document.createElement('canvas'); c.width = LW; c.height = LH; return c; };
  sceneCache = { LH, T, bg: [mk(), mk()], table: mk() };
  for (let wave = 0; wave < 2; wave++) drawStadium(sceneCache.bg[wave].getContext('2d'), T, wave);
  drawTable(sceneCache.table.getContext('2d'), T);
  return sceneCache;
}

function drawStadium(g, T, wave) {
  // --- fondo: pared, público y suelo (alturas relativas a HORIZON para que
  // el layout vertical simplemente muestre más pared arriba y más suelo abajo)
  const floorY = HORIZON + 34;
  g.fillStyle = T.wall; g.fillRect(0, 0, LW, floorY);
  // en vertical: banderines de feria colgados en la pared alta
  if (LH > 216) {
    const bunting = ['#d43d3d', '#f0c541', '#3d7ad4', '#3db554', '#e060a8'];
    for (let s = 0; s < 2; s++) {
      const by = 26 + s * 26;
      g.fillStyle = shade(T.wall, 1.4);
      g.fillRect(0, by, LW, 1);
      for (let i = 0; i < 26; i++) {
        g.fillStyle = bunting[(i + s * 2) % bunting.length];
        const bx = i * 15 + 4;
        g.fillRect(bx, by + 1, 7, 3); g.fillRect(bx + 1, by + 4, 5, 2); g.fillRect(bx + 2, by + 6, 3, 2);
      }
    }
  }
  // público: bloques con "ola" de dos frames; muchas más gradas en vertical
  const rows = LH === 216 ? 3 : Math.max(4, Math.min(16, Math.floor((HORIZON - 62) / 7)));
  const crowdTop = floorY - 2 - rows * 7;
  g.fillStyle = shade(T.wall, 0.7); g.fillRect(0, crowdTop - 3, LW, floorY - crowdTop + 3);
  const crowdCols = ['#c9a06a', '#8a6a4a', '#d4b088', '#7a5a3a', '#b08a5a'];
  for (let r = 0; r < rows; r++) {
    for (let i = 0; i < 48; i++) {
      const bob = (i + r + wave) % 2;
      g.fillStyle = crowdCols[(i * 7 + r * 3) % crowdCols.length];
      g.fillRect(i * 8 + 2, crowdTop + r * 7 + bob, 4, 4);
      g.fillStyle = '#2a2f3a';
      g.fillRect(i * 8 + 1, crowdTop + 4 + r * 7 + bob, 6, 3);
    }
  }
  // bandera de la isla de Ibiza que asoma sobre el público: paño blanco con
  // el castillo sobre las olas del mar, ondeando al ritmo de la ola. Va a la
  // derecha (x=296) para no chocar con el marcador, y se dibuja DESPUÉS de la
  // grada para que nada la tape.
  {
    const fx = 296, fy = crowdTop - 16 + wave;
    g.fillStyle = '#4a3a28'; g.fillRect(fx, fy, 2, 24); // mástil clavado en la grada
    g.fillStyle = '#f6f6ee'; g.fillRect(fx + 2, fy, 18 - wave, 13); // paño
    g.fillStyle = '#7a7264'; // castillo de tres torres con almenas
    g.fillRect(fx + 5, fy + 3, 3, 5); g.fillRect(fx + 9, fy + 2, 3, 6); g.fillRect(fx + 13, fy + 3, 3, 5);
    g.fillRect(fx + 5, fy + 8, 11, 1);
    g.fillRect(fx + 5, fy + 2, 1, 1); g.fillRect(fx + 7, fy + 2, 1, 1);
    g.fillRect(fx + 9, fy + 1, 1, 1); g.fillRect(fx + 11, fy + 1, 1, 1);
    g.fillRect(fx + 13, fy + 2, 1, 1); g.fillRect(fx + 15, fy + 2, 1, 1);
    g.fillStyle = '#3a6ec0'; // olas del mar
    g.fillRect(fx + 4, fy + 10, 4, 1); g.fillRect(fx + 10, fy + 10, 4, 1);
    g.fillRect(fx + 6, fy + 11, 4, 1); g.fillRect(fx + 12, fy + 11, 3, 1);
  }
  g.fillStyle = T.floor; g.fillRect(0, floorY, LW, LH - floorY);
  g.fillStyle = shade(T.floor, 0.9);
  for (let i = 0; i < 12; i++) { // tablones del suelo en perspectiva
    const yy = floorY + 6 + i * (10 + i * 4);
    if (yy >= LH) break;
    g.fillRect(0, yy, LW, 2);
  }
  // en vertical: marca "pintada" en el suelo entre la mesa y el jugador
  if (LH > 216) {
    const txt = 'QUEPING QUEPONG';
    const tw2 = pixelTextWidth(txt, 2);
    drawPixelText(g, txt, LW / 2 - tw2 / 2, LH - 138, 2, shade(T.floor, 0.78));
  }
}

function drawTable(g, T) {
  // --- mesa por scanlines (relleno por filas para bordes de píxel nítidos)
  const nl = project(-Physics.HALF_W, -Physics.HALF_L, 0);
  const nr = project(Physics.HALF_W, -Physics.HALF_L, 0);
  const fl = project(-Physics.HALF_W, Physics.HALF_L, 0);
  const fr = project(Physics.HALF_W, Physics.HALF_L, 0);
  const yTop = Math.round(Math.min(fl.y, fr.y)), yBot = Math.round(Math.max(nl.y, nr.y));
  for (let sy = yTop; sy <= yBot; sy++) {
    const t = (sy - fl.y) / (nl.y - fl.y);
    const left = Math.round(fl.x + (nl.x - fl.x) * t);
    const right = Math.round(fr.x + (nr.x - fr.x) * t);
    g.fillStyle = T.top;
    g.fillRect(left, sy, right - left, 1);
    g.fillStyle = T.line; // líneas laterales
    g.fillRect(left, sy, 1, 1); g.fillRect(right - 1, sy, 1, 1);
  }
  // bordes delantero/trasero + línea central (dobles)
  g.fillStyle = T.line;
  g.fillRect(Math.round(fl.x), yTop, Math.round(fr.x - fl.x), 1);
  g.fillRect(Math.round(nl.x), yBot, Math.round(nr.x - nl.x), 1);
  g.fillRect(LW / 2, yTop, 1, yBot - yTop);
  // canto frontal + patas
  g.fillStyle = T.side;
  g.fillRect(Math.round(nl.x), yBot + 1, Math.round(nr.x - nl.x), 5);
  g.fillStyle = shade(T.side, 0.7);
  g.fillRect(Math.round(nl.x + 14), yBot + 6, 5, 14);
  g.fillRect(Math.round(nr.x - 19), yBot + 6, 5, 14);

  // --- red
  const nlp = project(-Physics.NET_X, 0, 0);
  const nrp = project(Physics.NET_X, 0, 0);
  const ntp = project(0, 0, Physics.NET_H);
  const netBase = Math.round(nlp.y), netTop = Math.round(ntp.y);
  g.fillStyle = '#c9c9d4'; // postes
  g.fillRect(Math.round(nlp.x), netTop, 2, netBase - netTop + 1);
  g.fillRect(Math.round(nrp.x) - 1, netTop, 2, netBase - netTop + 1);
  g.globalAlpha = 0.55;
  g.fillStyle = '#e8e8f0';
  for (let x = Math.round(nlp.x) + 3; x < nrp.x - 2; x += 3) {
    g.fillRect(x, netTop + 1, 1, netBase - netTop - 1);
  }
  g.globalAlpha = 1;
  g.fillStyle = '#f0f0f8';
  g.fillRect(Math.round(nlp.x), netTop, Math.round(nrp.x - nlp.x), 1); // cinta superior
}

function draw(dt) {
  const scene = sceneCanvases();
  const wave = Math.floor(crowdT * 2) % 2;
  const g = lctx;
  // El fondo es opaco a pantalla completa: este drawImage hace también de clear.
  g.drawImage(scene.bg[wave], 0, 0);

  if (!state) { blit(); return; }

  const farSeat = viewFlip ? 0 : 1;
  const nearSeat = 1 - farSeat;
  const farP = state.paddles[farSeat];
  const nearP = state.paddles[nearSeat];

  // --- rival del fondo (pose según lo que le acaba de pasar)
  const oppBase = project(farP.x, Physics.PADDLE_Y + 34, 0);
  let oppPose = oppSprites.idle;
  if (state.phase === 'over' && state.winner === nearSeat) oppPose = oppSprites.lose;
  else if (nowT - oppMissT < 1.4) oppPose = oppSprites.miss;
  else if (nowT - armHitT[farSeat] < 0.2) oppPose = oppSprites.swing;
  const os = oppBase.s * 1.05;
  g.drawImage(oppPose, Math.round(oppBase.x - 26 * os), Math.round(oppBase.y - 72 * os), Math.round(52 * os), Math.round(72 * os));

  // --- mesa y red (cacheadas; van después del rival para taparle las piernas)
  g.drawImage(scene.table, 0, 0);

  // --- juez en su mesita, a la izquierda de la red (sigue la bola)
  {
    const rp = project(-(Physics.HALF_W + 46), 0, 0);
    const ballNear = (viewFlip ? -state.ball.y : state.ball.y) < 0;
    const ref = state.ball.live ? (ballNear ? refSprites.near : refSprites.far)
      : refSprites[state.server === nearSeat ? 'near' : 'far'];
    const rs = rp.s * 1.15;
    g.drawImage(ref, Math.round(rp.x - 15 * rs), Math.round(rp.y - 28 * rs), Math.round(30 * rs), Math.round(30 * rs));
  }

  // --- pala del rival (flota junto a su sprite)
  const fpp = project(farP.x, farP.y, 14);
  const farCos = cosmetics[farSeat] || { paddle: 0 };
  g.fillStyle = Cosmetics.PADDLES[farCos.paddle].rubber;
  g.fillRect(Math.round(fpp.x - 3 * fpp.s), Math.round(fpp.y - 4 * fpp.s), Math.round(6 * fpp.s), Math.round(7 * fpp.s));

  // --- sombra de la bola (la señal de profundidad principal) y bola
  const b = state.ball;
  const showBall = b.live || state.phase === 'serve';
  if (showBall) {
    const sh = project(b.x, b.y, 0);
    const onTable = Math.abs(b.x) <= Physics.HALF_W && Math.abs(b.y) <= Physics.HALF_L;
    const shW = Math.max(2, Math.round((3.4 - Math.min(b.z, 160) * 0.012) * sh.s));
    g.globalAlpha = onTable ? 0.35 : 0.2;
    g.fillStyle = '#000';
    g.fillRect(Math.round(sh.x - shW / 2), Math.round(sh.y - 1), shW, 2);
    g.globalAlpha = 1;

    const pb = project(b.x, b.y, b.z);
    const r = Math.max(1, Physics.BALL_VIS_R * pb.s);
    g.fillStyle = '#f8f8f0';
    g.beginPath(); // círculo "gordo": con radios de 1-4px queda pixelado igual
    g.fillRect(Math.round(pb.x - r), Math.round(pb.y - r), Math.round(r * 2), Math.round(r * 2));
    g.fillStyle = '#c9c9b0';
    g.fillRect(Math.round(pb.x - r), Math.round(pb.y + r - 1), Math.round(r * 2), 1);
  }

  // --- brazo + pala propios en primer plano (más grande en vertical)
  const armPose = (nowT - armHitT[nearSeat] < 0.18) ? armSprites.swing : armSprites.idle;
  const ap = project(nearP.x, nearP.y, 0);
  const bob = Math.round(Math.sin(nowT * 2.2) * 2);
  const armK = LH === 216 ? 1 : 1.6;
  g.drawImage(armPose, Math.round(ap.x - 32 * armK), Math.round(LH - 70 * armK) + bob, Math.round(64 * armK), Math.round(72 * armK));

  // --- marcador pixel + indicador de saque
  const sc = viewFlip ? [state.scores[1], state.scores[0]] : state.scores;
  const scoreTxt = `${sc[0]} - ${sc[1]}`;
  const tw = pixelTextWidth(scoreTxt, 2);
  g.fillStyle = 'rgba(10,14,20,.65)';
  g.fillRect(LW / 2 - tw / 2 - 5, 4, tw + 10, 15);
  drawPixelText(g, scoreTxt, LW / 2 - tw / 2, 7, 2, '#f8f8f0');
  if (state.phase === 'serve') {
    // triángulo sobre el lado del sacador (en coordenadas de vista)
    const servesNear = state.server === nearSeat;
    const sx = servesNear ? LW / 2 - tw / 2 - 12 : LW / 2 + tw / 2 + 6;
    g.fillStyle = '#f0c541';
    g.fillRect(sx + 2, 8, 2, 6); g.fillRect(sx, 10, 6, 2);
  }

  drawEffects(g);
  blit();
}

// Copia el lowres al canvas visible a factor entero (el shake se aplica aquí,
// en píxeles enteros del lowres, para no romper la retícula).
function blit() {
  let ox = 0, oy = 0;
  if (shakeT > 0) {
    ox = Math.round((Math.random() * 2 - 1) * shakeMag);
    oy = Math.round((Math.random() * 2 - 1) * shakeMag);
  }
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  ctx.drawImage(low, ox * SCALE, oy * SCALE, CANVAS_W, CANVAS_H);
}

// ---------------------------------------------------------------- efectos

function drawEffects(g) {
  for (const fx of effects) {
    const k = fx.t / fx.dur;
    if (fx.type === 'flash') {
      const r = Math.round(2 + k * 8);
      g.globalAlpha = 1 - k;
      g.fillStyle = fx.color || '#fff';
      g.fillRect(fx.x - r, fx.y - 1, r * 2, 2);
      g.fillRect(fx.x - 1, fx.y - r, 2, r * 2);
      g.globalAlpha = 1;
    } else if (fx.type === 'puff') {
      if (!fx.parts) {
        fx.parts = []; // geometría aleatoria cacheada la primera vez (no parpadea)
        for (let i = 0; i < 5; i++) {
          fx.parts.push({ a: (i / 5) * Math.PI * 2 + Math.random(), v: 6 + Math.random() * 8 });
        }
      }
      g.globalAlpha = 1 - k;
      g.fillStyle = '#e8e8f0';
      for (const p of fx.parts) {
        g.fillRect(Math.round(fx.x + Math.cos(p.a) * p.v * k), Math.round(fx.y + Math.sin(p.a) * p.v * k * 0.5), 1, 1);
      }
      g.globalAlpha = 1;
    } else if (fx.type === 'banner') {
      const scale = 3;
      const by = HORIZON + 54; // centrado sobre la mesa sea cual sea el layout
      const w = pixelTextWidth(fx.text, scale);
      const blink = fx.t < 0.25 && Math.floor(fx.t * 20) % 2 === 0;
      g.fillStyle = 'rgba(10,14,20,.7)';
      g.fillRect(LW / 2 - w / 2 - 8, by, w + 16, 27);
      drawPixelText(g, fx.text, LW / 2 - w / 2, by + 6, scale, blink ? '#fff' : (fx.color || '#f0c541'));
      if (fx.sub) {
        const sw = pixelTextWidth(fx.sub, 1);
        drawPixelText(g, fx.sub, LW / 2 - sw / 2, by + 29, 1, '#c9d4e0');
      }
    } else if (fx.type === 'confetti') {
      if (!fx.parts) {
        fx.parts = [];
        const cols = ['#f0c541', '#d43d3d', '#3d7ad4', '#3db554', '#e060a8'];
        for (let i = 0; i < 40; i++) {
          fx.parts.push({ x: Math.random() * LW, v: 20 + Math.random() * 40, ph: Math.random() * 6, col: cols[i % cols.length] });
        }
      }
      for (const p of fx.parts) {
        const y = (p.v * fx.t + p.ph * 20) % (LH + 10) - 5;
        g.fillStyle = p.col;
        g.fillRect(Math.round(p.x + Math.sin(fx.t * 3 + p.ph) * 4), Math.round(y), 2, 2);
      }
    }
  }
}

// ---------------------------------------------------------------- audio

// WebAudio 100% procedural, sin ficheros (patrón del billar).
let audioCtx = null;
function initAudio() {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch { /* sin audio */ }
  }
}

function playSound(kind, val) {
  if (!audioCtx) return;
  if (audioCtx.state === 'suspended') audioCtx.resume();
  const t0 = audioCtx.currentTime;
  const out = audioCtx.destination;
  const vol = Math.min(1, (val || 300) / 700);

  if (kind === 'paddle' || kind === 'serve') {
    // pop de goma: ruido corto filtrado + blip
    const dur = 0.06;
    const buf = audioCtx.createBuffer(1, audioCtx.sampleRate * dur, audioCtx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    const src = audioCtx.createBufferSource(); src.buffer = buf;
    const f = audioCtx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1400 + vol * 1200;
    const gn = audioCtx.createGain(); gn.gain.value = 0.25 + vol * 0.5;
    src.connect(f); f.connect(gn); gn.connect(out); src.start(t0);
  } else if (kind === 'bounce') {
    const o = audioCtx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(220, t0);
    o.frequency.exponentialRampToValueAtTime(140, t0 + 0.07);
    const gn = audioCtx.createGain();
    gn.gain.setValueAtTime(0.25 + vol * 0.2, t0);
    gn.gain.exponentialRampToValueAtTime(0.001, t0 + 0.08);
    o.connect(gn); gn.connect(out); o.start(t0); o.stop(t0 + 0.09);
  } else if (kind === 'net') {
    const o = audioCtx.createOscillator(); o.type = 'sawtooth';
    o.frequency.setValueAtTime(120, t0);
    o.frequency.exponentialRampToValueAtTime(60, t0 + 0.15);
    const gn = audioCtx.createGain();
    gn.gain.setValueAtTime(0.2, t0);
    gn.gain.exponentialRampToValueAtTime(0.001, t0 + 0.16);
    o.connect(gn); gn.connect(out); o.start(t0); o.stop(t0 + 0.17);
  } else if (kind === 'point') {
    [523, 392].forEach((fr, i) => {
      const o = audioCtx.createOscillator(); o.type = 'square';
      o.frequency.value = fr;
      const gn = audioCtx.createGain();
      gn.gain.setValueAtTime(0.12, t0 + i * 0.09);
      gn.gain.exponentialRampToValueAtTime(0.001, t0 + i * 0.09 + 0.09);
      o.connect(gn); gn.connect(out); o.start(t0 + i * 0.09); o.stop(t0 + i * 0.09 + 0.1);
    });
  } else if (kind === 'win') {
    [523, 659, 784, 1047].forEach((fr, i) => {
      const o = audioCtx.createOscillator(); o.type = 'triangle';
      o.frequency.value = fr;
      const gn = audioCtx.createGain();
      gn.gain.setValueAtTime(0.18, t0 + i * 0.12);
      gn.gain.exponentialRampToValueAtTime(0.001, t0 + i * 0.12 + 0.25);
      o.connect(gn); gn.connect(out); o.start(t0 + i * 0.12); o.stop(t0 + i * 0.12 + 0.3);
    });
  } else if (kind === 'lose') {
    [392, 330, 262].forEach((fr, i) => {
      const o = audioCtx.createOscillator(); o.type = 'triangle';
      o.frequency.value = fr;
      const gn = audioCtx.createGain();
      gn.gain.setValueAtTime(0.16, t0 + i * 0.15);
      gn.gain.exponentialRampToValueAtTime(0.001, t0 + i * 0.15 + 0.28);
      o.connect(gn); gn.connect(out); o.start(t0 + i * 0.15); o.stop(t0 + i * 0.15 + 0.3);
    });
  }
}

// ---------------------------------------------------------------- música chiptune

// Secuenciador WebAudio procedural (sin ficheros, como todo el audio):
// melodía square, bajo triangle y "hi-hat" de ruido en bucle de 8 compases.
// El botón 🔊 del HUD (o la tecla M) silencia SOLO la música, no los efectos.
let musicMuted = false;
let musicGain = null;
const music = { timer: null, step: 0, nextT: 0 };
const MUSIC_STEP = 60 / 118 / 2; // corcheas a 118 BPM

// notas MIDI (0 = silencio), 64 pasos = 8 compases
const LEAD = [
  72, 0, 76, 79, 76, 0, 79, 81, 84, 0, 81, 79, 76, 79, 72, 0,
  74, 0, 77, 81, 77, 0, 74, 0, 71, 74, 79, 74, 71, 0, 67, 0,
  72, 0, 76, 79, 76, 0, 79, 81, 84, 81, 84, 86, 88, 0, 84, 0,
  86, 84, 81, 79, 77, 76, 74, 71, 72, 0, 76, 0, 72, 0, 0, 0,
];
const BASSLINE = [
  48, 0, 55, 0, 48, 0, 55, 0, 45, 0, 52, 0, 45, 0, 52, 0,
  50, 0, 57, 0, 50, 0, 57, 0, 43, 0, 50, 0, 43, 0, 50, 0,
  48, 0, 55, 0, 48, 0, 55, 0, 45, 0, 52, 0, 45, 0, 52, 0,
  41, 0, 48, 0, 43, 0, 50, 0, 48, 0, 43, 0, 36, 0, 0, 0,
];
const midi2f = n => 440 * Math.pow(2, (n - 69) / 12);

function ensureMusicGain() {
  if (!audioCtx || musicGain) return;
  musicGain = audioCtx.createGain();
  musicGain.gain.value = musicMuted ? 0 : 1;
  musicGain.connect(audioCtx.destination);
}

function musicNote(type, freq, t, dur, vol) {
  const o = audioCtx.createOscillator(); o.type = type; o.frequency.value = freq;
  const gn = audioCtx.createGain();
  gn.gain.setValueAtTime(vol, t);
  gn.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(gn); gn.connect(musicGain);
  o.start(t); o.stop(t + dur + 0.02);
}

function scheduleMusic() {
  if (!audioCtx) return;
  // planifica con ~0.35s de antelación (lookahead clásico de WebAudio)
  while (music.nextT < audioCtx.currentTime + 0.35) {
    const t = music.nextT, s = music.step;
    if (LEAD[s]) musicNote('square', midi2f(LEAD[s]), t, MUSIC_STEP * 0.9, 0.035);
    if (BASSLINE[s]) musicNote('triangle', midi2f(BASSLINE[s]), t, MUSIC_STEP * 0.95, 0.06);
    if (s % 2 === 1) { // hi-hat en contratiempos
      const buf = audioCtx.createBuffer(1, Math.floor(audioCtx.sampleRate * 0.03), audioCtx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
      const src = audioCtx.createBufferSource(); src.buffer = buf;
      const f = audioCtx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 6000;
      const gn = audioCtx.createGain(); gn.gain.value = 0.045;
      src.connect(f); f.connect(gn); gn.connect(musicGain); src.start(t);
    }
    music.step = (music.step + 1) % LEAD.length;
    music.nextT += MUSIC_STEP;
  }
}

function startMusic() {
  initAudio();
  if (!audioCtx || music.timer) return;
  if (audioCtx.state === 'suspended') audioCtx.resume();
  ensureMusicGain();
  music.step = 0;
  music.nextT = audioCtx.currentTime + 0.1;
  music.timer = setInterval(scheduleMusic, 150);
}

function stopMusic() {
  if (music.timer) { clearInterval(music.timer); music.timer = null; }
}

function setMusicMuted(m) {
  musicMuted = m;
  if (musicGain) musicGain.gain.value = m ? 0 : 1;
  $('musicBtn').textContent = m ? '🔇' : '🔊';
}
$('musicBtn').addEventListener('click', () => setMusicMuted(!musicMuted));

// ---------------------------------------------------------------- mandos (Gamepad API)

// Los mandos bluetooth (o USB) aparecen como gamepads normales del sistema:
// no hace falta nada específico de bluetooth. Stick izquierdo o cruceta
// mueven la pala, stick vertical regula la profundidad, y A (botón 0) saca.
// En 2P local, el primer mando conectado es J1 (abajo) y el segundo J2.
let gamepadSeen = false;
window.addEventListener('gamepadconnected', e => {
  gamepadSeen = true;
  initAudio();
  setStatus('🎮 Mando conectado');
});

function pollGamepad(index) {
  if (!gamepadSeen || !navigator.getGamepads) return null;
  let n = 0;
  for (const gp of navigator.getGamepads()) {
    if (!gp || !gp.connected) continue;
    if (n === index) return gp;
    n++;
  }
  return null;
}

// ---------------------------------------------------------------- entrada

// Pointer events unificados (ratón y táctil). Cada puntero se enruta a la
// mitad de pantalla donde EMPEZÓ, para que en 2P local los dedos puedan
// cruzarse sin robarse la pala.
const pointers = new Map(); // pointerId -> {fx, fy, half}
const keys = new Set();
let tapServe = [false, false]; // petición de saque por asiento (consumida por la fuente)

function toGame(e) {
  const r = canvas.getBoundingClientRect();
  return { fx: (e.clientX - r.left) / r.width, fy: (e.clientY - r.top) / r.height };
}

canvas.addEventListener('pointerdown', e => {
  e.preventDefault();
  initAudio();
  const p = toGame(e);
  const half = p.fy >= 0.5 ? 'bottom' : 'top';
  pointers.set(e.pointerId, { ...p, half });
  try { canvas.setPointerCapture(e.pointerId); } catch { /* punteros sintéticos */ }
  // tocar = querer sacar (la fuente decide si procede)
  if (mode === 'local') tapServe[half === 'bottom' ? 0 : 1] = true;
  else tapServe[mySeat] = true;
});
canvas.addEventListener('pointermove', e => {
  const rec = pointers.get(e.pointerId);
  if (!rec) return;
  const p = toGame(e);
  rec.fx = p.fx; rec.fy = p.fy;
});
const releasePointer = e => { pointers.delete(e.pointerId); };
canvas.addEventListener('pointerup', releasePointer);
canvas.addEventListener('pointercancel', releasePointer);

window.addEventListener('keydown', e => {
  if (e.repeat) return;
  if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
  keys.add(e.code);
  initAudio();
  if (e.code === 'Space') { tapServe[mode === 'local' ? 0 : mySeat] = true; e.preventDefault(); }
  if (e.code === 'KeyW' && mode === 'local') tapServe[1] = true;
  if (e.code === 'KeyM') setMusicMuted(!musicMuted);
});
window.addEventListener('keyup', e => keys.delete(e.code));

// ---------------------------------------------------------------- fuentes de pala

// Interfaz común: update(dt) -> {x, y} en coordenadas FÍSICAS del asiento, y
// wantsServe() -> bool (consumible). Así el bucle no distingue humano/IA/red.

function pointerSource(seat, half) {
  const sign = seat === 0 ? -1 : 1;
  let x = 0, y = sign * Physics.PADDLE_Y;
  let gpServePrev = false;
  const KEYS = half === 'top' ? ['KeyA', 'KeyD'] : ['ArrowLeft', 'ArrowRight'];
  const PAD_INDEX = half === 'top' ? 1 : 0; // 2P local: mando 1 = J1, mando 2 = J2
  return {
    update(dt) {
      let ptr = null;
      for (const rec of pointers.values()) {
        if (mode === 'local' ? rec.half === half : true) { ptr = rec; break; }
      }
      if (ptr) {
        let fx = ptr.fx;
        if (viewFlip) fx = 1 - fx;
        x = (fx - 0.5) * 2 * Physics.PADDLE_X_MAX * 1.08;
        // la vertical del dedo dentro de su mitad regula la profundidad
        let fy = ptr.fy;
        if (half === 'bottom') fy = (fy - 0.5) * 2; else fy = 1 - fy * 2;
        if (viewFlip) fy = 1 - fy;
        const depth = Physics.PADDLE_Y_MAX - Math.max(0, Math.min(1, 1 - fy)) * (Physics.PADDLE_Y_MAX - Physics.PADDLE_Y_MIN);
        y = sign * depth;
      }
      const spd = 300 * dt;
      if (keys.has(KEYS[0])) x -= spd;
      if (keys.has(KEYS[1])) x += spd;
      // mando: stick izquierdo / cruceta; el eje vertical acerca a la red
      const gp = pollGamepad(PAD_INDEX);
      if (gp) {
        const ax = gp.axes[0] || 0;
        const dpad = (gp.buttons[15] && gp.buttons[15].pressed ? 1 : 0)
          - (gp.buttons[14] && gp.buttons[14].pressed ? 1 : 0);
        const mx = Math.abs(ax) > 0.18 ? ax : dpad;
        if (mx) x += mx * 340 * dt * (viewFlip ? -1 : 1);
        const ay = gp.axes[1] || 0;
        if (Math.abs(ay) > 0.25) {
          // stick arriba = acercarse a la red, para los dos jugadores
          const depth = Math.max(Physics.PADDLE_Y_MIN, Math.min(Physics.PADDLE_Y_MAX, Math.abs(y) + ay * 90 * dt));
          y = sign * depth;
        }
        const serveBtn = gp.buttons[0] && gp.buttons[0].pressed;
        if (serveBtn && !gpServePrev) tapServe[seat] = true; // flanco de subida
        gpServePrev = serveBtn;
      }
      x = Math.max(-Physics.PADDLE_X_MAX, Math.min(Physics.PADDLE_X_MAX, x));
      return { x, y };
    },
    wantsServe() {
      if (tapServe[seat]) { tapServe[seat] = false; return true; }
      return false;
    },
  };
}

// IA local (modo 1P). El error se muestrea UNA vez por golpe entrante — la
// aleatoriedad vive aquí, fuera del motor determinista.
const AI_LEVELS = {
  easy: { maxSpeed: 95, react: 0.42, errorStd: 20, place: 'center', serveDelay: 1.3 },
  medium: { maxSpeed: 160, react: 0.26, errorStd: 9, place: 'alternate', serveDelay: 1.0 },
  hard: { maxSpeed: 235, react: 0.13, errorStd: 3.5, place: 'away', serveDelay: 0.8 },
};

function gauss(std) {
  let s = 0;
  for (let i = 0; i < 4; i++) s += Math.random() * 2 - 1;
  return s / 2 * std;
}

function aiSource(seat, level) {
  const P = AI_LEVELS[level];
  const sign = seat === 0 ? -1 : 1;
  let x = 0;
  let planned = false, reactLeft = 0, targetX = 0, corner = 1;
  let serveT = 0;
  return {
    update(dt) {
      const b = state.ball;
      const incoming = b.live && Math.sign(b.vy) === sign;
      if (incoming && !planned) { planned = 'react'; reactLeft = P.react; }
      if (!incoming) planned = false;
      if (planned === 'react') {
        reactLeft -= dt;
        if (reactLeft <= 0) {
          const pred = Physics.predictX(b, sign * Physics.PADDLE_Y);
          let desired = 0; // offset de contacto deseado → colocación del tiro
          if (P.place === 'alternate') { corner = -corner; desired = corner * 0.6; }
          else if (P.place === 'away') desired = state.paddles[1 - seat].x > 0 ? -0.8 : 0.8;
          targetX = pred.x + gauss(P.errorStd) - desired * Physics.REACH_X * 0.75;
          planned = 'go';
        }
      }
      const goal = planned === 'go' ? targetX : x * 0.98; // sin bola: hacia el centro
      const dx = goal - x;
      const step = Math.min(Math.abs(dx), P.maxSpeed * dt);
      x += Math.sign(dx) * step;
      x = Math.max(-Physics.PADDLE_X_MAX, Math.min(Physics.PADDLE_X_MAX, x));
      if (state.phase === 'serve' && state.server === seat) serveT += dt; else serveT = 0;
      return { x, y: sign * Physics.PADDLE_Y };
    },
    wantsServe() {
      if (serveT > P.serveDelay) { serveT = 0; return true; }
      return false;
    },
  };
}

// Pala del rival online: persigue con un lerp corto la última posición
// recibida en snapshot (τ≈60ms) para disimular los 20Hz.
function remoteSource(seat) {
  const sign = seat === 0 ? -1 : 1;
  const src = {
    tx: 0, ty: sign * Physics.PADDLE_Y,
    x: 0, y: sign * Physics.PADDLE_Y,
    update(dt) {
      const k = 1 - Math.exp(-dt / 0.06);
      src.x += (src.tx - src.x) * k;
      src.y += (src.ty - src.y) * k;
      return { x: src.x, y: src.y };
    },
    wantsServe() { return false; },
  };
  return src;
}

// ---------------------------------------------------------------- HUD / DOM

function setStatus(txt) { $('status').textContent = txt || ''; }

function updateHud() {
  const leftSeat = viewFlip ? 1 : 0; // el HUD muestra al jugador "de abajo" a la izquierda
  [0, 1].forEach(i => {
    const seat = i === 0 ? leftSeat : 1 - leftSeat;
    const el = $('p' + i);
    el.querySelector('.pname').textContent = names[seat] || '—';
    el.classList.toggle('active', !!state && state.phase !== 'over' && state.server === seat);
    const av = el.querySelector('.avatar');
    const g = av.getContext('2d');
    g.clearRect(0, 0, 40, 40);
    g.imageSmoothingEnabled = false;
    if (cosmetics[seat]) drawFace(g, Cosmetics.CHARACTERS[cosmetics[seat].char], 40);
  });
}

function showOver(winnerSeat) {
  const meWins = mode === 'online' ? winnerSeat === mySeat : winnerSeat === 0;
  const txt = mode === '1p'
    ? (winnerSeat === 0 ? '¡Has ganado!' : 'Ha ganado la CPU…')
    : `¡Gana ${names[winnerSeat]}!`;
  $('overText').textContent = `${txt}  ${state.scores[0]}-${state.scores[1]}`;
  $('overMsg').classList.remove('hidden');
  playSound(mode === 'local' ? 'win' : (meWins ? 'win' : 'lose'));
  if (mode !== 'online' || meWins) addEffect({ type: 'confetti', dur: 4 });
  updateHud();
}

function hideOver() {
  $('overMsg').classList.add('hidden');
  effects = effects.filter(fx => fx.type !== 'confetti');
}

const POINT_REASONS = {
  out: 'FUERA', net: 'RED', double: 'DOBLE BOTE', miss: 'NO LLEGO', serveFault: 'SAQUE NULO',
};

function pointBanner(winner, reason) {
  const mine = mode === 'online' ? winner === mySeat : winner === 0;
  const who = mode === '1p'
    ? (winner === 0 ? '¡TU PUNTO!' : 'PUNTO CPU')
    : `¡PUNTO ${(names[winner] || '').slice(0, 8)}!`;
  addEffect({ type: 'banner', dur: 1.3, text: who, sub: POINT_REASONS[reason] || '', color: mine ? '#8fdc97' : '#ff9b92' });
  playSound('point');
  if (reason === 'net') triggerShake(0.15, 1);
}

// ---------------------------------------------------------------- flujo de partida

function startMatch(newMode, opts) {
  mode = newMode;
  opts = opts || {};
  viewFlip = newMode === 'online' && mySeat === 1;
  const firstServer = opts.firstServer != null ? opts.firstServer : (Math.random() < 0.5 ? 0 : 1);
  state = Physics.createState(firstServer);
  betweenT = 0; pendingWinner = null;
  effects = [];
  armHitT = [-9, -9];
  oppMissT = -9;

  if (newMode === '1p') {
    aiLevel = opts.level;
    names = [myName() || 'Tú', `CPU (${{ easy: 'fácil', medium: 'media', hard: 'difícil' }[opts.level]})`];
    cosmetics = [
      { char: myChar, paddle: myPaddle, table: myTable },
      { char: (myChar + 1 + ['easy', 'medium', 'hard'].indexOf(opts.level)) % Cosmetics.CHARACTERS.length, paddle: (myPaddle + 2) % Cosmetics.PADDLES.length, table: myTable },
    ];
    sources = [pointerSource(0, 'bottom'), aiSource(1, opts.level)];
  } else if (newMode === 'local') {
    names = ['Jugador 1', 'Jugador 2'];
    cosmetics = [
      { char: myChar, paddle: myPaddle, table: myTable },
      { char: (myChar + 1) % Cosmetics.CHARACTERS.length, paddle: (myPaddle + 1) % Cosmetics.PADDLES.length, table: myTable },
    ];
    sources = [pointerSource(0, 'bottom'), pointerSource(1, 'top')];
  } else { // online: names/cosmetics ya vienen del servidor
    sources = [null, null];
    sources[mySeat] = pointerSource(mySeat, 'bottom');
    sources[1 - mySeat] = remoteSource(1 - mySeat);
  }

  rebuildSprites();
  $('lobby').classList.add('hidden');
  $('game').classList.remove('hidden');
  $('chat').classList.toggle('hidden', newMode !== 'online');
  $('roomTag').classList.toggle('hidden', newMode !== 'online');
  // recordatorio de controles, siempre visible bajo el canvas
  $('controls').textContent = newMode === 'local'
    ? 'J1 (abajo): dedo · ← → · mando 1 — saque: toque/Espacio/Ⓐ   |   J2 (arriba): dedo · A D · mando 2 — saque: W/Ⓐ'
    : 'Mueve la pala: desliza el dedo, ← → o el stick del mando · Saque: toca la pantalla, Espacio o Ⓐ';
  hideOver();
  updateHud();
  setStatus(serveHint());
  startMusic();
}

function serveHint() {
  if (!state) return '';
  if (state.phase === 'over') return '';
  if (state.phase !== 'serve') return '';
  const s = state.server;
  if (mode === 'online') return s === mySeat ? 'Tu saque: toca la pantalla' : `Saca ${names[s]}`;
  if (mode === 'local') return `Saca ${names[s]} (${s === 0 ? 'abajo' : 'arriba'})`;
  return s === 0 ? 'Tu saque: toca o pulsa Espacio' : 'Saca la CPU…';
}

function backToMenu() {
  if (ws) { try { ws.close(); } catch { } ws = null; }
  mode = null; state = null; roomCode = null;
  stopMusic();
  hideOver();
  $('game').classList.add('hidden');
  $('lobby').classList.remove('hidden');
}

// eventos de física → sonido y efectos (compartido online/offline)
function handleEvents(evs) {
  for (const ev of evs) {
    if (ev.type === 'paddle') {
      armHitT[ev.seat] = nowT;
      const p = project(ev.x, ev.y, ev.z);
      addEffect({ type: 'flash', dur: 0.15, x: Math.round(p.x), y: Math.round(p.y), color: '#fff' });
      playSound('paddle', ev.speed);
      if (ev.power > 0.85) triggerShake(0.12, 1);
    } else if (ev.type === 'bounce') {
      const p = project(ev.x, ev.y, 0);
      addEffect({ type: 'puff', dur: 0.3, x: Math.round(p.x), y: Math.round(p.y) });
      playSound('bounce', ev.speed);
    } else if (ev.type === 'net') {
      playSound('net');
    } else if (ev.type === 'serve') {
      armHitT[ev.seat] = nowT;
      playSound('serve', 350);
    } else if (ev.type === 'point') {
      if (mode === 'online') {
        // La predicción local solo congela la bola: el punto de verdad (y el
        // marcador) llegan siempre del servidor en el mensaje 'point'.
      } else {
        pendingWinner = ev.winner;
        betweenT = 1.4;
        pointBanner(ev.winner, ev.reason);
        if (ev.winner !== (viewFlip ? 0 : 1)) oppMissT = nowT; // gesto del rival del fondo
        updateHud();
      }
    }
  }
}

// ---------------------------------------------------------------- red (online)

function myName() { return $('nameInput').value.trim(); }

function connect(firstMsg) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = window.PINGPONG_SERVER_URL || `${proto}://${location.host}${location.pathname}`;
  let sock;
  try { sock = new WebSocket(url); } catch {
    $('lobbyError').textContent = 'No se ha podido conectar al servidor.';
    return;
  }
  ws = sock;
  ws.onopen = () => ws.send(JSON.stringify(firstMsg));
  ws.onmessage = e => onMessage(JSON.parse(e.data));
  ws.onclose = () => {
    if (mode === 'online') {
      setStatus('Conexión perdida. Vuelve al menú.');
    }
    ws = null;
  };
  ws.onerror = () => { $('lobbyError').textContent = 'No se ha podido conectar al servidor.'; };
}

function onMessage(m) {
  switch (m.t) {
    case 'error':
      $('lobbyError').textContent = m.msg;
      break;
    case 'joined':
      mySeat = m.seat;
      roomCode = m.room;
      names = m.names.slice();
      cosmetics = m.cosmetics.slice();
      $('roomCode').textContent = roomCode;
      $('lobby').classList.add('hidden');
      $('game').classList.remove('hidden');
      $('chat').classList.remove('hidden');
      $('roomTag').classList.remove('hidden');
      initAudio();
      setStatus('Esperando rival… comparte el código ' + roomCode);
      history.replaceState(null, '', location.pathname + '?sala=' + roomCode);
      break;
    case 'opponent':
      names[1 - mySeat] = m.name;
      cosmetics[1 - mySeat] = m.cosmetics;
      break;
    case 'start':
      names = m.names ? m.names.slice() : names;
      startMatch('online', { firstServer: m.server });
      addChat(null, 'Empieza la partida. ¡A ganar!');
      break;
    case 'state':
      if (mode !== 'online' || !state) break;
      applySnapshot(m);
      break;
    case 'point': {
      if (mode !== 'online' || !state) break;
      state.scores = m.scores.slice();
      pointBanner(m.winner, m.reason);
      if (m.winner === mySeat) oppMissT = nowT; // el rival del fondo falló
      serveReadyAt = performance.now() + 1000;
      if (m.over) {
        state.phase = 'over';
        state.winner = m.matchWinner;
        showOver(m.matchWinner);
      } else {
        state.phase = 'serve';
        state.server = m.server;
      }
      updateHud();
      break;
    }
    case 'serve':
      // saque del rival: el snapshot trae la bola; esto solo adelanta la pose/sonido
      if (m.seat !== mySeat) { armHitT[m.seat] = nowT; playSound('serve', 350); }
      break;
    case 'chat':
      addChat(m.from, m.text, m.seat);
      break;
    case 'left':
      setStatus('Tu rival se ha ido.');
      addChat(null, 'El rival se ha desconectado.');
      if (state) { state.phase = 'over'; }
      $('overText').textContent = 'El rival se ha desconectado';
      $('overMsg').classList.remove('hidden');
      break;
  }
}

// Reconciliación con el snapshot del servidor: corrección suave si el error es
// pequeño, snap si es grande o cambió la fase. La pala rival va aparte
// (remoteSource) para poder suavizarla sin tocar la física.
function applySnapshot(m) {
  const b = state.ball;
  const sb = m.ball;
  const err = Math.hypot(b.x - sb.x, b.y - sb.y, b.z - sb.z);
  if (state.phase !== m.phase || err > 40 || b.live !== sb.live) {
    Object.assign(b, sb);
  } else if (err > 6) {
    b.x += (sb.x - b.x) * 0.35; b.y += (sb.y - b.y) * 0.35; b.z += (sb.z - b.z) * 0.35;
    b.vx = sb.vx; b.vy = sb.vy; b.vz = sb.vz;
  }
  state.phase = m.phase;
  state.server = m.server;
  state.scores = m.scores.slice();
  state.lastTouch = m.lastTouch;
  state.serving = m.serving;
  state.bouncedOwn = m.bouncedOwn;
  state.recvBounces = m.recvBounces;
  state.netTouched = m.netTouched;
  const rs = sources[1 - mySeat];
  const sp = m.paddles[1 - mySeat];
  if (rs && rs.tx !== undefined) { rs.tx = sp.x; rs.ty = sp.y; }
  updateHud();
}

function addChat(from, text, seat) {
  const log = $('chatLog');
  const div = document.createElement('div');
  if (from === null || from === undefined) {
    div.className = 'sys'; div.textContent = text;
  } else {
    const b = document.createElement('span');
    b.className = 'from' + (seat === mySeat ? ' me' : '');
    b.textContent = from + ': ';
    div.appendChild(b);
    div.appendChild(document.createTextNode(text));
  }
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

// ---------------------------------------------------------------- bucle

let lastTs = 0;

function frame(ts) {
  const dt = Math.min(0.05, (ts - lastTs) / 1000 || 0.016);
  lastTs = ts;
  nowT += dt;
  crowdT += dt;
  if (shakeT > 0) shakeT -= dt;

  for (const fx of effects) fx.t += dt;
  effects = effects.filter(fx => fx.t < fx.dur);

  if (mode && state) {
    // 1) fuentes → posiciones de pala
    for (let seat = 0; seat < 2; seat++) {
      const src = sources[seat];
      if (!src) continue;
      const pos = src.update(dt);
      Physics.setPaddle(state, seat, pos.x, pos.y);
      // 2) saques
      if (src.wantsServe() && state.phase === 'serve' && state.server === seat && betweenT <= 0) {
        if (mode === 'online') {
          if (seat === mySeat && performance.now() >= serveReadyAt) {
            ws && ws.send(JSON.stringify({ t: 'serve' }));
            const evs = [];
            Physics.serve(state, seat, evs); // predicción local; el server manda
            handleEvents(evs);
            setStatus('');
          }
        } else {
          const evs = [];
          Physics.serve(state, seat, evs);
          handleEvents(evs);
          setStatus('');
        }
      }
    }

    // 3) pausa entre puntos (solo offline: online la lleva el servidor)
    if (mode !== 'online' && betweenT > 0) {
      betweenT -= dt;
      if (betweenT <= 0 && pendingWinner !== null) {
        Physics.applyPoint(state, pendingWinner);
        pendingWinner = null;
        updateHud();
        if (state.phase === 'over') showOver(state.winner);
        else setStatus(serveHint());
      }
    }

    // 4) física. En online esto es PREDICCIÓN para animar a 60fps entre
    // snapshots (igual que el doble motor intencional del billar): si
    // discrepa, el snapshot del servidor siempre gana.
    if (state.phase === 'rally' || state.phase === 'serve') {
      const evs = [];
      Physics.step(state, dt, evs);
      handleEvents(evs);
    }

    // 5) online: enviar mi pala (throttled ~30Hz, solo si cambió)
    if (mode === 'online' && ws && ws.readyState === 1 && ts - lastPaddleSend > 33) {
      const p = state.paddles[mySeat];
      if (p.tx !== lastSentX || p.ty !== lastSentY) {
        ws.send(JSON.stringify({ t: 'paddle', x: Math.round(p.tx * 10) / 10, y: Math.round(p.ty * 10) / 10 }));
        lastSentX = p.tx; lastSentY = p.ty;
        lastPaddleSend = ts;
      }
    }

    if (state.phase === 'serve' && !$('status').textContent) setStatus(serveHint());
  }

  // En el lobby solo se anima el logo: la escena queda tapada por el overlay
  // opaco y dibujarla igualmente saturaba el hilo principal en móviles
  // modestos (el teclado del nombre se congelaba — mismo mal que el billar).
  if (!$('lobby').classList.contains('hidden')) drawLogo(nowT);
  else if (!document.hidden) draw(dt);
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- lobby

// Logo animado del menú: letras pixel que ondulan + pelota botando delante.
// Se dibuja desde frame() solo mientras el lobby está visible.
const logoCanvas = $('logo');
const logoCtx = logoCanvas.getContext('2d');
const LOGO_COLS = ['#f0c541', '#e05545', '#3d9ad4', '#3db554', '#e060a8'];

function drawLogo(t) {
  const g = logoCtx;
  const W = logoCanvas.width, H = logoCanvas.height;
  g.clearRect(0, 0, W, H);
  const scale = 4;
  ['QUEPING', 'QUEPONG'].forEach((txt, li) => {
    let x = (W - pixelTextWidth(txt, scale)) / 2;
    const baseY = 8 + li * 30;
    [...txt].forEach((ch, i) => {
      const bob = Math.round(Math.sin(t * 2.5 + (i + li * 3.5) * 0.65) * 2);
      drawPixelText(g, ch, x + 2, baseY + bob + 2, scale, '#0c1118'); // sombra
      drawPixelText(g, ch, x, baseY + bob, scale, LOGO_COLS[(i + li * 2) % LOGO_COLS.length]);
      x += 4 * scale;
    });
  });
  // pelota que va y viene botando por delante del título
  const bx = 12 + (Math.sin(t * 0.8) * 0.5 + 0.5) * (W - 24);
  const by = 58 - Math.abs(Math.sin(t * 3.4)) * 48;
  g.fillStyle = '#0c1118'; g.fillRect(Math.round(bx) - 2, Math.round(by) - 1, 5, 5);
  g.fillStyle = '#f8f8f0'; g.fillRect(Math.round(bx) - 3, Math.round(by) - 2, 5, 5);
}

function buildPicker(containerId, items, size, drawFn, onSelect) {
  const box = $(containerId);
  items.forEach((item, idx) => {
    const btn = document.createElement('button');
    btn.className = 'pick' + (idx === 0 ? ' selected' : '');
    btn.title = item.name;
    const c = document.createElement('canvas');
    c.width = size; c.height = size;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    drawFn(g, item, size);
    btn.appendChild(c);
    btn.addEventListener('click', () => {
      box.querySelectorAll('.pick').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      onSelect(idx);
    });
    box.appendChild(btn);
  });
}

buildPicker('charPicker', Cosmetics.CHARACTERS, 36, (g, item, s) => drawFace(g, item, s), idx => { myChar = idx; });
buildPicker('paddlePicker', Cosmetics.PADDLES, 36, (g, item, s) => {
  const u = s / 11;
  g.fillStyle = item.handle; g.fillRect(4.5 * u, 6.5 * u, 2 * u, 4 * u);
  g.fillStyle = item.rubber;
  g.beginPath(); g.arc(5.5 * u, 4 * u, 3.2 * u, 0, Math.PI * 2); g.fill();
  g.fillStyle = shade(item.rubber, 0.7);
  g.fillRect(2.8 * u, 6 * u, 5.4 * u, 0.8 * u);
}, idx => { myPaddle = idx; });
buildPicker('tablePicker', Cosmetics.TABLES, 36, (g, item, s) => {
  const u = s / 11;
  g.fillStyle = item.wall; g.fillRect(0, 0, s, s);
  g.fillStyle = item.floor; g.fillRect(0, 6 * u, s, 5 * u);
  g.fillStyle = item.top; g.fillRect(1.5 * u, 3.5 * u, 8 * u, 3.5 * u);
  g.fillStyle = item.line; g.fillRect(5.3 * u, 3.5 * u, 0.5 * u, 3.5 * u);
}, idx => { myTable = idx; });

document.querySelectorAll('[data-level]').forEach(btn => {
  btn.addEventListener('click', () => {
    initAudio();
    startMatch('1p', { level: btn.dataset.level });
  });
});
$('localBtn').addEventListener('click', () => { initAudio(); startMatch('local', {}); });
$('createBtn').addEventListener('click', () => {
  $('lobbyError').textContent = '';
  connect({ t: 'create', name: myName(), char: myChar, paddle: myPaddle, table: myTable });
});
function joinFromInput() {
  const code = $('codeInput').value.trim().toUpperCase();
  if (code.length < 4) { $('lobbyError').textContent = 'El código tiene 4 letras.'; return; }
  $('lobbyError').textContent = '';
  connect({ t: 'join', room: code, name: myName(), char: myChar, paddle: myPaddle, table: myTable });
}
$('joinBtn').addEventListener('click', joinFromInput);
$('codeInput').addEventListener('keydown', e => { if (e.key === 'Enter') joinFromInput(); });

// enlace de invitación ?sala=XXXX
{
  const saved = new URLSearchParams(location.search).get('sala');
  if (saved) $('codeInput').value = saved.toUpperCase();
}

$('exitBtn').addEventListener('click', backToMenu);
$('menuBtn').addEventListener('click', backToMenu);
$('rematchBtn').addEventListener('click', () => {
  if (mode === 'online') {
    ws && ws.send(JSON.stringify({ t: 'rematch' }));
    addChat(null, 'Esperando a que tu rival acepte…');
  } else {
    // offline: saca el que perdió
    const loser = 1 - state.winner;
    startMatch(mode, { level: aiLevel, firstServer: loser });
  }
});

$('chatForm').addEventListener('submit', e => {
  e.preventDefault();
  const text = $('chatInput').value.trim();
  if (!text || !ws) return;
  ws.send(JSON.stringify({ t: 'chat', text }));
  $('chatInput').value = '';
});

requestAnimationFrame(frame);
