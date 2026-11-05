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

// для отладки из консоли
window.sempik = { CONFIG, env, audio, ui, scene, cat };
