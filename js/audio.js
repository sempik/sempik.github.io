// Звук сайта. Всё синтезируется Web Audio API на лету — ни одного аудиофайла.
//
// createAudio({ config, env }) → {
//   unlock()                 — вызвать внутри жеста пользователя (создаёт/будит AudioContext)
//   meow(kind)               — 'short' | 'happy' | 'angry' | 'question'
//   startPurr() / stopPurr() — мурчание (идемпотентно)
//   pop() tick() chime() thud()
//   setMuted(bool), get muted         — плавный фейд, localStorage 'sempik:muted', событие 'sempik:mute'
//   musicOn() musicOff(), get musicPlaying — генеративный эмбиент (по умолчанию выключен)
// }
// Любой метод безопасен до unlock() и при выключенном звуке: просто ничего не делает и никогда не бросает.
//
// Внутри каждый звук — функция (rig, when, ...) → строит граф в rig.ctx начиная с момента `when`.
// Это позволяет рендерить те же самые звуки в OfflineAudioContext для тестов (см. __synth внизу).

const MUTE_KEY = "sempik:muted";
const TAU = Math.PI * 2;
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

// ---------------------------------------------------------------- уровни микса
const LEVEL = {
  meow: 0.3,
  purr: 0.95,
  pop: 0.34,
  tick: 0.05,
  chime: 0.085,
  thud: 0.8,
  music: 0.52,
};

// ---------------------------------------------------------------- утилиты графа

// Плавная кривая по опорным точкам [[x 0..1, y], ...] (косинусная интерполяция) → Float32Array
function curve(points, n = 96, map) {
  const out = new Float32Array(n);
  let k = 0;
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1);
    while (k < points.length - 2 && x > points[k + 1][0]) k++;
    const [x0, y0] = points[k];
    const [x1, y1] = points[Math.min(k + 1, points.length - 1)];
    const t = x1 > x0 ? clamp((x - x0) / (x1 - x0), 0, 1) : 1;
    const s = (1 - Math.cos(Math.PI * t)) / 2;
    const y = y0 + (y1 - y0) * s;
    out[i] = map ? map(y, i) : y;
  }
  return out;
}

// чуть сдвигает внутренние опорные точки по времени — чтобы мяу никогда не звучало одинаково
function jitter(points, amt) {
  const p = points.map((q) => q.slice());
  for (let i = 1; i < p.length - 1; i++) {
    p[i][0] = clamp(p[i][0] + rand(-amt, amt), p[i - 1][0] + 0.02, p[i + 1][0] - 0.02);
  }
  return p;
}

function disconnectAll(nodes) {
  for (const n of nodes) {
    try { n.disconnect(); } catch (_) { /* уже отключён */ }
  }
}

// Учёт голосов: по окончании `src` отключаем все узлы голоса (иначе граф копится и течёт память)
function track(rig, src, nodes, extra) {
  rig.active++;
  src.onended = () => {
    src.onended = null;
    rig.active = Math.max(0, rig.active - 1);
    disconnectAll(nodes);
    if (extra) {
      try { extra(); } catch (_) { /* ignore */ }
    }
  };
}

function makeKit(ctx, nodes) {
  const add = (n) => (nodes.push(n), n);
  return {
    gain(v) {
      const g = add(ctx.createGain());
      if (v !== undefined) g.gain.value = v;
      return g;
    },
    osc(type, f) {
      const o = add(ctx.createOscillator());
      if (typeof type === "string") o.type = type;
      else if (type) o.setPeriodicWave(type);
      if (f !== undefined) o.frequency.value = f;
      return o;
    },
    filter(type, f, q) {
      const b = add(ctx.createBiquadFilter());
      b.type = type;
      if (f !== undefined) b.frequency.value = f;
      if (q !== undefined) b.Q.value = q;
      return b;
    },
    pan(p) {
      if (ctx.createStereoPanner) {
        const n = add(ctx.createStereoPanner());
        n.pan.value = clamp(p, -1, 1);
        return n;
      }
      return add(ctx.createGain());
    },
    noise(rig, loop = true) {
      const s = add(ctx.createBufferSource());
      s.buffer = rig.noise;
      s.loop = loop;
      return s;
    },
    add,
  };
}

// периодическая волна из произвольной формы shape(phase 0..1); DC возвращается отдельно (mean),
// потому что PeriodicWave игнорирует нулевую гармонику
function waveFromShape(ctx, shape, H) {
  const M = 1024;
  const s = new Float32Array(M);
  let mean = 0;
  for (let k = 0; k < M; k++) { s[k] = shape(k / M); mean += s[k]; }
  mean /= M;
  const real = new Float32Array(H + 1);
  const imag = new Float32Array(H + 1);
  for (let n = 1; n <= H; n++) {
    let a = 0, b = 0;
    for (let k = 0; k < M; k++) {
      const ph = (TAU * n * k) / M;
      a += s[k] * Math.cos(ph);
      b += s[k] * Math.sin(ph);
    }
    real[n] = (2 * a) / M;
    imag[n] = (2 * b) / M;
  }
  let wave;
  try { wave = ctx.createPeriodicWave(real, imag, { disableNormalization: true }); }
  catch (_) { wave = ctx.createPeriodicWave(real, imag); }
  return { wave, mean };
}

// «голосовой» источник для кота: смесь пилы и узкого импульса (богатый, чуть носовой спектр)
function voiceWave(ctx) {
  const H = 48;
  const real = new Float32Array(H + 1);
  const imag = new Float32Array(H + 1);
  const duty = 0.3;
  for (let n = 1; n <= H; n++) {
    imag[n] = 0.8 / Math.pow(n, 0.95); // пила
    real[n] = (0.7 * Math.sin(Math.PI * n * duty)) / n; // импульс 30%
  }
  return ctx.createPeriodicWave(real, imag);
}

function makeNoise(ctx, seconds) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

