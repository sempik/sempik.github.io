// Точка входа: грузит модули независимо друг от друга (если один упал — остальные работают)
// и связывает их между собой. Сами фичи живут в ui.js / scene3d.js / cat.js / audio.js.
//
// Порядок: ui.js + audio.js маленькие — как только они пришли, заставку уже можно закрыть.
// 3D-сцена (three.js ~700 КБ) и кот подключаются, когда догрузятся; если человек вошёл раньше —
// они сразу появляются (reveal / drop) по прибытии.
import { CONFIG } from "./config.js";
import { ICONS } from "./icons.js";

// ссылка с невписанной заглушкой ника (вида XXX_HANDLE) на сайт не попадает
const isPlaceholder = (s) => typeof s === "string" && /\b[A-Z]+_HANDLE\b/.test(s);
if (Array.isArray(CONFIG.links)) {
  CONFIG.links = CONFIG.links.filter((l) => l && !isPlaceholder(l.url) && !isPlaceholder(l.copy) && !isPlaceholder(l.sub));
}

const env = {
  reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
  coarse: matchMedia("(pointer: coarse)").matches,
  get mobile() { return innerWidth < 900; },
};

const load = (name) =>
  import(`./${name}.js`).catch((e) => {
    console.error(`[sempik] ${name}.js не загрузился`, e);
    return null;
  });

const safe = (label, fn) => {
  try { return fn(); } catch (e) { console.error(`[sempik] ${label}`, e); return null; }
};

const pUI = load("ui");
const pAudio = load("audio");
const pScene = load("scene3d");
const pCat = load("cat");

const [uiM, audioM] = await Promise.all([pUI, pAudio]);

const audio = safe("audio", () => audioM?.createAudio?.({ config: CONFIG, env })) || null;
let ui = null;
let scene = null;
let cat = null;
let entered = false;
let gesture = true; // onEnter вызван из клика/клавиши (можно включать звук)

// звук можно разбудить только в жесте пользователя — если вошли без жеста, ждём первого касания
function armUnlock() {
  const go = () => {
    removeEventListener("pointerdown", go, true);
    removeEventListener("keydown", go, true);
    safe("audio.unlock", () => audio?.unlock?.());
  };
  addEventListener("pointerdown", go, { capture: true });
  addEventListener("keydown", go, { capture: true });
}

function onEnter() {
  // вызывается синхронно из клика по заставке — это и есть «жест пользователя» для звука
  if (entered) return;
  entered = true;
  if (gesture) safe("audio.unlock", () => audio?.unlock?.());
  else armUnlock();
  safe("scene.reveal", () => scene?.reveal?.());
  safe("cat.drop", () => cat?.drop?.());
  document.documentElement.classList.add("entered");
  window.dispatchEvent(new CustomEvent("sempik:enter"));
}

ui = safe("ui", () => uiM?.initUI?.({ config: CONFIG, icons: ICONS, audio, env, onEnter }));

// для отладки из консоли (scene / cat появятся, когда догрузятся)
const dbg = { CONFIG, env, audio, ui, scene: null, cat: null };
window.sempik = dbg;

// если ui.js не поднялся — не оставляем человека перед вечной заставкой
if (!ui) {
  document.getElementById("splash")?.remove();
  gesture = false;
  onEnter();
}

// ---------------------------------------------------------------- 3D-сцена
pScene.then((m) => {
  scene = safe("scene3d", () =>
    m?.initScene?.({
      canvas: document.getElementById("scene3d"),
      config: CONFIG,
      icons: ICONS,
      audio,
      env,
      onLinkActivate: (link) => ui?.activateLink?.(link),
    })
  );
  dbg.scene = scene;
  if (scene && entered) safe("scene.reveal", () => scene.reveal?.());
  if (scene?.anchor) setupBackdrop();
});

// ---------------------------------------------------------------- кот
pCat.then((m) => {
  cat = safe("cat", () =>
    m?.initCat?.({
      canvas: document.getElementById("cat-layer"),
      config: CONFIG,
      audio,
      env,
      toast: (msg) => ui?.toast?.(msg),
    })
  );
  dbg.cat = cat;
  if (cat && entered) safe("cat.drop", () => cat.drop?.());
});

// все модули на месте (или отвалились) — можно качать фоновое видео, не отнимая канал у three.js
Promise.allSettled([pScene, pCat]).then(() => {
  window.__sempikLoaded = true;
  window.dispatchEvent(new CustomEvent("sempik:loaded"));
});

// Фон: в ролике есть кольцо-«затмение» (центр в 69.5% / 45% кадра 1920x1080, см. tools/motion-bg).
// Ставим его ровно за гало 3D-острова, чтобы кольца были концентричны на любом экране.
// Пересчёт только на resize/поворот (через rAF), не каждый кадр; одинаковый результат не пишем —
// на телефонах resize сыплется при каждом показе/скрытии адресной строки.
const VIDEO = { w: 1920, h: 1080, cx: 0.695 * 1920, cy: 0.45 * 1080 };
let lastBackdrop = "";
function alignBackdrop() {
  const v = document.getElementById("bg-video");
  const box = v?.parentElement;
  if (!v || !box) return;
  const a = safe("scene.anchor", () => scene?.anchor?.());
  if (!a || !Number.isFinite(a.x) || !Number.isFinite(a.y)) {
    if (lastBackdrop) v.removeAttribute("style");
    lastBackdrop = "";
    return;
  }
  const W = box.clientWidth || innerWidth;
  const H = box.clientHeight || innerHeight;
  const cover = Math.max(W / VIDEO.w, H / VIDEO.h);
  // минимальный масштаб, при котором кадр закрывает экран и кольцо можно сдвинуть в нужную точку;
  // сильнее 1.3× не увеличиваем (мыло) — тогда кольцо встанет «как можно ближе»
  let s = Math.max(
    cover,
    a.x / VIDEO.cx,
    (W - a.x) / (VIDEO.w - VIDEO.cx),
    a.y / VIDEO.cy,
    (H - a.y) / (VIDEO.h - VIDEO.cy)
  );
  s = Math.min(s, cover * 1.3);
  const w = VIDEO.w * s;
  const h = VIDEO.h * s;
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const left = clamp(a.x - VIDEO.cx * s, W - w, 0);
  const top = clamp(a.y - VIDEO.cy * s, H - h, 0);
  const key = `${left.toFixed(1)}|${top.toFixed(1)}|${w.toFixed(1)}|${h.toFixed(1)}`;
  if (key === lastBackdrop) return;
  lastBackdrop = key;
  Object.assign(v.style, {
    inset: "auto",
    left: `${left.toFixed(1)}px`,
    top: `${top.toFixed(1)}px`,
    width: `${w.toFixed(1)}px`,
    height: `${h.toFixed(1)}px`,
  });
}
function setupBackdrop() {
  let q = 0;
  const queue = () => {
    cancelAnimationFrame(q);
    // два кадра: сначала сцена пересчитывает свою раскладку, потом мы
    q = requestAnimationFrame(() => { q = requestAnimationFrame(alignBackdrop); });
  };
  alignBackdrop();
  addEventListener("resize", queue, { passive: true });
  addEventListener("orientationchange", queue, { passive: true });
}
