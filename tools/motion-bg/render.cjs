#!/usr/bin/env node
// Рендер кадров фонового видео: шейдер motion.frag → PNG-кадры через headless Chromium (WebGL2).
// Пример:  node render.cjs --out /tmp/frames --w 1920 --h 1080 --fps 30 --seconds 12 --workers 3
// Отдельные кадры:  node render.cjs --out /tmp/test --frames 0,90,180,360
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith("--")) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : "1"]);
    return acc;
  }, [])
);

const W = +(args.w || 1920);
const H = +(args.h || 1080);
const FPS = +(args.fps || 30);
const SECONDS = +(args.seconds || 12);
const N = Math.round(FPS * SECONDS); // кадров в лупе; кадр N == кадр 0
const OUT = path.resolve(args.out || "frames");
const WORKERS = +(args.workers || 1);
const SHADER = fs.readFileSync(path.join(__dirname, args.shader || "motion.frag"), "utf8");

let list;
if (args.frames) list = args.frames.split(",").map(Number);
else {
  const from = +(args.from || 0);
  const to = +(args.to || N);
  list = [];
  for (let f = from; f < to; f++) list.push(f);
  if (!args.overwrite) list = list.filter((f) => !fs.existsSync(frameName(f)));
}

function frameName(f) {
  return path.join(OUT, `f${String(f).padStart(5, "0")}.png`);
}

const PAGE = `<!doctype html><html><body style="margin:0;background:#000">
<canvas id="c" width="${W}" height="${H}"></canvas></body></html>`;

// выполняется внутри страницы
function setup({ src, W, H }) {
const canvas = document.getElementById('c');
const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, preserveDrawingBuffer: true, premultipliedAlpha: false });
if (!gl) throw new Error('no webgl2');
function sh(type, src) {
  const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}
const prog = gl.createProgram();
gl.attachShader(prog, sh(gl.VERTEX_SHADER, '#version 300 es\nin vec2 a; void main(){ gl_Position = vec4(a,0.,1.); }'));
gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, src));
gl.bindAttribLocation(prog, 0, 'a');
gl.linkProgram(prog);
if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
gl.useProgram(prog);
const buf = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, buf);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
const uRes = gl.getUniformLocation(prog, 'uRes');
const uPhase = gl.getUniformLocation(prog, 'uPhase');
gl.viewport(0, 0, W, H);
window.renderPhase = (phase) => {
  gl.uniform2f(uRes, W, H);
  gl.uniform1f(uPhase, phase);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.finish();
  return canvas.toDataURL('image/png');
};
}

async function worker(browser, frames, id) {
  const page = await browser.newPage({ viewport: { width: Math.min(W, 1920), height: Math.min(H, 1080) } });
  page.on("pageerror", (e) => console.error(`[w${id}] pageerror`, e.message));
  await page.setContent(PAGE);
  await page.evaluate(`(${setup.toString()})(${JSON.stringify({ src: SHADER, W, H })})`);
  for (const f of frames) {
    const t0 = Date.now();
    // фаза считается без mod — так проверяется, что сам шейдер периодичен (кадр N == кадр 0)
    const url = await page.evaluate((ph) => window.renderPhase(ph), f / N);
    fs.writeFileSync(frameName(f), Buffer.from(url.split(",")[1], "base64"));
    console.log(`[w${id}] frame ${f}/${N} ${Date.now() - t0}ms`);
  }
  await page.close();
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  console.log(`${W}x${H} @${FPS}fps, ${SECONDS}s → ${N} frames; to render: ${list.length}; workers: ${WORKERS}`);
  const t0 = Date.now();
  const browsers = [];
  const jobs = [];
  for (let w = 0; w < WORKERS; w++) {
    const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
    browsers.push(browser);
    const mine = list.filter((_, i) => i % WORKERS === w);
    jobs.push(worker(browser, mine, w));
  }
  await Promise.all(jobs);
  await Promise.all(browsers.map((b) => b.close()));
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
})().catch((e) => { console.error(e); process.exit(1); });