// Алгоритмическая реверберация: стерео-шум с экспоненциальным спадом (~2.5 c), хвост темнеет со временем
function makeImpulse(ctx, seconds = 2.5) {
  const sr = ctx.sampleRate;
  const len = Math.max(2, Math.floor(sr * seconds));
  const buf = ctx.createBuffer(2, len, sr);
  const pre = Math.floor(sr * 0.012);
  const t60 = seconds * 0.95;
  const fadeLen = sr * 0.12;
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let lp = 0;
    for (let i = pre; i < len; i++) {
      const t = (i - pre) / sr;
      const k = 0.9 - 0.72 * Math.min(1, t / seconds); // коэффициент one-pole LP: светлое начало → тёмный хвост
      lp += k * (Math.random() * 2 - 1 - lp);
      let env = Math.exp((-6.9 * t) / t60) * Math.sqrt((2 - k) / k);
      if (t < 0.025) env *= 0.35 + (0.65 * t) / 0.025; // мягкая атака
      const left = len - i;
      if (left < fadeLen) env *= left / fadeLen;
      d[i] = lp * env;
    }
  }
  return buf;
}

const driveCache = new Map();
function driveCurve(k) {
  if (driveCache.has(k)) return driveCache.get(k);
  const n = 1024;
  const c = new Float32Array(n);
  const norm = Math.tanh(k);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(k * x) / norm;
  }
  driveCache.set(k, c);
  return c;
}

// ---------------------------------------------------------------- «риг»: общий граф на один контекст
// голоса → sfx ┐
// музыка ──────┼→ mix → compressor → out(mute) → destination
// reverb send → verbIn → HP → convolver → LP ┘
function buildRig(ctx, destination) {
  const dest = destination || ctx.destination;
  const out = ctx.createGain();
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -12;
  comp.knee.value = 12;
  comp.ratio.value = 2.5;
  comp.attack.value = 0.004;
  comp.release.value = 0.25;
  const mix = ctx.createGain();
  mix.gain.value = 0.7;
  mix.connect(comp);
  comp.connect(out);
  out.connect(dest);

  const sfx = ctx.createGain();
  sfx.connect(mix);

  const verbIn = ctx.createGain();
  const verbHP = ctx.createBiquadFilter();
  verbHP.type = "highpass";
  verbHP.frequency.value = 220;
  const verb = ctx.createConvolver();
  verb.normalize = true;
  verb.buffer = makeImpulse(ctx, 2.5);
  const verbLP = ctx.createBiquadFilter();
  verbLP.type = "lowpass";
  verbLP.frequency.value = 6500;
  const verbOut = ctx.createGain();
  verbOut.gain.value = 0.8;
  verbIn.connect(verbHP);
  verbHP.connect(verb);
  verb.connect(verbLP);
  verbLP.connect(verbOut);
  verbOut.connect(mix);

  const bump = (p, a, b) => (p > a && p < b ? Math.pow(Math.sin((Math.PI * (p - a)) / (b - a)), 0.6) : 0);
  return {
    ctx,
    out,
    mix,
    sfx,
    verbIn,
    noise: makeNoise(ctx, 4),
    waves: {
      voice: voiceWave(ctx),
      // один «удар» мурчания: резкий подъём, мягкий спад, тишина
      purrPulse: waveFromShape(ctx, (p) => (p < 0.6 ? Math.pow(Math.sin((Math.PI * p) / 0.6), 1.6) : 0), 32),
      // дыхание: выдох (громче) — пауза — вдох (тише) — пауза
      purrBreath: waveFromShape(ctx, (p) => 0.1 + 0.9 * bump(p, 0, 0.52) + 0.6 * bump(p, 0.58, 0.96), 24),
    },
    ks: new Map(),
    active: 0,
    meows: 0,
  };
}

// ---------------------------------------------------------------- МЯУ
// контуры: высота (Гц), «рот» (0 закрыт .. 1 открыт), «округление губ» (0..1 → «у/оу»), громкость
const MEOWS = {
  // «ми-яу»: подъём ~450→900 и спад к ~550
  short: {
    dur: [0.42, 0.5],
    pitch: [[0, 450], [0.12, 500], [0.4, 900], [0.68, 770], [1, 550]],
    mouth: [[0, 0], [0.12, 0.3], [0.4, 1], [0.7, 0.72], [1, 0.08]],
    round: [[0, 0.5], [0.16, 0.2], [0.45, 0], [0.74, 0.3], [1, 0.9]],
    amp: [[0, 0], [0.08, 0.5], [0.36, 1], [0.76, 0.72], [1, 0]],
    noise: 0.06, bright: 1, vib: 22, level: 1,
  },
  // «мррр-ЯУ!» — раскатистая трель в начале, светлее и выше
  happy: {
    dur: [0.52, 0.62],
    pitch: [[0, 640], [0.24, 700], [0.52, 1100], [0.78, 1020], [1, 880]],
    mouth: [[0, 0.22], [0.26, 0.4], [0.52, 1], [0.8, 0.85], [1, 0.25]],
    round: [[0, 0.35], [0.3, 0.2], [0.52, 0], [0.85, 0.1], [1, 0.45]],
    amp: [[0, 0], [0.05, 0.55], [0.26, 0.62], [0.5, 1], [0.82, 0.78], [1, 0]],
    am: { rate: 23, type: "triangle", depth: [[0, 0.95], [0.26, 0.85], [0.36, 0], [1, 0]] },
    noise: 0.035, bright: 1.1, vib: 28, level: 0.85,
  },
  // «мрроу?» — заканчивается подъёмом
  question: {
    dur: [0.52, 0.6],
    pitch: [[0, 480], [0.3, 780], [0.55, 640], [0.78, 720], [1, 1020]],
    mouth: [[0, 0.05], [0.3, 0.95], [0.55, 0.55], [0.84, 0.85], [1, 0.45]],
    round: [[0, 0.45], [0.3, 0], [0.55, 0.45], [0.8, 0.1], [1, 0.1]],
    amp: [[0, 0], [0.08, 0.6], [0.3, 1], [0.56, 0.72], [0.86, 0.92], [1, 0]],
    noise: 0.05, bright: 1.03, vib: 18, level: 1.1,
  },
  // «МРРАУ» — ниже, грубее, короче, с рычащей модуляцией
  angry: {
    dur: [0.34, 0.42],
    pitch: [[0, 300], [0.25, 470], [0.62, 430], [1, 320]],
    mouth: [[0, 0.3], [0.22, 1], [0.7, 0.9], [1, 0.3]],
    round: [[0, 0.2], [0.3, 0], [0.75, 0.15], [1, 0.6]],
    amp: [[0, 0], [0.05, 0.85], [0.3, 1], [0.8, 0.85], [1, 0]],
    am: { rate: 34, type: "sine", depth: [[0, 0.6], [1, 0.6]] },
    drive: 4, noise: 0.2, bright: 0.96, vib: 8, level: 1.25,
  },
};

