// UI: заставка, карточка (ссылки, печатная машинка, статистика GitHub), тосты,
// кнопки звука, курсор-светлячок, Konami-код.
//
// initUI({ config, icons, audio, env, onEnter }) → { toast(msg), activateLink(link) }
import { iconSvg } from "./icons.js";

const $ = (sel, root = document) => root.querySelector(sel);
const raf = (fn) => requestAnimationFrame(fn);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
// коэффициент сглаживания k (заданный для 60 к/с) → для кадра длиной dt мс
const ease = (k, dt) => 1 - Math.pow(1 - k, clamp(dt, 1, 100) / 16.67);
const call = (obj, method, ...args) => {
  try { return obj?.[method]?.(...args); } catch (_) { return undefined; }
};

const ARROW_SVG =
  '<svg class="link__go" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8"/></svg>';
const COPY_SVG =
  '<svg class="link__go" viewBox="0 0 24 24" aria-hidden="true"><rect x="8.5" y="8.5" width="11" height="11" rx="2.5"/><path d="M15.5 5.5v-.2A1.8 1.8 0 0 0 13.7 3.5H6.3a1.8 1.8 0 0 0-1.8 1.8v7.4a1.8 1.8 0 0 0 1.8 1.8h.2"/></svg>';
const CHECK_SVG =
  '<svg class="link__go" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';
const LINK_FALLBACK_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true" style="fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round"><path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/></svg>';
const SVG_REPO =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 19.5V5a2 2 0 0 1 2-2h12v15H7a2 2 0 0 0-2 2Zm0 0A2 2 0 0 0 7 22h12v-4"/></svg>';

function plural(n, forms) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}

// ------------------------------------------------------------------ буфер обмена
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) { /* пробуем по-старому */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.setAttribute("aria-hidden", "true");
    ta.style.cssText = "position:fixed;top:-200px;left:0;opacity:0;pointer-events:none";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    ta.remove();
    if (ok) return true;
  } catch (_) { /* последний вариант — prompt */ }
  try { window.prompt("Скопируй вручную:", text); } catch (_) { /* ну и ладно */ }
  return false;
}

// ------------------------------------------------------------------ тосты (очередь)
function createToaster(el) {
  const queue = []; // { msg, key }
  let current = null;
  let currentKey = null;
  let timer = 0;

  const durFor = (msg) => clamp(1700 + msg.length * 45, 2000, 4200);

  let shownAt = 0;
  function next() {
    const item = queue.shift();
    if (item == null) { current = null; currentKey = null; return; }
    const msg = item.msg;
    current = msg;
    currentKey = item.key;
    shownAt = performance.now();
    el.textContent = msg;
    el.classList.remove("is-on");
    void el.offsetWidth; // перезапуск анимации
    el.classList.add("is-on");
    clearTimeout(timer);
    timer = setTimeout(hide, durFor(msg));
  }
  function hide() {
    el.classList.remove("is-on");
    clearTimeout(timer);
    timer = setTimeout(next, 420);
  }
  // key — сообщения с одним ключом заменяют друг друга (например, «вечеринка вкл/выкл»)
  function show(msg, key = null) {
    if (!el || msg == null) return;
    msg = String(msg).trim();
    if (!msg) return;
    // то же сообщение уже на экране — просто продлеваем
    if (current === msg && el.classList.contains("is-on")) {
      clearTimeout(timer);
      timer = setTimeout(hide, durFor(msg));
      return;
    }
    if (key) {
      for (let i = queue.length - 1; i >= 0; i--) if (queue[i].key === key) queue.splice(i, 1);
    }
    if (queue.length && queue[queue.length - 1].msg === msg) return;
    queue.push({ msg, key });
    if (queue.length > 3) queue.splice(0, queue.length - 3);
    if (current === null) next();
    else if (el.classList.contains("is-on")) {
      // есть очередь — не ждём, пока текущее доиграет: даём ему побыть на экране полсекунды
      // (устаревшее с тем же ключом — сразу) и меняем текст на месте, без паузы на исчезание
      clearTimeout(timer);
      const left = key && key === currentKey ? 0 : Math.max(0, 500 - (performance.now() - shownAt));
      timer = setTimeout(next, left);
    }
  }
  return show;
}

