#version 300 es
// sempik.github.io — фоновое motion-видео «ночная сакура × неон».
// Один фрагментный шейдер = один кадр. Всё движение зависит только от фазы
// uPhase ∈ [0,1) (θ = 2π·uPhase), поэтому кадр N совпадает с кадром 0 — луп бесшовный.
precision highp float;

uniform vec2  uRes;    // размер кадра в пикселях
uniform float uPhase;  // t / T
out vec4 outColor;

#define TAU 6.283185307179586
#define PI  3.141592653589793

// ---------------------------------------------------------------------------
// 4D simplex noise — Ashima Arts / Stefan Gustavson, webgl-noise (MIT License)
// https://github.com/ashima/webgl-noise
// Copyright (C) 2011 Ashima Arts, (C) 2011-2022 Stefan Gustavson
// ---------------------------------------------------------------------------
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
float mod289(float x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 10.0) * x); }
float permute(float x) { return mod289(((x * 34.0) + 10.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
float taylorInvSqrt(float r) { return 1.79284291400159 - 0.85373472095314 * r; }

vec4 grad4(float j, vec4 ip) {
  const vec4 ones = vec4(1.0, 1.0, 1.0, -1.0);
  vec4 p, s;
  p.xyz = floor(fract(vec3(j) * ip.xyz) * 7.0) * ip.z - 1.0;
  p.w = 1.5 - dot(abs(p.xyz), ones.xyz);
  s = vec4(lessThan(p, vec4(0.0)));
  p.xyz = p.xyz + (s.xyz * 2.0 - 1.0) * s.www;
  return p;
}

#define F4 0.309016994374947451

float snoise(vec4 v) {
  const vec4 C = vec4(0.138196601125011,   // (5 - sqrt(5))/20  G4
                      0.276393202250021,   // 2 * G4
                      0.414589803375032,   // 3 * G4
                     -0.447213595499958);  // -1 + 4 * G4
  vec4 i  = floor(v + dot(v, vec4(F4)));
  vec4 x0 = v - i + dot(i, C.xxxx);

  vec4 i0;
  vec3 isX  = step(x0.yzw, x0.xxx);
  vec3 isYZ = step(x0.zww, x0.yyz);
  i0.x   = isX.x + isX.y + isX.z;
  i0.yzw = 1.0 - isX;
  i0.y  += isYZ.x + isYZ.y;
  i0.zw += 1.0 - isYZ.xy;
  i0.z  += isYZ.z;
  i0.w  += 1.0 - isYZ.z;

  vec4 i3 = clamp(i0, 0.0, 1.0);
  vec4 i2 = clamp(i0 - 1.0, 0.0, 1.0);
  vec4 i1 = clamp(i0 - 2.0, 0.0, 1.0);

  vec4 x1 = x0 - i1 + C.xxxx;
  vec4 x2 = x0 - i2 + C.yyyy;
  vec4 x3 = x0 - i3 + C.zzzz;
  vec4 x4 = x0 + C.wwww;

  i = mod289(i);
  float j0 = permute(permute(permute(permute(i.w) + i.z) + i.y) + i.x);
  vec4 j1 = permute(permute(permute(permute(
              i.w + vec4(i1.w, i2.w, i3.w, 1.0))
            + i.z + vec4(i1.z, i2.z, i3.z, 1.0))
            + i.y + vec4(i1.y, i2.y, i3.y, 1.0))
            + i.x + vec4(i1.x, i2.x, i3.x, 1.0));

  vec4 ip = vec4(1.0 / 294.0, 1.0 / 49.0, 1.0 / 7.0, 0.0);
  vec4 p0 = grad4(j0,   ip);
  vec4 p1 = grad4(j1.x, ip);
  vec4 p2 = grad4(j1.y, ip);
  vec4 p3 = grad4(j1.z, ip);
  vec4 p4 = grad4(j1.w, ip);

  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  p4 *= taylorInvSqrt(dot(p4, p4));

  vec3 m0 = max(0.6 - vec3(dot(x0, x0), dot(x1, x1), dot(x2, x2)), 0.0);
  vec2 m1 = max(0.6 - vec2(dot(x3, x3), dot(x4, x4)), 0.0);
  m0 = m0 * m0;
  m1 = m1 * m1;
  return 49.0 * (dot(m0 * m0, vec3(dot(p0, x0), dot(p1, x1), dot(p2, x2)))
               + dot(m1 * m1, vec2(dot(p3, x3), dot(p4, x4))));
}
// --------------------------- конец webgl-noise -----------------------------

// Петля во времени: две «лишние» координаты шума идут по окружности радиуса r.
// Через полный оборот θ шум возвращается ровно в исходное состояние.
float loopNoise(vec2 p, vec2 L, float r, float seed) {
  return snoise(vec4(p, L * r + vec2(seed, seed * 1.618)));
}

const mat2 ROT = mat2(0.80, 0.60, -0.60, 0.80);

float fbm(vec2 p, vec2 L, float r, float seed, int oct) {
  float a = 0.5, s = 0.0, n = 0.0;
  for (int i = 0; i < 5; i++) {
    if (i >= oct) break;
    s += a * loopNoise(p, L, r, seed + float(i) * 7.31);
    n += a;
    p = ROT * p * 2.02 + vec2(3.17, 1.91);
    r *= 1.35;
    a *= 0.5;
  }
  return s / n;
}

float hash11(float n) { return fract(sin(n * 127.1) * 43758.5453123); }
vec2 hash21(float n) { return fract(sin(vec2(n * 127.1, n * 311.7 + 17.0)) * 43758.5453123); }

vec3 srgb2lin(vec3 c) { return pow(c, vec3(2.2)); }
vec3 hex(float r, float g, float b) { return srgb2lin(vec3(r, g, b) / 255.0); }

float sq(float x) { return x * x; }
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }


// ---------------------------------------------------------------------------
// Шёлковая светящаяся лента. P — координаты (высота кадра = 1).
// Лента — полотно, по которому бегут волны изгиба и перекрута (целые частоты по θ).
// В местах перекрута полотно видно ребром — там оно сгущается в яркий жгут,
// а когда поворачивается «к свету», по нему пробегает блик.
// ---------------------------------------------------------------------------
struct Ribbon {
  vec2  pivot;
  float angle;
  float width;
  float amp;
  float k;        // волновое число изгиба
  float m;        // целое: сколько волн изгиба пробегает за луп
  float tk;       // волновое число перекрута
  float tm;       // целое: сколько волн перекрута пробегает за луп
  float u0, u1;   // где лента проявляется / гаснет вдоль своей оси
  float seed;
  float blur;     // 0 — в фокусе, 1 — сильно размыта (дальний план)
};

vec3 ribbon(vec2 P, vec2 warp, Ribbon R, float th, vec2 L, vec3 cFront, vec3 cBack) {
  vec2 Q = rot(-R.angle) * (P - R.pivot) + warp;
  float u = Q.x;
  float v = Q.y;

  float a1 = R.k * u - R.m * th + R.seed;
  float a2 = R.k * 2.13 * u + R.m * th + R.seed * 2.7;
  float c  = R.amp * (sin(a1) + 0.4 * sin(a2));
  float dc = R.amp * R.k * (cos(a1) + 0.4 * 2.13 * cos(a2));
  c += 0.035 * loopNoise(vec2(u * 0.8, R.seed), L, 0.30, R.seed * 3.1);

  float phi = R.tk * u - R.tm * th + R.seed * 1.7;
  float tw  = cos(phi);
  float w   = R.width * (0.07 + 0.93 * abs(tw));
  float d   = (v - c) / sqrt(1.0 + dc * dc);
  float x   = d / w;
  float ax  = abs(x);

  float soft = max(0.22 + 0.6 * R.blur, 1.2 / (uRes.y * w));
  float band = 1.0 - smoothstep(1.0 - soft, 1.0 + soft * 0.5, ax);

  float side   = smoothstep(-0.35, 0.35, tw);              // какая сторона полотна к нам
  float across = clamp(0.5 + 0.5 * x * (side * 2.0 - 1.0), 0.0, 1.0);
  float shade  = mix(0.12, 1.0, pow(across, 2.0));           // одна кромка в свету
  float fres   = pow(min(ax, 1.0), 4.0);                      // к кромкам полотно светится сильнее
  float spec   = pow(max(0.0, sin(phi + 0.7)), 7.0);        // блик, бегущий вдоль ленты
  // нити гасим там, где их шаг меньше пары пикселей (иначе муар и мерцание на перекруте)
  float px = 1.0 / uRes.y;
  float aa1 = smoothstep(2.5, 6.0, (2.0 * w / 13.0) / px);
  float aa2 = smoothstep(2.5, 6.0, (2.0 * w / 31.0) / px);
  float t1 = 0.5 + 0.5 * cos(x * PI * 13.0 + 0.9 * sin(u * 2.3 + R.seed));
  float t2 = 0.5 + 0.5 * cos(x * PI * 31.0 + 1.7 * sin(u * 1.3 - R.seed));
  float thr = 0.55 + 0.30 * mix(0.375, t1 * t1, aa1) + 0.15 * mix(0.5, t2, aa2);
  thr = mix(1.0, thr, 1.0 - R.blur);                         // тонкие шёлковые нити
  float dens = pow(clamp(R.width / w, 1.0, 8.0), 0.75);     // жгут на перекруте

  vec3 sheet = mix(cBack, cFront, side);
  vec3 inner = mix(sheet, cBack * 0.6 + cFront * 0.4, 0.35);
  float streak = pow(0.5 + 0.5 * sin(2.4 * u - 2.0 * th + R.seed * 3.3), 10.0);  // световые импульсы вдоль ленты
  vec3 col = inner * band * (0.06 + 0.32 * shade + 0.32 * fres) * thr * dens * (1.0 + 1.2 * streak);
  col += mix(sheet, vec3(1.0, 0.88, 0.96), 0.30) * band * (spec + 0.5 * streak) * thr * (0.25 + 0.75 * across) * 1.6;
  float hemW = max(0.06, 0.9 * px / w);
  float hem = exp(-sq((ax - 0.94) / hemW)) * (1.0 - R.blur) * min(1.0, 0.06 / hemW * 1.5);
  col += mix(sheet, vec3(1.0, 0.9, 0.97), 0.12 + 0.35 * max(spec, streak)) * hem * 0.80 * dens * (0.35 + 0.65 * across) * (1.0 + streak);

  // свечение вокруг (имитация bloom): плотное у ленты + широкое слабое
  float dg = d / (R.width * 2.6);
  col += sheet * (exp(-abs(d) / (R.width * 0.9)) * 0.09 + exp(-dg * dg) * 0.045) * (0.6 + 0.8 * spec + 0.8 * streak) * dens;

  // вдоль ленты: проявление/затухание и медленные импульсы
  float along = smoothstep(R.u0, R.u0 + 0.5, u) * (1.0 - smoothstep(R.u1 - 0.5, R.u1, u));
  float pulse = 0.65 + 0.35 * sin(1.6 * u - th + R.seed * 5.0);
  return col * along * pulse;
}

// Боке-кружок: мягкий диск с чуть более ярким ободком (как у реального объектива).
float bokehDisc(vec2 P, vec2 c, float r, float soft) {
  float d = length(P - c) / r;
  float disc = 1.0 - smoothstep(1.0 - soft, 1.0 + soft * 0.3, d);
  float rim  = exp(-sq((d - 0.85) / (0.10 + soft * 0.4))) * 0.45 * (1.0 - soft);
  return disc * (0.7 + rim);
}

// Лепесток сакуры (силуэт) — для пары огромных мягких лепестков не в фокусе.
float petalSDF(vec2 p) {
  p.x = abs(p.x);
  float body  = length(vec2(p.x * 1.35, p.y - 0.05)) - 0.55;
  float notch = length(p - vec2(0.0, 0.64)) - 0.17;
  float taper = p.x - (0.52 + p.y * 0.6);
  return max(max(body, -notch), taper * 0.7);
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  float asp = uRes.x / uRes.y;
  vec2 uv = frag / uRes;
  vec2 P = vec2(uv.x * asp, uv.y);        // x: 0..1.78, y: 0..1 (вверх)
  // сдвиг фазы: кадр 0 (он же постер) — один из самых красивых моментов лупа
  float phase = uPhase + 0.25;
  float th = TAU * phase;
  vec2 L = vec2(cos(th), sin(th));

  // палитра (линейные значения)
  vec3 cBg     = hex(7.0, 5.0, 12.0);
  vec3 cDeep   = hex(42.0, 20.0, 70.0);
  vec3 cHot    = hex(255.0, 61.0, 154.0);
  vec3 cPink   = hex(255.0, 140.0, 198.0);
  vec3 cViolet = hex(155.0, 123.0, 255.0);
  vec3 cLilac  = hex(214.0, 190.0, 255.0);
  vec3 cWhite  = vec3(1.0, 0.90, 0.97);

  // спокойная зона под карточкой (лево-центр) и точка героя (≈70% ширины)
  vec2 card = vec2(0.25 * asp, 0.50);
  vec2 hero = vec2(0.695 * asp, 0.55);
  vec2 cq = (P - card) / vec2(0.60, 0.62);
  float calm = exp(-dot(cq, cq));
  float rightness = smoothstep(0.30 * asp, 0.95 * asp, P.x);

  // ---------------- база: почти чёрный → глубокий фиолет справа ----------------
  vec3 col = vec3(0.0);   // свет копим отдельно, фон добавим в конце
  float rg = smoothstep(0.0, 1.0, (P.x / asp) * 0.9 + P.y * 0.25);
  col += cDeep * 0.30 * rg * rg;

  // ---------------- поле искажения (domain warp) ----------------
  vec2 q = vec2(fbm(P * 0.85,              L, 0.30, 11.0, 3),
                fbm(P * 0.85 + vec2(5.2, 1.3), L, 0.30, 23.0, 3));

  // ---------------- полярное сияние: дымка + шёлковые волокна ----------------
  vec2 hp = P * 1.2 + 1.15 * q;
  float f  = fbm(hp, L, 0.32, 41.0, 4);
  float f2 = fbm(hp * 1.6 + vec2(4.0, -2.0) + 0.7 * q.yx, L, 0.38, 57.0, 4);
  float haze = smoothstep(-0.15, 0.65, f);
  float hazeMask = mix(0.15, 1.0, rightness) * (0.6 + 0.4 * smoothstep(0.1, 1.0, P.y)) * (1.0 - 0.8 * calm);
  col += mix(cDeep * 0.7, cViolet * 0.06, haze) * haze * hazeMask * 0.42;
  float fil = pow(max(1.0 - abs(f2), 0.0), 9.0) * smoothstep(-0.25, 0.45, f);
  vec3 filCol = mix(cViolet, cHot, smoothstep(-0.35, 0.35, q.x));
  col += filCol * fil * hazeMask * 0.08;

  // ---------------- занавес полярного сияния (правый верх) ----------------
  {
    float yc = 0.60 + 0.07 * sin(P.x * 2.4 - th + 1.0)
                    + 0.05 * loopNoise(vec2(P.x * 1.3, 3.0), L, 0.30, 101.0);
    float dy = P.y - yc + 0.04 * q.y;                          // > 0 — выше нижней кромки
    float rays = fbm(vec2(P.x * 6.5 + 0.8 * q.x, P.y * 0.45), L, 0.34, 113.0, 3);
    rays = smoothstep(-0.25, 0.75, rays);
    float curtain = smoothstep(-0.03, 0.025, dy) * exp(-max(dy, 0.0) / 0.20);
    float aMask = smoothstep(0.42 * asp, 0.80 * asp, P.x) * (1.0 - 0.9 * calm);
    float aur = curtain * rays * aMask;
    vec3 aCol = mix(cViolet, mix(cHot, cPink, 0.3), smoothstep(0.02, 0.28, dy));
    col += aCol * aur * 0.20;
    col += cViolet * exp(-sq(dy / 0.03)) * rays * aMask * 0.08;   // яркая нижняя кромка
  }

  // ---------------- ореол-«затмение» за героем ----------------
  vec2 dH = P - hero;
  float rH = length(dH);
  vec2 dirH = dH / max(rH, 1e-4);
  float R0 = 0.215 + 0.004 * sin(th);
  float ang = atan(dH.y, dH.x);
  float orbit = max(0.5 + 0.5 * cos(ang - th - 0.6), 0.0);              // блик обегает кольцо за луп
  float orbit2 = max(0.5 + 0.5 * cos(ang + 2.0 * th + 2.1), 0.0);
  float rimHi = 0.012 + pow(orbit, 5.0) + 0.30 * pow(orbit2, 8.0);
  float inside = smoothstep(R0, R0 - 0.012, rH);
  col *= 1.0 - 0.55 * inside;                                   // диск чуть темнее фона
  float rim     = exp(-sq((rH - R0) / 0.0045));
  float rimGlow = exp(-sq((rH - R0) / 0.020));
  float outer   = max(rH - R0, 0.0);
  float rays    = 0.55 + 0.45 * fbm(dirH * 3.2 + dH * 1.4, L, 0.25, 91.0, 3);
  float corona  = exp(-outer / 0.055) * (1.0 - inside) * rays;
  col += cWhite * rim * rimHi * 0.70;
  col += mix(cHot, cPink, 0.35) * rimGlow * rimHi * 0.38;
  col += cHot * exp(-sq((rH - R0) / 0.06)) * rimHi * 0.06;
  col += mix(cViolet, cHot, orbit) * corona * 0.14;
  col += mix(cViolet, cDeep, 0.3) * exp(-rH * 2.2) * 0.06 * (1.0 - inside);
  col += cViolet * inside * exp(-(R0 - rH) / 0.03) * 0.05;     // внутреннее свечение у края
  // большое тонкое гало
  float ring2 = exp(-sq((rH - 0.36) / 0.05));
  col += mix(cViolet, cHot, orbit2) * ring2 * 0.018;

  // ---------------- шёлковые ленты ----------------
  vec2 warp = 0.09 * q;
  //                pivot               angle  width  amp    k    m    tk   tm   u0     u1    seed blur
  Ribbon A = Ribbon(vec2(1.28, 0.36),  0.52, 0.060, 0.070, 2.2, 1.0, 1.9, 1.0, -1.05, 1.20, 1.0, 0.0);
  Ribbon B = Ribbon(vec2(1.45, 0.83), -0.22, 0.038, 0.050, 3.0, 2.0, 2.6, 1.0, -0.75, 0.95, 4.0, 0.0);
  Ribbon C = Ribbon(vec2(1.30, 0.07),  0.08, 0.030, 0.040, 2.7, 1.0, 3.0, 1.0, -0.55, 0.95, 9.0, 0.0);
  Ribbon D = Ribbon(vec2(1.05, 0.98), -0.08, 0.090, 0.060, 1.6, 1.0, 1.2, 1.0, -1.25, 1.10, 6.5, 1.0);

  vec3 rib = vec3(0.0);
  rib += ribbon(P, warp * 1.6, D, th, L, cViolet * 0.55, cHot * 0.40) * 0.55;
  rib += ribbon(P, warp,       A, th, L, cHot,           cViolet * 0.90);
  rib += ribbon(P, warp * 1.3, B, th, L, cViolet,        cPink * 0.75) * 0.75;
  rib += ribbon(P, warp * 0.8, C, th, L, cPink * 0.9,    cHot * 0.80) * 0.55;
  rib *= 1.0 - 0.8 * calm;

  // мягкая световая волна по диагонали, раз за луп (на стыке — за кадром)
  vec2 sweepDir = normalize(vec2(0.86, 0.50));
  float sPos = dot(P, sweepDir);
  float sc = mix(-0.9, 2.95, fract(phase + 0.35));
  float sweep = exp(-sq((sPos - sc) / 0.32));
  rib *= 1.0 + 0.9 * sweep;
  col += rib;
  col += cLilac * sweep * 0.010 * (1.0 - calm) * (0.3 + 0.7 * rightness);

  // ---------------- боке на разной глубине ----------------
  vec3 bok = vec3(0.0);
  for (int i = 0; i < 28; i++) {
    float fi = float(i);
    vec2  h  = hash21(fi + 3.7);
    float z  = hash11(fi * 1.91 + 0.3);                  // 0 — далеко, 1 — близко
    float cyc = 1.0 + floor(hash11(fi * 4.3) * 1.999);   // 1 или 2 «жизни» за луп
    float lifeT = phase * cyc + hash11(fi * 9.1);
    float life = fract(lifeT);
    float gen  = mod(floor(lifeT), cyc);
    vec2  h2 = hash21(fi * 13.3 + gen * 5.1);
    vec2 start = vec2(mix(0.12, 1.0, pow(h2.x, 0.55)) * asp, mix(-0.05, 1.05, h2.y));
    vec2 dir = normalize(vec2(-0.35 + 0.3 * h.x, 1.0));
    float travel = mix(0.05, 0.30, z) / cyc;
    vec2 c = start + dir * travel * (life - 0.5);
    c += 0.010 * vec2(sin(th * 2.0 + fi), cos(th + fi * 1.7)) * (0.5 + z);
    float r    = mix(0.005, 0.085, z * z);
    float soft = mix(0.30, 0.95, z);
    float fade = sin(PI * life); fade *= fade;
    float b    = bokehDisc(P, c, r, soft) * fade * mix(0.75, 0.06, z);
    vec3  bc   = mix(cHot, cViolet, h.y);
    bc = mix(bc, cPink, step(0.65, hash11(fi * 7.7)) * 0.8);
    b *= 1.0 - 0.7 * calm;
    bok += bc * b;
  }
  col += bok;

  // пара огромных расфокусированных «лепестков» на переднем плане
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float life = fract(phase + fi / 3.0 + 0.12);
    vec2 h = hash21(fi * 31.7 + 2.0);
    vec2 start = vec2(mix(1.0, 1.9, h.x), 1.30);
    vec2 c = start + vec2(-0.50, -1.60) * life;
    c.x += 0.05 * sin(th * 2.0 + fi * 2.0);
    float ang2 = th * (mod(fi, 2.0) < 0.5 ? 1.0 : -1.0) + h.y * TAU;
    vec2 lp = rot(ang2) * (P - c) / mix(0.07, 0.11, h.y);
    lp.y *= 1.0 + 0.35 * sin(th * 2.0 + fi);
    float pet = 1.0 - smoothstep(-0.40, 0.30, petalSDF(lp));
    float fade = smoothstep(0.0, 0.15, life) * (1.0 - smoothstep(0.85, 1.0, life));
    col += mix(cPink, cHot, 0.4) * pet * fade * 0.045 * (1.0 - 0.85 * calm);
  }

  // ---------------- грейдинг ----------------
  vec2 vq = uv - vec2(0.58, 0.52);
  float vig = 1.0 - 0.6 * smoothstep(0.30, 0.95, length(vq * vec2(1.0, 1.3)));
  col *= vig;
  col *= 1.0 - 0.30 * calm;

  // «носок» кривой: гасим слабую дымку, яркий неон почти не трогаем
  col = col * col / (col + 0.016);
  col += cBg;

  // мягкий тонмаппинг: перегретый неон уходит в белое
  float mx = max(col.r, max(col.g, col.b));
  col += vec3(max(mx - 0.7, 0.0)) * 0.30;
  col = 1.0 - exp(-col * 1.1);

  vec3 srgb = pow(max(col, 0.0), vec3(1.0 / 2.2));

  // статичный треугольный дизеринг (одинаковый в каждом кадре) против бэндинга
  float n1 = fract(52.9829189 * fract(dot(frag, vec2(0.06711056, 0.00583715))));
  float n2 = fract(52.9829189 * fract(dot(frag + vec2(37.0, 17.0), vec2(0.06711056, 0.00583715))));
  srgb += (n1 + n2 - 1.0) / 255.0;

  outColor = vec4(clamp(srgb, 0.0, 1.0), 1.0);
}