function meowVoice(rig, when, kind) {
  const P = MEOWS[kind] || MEOWS.short;
  const ctx = rig.ctx;
  const nodes = [];
  const K = makeKit(ctx, nodes);
  const dur = rand(P.dur[0], P.dur[1]);
  const pk = rand(0.9, 1.12); // высота голоса именно этого мяу
  const fk = rand(0.95, 1.06) * P.bright; // форманты (размер «кошачьей головы»)
  const N = 96;
  const pitch = curve(jitter(P.pitch, 0.025), N, (y) => y * pk);
  const mouth = curve(jitter(P.mouth, 0.03), N);
  const round = curve(P.round, N);
  const amp = curve(P.amp, N, (y) => y * P.level * LEVEL.meow * rand(0.9, 1.05));
  const end = when + dur;

  // источник
  const osc = K.osc(rig.waves.voice);
  osc.frequency.setValueCurveAtTime(pitch, when, dur);
  const vib = K.osc("sine", rand(5.2, 6.8)); // вибрато, нарастает к концу
  const vibG = K.gain();
  vibG.gain.setValueCurveAtTime(curve([[0, 0], [0.3, 0.25], [1, 1]], 32, (y) => y * P.vib * rand(0.75, 1.3)), when, dur);
  vib.connect(vibG).connect(osc.detune);
  const jit = K.osc("triangle", rand(11, 15)); // микро-нестабильность голоса
  const jitG = K.gain(7);
  jit.connect(jitG).connect(osc.detune);

  const src = K.gain();
  if (P.drive) {
    const ws = K.add(ctx.createWaveShaper());
    ws.curve = driveCurve(P.drive);
    ws.oversample = "2x";
    const g = K.gain(0.75);
    const hp = K.filter("highpass", 140, 0.7); // убираем DC/инфранизы после перегруза
    osc.connect(ws).connect(hp).connect(g).connect(src);
  } else {
    osc.connect(src);
  }
  // придыхание
  const nz = K.noise(rig);
  const nzHP = K.filter("highpass", 900, 0.7);
  const nzG = K.gain(P.noise);
  nz.connect(nzHP).connect(nzG).connect(src);

  // трель / рычание (амплитудная модуляция)
  let pre = src;
  if (P.am) {
    const d = curve(P.am.depth, 48, (y) => y * 0.5);
    const am = K.gain();
    am.gain.setValueCurveAtTime(d.map((v) => 1 - v), when, dur);
    const lfo = K.osc(P.am.type, P.am.rate * rand(0.92, 1.08));
    const lg = K.gain();
    lg.gain.setValueCurveAtTime(d, when, dur);
    lfo.connect(lg).connect(am.gain);
    src.connect(am);
    pre = am;
  }

  // «рот»: закрытый — темнее; плюс подъём верхов, чтобы гармоники в формантах звучали «по-кошачьи»
  const shelf = K.filter("highshelf", 1300);
  shelf.gain.value = 9;
  const lp = K.filter("lowpass", undefined, 0.6);
  lp.frequency.setValueCurveAtTime(mouth.map((m) => 1400 + 4200 * m), when, dur);
  pre.connect(shelf).connect(lp);

  // форманты, которые двигаются вместе с ртом
  const sum = K.gain();
  const formant = (freq, q, gains) => {
    const bp = K.filter("bandpass", undefined, q);
    bp.frequency.setValueCurveAtTime(freq, when, dur);
    const g = K.gain();
    g.gain.setValueCurveAtTime(gains, when, dur);
    lp.connect(bp).connect(g).connect(sum);
  };
  formant(mouth.map((m, i) => (700 + 300 * m) * (1 - 0.22 * round[i]) * fk), 3.2, mouth.map((m) => 0.9 + 0.4 * m));
  formant(mouth.map((m, i) => (1800 + 800 * m) * (1 - 0.38 * round[i]) * fk), 5, mouth.map((m) => 0.9 + 1.2 * m));
  formant(mouth.map((m) => (3300 + 450 * m) * fk), 8, mouth.map((m) => 0.25 + 0.3 * m));
  // носовой «м» при закрытом рте
  const nasal = K.filter("lowpass", 650, 0.7);
  const nasalG = K.gain();
  nasalG.gain.setValueCurveAtTime(mouth.map((m) => 0.08 + 0.5 * (1 - m)), when, dur);
  pre.connect(nasal).connect(nasalG).connect(sum);

  const env = K.gain();
  env.gain.setValueCurveAtTime(amp, when, dur);
  const pan = K.pan(rand(-0.22, 0.22));
  sum.connect(env).connect(pan).connect(rig.sfx);
  const send = K.gain(0.14);
  pan.connect(send).connect(rig.verbIn);

  // все источники голоса (осцилляторы, LFO, шум) стартуют/останавливаются вместе
  const stopAt = end + 0.03;
  for (const n of nodes) {
    if (typeof n.start !== "function" || n === osc) continue;
    if (n === nz) n.start(when, rand(0, 3));
    else n.start(when);
    n.stop(stopAt);
  }
  osc.start(when);
  osc.stop(stopAt + 0.01); // osc заканчивается последним → по нему чистим граф
  rig.meows++;
  track(rig, osc, nodes, () => { rig.meows = Math.max(0, rig.meows - 1); });
  return dur;
}

