// Кекс — интерактивный котик для sempik.github.io
// ---------------------------------------------------------------------------
// Рисуется процедурно (пути + градиенты, без спрайтов) на <canvas id="cat-layer">.
// Канвас всегда pointer-events: none — ввод ловим сами на window (capture) и забираем
// только то, что попало в кота или в клубок; остальная страница работает как обычно.
//
// Внутри: «кукла» (тело, голова, уши, глаза, 4 лапы с циклом шага, хвост-верлет),
// стейт-машина поведения (сидит / гуляет / прыгает на карточку / спит / охотится на лазер /
// гоняет клубок / танцует на пати), физика броска и частицы (сердечки, Z z z, пыль).

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);
const sgn = (v) => (v < 0 ? -1 : 1);
const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const toward = (v, target, step) => (v < target ? Math.min(v + step, target) : Math.max(v - step, target));
const follow = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const now = () => performance.now() / 1000;

// ---- кукла: локальные единицы, кот смотрит вправо, (0,0) — земля между лапами ----
const PIV = 27; // точка вращения всего кота (центр тела) над землёй
const BPX = -17, BPY = -14; // вокруг этой точки тело наклоняется, когда кот садится
const NECK_X = 15, NECK_Y = -35;
const TAIL_X = -27, TAIL_Y = -31;
const SCRUFF_X = 9, SCRUFF_Y = -44; // загривок — за него таскаем
const COM_X = -6, COM_Y = -26; // центр масс
const HANG_L = Math.hypot(COM_X - SCRUFF_X, COM_Y - SCRUFF_Y);
// лапы: 0 — передняя ближняя, 1 — задняя ближняя, 2 — передняя дальняя, 3 — задняя дальняя
const HIP_X = [13, -16, 9, -20];
const HIP_Y = [-22, -23, -23, -24];
const FOOT_STAND = [15, -14, 10, -19];
const FOOT_SIT = [9, -1, 4, -8];
const FOOT_STRETCH = [33, -16, 28, -21];
const HIP_SIT_X = [0, -8, 0, -13];
const HIP_SIT_Y = [0, -7, 0, -8];
const LEG_L = 23, LEG_AIR = 19;
const WALK_OFF = [0.25, 0, 0.75, 0.5];
const RUN_OFF = [0.52, 0, 0.6, 0.08];
const OL = 1.3; // половина толщины контура
const TN = 11, TSEG = 4.5; // хвост: точек и длина сегмента
const G = 2600; // гравитация, px/s²
const STEP = 1 / 120;

