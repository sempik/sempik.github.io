// 3D-сцена: парящий остров с ночной сакурой, торii и фонарём, 3D-логотипы соцсетей на орбитах,
// падающие лепестки. Всё процедурное (никаких файлов моделей). Канвас прозрачный — под ним видео.
//
// initScene({ canvas, config, icons, audio, env, onLinkActivate }) → { reveal() }
import * as THREE from 'three';
import { SVGLoader } from 'three/addons/loaders/SVGLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { SimplexNoise } from 'three/addons/math/SimplexNoise.js';

const TAU = Math.PI * 2;
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (a, b, t) => a + (b - a) * t;
const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));
const easeOutExpo = (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));
const easeOutCubic = (t) => 1 - Math.pow(1 - clamp01(t), 3);
const easeOutBack = (t) => {
  const c1 = 1.45, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- GLSL helpers
const GLSL_NOISE = /* glsl */ `
vec3 sk_mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 sk_mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 sk_permute(vec4 x){return sk_mod289(((x*34.0)+1.0)*x);}
vec4 sk_tis(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0);
  const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy));
  vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz);
  vec3 l=1.0-g;
  vec3 i1=min(g.xyz,l.zxy);
  vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx;
  vec3 x2=x0-i2+C.yyy;
  vec3 x3=x0-D.yyy;
  i=sk_mod289(i);
  vec4 p=sk_permute(sk_permute(sk_permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857;
  vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z);
  vec4 x_=floor(j*ns.z);
  vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy;
  vec4 y=y_*ns.x+ns.yyyy;
  vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy);
  vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0;
  vec4 s1=floor(b1)*2.0+1.0;
  vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;
  vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x);
  vec3 p1=vec3(a0.zw,h.y);
  vec3 p2=vec3(a1.xy,h.z);
  vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=sk_tis(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0);
  m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}`;

const GLSL_RAINBOW = /* glsl */ `
vec3 sk_rainbow(float h){ return clamp(abs(mod(h*6.0+vec3(0.0,4.0,2.0),6.0)-3.0)-1.0,0.0,1.0); }
float sk_luma(vec3 c){ return dot(c, vec3(0.299,0.587,0.114)); }`;

// Подмешивает код в стандартный материал three.js (эмиссия, rim-свет, анимации).
function patchMaterial(mat, key, { uniforms = {}, vertHead = '', vertBody = '', fragHead = '', fragBody = '' }) {
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + vertHead)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + vertBody);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + fragHead)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n' + fragBody);
  };
  mat.customProgramCacheKey = () => key;
  return mat;
}

// ---------------------------------------------------------------- geometry helpers
function prep(geo, color) {
  // единый набор атрибутов для mergeGeometries: position + normal + color, без индекса
  let g = geo.index ? geo.toNonIndexed() : geo;
  if (g.attributes.uv) g.deleteAttribute('uv');
  if (g.attributes.uv1) g.deleteAttribute('uv1');
  g.computeVertexNormals();
  if (color !== undefined) {
    const c = new THREE.Color(color);
    const n = g.attributes.position.count;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  }
  return g;
}

function place(geo, { x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1 } = {}) {
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
    new THREE.Vector3(sx, sy, sz)
  );
  geo.applyMatrix4(m);
  return geo;
}

// Конусная «труба» вдоль кривой (ветки, корни) — радиус задаётся функцией от t.
function taperedTube(curve, tubular, radial, radiusAt) {
  const frames = curve.computeFrenetFrames(tubular, false);
  const pos = [];
  const idx = [];
  const P = new THREE.Vector3();
  const N = new THREE.Vector3();
  for (let i = 0; i <= tubular; i++) {
    const t = i / tubular;
    curve.getPointAt(t, P);
    const r = radiusAt(t);
    for (let j = 0; j < radial; j++) {
      const a = (j / radial) * TAU;
      N.copy(frames.normals[i]).multiplyScalar(Math.cos(a)).addScaledVector(frames.binormals[i], Math.sin(a));
      pos.push(P.x + N.x * r, P.y + N.y * r, P.z + N.z * r);
    }
  }
  for (let i = 0; i < tubular; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * radial + j;
      const b = (i + 1) * radial + j;
      const c = (i + 1) * radial + ((j + 1) % radial);
      const d = i * radial + ((j + 1) % radial);
      idx.push(a, d, b, b, d, c);
    }
  }
  // кончик: сводим в точку
  const tip = pos.length / 3;
  curve.getPointAt(1, P);
  const T = curve.getTangentAt(1);
  pos.push(P.x + T.x * radiusAt(1), P.y + T.y * radiusAt(1), P.z + T.z * radiusAt(1));
  const last = tubular * radial;
  for (let j = 0; j < radial; j++) idx.push(last + j, last + ((j + 1) % radial), tip);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

function makeGlowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.18, 'rgba(255,255,255,0.6)');
  grd.addColorStop(0.45, 'rgba(255,255,255,0.18)');
  grd.addColorStop(0.75, 'rgba(255,255,255,0.04)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// SVG-путь иконки (viewBox 24×24) → объёмная геометрия с фаской, центрированная, размер `size`.
export function createLogoGeometry(d, size = 1) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="${d}"/></svg>`;
  const data = new SVGLoader().parse(svg);
  const shapes = [];
  for (const p of data.paths) shapes.push(...SVGLoader.createShapes(p));
  const geo = new THREE.ExtrudeGeometry(shapes, {
    depth: 2.0,
    bevelEnabled: true,
    bevelThickness: 0.55,
    bevelSize: 0.28,
    bevelOffset: -0.06,
    bevelSegments: 3,
    curveSegments: 7,
  });
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const cx = (bb.min.x + bb.max.x) / 2, cy = (bb.min.y + bb.max.y) / 2, cz = (bb.min.z + bb.max.z) / 2;
  geo.translate(-cx, -cy, -cz);
  // SVG: ось Y смотрит вниз. Поворот на 180° вокруг X переворачивает Y, не ломая порядок обхода граней.
  geo.rotateX(Math.PI);
  const s = size / Math.max(bb.max.x - bb.min.x, bb.max.y - bb.min.y);
  geo.scale(s, s, s);
  geo.computeVertexNormals();
  return geo;
}

// Лепесток сакуры: овал с вырезом на кончике, выгнутый «лодочкой», градиент цвета от основания.
function makePetalGeometry() {
  const s = new THREE.Shape();
  s.moveTo(0, 0);
  s.bezierCurveTo(0.3, 0.06, 0.5, 0.5, 0.3, 0.9);
  s.quadraticCurveTo(0.21, 1.02, 0.11, 0.99);
  s.lineTo(0, 0.85);
  s.lineTo(-0.11, 0.99);
  s.quadraticCurveTo(-0.21, 1.02, -0.3, 0.9);
  s.bezierCurveTo(-0.5, 0.5, -0.3, 0.06, 0, 0);
  const g = new THREE.ShapeGeometry(s, 6);
  g.deleteAttribute('uv');
  const p = g.attributes.position;
  const cols = new Float32Array(p.count * 3);
  const cBase = new THREE.Color('#ff5aa5');
  const cMid = new THREE.Color('#ffa3cf');
  const cTip = new THREE.Color('#fff0f7');
  const c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i);
    const z = -0.55 * x * x + 0.18 * (y - 0.5) * (y - 0.5) + 0.06 * x * y;
    p.setXYZ(i, x, y - 0.5, z);
    if (y < 0.35) c.copy(cBase).lerp(cMid, y / 0.35);
    else c.copy(cMid).lerp(cTip, (y - 0.35) / 0.65);
    cols[i * 3] = c.r; cols[i * 3 + 1] = c.g; cols[i * 3 + 2] = c.b;
  }
  g.setAttribute('aCol', new THREE.BufferAttribute(cols, 3));
  g.computeVertexNormals();
  return g;
}

// ================================================================= main
export function initScene({ canvas, config = {}, icons = {}, audio = null, env = {}, onLinkActivate } = {}) {
  const stub = { reveal() {} };
  if (!canvas) return stub;

  const reduced = !!env.reducedMotion;
  const isMobile = () => (typeof env.mobile === 'boolean' ? env.mobile : innerWidth < 900);
  const sfx = (name) => { try { audio?.[name]?.(); } catch (_) { /* звук не обязателен */ } };

  // three.js r170 требует WebGL2; проверяем заранее на отдельном канвасе, чтобы не сыпать ошибками в консоль
  const hasGL = (() => {
    try {
      const gl = document.createElement('canvas').getContext('webgl2');
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
      return !!gl;
    } catch (_) { return false; }
  })();
  if (!hasGL) {
    canvas.style.display = 'none';
    return stub;
  }

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      // MSAA только там, где буфер небольшой: на ретине (DPR 2 → буфер 2880×1800) он дорогой и почти незаметен,
      // а на телефоне холст и так ограничен DPR 1.5
      canvas, alpha: true, powerPreference: 'high-performance',
      antialias: Math.min(window.devicePixelRatio || 1, innerWidth < 900 ? 1.5 : 2) < 1.75,
    });
  } catch (e) {
    console.warn('[sempik] WebGL недоступен — 3D-сцена выключена', e);
    canvas.style.display = 'none';
    return stub;
  }
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;

  // если CSS ещё не растянул канвас — растягиваем сами
  if (canvas.clientWidth < innerWidth * 0.5 || canvas.clientHeight < innerHeight * 0.5) {
    canvas.style.width = '100%';
    canvas.style.height = '100%';
  }
  // горизонтальный свайп крутит остров, вертикальный — скроллит страницу, щипок — зумит
  canvas.style.touchAction = 'pan-y pinch-zoom';

  const theme = Object.assign(
    { pink: '#ff8cc6', hot: '#ff3d9a', violet: '#9b7bff', deep: '#2a1446', ink: '#f6f0ff' },
    config.theme || {}
  );
  const links = (config.links || []).filter((l) => icons[l.id]);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  const CAM_BASE = new THREE.Vector3(0, 2.0, 14);
  const LOOK = new THREE.Vector3(0, 0, 0);
  camera.position.copy(CAM_BASE);
  camera.lookAt(LOOK);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();

  const glowTex = makeGlowTexture();
  const makeGlow = (color, scale, opacity) => {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTex, color: new THREE.Color(color), transparent: true, opacity,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    }));
    sp.scale.setScalar(scale);
    sp.userData.baseOpacity = opacity;
    sp.userData.baseScale = scale;
    return sp;
  };

  // общие юниформы для всех шейдеров
  const U = {
    uTime: { value: 0 },
    uParty: { value: 0 },
    uShake: { value: 0 },
  };

  // ------------------------------------------------------------ lights
  scene.add(new THREE.HemisphereLight('#b9a6ff', '#1a0b2a', 1.25));
  const key = new THREE.DirectionalLight('#ffeef8', 2.6);
  key.position.set(-5, 8, 7);
  scene.add(key);
  const rimL = new THREE.DirectionalLight('#ff4fa8', 3.2);
  rimL.position.set(6, 3, -6);
  scene.add(rimL);
  const rimL2 = new THREE.DirectionalLight('#7c6bff', 2.4);
  rimL2.position.set(-7, -1, -5);
  scene.add(rimL2);

  // ------------------------------------------------------------ hero hierarchy
  const heroRoot = new THREE.Group(); // позиция/масштаб героя (раскладка), покачивание
  const spin = new THREE.Group(); // остров + дерево, вращается вокруг Y
  const orbitGroup = new THREE.Group(); // логотипы
  heroRoot.add(spin, orbitGroup);
  scene.add(heroRoot);

  const rng = mulberry32(20241105);
  const noise = new SimplexNoise({ random: rng });
  const R_TOP = 1.75;
  const H_ISLAND = 2.25;

  // ------------------------------------------------------------ island
  const island = (() => {
    const geo = new THREE.IcosahedronGeometry(1, 5);
    geo.deleteAttribute('uv');
    const pos = geo.attributes.position;
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).normalize();
      const hor = Math.hypot(v.x, v.z) || 1e-6;
      const dx = v.x / hor, dz = v.z / hor;
      const n1 = noise.noise3d(v.x * 1.7, v.y * 1.7, v.z * 1.7);
      const n2 = noise.noise3d(v.x * 4.2 + 11, v.y * 4.2, v.z * 4.2);
      let x, y, z;
      if (v.y >= 0) {
        const r = hor * R_TOP * (1 + 0.07 * n1);
        y = 0.16 * v.y + 0.035 * n2 + 0.025 * n1 * v.y;
        if (hor > 0.9) y -= (hor - 0.9) * 0.5; // скруглённая кромка
        x = dx * r; z = dz * r;
      } else {
        const u = Math.asin(Math.min(1, -v.y)) / (Math.PI / 2); // 0 — кромка, 1 — нижний шпиль
        const r = R_TOP * Math.pow(1 - u, 0.8) * (1 + 0.07 * n1 + u * (0.2 * n1 + 0.12 * n2));
        y = -H_ISLAND * Math.pow(u, 1.12) * (1 + 0.12 * n1) + 0.035 * n2 * (1 - u) - 0.05 * Math.min(1, u * 8);
        x = dx * r; z = dz * r;
      }
      pos.setXYZ(i, x, y, z);
    }
    geo.computeVertexNormals();

    // раскраска по граням: мох с опавшими лепестками сверху, тёмный фиолетовый камень по бокам
    const cnt = pos.count;
    const col = new Float32Array(cnt * 3);
    const cMoss = [new THREE.Color('#2c1f45'), new THREE.Color('#33244f'), new THREE.Color('#271a3d')];
    const cPetal = [new THREE.Color('#c25b97'), new THREE.Color('#e07fb3'), new THREE.Color('#9e4a86')];
    const cEarth = new THREE.Color('#2e1f3c');
    const cStoneHi = new THREE.Color('#4d3c6b');
    const cStoneLo = new THREE.Color('#150d22');
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const n = new THREE.Vector3();
    const tmp = new THREE.Color();
    for (let f = 0; f < cnt; f += 3) {
      a.fromBufferAttribute(pos, f); b.fromBufferAttribute(pos, f + 1); c.fromBufferAttribute(pos, f + 2);
      n.subVectors(c, b).cross(a.clone().sub(b)).normalize();
      const cy = (a.y + b.y + c.y) / 3;
      const jitter = 0.85 + rng() * 0.3;
      if (n.y > 0.5 && cy > -0.2) {
        const rr = rng();
        tmp.copy(rr < 0.2 ? cPetal[(rng() * 3) | 0] : cMoss[(rng() * 3) | 0]);
      } else if (cy > -0.32) {
        tmp.copy(cEarth);
      } else {
        const t = clamp01((-cy - 0.3) / (H_ISLAND - 0.3));
        tmp.copy(cStoneHi).lerp(cStoneLo, Math.pow(t, 0.8));
        if (rng() < 0.08) tmp.lerp(new THREE.Color('#6a54a0'), 0.35);
      }
      tmp.multiplyScalar(jitter);
      for (let k = 0; k < 3; k++) {
        col[(f + k) * 3] = tmp.r; col[(f + k) * 3 + 1] = tmp.g; col[(f + k) * 3 + 2] = tmp.b;
      }
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return geo;
  })();

  const islandMat = patchMaterial(
    new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.92, metalness: 0.0 }),
    'sk-island',
    {
      uniforms: {
        uTime: U.uTime,
        uCrackA: { value: new THREE.Color('#ff3d9a') },
        uCrackB: { value: new THREE.Color('#8b5cff') },
        uRimCol: { value: new THREE.Color('#9b7bff') },
        uParty: U.uParty,
      },
      vertHead: 'varying vec3 vObjPos; varying vec3 vObjN;',
      vertBody: 'vObjPos = position; vObjN = normal;',
      fragHead: 'varying vec3 vObjPos; varying vec3 vObjN; uniform float uTime; uniform float uParty; uniform vec3 uCrackA; uniform vec3 uCrackB; uniform vec3 uRimCol;' + GLSL_NOISE + GLSL_RAINBOW,
      fragBody: /* glsl */ `
        {
          float n1 = snoise(vObjPos * 1.3 + vec3(3.1, 0.0, 1.7));
          float n2 = snoise(vObjPos * 3.6 + vec3(7.3));
          float patchy = smoothstep(-0.05, 0.45, snoise(vObjPos * 0.7 + vec3(1.0, 5.0, 2.0)));
          float v = abs(n1 + n2 * 0.18);
          float crack = 1.0 - smoothstep(0.0, 0.028, v);
          float halo = (1.0 - smoothstep(0.0, 0.12, v)) * 0.18;
          float side = 1.0 - smoothstep(0.25, 0.7, vObjN.y);
          float below = smoothstep(-0.3, -0.75, vObjPos.y);
          float pulse = 0.55 + 0.45 * sin(uTime * 0.9 + vObjPos.y * 2.2 + n1 * 2.0);
          vec3 cc = mix(uCrackB, uCrackA, smoothstep(-1.8, -0.5, vObjPos.y));
          cc = mix(cc, sk_rainbow(fract(vObjPos.y * 0.3 + uTime * 0.3)), uParty * 0.8);
          totalEmissiveRadiance += cc * (crack + halo) * side * below * pulse * patchy * (1.25 + uParty);
          vec3 V = normalize(vViewPosition);
          float fres = pow(1.0 - clamp(abs(dot(normal, V)), 0.0, 1.0), 3.0);
          totalEmissiveRadiance += uRimCol * fres * 0.35;
        }`,
    }
  );

  // корни под островом
  const rootParts = [];
  for (let i = 0; i < 9; i++) {
    const ang = (i / 9) * TAU + rng() * 0.5;
    const u = 0.12 + rng() * 0.3;
    const rr = R_TOP * Math.pow(1 - u, 0.8) * 0.88;
    const start = new THREE.Vector3(Math.cos(ang) * rr, -H_ISLAND * Math.pow(u, 1.12) - 0.02, Math.sin(ang) * rr);
    const len = 0.5 + rng() * 0.9;
    const pts = [start.clone()];
    let p = start.clone();
    const dir = new THREE.Vector3(Math.cos(ang) * 0.35, -1, Math.sin(ang) * 0.35).normalize();
    for (let k = 0; k < 4; k++) {
      dir.x += (rng() - 0.5) * 0.6; dir.z += (rng() - 0.5) * 0.6; dir.y = -1;
      dir.normalize();
      p = p.clone().addScaledVector(dir, len / 4);
      pts.push(p);
    }
    const curve = new THREE.CatmullRomCurve3(pts);
    const r0 = 0.035 + rng() * 0.03;
    rootParts.push(prep(taperedTube(curve, 8, 5, (t) => r0 * (1 - t * 0.85)), '#24162c'));
  }

  // камни и ступени сверху
  const decoParts = [];
  const islandMeshTmp = new THREE.Mesh(island, new THREE.MeshBasicMaterial());
  const rc = new THREE.Raycaster();
  const DOWN = new THREE.Vector3(0, -1, 0);
  const surfaceY = (x, z) => {
    rc.set(new THREE.Vector3(x, 5, z), DOWN);
    const h = rc.intersectObject(islandMeshTmp, false)[0];
    return h ? h.point.y : 0.08;
  };
  for (let i = 0; i < 9; i++) {
    const ang = rng() * TAU;
    const r = 1.05 + rng() * 0.55;
    const x = Math.cos(ang) * r, z = Math.sin(ang) * r;
    const s = 0.07 + rng() * 0.1;
    decoParts.push(prep(place(new THREE.DodecahedronGeometry(1, 0), {
      x, y: surfaceY(x, z) + s * 0.25, z, rx: rng() * 3, ry: rng() * 3, sx: s, sy: s * 0.7, sz: s,
    }), rng() < 0.5 ? '#4b3b66' : '#3b2d55'));
  }
  // ступени от тории к дереву
  const TORII_POS = new THREE.Vector2(-0.55, 1.05);
  for (let i = 0; i < 4; i++) {
    const t = (i + 0.6) / 4.6;
    const x = lerp(TORII_POS.x, 0.0, t) + (rng() - 0.5) * 0.08;
    const z = lerp(TORII_POS.y + 0.15, 0.35, t);
    decoParts.push(prep(place(new THREE.CylinderGeometry(0.1, 0.11, 0.035, 6), {
      x, y: surfaceY(x, z) + 0.008, z, ry: rng(),
    }), '#5d4c7a'));
  }

  const islandGeo = mergeGeometries([prep(island), ...rootParts, ...decoParts]);
  const islandMesh = new THREE.Mesh(islandGeo, islandMat);
  islandMesh.userData.kind = 'tree';
  spin.add(islandMesh);

  // светящиеся цветочки во мху
  {
    const bits = [];
    const palette = ['#ff9ad5', '#ffc4e6', '#b99bff', '#9fe0ff'];
    for (let i = 0; i < 28; i++) {
      const ang = rng() * TAU;
      const r = 0.35 + Math.sqrt(rng()) * 1.25;
      const x = Math.cos(ang) * r, z = Math.sin(ang) * r;
      const s = 0.018 + rng() * 0.018;
      bits.push(prep(place(new THREE.OctahedronGeometry(1, 0), {
        x, y: surfaceY(x, z) + s, z, sx: s, sy: s * 1.4, sz: s,
      }), palette[(rng() * palette.length) | 0]));
    }
    const m = new THREE.Mesh(mergeGeometries(bits), new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }));
    spin.add(m);
  }

  // ------------------------------------------------------------ crystals under the island
  const crystalMat = patchMaterial(
    new THREE.MeshStandardMaterial({
      vertexColors: true, flatShading: true, roughness: 0.12, metalness: 0.25,
      envMap: envTex, envMapIntensity: 1.4,
    }),
    'sk-glowcol',
    {
      uniforms: { uSelfGlow: { value: 0.7 }, uRimCol: { value: new THREE.Color('#b89cff') }, uRim: { value: 0.75 } },
      fragHead: 'uniform float uSelfGlow; uniform vec3 uRimCol; uniform float uRim;',
      fragBody: /* glsl */ `
        #ifdef USE_COLOR
          totalEmissiveRadiance += vColor.rgb * uSelfGlow;
        #endif
        {
          vec3 V = normalize(vViewPosition);
          float fres = pow(1.0 - clamp(abs(dot(normal, V)), 0.0, 1.0), 2.5);
          totalEmissiveRadiance += uRimCol * fres * uRim;
        }`,
    }
  );
  let crystals;
  {
    const parts = [];
    const crystalCols = ['#8a63ff', '#a77bff', '#ff6fb8', '#6f4dff', '#c9a6ff'];
    const addCrystal = (x, y, z, len, rad, tiltX, tiltZ, col) => {
      parts.push(prep(place(new THREE.OctahedronGeometry(1, 0), {
        x, y, z, rx: tiltX, rz: tiltZ, sx: rad, sy: len, sz: rad,
      }), col));
    };
    const tipY = -H_ISLAND - 0.02;
    addCrystal(0, tipY - 0.25, 0, 0.62, 0.17, 0, 0, '#9a72ff');
    for (let i = 0; i < 5; i++) {
      const ang = (i / 5) * TAU + rng();
      addCrystal(Math.cos(ang) * 0.14, tipY - 0.05, Math.sin(ang) * 0.14, 0.32 + rng() * 0.2, 0.08 + rng() * 0.04,
        Math.sin(ang) * 0.5, -Math.cos(ang) * 0.5, crystalCols[i % crystalCols.length]);
    }
    for (let i = 0; i < 9; i++) {
      const ang = rng() * TAU;
      const u = 0.35 + rng() * 0.45;
      const rr = R_TOP * Math.pow(1 - u, 0.8) * 0.92;
      const y = -H_ISLAND * Math.pow(u, 1.12);
      const out = 0.5 + rng() * 0.4;
      addCrystal(Math.cos(ang) * rr, y - 0.08, Math.sin(ang) * rr, 0.16 + rng() * 0.18, 0.05 + rng() * 0.04,
        Math.sin(ang) * out, -Math.cos(ang) * out, crystalCols[(rng() * crystalCols.length) | 0]);
    }
    crystals = new THREE.Mesh(mergeGeometries(parts), crystalMat);
    spin.add(crystals);
    const g = makeGlow('#7f52ff', 2.2, 0.45);
    g.position.set(0, tipY - 0.25, 0);
    spin.add(g);
    const pl = new THREE.PointLight('#9a6bff', 5, 4, 2);
    pl.position.set(0, tipY - 0.1, 0);
    spin.add(pl);
  }

  // ------------------------------------------------------------ sakura tree
  const treeGroup = new THREE.Group(); // pivot у основания ствола — для «встряхивания»
  const TREE_BASE = new THREE.Vector3(0.08, surfaceY(0.08, -0.12), -0.12);
  treeGroup.position.copy(TREE_BASE);
  spin.add(treeGroup);

  const tips = [];
  let trunk;
  {
    const parts = [];
    const MAX = 4;
    const grow = (p0, dir, len, r0, depth, az0) => {
      const n = depth === 0 ? 4 : 3;
      const pts = [p0.clone()];
      let p = p0.clone();
      const d = dir.clone();
      for (let k = 1; k <= n; k++) {
        d.x += (rng() - 0.5) * (depth === 0 ? 0.35 : 0.5);
        d.z += (rng() - 0.5) * (depth === 0 ? 0.35 : 0.5);
        d.y += (rng() - 0.5) * 0.2 + (depth > 1 ? 0.03 : 0);
        d.normalize();
        p = p.clone().addScaledVector(d, len / n);
        pts.push(p);
      }
      const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
      const r1 = r0 * 0.6;
      parts.push(prep(taperedTube(curve, n * 2, depth <= 1 ? 7 : 5, (t) => {
        let r = lerp(r0, r1, t);
        if (depth === 0) r += r0 * 1.1 * Math.pow(1 - t, 7);
        return r;
      })));
      const end = pts[pts.length - 1];
      if (depth >= 2) tips.push({ p: curve.getPoint(0.5), big: false });
      if (depth >= MAX) { tips.push({ p: end.clone(), big: true }); return; }
      const kids = depth === 0 ? 4 : rng() < 0.5 ? 2 : 3;
      const parentAz = Math.atan2(d.z, d.x);
      for (let k = 0; k < kids; k++) {
        const leader = depth === 0 && k === kids - 1; // центральный «лидер» — вверх
        const az = depth === 0
          ? az0 + (k / (kids - 1)) * TAU + (rng() - 0.5) * 0.5
          : parentAz + (k - (kids - 1) / 2) * 0.95 + (rng() - 0.5) * 0.6;
        const spread = leader ? 0.25 : depth === 0 ? 0.85 + rng() * 0.2 : 0.4 + rng() * 0.4;
        const hor = new THREE.Vector3(Math.cos(az), 0, Math.sin(az));
        const nd = d.clone().multiplyScalar(Math.cos(spread)).addScaledVector(hor, Math.sin(spread));
        nd.y = lerp(nd.y, 0.42, depth >= 2 ? 0.35 : 0.12);
        nd.normalize();
        grow(end, nd, len * (leader ? 0.62 : 0.7 + rng() * 0.12), r1 * (leader ? 0.85 : 0.95), depth + 1, az);
      }
    };
    grow(new THREE.Vector3(0, -0.12, 0), new THREE.Vector3(0.08, 1, 0.04).normalize(), 1.1, 0.19, 0, rng() * TAU);
    trunk = new THREE.Mesh(
      mergeGeometries(parts),
      new THREE.MeshStandardMaterial({ color: '#3a2438', roughness: 0.85, flatShading: true })
    );
    trunk.userData.kind = 'tree';
    treeGroup.add(trunk);
  }

  // кроны: инстансы низкополигональных «облачков»
  const canopyCenter = new THREE.Vector3();
  let foliage;
  {
    // на телефоне облачков меньше (они и так мелкие на экране), зато каждое чуть крупнее
    const lite = isMobile() || !!env.coarse;
    const grow = lite ? 1.14 : 1;
    // размер облачков заметно разный — иначе крона похожа на попкорн
    const vary = () => lerp(0.62, 1.35, Math.pow(rng(), 1.15));
    const blobs = [];
    for (const t of tips) {
      const count = t.big ? (lite ? 3 : 5) : (lite ? 2 : 3);
      for (let c = 0; c < count; c++) {
        const off = new THREE.Vector3(rng() - 0.5, rng() - 0.5, rng() - 0.5).normalize().multiplyScalar(Math.cbrt(rng()) * (t.big ? 0.27 : 0.19));
        off.y = Math.abs(off.y) * 0.6 + 0.02;
        const s = ((t.big ? 0.19 : 0.15) + rng() * 0.1) * vary() * grow;
        blobs.push({ p: t.p.clone().add(off), s });
      }
    }
    // «купол» кроны: дополнительные облачка по верхней поверхности эллипсоида — крона круглая и пышная
    {
      const tb = new THREE.Box3();
      for (const t of tips) tb.expandByPoint(t.p);
      const c = tb.getCenter(new THREE.Vector3());
      const r = tb.getSize(new THREE.Vector3()).multiplyScalar(0.5);
      const pnt = new THREE.Vector3();
      let added = 0;
      const domeN = lite ? 46 : 70;
      for (let k = 0; k < 400 && added < domeN; k++) {
        const th = rng() * TAU;
        const ph = Math.acos(lerp(1, -0.25, rng()));
        const sh = 0.8 + rng() * 0.25;
        pnt.set(c.x + Math.sin(ph) * Math.cos(th) * r.x * sh, c.y + Math.cos(ph) * r.y * sh + 0.05, c.z + Math.sin(ph) * Math.sin(th) * r.z * sh);
        let near = Infinity;
        for (const t of tips) near = Math.min(near, t.p.distanceToSquared(pnt));
        if (near > 0.5 * 0.5) continue;
        blobs.push({ p: pnt.clone(), s: (0.19 + rng() * 0.1) * vary() * grow });
        added++;
      }
    }
    let minY = Infinity, maxY = -Infinity;
    for (const b of blobs) { minY = Math.min(minY, b.p.y); maxY = Math.max(maxY, b.p.y); canopyCenter.add(b.p); }
    canopyCenter.divideScalar(blobs.length);
    // «плакучие» кисти: несколько гроздей свисают ниже кромки кроны с крайних веток
    {
      const outer = tips
        .filter((t) => t.big)
        .map((t) => ({ t, r: Math.hypot(t.p.x - canopyCenter.x, t.p.z - canopyCenter.z) }))
        .sort((a, b) => b.r - a.r);
      const picked = [];
      for (const o of outer) {
        if (picked.length >= 6) break;
        // не две кисти рядом
        if (picked.some((q) => q.p.distanceTo(o.t.p) < 0.55)) continue;
        picked.push(o.t);
      }
      for (const t of picked) {
        const out = new THREE.Vector3(t.p.x - canopyCenter.x, 0, t.p.z - canopyCenter.z).normalize();
        // короткие плотные «кисти»: шарики сильно перекрываются, читаются как свисающая ветка в цвету,
        // а не как бусы (rng() вызывается столько же раз, чтобы не сдвинуть остальную генерацию)
        const len = 0.13 + rng() * 0.1;
        const n = 3;
        for (let k = 0; k < n; k++) {
          const u = (k + 1) / n;
          blobs.push({
            p: t.p.clone().addScaledVector(out, 0.04 + u * 0.05).add(new THREE.Vector3((rng() - 0.5) * 0.04, -len * u, (rng() - 0.5) * 0.04)),
            s: lerp(0.13, 0.085, u) * grow,
            droop: true,
          });
        }
      }
    }
    // «облачко» листвы: не идеальная сфера, а комок с буграми (шум по нормали) и гладкими нормалями;
    // каждому инстансу — свой случайный поворот, так что одинаковые бугры не повторяются на глаз
    let geo = new THREE.IcosahedronGeometry(1, lite ? 1 : 2);
    geo.deleteAttribute('normal');
    geo.deleteAttribute('uv');
    geo = mergeVertices(geo);
    {
      const pos = geo.attributes.position;
      const v = new THREE.Vector3();
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i);
        const d = 1 + 0.13 * noise.noise3d(v.x * 1.7 + 3.1, v.y * 1.7 - 0.6, v.z * 1.7 - 1.7)
                    + 0.05 * noise.noise3d(v.x * 4.1 - 2.3, v.y * 4.1 + 1.9, v.z * 4.1 + 0.4);
        v.multiplyScalar(d);
        pos.setXYZ(i, v.x, v.y, v.z);
      }
      geo.computeVertexNormals();
    }
    const foliagePatch = {
        uniforms: {
          uTime: U.uTime, uParty: U.uParty, uShake: U.uShake,
          uRimCol: { value: new THREE.Color('#ffc2e2') },
        },
        vertHead: 'uniform float uTime; uniform float uShake; varying float vPhase;',
        vertBody: /* glsl */ `
          #ifdef USE_INSTANCING
            vec3 ip = instanceMatrix[3].xyz;
            float isc = max(0.08, length(instanceMatrix[0].xyz));
          #else
            vec3 ip = vec3(0.0); float isc = 1.0;
          #endif
          float hk = smoothstep(0.6, 2.4, ip.y);
          vec3 sway = vec3(sin(uTime * 1.4 + ip.x * 1.7 + ip.z * 1.1), 0.35 * sin(uTime * 2.0 + ip.y * 3.0), cos(uTime * 1.2 + ip.z * 1.9)) * 0.025;
          vec3 shake = vec3(sin(uTime * 23.0 + ip.y * 5.0), 0.6 * cos(uTime * 19.0 + ip.x * 4.0), cos(uTime * 21.0 + ip.z * 5.0)) * uShake * 0.09;
          transformed += (sway + shake) * hk / isc;
          vPhase = ip.x * 0.22 + ip.y * 0.3 + ip.z * 0.17;`,
        fragHead: 'uniform float uTime; uniform float uParty; uniform vec3 uRimCol; varying float vPhase;' + GLSL_RAINBOW,
        fragBody: /* glsl */ `
          {
            vec3 rb = sk_rainbow(fract(vPhase + uTime * 0.35));
            diffuseColor.rgb = mix(diffuseColor.rgb, rb * (0.3 + 0.9 * sk_luma(diffuseColor.rgb)), uParty * 0.85);
            totalEmissiveRadiance += diffuseColor.rgb * (0.16 + 0.25 * uParty);
            vec3 V = normalize(vViewPosition);
            float fres = pow(1.0 - clamp(abs(dot(normal, V)), 0.0, 1.0), 2.4);
            // мягкая розовая кайма по краю — будто крону подсвечивают сзади
            totalEmissiveRadiance += mix(uRimCol, diffuseColor.rgb * 1.6, 0.45) * fres * 0.6;
          }`,
    };
    // матовая листва: без пластиковых бликов
    const mat = patchMaterial(
      new THREE.MeshStandardMaterial({ flatShading: false, roughness: 0.82, metalness: 0 }),
      'sk-foliage',
      foliagePatch
    );
    foliage = new THREE.InstancedMesh(geo, mat, blobs.length);
    const palette = [
      ['#ffb3d4', 0.28], ['#ff8cc6', 0.26], ['#ffd2e7', 0.16], ['#f56aab', 0.16], ['#e2a3ff', 0.08], ['#ffe9f4', 0.06],
    ];
    const pick = () => {
      let r = rng();
      for (const [c, w] of palette) { if ((r -= w) <= 0) return c; }
      return palette[0][0];
    };
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const col = new THREE.Color();
    const base = new THREE.Color('#ff9ccc');
    const light = new THREE.Color('#fff0f7');
    const dark = new THREE.Color('#d94f95');
    const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
    blobs.forEach((b, i) => {
      e.set(rng() * TAU, rng() * TAU, rng() * TAU);
      q.setFromEuler(e);
      m.compose(b.p, q, new THREE.Vector3(b.s, b.s * 0.82, b.s));
      foliage.setMatrixAt(i, m);
      const h = Math.max(0, (b.p.y - minY) / Math.max(0.001, maxY - minY));
      pick(); // оставляем вызов rng(), чтобы не сдвигать остальную процедурную генерацию
      // плавное цветовое поле вместо случайной палитры: сверху светлее (свет луны), снизу глубже,
      // плюс крупный мягкий шум ±8% — соседние облачка не контрастируют, как горох
      col.copy(base);
      col.lerp(light, smooth(0.45, 1.0, h) * 0.6);
      col.lerp(dark, (1 - smooth(0.0, 0.42, h)) * 0.55);
      if (b.droop) col.lerp(light, 0.18);
      const nv = noise.noise3d(b.p.x * 1.3 + 7.7, b.p.y * 1.3, b.p.z * 1.3 - 4.2);
      col.offsetHSL(nv * 0.012, 0, nv * 0.06);
      foliage.setColorAt(i, col);
    });
    foliage.userData.kind = 'tree';
    treeGroup.add(foliage);

    // мелкие пятилепестковые цветы по внешней поверхности кроны: дают «цветочную» фактуру
    // и ломают круглые силуэты облачков
    {
      const brng = mulberry32(777001);
      const N = lite ? 150 : 320;
      const R = 1;
      const SEG = 40;
      const verts = [0, 0, 0.18];
      const cols = [1.0, 0.36, 0.64];
      const centre = new THREE.Color('#ff5fa6');
      const edge = new THREE.Color('#fff4fa');
      for (let k = 0; k <= SEG; k++) {
        const th = (k / SEG) * TAU;
        // 5 лепестков с выемкой на кончике
        const pet = Math.pow(Math.abs(Math.cos(2.5 * th)), 0.55);
        const notch = 1 - 0.18 * Math.pow(Math.abs(Math.cos(2.5 * th)), 24);
        const r = R * (0.38 + 0.62 * pet) * notch;
        verts.push(Math.cos(th) * r, Math.sin(th) * r, -0.08 * r);
        const c = centre.clone().lerp(edge, Math.min(1, 0.35 + r * 0.8));
        cols.push(c.r, c.g, c.b);
      }
      const idx = [];
      for (let k = 1; k <= SEG; k++) idx.push(0, k, k + 1);
      const fgeo = new THREE.BufferGeometry();
      fgeo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
      fgeo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
      fgeo.setIndex(idx);
      fgeo.computeVertexNormals();
      const fmat = patchMaterial(
        new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.75, metalness: 0 }),
        'sk-blossom',
        foliagePatch
      );
      const shell = blobs.filter((b) => !b.droop);
      const flowers = new THREE.InstancedMesh(fgeo, fmat, N);
      const fm = new THREE.Matrix4();
      const fq = new THREE.Quaternion();
      const spin = new THREE.Quaternion();
      const Z = new THREE.Vector3(0, 0, 1);
      const d = new THREE.Vector3();
      const outv = new THREE.Vector3();
      const fp = new THREE.Vector3();
      const fc = new THREE.Color();
      let placed = 0;
      for (let tries = 0; tries < N * 30 && placed < N; tries++) {
        const b = shell[(brng() * shell.length) | 0];
        d.set(brng() - 0.5, brng() - 0.5, brng() - 0.5);
        if (d.lengthSq() < 1e-4) continue;
        d.normalize();
        outv.subVectors(b.p, canopyCenter);
        outv.y *= 0.6;
        outv.normalize();
        // только наружная и верхняя сторона облачка — внутри кроны цветов всё равно не видно
        if (d.dot(outv) < -0.05 || d.y < -0.35) continue;
        fp.set(d.x * b.s, d.y * b.s * 0.82, d.z * b.s).multiplyScalar(1.03).add(b.p);
        fq.setFromUnitVectors(Z, d);
        spin.setFromAxisAngle(Z, brng() * TAU);
        fq.multiply(spin);
        const sc = (0.042 + brng() * 0.03) * (lite ? 1.25 : 1);
        fm.compose(fp, fq, new THREE.Vector3(sc, sc, sc));
        flowers.setMatrixAt(placed, fm);
        fc.setHSL(0.94 + brng() * 0.03, 0.55 + brng() * 0.3, 0.9 + brng() * 0.08);
        flowers.setColorAt(placed, fc);
        placed++;
      }
      flowers.count = placed;
      flowers.userData.kind = 'tree';
      treeGroup.add(flowers);
    }

    const cg = makeGlow('#ff7cc0', 4.6, 0.2);
    cg.position.copy(canopyCenter);
    treeGroup.add(cg);
  }

  // ------------------------------------------------------------ torii + lantern
  {
    const red = '#e5304f', black = '#1c0f22';
    const parts = [];
    const add = (geo, opts, color) => parts.push(prep(place(geo, opts), color));
    for (const sx of [-1, 1]) {
      add(new THREE.CylinderGeometry(0.03, 0.038, 0.52, 7), { x: sx * 0.19, y: 0.26 }, red);
      add(new THREE.CylinderGeometry(0.048, 0.052, 0.05, 7), { x: sx * 0.19, y: 0.025 }, black);
      add(new THREE.BoxGeometry(0.11, 0.042, 0.08), { x: sx * 0.34, y: 0.548, rz: sx * 0.22 }, black);
    }
    add(new THREE.BoxGeometry(0.58, 0.044, 0.08), { y: 0.535 }, black);
    add(new THREE.BoxGeometry(0.54, 0.038, 0.065), { y: 0.495 }, red);
    add(new THREE.BoxGeometry(0.5, 0.03, 0.045), { y: 0.4 }, red);
    add(new THREE.BoxGeometry(0.035, 0.075, 0.03), { y: 0.45 }, red);
    const mat = patchMaterial(
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.1, envMap: envTex, envMapIntensity: 0.6 }),
      'sk-torii',
      {
        uniforms: { uRimCol: { value: new THREE.Color('#ff7aa8') } },
        fragHead: 'uniform vec3 uRimCol;',
        fragBody: /* glsl */ `
          #ifdef USE_COLOR
            totalEmissiveRadiance += vColor.rgb * vec3(0.35, 0.12, 0.16);
          #endif
          { vec3 V = normalize(vViewPosition); float fres = pow(1.0 - clamp(abs(dot(normal, V)), 0.0, 1.0), 2.5); totalEmissiveRadiance += uRimCol * fres * 0.5; }`,
      }
    );
    const torii = new THREE.Mesh(mergeGeometries(parts), mat);
    const tx = TORII_POS.x, tz = TORII_POS.y;
    torii.position.set(tx, surfaceY(tx, tz) - 0.01, tz);
    torii.rotation.y = 0.45;
    torii.scale.setScalar(1.15);
    spin.add(torii);
  }
  {
    const stone = '#6d5d86';
    const parts = [];
    const add = (geo, opts) => parts.push(prep(place(geo, opts), stone));
    add(new THREE.CylinderGeometry(0.1, 0.12, 0.05, 6), { y: 0.025 });
    add(new THREE.CylinderGeometry(0.032, 0.04, 0.17, 6), { y: 0.135 });
    add(new THREE.CylinderGeometry(0.1, 0.08, 0.035, 6), { y: 0.237 });
    add(new THREE.ConeGeometry(0.16, 0.085, 6), { y: 0.39 });
    add(new THREE.IcosahedronGeometry(0.028, 0), { y: 0.45 });
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      add(new THREE.BoxGeometry(0.018, 0.1, 0.018), { x: sx * 0.052, y: 0.3, z: sz * 0.052 });
    }
    const lantern = new THREE.Group();
    lantern.add(new THREE.Mesh(mergeGeometries(parts), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true })));
    const fire = new THREE.Mesh(
      new THREE.BoxGeometry(0.085, 0.085, 0.085),
      new THREE.MeshBasicMaterial({ color: new THREE.Color('#ffc983').multiplyScalar(1.6), toneMapped: false })
    );
    fire.position.y = 0.3;
    lantern.add(fire);
    const lg = makeGlow('#ffb35c', 0.9, 0.75);
    lg.position.y = 0.3;
    lantern.add(lg);
    const pl = new THREE.PointLight('#ffb067', 3.2, 3, 2);
    pl.position.y = 0.32;
    lantern.add(pl);
    const lx = 0.95, lz = 0.75;
    lantern.position.set(lx, surfaceY(lx, lz) - 0.01, lz);
    lantern.scale.setScalar(1.2);
    spin.add(lantern);
  }

  // ------------------------------------------------------------ halo ring behind the tree + magic circle below
  const haloMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: U.uTime, uParty: U.uParty, uOpacity: { value: 0 },
      uColA: { value: new THREE.Color(theme.pink) }, uColB: { value: new THREE.Color(theme.violet) },
    },
    vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      varying vec2 vUv; uniform float uTime; uniform float uParty; uniform float uOpacity; uniform vec3 uColA; uniform vec3 uColB;
      ${GLSL_RAINBOW}
      void main(){
        vec2 p = vUv * 2.0 - 1.0;
        float r = length(p);
        float a = atan(p.y, p.x);
        float ring = exp(-pow((r - 0.8) / 0.008, 2.0)) * 0.5;
        float soft = exp(-pow((r - 0.8) / 0.09, 2.0)) * 0.12;
        float fill = smoothstep(0.82, 0.0, r) * 0.05;
        float outer = exp(-pow((r - 0.93) / 0.004, 2.0)) * 0.3 * (0.35 + 0.65 * sin(a * 2.0 - uTime * 0.35));
        float ticks = step(0.6, fract(a / 6.2831853 * 120.0 + uTime * 0.02)) * exp(-pow((r - 0.87) / 0.006, 2.0)) * 0.1;
        float fadeLow = 0.55 + 0.45 * smoothstep(-0.9, 0.4, p.y);
        ring *= fadeLow; soft *= fadeLow; outer *= fadeLow; ticks *= fadeLow;
        vec3 col = mix(uColA, uColB, 0.5 + 0.5 * sin(a + uTime * 0.25));
        col = mix(col, vec3(1.0, 0.92, 0.97), 0.25);
        col = mix(col, sk_rainbow(fract(a / 6.2831853 + uTime * 0.2)), uParty * 0.9);
        float v = (ring + soft + fill + outer + ticks) * uOpacity * smoothstep(1.0, 0.96, r);
        gl_FragColor = vec4(col * v, 0.0);
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, premultipliedAlpha: true,
  });
  const halo = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), haloMat);
  const HALO_R = 2.35;
  halo.scale.setScalar(HALO_R * 2);
  halo.position.set(0, canopyCenter.y + TREE_BASE.y - 0.25, -1.6);
  heroRoot.add(halo);

  const circleMat = new THREE.ShaderMaterial({
    uniforms: { uTime: U.uTime, uParty: U.uParty, uOpacity: { value: 0 }, uCol: { value: new THREE.Color(theme.violet) }, uCol2: { value: new THREE.Color(theme.pink) } },
    vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      varying vec2 vUv; uniform float uTime; uniform float uParty; uniform float uOpacity; uniform vec3 uCol; uniform vec3 uCol2;
      ${GLSL_RAINBOW}
      void main(){
        vec2 p = vUv * 2.0 - 1.0;
        float r = length(p);
        float a = atan(p.y, p.x);
        float r1 = exp(-pow((r - 0.92) / 0.01, 2.0));
        float r2 = exp(-pow((r - 0.8) / 0.006, 2.0)) * 0.6;
        float dash = step(0.5, fract(a / 6.2831853 * 48.0 - uTime * 0.05)) * exp(-pow((r - 0.86) / 0.012, 2.0)) * 0.35;
        float glow = exp(-pow((r - 0.86) / 0.12, 2.0)) * 0.12;
        vec3 col = mix(uCol, uCol2, 0.5 + 0.5 * sin(a * 2.0 + uTime * 0.4));
        col = mix(col, sk_rainbow(fract(a / 6.2831853 - uTime * 0.25)), uParty * 0.9);
        float v = (r1 + r2 + dash + glow) * uOpacity * smoothstep(1.0, 0.97, r);
        gl_FragColor = vec4(col * v, 0.0);
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, premultipliedAlpha: true, side: THREE.DoubleSide,
  });
  const magic = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), circleMat);
  magic.rotation.x = -Math.PI / 2;
  magic.scale.setScalar(4.6);
  magic.position.y = -0.55;
  heroRoot.add(magic);

  // ------------------------------------------------------------ fireflies around the island
  const FLY_N = 64;
  const flyMat = new THREE.ShaderMaterial({
    uniforms: { uTime: U.uTime, uParty: U.uParty, uVis: { value: 0 }, uPx: { value: 600 } },
    vertexShader: /* glsl */ `
      attribute float aSeed;
      uniform float uTime; uniform float uVis; uniform float uPx;
      varying float vA; varying float vSeed;
      void main(){
        float s = aSeed;
        float cyc = fract(uTime * (0.025 + 0.035 * fract(s * 7.31)) + s);
        vec3 p = position;
        p.y += cyc * 2.6 - 0.7;
        p.x += sin(uTime * 0.6 + s * 20.0) * 0.22;
        p.z += cos(uTime * 0.5 + s * 13.0) * 0.22;
        vA = smoothstep(0.0, 0.15, cyc) * smoothstep(1.0, 0.75, cyc) * (0.45 + 0.55 * sin(uTime * 2.6 + s * 40.0)) * uVis;
        vSeed = s;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        float sc = length(modelMatrix[0].xyz);
        gl_PointSize = clamp((0.05 + 0.04 * fract(s * 3.7)) * sc * uPx / -mv.z, 1.0, 48.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform float uParty; varying float vA; varying float vSeed;
      ${GLSL_RAINBOW}
      void main(){
        vec2 q = gl_PointCoord * 2.0 - 1.0;
        float d = dot(q, q);
        float a = exp(-d * 5.0) + smoothstep(0.12, 0.0, d);
        vec3 col = mix(vec3(1.0, 0.82, 0.92), vec3(0.85, 0.75, 1.0), step(0.5, fract(vSeed * 9.1)));
        col = mix(col, sk_rainbow(fract(vSeed + uTime * 0.4)), uParty * 0.8);
        gl_FragColor = vec4(col * a * vA, 0.0);
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, premultipliedAlpha: true,
  });
  {
    const g = new THREE.BufferGeometry();
    const p = new Float32Array(FLY_N * 3);
    const s = new Float32Array(FLY_N);
    for (let i = 0; i < FLY_N; i++) {
      const ang = rng() * TAU;
      const r = 0.6 + rng() * 2.4;
      p[i * 3] = Math.cos(ang) * r;
      p[i * 3 + 1] = -1.6 + rng() * 3.6;
      p[i * 3 + 2] = Math.sin(ang) * r;
      s[i] = rng();
    }
    g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(s, 1));
    const pts = new THREE.Points(g, flyMat);
    pts.frustumCulled = false;
    heroRoot.add(pts);
  }

  // ------------------------------------------------------------ orbiting 3D logos
  const ORBITS = [
    { r: 2.92, tx: 0.34, tz: 0.24, y: 1.1 },
    { r: 3.08, tx: 0.2, tz: -0.3, y: 1.25 },
    { r: 2.8, tx: 0.4, tz: -0.06, y: 0.95 },
    { r: 3.18, tx: 0.12, tz: 0.34, y: 1.35 },
    { r: 3.0, tx: 0.3, tz: -0.18, y: 0.85 },
    { r: 2.86, tx: 0.24, tz: 0.12, y: 1.45 },
  ];
  const MAX_LOGOS = ORBITS.length;
  const orbitPoint = (o, ang, out) => {
    out.set(Math.cos(ang) * o.r, 0, Math.sin(ang) * o.r);
    out.applyEuler(o.euler);
    out.y += o.y;
    return out;
  };
  ORBITS.forEach((o) => { o.euler = new THREE.Euler(o.tx, 0, o.tz); });
  const LOGO_SIZE = 0.8;
  // 3D-цвета брендов: cap — лицевая сторона, accent — кайма/свечение/хвост орбиты.
  // Steam — тёмно-синий диск с голубой каймой (иначе он, как и GitHub, читается белым кругом)
  const BRAND3D = {
    steam: { cap: '#1b2838', accent: '#66c0f4', side: '#2a475e' },
  };
  const shown = links.slice(0, MAX_LOGOS);
  const logos = shown.map((link, i) => {
    const o = ORBITS[i % ORBITS.length];
    const group = new THREE.Group();
    const spinner = new THREE.Group();
    group.add(spinner);
    const b3 = BRAND3D[link.id] || {};
    const col = new THREE.Color(b3.cap || link.color || theme.pink);
    const accent = new THREE.Color(b3.accent || link.color || theme.pink);
    const uHover = { value: 0 };
    const rimCol = b3.accent ? accent.clone() : accent.clone().lerp(new THREE.Color('#ffffff'), 0.5);
    const capMat = patchMaterial(
      new THREE.MeshPhysicalMaterial({
        color: col, metalness: 0.15, roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.08,
        emissive: col, emissiveIntensity: 0.22, envMap: envTex, envMapIntensity: 0.7,
      }),
      'sk-logo',
      {
        uniforms: { uHover, uRimCol: { value: rimCol } },
        fragHead: 'uniform float uHover; uniform vec3 uRimCol;',
        fragBody: /* glsl */ `{
          vec3 V = normalize(vViewPosition);
          float fres = pow(1.0 - clamp(abs(dot(normal, V)), 0.0, 1.0), 2.0);
          totalEmissiveRadiance += uRimCol * fres * (0.5 + 1.2 * uHover) + emissive * uHover * 0.9;
        }`,
      }
    );
    const sideMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(b3.side || col).lerp(new THREE.Color('#ffffff'), 0.25), metalness: 1, roughness: 0.16,
      emissive: b3.accent ? accent : col, emissiveIntensity: 0.18, envMap: envTex, envMapIntensity: 1.8,
    });
    let geo;
    try {
      geo = createLogoGeometry(icons[link.id], LOGO_SIZE);
    } catch (e) {
      console.warn('[sempik] логотип не собрался', link.id, e);
      geo = new THREE.CylinderGeometry(LOGO_SIZE / 2, LOGO_SIZE / 2, 0.1, 32).rotateX(Math.PI / 2);
    }
    const mesh = new THREE.Mesh(geo, [capMat, sideMat]);
    spinner.add(mesh);
    const glow = makeGlow(accent, 1.9, 0.32);
    group.add(glow);
    const hit = new THREE.Mesh(new THREE.SphereGeometry(0.58, 12, 8), new THREE.MeshBasicMaterial({ visible: false }));
    hit.userData = { kind: 'logo', index: i };
    group.add(hit);
    orbitGroup.add(group);
    return {
      link, i, o, group, spinner, glow, hit, col, accent, uHover, capMat,
      phase: (i / Math.max(1, shown.length)) * TAU + 0.4,
      delay: 0.55 + i * 0.16, dur: 1.25,
      hoverK: 0, pulse: 0, spinT: 1,
      start: new THREE.Vector3(), target: new THREE.Vector3(),
    };
  });

  // светящиеся «хвосты» орбит
  const TRAIL_N = 180;
  const trailMat = new THREE.ShaderMaterial({
    uniforms: {
      uHead: { value: new Array(MAX_LOGOS).fill(0) },
      uVis: { value: new Array(MAX_LOGOS).fill(0) },
      uCol: { value: ORBITS.map((_, i) => (logos[i]?.accent || new THREE.Color(theme.pink)).clone().lerp(new THREE.Color('#ffffff'), 0.25)) },
      uPx: { value: 600 }, uParty: U.uParty, uTime: U.uTime,
    },
    vertexShader: /* glsl */ `
      attribute float aAng; attribute float aOrbit;
      uniform float uHead[${MAX_LOGOS}]; uniform float uVis[${MAX_LOGOS}]; uniform vec3 uCol[${MAX_LOGOS}]; uniform float uPx;
      varying vec3 vCol; varying float vA;
      void main(){
        int oi = int(aOrbit + 0.5);
        float head = uHead[oi];
        float d = fract((head - aAng) / 6.2831853);
        float trail = pow(1.0 - d, 9.0);
        vA = 0.9 * trail * uVis[oi];
        vCol = uCol[oi];
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float sc = length(modelMatrix[0].xyz);
        gl_PointSize = clamp((0.028 + 0.03 * trail) * sc * uPx / -mv.z, 1.0, 16.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vCol; varying float vA;
      void main(){
        vec2 q = gl_PointCoord * 2.0 - 1.0;
        float d = dot(q, q);
        float a = smoothstep(1.0, 0.0, d);
        gl_FragColor = vec4(vCol * a * vA * 0.9, 0.0);
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, premultipliedAlpha: true,
  });
  if (logos.length) {
    const g = new THREE.BufferGeometry();
    const n = logos.length * TRAIL_N;
    const p = new Float32Array(n * 3);
    const ang = new Float32Array(n);
    const ob = new Float32Array(n);
    const v = new THREE.Vector3();
    logos.forEach((L, li) => {
      for (let k = 0; k < TRAIL_N; k++) {
        const a = (k / TRAIL_N) * TAU;
        orbitPoint(L.o, a, v);
        const j = li * TRAIL_N + k;
        p[j * 3] = v.x; p[j * 3 + 1] = v.y; p[j * 3 + 2] = v.z;
        ang[j] = a; ob[j] = li;
      }
    });
    g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    g.setAttribute('aAng', new THREE.BufferAttribute(ang, 1));
    g.setAttribute('aOrbit', new THREE.BufferAttribute(ob, 1));
    const pts = new THREE.Points(g, trailMat);
    pts.frustumCulled = false;
    orbitGroup.add(pts);
  }

  // ------------------------------------------------------------ hero bounds (for layout)
  const HERO = (() => {
    spin.updateMatrixWorld(true);
    const box = new THREE.Box3();
    box.expandByObject(islandMesh);
    box.expandByObject(trunk);
    box.expandByObject(foliage);
    box.expandByObject(crystals);
    let maxR = 0;
    // остров вращается — берём радиус в плоскости XZ
    for (const c of [box.min, box.max]) maxR = Math.max(maxR, Math.abs(c.x), Math.abs(c.z));
    let minX = -maxR, maxX = maxR, minY = box.min.y, maxY = box.max.y;
    const v = new THREE.Vector3();
    const lr = LOGO_SIZE * 0.6;
    for (const L of logos) {
      for (let k = 0; k < 96; k++) {
        orbitPoint(L.o, (k / 96) * TAU, v);
        const persp = 1 + v.z * 0.06; // ближняя к камере часть орбиты кажется крупнее
        minX = Math.min(minX, (v.x - lr) * persp); maxX = Math.max(maxX, (v.x + lr) * persp);
        minY = Math.min(minY, (v.y - lr) * persp); maxY = Math.max(maxY, (v.y + lr) * persp);
      }
    }
    maxY = Math.max(maxY, halo.position.y + HALO_R * 0.82);
    const halfW = Math.max(Math.abs(minX), Math.abs(maxX));
    // «ядро» — сам остров с деревом (без орбит и гало): по нему кот понимает, где 3D-герой
    const core = { halfW: maxR, top: box.max.y, bottom: box.min.y };
    return { w: halfW * 2, h: maxY - minY, cy: (maxY + minY) / 2, core };
  })();

  // ------------------------------------------------------------ petals
  // лепестков немного: это атмосфера, а не метель (и ближние к камере — мягкие и полупрозрачные)
  const PETAL_MAX = reduced ? 90 : 170;
  let petalMul = 1; // понижается «губернатором» кадров на слабых устройствах
  const petalCount = () => Math.round((reduced ? 70 : isMobile() ? 80 : 170) * petalMul);
  const BURST_N = 110;
  const petalGeo = makePetalGeometry();
  {
    const seeds = new Float32Array(Math.max(PETAL_MAX, BURST_N));
    for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();
    petalGeo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 1));
  }
  const petalMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: U.uTime, uParty: U.uParty, uFar: { value: new THREE.Color('#8f7ad8') },
      // экранная «чистая зона» вокруг острова: центр (NDC), радиус (в долях высоты NDC), соотношение сторон
      uHero: { value: new THREE.Vector4(0.36, 0, 0.5, 1.6) },
    },
    vertexShader: /* glsl */ `
      attribute vec3 aCol; attribute float aSeed;
      uniform vec4 uHero;
      varying vec3 vCol; varying float vSeed; varying float vShade; varying float vAlpha; varying float vFar;
      void main(){
        #ifdef USE_INSTANCING
          mat4 im = instanceMatrix;
        #else
          mat4 im = mat4(1.0);
        #endif
        vec4 wp = modelMatrix * im * vec4(position, 1.0);
        vec3 n = normalize(mat3(modelMatrix) * mat3(im) * normal);
        vec3 vd = normalize(cameraPosition - wp.xyz);
        float facing = abs(dot(n, vd));
        float lit = abs(dot(n, normalize(vec3(-0.35, 0.8, 0.45))));
        vShade = 0.6 + 0.35 * lit + 0.6 * pow(facing, 14.0);
        vec4 mv = viewMatrix * wp;
        float d = -mv.z;
        // близкие к камере — мягкие и полупрозрачные, дальние — чуть тусклее
        vAlpha = (smoothstep(2.5, 7.0, d) * 0.55 + 0.45 * smoothstep(5.0, 8.0, d)) * (1.0 - 0.35 * smoothstep(16.0, 24.0, d));
        vFar = smoothstep(9.0, 24.0, d);
        vCol = aCol; vSeed = aSeed;
        gl_Position = projectionMatrix * mv;
        // перед островом лепестки вдвое прозрачнее — герой остаётся чистым
        vec2 ndc = gl_Position.xy / max(gl_Position.w, 1e-3);
        float hr = length((ndc - uHero.xy) * vec2(uHero.w, 1.0)) / max(uHero.z, 1e-3);
        vAlpha *= mix(0.5, 1.0, smoothstep(0.7, 1.05, hr));
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform float uParty; uniform vec3 uFar;
      varying vec3 vCol; varying float vSeed; varying float vShade; varying float vAlpha; varying float vFar;
      ${GLSL_RAINBOW}
      void main(){
        vec3 c = vCol;
        c = mix(c, c * vec3(1.0, 0.72, 0.88), step(0.72, vSeed) * 0.7);
        c = mix(c, vec3(1.0, 0.96, 0.98), step(vSeed, 0.14) * 0.45);
        c *= vShade;
        c = mix(c, uFar * (0.35 + 0.6 * sk_luma(c)), vFar * 0.55);
        c = mix(c, sk_rainbow(fract(vSeed * 3.0 + uTime * 0.3)) * (0.45 + 0.8 * sk_luma(c)), uParty * 0.85);
        gl_FragColor = vec4(c, vAlpha);
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
  });
  const petals = new THREE.InstancedMesh(petalGeo, petalMat, PETAL_MAX);
  petals.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  petals.frustumCulled = false;
  petals.count = Math.min(PETAL_MAX, petalCount());
  scene.add(petals);
  const burst = new THREE.InstancedMesh(petalGeo, petalMat, BURST_N);
  burst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  burst.frustumCulled = false;
  scene.add(burst);

  // ------------------------------------------------------------ sparks (click bursts)
  const SPARK_N = 240;
  const spark = {
    pos: new Float32Array(SPARK_N * 3), vel: new Float32Array(SPARK_N * 3), col: new Float32Array(SPARK_N * 3),
    alpha: new Float32Array(SPARK_N), size: new Float32Array(SPARK_N), life: new Float32Array(SPARK_N), max: new Float32Array(SPARK_N),
    next: 0, active: 0,
  };
  const sparkGeo = new THREE.BufferGeometry();
  sparkGeo.setAttribute('position', new THREE.BufferAttribute(spark.pos, 3).setUsage(THREE.DynamicDrawUsage));
  sparkGeo.setAttribute('aColor', new THREE.BufferAttribute(spark.col, 3).setUsage(THREE.DynamicDrawUsage));
  sparkGeo.setAttribute('aAlpha', new THREE.BufferAttribute(spark.alpha, 1).setUsage(THREE.DynamicDrawUsage));
  sparkGeo.setAttribute('aSize', new THREE.BufferAttribute(spark.size, 1).setUsage(THREE.DynamicDrawUsage));
  const sparkMat = new THREE.ShaderMaterial({
    uniforms: { uPx: { value: 600 } },
    vertexShader: /* glsl */ `
      attribute vec3 aColor; attribute float aAlpha; attribute float aSize; uniform float uPx;
      varying vec3 vCol; varying float vA;
      void main(){
        vCol = aColor; vA = aAlpha;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aAlpha > 0.001 ? clamp(aSize * uPx / -mv.z, 1.0, 40.0) : 0.0;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vCol; varying float vA;
      void main(){
        vec2 q = gl_PointCoord * 2.0 - 1.0;
        float d = dot(q, q);
        float a = exp(-d * 4.5) * 0.8 + smoothstep(0.1, 0.0, d);
        gl_FragColor = vec4(vCol * a * vA, 0.0);
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, premultipliedAlpha: true,
  });
  const sparks = new THREE.Points(sparkGeo, sparkMat);
  sparks.frustumCulled = false;
  scene.add(sparks);

  const tmpCol = new THREE.Color();
  function emitSparks(at, color, count, speed = 1.6) {
    const c = new THREE.Color(color);
    for (let k = 0; k < count; k++) {
      const i = spark.next;
      spark.next = (spark.next + 1) % SPARK_N;
      const dir = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
      const sp = speed * (0.35 + Math.random() * 0.75);
      spark.pos[i * 3] = at.x; spark.pos[i * 3 + 1] = at.y; spark.pos[i * 3 + 2] = at.z;
      spark.vel[i * 3] = dir.x * sp; spark.vel[i * 3 + 1] = dir.y * sp + 0.3; spark.vel[i * 3 + 2] = dir.z * sp;
      tmpCol.copy(c).lerp(new THREE.Color('#ffffff'), Math.random() * 0.6);
      spark.col[i * 3] = tmpCol.r; spark.col[i * 3 + 1] = tmpCol.g; spark.col[i * 3 + 2] = tmpCol.b;
      spark.max[i] = spark.life[i] = 0.6 + Math.random() * 0.8;
      spark.size[i] = 0.05 + Math.random() * 0.07;
    }
    spark.active = 2.0;
  }

  // ------------------------------------------------------------ petal simulation
  const rays = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const CORNERS = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
  function updateRays() {
    for (let i = 0; i < 4; i++) {
      rays[i].set(CORNERS[i][0], CORNERS[i][1], 0.5).unproject(camera).sub(camera.position).normalize();
    }
  }
  const B = { x0: 0, x1: 0, y0: 0, y1: 0 };
  function boundsAtZ(z) {
    const cp = camera.position;
    B.x0 = Infinity; B.x1 = -Infinity; B.y0 = Infinity; B.y1 = -Infinity;
    for (let i = 0; i < 4; i++) {
      const r = rays[i];
      const t = (z - cp.z) / (r.z || -1e-4);
      const x = cp.x + r.x * t, y = cp.y + r.y * t;
      if (x < B.x0) B.x0 = x; if (x > B.x1) B.x1 = x;
      if (y < B.y0) B.y0 = y; if (y > B.y1) B.y1 = y;
    }
    return B;
  }
  const petalState = [];
  const randZ = () => (Math.random() < 0.04 ? lerp(6.5, 9.0, Math.random()) : lerp(-9, 6.5, Math.random()));
  function spawnPetal(p, initial) {
    p.z = randZ();
    const b = boundsAtZ(p.z);
    const w = b.x1 - b.x0;
    p.x = b.x0 - 0.15 * w + Math.random() * w * 1.15;
    p.y = initial ? lerp(b.y0, b.y1, Math.random()) : b.y1 + 0.2 + Math.random() * 0.8;
    p.vy = 0.28 + Math.random() * 0.34;
    p.sw = 0.15 + Math.random() * 0.35;
    p.f = 0.6 + Math.random() * 1.1;
    p.ph = Math.random() * TAU;
    p.rx = Math.random() * TAU; p.ry = Math.random() * TAU; p.rz = Math.random() * TAU;
    p.wx = (Math.random() - 0.5) * 2.4; p.wy = (Math.random() - 0.5) * 2.0;
    p.rock = 0.5 + Math.random() * 0.9;
    p.s = 0.11 + Math.random() * 0.07;
  }
  const burstState = [];
  for (let i = 0; i < BURST_N; i++) burstState.push({ on: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, rx: 0, ry: 0, rz: 0, wx: 0, wy: 0, s: 0, life: 0, ph: 0 });
  let burstNext = 0;

  // ------------------------------------------------------------ layout
  const lay = { s: 1, cx: 0.68, cy: 0.5, ts: 1, tcx: 0.68, tcy: 0.5, w: 1, h: 1, ppw: 1, k: 1, ready: false };
  function computeLayout() {
    const w = Math.max(1, canvas.clientWidth || innerWidth);
    const h = Math.max(1, canvas.clientHeight || innerHeight);
    const mobile = w < 900;
    const dist = CAM_BASE.distanceTo(LOOK);
    const ppw = h / (2 * dist * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))); // px на единицу мира у центра
    let k;
    if (!mobile) {
      // на больших мониторах остров крупнее (иначе теряется в кольце видео)
      const t = clamp01((w - 1440) / 480);
      k = Math.min((lerp(0.52, 0.62, t) * h) / HERO.h, (lerp(0.44, 0.48, t) * w) / HERO.w);
      lay.tcx = lerp(0.68, 0.66, t); lay.tcy = 0.5;
    } else if (w > h && h <= 560) {
      // телефон боком: остров справа, карточка слева (см. css: orientation: landscape)
      k = Math.min((0.88 * h) / HERO.h, (0.42 * w) / HERO.w);
      lay.tcx = 0.75; lay.tcy = 0.5;
    } else {
      // телефон: остров сверху и поменьше, между ним и карточкой (44svh) остаётся воздух для кота
      k = Math.min((0.8 * w) / HERO.w, (0.28 * h) / HERO.h);
      lay.tcx = 0.5; lay.tcy = 0.22;
    }
    lay.ts = k / ppw;
    lay.w = w; lay.h = h; lay.ppw = ppw; lay.k = k;
  }
  // экранный прямоугольник «ядра» героя (остров + дерево), CSS px — для кота (куда ставить пузырь)
  function heroRect() {
    const k = lay.k;
    const cx = lay.tcx * lay.w, cy = lay.tcy * lay.h;
    const c = HERO.core;
    return {
      x: cx - c.halfW * k, w: c.halfW * 2 * k,
      y: cy - (c.top - HERO.cy) * k, h: (c.top - c.bottom) * k,
      mobile: lay.w < 900,
    };
  }
  function announceHero() {
    try {
      const detail = heroRect();
      window.__sempikHero = detail; // для модулей, которые подключатся позже
      window.dispatchEvent(new CustomEvent('sempik:hero', { detail }));
    } catch (_) { /* старый браузер */ }
  }
  function applyLayout(dt, snap) {
    if (snap || !lay.ready) {
      lay.s = lay.ts; lay.cx = lay.tcx; lay.cy = lay.tcy; lay.ready = true;
    } else {
      lay.s = damp(lay.s, lay.ts, 6, dt);
      lay.cx = damp(lay.cx, lay.tcx, 6, dt);
      lay.cy = damp(lay.cy, lay.tcy, 6, dt);
    }
    const { w, h } = lay;
    camera.setViewOffset(w, h, w / 2 - lay.cx * w, h / 2 - lay.cy * h, w, h);
  }

  let pxScale = 600;
  let pixelCap = Infinity; // потолок DPR от «губернатора» кадров
  function resize() {
    const w = Math.max(1, canvas.clientWidth || innerWidth);
    const h = Math.max(1, canvas.clientHeight || innerHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, w < 900 ? 1.5 : 2, pixelCap);
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    computeLayout();
    pxScale = (h * dpr) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
    flyMat.uniforms.uPx.value = pxScale;
    trailMat.uniforms.uPx.value = pxScale;
    sparkMat.uniforms.uPx.value = pxScale;
    const want = Math.min(PETAL_MAX, petalCount());
    if (want !== petals.count) petals.count = want;
    announceHero();
  }
  resize();
  applyLayout(0, true);
  camera.updateMatrixWorld(true);
  updateRays();
  for (let i = 0; i < PETAL_MAX; i++) { const p = {}; spawnPetal(p, true); petalState.push(p); }

  // ------------------------------------------------------------ interaction state
  let revealed = false;
  let revealT = 0;
  let time = 0;
  let party = false;
  let partyK = 0;
  let spinAngle = 0;
  let spinVel = 0; // инерция от перетаскивания
  let orbitAngle = 0;
  let orbitMul = 1;
  let hovered = -1;
  let overTree = false;
  let shakeT = 10;
  const pointer = { tx: 0, ty: 0, x: 0, y: 0, has: false };
  const drag = { down: false, id: -1, x: 0, lastX: 0, moved: 0, vel: 0, lastT: 0, suppressClick: false };

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const anchorCam = new THREE.PerspectiveCamera();
  const treeProxies = [islandMesh];
  {
    // невидимые «хитбоксы»: крона-эллипсоид + ствол — дешевле, чем рейкаст по сотням инстансов
    const inv = new THREE.MeshBasicMaterial({ visible: false });
    const crown = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), inv);
    const tb = new THREE.Box3();
    for (const t of tips) tb.expandByPoint(t.p);
    tb.getCenter(crown.position);
    const size = tb.getSize(new THREE.Vector3());
    crown.scale.set(size.x / 2 + 0.25, size.y / 2 + 0.25, size.z / 2 + 0.25);
    crown.userData.kind = 'tree';
    treeGroup.add(crown);
    const trunkProxy = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.28, 1.2, 8), inv);
    trunkProxy.position.y = 0.55;
    trunkProxy.userData.kind = 'tree';
    treeGroup.add(trunkProxy);
    treeProxies.push(crown, trunkProxy);
  }
  const pickables = [...logos.map((L) => L.hit), ...treeProxies];

  function pick(clientX, clientY) {
    if (!revealed || revealT < 0.9) return null;
    const rect = canvas.getBoundingClientRect();
    ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(pickables, false);
    for (const h of hits) {
      const u = h.object.userData;
      if (u.kind === 'logo') {
        const L = logos[u.index];
        if (L && revealT > L.delay + L.dur * 0.8) return { kind: 'logo', L };
      } else if (u.kind === 'tree') return { kind: 'tree' };
    }
    return null;
  }

  function setCursor() {
    canvas.style.cursor = drag.down && drag.moved > 5 ? 'grabbing' : hovered >= 0 || overTree ? 'pointer' : '';
  }

  function onPointerMove(e) {
    if (e.pointerType === 'mouse') {
      pointer.tx = (e.clientX / innerWidth) * 2 - 1;
      pointer.ty = (e.clientY / innerHeight) * 2 - 1;
      pointer.has = true;
    }
  }
  window.addEventListener('pointermove', onPointerMove, { passive: true });

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    drag.down = true; drag.id = e.pointerId; drag.x = drag.lastX = e.clientX; drag.moved = 0; drag.vel = 0;
    drag.lastT = performance.now();
    drag.suppressClick = false;
    try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (drag.down && e.pointerId === drag.id) {
      const dx = e.clientX - drag.lastX;
      drag.lastX = e.clientX;
      drag.moved += Math.abs(dx);
      const now = performance.now();
      const dts = Math.max(0.008, (now - drag.lastT) / 1000);
      drag.lastT = now;
      if (drag.moved > 5 && revealed) {
        const k = 0.0085;
        spinAngle += dx * k;
        drag.vel = lerp(drag.vel, (dx * k) / dts, 0.35);
        drag.suppressClick = true;
        if (hovered >= 0) hovered = -1;
      }
      setCursor();
      return;
    }
    if (e.pointerType !== 'mouse') return;
    const hit = pick(e.clientX, e.clientY);
    const idx = hit?.kind === 'logo' ? hit.L.i : -1;
    if (idx !== hovered) {
      if (idx >= 0) { logos[idx].spinT = 0; sfx('tick'); }
      hovered = idx;
    }
    overTree = hit?.kind === 'tree';
    setCursor();
  });
  const endDrag = (e) => {
    if (!drag.down || (e && e.pointerId !== drag.id)) return;
    drag.down = false;
    if (drag.moved > 5) spinVel = THREE.MathUtils.clamp(drag.vel, -5, 5);
    try { canvas.releasePointerCapture(drag.id); } catch (_) { /* ignore */ }
    setCursor();
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('pointerleave', () => { if (!drag.down) { hovered = -1; overTree = false; setCursor(); } });

  const tmpV = new THREE.Vector3();
  canvas.addEventListener('click', (e) => {
    if (drag.suppressClick) { drag.suppressClick = false; return; }
    const hit = pick(e.clientX, e.clientY);
    if (!hit) return;
    if (hit.kind === 'logo') {
      const L = hit.L;
      L.pulse = 1;
      if (e.pointerType !== 'mouse') { hovered = L.i; L.spinT = 0; setTimeout(() => { if (hovered === L.i) hovered = -1; }, 900); }
      L.group.getWorldPosition(tmpV);
      emitSparks(tmpV, L.accent || theme.pink, 46, 1.9);
      sfx('pop');
      try { onLinkActivate?.(L.link); } catch (err) { console.error('[sempik] onLinkActivate', err); }
    } else {
      shakeTree();
    }
  });

  function shakeTree() {
    shakeT = 0;
    sfx('chime');
    // лепестки из кроны
    const m = new THREE.Matrix4();
    const wp = new THREE.Vector3();
    const center = canopyCenter.clone();
    treeGroup.localToWorld(center);
    const n = reduced ? 18 : 42;
    for (let k = 0; k < n; k++) {
      const i = (Math.random() * foliage.count) | 0;
      foliage.getMatrixAt(i, m);
      wp.setFromMatrixPosition(m);
      foliage.localToWorld(wp);
      const b = burstState[burstNext];
      burstNext = (burstNext + 1) % BURST_N;
      const out = wp.clone().sub(center).normalize();
      b.on = true; b.x = wp.x; b.y = wp.y; b.z = wp.z;
      const sp = 0.6 + Math.random() * 1.1;
      b.vx = out.x * sp + (Math.random() - 0.5) * 0.4;
      b.vy = Math.abs(out.y) * sp * 0.6 + 0.4 + Math.random() * 0.6;
      b.vz = out.z * sp + 0.35 + Math.random() * 0.5;
      b.rx = Math.random() * TAU; b.ry = Math.random() * TAU; b.rz = Math.random() * TAU;
      b.wx = (Math.random() - 0.5) * 6; b.wy = (Math.random() - 0.5) * 5;
      b.s = 0.11 + Math.random() * 0.06; b.life = 0; b.ph = Math.random() * TAU;
    }
    emitSparks(center, theme.pink, 22, 1.2);
  }

  window.addEventListener('sempik:party', (e) => { party = !!e?.detail?.on; });

  // ------------------------------------------------------------ frame update
  const m4 = new THREE.Matrix4();
  const q4 = new THREE.Quaternion();
  const eul = new THREE.Euler();
  const pv = new THREE.Vector3();
  const sv = new THREE.Vector3();

  function update(dt) {
    time += dt;
    U.uTime.value = time;
    applyLayout(dt, false);

    // parallax / idle camera drift
    if (!reduced) {
      let tx = 0, ty = 0;
      if (pointer.has) { tx = pointer.tx; ty = pointer.ty; } else { tx = Math.sin(time * 0.13) * 0.35; ty = Math.sin(time * 0.09) * 0.2; }
      pointer.x = damp(pointer.x, tx, 2.2, dt);
      pointer.y = damp(pointer.y, ty, 2.2, dt);
    }
    camera.position.set(CAM_BASE.x + pointer.x * 1.1, CAM_BASE.y - pointer.y * 0.6, CAM_BASE.z);
    camera.lookAt(LOOK);
    camera.updateMatrixWorld();
    updateRays();

    partyK = damp(partyK, party ? 1 : 0, 2.5, dt);
    U.uParty.value = partyK;
    {
      const hu = petalMat.uniforms.uHero.value;
      hu.set(lay.cx * 2 - 1, 1 - lay.cy * 2, (0.42 * HERO.h * lay.s * lay.ppw) / Math.max(1, lay.h) * 2, lay.w / Math.max(1, lay.h));
    }

    // reveal
    if (revealed) revealT += dt;
    const heroDur = reduced ? 0.7 : 1.6;
    const hp = revealed ? clamp01(revealT / heroDur) : 0;
    const he = reduced ? easeOutCubic(hp) : easeOutExpo(hp);
    heroRoot.visible = revealed;
    const s = lay.s;
    const bob = reduced ? 0 : Math.sin(time * 0.75) * 0.07;
    heroRoot.scale.setScalar(s * (reduced ? 0.9 + 0.1 * he : Math.max(0.0001, he)));
    heroRoot.position.set(0, (-HERO.cy + bob) * s - (reduced ? 0 : (1 - he) * 2.6 * s), 0);
    heroRoot.rotation.z = reduced ? 0 : Math.sin(time * 0.5) * 0.015;

    // spin
    const auto = reduced ? 0 : 0.085 * (1 + partyK * 9);
    if (!drag.down) {
      spinAngle += (auto + spinVel) * dt;
      spinVel *= Math.exp(-dt * 2.2);
    }
    spin.rotation.y = spinAngle - (reduced ? 0 : (1 - he) * 2.2);

    // tree shake
    shakeT += dt;
    const sh = shakeT < 3 ? Math.exp(-shakeT * 2.6) : 0;
    U.uShake.value = sh;
    treeGroup.rotation.z = 0.07 * sh * Math.sin(shakeT * 17);
    treeGroup.rotation.x = 0.045 * sh * Math.sin(shakeT * 13 + 1.3);

    // halo + magic circle
    const glowIn = clamp01((revealT - 0.15) / 1.2);
    haloMat.uniforms.uOpacity.value = easeOutCubic(glowIn) * (0.85 + 0.15 * Math.sin(time * 0.8));
    circleMat.uniforms.uOpacity.value = easeOutCubic(clamp01((revealT - 0.4) / 1.4)) * 0.25;
    flyMat.uniforms.uVis.value = easeOutCubic(clamp01((revealT - 0.6) / 1.5));
    magic.rotation.z = -time * (reduced ? 0 : 0.06 + partyK * 0.5);
    halo.lookAt(camera.position); // гало всегда лицом к камере

    // logos
    orbitMul = damp(orbitMul, (hovered >= 0 ? 0.04 : 1) * (1 + partyK * 2), 4, dt);
    orbitAngle += (reduced ? 0.04 : 0.16) * orbitMul * dt;
    const heads = trailMat.uniforms.uHead.value;
    const vis = trailMat.uniforms.uVis.value;
    for (const L of logos) {
      const p = revealed ? clamp01((revealT - L.delay) / (reduced ? 0.6 : L.dur)) : 0;
      const pe = easeOutCubic(p);
      L.group.visible = p > 0;
      const ang = orbitAngle + L.phase;
      orbitPoint(L.o, ang, L.target);
      heads[L.i] = ((ang % TAU) + TAU) % TAU;
      vis[L.i] = pe;
      if (!reduced && p < 1) {
        L.start.copy(L.target).multiplyScalar(2.4);
        L.start.y += 1.2;
        L.start.z += 6.5;
        L.group.position.lerpVectors(L.start, L.target, pe);
      } else {
        L.group.position.copy(L.target);
      }
      L.hoverK = damp(L.hoverK, hovered === L.i ? 1 : 0, 9, dt);
      L.pulse = Math.max(0, L.pulse - dt * 2.2);
      L.spinT = Math.min(1, L.spinT + dt / 0.75);
      const intro = reduced ? pe : p < 1 ? Math.max(0, easeOutBack(p)) : 1;
      const sc = intro * (1 + 0.34 * L.hoverK + 0.22 * Math.sin(L.pulse * Math.PI));
      L.spinner.scale.setScalar(Math.max(0.0001, sc));
      L.spinner.lookAt(camera.position);
      const sway = reduced ? 0 : Math.sin(time * 0.8 + L.i * 1.7) * 0.5 * (1 - L.hoverK);
      const hoverSpin = (1 - easeOutCubic(L.spinT)) * TAU;
      const introSpin = reduced ? 0 : (1 - pe) * TAU * 1.5;
      L.spinner.rotateY(sway + hoverSpin + introSpin);
      L.spinner.rotateX(reduced ? 0 : Math.sin(time * 0.6 + L.i) * 0.12 * (1 - L.hoverK));
      L.uHover.value = L.hoverK + L.pulse;
      L.glow.material.opacity = (0.3 + 0.7 * L.hoverK + 0.8 * L.pulse) * pe;
      L.glow.scale.setScalar((1.8 + 1.0 * L.hoverK + 1.4 * L.pulse) * Math.max(0.0001, intro));
    }

    // petals
    const speed = reduced ? 0.35 : 1 + partyK * 0.6;
    const wind = 0.16 + 0.1 * Math.sin(time * 0.11) + partyK * 0.25;
    for (let i = 0; i < petals.count; i++) {
      const p = petalState[i];
      p.y -= p.vy * dt * speed;
      p.x += (wind + Math.sin(time * p.f + p.ph) * p.sw) * dt * speed;
      p.z += Math.cos(time * p.f * 0.7 + p.ph) * 0.08 * dt * speed;
      p.rx += p.wx * dt * speed;
      p.ry += p.wy * dt * speed;
      const b = boundsAtZ(p.z);
      if (p.y < b.y0 - 0.6) spawnPetal(p, false);
      else if (p.x > b.x1 + 0.6) { p.x = b.x0 - 0.4; }
      else if (p.x < b.x0 - 1.6) { p.x = b.x1 + 0.4; }
      eul.set(p.rx, p.ry, p.rz + Math.sin(time * p.f * 1.3 + p.ph) * p.rock);
      q4.setFromEuler(eul);
      pv.set(p.x, p.y, p.z);
      sv.setScalar(p.s);
      m4.compose(pv, q4, sv);
      petals.setMatrixAt(i, m4);
    }
    petals.instanceMatrix.needsUpdate = true;

    // burst petals
    let anyBurst = false;
    for (let i = 0; i < BURST_N; i++) {
      const b = burstState[i];
      if (!b.on) { sv.setScalar(0); m4.makeScale(0, 0, 0); burst.setMatrixAt(i, m4); continue; }
      anyBurst = true;
      b.life += dt;
      const drag2 = Math.exp(-dt * 1.4);
      b.vx = b.vx * drag2 + wind * 0.5 * dt * 1.4;
      b.vz *= drag2;
      b.vy = b.vy * drag2 - 0.55 * dt;
      if (b.vy < -0.45) b.vy = -0.45;
      b.x += (b.vx + Math.sin(time * 1.7 + b.ph) * 0.25) * dt;
      b.y += b.vy * dt;
      b.z += b.vz * dt;
      b.rx += b.wx * dt; b.ry += b.wy * dt;
      const bb = boundsAtZ(b.z);
      const fade = clamp01((14 - b.life) / 2);
      if (b.y < bb.y0 - 0.6 || b.life > 14 || b.z > CAM_BASE.z - 1) b.on = false;
      eul.set(b.rx, b.ry, b.rz);
      q4.setFromEuler(eul);
      pv.set(b.x, b.y, b.z);
      sv.setScalar(b.on ? b.s * fade * clamp01(b.life * 6) : 0);
      m4.compose(pv, q4, sv);
      burst.setMatrixAt(i, m4);
    }
    burst.instanceMatrix.needsUpdate = true;
    burst.visible = anyBurst;

    // sparks
    if (spark.active > 0) {
      spark.active -= dt;
      for (let i = 0; i < SPARK_N; i++) {
        if (spark.life[i] <= 0) { spark.alpha[i] = 0; continue; }
        spark.life[i] -= dt;
        const k = Math.exp(-dt * 2.4);
        spark.vel[i * 3] *= k; spark.vel[i * 3 + 1] = spark.vel[i * 3 + 1] * k - 0.6 * dt; spark.vel[i * 3 + 2] *= k;
        spark.pos[i * 3] += spark.vel[i * 3] * dt;
        spark.pos[i * 3 + 1] += spark.vel[i * 3 + 1] * dt;
        spark.pos[i * 3 + 2] += spark.vel[i * 3 + 2] * dt;
        const t = clamp01(spark.life[i] / spark.max[i]);
        spark.alpha[i] = t * t * (0.6 + 0.4 * Math.sin(time * 30 + i));
      }
      sparkGeo.attributes.position.needsUpdate = true;
      sparkGeo.attributes.aAlpha.needsUpdate = true;
      sparkGeo.attributes.aColor.needsUpdate = true;
      sparkGeo.attributes.aSize.needsUpdate = true;
      sparks.visible = true;
    } else {
      sparks.visible = false;
    }
  }

  // ------------------------------------------------------------ loop
  let raf = 0;
  let last = 0;
  let running = false;
  let errors = 0;
  let firstFrame = true;

  // Прогрев шейдеров: compileAsync компилирует программы в фоне (KHR_parallel_shader_compile),
  // а не одним длинным блокирующим кадром. Герой на время компиляции «видим», чтобы учлись его
  // точечные источники света (иначе на reveal() всё перекомпилируется). Страховка — 5 с.
  let warm = false;
  const warmDone = () => { warm = true; };
  try {
    heroRoot.visible = true;
    for (const L of logos) L.group.visible = true;
    sparks.visible = true;
    burst.visible = true;
    // без расширения compileAsync всё равно компилирует синхронно (и пишет предупреждение) — тогда как раньше
    const par = !!renderer.extensions?.has?.('KHR_parallel_shader_compile');
    const p = par && renderer.compileAsync ? renderer.compileAsync(scene, camera) : null;
    if (p && p.then) p.then(warmDone, warmDone); else warmDone();
  } catch (_) { warmDone(); }
  setTimeout(warmDone, 5000);

  // «Губернатор» кадров: если долго не тянем ~45 fps — снижаем разрешение (2 → 1.5 → 1) и число лепестков
  const gov = { ema: 16, slowT: 0, wait: 4, level: 0 };
  function govern(rawMs, dt) {
    if (!revealed || reduced) return;
    if (rawMs > 250) return; // вкладка подвисла/спала — не считается
    gov.ema = gov.ema * 0.92 + rawMs * 0.08;
    if (gov.wait > 0) { gov.wait -= dt; return; }
    gov.slowT = gov.ema > 22 ? gov.slowT + dt : 0;
    if (gov.slowT < 2.5) return;
    gov.slowT = 0;
    gov.wait = 3;
    const cur = renderer.getPixelRatio();
    if (cur > 1.01) {
      pixelCap = Math.max(1, cur - 0.5);
      resize();
    } else if (petalMul > 0.45) {
      petalMul *= 0.6;
      resize();
    } else {
      gov.wait = Infinity; // дальше не трогаем
    }
    gov.level++;
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const rawMs = last ? now - last : 16;
    const dt = last ? Math.min(0.05, Math.max(0, rawMs / 1000)) : 1 / 60;
    last = now;
    // пока шейдеры компилируются в фоне, а заставка закрывает экран — не рисуем
    if (!warm && !revealed) return;
    // пока непрозрачная заставка закрывает экран, сцену всё равно не видно — после кадра прогрева
    // не рисуем, чтобы заставка и её «дырка» на входе шли плавно (особенно на слабых видеокартах)
    if (!firstFrame && !revealed && document.getElementById('splash')) return;
    govern(rawMs, dt);
    try {
      update(dt);
      if (firstFrame) {
        // прогрев: один кадр с видимым героем (масштаб ~0), чтобы шейдеры/буферы загрузились до reveal()
        firstFrame = false;
        if (!revealed) {
          heroRoot.visible = true;
          for (const L of logos) L.group.visible = true;
        }
        sparks.visible = true;
        burst.visible = true;
      }
      renderer.render(scene, camera);
    } catch (e) {
      if (++errors <= 1) console.error('[sempik] scene3d frame', e);
      if (errors > 30) stop();
    }
  }
  function start() {
    if (running) return;
    running = true;
    last = 0;
    raf = requestAnimationFrame(frame);
  }
  function stop() {
    running = false;
    cancelAnimationFrame(raf);
  }
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); stop(); });
  canvas.addEventListener('webglcontextrestored', () => start());

  let resizeQueued = false;
  const queueResize = () => {
    if (resizeQueued) return;
    resizeQueued = true;
    requestAnimationFrame(() => { resizeQueued = false; resize(); });
  };
  window.addEventListener('resize', queueResize);
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(queueResize).observe(canvas);

  if (!document.hidden) start();

  return {
    // отладка/тесты: экранные координаты логотипов и кроны
    _probe() {
      const toScreen = (obj, local) => {
        const v = local ? local.clone() : new THREE.Vector3();
        obj.localToWorld(v).project(camera);
        const r = canvas.getBoundingClientRect();
        return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
      };
      return {
        logos: logos.map((L) => ({ id: L.link.id, ...toScreen(L.group), z: L.group.getWorldPosition(new THREE.Vector3()).z })),
        tree: toScreen(treeGroup, canopyCenter),
        hovered,
        hero: heroRect(),
        gov: { level: gov.level, ema: gov.ema, dpr: renderer.getPixelRatio(), petals: petals.count },
        info: { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles },
      };
    },
    // отладка из консоли: sempik.scene._step(1.5) — прокрутить симуляцию вперёд на N секунд
    _step(sec = 1) {
      for (let t = 0; t < sec; t += 1 / 30) update(1 / 30);
      renderer.render(scene, camera);
      const r = renderer.info.render;
      return { calls: r.calls, triangles: r.triangles, programs: renderer.info.programs?.length };
    },
    // где на экране центр гало за деревом (CSS px, без покачивания и параллакса) и его радиус —
    // по этой точке main.js подгоняет «затмение» в фоновом видео, чтобы кольца были концентричны
    anchor() {
      try {
        const r = canvas.getBoundingClientRect();
        computeLayout();
        const w = r.width || lay.w, h = r.height || lay.h;
        anchorCam.copy(camera);
        anchorCam.position.copy(CAM_BASE);
        anchorCam.lookAt(LOOK);
        anchorCam.setViewOffset(w, h, w / 2 - lay.tcx * w, h / 2 - lay.tcy * h, w, h);
        anchorCam.updateMatrixWorld(true);
        const s = lay.ts;
        const c = new THREE.Vector3(0, (halo.position.y - HERO.cy) * s, halo.position.z * s);
        const e = c.clone();
        e.x += HALO_R * 0.8 * s;
        c.project(anchorCam);
        e.project(anchorCam);
        const x = r.left + ((c.x + 1) / 2) * w;
        const y = r.top + ((1 - c.y) / 2) * h;
        return { x, y, r: Math.abs(r.left + ((e.x + 1) / 2) * w - x) };
      } catch (_) { return null; }
    },
    reveal() {
      if (revealed) return;
      revealed = true;
      revealT = 0;
      announceHero();
      // маленький салют искр в момент появления
      setTimeout(() => {
        if (reduced) return;
        const c = canopyCenter.clone();
        treeGroup.localToWorld(c);
        emitSparks(c, theme.pink, 26, 1.1);
      }, 700);
    },
  };
}