// ---------------------------------------------------------------- МУРЧАНИЕ
// ~25–28 «ударов» в секунду (АМ шума и низкой пилы), дыхание вдох/выдох ≈ 1.6 c, всё под НЧ-фильтром
function purrVoice(rig, when) {
  const ctx = rig.ctx;
  const nodes = [];
  const K = makeKit(ctx, nodes);
  const R = rand(24.5, 28);
  const { purrPulse, purrBreath } = rig.waves;

  const out = K.gain(0);
  out.gain.setValueAtTime(0, when);
  out.gain.setTargetAtTime(LEVEL.purr, when, 0.16);

  const saw = K.osc("sawtooth", R * 3); // ~75–85 Гц, кратно частоте ударов
  const sawG = K.gain(0.32);
  const nz = K.noise(rig);
  const nzLP = K.filter("lowpass", 380, 0.7);
  const nzG = K.gain(1.0);
  const sum = K.gain();
  saw.connect(sawG).connect(sum);
  nz.connect(nzLP).connect(nzG).connect(sum);

  const lp = K.filter("lowpass", 300, 1.1);
  sum.connect(lp);
  const am = K.gain(purrPulse.mean); // DC + волна = форма удара 0..1
  lp.connect(am);
  const pulse = K.osc(purrPulse.wave, R);
  pulse.connect(am.gain);

  const breath = K.gain(purrBreath.mean);
  am.connect(breath).connect(out).connect(rig.sfx);
  const bOsc = K.osc(purrBreath.wave, 1 / rand(1.5, 1.72));
  bOsc.connect(breath.gain);
  // на выдохе мурчание чуть ярче и быстрее
  const bR = K.gain(1.1);
  const bR3 = K.gain(3.3);
  const bLP = K.gain(160);
  bOsc.connect(bR).connect(pulse.frequency);
  bOsc.connect(bR3).connect(saw.frequency);
  bOsc.connect(bLP).connect(lp.frequency);
  // дыхание не метрономное
  const wob = K.osc("sine", rand(0.07, 0.12));
  const wobG = K.gain(0.05);
  wob.connect(wobG).connect(bOsc.frequency);

  const srcs = [saw, nz, pulse, bOsc, wob];
  nz.start(when, rand(0, 3));
  for (const s of srcs) if (s !== nz) s.start(when);
  let stopped = false;
  track(rig, pulse, nodes);
  return {
    stop(at) {
      if (stopped) return;
      stopped = true;
      const t = Math.max(at, when);
      out.gain.cancelScheduledValues(t);
      out.gain.setTargetAtTime(0, t, 0.12);
      for (const s of srcs) {
        try { s.stop(t + 0.9); } catch (_) { /* ignore */ }
      }
    },
  };
}

// ---------------------------------------------------------------- UI-звуки

// мягкий «пузырьковый» поп: синус с быстрым подъёмом высоты
function popVoice(rig, when) {
  const ctx = rig.ctx;
  const nodes = [];
  const K = makeKit(ctx, nodes);
  const f = rand(330, 450);
  const o = K.osc("sine");
  o.frequency.setValueAtTime(f, when);
  o.frequency.exponentialRampToValueAtTime(f * rand(2.2, 2.7), when + 0.07);
  const g = K.gain(0);
  g.gain.setValueAtTime(0, when);
  g.gain.linearRampToValueAtTime(LEVEL.pop, when + 0.004);
  g.gain.setTargetAtTime(0, when + 0.025, 0.026);
  const o2 = K.osc("sine");
  o2.frequency.setValueAtTime(f * 1.5, when);
  o2.frequency.exponentialRampToValueAtTime(f * 4.2, when + 0.05);
  const g2 = K.gain(0);
  g2.gain.setValueAtTime(0, when);
  g2.gain.linearRampToValueAtTime(LEVEL.pop * 0.22, when + 0.003);
  g2.gain.setTargetAtTime(0, when + 0.01, 0.014);
  const nz = K.noise(rig);
  const bp = K.filter("bandpass", 2600, 0.9);
  const gn = K.gain(0);
  gn.gain.setValueAtTime(LEVEL.pop * 0.18, when);
  gn.gain.setTargetAtTime(0, when + 0.001, 0.004);
  const pan = K.pan(rand(-0.2, 0.2));
  o.connect(g).connect(pan);
  o2.connect(g2).connect(pan);
  nz.connect(bp).connect(gn).connect(pan);
  pan.connect(rig.sfx);
  const send = K.gain(0.08);
  pan.connect(send).connect(rig.verbIn);
  o.start(when); o2.start(when); nz.start(when, rand(0, 3));
  o2.stop(when + 0.25); nz.stop(when + 0.06); o.stop(when + 0.3);
  track(rig, o, nodes);
}

// едва слышный тик на ховер
function tickVoice(rig, when) {
  const ctx = rig.ctx;
  const nodes = [];
  const K = makeKit(ctx, nodes);
  const o = K.osc("sine", rand(2900, 3400));
  const g = K.gain(0);
  g.gain.setValueAtTime(0, when);
  g.gain.linearRampToValueAtTime(LEVEL.tick, when + 0.0015);
  g.gain.setTargetAtTime(0, when + 0.002, 0.006);
  const nz = K.noise(rig);
  const hp = K.filter("highpass", 4000, 0.7);
  const gn = K.gain(0);
  gn.gain.setValueAtTime(LEVEL.tick * 0.35, when);
  gn.gain.setTargetAtTime(0, when + 0.001, 0.003);
  const pan = K.pan(rand(-0.15, 0.15));
  o.connect(g).connect(pan);
  nz.connect(hp).connect(gn).connect(pan);
  pan.connect(rig.sfx);
  o.start(when); nz.start(when, rand(0, 3));
  nz.stop(when + 0.03); o.stop(when + 0.07);
  track(rig, o, nodes);
}