export function initCat({ canvas, config, audio, env, toast } = {}) {
  const noop = { drop() {} };
  if (!canvas || typeof canvas.getContext !== "function") return noop;
  const ctx = canvas.getContext("2d");
  if (!ctx) return noop;

  // ---------------------------------------------------------------- конфиг
  const theme = Object.assign(
    { pink: "#ff8cc6", hot: "#ff3d9a", violet: "#9b7bff", deep: "#2a1446", ink: "#f6f0ff" },
    config?.theme || {}
  );
  const catCfg = config?.cat || {};
  const NAME = catCfg.name || "Кекс";
  const DEF_PH = {
    click: ["мяу", "мяу?", "мрр?"],
    pet: ["мррр…"],
    drag: ["эй!"],
    land: ["я так и планировал"],
    wake: ["м?"],
    laser: ["ТОЧКА!!!"],
    yarn: ["клубок!"],
  };
  const PH = {};
  for (const k in DEF_PH) {
    const a = catCfg.phrases?.[k];
    PH[k] = Array.isArray(a) && a.length ? a.map(String) : DEF_PH[k];
  }
  const ANGRY_LINE = "не трогай, я занят";
  const CLICK_LINES = PH.click.filter((s) => s !== ANGRY_LINE);
  if (!CLICK_LINES.length) CLICK_LINES.push("мяу");
  const RM = !!env?.reducedMotion;
  const isMobile = () => (env && "mobile" in env ? !!env.mobile : innerWidth < 900);
  const sfx = (fn, arg) => {
    try { audio?.[fn]?.(arg); } catch (_) { /* звук не обязателен */ }
  };
  const lastPick = new Map();
  const pickFresh = (list) => {
    if (list.length < 2) return list[0];
    let s;
    do s = list[(Math.random() * list.length) | 0]; while (s === lastPick.get(list));
    lastPick.set(list, s);
    return s;
  };

  // ---------------------------------------------------------------- палитра кота
  const C = {
    line: "#3b2254",
    fur: "#fffafd",
    furShade: "#eadff4",
    furFar: "#d9cbe8",
    furFarShade: "#c4b2da",
    point: "#b39edb",
    pointDeep: "#9580c6",
    innerEar: "#ffa6cf",
    nose: "#ff74b0",
    eyeTop: "#120a20",
    eyeBot: "#6446c8",
    pupil: "#05020b",
    mouth: "#5b1134",
    tongue: "#ff86b0",
    collar: theme.hot,
    charm: "#ffd6ea",
    charmCore: "#ff4f9f",
    whisker: "rgba(240,232,255,0.8)",
    bean: "#ff9cc8",
  };
  const FONT_BUBBLE = '700 13px Manrope, "Segoe UI", system-ui, sans-serif';
  const FONT_Z = [
    '800 12px Unbounded, Manrope, system-ui, sans-serif',
    '800 15px Unbounded, Manrope, system-ui, sans-serif',
    '800 19px Unbounded, Manrope, system-ui, sans-serif',
  ];
  const RAINBOW = [];
  for (let i = 0; i < 12; i++) RAINBOW.push(`hsl(${i * 30},95%,72%)`);

  // градиенты создаём один раз в локальных координатах — дальше их двигает трансформация
  const mkLin = (x0, y0, x1, y1, stops) => {
    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    for (const [o, c] of stops) g.addColorStop(o, c);
    return g;
  };
  const mkRad = (x0, y0, r0, x1, y1, r1, stops) => {
    const g = ctx.createRadialGradient(x0, y0, r0, x1, y1, r1);
    for (const [o, c] of stops) g.addColorStop(o, c);
    return g;
  };
  const gBody = mkLin(0, -44, 0, -11, [[0, "#ffffff"], [0.55, C.fur], [1, C.furShade]]);
  const gHead = mkLin(0, -19, 0, 17, [[0, "#ffffff"], [0.6, C.fur], [1, "#efe4f7"]]);
  const gHaunch = mkLin(0, -20, 0, 0, [[0, "#ffffff"], [1, C.furShade]]);
  const gEarNear = mkLin(0, 0, 0, -16, [[0, C.fur], [0.45, C.fur], [1, C.point]]);
  const gEarFar = mkLin(0, 0, 0, -16, [[0, C.furFar], [0.4, C.furFar], [1, C.pointDeep]]);
  const gEye = mkLin(0, -6.5, 0, 6.5, [[0, C.eyeTop], [0.55, "#2a1650"], [1, C.eyeBot]]);
  const gLaser = mkRad(0, 0, 0, 0, 0, 20, [
    [0, "rgba(255,255,255,1)"],
    [0.1, "rgba(255,70,70,1)"],
    [0.28, "rgba(255,20,50,0.55)"],
    [1, "rgba(255,0,40,0)"],
  ]);
  const gYarn = mkRad(-0.35, -0.4, 0.05, 0, 0, 1, [[0, "#ffc4e1"], [0.55, "#ff86bf"], [1, "#d4478f"]]);
  const gShadow = mkRad(0, 0, 0, 0, 0, 1, [[0, "rgba(4,2,10,0.55)"], [1, "rgba(4,2,10,0)"]]);
  const gGlow = mkRad(0, 0, 0, 0, 0, 1, [[0, "rgba(255,140,198,0.16)"], [1, "rgba(255,140,198,0)"]]);
  const gBubble = mkLin(0, 0, 0, 52, [[0, "#ffffff"], [1, "#ffe1f0"]]);
  // цвета сегментов хвоста: кремовый → сиреневый кончик
  const T_COL = [];
  const T_W = new Float32Array(TN);
  const T_STIFF = new Float32Array(TN);
  {
    const a = [255, 248, 252], b = [179, 158, 219];
    for (let i = 0; i < TN; i++) {
      const u = i / (TN - 1);
      const m = smooth((u - 0.5) / 0.35);
      T_COL.push(`rgb(${Math.round(lerp(a[0], b[0], m))},${Math.round(lerp(a[1], b[1], m))},${Math.round(lerp(a[2], b[2], m))})`);
      T_W[i] = lerp(7.6, 5.6, u);
      T_STIFF[i] = lerp(0.3, 0.05, u);
    }
  }

  // ---------------------------------------------------------------- холст
  let W = 1, H = 1, DPR = 1, K = 1.25, FLOOR = 1;
  const floorSurf = { el: null, floor: true, top: 1, left: 0, right: 1, valid: true, stay: true };
  try {
    if (getComputedStyle(canvas).position !== "fixed") {
      Object.assign(canvas.style, { position: "fixed", left: "0", top: "0", width: "100%", height: "100%", zIndex: "5" });
    }
  } catch (_) { /* ignore */ }
  canvas.style.pointerEvents = "none";

  const wallL = () => 28 * K;
  const wallR = () => W - 28 * K;
  const surfL = (s) => (s.floor ? wallL() : Math.max(s.left, wallL()));
  const surfR = (s) => (s.floor ? wallR() : Math.min(s.right, wallR()));

  // ---------------------------------------------------------------- платформы ([data-cat-platform])
  const platMap = new Map();
  let plats = [];
  let platScanT = 0;
  function scanPlatforms() {
    const els = document.querySelectorAll("[data-cat-platform]");
    const next = [];
    els.forEach((el) => {
      let p = platMap.get(el);
      if (!p) {
        p = { el, floor: false, top: 0, left: 0, right: 0, valid: false, stay: false };
        platMap.set(el, p);
      }
      next.push(p);
    });
    for (const p of plats) {
      if (!next.includes(p)) { p.valid = p.stay = false; platMap.delete(p.el); }
    }
    plats = next;
  }
  function measurePlatforms() {
    const minTop = 96 * K;
    for (let i = 0; i < plats.length; i++) {
      const p = plats[i];
      if (!p.el.isConnected) { p.valid = p.stay = false; continue; }
      const r = p.el.getBoundingClientRect();
      p.top = r.top;
      p.left = r.left + 16 * K;
      p.right = r.right - 16 * K;
      const shown = r.width > 90 && r.height > 8 && r.left < W - 40 && r.right > 40;
      p.valid = shown && r.top > minTop && r.top < FLOOR - 70;
      p.stay = shown && r.top > 26 * K && r.top < FLOOR - 50;
    }
  }
  // самая высокая поверхность на уровне y или ниже
  function surfaceBelow(x, y) {
    let best = floorSurf;
    for (let i = 0; i < plats.length; i++) {
      const p = plats[i];
      if (p.valid && x >= p.left && x <= p.right && p.top >= y - 1 && p.top < best.top) best = p;
    }
    return best;
  }
  // пересёк ли падающий объект поверхность сверху вниз за шаг
  function crossed(x, y0, y1, pad, only) {
    let best = null;
    for (let i = 0; i < plats.length; i++) {
      const p = plats[i];
      if (!p.valid || (only && p !== only)) continue;
      if (x >= p.left - pad && x <= p.right + pad && y0 <= p.top + 0.5 && y1 >= p.top && (!best || p.top < best.top)) best = p;
    }
    if (!best && y1 >= FLOOR) best = floorSurf;
    return best;
  }
  const canJumpTo = (s) => s.floor || (s.valid && cat.y - s.top < H * 0.82 && s.right - s.left > 60 * K);

  // ---------------------------------------------------------------- состояние кота
  const cat = {
    vis: false, mode: "hidden", // hidden | air | ground | drag
    x: 0, y: 0, vx: 0, vy: 0, rot: 0, vrot: 0,
    dir: 1, face: 1, surf: floorSurf,
    tumble: false, landOn: null, airT: 0, thrown: false, greet: false, pounce: false,
    sq: 0, sqv: 0, phase: 0, task: null, moved: false, rotVis: 0,
    sx: 0, sy: 0, cmx: 0, cmy: 0, cmpx: 0, cmpy: 0,
  };
  // сглаженные параметры позы (P) и их цели (TG)
  const P = {
    sit: 0, loaf: 0, crouch: 0, stretch: 0, dance: 0, groom: 0, wiggle: 0, move: 0, run: 0,
    lookX: 0, lookY: 0, headTilt: 0,
    shut: 0, happy: 0, angry: 0, surprise: 0, pupil: 1,
    earFlat: 0, earL: 0, earR: 0, earFwd: 0,
    mouth: 0, tongue: 0, blush: 0.55, paw: 0,
    tA: 3.85, tK: 0.07, tB: 0, tStiff: 1, tSwA: 0.15, tSwF: 0.6, tTw: 0, tPuff: 1,
  };
  const TG = Object.assign({}, P);
  const RATE = {
    sit: 6, loaf: 4, crouch: 10, stretch: 5, dance: 5, groom: 7, wiggle: 12, move: 10, run: 6,
    lookX: 9, lookY: 9, headTilt: 7,
    shut: 14, happy: 6, angry: 10, surprise: 12, pupil: 6,
    earFlat: 14, earL: 22, earR: 22, earFwd: 8,
    mouth: 18, tongue: 14, blush: 4, paw: 11,
    tA: 5, tK: 5, tB: 5, tStiff: 4, tSwA: 3, tSwF: 3, tTw: 4, tPuff: 6,
  };
  let pawMode = 0, pawU = 0; // 1 — умывается, 2 — машет, 3 — бьёт лапой

  // кукла (результат computePose)
  const R = {
    bRot: 0, bDX: 0, bDY: 0, bSX: 1, bSY: 1,
    hipX: new Float32Array(4), hipY: new Float32Array(4), footX: new Float32Array(4), footY: new Float32Array(4),
    headX: 0, headY: 0, headRot: 0, tailX: 0, tailY: 0, haunch: 0, pawOver: false,
  };
  let bc = 1, bs = 0;
  const btX = (lx, ly) => BPX + R.bDX + bc * (lx - BPX) * R.bSX - bs * (ly - BPY) * R.bSY;
  const btY = (lx, ly) => BPY + R.bDY + bs * (lx - BPX) * R.bSX + bc * (ly - BPY) * R.bSY;

  // глобальная трансформация (локальные единицы → css-пиксели)
  let gax = 1, gay = 1, gc = 1, gs = 0, gpiv = PIV;
  function computeXform() {
    let f = cat.face;
    if (Math.abs(f) < 0.14) f = f < 0 ? -0.14 : 0.14;
    const sq = cat.sq;
    gax = f * K * (1 + sq * 0.5);
    gay = K * (1 - sq);
    gc = Math.cos(cat.rot + cat.rotVis);
    gs = Math.sin(cat.rot + cat.rotVis);
    gpiv = PIV * K;
  }
  const l2wX = (lx, ly) => { const ax = lx * gax, ay = ly * gay + gpiv; return cat.x + gc * ax - gs * ay; };
  const l2wY = (lx, ly) => { const ax = lx * gax, ay = ly * gay + gpiv; return cat.y - gpiv + gs * ax + gc * ay; };

  // мировые точки для хит-теста/пузыря (обновляются при отрисовке)
  let headWX = -1e4, headWY = -1e4, bodyWX = -1e4, bodyWY = -1e4;

  // ---------------------------------------------------------------- хвост, лапы в воздухе
  const tX = new Float32Array(TN), tY = new Float32Array(TN), tPX = new Float32Array(TN), tPY = new Float32Array(TN);
  const tGX = new Float32Array(TN), tGY = new Float32Array(TN);
  const legA = new Float32Array(4), legV = new Float32Array(4);
  let prevVrot = 0;

  // ---------------------------------------------------------------- игрушки
  const laser = { on: false, has: false, x: 0, y: 0, speed: 0, t: 0 };
  const YN = 18;
  const yarn = {
    on: false, x: 0, y: 0, vx: 0, vy: 0, r: 13, ang: 0, ground: false, surf: floorSurf,
    grabbed: false, ox: 0, oy: 0, boredUntil: 0, alpha: 0, dying: false,
    hx: new Float32Array(YN), hy: new Float32Array(YN), hpx: new Float32Array(YN), hpy: new Float32Array(YN),
  };

  // ---------------------------------------------------------------- частицы
  const MAXP = RM ? 24 : 90;
  const HEART = 1, ZZZ = 2, DUST = 3, SPARK = 4;
  const parts = [];
  for (let i = 0; i < MAXP; i++) parts.push({ on: false, k: 0, x: 0, y: 0, vx: 0, vy: 0, t: 0, life: 1, s: 1, h: 0, c: 0 });
  function emit(k, x, y, vx, vy, life, s, c = 0) {
    for (let i = 0; i < MAXP; i++) {
      const p = parts[i];
      if (p.on) continue;
      p.on = true; p.k = k; p.x = x; p.y = y; p.vx = vx; p.vy = vy; p.t = 0; p.life = life; p.s = s;
      p.h = Math.random() * TAU; p.c = c;
      return p;
    }
    return null;
  }

  // ---------------------------------------------------------------- реплики
  const bub = { on: false, text: "", lines: ["", ""], n: 1, w: 0, t: 0, dur: 2.4, x: 0, y: 0, placed: false };
  function say(text, dur = 2.5) {
    if (!text) return;
    ctx.font = FONT_BUBBLE;
    const maxW = 210;
    const words = String(text).split(" ");
    let l1 = "", l2 = "";
    for (const w of words) {
      const t = l1 ? l1 + " " + w : w;
      if (!l2 && ctx.measureText(t).width <= maxW) l1 = t;
      else l2 = l2 ? l2 + " " + w : w;
    }
    bub.lines[0] = l1; bub.lines[1] = l2; bub.n = l2 ? 2 : 1;
    bub.w = Math.max(ctx.measureText(l1).width, l2 ? ctx.measureText(l2).width : 0);
    bub.text = text; bub.t = 0; bub.dur = dur; bub.on = true;
  }

  // ---------------------------------------------------------------- указатель
  const ptr = { x: -1e4, y: -1e4, in: false, type: "mouse", lastMove: -10, down: false };
  const VS = 8;
  const vsT = new Float64Array(VS), vsX = new Float32Array(VS), vsY = new Float32Array(VS);
  let vsI = 0;
  function trackPtr(e) {
    ptr.x = e.clientX; ptr.y = e.clientY; ptr.in = true; ptr.type = e.pointerType || "mouse";
    ptr.lastMove = now();
    vsT[vsI] = ptr.lastMove; vsX[vsI] = ptr.x; vsY[vsI] = ptr.y; vsI = (vsI + 1) % VS;
  }
  function ptrVel(out) {
    const last = (vsI + VS - 1) % VS;
    const tl = vsT[last];
    let j = last;
    for (let k = 1; k < VS; k++) {
      const i = (last - k + VS) % VS;
      if (vsT[i] === 0 || tl - vsT[i] > 0.1) break;
      j = i;
    }
    const dt = tl - vsT[j];
    if (dt < 0.008 || now() - tl > 0.12) { out.x = 0; out.y = 0; return out; }
    out.x = (vsX[last] - vsX[j]) / dt; out.y = (vsY[last] - vsY[j]) / dt;
    return out;
  }
  const tmpV = { x: 0, y: 0 };

  // ---------------------------------------------------------------- состояние взаимодействий
  let clock = now();
  let lastInteract = clock;
  const interact = () => { lastInteract = now(); };
  let party = false;
  let angryUntil = 0, happyUntil = 0, surpriseUntil = 0, chatter = 0;
  const clicks = [];
  let lastMeow = 0;
  const meow = (kind) => {
    const t = now();
    if (t - lastMeow < 0.3) return;
    lastMeow = t;
    sfx("meow", kind);
  };
  // поглаживания
  const PET_TH = 6;
  const pet = { d: [0, 0], e: [0, 0], flips: new Float64Array(6), fi: 0, active: false, last: 0, start: 0, said: false, purring: false };
  const LS_KEY = "sempik.cat.pets";
  let petCount = 0;
  try { petCount = parseInt(localStorage.getItem(LS_KEY), 10) || 0; } catch (_) { petCount = 0; }
  const plural = (n) => {
    const a = n % 10, b = n % 100;
    if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return "раза";
    return "раз";
  };

  // ================================================================ ПОВЕДЕНИЕ
  function setTask(type, o) {
    const t = o || {};
    t.type = type;
    t.t = 0;
    if (t.dur == null) t.dur = Infinity;
    cat.task = t;
    return t;
  }
  function startTask(t) { t.t = 0; if (t.dur == null) t.dur = Infinity; cat.task = t; }
  function setDir(d) { if (d && d !== cat.dir) cat.dir = d; }

  function think() {
    if (cat.mode !== "ground") return;
    const t = now();
    if (party) { setTask("dance"); return; }
    if (laser.on) { setTask("hunt", { sub: "track", subT: 0, cool: 0 }); return; }
    if (yarn.on && !yarn.dying && t > yarn.boredUntil) { setTask("yarn", { sub: "chase", subT: 0, cool: 0.2, play: 0 }); return; }
    if (t - lastInteract > 25 && !pet.active) { goSleep(); return; }
    if (maybeFollow()) return;
    const s = cat.surf;
    const opts = RM
      ? [["sit", 30], ["loaf", 22], ["stand", 10], ["walk", 12], ["groom", 6], ["yawn", 5], ["jump", 5]]
      : [["sit", 20], ["stand", 9], ["walk", 24], ["loaf", 9], ["groom", 9], ["stretch", 6], ["yawn", 6], ["jump", 17]];
    let sum = 0;
    for (const o of opts) sum += o[1];
    let r = Math.random() * sum, pick = "sit";
    for (const o of opts) { r -= o[1]; if (r <= 0) { pick = o[0]; break; } }
    switch (pick) {
      case "sit": setTask("sit", { dur: rand(3, 7) }); break;
      case "loaf": setTask("loaf", { dur: rand(4, 8) }); break;
      case "stand": setTask("stand", { dur: rand(1.4, 3) }); break;
      case "groom": setTask("groom", { dur: 2.8 }); break;
      case "stretch": setTask("stretch", { dur: 2.2 }); break;
      case "yawn": setTask("yawn", { dur: 1.9 }); break;
      case "walk": {
        const l = surfL(s), rr = surfR(s);
        let tx = rand(l, rr);
        if (Math.abs(tx - cat.x) < 60 * K) tx = clamp(cat.x + sgn(tx - cat.x) * rand(90, 220) * K, l, rr);
        setTask("walk", { tx, speed: rand(62, 86) * K / 1.25 });
        break;
      }
      case "jump": if (!planWander()) setTask("sit", { dur: rand(2, 4) }); break;
    }
  }

  // прогулка между полом и платформами
  function planWander() {
    const s = cat.surf;
    const cands = [];
    for (const p of plats) if (p.valid && p !== s && canJumpTo(p)) cands.push(p);
    if (!s.floor) cands.push(floorSurf);
    if (!cands.length) return false;
    const target = cands[(Math.random() * cands.length) | 0];
    planJump(target, null);
    return true;
  }
  // дойти до места толчка, присесть и прыгнуть на поверхность target
  function planJump(target, lx, next, speed = 105) {
    const s = cat.surf;
    let landX, takeoff;
    if (target.floor) {
      // спрыгнуть с края текущей платформы
      const goRight = lx != null ? lx > (s.left + s.right) / 2 : Math.random() < 0.5 ? cat.x > (s.left + s.right) / 2 : Math.random() < 0.5;
      const edge = goRight ? s.right : s.left;
      takeoff = edge - (goRight ? 1 : -1) * 8 * K;
      landX = lx != null ? lx : edge + (goRight ? 1 : -1) * rand(50, 120) * K;
      landX = clamp(landX, wallL(), wallR());
      if (goRight ? landX < edge + 30 * K : landX > edge - 30 * K) landX = clamp(edge + (goRight ? 40 : -40) * K, wallL(), wallR());
    } else {
      const l = target.left + 22 * K, r = target.right - 22 * K;
      landX = lx != null ? clamp(lx, l, r) : rand(l, r);
      const side = cat.x < landX ? -1 : 1;
      takeoff = clamp(landX + side * rand(40, 110) * K, surfL(s), surfR(s));
      if (!s.floor) takeoff = clamp(cat.x, surfL(s), surfR(s));
    }
    const prep = { type: "prep", dur: 0.32, tx: landX, surf: target, next: next || null };
    if (Math.abs(takeoff - cat.x) > 8 * K) setTask("walk", { tx: takeoff, speed: speed * K / 1.25, next: prep });
    else startTask(prep);
  }

  function launchJump(tx, surf, apexExtra) {
    const ty = surf.top;
    const apexY = Math.min(cat.y, ty) - apexExtra;
    const up = Math.max(cat.y - apexY, 4);
    const vy0 = -Math.sqrt(2 * G * up);
    const tUp = -vy0 / G;
    const tDown = Math.sqrt((2 * Math.max(ty - apexY, 4)) / G);
    cat.vx = clamp((tx - cat.x) / (tUp + tDown), -1700, 1700);
    cat.vy = vy0;
    if (Math.abs(tx - cat.x) > 4) setDir(sgn(tx - cat.x));
    takeOff(false);
    cat.landOn = surf;
    cat.sqv -= 6;
  }
  function takeOff(tumble) {
    // фиксируем углы лап, чтобы маятники стартовали из текущей позы
    for (let i = 0; i < 4; i++) {
      legA[i] = Math.atan2(R.footX[i] - R.hipX[i], R.footY[i] - R.hipY[i]);
      legV[i] = 0;
    }
    cat.mode = "air";
    cat.tumble = tumble;
    cat.airT = 0;
    cat.landOn = null;
    cat.task = null;
    prevVrot = cat.vrot;
  }

  function land(s) {
    const impact = cat.vy;
    const wasTumble = cat.tumble;
    // остаток поворота догоняем плавно, без рывка
    if (wasTumble) cat.rotVis = clamp(wrapAngle(cat.rot), -1.2, 1.2);
    cat.mode = "ground";
    cat.surf = s;
    cat.y = s.top;
    cat.vy = 0;
    cat.rot = 0;
    cat.vrot = 0;
    cat.vx *= wasTumble ? 0.3 : 0.15;
    cat.tumble = false;
    cat.landOn = null;
    cat.sqv += clamp(impact / 1500, 0.12, 0.6) * 9;
    if (impact > 650 || (wasTumble && impact > 250)) {
      const n = RM ? 3 : 7;
      for (let i = 0; i < n; i++) emit(DUST, cat.x + rand(-26, 26) * K, s.top - 2, rand(-90, 90), rand(-40, -10), rand(0.45, 0.7), rand(3, 6) * K);
      sfx("thud");
    }
    const pounce = cat.pounce;
    cat.pounce = false;
    setTask("land", { dur: wasTumble ? 0.5 : 0.2 });
    if (cat.greet) {
      cat.greet = false;
      cat.task.dur = 1.2;
      setTimeout(() => { say(`мяу! я ${NAME}`, 2.8); meow("happy"); }, 260);
      showToys();
    } else if (wasTumble && cat.thrown) {
      if (Math.random() < 0.75) setTimeout(() => say(pickFresh(PH.land)), 200);
    }
    cat.thrown = false;
    if (pounce && laser.on && laser.has) {
      const dx = laser.x - (cat.x + cat.dir * 20 * K), dy = laser.y - cat.y;
      if (dx * dx + dy * dy < (46 * K) ** 2) {
        setTask("sniff", { dur: 0.9 });
        if (Math.random() < 0.35) say(PH.laser[PH.laser.length - 1]);
      }
    }
  }

  function fall() {
    takeOff(true);
    cat.vy = 0;
    cat.vrot = rand(-2.5, 2.5);
    surpriseUntil = now() + 0.8;
  }

  function goSleep() {
    setTask("sleep");
  }
  function wake(say_ = true) {
    if (cat.task?.type !== "sleep") return false;
    if (say_) { say(pickFresh(PH.wake)); meow("question"); }
    setTask("stretch", { dur: 1.8 });
    interact();
    return true;
  }

  // кот стоит под неподвижным курсором → подойти и сесть, глядя вверх
  let followX = -1, followY = -1;
  function maybeFollow() {
    if (ptr.type !== "mouse" || !ptr.in) return false;
    const idle = now() - ptr.lastMove;
    if (idle < 0.8 || idle > 8) return false;
    if (ptr.x === followX && ptr.y === followY) return false;
    const s = cat.surf;
    if (ptr.x < surfL(s) || ptr.x > surfR(s)) return false;
    const above = s.top - ptr.y;
    if (above < 20 || above > 320) return false;
    followX = ptr.x; followY = ptr.y;
    const dx = ptr.x - cat.x;
    if (Math.abs(dx) < 34 * K) { setTask("sit", { dur: rand(4, 7), adore: true }); return true; }
    if (Math.random() < 0.85) {
      setTask("walk", { tx: ptr.x - sgn(dx) * 8 * K, speed: 100 * K / 1.25, next: { type: "sit", dur: rand(4, 7), adore: true } });
      return true;
    }
    return false;
  }

  function moveTo(tx, speed, dt) {
    const s = cat.surf;
    tx = clamp(tx, surfL(s), surfR(s));
    const dx = tx - cat.x;
    if (Math.abs(dx) > 5 * K) setDir(sgn(dx));
    const ready = P.sit < 0.3 && P.loaf < 0.3 && P.stretch < 0.4 && Math.abs(cat.face - cat.dir) < 0.5;
    const want = ready ? clamp(dx * 5, -speed, speed) : 0;
    cat.vx = toward(cat.vx, want, (speed > 220 ? 1700 : 650) * dt);
    cat.moved = true;
    return Math.abs(dx) < 4 && Math.abs(cat.vx) < 30;
  }

  // направление взгляда (мировая точка)
  function lookAt(x, y) {
    const dx = x - headWX, dy = y - headWY;
    TG.lookX = clamp((dx * sgn(cat.face)) / 140, -1, 1);
    TG.lookY = clamp(dy / 140, -1, 1);
  }
  let sacT = 0, sacX = 0.4, sacY = 0;
  let behindT = 0;
  function idleLook(dt) {
    const t = now();
    const near = ptr.in && t - ptr.lastMove < 4 && Math.hypot(ptr.x - headWX, ptr.y - headWY) < 340;
    if (near) {
      lookAt(ptr.x, ptr.y);
      // курсор сзади — развернуться
      if ((ptr.x - cat.x) * cat.dir < -30 * K && Math.abs(ptr.x - cat.x) < 320) {
        behindT += dt;
        if (behindT > 0.7) { setDir(-cat.dir); behindT = 0; }
      } else behindT = 0;
      return true;
    }
    behindT = 0;
    sacT -= dt;
    if (sacT <= 0) {
      sacT = rand(1.2, 3.8);
      sacX = rand(-0.5, 1);
      sacY = rand(-0.6, 0.35);
    }
    TG.lookX = sacX; TG.lookY = sacY;
    return false;
  }

  // ---------------------------------------------------------------- цели позы
  function resetTargets() {
    TG.sit = 0; TG.loaf = 0; TG.crouch = 0; TG.stretch = 0; TG.dance = 0; TG.groom = 0; TG.wiggle = 0;
    TG.headTilt = 0; TG.shut = 0; TG.happy = 0; TG.angry = 0; TG.surprise = 0; TG.pupil = 1;
    TG.earFlat = 0; TG.earFwd = 0; TG.mouth = 0; TG.tongue = 0; TG.blush = 0.55; TG.paw = 0;
    tail(3.85, 0.07, 1, RM ? 0.08 : 0.16, 0.55, 0, 1);
    pawMode = 0;
  }
  function tail(a, k, stiff, swA, swF, tw, puff, bend = 0) {
    TG.tA = a; TG.tK = k; TG.tStiff = stiff; TG.tSwA = swA; TG.tSwF = swF; TG.tTw = tw; TG.tPuff = puff; TG.tB = bend;
  }
  // хвост обёрнут вокруг лап (сидит / лежит)
  const tailWrap = (tw = 0.12, swA = 0.04) => tail(1.95, -0.02, 1.2, swA, 0.4, RM ? tw * 0.3 : tw, 1, -0.42);

  // ---------------------------------------------------------------- задачи на земле
  function taskUpdate(dt) {
    let t = cat.task;
    if (!t) { think(); t = cat.task; if (!t) return; }
    t.t += dt;
    const done = t.t >= t.dur;
    switch (t.type) {
      case "land":
        idleLook(dt);
        if (done) think();
        break;
      case "stand":
        idleLook(dt);
        if (done) think();
        else if (t.t > 0.6 && maybeFollow()) break;
        break;
      case "sit":
        TG.sit = 1;
        tailWrap(0.18, 0.05);
        if (t.adore) {
          // сидит под курсором и смотрит снизу вверх, медленно моргает
          if (ptr.in && now() - ptr.lastMove < 0.25 && Math.hypot(ptr.x - cat.x, ptr.y - cat.y) > 260) t.adore = false;
          lookAt(ptr.x, ptr.y);
          TG.happy = 0.6; TG.blush = 0.9;
          slowBlinkWanted = true;
        } else idleLook(dt);
        if (done) think();
        else if (t.t > 1 && !t.adore && maybeFollow()) break;
        break;
      case "loaf":
        TG.loaf = 1;
        tailWrap(0.12, 0.03);
        idleLook(dt);
        TG.shut = 0.35;
        if (done) think();
        else if (t.t > 1.5 && maybeFollow()) break;
        break;
      case "sleep": {
        TG.loaf = 1;
        TG.shut = 1;
        TG.lookY = 0.5; TG.lookX = 0.2; TG.headTilt = 0.12;
        tailWrap(0, 0.02);
        t.zt = (t.zt == null ? 0.8 : t.zt) - dt;
        if (t.zt <= 0) {
          t.zt = RM ? 2.4 : 1.15;
          t.zi = ((t.zi || 0) + 1) % 3;
          emit(ZZZ, headWX + cat.dir * 14 * K, headWY - 18 * K, cat.dir * rand(8, 16), -rand(20, 28), 2.6, 1, t.zi);
        }
        break;
      }
      case "groom": {
        TG.sit = 1; TG.groom = 1; TG.shut = 1; TG.happy = 0.3;
        tailWrap(0.1);
        pawMode = 1;
        TG.paw = t.t > 0.25 && t.t < t.dur - 0.35 ? 1 : 0;
        TG.tongue = TG.paw > 0.5 && Math.sin(t.t * 16) > 0.2 ? 1 : 0;
        if (done) think();
        break;
      }
      case "stretch": {
        const u = t.t / t.dur;
        TG.stretch = u > 0.08 && u < 0.78 ? 1 : 0;
        TG.shut = u > 0.15 && u < 0.75 ? 1 : 0;
        TG.mouth = u > 0.3 && u < 0.62 ? 1 : 0;
        TG.earFlat = TG.stretch * 0.35;
        tail(4.3, 0.1, 1, 0.08, 0.6, 0, 1);
        if (done) think();
        break;
      }
      case "yawn": {
        const u = t.t / t.dur;
        TG.sit = 1;
        const m = u > 0.15 && u < 0.72;
        TG.mouth = m ? 1.35 : 0;
        TG.shut = m ? 1 : 0;
        TG.headTilt = m ? -0.22 : 0;
        TG.earFlat = m ? 0.35 : 0;
        tailWrap(0.06);
        if (done) think();
        break;
      }
      case "walk": {
        const fast = t.speed > 200;
        if (fast) tail(3.35, 0.02, 1, 0.08, 1.2, 0, 1);
        else tail(4.4, 0.12, 1, 0.12, 0.9, 0.06, 1);
        idleLook(dt);
        if (moveTo(t.tx, t.speed, dt)) {
          if (t.next) startTask(t.next);
          else think();
        } else if (t.t > 14) think();
        break;
      }
      case "prep": {
        TG.crouch = 1;
        TG.pupil = 1.35;
        TG.earFwd = 1;
        tail(3.1, 0.0, 1, 0.05, 2, 0.25, 1);
        if (Math.abs(t.tx - cat.x) > 4) setDir(sgn(t.tx - cat.x));
        if (t.t > 0.12) TG.wiggle = 1;
        lookAt(t.tx, t.surf.top - 20 * K);
        if (done) {
          if (!t.surf.floor && !t.surf.valid) { think(); break; }
          const extra = t.surf.floor ? 34 * K : clamp((cat.y - t.surf.top) * 0.12, 40, 90) * K / 1.25;
          launchJump(t.tx, t.surf, extra);
        }
        break;
      }
      case "petted": {
        TG.happy = 1; TG.shut = 1; TG.blush = 1;
        TG.headTilt = 0.18 * Math.sin(now() * 1.3);
        TG.earFlat = 0.15;
        if (t.loaf) TG.loaf = 1;
        else TG.sit = 1;
        tailWrap(0.16, 0.06);
        if (!pet.active && now() - pet.last > 1.0) {
          happyUntil = now() + 5;
          think();
        }
        break;
      }
      case "angry": {
        TG.angry = 1; TG.earFlat = 1; TG.crouch = 0.35; TG.pupil = 0.7;
        tail(3.9, 0.03, 0.8, RM ? 0.15 : 0.5, 2.6, 0.3, 1.55);
        if (ptr.in) lookAt(ptr.x, ptr.y);
        TG.mouth = t.t < 0.5 ? 0.6 : 0;
        if (done) {
          // уходит по своим делам
          const s = cat.surf;
          const away = clamp(cat.x + (ptr.x > cat.x ? -1 : 1) * rand(140, 240) * K, surfL(s), surfR(s));
          setTask("walk", { tx: away, speed: 150 * K / 1.25, next: { type: "sit", dur: rand(3, 5) } });
        }
        break;
      }
      case "sniff": {
        TG.crouch = 0.6; TG.lookY = 0.9; TG.lookX = 0.6; TG.pupil = 1.3; TG.earFwd = 1;
        tail(3.0, 0.02, 1, 0.1, 1.5, 0.2, 1);
        if (done) think();
        break;
      }
      case "jumpdbg": if (!planWander()) think(); break;
      case "dance": danceUpdate(t, dt); break;
      case "hunt": huntUpdate(t, dt); break;
      case "yarn": yarnPlay(t, dt); break;
      default:
        if (done) think();
    }
  }

  function danceUpdate(t, dt) {
    if (!party) { think(); return; }
    TG.sit = 1; TG.dance = 1; TG.happy = 1; TG.shut = 1; TG.blush = 1;
    TG.headTilt = 0.22 * Math.sin(now() * TAU * 0.55);
    TG.mouth = 0.35;
    pawMode = 2; TG.paw = 1;
    tail(4.5, 0.06, 1, RM ? 0.15 : 0.45, 1.1, 0.1, 1);
    t.ht = (t.ht || 0) - dt;
    if (t.ht <= 0) {
      t.ht = RM ? 0.9 : 0.28;
      emit(HEART, headWX + rand(-30, 30) * K, headWY - rand(10, 30) * K, rand(-30, 30), -rand(50, 90), rand(1.2, 1.8), rand(6, 10), 1 + ((Math.random() * 12) | 0));
    }
  }

  // ---- лазер ----
  function huntUpdate(t, dt) {
    if (!laser.on) { think(); return; }
    t.subT += dt;
    t.cool -= dt;
    TG.pupil = 1.6; TG.earFwd = 1;
    tail(3.05, 0.0, 1, 0.06, 1.6, RM ? 0.15 : 0.4, 1);
    if (!laser.has) { TG.sit = 1; idleLook(dt); return; }
    lookAt(laser.x, laser.y);
    const s = surfaceBelow(laser.x, laser.y - 2);
    const h = s.top - laser.y;
    const dx = laser.x - cat.x;
    if (t.sub === "track") {
      if (s !== cat.surf) {
        if (t.cool <= 0 && canJumpTo(s)) {
          t.cool = 1.2;
          planJump(s, laser.x, null, 420);
          return;
        }
        moveTo(laser.x, 300 * K / 1.25, dt);
        return;
      }
      if (h > 250 * K) {
        // высоко — сидит, смотрит и «чирикает»
        if (Math.abs(dx) > 50 * K) moveTo(laser.x, 220 * K / 1.25, dt);
        else { TG.sit = 1; TG.mouth = chatter > 0 && Math.sin(now() * 34) > 0 ? 0.45 : 0; }
        return;
      }
      if (Math.abs(dx) > 100 * K || laser.speed > 520) {
        moveTo(laser.x - sgn(dx) * 26 * K, clamp(Math.abs(dx) * 2.4, 170, 560) * K / 1.25, dt);
        TG.crouch = 0.3;
      } else {
        t.sub = "crouch"; t.subT = 0; t.wig = RM ? 0.5 : rand(0.45, 1.05);
      }
    } else if (t.sub === "crouch") {
      TG.crouch = 1;
      TG.wiggle = t.subT > 0.15 ? 1 : 0;
      if (Math.abs(dx) > 4) setDir(sgn(dx));
      if (Math.abs(dx) > 170 * K || s !== cat.surf || h > 250 * K) { t.sub = "track"; return; }
      if (t.subT >= t.wig) {
        const tx = clamp(laser.x - sgn(dx) * 14 * K, surfL(cat.surf), surfR(cat.surf));
        cat.pounce = true;
        if (Math.random() < 0.3) say(pickFresh(PH.laser), 1.6);
        launchJump(tx, cat.surf, clamp(h + 16, 26, 240 * K));
      }
    }
  }

  // ---- клубок ----
  function yarnPlay(t, dt) {
    const b = yarn;
    if (!b.on || b.dying) { think(); return; }
    t.subT += dt;
    t.cool -= dt;
    t.play += dt;
    TG.pupil = 1.4; TG.earFwd = 0.8;
    tail(3.6, 0.06, 1, 0.1, 1.4, 0.25, 1);
    lookAt(b.x, b.y);
    if (t.play > (t.bore || (t.bore = rand(18, 32)))) {
      b.boredUntil = now() + rand(8, 14);
      setTask("loaf", { dur: rand(4, 6) });
      return;
    }
    if (b.grabbed) { TG.crouch = 0.5; if (Math.abs(b.x - cat.x) > 4) setDir(sgn(b.x - cat.x)); return; }
    if (!b.ground) {
      const s = surfaceBelow(b.x, b.y + b.r);
      if (s === cat.surf) moveTo(b.x, 380 * K / 1.25, dt);
      return;
    }
    if (b.surf !== cat.surf) {
      if (t.cool <= 0 && canJumpTo(b.surf)) { t.cool = 1.4; planJump(b.surf, b.x, null, 380); return; }
      moveTo(b.x, 200 * K / 1.25, dt);
      return;
    }
    const dx = b.x - cat.x;
    const reach = 30 * K + b.r;
    if (t.sub === "bat") {
      TG.crouch = 0.35;
      pawMode = 3;
      pawU = clamp(t.subT / 0.42, 0, 1);
      TG.paw = 1;
      if (!t.hit && t.subT > 0.16) {
        t.hit = true;
        const pawX = cat.x + cat.dir * 34 * K;
        if (Math.abs(b.x - pawX) < b.r + 26 * K) {
          b.vx = cat.dir * rand(260, 560);
          b.vy = -rand(160, 460);
          b.ground = false;
          if (Math.random() < 0.22) say(pickFresh(PH.yarn), 1.6);
          sfx("tick");
        }
      }
      if (t.subT > 0.45) { t.sub = "chase"; t.cool = rand(0.25, 0.8); }
      return;
    }
    if (Math.abs(dx) > reach + 8 * K || Math.abs(b.vx) > 120) {
      const far = Math.abs(dx) > 160 * K || Math.abs(b.vx) > 200;
      moveTo(b.x - sgn(dx) * reach * 0.8, (far ? 430 : 170) * K / 1.25, dt);
      if (!far) TG.crouch = 0.35;
      return;
    }
    if (Math.abs(dx) > 3) setDir(sgn(dx));
    TG.crouch = 0.45;
    if (t.cool <= 0) { t.sub = "bat"; t.subT = 0; t.hit = false; }
  }

  // ---------------------------------------------------------------- клик / гнев / поглаживание
  function onCatClick() {
    interact();
    if (wake()) return;
    const t = now();
    clicks.push(t);
    while (clicks.length && t - clicks[0] > 2.2) clicks.shift();
    if (clicks.length >= 4) {
      clicks.length = 0;
      angryUntil = t + 1.6;
      meow("angry");
      say(ANGRY_LINE, 2.2);
      if (cat.mode === "ground") setTask("angry", { dur: 1.5 });
      return;
    }
    if (cat.task?.type === "angry") { cat.sqv += 2; return; }
    const kinds = ["short", "question", "happy", "short"];
    meow(kinds[(Math.random() * kinds.length) | 0]);
    say(pickFresh(CLICK_LINES));
    if (cat.mode === "ground") {
      // маленький подскок на месте
      cat.vy = -rand(380, 460);
      cat.vx = 0;
      takeOff(false);
      cat.landOn = cat.surf;
      cat.sqv -= 4;
    }
  }

  function registerFlip(need = 3) {
    const t = now();
    pet.flips[pet.fi] = t;
    pet.fi = (pet.fi + 1) % pet.flips.length;
    if (grab) grab.flips++;
    let n = 0;
    for (let i = 0; i < pet.flips.length; i++) if (t - pet.flips[i] < 1.5) n++;
    if (n >= need && !pet.active) startPetting();
    if (pet.active) pet.last = t;
  }
  function trackAxis(i, v) {
    const d = pet.d[i];
    if (d === 0) {
      if (Math.abs(v - pet.e[i]) > PET_TH) { pet.d[i] = sgn(v - pet.e[i]); pet.e[i] = v; }
      return false;
    }
    if ((v - pet.e[i]) * d > 0) { pet.e[i] = v; return false; }
    if (Math.abs(v - pet.e[i]) > PET_TH) { pet.d[i] = -d; pet.e[i] = v; return true; }
    return false;
  }
  function petMove(x, y, need) {
    if (trackAxis(0, x) | trackAxis(1, y)) registerFlip(need);
    if (pet.active) pet.last = now();
  }
  function petReset(x, y) { pet.d[0] = pet.d[1] = 0; pet.e[0] = x; pet.e[1] = y; }
  function startPetting() {
    if (cat.mode !== "ground" || cat.task?.type === "angry") return;
    const t = now();
    pet.active = true; pet.start = t; pet.last = t; pet.said = false;
    interact();
    const wasSleep = cat.task?.type === "sleep";
    if (wasSleep) say(pickFresh(PH.wake), 1.6);
    else say(pickFresh(PH.pet), 2);
    setTask("petted", { loaf: wasSleep || cat.task?.type === "loaf" });
    if (!pet.purring) { sfx("startPurr"); pet.purring = true; }
    petCount++;
    try { localStorage.setItem(LS_KEY, String(petCount)); } catch (_) { /* приватный режим */ }
    if ([10, 25, 50, 100, 250, 500, 1000].includes(petCount)) {
      try { toast?.(`${NAME}: меня погладили уже ${petCount} ${plural(petCount)}`); } catch (_) { /* ignore */ }
    }
  }
  function petTick() {
    const t = now();
    if (pet.active) {
      if (t - pet.last > 0.8 || cat.mode !== "ground") {
        pet.active = false;
        if (pet.purring) { sfx("stopPurr"); pet.purring = false; }
      } else {
        interact();
        if (!pet.said && t - pet.start > 2.6) {
          pet.said = true;
          if (petCount === 1 || petCount % 5 === 0 || Math.random() < 0.3) say(`меня погладили ${petCount} ${plural(petCount)}`, 2.6);
          else say(pickFresh(PH.pet), 2);
        }
      }
    } else if (pet.purring) { sfx("stopPurr"); pet.purring = false; }
  }

  // ---------------------------------------------------------------- перетаскивание
  function startDrag() {
    if (cat.mode === "hidden") return;
    wake(false);
    interact();
    if (pet.active) { pet.active = false; }
    computeXform();
    cat.sx = l2wX(SCRUFF_X, SCRUFF_Y);
    cat.sy = l2wY(SCRUFF_X, SCRUFF_Y);
    cat.cmx = cat.cmpx = l2wX(COM_X, COM_Y);
    cat.cmy = cat.cmpy = l2wY(COM_X, COM_Y);
    cat.mode = "drag";
    cat.tumble = true;
    cat.task = null;
    cat.vx = cat.vy = 0;
    for (let i = 0; i < 4; i++) {
      legA[i] = Math.atan2(R.footX[i] - R.hipX[i], R.footY[i] - R.hipY[i]);
      legV[i] = 0;
    }
    say(pickFresh(PH.drag), 2);
    meow(Math.random() < 0.5 ? "angry" : "question");
    surpriseUntil = now() + 1.2;
  }
  function releaseDrag() {
    if (cat.mode !== "drag") return;
    const pv = ptrVel(tmpV);
    const cvx = (cat.cmx - cat.cmpx) / STEP, cvy = (cat.cmy - cat.cmpy) / STEP;
    let vx = pv.x * 0.75 + cvx * 0.25, vy = pv.y * 0.75 + cvy * 0.25;
    const sp = Math.hypot(vx, vy);
    if (sp > 2600) { vx *= 2600 / sp; vy *= 2600 / sp; }
    cat.vx = vx; cat.vy = vy;
    cat.vrot = clamp(cat.vrot + vx * 0.004, -14, 14);
    takeOff(true);
    cat.thrown = true;
    if (sp > 900 && Math.random() < 0.5) say(PH.drag[PH.drag.length - 1], 1.6);
    if (cat.y > FLOOR) land(floorSurf);
  }

  // ================================================================ ФИЗИКА (фиксированный шаг)
  function physCat(dt) {
    if (cat.mode === "air") {
      cat.airT += dt;
      cat.vy += G * dt;
      const y0 = cat.y;
      cat.x += cat.vx * dt;
      cat.y += cat.vy * dt;
      const l = wallL(), r = wallR();
      if (cat.x < l) { cat.x = l; if (cat.vx < 0) { cat.vx = -cat.vx * 0.45; cat.vrot += 3; } }
      else if (cat.x > r) { cat.x = r; if (cat.vx > 0) { cat.vx = -cat.vx * 0.45; cat.vrot -= 3; } }
      // потолок: стукается и падает обратно (голова остаётся на экране)
      const ceil = 64 * K;
      if (cat.y < ceil && cat.vy < 0) {
        cat.y = ceil;
        if (cat.vy < -300) {
          cat.vrot += clamp(cat.vx / 200, -6, 6) + rand(-3, 3);
          for (let i = 0; i < (RM ? 2 : 5); i++) emit(SPARK, cat.x + rand(-20, 20) * K, Math.max(4, cat.y - 70 * K), rand(-120, 120), rand(20, 120), 0.5, rand(2, 3.5));
          sfx("thud");
        }
        cat.vy = -cat.vy * 0.25;
      }
      if (cat.tumble) {
        cat.rot = wrapAngle(cat.rot);
        const below = surfaceBelow(cat.x, cat.y).top;
        const dist = below - cat.y;
        const tLeft = cat.vy > 0 ? dist / cat.vy : 9;
        if (cat.vy > -200 && (tLeft < 0.42 || dist < 150)) cat.vrot += (-cat.rot * 95 - cat.vrot * 15) * dt;
        else cat.vrot *= 0.999;
        cat.rot += cat.vrot * dt;
      } else cat.rot = 0;
      if (cat.vy > 0) {
        const s = crossed(cat.x, y0, cat.y, 0, cat.landOn);
        if (s) land(s);
        else if (cat.y > FLOOR) land(floorSurf);
      }
    } else if (cat.mode === "drag") {
      const k = 1 - Math.exp(-32 * dt);
      cat.sx += (clamp(ptr.x, 20 * K, W - 20 * K) - cat.sx) * k;
      cat.sy += (clamp(ptr.y, 34 * K, FLOOR - 72 * K) - cat.sy) * k;
      const hang = HANG_L * K;
      const vx = (cat.cmx - cat.cmpx) * 0.99, vy = (cat.cmy - cat.cmpy) * 0.99;
      cat.cmpx = cat.cmx; cat.cmpy = cat.cmy;
      cat.cmx += vx; cat.cmy += vy + G * dt * dt;
      const dx = cat.cmx - cat.sx, dy = cat.cmy - cat.sy;
      const d = Math.hypot(dx, dy) || 1e-4;
      cat.cmx = cat.sx + (dx / d) * hang;
      cat.cmy = cat.sy + (dy / d) * hang;
      const fs = cat.face < 0 ? -1 : 1;
      const rest = Math.atan2(COM_Y - SCRUFF_Y, (COM_X - SCRUFF_X) * fs);
      // + небольшой доп. наклон: за шкирку кот висит почти вертикально
      const nr = wrapAngle(Math.atan2(cat.cmy - cat.sy, cat.cmx - cat.sx) - rest - 0.42 * fs);
      cat.vrot = wrapAngle(nr - cat.rot) / dt;
      cat.rot = nr;
      computeXform();
      const ax = gax * SCRUFF_X, ay = gay * SCRUFF_Y + gpiv;
      cat.x = cat.sx - (gc * ax - gs * ay);
      cat.y = cat.sy + gpiv - (gs * ax + gc * ay);
    }
    // пружина сквоша
    let sqT = 0;
    if (cat.mode === "air" && !cat.tumble) sqT = -clamp(Math.abs(cat.vy) / 3400, 0, 0.14);
    if (cat.mode === "ground" && P.crouch > 0.5 && cat.task?.type === "prep") sqT = 0.1;
    cat.sqv += ((sqT - cat.sq) * 230 - cat.sqv * 14) * dt;
    cat.sq = clamp(cat.sq + cat.sqv * dt, -0.3, 0.45);
  }

  function physLegs(dt) {
    if (cat.mode === "ground") return;
    const fs = cat.face < 0 ? -1 : 1;
    const dv = cat.vrot - prevVrot;
    prevVrot = cat.vrot;
    const t = clock;
    for (let i = 0; i < 4; i++) {
      const front = i === 0 || i === 2;
      let tgt;
      if (cat.mode === "drag") {
        tgt = cat.rot * fs + Math.sin(t * 10 + i * 1.9) * (RM ? 0.1 : 0.32);
      } else if (cat.tumble) {
        const righting = Math.abs(cat.rot) < 0.6 && cat.vy > 0;
        tgt = righting ? (front ? 0.3 : -0.25) : cat.rot * fs + Math.sin(t * 13 + i * 2.3) * 0.4;
      } else {
        const up = clamp(-cat.vy / 900, 0, 1);
        tgt = front ? lerp(0.3, 1.0, up) : lerp(-0.2, -1.0, up);
      }
      legV[i] += ((tgt - legA[i]) * 170 - legV[i] * 11) * dt - dv * 0.9;
      legA[i] += legV[i] * dt;
    }
  }

  function tailTargets() {
    let lx = R.tailX, ly = R.tailY;
    let a = P.tA + P.tSwA * Math.sin(clock * P.tSwF * TAU);
    tGX[0] = l2wX(lx, ly); tGY[0] = l2wY(lx, ly);
    for (let i = 1; i < TN; i++) {
      a += P.tK + (i <= 4 ? P.tB : 0);
      if (i >= TN - 4) a += P.tTw * Math.sin(clock * 7 + i * 0.9);
      lx += Math.cos(a) * TSEG; ly += Math.sin(a) * TSEG;
      tGX[i] = l2wX(lx, ly); tGY[i] = l2wY(lx, ly);
    }
  }
  function tailSnap() {
    computeXform();
    tailTargets();
    for (let i = 0; i < TN; i++) { tX[i] = tPX[i] = tGX[i]; tY[i] = tPY[i] = tGY[i]; }
  }
  function physTail(dt) {
    computeXform();
    tailTargets();
    tX[0] = tPX[0] = tGX[0];
    tY[0] = tPY[0] = tGY[0];
    const seg = TSEG * K;
    const grav = 900 * dt * dt;
    const sm = P.tStiff;
    for (let i = 1; i < TN; i++) {
      const vx = (tX[i] - tPX[i]) * 0.94, vy = (tY[i] - tPY[i]) * 0.94;
      tPX[i] = tX[i]; tPY[i] = tY[i];
      tX[i] += vx; tY[i] += vy + grav;
      const s = Math.min(T_STIFF[i] * sm, 0.6);
      tX[i] += (tGX[i] - tX[i]) * s;
      tY[i] += (tGY[i] - tY[i]) * s;
    }
    for (let i = 1; i < TN; i++) {
      const dx = tX[i] - tX[i - 1], dy = tY[i] - tY[i - 1];
      const d = Math.hypot(dx, dy) || 1e-4;
      tX[i] = tX[i - 1] + (dx / d) * seg;
      tY[i] = tY[i - 1] + (dy / d) * seg;
    }
    if (cat.mode === "ground") {
      const gy = cat.y - 2.6 * K;
      for (let i = 1; i < TN; i++) if (tY[i] > gy) { tY[i] = gy; tPX[i] = lerp(tPX[i], tX[i], 0.3); }
    }
  }

  function physYarn(dt) {
    const b = yarn;
    if (!b.on) return;
    if (b.grabbed) {
      const nx = clamp(ptr.x + b.ox, b.r, W - b.r), ny = clamp(ptr.y + b.oy, b.r, FLOOR - b.r);
      b.vx = lerp(b.vx, (nx - b.x) / dt, 0.25);
      b.vy = lerp(b.vy, (ny - b.y) / dt, 0.25);
      b.ang += (nx - b.x) / b.r;
      b.x = nx; b.y = ny;
      b.ground = false;
    } else {
      const y0 = b.y;
      if (!b.ground) b.vy += G * dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      if (b.x < b.r) { b.x = b.r; b.vx = Math.abs(b.vx) * 0.6; }
      else if (b.x > W - b.r) { b.x = W - b.r; b.vx = -Math.abs(b.vx) * 0.6; }
      if (b.y < b.r && b.vy < 0) { b.y = b.r; b.vy = -b.vy * 0.4; }
      if (b.ground) {
        const s = b.surf;
        if (!s.floor && (!s.stay || b.x < s.left - 14 * K || b.x > s.right + 14 * K)) b.ground = false;
        else {
          b.y = s.top - b.r; b.vy = 0;
          b.vx *= Math.exp(-1.7 * dt);
          if (Math.abs(b.vx) < 3) b.vx = 0;
        }
      } else if (b.vy > 0) {
        const s = crossed(b.x, y0 + b.r, b.y + b.r, -4 * K, null);
        if (s) {
          b.y = s.top - b.r;
          b.surf = s;
          if (b.vy > 170) { b.vy = -b.vy * 0.46; b.vx *= 0.9; }
          else { b.vy = 0; b.ground = true; }
        }
      }
      b.ang += (b.vx * dt) / b.r;
    }
    // нитка
    const ax = b.x + Math.cos(b.ang + 2.2) * b.r, ay = b.y + Math.sin(b.ang + 2.2) * b.r;
    b.hx[0] = b.hpx[0] = ax; b.hy[0] = b.hpy[0] = ay;
    const g = G * 0.5 * dt * dt;
    for (let i = 1; i < YN; i++) {
      const vx = (b.hx[i] - b.hpx[i]) * 0.97, vy = (b.hy[i] - b.hpy[i]) * 0.97;
      b.hpx[i] = b.hx[i]; b.hpy[i] = b.hy[i];
      b.hx[i] += vx; b.hy[i] += vy + g;
    }
    const seg = 7 * K / 1.25;
    for (let it = 0; it < 2; it++) {
      for (let i = 1; i < YN; i++) {
        const dx = b.hx[i] - b.hx[i - 1], dy = b.hy[i] - b.hy[i - 1];
        const d = Math.hypot(dx, dy) || 1e-4;
        if (d > seg) { b.hx[i] = b.hx[i - 1] + (dx / d) * seg; b.hy[i] = b.hy[i - 1] + (dy / d) * seg; }
      }
      for (let i = 1; i < YN; i++) {
        const top = surfaceBelow(b.hx[i], b.hpy[i] - 1).top - 1;
        if (b.hy[i] > top) { b.hy[i] = top; b.hpx[i] = lerp(b.hpx[i], b.hx[i], 0.5); }
      }
    }
  }

  // ================================================================ ПОЗА
  function computePose() {
    const sit = P.sit, loaf = P.loaf, cr = P.crouch, st = P.stretch;
    const t = clock;
    const ground = cat.mode === "ground";
    const sleeping = cat.task?.type === "sleep";
    let rot = -0.56 * sit + 0.3 * st + 0.05 * cr;
    let dy = 8 * sit + 10 * loaf + 7 * cr + 1.5 * st;
    let sx = 1 + 0.07 * loaf - 0.02 * cr, sy = 1 - 0.1 * loaf - 0.08 * cr;
    const br = Math.sin(t * (sleeping ? 1.6 : 2.4));
    sy += br * (0.012 + 0.022 * loaf);
    const run = P.run, mv = P.move;
    const ph = cat.phase * TAU;
    rot += run * 0.12 * Math.sin(ph);
    dy -= mv * (1 - run) * 0.9 * Math.abs(Math.sin(ph * 2)) + run * 2.4 * Math.abs(Math.cos(ph));
    sx += run * 0.07 * Math.cos(ph);
    if (P.wiggle > 0.01) {
      const w = P.wiggle * (RM ? 0.025 : 0.05) * Math.sin(t * TAU * 6.5);
      rot += w;
      dy -= w * 32;
    }
    if (P.dance > 0.01) {
      const bt = t * TAU * (RM ? 0.6 : 1.1);
      dy -= P.dance * (RM ? 1.5 : 4) * Math.abs(Math.sin(bt));
      rot += P.dance * 0.06 * Math.sin(bt * 0.5);
    }
    if (cat.mode === "air" && !cat.tumble) rot += clamp(cat.vy / 2600, -0.42, 0.42) * 0.8;
    R.bRot = rot; R.bDX = 0; R.bDY = dy; R.bSX = sx; R.bSY = sy;
    bc = Math.cos(rot); bs = Math.sin(rot);

    // бёдра
    for (let i = 0; i < 4; i++) {
      let hx = btX(HIP_X[i], HIP_Y[i]), hy = btY(HIP_X[i], HIP_Y[i]);
      if (i === 1 || i === 3) {
        hx = lerp(hx, HIP_SIT_X[i], sit);
        hy = lerp(hy, HIP_SIT_Y[i], sit);
      }
      R.hipX[i] = hx; R.hipY[i] = hy;
    }

    // голова
    const nx = btX(NECK_X, NECK_Y), ny = btY(NECK_X, NECK_Y);
    R.headX = nx + 8 + P.lookX * 1.4 - 2 * loaf + 4 * cr + 5 * st - 4 * P.groom;
    R.headY = ny - 12 - 5 * sit + 8 * loaf + 3 * cr + 9 * st + 4 * P.groom + P.lookY * 1.1;
    if (ground) R.headY -= mv * (1 - run) * 0.7 * Math.sin(ph * 2 + 0.6);
    if (P.dance > 0.01) R.headX += P.dance * 2 * Math.sin(t * TAU * 0.55);
    R.headRot = P.headTilt + rot * 0.25 + P.lookY * 0.08 - P.groom * 0.2;
    R.tailX = btX(TAIL_X, TAIL_Y);
    R.tailY = btY(TAIL_X, TAIL_Y);

    // ступни
    if (ground) {
      const beta = lerp(0.6, 0.38, run);
      const stride = lerp(30, 92, run);
      const A = (stride * beta) / 2 * mv;
      const lift = lerp(5, 11, run) * mv;
      for (let i = 0; i < 4; i++) {
        const off = lerp(WALK_OFF[i], RUN_OFF[i], run);
        let p = (cat.phase + off) % 1;
        let gx, gy;
        if (p < beta) { gx = A * (1 - (2 * p) / beta); gy = 0; }
        else {
          const u = (p - beta) / (1 - beta);
          gx = A * (-1 + 2 * smooth(u));
          gy = -lift * Math.sin(Math.PI * u);
        }
        let home = lerp(FOOT_STAND[i], FOOT_STRETCH[i], st);
        home = lerp(home, FOOT_SIT[i], sit);
        let fx = home + gx, fy = gy;
        if (loaf > 0.001) {
          const front = i === 0 || i === 2;
          fx = lerp(fx, front ? R.hipX[i] + (i === 0 ? 6 : 3) : R.hipX[i] + 3, loaf);
          fy = lerp(fy, front ? -1 : R.hipY[i] + 5, loaf);
        }
        // в танце задние лапы притопывают
        if (P.dance > 0.01 && (i === 1 || i === 3)) fy -= P.dance * 2 * Math.max(0, Math.sin(t * TAU * 1.1 + (i === 1 ? 0 : Math.PI)));
        R.footX[i] = fx; R.footY[i] = fy;
      }
    } else {
      for (let i = 0; i < 4; i++) {
        R.footX[i] = R.hipX[i] + Math.sin(legA[i]) * LEG_AIR;
        R.footY[i] = R.hipY[i] + Math.cos(legA[i]) * LEG_AIR;
      }
    }

    // поднятая лапка
    R.pawOver = false;
    if (P.paw > 0.01 && ground) {
      let tx = R.footX[0], ty = R.footY[0];
      if (pawMode === 1) {
        // умывается: лапка к мордочке, потом трёт за ухом
        tx = R.headX + 10 + Math.sin(t * 8) * 1.6;
        ty = R.headY + 11 + Math.sin(t * 8) * 2.2;
        R.pawOver = true;
      } else if (pawMode === 2) {
        const w = Math.sin(t * TAU * (RM ? 0.6 : 1.1));
        tx = R.headX + 22 + w * 3;
        ty = R.headY - 3 - Math.abs(w) * 6;
        R.pawOver = true;
      } else if (pawMode === 3) {
        const u = pawU, hx = R.hipX[0], hy = R.hipY[0];
        if (u < 0.35) { const k = smooth(u / 0.35); tx = lerp(FOOT_STAND[0], hx + 6, k); ty = lerp(0, hy + 2, k); }
        else if (u < 0.55) { const k = smooth((u - 0.35) / 0.2); tx = lerp(hx + 6, hx + 30, k); ty = lerp(hy + 2, -3, k); }
        else { const k = smooth((u - 0.55) / 0.45); tx = lerp(hx + 30, FOOT_STAND[0], k); ty = lerp(-3, 0, k); }
      }
      R.footX[0] = lerp(R.footX[0], tx, P.paw);
      R.footY[0] = lerp(R.footY[0], ty, P.paw);
      if (pawMode === 2) {
        // в танце машет и второй лапкой (в противофазе)
        const w2 = Math.sin(t * TAU * (RM ? 0.6 : 1.1) + Math.PI);
        R.footX[2] = lerp(R.footX[2], R.headX + 4 + w2 * 3, P.paw * 0.85);
        R.footY[2] = lerp(R.footY[2], R.headY + 8 - Math.abs(w2) * 4, P.paw * 0.85);
      }
    }
    R.haunch = sit;
  }

  // ================================================================ ОТРИСОВКА
  function rrect(x, y, w, h, r) {
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function heartPath(x, y, s) {
    ctx.beginPath();
    ctx.moveTo(x, y + s * 0.42);
    ctx.bezierCurveTo(x - s * 1.15, y - s * 0.3, x - s * 0.5, y - s * 1.1, x, y - s * 0.42);
    ctx.bezierCurveTo(x + s * 0.5, y - s * 1.1, x + s * 1.15, y - s * 0.3, x, y + s * 0.42);
    ctx.closePath();
  }

  function bodyPath() {
    ctx.beginPath();
    ctx.moveTo(-17, -41);
    ctx.bezierCurveTo(-5, -43, 7, -42.5, 14, -41.5);
    ctx.bezierCurveTo(23, -40, 27.5, -32, 25.5, -24);
    ctx.bezierCurveTo(23.5, -16, 16, -12.5, 6, -13);
    ctx.bezierCurveTo(-4, -13.5, -14, -12, -21, -13.5);
    ctx.bezierCurveTo(-28, -15, -31, -22, -30, -28);
    ctx.bezierCurveTo(-29.5, -36, -25, -41, -17, -41);
    ctx.closePath();
  }
  function headPath() {
    ctx.beginPath();
    ctx.moveTo(0, -18);
    ctx.bezierCurveTo(12.5, -18, 21, -12, 21.8, -2.5);
    ctx.bezierCurveTo(22.6, 3, 21.5, 7, 22.8, 9.5);
    ctx.bezierCurveTo(19.5, 9.5, 18.5, 11, 17.5, 12);
    ctx.bezierCurveTo(13, 15.8, 6, 16.4, 0, 16.4);
    ctx.bezierCurveTo(-6, 16.4, -13, 15.8, -17.5, 12);
    ctx.bezierCurveTo(-18.5, 11, -19.5, 9.5, -22.8, 9.5);
    ctx.bezierCurveTo(-21.5, 7, -22.6, 3, -21.8, -2.5);
    ctx.bezierCurveTo(-21, -12, -12.5, -18, 0, -18);
    ctx.closePath();
  }
  function earPath(w, h) {
    ctx.beginPath();
    ctx.moveTo(-w, 1);
    ctx.quadraticCurveTo(-w * 0.78, -h * 0.55, -w * 0.16, -h);
    ctx.quadraticCurveTo(0, -h * 1.1, w * 0.18, -h * 0.95);
    ctx.quadraticCurveTo(w * 0.8, -h * 0.5, w, 1);
    ctx.closePath();
  }

  function legStroke(i) {
    const hx = R.hipX[i], hy = R.hipY[i], fx = R.footX[i], fy = R.footY[i] - 2.4;
    const dx = fx - hx, dy = fy - hy;
    const len = Math.hypot(dx, dy) || 0.001;
    const b = len < LEG_L ? Math.sqrt(LEG_L * LEG_L - len * len) * 0.45 : 0;
    const sg = i === 0 || i === 2 ? 1 : -1;
    const cx = (hx + fx) / 2 + (-dy / len) * b * sg, cy = (hy + fy) / 2 + (dx / len) * b * sg;
    ctx.beginPath();
    ctx.moveTo(hx, hy);
    ctx.quadraticCurveTo(cx, cy, fx, fy);
  }
  function pawPath(i) {
    ctx.beginPath();
    ctx.ellipse(R.footX[i] + 1.2, R.footY[i] - 2.4, 5.3, 3.5, 0, 0, TAU);
  }
  function legOutline(i, w) {
    ctx.lineWidth = w + OL * 2;
    legStroke(i); ctx.stroke();
    ctx.lineWidth = OL * 2;
    pawPath(i); ctx.stroke();
  }
  function legFill(i, w, col) {
    ctx.strokeStyle = col; ctx.fillStyle = col;
    ctx.lineWidth = w;
    legStroke(i); ctx.stroke();
    pawPath(i); ctx.fill();
  }
  function pawToes(i) {
    // пальчики
    ctx.strokeStyle = "rgba(59,34,84,0.35)";
    ctx.lineWidth = 0.7;
    const x = R.footX[i] + 1.2, y = R.footY[i] - 2.4;
    ctx.beginPath();
    ctx.moveTo(x + 2.2, y + 0.6); ctx.lineTo(x + 2.6, y + 2.6);
    ctx.moveTo(x + 4.2, y - 0.2); ctx.lineTo(x + 4.6, y + 1.8);
    ctx.stroke();
  }
  function pawBeans(x, y) {
    ctx.fillStyle = C.bean;
    ctx.beginPath(); ctx.ellipse(x, y + 0.8, 2.3, 1.8, 0, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(x - 2.4, y - 1.6, 0.95, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(x, y - 2.5, 0.95, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(x + 2.4, y - 1.6, 0.95, 0, TAU); ctx.fill();
  }

  function drawTail() {
    const puff = P.tPuff;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = C.line;
    for (let i = 1; i < TN; i++) {
      ctx.lineWidth = (T_W[i] * puff + OL * 2) * K;
      ctx.beginPath(); ctx.moveTo(tX[i - 1], tY[i - 1]); ctx.lineTo(tX[i], tY[i]); ctx.stroke();
    }
    for (let i = 1; i < TN; i++) {
      ctx.strokeStyle = T_COL[i];
      ctx.lineWidth = T_W[i] * puff * K;
      ctx.beginPath(); ctx.moveTo(tX[i - 1], tY[i - 1]); ctx.lineTo(tX[i], tY[i]); ctx.stroke();
    }
  }

  function applyCatXform() {
    ctx.translate(cat.x, cat.y - gpiv);
    ctx.rotate(cat.rot + cat.rotVis);
    ctx.translate(0, gpiv);
    ctx.scale(gax, gay);
  }

  function drawShadow() {
    let top, h;
    if (cat.mode === "ground") { top = cat.y; h = 0; }
    else { top = surfaceBelow(cat.x, cat.y - 4).top; h = Math.max(0, top - cat.y); }
    const f = clamp(1 - h / 420, 0.15, 1);
    const sw = (38 - 8 * P.sit) * K * f;
    ctx.save();
    ctx.translate(cat.x - cat.dir * 2 * K, top - 1);
    ctx.scale(sw * 1.35, 9 * K * f);
    ctx.globalAlpha = f;
    ctx.fillStyle = gGlow;
    ctx.beginPath(); ctx.arc(0, 0, 1, 0, TAU); ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.translate(cat.x - cat.dir * 2 * K, top - 0.5);
    ctx.scale(sw, 5 * K * f);
    ctx.globalAlpha = f;
    ctx.fillStyle = gShadow;
    ctx.beginPath(); ctx.arc(0, 0, 1, 0, TAU); ctx.fill();
    ctx.restore();
  }

  function drawCat() {
    computeXform();
    const tailFront = (P.sit > 0.55 || P.loaf > 0.55) && cat.mode === "ground";
    // мировые точки для хит-теста и пузыря
    headWX = l2wX(R.headX, R.headY); headWY = l2wY(R.headX, R.headY);
    bodyWX = l2wX(-4, -27 + R.bDY * 0.5); bodyWY = l2wY(-4, -27 + R.bDY * 0.5);

    if (!tailFront) drawTail();

    ctx.save();
    applyCatXform();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // дальние лапы
    ctx.strokeStyle = C.line;
    legOutline(2, 7.2); legOutline(3, 7.2);
    legFill(3, 7.2, C.furFar); legFill(2, 7.2, C.furFar);

    // тело + контуры ближних лап (заливка тела потом перекроет их верх)
    ctx.save();
    ctx.translate(BPX + R.bDX, BPY + R.bDY);
    ctx.rotate(R.bRot);
    ctx.scale(R.bSX, R.bSY);
    ctx.translate(-BPX, -BPY);
    bodyPath();
    ctx.lineWidth = OL * 2;
    ctx.strokeStyle = C.line;
    ctx.stroke();
    ctx.restore();
    const sitHind = R.haunch > 0.45;
    ctx.strokeStyle = C.line;
    if (!sitHind) legOutline(1, 7.8);
    if (!R.pawOver) legOutline(0, 7.8);
    ctx.save();
    ctx.translate(BPX + R.bDX, BPY + R.bDY);
    ctx.rotate(R.bRot);
    ctx.scale(R.bSX, R.bSY);
    ctx.translate(-BPX, -BPY);
    bodyPath();
    ctx.fillStyle = gBody;
    ctx.fill();
    // мягкий розовый «рим-лайт» по спине
    ctx.strokeStyle = "rgba(255,150,205,0.28)";
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(-24, -37.5);
    ctx.bezierCurveTo(-14, -40.5, 2, -40.6, 12, -39.5);
    ctx.stroke();
    ctx.restore();

    // бедро (когда сидит)
    if (R.haunch > 0.02) {
      const s = R.haunch;
      ctx.save();
      ctx.translate(-12.5, -10.5 + (1 - s) * -8);
      ctx.rotate(-0.28);
      ctx.scale(s, s);
      ctx.beginPath();
      ctx.ellipse(0, 0, 12.5, 10.2, 0, 0, TAU);
      ctx.lineWidth = OL * 2;
      ctx.strokeStyle = C.line;
      ctx.stroke();
      ctx.fillStyle = gHaunch;
      ctx.fill();
      ctx.restore();
    }
    if (sitHind) {
      ctx.strokeStyle = C.line;
      legOutline(1, 7.8);
      legFill(1, 7.8, C.fur);
      pawToes(1);
    } else {
      legFill(1, 7.8, C.fur);
      if (cat.mode === "ground") pawToes(1);
    }
    if (!R.pawOver) {
      legFill(0, 7.8, C.fur);
      if (cat.mode === "ground" && P.paw < 0.3) pawToes(0);
    }
    ctx.restore();

    if (tailFront) drawTail();

    ctx.save();
    applyCatXform();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    drawHead();
    if (R.pawOver) {
      ctx.strokeStyle = C.line;
      legOutline(0, 7.8);
      legFill(0, 7.8, C.fur);
      if (pawMode === 2 || pawMode === 1) pawBeans(R.footX[0] + 1.2, R.footY[0] - 2.2);
    }
    ctx.restore();
  }

  function drawHead() {
    const flat = P.earFlat, fwd = P.earFwd;
    ctx.save();
    ctx.translate(R.headX, R.headY);
    ctx.rotate(R.headRot);
    // уши
    const farR = -0.36 - flat * 0.95 + P.earL + fwd * 0.12;
    const nearR = 0.22 + flat * 0.95 + P.earR - fwd * 0.08;
    const earSy = 1 - flat * 0.42;
    ctx.strokeStyle = C.line;
    ctx.lineWidth = OL * 2;
    ctx.save(); ctx.translate(-10.5, -12); ctx.rotate(farR); ctx.scale(1, earSy); earPath(8, 16); ctx.stroke(); ctx.restore();
    ctx.save(); ctx.translate(9, -13.5); ctx.rotate(nearR); ctx.scale(1, earSy); earPath(8.6, 17); ctx.stroke(); ctx.restore();
    headPath();
    ctx.stroke();
    // заливка ушей
    ctx.save(); ctx.translate(-10.5, -12); ctx.rotate(farR); ctx.scale(1, earSy);
    earPath(8, 16); ctx.fillStyle = gEarFar; ctx.fill();
    ctx.translate(1.2, -1.5); ctx.scale(0.55, 0.62); earPath(8, 16); ctx.fillStyle = "#e88cbc"; ctx.fill();
    ctx.restore();
    ctx.save(); ctx.translate(9, -13.5); ctx.rotate(nearR); ctx.scale(1, earSy);
    earPath(8.6, 17); ctx.fillStyle = gEarNear; ctx.fill();
    ctx.translate(0.4, -1.5); ctx.scale(0.56, 0.64); earPath(8.6, 17); ctx.fillStyle = C.innerEar; ctx.fill();
    ctx.restore();
    // голова
    headPath();
    ctx.fillStyle = gHead;
    ctx.fill();

    const fx = 1.4 + P.lookX * 2.6, fy = 0.6 + P.lookY * 1.8;
    // полоски на лбу (сиреневые)
    ctx.strokeStyle = "rgba(170,146,214,0.75)";
    ctx.lineWidth = 1.7;
    const sx = 2 + fx * 0.45;
    ctx.beginPath();
    ctx.moveTo(sx - 4.3, -16.4); ctx.lineTo(sx - 3.6, -12.4);
    ctx.moveTo(sx, -17.4); ctx.lineTo(sx, -11.6);
    ctx.moveTo(sx + 4.3, -16.4); ctx.lineTo(sx + 3.6, -12.4);
    ctx.stroke();
    // румянец
    ctx.globalAlpha = clamp(P.blush, 0, 1) * 0.75;
    ctx.fillStyle = "#ff8ac0";
    ctx.beginPath(); ctx.ellipse(fx - 11, fy + 6.8, 4, 2.5, 0, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.ellipse(fx + 15.5, fy + 6.8, 3.6, 2.4, 0, 0, TAU); ctx.fill();
    ctx.globalAlpha = 1;
    // глаза
    drawEye(fx - 5.6, fy - 0.6, 4.6, 6.0, false);
    drawEye(fx + 9.8, fy - 0.6, 5.3, 6.4, true);
    // нос
    const nx = fx + 2.6, ny = fy + 5.6;
    ctx.fillStyle = C.nose;
    ctx.beginPath();
    ctx.moveTo(nx - 2.5, ny - 1.2);
    ctx.quadraticCurveTo(nx, ny - 2.3, nx + 2.5, ny - 1.2);
    ctx.quadraticCurveTo(nx + 2.2, ny + 0.5, nx, ny + 1.5);
    ctx.quadraticCurveTo(nx - 2.2, ny + 0.5, nx - 2.5, ny - 1.2);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    ctx.beginPath(); ctx.ellipse(nx - 0.7, ny - 1.1, 0.8, 0.45, 0, 0, TAU); ctx.fill();
    // рот
    const m = P.mouth;
    ctx.strokeStyle = C.line;
    ctx.lineWidth = 0.95;
    if (m > 0.08) {
      const mw = 2.3 + m * 1.3, mh = 1.2 + m * 3.6;
      const my = ny + 2.2 + mh * 0.5;
      ctx.beginPath(); ctx.ellipse(nx, my, mw, mh, 0, 0, TAU);
      ctx.fillStyle = C.mouth; ctx.fill(); ctx.stroke();
      ctx.save();
      ctx.beginPath(); ctx.ellipse(nx, my, mw, mh, 0, 0, TAU); ctx.clip();
      ctx.fillStyle = C.tongue;
      ctx.beginPath(); ctx.ellipse(nx, my + mh * 0.7, mw * 0.8, mh * 0.55, 0, 0, TAU); ctx.fill();
      ctx.restore();
    } else {
      ctx.beginPath();
      ctx.moveTo(nx, ny + 1.4); ctx.lineTo(nx, ny + 2.6);
      ctx.moveTo(nx - 3, ny + 2.9); ctx.quadraticCurveTo(nx - 1.4, ny + 4.6, nx, ny + 2.6);
      ctx.quadraticCurveTo(nx + 1.4, ny + 4.6, nx + 3, ny + 2.9);
      ctx.stroke();
      if (P.tongue > 0.3) {
        ctx.fillStyle = C.tongue;
        ctx.beginPath(); ctx.ellipse(nx + 0.3, ny + 4.4, 1.5 * P.tongue, 1.6 * P.tongue, 0, 0, TAU); ctx.fill();
      }
    }
    // усы
    const wig = Math.sin(clock * 3) * 0.04 + (pet.active ? Math.sin(clock * 12) * 0.05 : 0);
    ctx.strokeStyle = C.whisker;
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    for (let k = -1; k <= 1; k++) {
      const a = k * 0.16 + wig;
      ctx.moveTo(fx + 15.5, fy + 5 + k * 1.4);
      ctx.quadraticCurveTo(fx + 23, fy + 3.8 + k * 3 - a * 8, fx + 31, fy + 2.5 + k * 4.6 - a * 14);
      ctx.moveTo(fx - 11.5, fy + 5 + k * 1.4);
      ctx.quadraticCurveTo(fx - 18.5, fy + 3.8 + k * 3 - a * 8, fx - 26, fy + 2.5 + k * 4.6 - a * 14);
    }
    ctx.stroke();
    ctx.restore();
    // ошейник с цветком сакуры
    drawCollar();
  }

  let blinkT = 2, blinkPh = -1, blinkDur = 0.15, slowBlinkWanted = false;
  function drawEye(x, y, rx, ry, near) {
    const open = (1 - P.shut) * blinkOpen();
    const angry = P.angry, surprise = P.surprise;
    ctx.save();
    ctx.translate(x, y);
    if (open < 0.16) {
      // закрытые глаза: «^» когда доволен, «‿» когда спит/моргает
      ctx.strokeStyle = C.eyeTop;
      ctx.lineWidth = 1.7;
      ctx.beginPath();
      if (P.happy > 0.5) { ctx.moveTo(-rx * 0.95, ry * 0.2); ctx.quadraticCurveTo(0, -ry * 0.85, rx * 0.95, ry * 0.2); }
      else { ctx.moveTo(-rx * 0.95, 0); ctx.quadraticCurveTo(0, ry * 0.62, rx * 0.95, 0); }
      ctx.stroke();
      ctx.restore();
      return;
    }
    const sc = 1 + surprise * 0.12;
    ctx.scale(sc, open * sc);
    ctx.beginPath(); ctx.ellipse(0, 0, rx, ry, 0, 0, TAU);
    ctx.fillStyle = gEye; ctx.fill();
    // зрачок следит за курсором
    const pr = clamp(P.pupil - surprise * 0.45, 0.45, 1.8);
    const px = P.lookX * rx * 0.3, py = P.lookY * ry * 0.22;
    ctx.fillStyle = C.pupil;
    ctx.beginPath();
    ctx.ellipse(px, py, rx * 0.36 * Math.min(pr, 1.75), ry * (pr > 1 ? 0.6 + (pr - 1) * 0.25 : 0.68 * pr + 0.04), 0, 0, TAU);
    ctx.fill();
    // блики
    ctx.fillStyle = "#ffffff";
    ctx.beginPath(); ctx.ellipse(rx * 0.3 + px * 0.25, -ry * 0.36, rx * 0.36, ry * 0.3, 0, 0, TAU); ctx.fill();
    ctx.globalAlpha = 0.85;
    ctx.beginPath(); ctx.arc(-rx * 0.34 + px * 0.2, ry * 0.36, rx * 0.17, 0, TAU); ctx.fill();
    ctx.globalAlpha = 1;
    // сердитые «брови»: срезаем верх глаза под углом
    if (angry > 0.05) {
      const s = near ? 1 : -1;
      ctx.fillStyle = C.fur;
      ctx.beginPath();
      ctx.moveTo(-rx * 1.3 * s, -ry * (1.25 - angry * 1.2));
      ctx.lineTo(rx * 1.3 * s, -ry * (1.25 - angry * 0.45));
      ctx.lineTo(rx * 1.3 * s, -ry * 1.4);
      ctx.lineTo(-rx * 1.3 * s, -ry * 1.4);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = C.line;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(-rx * 1.05 * s, -ry * (1.25 - angry * 1.2) + 0.2);
      ctx.lineTo(rx * 1.05 * s, -ry * (1.25 - angry * 0.45) + 0.2);
      ctx.stroke();
    }
    ctx.restore();
  }
  function blinkOpen() {
    if (blinkPh < 0) return 1;
    const u = blinkPh;
    if (blinkDur > 0.3) {
      // медленное «кошачье» моргание: закрыть, подержать, открыть
      if (u < 0.35) return 1 - smooth(u / 0.35);
      if (u < 0.6) return 0;
      return smooth((u - 0.6) / 0.4);
    }
    return Math.abs(1 - 2 * u);
  }

  function drawCollar() {
    // ошейник рисуется в системе головы, но под мордочкой
    ctx.save();
    ctx.translate(R.headX, R.headY);
    ctx.rotate(R.headRot * 0.6);
    ctx.lineCap = "round";
    ctx.strokeStyle = C.line;
    ctx.lineWidth = 4.4;
    ctx.beginPath(); ctx.moveTo(-12, 13.6); ctx.quadraticCurveTo(2, 21.5, 16, 13); ctx.stroke();
    ctx.strokeStyle = C.collar;
    ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.moveTo(-12, 13.6); ctx.quadraticCurveTo(2, 21.5, 16, 13); ctx.stroke();
    // сакура-кулон
    const swing = Math.sin(clock * 2.2) * 0.25 + clamp(cat.vx / 600, -0.5, 0.5) * -1;
    ctx.translate(3.5, 18.6);
    ctx.rotate(swing);
    ctx.translate(0, 2.6);
    ctx.fillStyle = C.charm;
    ctx.strokeStyle = C.line;
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * TAU - Math.PI / 2;
      const px = Math.cos(a) * 2.2, py = Math.sin(a) * 2.2;
      ctx.moveTo(px + 1.6, py);
      ctx.arc(px, py, 1.6, 0, TAU);
    }
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = C.charmCore;
    ctx.beginPath(); ctx.arc(0, 0, 1.1, 0, TAU); ctx.fill();
    ctx.restore();
  }

  function drawYarn() {
    const b = yarn;
    if (!b.on) return;
    ctx.save();
    ctx.globalAlpha = b.alpha;
    // нитка
    ctx.strokeStyle = "#ff8cc6";
    ctx.lineWidth = 1.6;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(b.hx[0], b.hy[0]);
    for (let i = 1; i < YN - 1; i++) {
      ctx.quadraticCurveTo(b.hx[i], b.hy[i], (b.hx[i] + b.hx[i + 1]) / 2, (b.hy[i] + b.hy[i + 1]) / 2);
    }
    ctx.lineTo(b.hx[YN - 1], b.hy[YN - 1]);
    ctx.stroke();
    // тень
    const top = b.ground ? b.surf.top : surfaceBelow(b.x, b.y + b.r).top;
    const f = clamp(1 - (top - b.y - b.r) / 300, 0.2, 1);
    ctx.save();
    ctx.translate(b.x, top - 0.5);
    ctx.scale(b.r * 1.1 * f, 3.5 * f);
    ctx.fillStyle = gShadow;
    ctx.beginPath(); ctx.arc(0, 0, 1, 0, TAU); ctx.fill();
    ctx.restore();
    // клубок
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.shadowColor = "rgba(255,61,154,0.55)";
    ctx.shadowBlur = 14;
    ctx.save();
    ctx.scale(b.r, b.r);
    ctx.beginPath(); ctx.arc(0, 0, 1, 0, TAU);
    ctx.fillStyle = gYarn;
    ctx.fill();
    ctx.restore();
    ctx.shadowBlur = 0;
    ctx.save();
    ctx.beginPath(); ctx.arc(0, 0, b.r, 0, TAU);
    ctx.clip();
    ctx.rotate(b.ang);
    ctx.strokeStyle = "rgba(255,226,240,0.75)";
    ctx.lineWidth = 1.1;
    const r = b.r;
    ctx.beginPath();
    for (let k = -2; k <= 2; k++) {
      ctx.moveTo(-r, k * r * 0.34 - r * 0.25);
      ctx.quadraticCurveTo(0, k * r * 0.34 + r * 0.32, r, k * r * 0.34 - r * 0.25);
    }
    ctx.stroke();
    ctx.strokeStyle = "rgba(200,60,130,0.55)";
    ctx.beginPath();
    for (let k = -1; k <= 1; k++) {
      ctx.moveTo(k * r * 0.45 - r * 0.2, -r);
      ctx.quadraticCurveTo(k * r * 0.45 + r * 0.35, 0, k * r * 0.45 - r * 0.2, r);
    }
    ctx.stroke();
    ctx.restore();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = "rgba(90,20,60,0.7)";
    ctx.beginPath(); ctx.arc(0, 0, b.r, 0, TAU); ctx.stroke();
    ctx.restore();
    ctx.restore();
  }

  function drawLaser() {
    const fl = RM ? 1 : 0.85 + Math.random() * 0.25;
    ctx.save();
    ctx.translate(laser.x, laser.y);
    ctx.globalCompositeOperation = "lighter";
    ctx.scale(fl, fl);
    ctx.fillStyle = gLaser;
    ctx.beginPath(); ctx.arc(0, 0, 20, 0, TAU); ctx.fill();
    // ядро рисуем обычным смешиванием — иначе на белой шерсти точка пропадает
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "rgba(255,40,60,0.9)";
    ctx.beginPath(); ctx.arc(0, 0, 3.6, 0, TAU); ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.beginPath(); ctx.arc(0, 0, 1.6, 0, TAU); ctx.fill();
    ctx.restore();
  }

  function drawParticles() {
    for (let i = 0; i < MAXP; i++) {
      const p = parts[i];
      if (!p.on) continue;
      const u = p.t / p.life;
      const a = u < 0.15 ? u / 0.15 : 1 - smooth((u - 0.55) / 0.45);
      ctx.globalAlpha = clamp(a, 0, 1);
      if (p.k === HEART) {
        const s = p.s * (0.7 + 0.3 * smooth(u * 4));
        heartPath(p.x, p.y, s);
        ctx.fillStyle = p.c ? RAINBOW[(p.c - 1 + ((clock * 4) | 0)) % 12] : u < 0.5 ? theme.pink : theme.hot;
        ctx.fill();
        ctx.fillStyle = "rgba(255,255,255,0.55)";
        ctx.beginPath(); ctx.arc(p.x - s * 0.35, p.y - s * 0.45, s * 0.16, 0, TAU); ctx.fill();
      } else if (p.k === ZZZ) {
        ctx.font = FONT_Z[p.c % 3];
        ctx.fillStyle = "#e9ddff";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.shadowColor = "rgba(155,123,255,0.8)";
        ctx.shadowBlur = 8;
        ctx.fillText(p.c === 0 ? "z" : "Z", p.x, p.y);
        ctx.shadowBlur = 0;
      } else if (p.k === DUST) {
        ctx.fillStyle = "rgba(225,210,250,0.55)";
        ctx.beginPath(); ctx.arc(p.x, p.y, p.s * (0.6 + u), 0, TAU); ctx.fill();
      } else if (p.k === SPARK) {
        ctx.fillStyle = theme.pink;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.s * (1 - u), 0, TAU); ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }
  function updateParticles(dt) {
    for (let i = 0; i < MAXP; i++) {
      const p = parts[i];
      if (!p.on) continue;
      p.t += dt;
      if (p.t >= p.life) { p.on = false; continue; }
      if (p.k === HEART) { p.x += (p.vx + Math.sin(p.t * 5 + p.h) * 18) * dt; p.y += p.vy * dt; p.vy *= 1 - 0.6 * dt; }
      else if (p.k === ZZZ) { p.x += (p.vx + Math.sin(p.t * 2.5 + p.h) * 8) * dt; p.y += p.vy * dt; }
      else if (p.k === DUST) { p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 1 - 4 * dt; p.vy *= 1 - 4 * dt; }
      else { p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 600 * dt; }
    }
  }

  function drawBubble(dt) {
    if (!bub.on) return;
    bub.t += dt;
    if (bub.t > bub.dur) { bub.on = false; bub.placed = false; return; }
    const u = bub.t;
    const appear = u < 0.28 ? u / 0.28 : 1;
    const back = 1.70158;
    const e = appear - 1;
    const sc = RM ? 1 : 1 + (back + 1) * e * e * e + back * e * e; // easeOutBack
    const alpha = clamp(Math.min(appear * 2, (bub.dur - u) / 0.3), 0, 1);
    const w = Math.ceil(bub.w) + 26, h = bub.n === 2 ? 46 : 30;
    // якорь — над головой
    const ax = headWX, ay = headWY - 34 * K - (cat.mode === "drag" ? 0 : P.earFlat * -4);
    if (!bub.placed) { bub.x = ax; bub.y = ay; bub.placed = true; }
    bub.x = follow(bub.x, ax, 14, dt);
    bub.y = follow(bub.y, ay, 14, dt);
    // по умолчанию — над головой; если места нет — сбоку от головы
    let bx = clamp(bub.x - w / 2, 8, W - w - 8);
    let by = bub.y - h - 8;
    let side = 0; // 0 — хвостик вниз, 1 — пузырь справа (хвостик влево), -1 — слева
    if (by < 8) {
      const hx = headWX, gap = 30 * K;
      side = hx + gap + w + 8 < W ? 1 : -1;
      bx = side > 0 ? hx + gap : hx - gap - w;
      by = clamp(headWY - h / 2 - 6 * K, 8, H - h - 8);
    }
    const tx = side === 0 ? clamp(bub.x, bx + 14, bx + w - 14) : side > 0 ? bx : bx + w;
    const ty = side === 0 ? by + h : clamp(headWY - 6 * K, by + 10, by + h - 10);
    ctx.save();
    ctx.globalAlpha = alpha;
    const ox = side === 0 ? tx : side > 0 ? bx - 7 : bx + w + 7;
    const oy = side === 0 ? by + h + 7 : ty;
    ctx.translate(ox, oy);
    ctx.scale(sc, sc);
    ctx.translate(-ox, -oy);
    ctx.beginPath();
    rrect(bx, by, w, h, 14);
    // хвостик пузыря
    if (side === 0) {
      ctx.moveTo(tx - 7, ty - 0.5);
      ctx.quadraticCurveTo(tx - 1, ty + 3, tx + 1, ty + 9);
      ctx.quadraticCurveTo(tx + 3, ty + 2, tx + 8, ty - 0.5);
    } else {
      const d = -side;
      ctx.moveTo(tx - d * 0.5, ty - 6);
      ctx.quadraticCurveTo(tx + d * 3, ty - 1, tx + d * 9, ty + 1);
      ctx.quadraticCurveTo(tx + d * 2, ty + 3, tx - d * 0.5, ty + 6);
    }
    ctx.shadowColor = "rgba(255,61,154,0.5)";
    ctx.shadowBlur = 18;
    ctx.save();
    ctx.translate(0, by - (bub.n === 2 ? 0 : 8));
    ctx.fillStyle = gBubble;
    ctx.fill();
    ctx.restore();
    ctx.shadowBlur = 0;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = theme.pink;
    ctx.stroke();
    // чтобы хвостик слился с пузырём, перекрываем шов
    ctx.font = FONT_BUBBLE;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = theme.deep;
    if (bub.n === 1) ctx.fillText(bub.lines[0], bx + w / 2, by + h / 2 + 0.5);
    else {
      ctx.fillText(bub.lines[0], bx + w / 2, by + 15.5);
      ctx.fillText(bub.lines[1], bx + w / 2, by + 31.5);
    }
    ctx.restore();
  }

  function render(dt) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    if (cat.vis) {
      drawShadow();
      drawCat();
    }
    if (yarn.on) drawYarn();
    drawParticles();
    if (laser.on && laser.has) drawLaser();
    drawBubble(dt);
  }

  // ================================================================ КАДР
  let acc = 0;
  function tick(dt) {
    clock = now();
    platScanT -= dt;
    if (platScanT <= 0) { scanPlatforms(); platScanT = 1; }
    measurePlatforms();
    petTick();

    resetTargets();
    cat.moved = false;
    // разворот: «переворачиваем» кота по X (быстро, ~0.25 c)
    if (cat.mode !== "drag") cat.face = toward(cat.face, cat.dir, dt * (RM ? 7 : 10));
    cat.rotVis = cat.mode === "ground" ? follow(cat.rotVis, 0, 16, dt) : 0;
    if (cat.mode === "ground") {
      const s = cat.surf;
      if (!s.floor && !s.stay) fall();
      else {
        cat.y = s.top;
        taskUpdate(dt);
      }
    }
    if (cat.mode === "ground") {
      if (!cat.moved) cat.vx = toward(cat.vx, 0, 900 * dt);
      cat.x += cat.vx * dt;
      const s = cat.surf;
      const l = surfL(s), r = surfR(s);
      if (cat.x < l - 2) { cat.x = l; cat.vx = Math.max(cat.vx, 0); }
      if (cat.x > r + 2) { cat.x = r; cat.vx = Math.min(cat.vx, 0); }
      if (!s.floor && (cat.x < s.left - 14 * K || cat.x > s.right + 14 * K)) fall();
      const spd = Math.abs(cat.vx) / K;
      TG.move = clamp(spd / 22, 0, 1);
      TG.run = clamp((spd - 140) / 130, 0, 1);
      const stride = lerp(30, 92, P.run);
      cat.phase = (cat.phase + (spd * dt) / stride) % 1;
    } else {
      TG.move = 0; TG.run = 0;
    }
    if (cat.mode === "air") {
      if (cat.tumble) {
        TG.surprise = 1; TG.earFlat = 0.6; TG.mouth = 0.5; TG.pupil = 0.8;
        tail(2.6, 0.05, 0.18, 0, 1, 0, 1.2);
        if (ptr.in) lookAt(ptr.x, ptr.y);
      } else {
        TG.earFwd = 1; TG.pupil = 1.3;
        tail(3.2, cat.vy < 0 ? -0.05 : 0.06, 0.55, 0, 1, 0, 1);
        if (laser.on && laser.has) lookAt(laser.x, laser.y);
      }
    } else if (cat.mode === "drag") {
      TG.surprise = 0.7; TG.earFlat = 0.85; TG.angry = 0.25; TG.mouth = Math.sin(clock * 3) > 0.7 ? 0.7 : 0.15;
      tail(2.4, 0.04, 0.12, 0, 1, 0, 1.3);
      TG.lookX = 0.3; TG.lookY = 0.6;
    }
    const t = clock;
    if (t < angryUntil) { TG.angry = 1; TG.earFlat = 1; }
    if (t < surpriseUntil && cat.mode !== "ground") TG.surprise = 1;
    if (t < happyUntil && cat.mode === "ground" && TG.angry < 0.5) { TG.blush = Math.max(TG.blush, 0.9); slowBlinkWanted = true; }
    chatter = laser.on ? 1 : 0;

    // моргание
    if (blinkPh >= 0) {
      blinkPh += dt / blinkDur;
      if (blinkPh >= 1) {
        blinkPh = -1;
        if (Math.random() < 0.18) blinkT = 0.1;
        else blinkT = slowBlinkWanted ? rand(1.8, 3.2) : rand(2.2, 5.5);
      }
    } else {
      blinkT -= dt;
      if (blinkT <= 0) { blinkPh = 0; blinkDur = slowBlinkWanted ? 0.95 : 0.15; }
    }
    slowBlinkWanted = false;
    // подёргивания ушами
    if (Math.random() < dt * (RM ? 0.08 : 0.25)) {
      if (Math.random() < 0.5) P.earL += rand(-0.45, -0.25); else P.earR += rand(0.25, 0.45);
    }
    TG.earL = 0; TG.earR = 0;

    // сглаживание параметров позы
    for (const k in RATE) P[k] = follow(P[k], TG[k], RATE[k], dt);

    computePose();

    // физика фиксированным шагом
    acc += dt;
    let n = 0;
    while (acc >= STEP && n < 8) {
      physCat(STEP);
      physLegs(STEP);
      if (cat.vis) physTail(STEP);
      physYarn(STEP);
      acc -= STEP;
      n++;
    }
    if (n === 8) acc = 0;

    // клубок: появление/исчезновение
    if (yarn.on) {
      yarn.alpha = follow(yarn.alpha, yarn.dying ? 0 : 1, 10, dt);
      if (yarn.dying && yarn.alpha < 0.02) yarn.on = false;
    }
    if (laser.on) laser.speed *= Math.exp(-5 * dt);

    // сердечки, пока гладят
    if (pet.active) {
      pet.ht = (pet.ht || 0) - dt;
      if (pet.ht <= 0) {
        pet.ht = RM ? 0.7 : 0.22;
        emit(HEART, headWX + rand(-18, 18) * K, headWY - rand(18, 30) * K, rand(-20, 20), -rand(45, 75), rand(1.1, 1.6), rand(5, 8));
      }
    }
    updateParticles(dt);
  }

  // ================================================================ ЦИКЛ
  let raf = 0, running = false, lastT = 0, errored = false, timeScale = 1, perfMs = 0;
  function frame(ts) {
    if (!running) return;
    raf = requestAnimationFrame(frame);
    let dt = (ts - lastT) / 1000;
    lastT = ts;
    if (!(dt > 0)) dt = 1 / 60;
    if (dt > 0.05) dt = 0.05;
    dt *= timeScale;
    try {
      const t0 = performance.now();
      tick(dt);
      render(dt);
      perfMs = perfMs * 0.95 + (performance.now() - t0) * 0.05;
    } catch (e) {
      if (!errored) { errored = true; console.error("[cat]", e); }
      stopLoop();
    }
  }
  function startLoop() {
    if (running || document.hidden || errored) return;
    running = true;
    lastT = performance.now();
    raf = requestAnimationFrame(frame);
  }
  function stopLoop() {
    running = false;
    cancelAnimationFrame(raf);
  }

  // ================================================================ ВВОД
  let grab = null; // { id, what: 1 кот | 2 клубок, sx, sy, t0, dragging, touch, moved }
  let swallowUntil = 0;
  let cursorMode = "";
  const de = document.documentElement;
  const origCursor = de.style.cursor;
  function setCursor(m) {
    if (m === cursorMode) return;
    cursorMode = m;
    de.classList.toggle("kex-grab", m === "grab");
    de.classList.toggle("kex-grabbing", m === "grabbing");
    de.style.cursor = m || origCursor;
  }

  function hitCat(x, y, pad) {
    if (!cat.vis || cat.mode === "hidden") return false;
    let dx = x - headWX, dy = y - headWY;
    const hr = 23 * K + pad;
    if (dx * dx + dy * dy < hr * hr) return true;
    dx = x - bodyWX; dy = y - bodyWY;
    const c = Math.cos(-cat.rot), s = Math.sin(-cat.rot);
    const lx = dx * c - dy * s, ly = dx * s + dy * c;
    const rx = (30 - 6 * P.sit) * K + pad, ry = (18 + 8 * P.sit) * K + pad;
    return (lx * lx) / (rx * rx) + (ly * ly) / (ry * ry) < 1;
  }
  function hitYarn(x, y, pad) {
    if (!yarn.on || yarn.dying) return false;
    const r = yarn.r + pad;
    return (x - yarn.x) ** 2 + (y - yarn.y) ** 2 < r * r;
  }
  // элемент интерфейса поверх кота (z-index > 5, fixed) — его не трогаем
  function overChrome(t) {
    for (let el = t; el && el !== document.body && el !== de; el = el.parentElement) {
      if (el === toysEl) return true;
      let cs;
      try { cs = getComputedStyle(el); } catch (_) { return false; }
      if (cs.position === "fixed" || cs.position === "sticky") {
        const z = parseInt(cs.zIndex, 10);
        if (z > 5) return true;
      }
    }
    return false;
  }
  function swallow(e) {
    if (e.cancelable) e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  function onDown(e) {
    trackPtr(e);
    ptr.down = true;
    swallowUntil = 0; // новый жест — прошлый «съеденный» клик больше не ждём
    if (laser.on && e.pointerType === "touch") laserTo(e.clientX, e.clientY);
    if (!cat.vis || grab) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const touch = e.pointerType === "touch" || e.pointerType === "pen";
    const pad = touch ? 14 : 3;
    let what = 0;
    if (hitYarn(e.clientX, e.clientY, pad + 6)) what = 2;
    else if (hitCat(e.clientX, e.clientY, pad)) what = 1;
    if (!what) return;
    if (overChrome(e.target)) return;
    swallow(e);
    swallowUntil = performance.now() + 900;
    grab = { id: e.pointerId, what, sx: e.clientX, sy: e.clientY, t0: now(), dragging: false, touch, moved: 0, petted: false, flips: 0 };
    if (what === 2) {
      yarn.grabbed = true;
      yarn.ox = yarn.x - e.clientX;
      yarn.oy = yarn.y - e.clientY;
      yarn.boredUntil = 0;
      interact();
      setCursor("grabbing");
      nudgeYarnInterest();
    } else {
      petReset(e.clientX, e.clientY);
    }
  }

  function onMove(e) {
    trackPtr(e);
    if (laser.on && (e.pointerType === "mouse" || e.buttons)) laserTo(e.clientX, e.clientY);
    if (grab && e.pointerId === grab.id) {
      swallow(e);
      const dx = e.clientX - grab.sx, dy = e.clientY - grab.sy;
      grab.moved = Math.max(grab.moved, Math.hypot(dx, dy));
      if (grab.what === 1 && !grab.dragging) {
        if (grab.touch) {
          // на тач-экране: штрихи по коту — гладим, рывок вверх/наружу — берём на руки
          petMove(e.clientX, e.clientY, 2);
          if (pet.active || grab.flips > 0) grab.petted = true;
          const out = !hitCat(e.clientX, e.clientY, 30);
          // долгое удержание без «штрихов» туда-сюда — тоже берём на руки
          const hold = now() - grab.t0 > 0.45 && grab.moved > 8;
          if (!grab.petted && grab.moved > 8 && (dy < -18 || out || hold)) beginDrag();
          else if (grab.petted && out && grab.moved > 60 && !pet.active) beginDrag();
        } else if (grab.moved > 6) beginDrag();
      }
      return;
    }
    if (e.pointerType === "mouse" && cat.vis) {
      const overCat = hitCat(e.clientX, e.clientY, 2);
      const overBall = !overCat && hitYarn(e.clientX, e.clientY, 4);
      setCursor(overCat || overBall ? "grab" : "");
      if (overCat && !e.buttons) {
        if (!pet.hover) { pet.hover = true; petReset(e.clientX, e.clientY); }
        petMove(e.clientX, e.clientY);
      } else pet.hover = false;
    }
  }
  function beginDrag() {
    grab.dragging = true;
    setCursor("grabbing");
    de.classList.add("kex-noselect");
    startDrag();
  }

  function onUp(e) {
    trackPtr(e);
    ptr.down = false;
    if (!grab || e.pointerId !== grab.id) return;
    swallow(e);
    const g = grab;
    grab = null;
    de.classList.remove("kex-noselect");
    if (g.what === 1) {
      if (g.dragging) releaseDrag();
      else if (g.touch && g.moved >= 8 && !g.petted) registerFlip(2);
      else if (g.moved < 8 && !g.petted && !pet.active) onCatClick();
    } else {
      yarn.grabbed = false;
      const pv = ptrVel(tmpV);
      yarn.vx = clamp(pv.x, -2400, 2400);
      yarn.vy = clamp(pv.y, -2400, 2400);
      yarn.ground = false;
      nudgeYarnInterest();
    }
    setCursor(e.pointerType === "mouse" && hitCat(e.clientX, e.clientY, 2) ? "grab" : "");
  }
  function onCancel(e) {
    ptr.down = false;
    if (e.pointerType === "touch") ptr.in = false;
    if (!grab || e.pointerId !== grab.id) return;
    const g = grab;
    grab = null;
    de.classList.remove("kex-noselect");
    if (g.what === 1 && g.dragging) releaseDrag();
    if (g.what === 2) yarn.grabbed = false;
    setCursor("");
  }

  window.addEventListener("pointerdown", onDown, { capture: true });
  window.addEventListener("pointermove", onMove, { capture: true });
  window.addEventListener("pointerup", onUp, { capture: true });
  window.addEventListener("pointercancel", onCancel, { capture: true });
  window.addEventListener("click", (e) => {
    if (performance.now() < swallowUntil) { swallowUntil = 0; swallow(e); }
  }, { capture: true });
  // скролл страницы блокируем только когда палец начался на коте / клубке
  const blockTouch = (e) => { if (grab && e.cancelable) e.preventDefault(); };
  window.addEventListener("touchstart", blockTouch, { capture: true, passive: false });
  window.addEventListener("touchmove", blockTouch, { capture: true, passive: false });
  window.addEventListener("contextmenu", (e) => {
    if (grab || hitCat(e.clientX, e.clientY, 4)) e.preventDefault();
  }, { capture: true });
  window.addEventListener("selectstart", (e) => { if (grab) e.preventDefault(); }, { capture: true });
  window.addEventListener("dragstart", (e) => { if (grab) e.preventDefault(); }, { capture: true });
  window.addEventListener("mouseout", (e) => {
    if (e.relatedTarget) return;
    ptr.in = false;
    if (!grab) setCursor("");
  });
  window.addEventListener("blur", () => { ptr.in = false; });

  function laserTo(x, y) {
    const t = now();
    const dt = Math.max(t - laser.t, 1 / 240);
    const sp = laser.has ? Math.hypot(x - laser.x, y - laser.y) / dt : 0;
    laser.speed = lerp(laser.speed, Math.min(sp, 4000), 0.35);
    laser.x = x; laser.y = y; laser.has = true; laser.t = t;
  }

  // ================================================================ ИГРУШКИ (кнопки)
  const style = document.createElement("style");
  style.id = "kex-cat-style";
  style.textContent = `
.kex-toys{position:fixed;left:max(16px,env(safe-area-inset-left));bottom:max(16px,env(safe-area-inset-bottom));z-index:80;display:flex;gap:10px;
  opacity:0;transform:translateY(14px) scale(.9);pointer-events:none;transition:opacity .6s ease,transform .7s cubic-bezier(.2,.9,.25,1.25)}
.kex-toys.is-on{opacity:1;transform:none;pointer-events:auto}
.kex-toy{all:unset;box-sizing:border-box;position:relative;width:40px;height:40px;border-radius:50%;display:grid;place-items:center;cursor:pointer;
  background:radial-gradient(120% 120% at 30% 20%,rgba(255,255,255,.09),rgba(255,255,255,0) 55%),rgba(20,11,34,.58);
  border:1px solid rgba(255,140,198,.3);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.08),0 8px 24px rgba(0,0,0,.45),0 0 18px rgba(255,61,154,.16);
  -webkit-backdrop-filter:blur(12px) saturate(1.4);backdrop-filter:blur(12px) saturate(1.4);
  transition:transform .25s cubic-bezier(.2,.9,.3,1.3),box-shadow .25s,border-color .25s,background-color .25s;-webkit-tap-highlight-color:transparent}
@media (hover:hover){.kex-toy:hover{transform:translateY(-2px);border-color:rgba(255,140,198,.65);box-shadow:inset 0 1px 0 rgba(255,255,255,.1),0 10px 26px rgba(0,0,0,.5),0 0 26px rgba(255,61,154,.38)}}
.kex-toy:active{transform:scale(.92)}
.kex-toy:focus-visible{outline:2px solid #ff8cc6;outline-offset:3px}
.kex-toy[aria-pressed="true"]{border-color:#ff8cc6;background-color:rgba(255,61,154,.2);
  box-shadow:inset 0 0 0 1px rgba(255,140,198,.45),inset 0 0 14px rgba(255,61,154,.35),0 0 30px rgba(255,61,154,.55)}
.kex-toy::after{content:attr(data-tip);position:absolute;left:50%;bottom:calc(100% + 9px);transform:translate(-50%,4px);white-space:nowrap;
  font:600 11px/1 "JetBrains Mono",ui-monospace,monospace;letter-spacing:.02em;color:#f6f0ff;background:rgba(20,11,34,.82);
  border:1px solid rgba(255,140,198,.3);padding:6px 8px;border-radius:8px;opacity:0;pointer-events:none;transition:opacity .2s,transform .2s}
@media (hover:hover){.kex-toy:hover::after{opacity:1;transform:translate(-50%,0)}}
.kex-toy:focus-visible::after{opacity:1;transform:translate(-50%,0)}
.kex-dot{width:12px;height:12px;border-radius:50%;background:radial-gradient(circle at 38% 34%,#fff 0 16%,#ff4a4a 42%,#c3001c 100%);
  box-shadow:0 0 10px 2px rgba(255,40,60,.7)}
.kex-toy[aria-pressed="true"] .kex-dot{animation:kexPulse 1.1s ease-in-out infinite}
.kex-toy svg{width:24px;height:24px;display:block}
@keyframes kexPulse{50%{box-shadow:0 0 16px 5px rgba(255,40,60,.85)}}
html.kex-grab,html.kex-grab *{cursor:grab!important}
html.kex-grabbing,html.kex-grabbing *{cursor:grabbing!important}
html.kex-laser,html.kex-laser *:not(.kex-toy):not(.kex-toy *){cursor:none!important}
html.kex-noselect,html.kex-noselect *{user-select:none!important;-webkit-user-select:none!important}
@media (prefers-reduced-motion:reduce){.kex-toys,.kex-toy,.kex-toy::after{transition:none}.kex-toy[aria-pressed="true"] .kex-dot{animation:none}}
`;
  document.head.appendChild(style);
  const toysEl = document.createElement("div");
  toysEl.className = "kex-toys";
  toysEl.setAttribute("role", "group");
  toysEl.setAttribute("aria-label", `Игрушки для кота ${NAME}`);
  toysEl.innerHTML =
    `<button type="button" class="kex-toy" data-toy="laser" data-tip="лазер" aria-pressed="false" aria-label="Лазерная указка: кот будет ловить красную точку"><span class="kex-dot"></span></button>` +
    `<button type="button" class="kex-toy" data-toy="yarn" data-tip="клубок" aria-pressed="false" aria-label="Клубок ниток для кота">` +
    `<svg viewBox="0 0 24 24" aria-hidden="true"><defs><radialGradient id="kexY" cx="38%" cy="32%" r="70%"><stop offset="0" stop-color="#ffc4e1"/><stop offset=".6" stop-color="#ff86bf"/><stop offset="1" stop-color="#d4478f"/></radialGradient></defs>` +
    `<path d="M18.6 16.4c1.6.7 2.6 2.2 2.4 3.9" fill="none" stroke="#ff8cc6" stroke-width="1.3" stroke-linecap="round"/>` +
    `<circle cx="11.5" cy="11.5" r="8" fill="url(#kexY)" stroke="#7a1d4f" stroke-width=".9"/>` +
    `<path d="M4.6 9.2c3.6.2 9 2.7 11.6 8.6M6.3 5.6c3.4 1.2 8.4 5 9.9 11.3M4 13.3c3.2-.1 7.2 2 9 5.8M11 3.6c2.8 1.7 6 5 7.2 9" fill="none" stroke="#ffe2f0" stroke-opacity=".8" stroke-width="1.1" stroke-linecap="round"/></svg></button>`;
  document.body.appendChild(toysEl);
  const laserBtn = toysEl.querySelector('[data-toy="laser"]');
  const yarnBtn = toysEl.querySelector('[data-toy="yarn"]');
  laserBtn.addEventListener("click", () => setLaser(!laser.on));
  yarnBtn.addEventListener("click", () => setYarn(!yarn.on || yarn.dying));
  let toysShown = false;
  function showToys() {
    if (toysShown) return;
    toysShown = true;
    setTimeout(() => toysEl.classList.add("is-on"), 600);
  }

  function setLaser(on) {
    laser.on = on;
    laserBtn.setAttribute("aria-pressed", String(on));
    de.classList.toggle("kex-laser", on && !env?.coarse);
    sfx("pop");
    interact();
    if (on) {
      if (ptr.type === "mouse" && ptr.in) { laser.has = true; laser.x = ptr.x; laser.y = ptr.y; }
      else {
        // на тач-экране точка появляется рядом с котом, дальше двигаешь пальцем
        laser.has = true;
        laser.x = clamp(cat.x + (cat.x < W / 2 ? 1 : -1) * 140 * K, 40, W - 40);
        laser.y = cat.surf.top - 6;
      }
      laser.speed = 0;
      wake(false);
      say(pickFresh(PH.laser), 1.8);
      meow("question");
    } else {
      laser.has = false;
    }
    if (cat.mode === "ground" && cat.task?.type !== "petted") think();
  }

  function setYarn(on) {
    sfx("pop");
    interact();
    const b = yarn;
    yarnBtn.setAttribute("aria-pressed", String(on));
    if (!on) { b.dying = true; b.grabbed = false; if (cat.task?.type === "yarn") think(); return; }
    // клубок вылетает из кнопки
    const r = yarnBtn.getBoundingClientRect();
    b.on = true; b.dying = false; b.alpha = 0;
    b.r = 15 * K / 1.25;
    b.x = r.left + r.width / 2; b.y = r.top - b.r;
    b.vx = rand(380, 520) * (W < 600 ? 0.75 : 1);
    b.vy = -rand(700, 900);
    b.ground = false; b.grabbed = false; b.ang = 0; b.surf = floorSurf; b.boredUntil = 0;
    for (let i = 0; i < YN; i++) { b.hx[i] = b.hpx[i] = b.x; b.hy[i] = b.hpy[i] = b.y; }
    wake(false);
    setTimeout(() => { if (b.on && !b.dying) say(pickFresh(PH.yarn), 1.8); }, 500);
    nudgeYarnInterest();
  }
  function nudgeYarnInterest() {
    const tt = cat.task?.type;
    if (cat.mode === "ground" && tt !== "yarn" && tt !== "petted" && tt !== "angry" && tt !== "prep" && !laser.on && !party) think();
  }

  // ================================================================ СОБЫТИЯ СТРАНИЦЫ
  window.addEventListener("resize", () => {
    resize();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopLoop();
      if (pet.purring) { sfx("stopPurr"); pet.purring = false; }
    } else if (cat.vis || yarn.on) startLoop();
  });
  window.addEventListener("sempik:party", (e) => {
    party = !!e?.detail?.on;
    if (cat.mode === "ground" && cat.task?.type !== "petted") {
      if (party) { wake(false); setTask("dance"); }
      else think();
    }
    if (party && cat.vis) for (let i = 0; i < (RM ? 3 : 10); i++) emit(HEART, cat.x + rand(-40, 40) * K, cat.y - rand(30, 80) * K, rand(-60, 60), -rand(60, 130), rand(1.2, 2), rand(6, 10), 1 + i);
  });

  function resize() {
    const r = canvas.getBoundingClientRect();
    W = Math.max(1, Math.round(r.width || innerWidth));
    H = Math.max(1, Math.round(r.height || innerHeight));
    const mob = isMobile();
    DPR = Math.min(window.devicePixelRatio || 1, mob ? 1.5 : 2);
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    K = mob ? (W < 480 ? 1.04 : 1.12) : 1.28;
    FLOOR = H - 3;
    floorSurf.top = FLOOR; floorSurf.left = 0; floorSurf.right = W;
    if (cat.vis) {
      cat.x = clamp(cat.x, wallL(), wallR());
      if (cat.mode === "ground" && cat.surf.floor) cat.y = FLOOR;
    }
    if (yarn.on) yarn.x = clamp(yarn.x, yarn.r, W - yarn.r);
    if (!running) render(0);
  }
  resize();
  scanPlatforms();

  // ================================================================ ПОЯВЛЕНИЕ
  let dropping = false;
  function drop() {
    if (dropping) return;
    dropping = true;
    setTimeout(() => {
      resize();
      scanPlatforms();
      measurePlatforms();
      let x = W * 0.5;
      // приземлиться на карточку, если она видна
      const p = plats.find((q) => q.valid);
      if (p) x = lerp(surfL(p), surfR(p), rand(0.55, 0.85));
      cat.x = clamp(x, wallL(), wallR());
      cat.y = -95 * K;
      cat.vx = 0;
      cat.vy = RM ? 300 : 80;
      cat.rot = RM ? 0 : -1.4;
      cat.vrot = RM ? 0 : 7.5;
      cat.dir = cat.face = cat.x > W * 0.6 ? -1 : 1;
      cat.vis = true;
      cat.greet = true;
      takeOff(!RM);
      cat.thrown = false;
      P.surprise = 1;
      computePose();
      tailSnap();
      interact();
      startLoop();
    }, 380);
  }

  const api = { drop };
  // для отладки из консоли: window.sempik.cat._debug
  Object.defineProperty(api, "_debug", {
    enumerable: false,
    value: {
      cat, P, laser, yarn, pet,
      setTask: (type, o) => { if (cat.mode === "ground") setTask(type, o); },
      setLaser, setYarn, say, think,
      set timeScale(v) { timeScale = v; },
      get perfMs() { return perfMs; },
      get running() { return running; },
      get petCount() { return petCount; },
      get head() { return { x: headWX, y: headWY }; },
      get body() { return { x: bodyWX, y: bodyWY }; },
      get task() { return cat.task?.type || cat.mode; },
    },
  });
  return api;
}