// =================================================================== initUI
export function initUI({ config = {}, icons, audio = null, env = {}, onEnter } = {}) {
  const root = document.documentElement;
  const reduced = !!env.reducedMotion;
  const fine = !env.coarse && matchMedia("(hover: hover) and (pointer: fine)").matches;
  const motion = fine && !reduced;

  const toast = createToaster($("#toast"));
  const card = $(".card");
  const linkEls = new Map();

  fillStatic();
  renderLinks();
  setupBackground();
  setupSplash();
  setupControls();
  setupTypewriter();
  setupGitHub();
  setupTilt();
  setupCursor();
  setupParty();
  setupTitle();
  setupScrolled();
  setupLite();

  // ---------------------------------------------------------------- тексты карточки
  function fillStatic() {
    const name = config.name || "sempik";
    const nameEl = $(".name");
    if (nameEl) {
      nameEl.dataset.text = name;
      const t = $(".name__text", nameEl);
      if (t) t.textContent = name;
    }
    const st = $(".status__text");
    if (st) {
      if (config.status) st.textContent = config.status;
      else $(".status")?.remove();
    }
    const about = $(".about");
    if (about && config.about) about.textContent = config.about;
    const img = $(".avatar__img img");
    if (img && config.avatar) img.src = config.avatar;
    const year = $(".js-year");
    if (year) year.textContent = String(new Date().getFullYear());
    if (env.coarse) {
      const hint = $(".card__hint");
      if (hint) hint.textContent = "погладь кота · тапни аватарку 5 раз";
    }
  }

  // ---------------------------------------------------------------- ссылки
  function renderLinks() {
    const list = $(".links__list");
    if (!list) return;
    const links = Array.isArray(config.links) ? config.links : [];
    list.textContent = "";
    links.forEach((link, idx) => {
      if (!link || !(link.url || link.copy)) return;
      const li = document.createElement("li");
      li.className = "reveal";
      li.style.setProperty("--i", String(5 + idx));
      const isUrl = !!link.url;
      const el = document.createElement(isUrl ? "a" : "button");
      el.className = "link" + (isUrl ? "" : " link--copy");
      el.dataset.id = link.id || "";
      if (link.color) el.style.setProperty("--brand", link.color);
      const sub = link.sub || link.copy || "";
      if (isUrl) {
        el.href = link.url;
        el.target = "_blank";
        el.rel = "noopener";
        el.setAttribute("aria-label", `${link.name} ${sub} — откроется в новой вкладке`);
      } else {
        el.type = "button";
        el.setAttribute("aria-label", `${link.name} ${sub} — скопировать ник`);
      }
      const svg = icons && link.id && icons[link.id] ? iconSvg(link.id) : LINK_FALLBACK_SVG;
      el.innerHTML =
        `<span class="link__icon">${svg}</span>` +
        `<span class="link__text"><span class="link__name"></span><span class="link__sub"></span></span>` +
        (isUrl ? ARROW_SVG : COPY_SVG);
      $(".link__name", el).textContent = link.name || link.id || "";
      $(".link__sub", el).textContent = sub;
      wireLink(el, link);
      li.appendChild(el);
      list.appendChild(li);
      linkEls.set(link.id, el);
    });
    const foot = $(".card__foot");
    if (foot) foot.style.setProperty("--i", String(6 + links.length));
  }

  function wireLink(el, link) {
    let rect = null;
    el.addEventListener("pointerenter", (e) => {
      if (e.pointerType === "mouse") call(audio, "tick");
      rect = el.getBoundingClientRect();
    });
    el.addEventListener("focus", () => {
      try { if (el.matches(":focus-visible")) call(audio, "tick"); } catch (_) { /* старые браузеры */ }
    });
    // «магнит»: пишем стили не на каждый pointermove (у игровых мышей их сотни в секунду),
    // а один раз за кадр, последнее положение
    let nx = 0.5, ny = 0.5, magRaf = 0;
    const applyMagnet = () => {
      magRaf = 0;
      if (!rect) return;
      el.style.setProperty("--mx", ((nx - 0.5) * 8).toFixed(2) + "px");
      el.style.setProperty("--my", ((ny - 0.5) * 6).toFixed(2) + "px");
      el.style.setProperty("--px", (nx * 100).toFixed(1) + "%");
      el.style.setProperty("--py", (ny * 100).toFixed(1) + "%");
    };
    if (motion) {
      el.addEventListener("pointermove", (e) => {
        if (e.pointerType !== "mouse" || root.classList.contains("lite")) return;
        if (!rect) rect = el.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        nx = clamp((e.clientX - rect.left) / rect.width, 0, 1);
        ny = clamp((e.clientY - rect.top) / rect.height, 0, 1);
        if (!magRaf) magRaf = raf(applyMagnet);
      }, { passive: true });
    }
    el.addEventListener("pointerleave", () => {
      rect = null;
      if (magRaf) { cancelAnimationFrame(magRaf); magRaf = 0; }
      el.style.setProperty("--mx", "0px");
      el.style.setProperty("--my", "0px");
    });
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      ripple(el, e.clientX, e.clientY);
    });
    el.addEventListener("click", (e) => {
      call(audio, "pop");
      if (e.detail === 0) {
        const r = el.getBoundingClientRect();
        ripple(el, r.left + r.width / 2, r.top + r.height / 2);
      }
      if (!link.url) {
        e.preventDefault();
        doCopy(link, el);
      }
    });
  }

  function ripple(el, x, y) {
    if (reduced) return;
    const r = el.getBoundingClientRect();
    const span = document.createElement("span");
    span.className = "ripple";
    span.setAttribute("aria-hidden", "true");
    const lx = x - r.left;
    const ly = y - r.top;
    const reach = Math.hypot(Math.max(lx, r.width - lx), Math.max(ly, r.height - ly));
    const s = (reach * 2.3) / 20;
    el.appendChild(span);
    try {
      const anim = span.animate(
        [
          { transform: `translate(${lx}px, ${ly}px) scale(0.2)`, opacity: 0.9 },
          { transform: `translate(${lx}px, ${ly}px) scale(${s})`, opacity: 0 },
        ],
        { duration: 720, easing: "cubic-bezier(.16,1,.3,1)" }
      );
      anim.onfinish = anim.oncancel = () => span.remove();
    } catch (_) {
      span.remove();
    }
  }

  const copyTimers = new WeakMap();
  async function doCopy(link, el) {
    const text = String(link.copy);
    const ok = await copyText(text);
    if (!ok) return;
    toast(`Скопировано: ${text}`);
    if (!el) return;
    const sub = $(".link__sub", el);
    const go = $(".link__go", el);
    clearTimeout(copyTimers.get(el));
    el.classList.add("is-copied");
    if (sub) sub.textContent = "в буфере ✓";
    if (go) go.outerHTML = CHECK_SVG;
    copyTimers.set(
      el,
      setTimeout(() => {
        el.classList.remove("is-copied");
        const s = $(".link__sub", el);
        if (s) s.textContent = link.sub || text;
        const g = $(".link__go", el);
        if (g) g.outerHTML = COPY_SVG;
      }, 1800)
    );
  }

  function ping(el) {
    if (!el) return;
    el.classList.remove("is-ping");
    void el.offsetWidth;
    el.classList.add("is-ping");
    setTimeout(() => el.classList.remove("is-ping"), 950);
  }

  function activateLink(link) {
    if (!link) return;
    const el = linkEls.get(link.id);
    ping(el);
    if (link.url) {
      try { window.open(link.url, "_blank", "noopener"); } catch (_) { /* попап заблокирован */ }
    } else if (link.copy != null) {
      doCopy(link, el);
    }
  }

  // ---------------------------------------------------------------- фон
  function setupBackground() {
    const v = $("#bg-video");
    if (!v) return;
    if (reduced) {
      try { v.removeAttribute("autoplay"); v.pause(); } catch (_) { /* нет видео — нет проблем */ }
      return;
    }
    const tryPlay = () => {
      // src ставит скрипт в index.html (не ставит при экономии трафика) — без него play() бессмысленен
      if (document.hidden || (!v.currentSrc && !v.getAttribute("src"))) return;
      try {
        const p = v.play();
        if (p && p.catch) p.catch(() => {});
      } catch (_) { /* autoplay запрещён — останется постер */ }
    };
    // некоторые мобильные браузеры не стартуют autoplay сами — дожимаем при входе
    window.addEventListener("sempik:enter", tryPlay, { once: true });
    // вкладка скрыта — видео на паузу (не декодируем кадры, которых никто не видит)
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) { try { v.pause(); } catch (_) { /* ок */ } }
      else if (v.paused) tryPlay();
    });
    // autoplay мог сработать, пока вкладка в фоне (src поставили по таймеру) — тоже на паузу
    v.addEventListener("play", () => { if (document.hidden) { try { v.pause(); } catch (_) { /* ок */ } } });
  }

  // ---------------------------------------------------------------- заставка
  function setupSplash() {
    const splash = $("#splash");
    if (!splash) {
      setTimeout(() => { try { onEnter?.(); } catch (e) { console.error("[sempik] onEnter", e); } }, 0);
      return;
    }
    // пока висит заставка, невидимая карточка не должна ловить Tab
    const hidden = [$(".ui"), $(".controls")].filter(Boolean);
    hidden.forEach((el) => { el.inert = true; });
    const hint = $(".splash__hint-text", splash);
    if (hint) hint.textContent = env.coarse ? "[ тапни, чтобы войти ]" : "[ нажми, чтобы войти ]";
    splash.classList.add("is-ready");

    // растущая «дырка» требует анимируемой CSS-переменной; без неё — просто растворяемся
    let canMask = false;
    try {
      if (window.CSS && CSS.registerProperty) {
        try {
          CSS.registerProperty({ name: "--r", syntax: "<length>", inherits: false, initialValue: "-120px" });
        } catch (_) { /* уже зарегистрировано */ }
        canMask = CSS.supports("mask-image", "radial-gradient(#000, transparent)") ||
          CSS.supports("-webkit-mask-image", "radial-gradient(#000, transparent)");
      }
    } catch (_) { canMask = false; }

    let done = false;
    function enter(x, y, viaKeyboard) {
      if (done) return;
      done = true;
      window.removeEventListener("keydown", onKey, true);
      // строго синхронно в обработчике жеста — иначе браузер не даст включить звук
      try { onEnter?.(); } catch (e) { console.error("[sempik] onEnter", e); }
      hidden.forEach((el) => { el.inert = false; });

      splash.style.setProperty("--x", `${Math.round(x)}px`);
      splash.style.setProperty("--y", `${Math.round(y)}px`);
      splash.setAttribute("aria-hidden", "true");
      if (reduced || !canMask) splash.classList.add("is-fading");
      else splash.classList.add("is-leaving");
      // вошли с клавиатуры — переводим фокус на первую ссылку, чтобы он не потерялся
      if (viaKeyboard) {
        setTimeout(() => {
          try { $(".link")?.focus({ preventScroll: true }); } catch (_) { /* не критично */ }
        }, 50);
      }
      setTimeout(() => splash.remove(), reduced ? 750 : 1150);
    }
    function onKey(e) {
      if (e.repeat) return;
      if (e.key === "Enter" || e.key === " " || e.code === "Space" || e.key === "Spacebar") {
        e.preventDefault();
        enter(innerWidth / 2, innerHeight / 2, true);
      }
    }
    splash.addEventListener("click", (e) => {
      const x = e.detail === 0 ? innerWidth / 2 : e.clientX;
      const y = e.detail === 0 ? innerHeight / 2 : e.clientY;
      enter(x, y, e.detail === 0);
    });
    window.addEventListener("keydown", onKey, true);
  }

  // ---------------------------------------------------------------- звук / музыка
  function setupControls() {
    const box = $(".controls");
    if (!box) return;
    if (!audio) { box.remove(); return; }
    box.hidden = false;
    const snd = $(".ctl--sound", box);
    const mus = $(".ctl--music", box);

    function syncSound() {
      const muted = !!audio.muted;
      snd?.setAttribute("aria-pressed", String(!muted));
      snd?.setAttribute("aria-label", muted ? "Включить звук" : "Выключить звук");
      if (snd) snd.dataset.tip = muted ? "звук выключен" : "звук включён";
      box.classList.toggle("is-muted", muted);
      syncMusic();
    }
    function syncMusic() {
      // при выключенном звуке музыку не слышно — кнопка показывает «выкл»
      const on = !!audio.musicPlaying && !audio.muted;
      mus?.setAttribute("aria-pressed", String(on));
      mus?.setAttribute("aria-label", on ? "Выключить музыку" : "Включить музыку");
      if (mus) mus.dataset.tip = on ? "музыка играет" : "музыка";
    }
    // после клика мышью снимаем фокус — иначе стрелки (Konami) зажгут на кнопке рамку фокуса
    const blurIfMouse = (e, b) => { if (e.detail > 0) { try { b.blur(); } catch (_) { /* ок */ } } };
    snd?.addEventListener("click", (e) => {
      blurIfMouse(e, snd);
      const next = !audio.muted;
      call(audio, "setMuted", next);
      if (!next) call(audio, "pop");
      syncSound();
    });
    mus?.addEventListener("click", (e) => {
      blurIfMouse(e, mus);
      if (audio.muted) {
        // звук выключен — кнопка музыки значит «хочу слышать музыку»: включаем звук (и музыку, если не играла)
        call(audio, "setMuted", false);
        if (!audio.musicPlaying) call(audio, "musicOn");
      } else if (audio.musicPlaying) call(audio, "musicOff");
      else call(audio, "musicOn");
      syncMusic();
      syncSound();
    });
    [snd, mus].forEach((b) =>
      b?.addEventListener("pointerenter", (e) => { if (e.pointerType === "mouse") call(audio, "tick"); })
    );
    window.addEventListener("sempik:mute", syncSound);
    window.addEventListener("sempik:enter", () => { syncSound(); });
    syncSound();
  }

  // ---------------------------------------------------------------- печатная машинка
  function setupTypewriter() {
    const wrap = $(".tagline");
    const out = $(".tagline__text", wrap || undefined);
    const sr = $(".tagline__sr", wrap || undefined);
    const lines = (Array.isArray(config.taglines) ? config.taglines : []).filter(Boolean).map(String);
    if (!wrap || !out) return;
    if (!lines.length) { wrap.remove(); return; }
    out.textContent = lines[0];
    if (sr) sr.textContent = lines[0];
    // «призрак» держит высоту под самую длинную фразу — карточка не прыгает при переносах
    const ghost = $(".tagline__ghost-text", wrap);
    if (ghost) ghost.textContent = lines.reduce((a, b) => (Array.from(b).length > Array.from(a).length ? b : a), "");
    if (reduced) return;

    // один текстовый узел, меняем только его data — без пересоздания узлов на каждую букву
    const node = document.createTextNode("");
    out.textContent = "";
    out.appendChild(node);
    let li = 0;
    let chars = Array.from(lines[0]);
    let n = 0;
    let deleting = false;
    let timer = 0;
    // карточка уехала за экран (телефон) — не печатаем впустую
    let onScreen = true;
    if (typeof IntersectionObserver === "function") {
      new IntersectionObserver((es) => { onScreen = es[es.length - 1].isIntersecting; }).observe(wrap);
    }

    function step() {
      if (document.hidden || !onScreen) { timer = setTimeout(step, 400); return; }
      if (!deleting) {
        n++;
        node.data = chars.slice(0, n).join("");
        wrap.classList.add("is-typing");
        if (n >= chars.length) {
          wrap.classList.remove("is-typing");
          if (lines.length < 2) return; // одна строка — печатаем и оставляем
          deleting = true;
          timer = setTimeout(step, 2600);
          return;
        }
        const ch = chars[n - 1];
        const extra = /[,.!?…]/.test(ch) ? 220 : ch === " " ? 40 : 0;
        timer = setTimeout(step, 34 + Math.random() * 52 + extra);
      } else {
        n--;
        node.data = chars.slice(0, n).join("");
        wrap.classList.add("is-typing");
        if (n <= 0) {
          wrap.classList.remove("is-typing");
          deleting = false;
          li = (li + 1) % lines.length;
          chars = Array.from(lines[li]);
          timer = setTimeout(step, 480);
          return;
        }
        timer = setTimeout(step, 16 + Math.random() * 18);
      }
    }
    const start = () => { clearTimeout(timer); timer = setTimeout(step, 1250); };
    if (root.classList.contains("entered")) start();
    else window.addEventListener("sempik:enter", start, { once: true });
  }

  // ---------------------------------------------------------------- GitHub
  function setupGitHub() {
    const box = $(".gh");
    const user = config.github?.user;
    if (!box || !user || typeof fetch !== "function") { box?.remove(); return; }
    // localStorage (а не sessionStorage): у GitHub API без токена 60 запросов в час на IP —
    // кэшируем на 6 часов, а неудачу — на 15 минут, чтобы не долбить API при каждом открытии
    const key = `sempik:gh:${user}`;
    const failKey = `sempik:gh-fail:${user}`;
    const TTL = 6 * 60 * 60 * 1000;
    const FAIL_TTL = 15 * 60 * 1000;
    const store = {
      get(k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (_) { return null; } },
      set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* приватный режим */ } },
    };

    const cached = store.get(key);
    if (cached && cached.u && Date.now() - cached.t < TTL) { render(cached); return; }
    const failed = store.get(failKey);
    if (failed && Date.now() - failed.t < FAIL_TTL) {
      // API недавно не ответил — показываем старые данные, если есть, иначе молча прячем блок
      if (cached && cached.u) render(cached); else box.remove();
      return;
    }

    const ctrl = typeof AbortController === "function" ? new AbortController() : null;
    const to = setTimeout(() => ctrl?.abort(), 25000);
    const opts = { signal: ctrl?.signal, headers: { Accept: "application/vnd.github+json" } };
    const base = `https://api.github.com/users/${encodeURIComponent(user)}`;
    const json = (r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status))));

    Promise.all([
      fetch(base, opts).then(json),
      fetch(`${base}/repos?sort=pushed&per_page=3`, opts).then(json).catch(() => []),
    ])
      .then(([u, repos]) => {
        if (!u || typeof u !== "object") throw new Error("bad user");
        const data = {
          t: Date.now(),
          u: {
            repos: Number.isFinite(u.public_repos) ? u.public_repos : null,
            followers: Number.isFinite(u.followers) ? u.followers : null,
            since: u.created_at || null,
            url: u.html_url || `https://github.com/${user}`,
          },
          r: (Array.isArray(repos) ? repos : [])
            .filter((x) => x && x.name && x.html_url)
            .slice(0, 3)
            .map((x) => ({ name: String(x.name), url: String(x.html_url) })),
        };
        store.set(key, data);
        // ответ пришёл, когда человек уже читает карточку: на десктопе она отцентрована по вертикали,
        // и новый блок сдвинул бы её (вместе с котом) — показываем в следующий раз, из кэша
        if (root.classList.contains("entered") && innerWidth >= 900) { box.remove(); return; }
        render(data);
      })
      .catch(() => {
        store.set(failKey, { t: Date.now() });
        if (cached && cached.u && !root.classList.contains("entered")) render(cached);
        else box.remove();
      })
      .finally(() => clearTimeout(to));

    function render(data) {
      try {
        const stats = $(".gh__stats", box);
        const items = [];
        const { repos, followers, since } = data.u;
        if (repos != null) items.push(`<b>${repos}</b> репо`);
        if (followers != null) {
          items.push(`<b>${followers}</b> ${plural(followers, ["подписчик", "подписчика", "подписчиков"])}`);
        }
        const year = since ? new Date(since).getFullYear() : NaN;
        if (Number.isFinite(year)) items.push(`с <b>${year}</b>`);
        if (!items.length) { box.remove(); return; }
        if (stats) stats.innerHTML = items.join('<i aria-hidden="true">·</i>');

        const recent = $(".gh__recent", box);
        const list = $(".gh__repos", box);
        if (data.r && data.r.length && recent && list) {
          list.textContent = "";
          data.r.forEach((r) => {
            const li = document.createElement("li");
            const a = document.createElement("a");
            a.className = "gh__repo";
            a.href = r.url;
            a.target = "_blank";
            a.rel = "noopener";
            a.innerHTML = `${SVG_REPO}<span></span>`;
            a.lastChild.textContent = r.name;
            a.setAttribute("aria-label", `репозиторий ${r.name} на GitHub`);
            a.addEventListener("pointerenter", (e) => { if (e.pointerType === "mouse") call(audio, "tick"); });
            li.appendChild(a);
            list.appendChild(li);
          });
          recent.hidden = false;
        }
        box.hidden = false;
        void box.offsetHeight;
        raf(() => box.classList.add("is-ready"));
      } catch (_) {
        box.remove();
      }
    }
  }

  // ---------------------------------------------------------------- наклон карточки
  function setupTilt() {
    // Раньше карточка наклонялась в 3D за курсором, но Chrome при этом рисует её как текстуру
    // и весь текст «мылится». Теперь карточка стоит ровно (текст всегда чёткий, коту не трясёт
    // платформу), а за курсором бегает только мягкий блик + подсвечивается рамка.
    if (!card || !motion) return;
    const glare = document.createElement("span");
    $(".card__glare", card)?.appendChild(glare);
    let gx = 0, gy = 0, cgx = 0, cgy = 0;
    let rect = null;
    let rafId = 0;
    let last = 0;

    function frame(t) {
      rafId = 0;
      // сглаживание по времени, а не по кадрам: на 144 Гц блик не носится вдвое быстрее
      const k = ease(0.18, t - (last || t - 16.7));
      last = t;
      cgx += (gx - cgx) * k;
      cgy += (gy - cgy) * k;
      glare.style.transform = `translate3d(${cgx.toFixed(1)}px, ${cgy.toFixed(1)}px, 0)`;
      if (Math.abs(gx - cgx) > 0.5 || Math.abs(gy - cgy) > 0.5) rafId = raf(frame);
      else last = 0;
    }
    const kick = () => { if (!rafId && !document.hidden) rafId = raf(frame); };

    card.addEventListener("pointerenter", (e) => {
      if (e.pointerType !== "mouse") return;
      rect = null;
      card.classList.add("is-hover");
    });
    card.addEventListener("pointermove", (e) => {
      if (e.pointerType !== "mouse") return;
      if (!rect) rect = card.getBoundingClientRect();
      gx = clamp(e.clientX - rect.left, 0, rect.width);
      gy = clamp(e.clientY - rect.top, 0, rect.height);
      if (!card.classList.contains("is-hover")) card.classList.add("is-hover");
      kick();
    });
    card.addEventListener("pointerleave", () => {
      rect = null;
      card.classList.remove("is-hover");
    });
    window.addEventListener("resize", () => { rect = null; }, { passive: true });
    window.addEventListener("scroll", () => { rect = null; }, { passive: true });
  }

  // ---------------------------------------------------------------- курсор + лепестки
  function setupCursor() {
    if (!motion) return;
    const glow = document.createElement("div");
    glow.className = "cursor-glow";
    glow.setAttribute("aria-hidden", "true");
    document.body.appendChild(glow);
    const pool = [];
    for (let i = 0; i < 14; i++) {
      const p = document.createElement("i");
      p.className = "trail-petal";
      p.setAttribute("aria-hidden", "true");
      document.body.appendChild(p);
      pool.push({ el: p, busy: false });
    }
    const canAnimate = typeof glow.animate === "function";

    let x = -100, y = -100, gx = -100, gy = -100, s = 1, ts = 1;
    let lastX = null, lastY = null, travel = 0, lastSpawn = 0;
    let visible = false;
    // над карточкой светлячок и лепестки не нужны — они мажут стекло и текст
    let overCard = false;
    let rafId = 0;
    let last = 0;

    // только transform в rAF: pointermove лишь запоминает координаты
    function frame(t) {
      rafId = 0;
      const dt = t - (last || t - 16.7);
      last = t;
      const kp = ease(0.22, dt);
      gx += (x - gx) * kp;
      gy += (y - gy) * kp;
      s += (ts - s) * ease(0.16, dt);
      glow.style.transform = `translate3d(${gx.toFixed(1)}px, ${gy.toFixed(1)}px, 0) scale(${s.toFixed(3)})`;
      if (Math.abs(x - gx) > 0.3 || Math.abs(y - gy) > 0.3 || Math.abs(ts - s) > 0.005) rafId = raf(frame);
      else last = 0;
    }
    const kick = () => { if (!rafId && !document.hidden) rafId = raf(frame); };

    function spawn(px, py, vx, vy) {
      if (!canAnimate || root.classList.contains("lite")) return;
      const p = pool.find((q) => !q.busy);
      if (!p) return;
      p.busy = true;
      const sc = 0.65 + Math.random() * 0.75;
      const r0 = Math.random() * 360;
      const r1 = r0 + (Math.random() < 0.5 ? -1 : 1) * (140 + Math.random() * 220);
      const dx = -vx * 0.25 + (Math.random() - 0.5) * 50;
      const dy = 50 + Math.random() * 60 - vy * 0.1;
      try {
        const a = p.el.animate(
          [
            { transform: `translate3d(${px}px, ${py}px, 0) rotate(${r0}deg) scale(${sc})`, opacity: 0 },
            { opacity: 0.95, offset: 0.12 },
            { transform: `translate3d(${px + dx}px, ${py + dy}px, 0) rotate(${r1}deg) scale(${sc * 0.55})`, opacity: 0 },
          ],
          { duration: 1100 + Math.random() * 700, easing: "cubic-bezier(.22,.6,.35,1)" }
        );
        a.onfinish = a.oncancel = () => { p.busy = false; };
      } catch (_) {
        p.busy = false;
      }
    }

    window.addEventListener("pointermove", (e) => {
      if (e.pointerType !== "mouse") return;
      x = e.clientX;
      y = e.clientY;
      if (!visible) {
        visible = true;
        gx = x; gy = y;
        glow.classList.add("is-on");
      }
      if (lastX != null) {
        const dx = x - lastX;
        const dy = y - lastY;
        travel += Math.hypot(dx, dy);
        const t = performance.now();
        if (travel > 90 && t - lastSpawn > 80) {
          travel = 0;
          lastSpawn = t;
          if (!overCard && Math.random() < 0.6) spawn(x, y, dx, dy);
        }
      }
      lastX = x;
      lastY = y;
      kick();
    }, { passive: true });

    document.addEventListener("pointerover", (e) => {
      const t = e.target;
      ts = t && t.closest && t.closest("a, button, [role='button'], .avatar") ? 1.9 : 1;
      const oc = !!(t && t.closest && t.closest(".card"));
      if (oc !== overCard) { overCard = oc; glow.classList.toggle("is-dim", oc); }
      kick();
    }, { passive: true });
    document.addEventListener("pointerdown", () => { ts = Math.max(0.7, ts * 0.7); kick(); }, { passive: true });
    document.addEventListener("pointerup", (e) => {
      const t = e.target;
      ts = t && t.closest && t.closest("a, button, [role='button'], .avatar") ? 1.9 : 1;
      kick();
    }, { passive: true });
    root.addEventListener("mouseleave", () => {
      visible = false;
      lastX = lastY = null;
      glow.classList.remove("is-on");
    });
    window.addEventListener("blur", () => {
      visible = false;
      lastX = lastY = null;
      glow.classList.remove("is-on");
    });
  }

  // ---------------------------------------------------------------- вечеринка
  function setupParty() {
    let on = false;
    function setParty(next) {
      on = !!next;
      root.classList.toggle("party", on);
      try { window.dispatchEvent(new CustomEvent("sempik:party", { detail: { on } })); } catch (_) { /* старый браузер */ }
      toast(on ? "🎉 режим вечеринки" : "вечеринка окончена 😴", "party");
      call(audio, "chime");
    }

    const SEQ = ["ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight", "KeyB", "KeyA"];
    const buf = [];
    window.addEventListener("keydown", (e) => {
      const t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      let code = e.code;
      if (!code) {
        const k = String(e.key || "").toLowerCase();
        code = k === "b" || k === "и" ? "KeyB" : k === "a" || k === "ф" ? "KeyA" : e.key;
      }
      buf.push(code);
      if (buf.length > SEQ.length) buf.shift();
      if (buf.length === SEQ.length && buf.every((c, i) => c === SEQ[i])) {
        buf.length = 0;
        setParty(!on);
      }
    });

    // для телефонов: 5 быстрых тапов по аватарке
    const av = $(".avatar");
    if (av) {
      let taps = [];
      // с клавиатуры: Enter/Space = клик
      av.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " " || e.code === "Space") { e.preventDefault(); av.click(); }
      });
      av.addEventListener("click", () => {
        const t = performance.now();
        taps = taps.filter((x) => t - x < 1800);
        taps.push(t);
        if (!reduced) {
          av.classList.remove("is-boop");
          void av.offsetWidth;
          av.classList.add("is-boop");
        }
        if (taps.length >= 5) {
          taps = [];
          setParty(!on);
        } else {
          call(audio, "pop");
        }
      });
      av.addEventListener("animationend", () => av.classList.remove("is-boop"));
    }
  }

  // ---------------------------------------------------------------- облегчённый режим
  // Через пару секунд после входа меряем частоту кадров (≈2 с). Если меньше ~40 к/с — железо
  // не тянет: ставим html.lite (CSS гасит бесконечные декоративные анимации, курсор без лепестков,
  // кнопки без «магнита») и шлём событие sempik:lite для остальных модулей. Обратно не снимаем.
  function setupLite() {
    let tries = 0;
    let timer = 0;
    // счётчик смен видимости: пока вкладка скрыта, rAF стоит, и первый кадр после возврата
    // выглядел бы как «кадр длиной в минуту» — такой замер выбрасываем и начинаем заново
    let visGen = 0;
    document.addEventListener("visibilitychange", () => { visGen++; });
    const later = (ms) => { clearTimeout(timer); timer = setTimeout(probe, ms); };
    function probe() {
      if (root.classList.contains("lite")) return;
      if (document.hidden) { later(3000); return; }
      const gen = visGen;
      const dts = [];
      let sum = 0;
      let last = 0;
      const f = (t) => {
        if (document.hidden || gen !== visGen) { later(3000); return; }
        if (last) { const dt = t - last; dts.push(dt); sum += dt; }
        last = t;
        if (sum < 2000) { raf(f); return; }
        // медиана, а не среднее: разовая заминка (компиляция шейдеров, догрузка 3D) не должна
        // навсегда выключать красоту на нормальном железе
        dts.sort((a, b) => a - b);
        const med = dts[dts.length >> 1] || 1000;
        const fps = 1000 / med;
        if (fps < 40) {
          root.classList.add("lite");
          try { window.dispatchEvent(new CustomEvent("sempik:lite", { detail: { fps } })); } catch (_) { /* старый браузер */ }
        } else if (++tries < 3) later(12000);
      };
      raf(f);
    }
    const start = () => later(2600);
    if (root.classList.contains("entered")) start();
    else window.addEventListener("sempik:enter", start, { once: true });
  }

  // ---------------------------------------------------------------- прокрутка (для затемнения под кнопками)
  function setupScrolled() {
    let on = null;
    const check = () => {
      const next = (window.scrollY || 0) > 24;
      if (next !== on) { on = next; root.classList.toggle("is-scrolled", next); }
    };
    window.addEventListener("scroll", check, { passive: true });
    check();
  }

  // ---------------------------------------------------------------- заголовок вкладки
  function setupTitle() {
    const base = document.title || "sempik";
    const away = "мяу? вернись 🐾";
    document.addEventListener("visibilitychange", () => {
      document.title = document.hidden ? away : base;
    });
    window.addEventListener("focus", () => { document.title = base; });
  }

  return { toast, activateLink };
}