// китайские колокольчики: пентатоника + негармонические обертоны трубки + много реверба
const CHIME_NOTES = [86, 88, 91, 93, 95, 98, 100]; // D6 E6 G6 A6 B6 D7 E7 (та же пентатоника, что и в музыке)
function chimeBar(rig, t, f, v, p) {
  const ctx = rig.ctx;
  const nodes = [];
  const K = makeKit(ctx, nodes);
  const pan = K.pan(p);
  const send = K.gain(0.5);
  pan.connect(rig.sfx);
  pan.connect(send).connect(rig.verbIn);
  let last = null;
  // [отношение частот свободной трубки, амплитуда, время спада]
  for (const [ratio, a, tau] of [[1, 1, 0.55], [2.756, 0.3, 0.22], [5.404, 0.1, 0.08]]) {
    const o = K.osc(ratio === 1 ? "sine" : "sine", f * ratio * rand(0.998, 1.002));
    const g = K.gain(0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(v * a, t + 0.0025);
    g.gain.setTargetAtTime(0, t + 0.0025, tau);
    o.connect(g).connect(pan);
    o.start(t);
    o.stop(t + tau * 8 + 0.05);
    if (ratio === 1) last = o;
  }
  track(rig, last, nodes);
}
function chimeVoice(rig, when) {
  const n = CHIME_NOTES.length;
  const count = 4 + Math.floor(rand(0, 3));
  const up = Math.random() < 0.72;
  let i = up ? Math.floor(rand(0, 3)) : n - 1 - Math.floor(rand(0, 2));
  let t = when;
  for (let k = 0; k < count; k++) {
    chimeBar(rig, t, mtof(CHIME_NOTES[i]), LEVEL.chime * (1 - k * 0.07) * rand(0.85, 1.1), rand(-0.45, 0.45));
    t += rand(0.055, 0.1);
    const step = (up ? 1 : -1) * (Math.random() < 0.25 ? 2 : 1);
    i += step;
    if (i >= n) i = n - 2 - Math.floor(rand(0, 2));
    if (i < 0) i = 1 + Math.floor(rand(0, 2));
  }
  // лёгкий «шшш» блеска сверху
  const ctx = rig.ctx;
  const nodes = [];
  const K = makeKit(ctx, nodes);
  const nz = K.noise(rig);
  const bp = K.filter("bandpass", 8500, 1.4);
  const g = K.gain(0);
  g.gain.setValueAtTime(0, when);
  g.gain.linearRampToValueAtTime(LEVEL.chime * 0.12, when + 0.12);
  g.gain.linearRampToValueAtTime(0, when + 0.45);
  nz.connect(bp).connect(g).connect(rig.verbIn);
  nz.start(when, rand(0, 3));
  nz.stop(when + 0.5);
  track(rig, nz, nodes);
}

// мягкое мультяшное приземление: «бум» с падением высоты + «пуф» воздуха
function thudVoice(rig, when) {
  const ctx = rig.ctx;
  const nodes = [];
  const K = makeKit(ctx, nodes);
  const r = rand(0.9, 1.12);
  const sum = K.gain();
  const lp = K.filter("lowpass", 1800, 0.7);
  sum.connect(lp).connect(rig.sfx);
  const send = K.gain(0.05);
  lp.connect(send).connect(rig.verbIn);

  const o = K.osc("sine");
  o.frequency.setValueAtTime(150 * r, when);
  o.frequency.exponentialRampToValueAtTime(48 * r, when + 0.16);
  const g = K.gain(0);
  g.gain.setValueAtTime(0, when);
  g.gain.linearRampToValueAtTime(LEVEL.thud, when + 0.006);
  g.gain.setTargetAtTime(0, when + 0.006, 0.075);
  o.connect(g).connect(sum);

  const b = K.osc("triangle"); // «тело» удара — слышно и на телефонных динамиках
  b.frequency.setValueAtTime(260 * r, when);
  b.frequency.exponentialRampToValueAtTime(115 * r, when + 0.08);
  const g2 = K.gain(0);
  g2.gain.setValueAtTime(0, when);
  g2.gain.linearRampToValueAtTime(LEVEL.thud * 0.3, when + 0.004);
  g2.gain.setTargetAtTime(0, when + 0.004, 0.035);
  b.connect(g2).connect(sum);

  const nz = K.noise(rig);
  const nlp = K.filter("lowpass", 700, 0.7);
  const g3 = K.gain(0);
  g3.gain.setValueAtTime(0, when);
  g3.gain.linearRampToValueAtTime(LEVEL.thud * 0.42, when + 0.003);
  g3.gain.setTargetAtTime(0, when + 0.003, 0.028);
  nz.connect(nlp).connect(g3).connect(sum);

  o.start(when); b.start(when); nz.start(when, rand(0, 3));
  b.stop(when + 0.3); nz.stop(when + 0.25); o.stop(when + 0.65);
  track(rig, o, nodes);
}

// ---------------------------------------------------------------- МУЗЫКА (генеративный эмбиент)
// Соль-мажорная пентатоника (= японский лад «ё» от ре): мягкие пэды IV–iii–vi–ii, щипковые «кото»
// (Карплус–Стронг), редкие колокольчики, едва слышный ветер и винил. Планировщик с упреждением по часам контекста.

const PENTA = [62, 64, 67, 69, 71, 74, 76, 79, 81, 83, 86, 88]; // D4 … E6
const BELLS = [79, 81, 83, 86, 88, 91, 93];
const CH = {
  Cmaj9: { bass: 36, notes: [48, 55, 59, 62, 64] },
  Bm11: { bass: 35, notes: [47, 54, 57, 62, 64] },
  Em9: { bass: 40, notes: [52, 59, 62, 66, 67] },
  Am9: { bass: 33, notes: [45, 55, 59, 60, 64] },
  D69: { bass: 38, notes: [50, 57, 59, 64, 66] },
};
for (const k in CH) CH[k].pcs = new Set([CH[k].bass, ...CH[k].notes].map((m) => m % 12));
const PROGS = [
  [CH.Cmaj9, CH.Bm11, CH.Em9, CH.Am9],
  [CH.Cmaj9, CH.D69, CH.Bm11, CH.Em9],
];

// Щипок струны (Карплус–Стронг), считается один раз на ноту и кешируется
function ksBuffer(rig, midi) {
  const hit = rig.ks.get(midi);
  if (hit) return hit;
  const ctx = rig.ctx;
  const sr = ctx.sampleRate;
  const f = mtof(midi);
  const N = Math.max(4, Math.round(sr / f - 0.5));
  const rate = f / (sr / (N + 0.5));
  const dur = clamp(3.4 - (midi - 60) * 0.07, 1.5, 3.4);
  const len = Math.floor(sr * dur);
  const buf = ctx.createBuffer(1, len, sr);
  const d = buf.getChannelData(0);
  const line = new Float32Array(N);
  let lp = 0;
  for (let i = 0; i < N; i++) { lp += 0.62 * (Math.random() * 2 - 1 - lp); line[i] = lp; }
  // позиция щипка у края струны → характерный «звонкий» тембр кото
  const P = Math.max(1, Math.round(N * 0.14));
  const ex = line.slice();
  let mean = 0;
  for (let i = 0; i < N; i++) { line[i] = ex[i] - 0.85 * ex[(i - P + N) % N]; mean += line[i]; }
  mean /= N;
  for (let i = 0; i < N; i++) line[i] -= mean;
  const rho = Math.pow(0.001, 1 / (f * dur * 0.95));
  let idx = 0, peak = 1e-6;
  for (let n = 0; n < len; n++) {
    const nx = idx + 1 === N ? 0 : idx + 1;
    const a = line[idx];
    line[idx] = rho * 0.5 * (a + line[nx]);
    d[n] = a;
    const ab = a < 0 ? -a : a;
    if (ab > peak) peak = ab;
    idx = nx;
  }
  const fade = Math.floor(sr * 0.08);
  const g = 0.9 / peak;
  for (let n = 0; n < len; n++) {
    d[n] *= n > len - fade ? (g * (len - n)) / fade : g;
  }
  const res = { buffer: buf, rate };
  rig.ks.set(midi, res);
  return res;
}

function makeCrackle(ctx) {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * 7);
  const buf = ctx.createBuffer(1, len, sr);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * 0.02; // тихое шипение
  const clicks = 7 * 9;
  for (let c = 0; c < clicks; c++) {
    let i = Math.floor(Math.random() * (len - 64));
    const a = Math.pow(Math.random(), 2.2) * (Math.random() < 0.5 ? -1 : 1);
    let v = a;
    for (let k = 0; k < 24; k++) { d[i++] += v; v *= -0.55; }
  }
  return buf;
}

