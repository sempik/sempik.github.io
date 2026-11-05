// Точка входа: грузит модули независимо друг от друга (если один упал — остальные работают)
// и связывает их между собой. Сами фичи живут в ui.js / scene3d.js / cat.js / audio.js.
import { CONFIG } from "./config.js";
import { ICONS } from "./icons.js";

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

const [uiM, sceneM, catM, audioM] = await Promise.all(["ui", "scene3d", "cat", "audio"].map(load));

const audio = safe("audio", () => audioM?.createAudio?.({ config: CONFIG, env })) || null;
let ui = null;

const scene = safe("scene3d", () =>
  sceneM?.initScene?.({
    canvas: document.getElementById("scene3d"),
    config: CONFIG,
    icons: ICONS,
    audio,
    env,
    onLinkActivate: (link) => ui?.activateLink?.(link),
  })
);

const cat = safe("cat", () =>
  catM?.initCat?.({
    canvas: document.getElementById("cat-layer"),
    config: CONFIG,
    audio,
    env,
    toast: (msg) => ui?.toast?.(msg),
  })
);

let entered = false;
function onEnter() {
  // вызывается синхронно из клика по заставке — это и есть «жест пользователя» для звука
  if (entered) return;
  entered = true;
  safe("audio.unlock", () => audio?.unlock?.());
  safe("scene.reveal", () => scene?.reveal?.());
  safe("cat.drop", () => cat?.drop?.());
  document.documentElement.classList.add("entered");
  window.dispatchEvent(new CustomEvent("sempik:enter"));
}

ui = safe("ui", () => uiM?.initUI?.({ config: CONFIG, icons: ICONS, audio, env, onEnter }));

// если ui.js не поднялся — не оставляем человека перед вечной заставкой
if (!ui) {
  document.getElementById("splash")?.remove();
  onEnter();
}

// Фон: в ролике есть кольцо-«затмение» (центр в 69.5% / 45% кадра 1920x1080, см. tools/motion-bg).
// Ставим его ровно за гало 3D-острова, чтобы кольца были концентричны на любом экране.
const VIDEO = { w: 1920, h: 1080, cx: 0.695 * 1920, cy: 0.45 * 1080 };
function alignBackdrop() {
  const v = document.getElementById("bg-video");
  const box = v?.parentElement;
  const a = safe("scene.anchor", () => scene?.anchor?.());
  if (!v || !box) return;
  if (!a || !Number.isFinite(a.x) || !Number.isFinite(a.y)) {
    v.removeAttribute("style");
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
  Object.assign(v.style, {
    inset: "auto",
    left: `${left.toFixed(1)}px`,
    top: `${top.toFixed(1)}px`,
    width: `${w.toFixed(1)}px`,
    height: `${h.toFixed(1)}px`,
  });
}
if (scene?.anchor) {
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

// для отладки из консоли
window.sempik = { CONFIG, env, audio, ui, scene, cat };