// баланс дорожек музыки (stems можно переопределить в тестах)
const STEMS = { pad: 1, bass: 1, pluck: 1, bell: 1, wind: 1, vinyl: 1 };

function createMusic(rig, stems) {
  const ctx = rig.ctx;
  const st = Object.assign({}, STEMS, stems);
  const keep = []; // постоянные узлы (живут всё время звучания)
  const K = makeKit(ctx, keep);
  const live = new Set(); // запланированные голоса { srcs, end }

  const fader = K.gain(0);
  const tone = K.filter("lowpass", 5200, 0.5); // лоу-фай: срезаем верх
  const dry = K.gain(0.85);
  const send = K.gain(0.55);
  fader.connect(tone);
  tone.connect(dry).connect(rig.mix);
  tone.connect(send).connect(rig.verbIn);
  const bus = fader;
  const padBus = K.gain(st.pad);
  padBus.connect(bus);
  const bassBus = K.gain(st.bass);
  bassBus.connect(bus);
  const bellBus = K.gain(st.bell);
  bellBus.connect(bus);
  const pluckBus = K.gain(st.pluck);
  const pluckLP = K.filter("lowpass", 3400, 0.6);
  const pluckSend = K.gain(0.3);
  pluckBus.connect(pluckLP).connect(bus);
  pluckLP.connect(pluckSend).connect(rig.verbIn); // кото чуть «дальше» в пространстве

  // «плёночная» плавающая высота для всех тональных голосов (в центах)
  const wow = K.osc("sine", 0.23);
  const wowG = K.gain(5);
  wow.connect(wowG);
  // медленное «дыхание» фильтров пэдов
  const sweep = K.osc("sine", 0.031);
  const sweepG = K.gain(300);
  sweep.connect(sweepG);

  // ветер: фильтрованный шум с медленно плывущей полосой и громкостью
  const wind = K.noise(rig);
  const wbp = K.filter("bandpass", 650, 0.7);
  const wl1 = K.osc("sine", 0.043);
  const wl1g = K.gain(300);
  wl1.connect(wl1g).connect(wbp.frequency);
  const wg = K.gain(0.03);
  const wl2 = K.osc("sine", 0.067);
  const wl2g = K.gain(0.018);
  wl2.connect(wl2g).connect(wg.gain);
  const windStem = K.gain(st.wind);
  wind.connect(wbp).connect(wg).connect(windStem).connect(bus);

  // винил
  if (!rig.crackle) rig.crackle = makeCrackle(ctx);
  const crk = K.add(ctx.createBufferSource());
  crk.buffer = rig.crackle;
  crk.loop = true;
  const crkHP = K.filter("highpass", 1400, 0.7);
  const crkG = K.gain(0.15 * st.vinyl);
  crk.connect(crkHP).connect(crkG).connect(bus);

  const persistent = [wow, sweep, wind, wl1, wl2, crk];

  let started = false, stopped = false;
  let nextChord = 0, chordN = 0, prog = PROGS[0], D = 10;
  let nextNote = 0, nextBell = 0, phraseLeft = 0, idx = 5;
  const chordLine = [];

  const addLive = (srcs, end, cleanupSrc, nodes, extra) => {
    const v = { srcs, end };
    live.add(v);
    track(rig, cleanupSrc, nodes, () => {
      live.delete(v);
      if (extra) extra();
    });
  };

  function chordAt(t) {
    for (let i = chordLine.length - 1; i >= 0; i--) if (chordLine[i][0] <= t + 0.05) return chordLine[i][1];
    return chordLine.length ? chordLine[0][1] : PROGS[0][0];
  }

  function padChord(t, ch, dur) {
    const nodes = [];
    const V = makeKit(ctx, nodes);
    const end = t + dur + 8;
    const f = V.filter("lowpass", undefined, 0.8);
    f.frequency.setValueAtTime(240, t);
    f.frequency.setTargetAtTime(rand(1300, 2000), t, 1.6);
    f.frequency.setTargetAtTime(rand(650, 900), t + dur * 0.6, 2.5);
    sweepG.connect(f.frequency);
    const g = V.gain(0);
    g.gain.setValueAtTime(0, t);
    g.gain.setTargetAtTime(1, t, 1.1);
    g.gain.setTargetAtTime(0, t + dur, 1.5);
    f.connect(g).connect(padBus);
    const srcs = [];
    ch.notes.forEach((m, i) => {
      const lvl = m < 50 ? 0.7 : 1;
      for (const [type, det, a] of [["sawtooth", rand(-10, -4), 0.03], ["triangle", rand(4, 10), 0.05]]) {
        const o = V.osc(type, mtof(m));
        o.detune.value = det;
        wowG.connect(o.detune);
        const og = V.gain(a * lvl);
        o.connect(og).connect(f);
        srcs.push(o);
      }
      if (i >= ch.notes.length - 2) {
        // «стеклянный» слой: верхние ноты октавой выше
        const o = V.osc("sine", mtof(m + 12) * rand(0.999, 1.001));
        wowG.connect(o.detune);
        const og = V.gain(0.018);
        o.connect(og).connect(g);
        srcs.push(o);
      }
    });
    // тёплый бас
    const b = V.osc("sine", mtof(ch.bass + 12));
    wowG.connect(b.detune);
    const bg = V.gain(0);
    bg.gain.setValueAtTime(0, t);
    bg.gain.setTargetAtTime(0.07, t + 0.3, 1.2);
    bg.gain.setTargetAtTime(0, t + dur, 1.3);
    b.connect(bg).connect(bassBus);
    srcs.push(b);
    for (const s of srcs) { s.start(t); s.stop(end); }
    addLive(srcs, end, srcs[srcs.length - 1], nodes, () => {
      try { sweepG.disconnect(f.frequency); } catch (_) { /* ignore */ }
      for (const s of srcs) {
        try { wowG.disconnect(s.detune); } catch (_) { /* ignore */ }
      }
    });
  }

  function pluck(t, midi, vel, bendFrom) {
    const { buffer, rate } = ksBuffer(rig, midi);
    const nodes = [];
    const V = makeKit(ctx, nodes);
    const s = V.add(ctx.createBufferSource());
    s.buffer = buffer;
    let r0 = rate;
    if (bendFrom != null) {
      // ошидэ: щипок ниже и «дожим» струны до целевой ноты, как на кото
      r0 = rate * Math.pow(2, (bendFrom - midi) / 12);
      s.playbackRate.setValueAtTime(r0, t);
      s.playbackRate.setValueAtTime(r0, t + 0.13);
      s.playbackRate.linearRampToValueAtTime(rate, t + 0.3);
    } else {
      s.playbackRate.value = rate;
    }
    wowG.connect(s.detune);
    const g = V.gain(vel);
    const p = V.pan(rand(-0.35, 0.35));
    s.connect(g).connect(p).connect(pluckBus);
    const end = t + buffer.duration / Math.min(rate, r0) + 0.05;
    s.start(t);
    s.stop(end);
    addLive([s], end, s, nodes, () => {
      try { wowG.disconnect(s.detune); } catch (_) { /* ignore */ }
    });
  }

  function bell(t, midi, vel) {
    const nodes = [];
    const V = makeKit(ctx, nodes);
    const f = mtof(midi);
    const car = V.osc("sine", f);
    const mod = V.osc("sine", f * 3.5);
    const mg = V.gain(0);
    mg.gain.setValueAtTime(f * 1.4, t);
    mg.gain.setTargetAtTime(0, t, 0.3);
    mod.connect(mg).connect(car.frequency);
    const g = V.gain(0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vel, t + 0.004);
    g.gain.setTargetAtTime(0, t + 0.004, 1.1);
    const p = V.pan(rand(-0.5, 0.5));
    car.connect(g).connect(p).connect(bellBus);
    const end = t + 6;
    car.start(t); mod.start(t);
    car.stop(end); mod.stop(end);
    addLive([car, mod], end, car, nodes);
  }

  function melodyNote(t) {
    const ch = chordAt(t);
    if (phraseLeft <= 0) phraseLeft = 2 + Math.floor(rand(0, 5));
    // случайное блуждание по ладу с тягой к центру и к звукам аккорда
    const cands = [];
    let total = 0;
    for (const step of [-2, -1, 0, 1, 2]) {
      const j = idx + step;
      if (j < 0 || j >= PENTA.length) continue;
      let w = step === 0 ? 0.25 : Math.abs(step) === 1 ? 1 : 0.5;
      if (ch.pcs.has(PENTA[j] % 12)) w *= phraseLeft === 1 ? 3 : 1.7;
      w *= 1 + 0.12 * Math.sign(step) * (5.5 - idx);
      w = Math.max(0.02, w);
      cands.push([j, w]);
      total += w;
    }
    let r = Math.random() * total;
    for (const [j, w] of cands) { r -= w; if (r <= 0) { idx = j; break; } }
    const midi = PENTA[idx];
    const first = phraseLeft >= 2 && Math.random() < 0.3;
    const vel = first ? rand(0.75, 0.95) : rand(0.5, 0.82);
    const roll = Math.random();
    if (roll < 0.12 && idx > 0) {
      pluck(t, midi, vel, PENTA[idx - 1]);
    } else if (roll < 0.22 && idx < PENTA.length - 1) {
      pluck(t - 0.075, PENTA[idx + 1], vel * 0.45); // форшлаг
      pluck(t, midi, vel);
    } else {
      pluck(t, midi, vel);
    }
    phraseLeft--;
    return phraseLeft > 0 ? pick([0.36, 0.48, 0.48, 0.72, 0.96]) * rand(0.94, 1.06) : rand(2.8, 6.5);
  }

  return {
    start(at) {
      if (started) return;
      started = true;
      const t0 = at;
      fader.gain.setValueAtTime(0, t0);
      fader.gain.linearRampToValueAtTime(LEVEL.music, t0 + 5);
      wind.start(t0, rand(0, 3));
      crk.start(t0, rand(0, 6));
      for (const s of persistent) if (s !== wind && s !== crk) s.start(t0);
      nextChord = t0;
      nextNote = t0 + rand(2.2, 3.2);
      nextBell = t0 + rand(5, 9);
    },
    // планирует всё, что начинается до момента `until`
    pump(until) {
      if (!started || stopped) return;
      const now = ctx.currentTime;
      if (nextChord < now) nextChord = now + 0.05;
      if (nextNote < now) nextNote = now + 0.1;
      if (nextBell < now) nextBell = now + 0.5;
      while (nextChord < until) {
        const ch = prog[chordN % prog.length];
        padChord(nextChord, ch, D);
        chordLine.push([nextChord, ch]);
        if (chordLine.length > 4) chordLine.shift();
        nextChord += D;
        chordN++;
        if (chordN % 4 === 0) prog = Math.random() < 0.6 ? PROGS[0] : PROGS[1];
      }
      while (nextNote < until) nextNote += melodyNote(nextNote);
      while (nextBell < until) {
        const ch = chordAt(nextBell);
        const opts = BELLS.filter((m) => ch.pcs.has(m % 12));
        bell(nextBell, pick(opts.length ? opts : BELLS), rand(0.06, 0.1));
        nextBell += rand(7, 15);
      }
    },
    stop(fade = 2.8) {
      if (stopped) return;
      stopped = true;
      const now = ctx.currentTime;
      const p = fader.gain;
      if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(now);
      else { p.cancelScheduledValues(now); p.setValueAtTime(p.value, now); }
      p.linearRampToValueAtTime(0, now + fade);
      const endT = now + fade + 0.1;
      for (const v of live) {
        if (v.end > endT) for (const s of v.srcs) { try { s.stop(endT); } catch (_) { /* ignore */ } }
      }
      for (const s of persistent) {
        try { s.stop(endT + 0.05); } catch (_) { /* ignore */ }
      }
      if (!started) { disconnectAll(keep); return; }
      wind.onended = () => { wind.onended = null; disconnectAll(keep); };
    },
    get stopped() { return stopped; },
  };
}

// ---------------------------------------------------------------- публичный объект

function readMuted() {
  try { return localStorage.getItem(MUTE_KEY) === "1"; } catch (_) { return false; }
}
function writeMuted(m) {
  try { localStorage.setItem(MUTE_KEY, m ? "1" : "0"); } catch (_) { /* приватный режим */ }
}

export function createAudio({ config, env } = {}) {
  let ctx = null;
  let rig = null;
  let muted = readMuted();
  let purr = null;
  let purrTimer = 0;
  let music = null;
  let musicWanted = false;
  let musicTimer = 0;
  let suspendTimer = 0;
  const lastAt = Object.create(null);

  const hidden = () => typeof document !== "undefined" && document.hidden;
  const can = () => !!(rig && !muted && !hidden() && ctx.state !== "closed");
  const now = () => ctx.currentTime + 0.012;

  const guard = (fn) => (...args) => {
    try { return fn(...args); } catch (e) { return undefined; }
  };

  function play(name, minGapMs, fn) {
    if (!can()) return;
    const t = typeof performance !== "undefined" ? performance.now() : Date.now();
    if (t - (lastAt[name] || -1e9) < minGapMs) return;
    if (rig.active > 24) return; // защита от лавины звуков
    lastAt[name] = t;
    fn(rig, now());
  }

  function resume() {
    if (ctx && ctx.state !== "running" && ctx.state !== "closed") {
      const p = ctx.resume();
      if (p && p.catch) p.catch(() => {});
    }
  }
  function suspend() {
    if (ctx && ctx.state === "running") {
      const p = ctx.suspend();
      if (p && p.catch) p.catch(() => {});
    }
  }

  function onVisibility() {
    if (!ctx) return;
    if (hidden()) {
      stopPurr();
      suspend();
    } else if (!muted) {
      resume();
    }
  }
  function onPointer() {
    // iOS может «прервать» контекст (звонок, блокировка) — будим при следующем касании
    if (ctx && !muted && !hidden() && ctx.state !== "running") resume();
  }

  function unlock() {
    if (!ctx) {
      const AC = typeof window !== "undefined" && (window.AudioContext || window.webkitAudioContext);
      if (!AC) return;
      try { ctx = new AC({ latencyHint: "interactive" }); } catch (_) { ctx = new AC(); }
      rig = buildRig(ctx);
      rig.out.gain.value = 0;
      if (!muted) rig.out.gain.setTargetAtTime(1, ctx.currentTime, 0.05);
      // iOS: проиграть пустой буфер внутри жеста
      try {
        const b = ctx.createBufferSource();
        b.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
        b.connect(ctx.destination);
        b.onended = () => b.disconnect();
        b.start(0);
      } catch (_) { /* ignore */ }
      document.addEventListener("visibilitychange", onVisibility);
      window.addEventListener("pointerdown", onPointer, { passive: true, capture: true });
      window.addEventListener("keydown", onPointer, { passive: true, capture: true });
    }
    resume(); // будим даже если звук выключен — это наш шанс сделать это внутри жеста
    if (muted) scheduleSuspend();
    if (musicWanted && !music) startMusic();
  }

  function scheduleSuspend() {
    clearTimeout(suspendTimer);
    suspendTimer = setTimeout(() => { if (muted) suspend(); }, 450);
  }

  function setMuted(m) {
    m = !!m;
    if (m === muted) return;
    muted = m;
    writeMuted(m);
    if (rig) {
      const g = rig.out.gain;
      const t = ctx.currentTime;
      g.cancelScheduledValues(t);
      g.setTargetAtTime(m ? 0 : 1, t, m ? 0.06 : 0.09);
      if (m) {
        stopPurr();
        scheduleSuspend();
      } else {
        clearTimeout(suspendTimer);
        if (!hidden()) resume();
      }
    }
    try {
      window.dispatchEvent(new CustomEvent("sempik:mute", { detail: { muted: m } }));
    } catch (_) { /* ignore */ }
  }

  function startPurr() {
    if (purr || !can()) return;
    purr = purrVoice(rig, now());
    clearTimeout(purrTimer);
    purrTimer = setTimeout(stopPurr, 60000); // предохранитель: вечного мурчания не бывает
  }
  function stopPurr() {
    clearTimeout(purrTimer);
    if (!purr) return;
    const p = purr;
    purr = null;
    try { p.stop(ctx.currentTime); } catch (_) { /* ignore */ }
  }

  function startMusic() {
    if (music || !rig) return;
    music = createMusic(rig);
    music.start(ctx.currentTime + 0.1);
    const pumpIt = () => {
      if (music && ctx.state === "running") music.pump(ctx.currentTime + 1.2);
    };
    pumpIt();
    clearInterval(musicTimer);
    musicTimer = setInterval(() => {
      try { pumpIt(); } catch (_) { /* ignore */ }
    }, 200);
  }
  function stopMusic() {
    clearInterval(musicTimer);
    musicTimer = 0;
    if (music) { music.stop(); music = null; }
  }

  function musicOn() {
    musicWanted = true;
    if (rig) startMusic();
  }
  function musicOff() {
    musicWanted = false;
    stopMusic();
  }

  return {
    unlock: guard(unlock),
    meow: guard((kind = "short") =>
      play("meow", 90, (r, t) => {
        if (r.meows >= 3) return;
        meowVoice(r, t, MEOWS[kind] ? kind : "short");
      })
    ),
    startPurr: guard(startPurr),
    stopPurr: guard(stopPurr),
    pop: guard(() => play("pop", 45, popVoice)),
    tick: guard(() => play("tick", 40, tickVoice)),
    chime: guard(() => play("chime", 250, chimeVoice)),
    thud: guard(() => play("thud", 80, thudVoice)),
    setMuted: guard(setMuted),
    get muted() { return muted; },
    musicOn: guard(musicOn),
    musicOff: guard(musicOff),
    get musicPlaying() { return musicWanted; },
    // для отладки из консоли: window.sempik.audio.debug
    get debug() {
      return { state: ctx ? ctx.state : "locked", voices: rig ? rig.active : 0, purring: !!purr, music: !!music };
    },
  };
}

// Внутренности для офлайн-тестов (рендер в OfflineAudioContext). Сайт это не использует.
export const __synth = {
  buildRig, meowVoice, purrVoice, popVoice, tickVoice, chimeVoice, thudVoice, createMusic, ksBuffer, LEVEL,
};
