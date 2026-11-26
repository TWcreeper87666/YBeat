// 節奏剪輯（卡點 / Velocity / 短影音）常用的現代特效與轉場
import type { Module, ModuleKind } from './builtin';

// ───────── 特效 ─────────

const shockwave = `// 衝擊波：從中心擴散的一圈折射波紋（drop / 重拍）
// @duration 0.6
// @hit
// @param strength: float = 0.06 (0..0.2) "扭曲量"
// @param width: float = 0.12 (0.02..0.5) "波寬"
// @param radius: float = 1.2 (0.2..2) "擴散距離"
// @param rgb: float = 0.4 (0..1) "色差"
// @param center: point = 0.5,0.5 "中心" @follow
// @param ease: curve = expoOut "曲線"
vec4 effect(vec2 uv) {
  float r0 = curve(ease, u_progress) * radius;
  vec2 p = uv - center;
  p.x *= ASPECT;
  float d = length(p);
  float x = (d - r0) / width;
  float k = -x * exp(-x * x * 2.0) * strength * (1.0 - u_progress);
  vec2 off = d > 1e-4 ? p / d * k : vec2(0.0);
  off.x /= ASPECT;
  vec4 c = tex(mirrorUV(uv + off));
  c.r = tex(mirrorUV(uv + off * (1.0 + rgb))).r;
  c.b = tex(mirrorUV(uv + off * (1.0 - rgb))).b;
  return c;
}
`;

const chromaZoom = `// RGB 變焦：放大一下，紅藍通道往外散開再收回
// @duration 0.4
// @hit
// @param amount: float = 0.08 (0..0.3) "分離量"
// @param zoom: float = 0.1 (0..0.5) "放大量"
// @param center: point = 0.5,0.5 "中心" @follow
// @param ease: curve = expoOut "回落曲線"
vec4 effect(vec2 uv) {
  float k = 1.0 - curve(ease, u_progress);
  float z = 1.0 + zoom * k;
  float a = amount * k;
  vec4 g = tex(mirrorUV(zoomUV(uv, z, center)));
  float r = tex(mirrorUV(zoomUV(uv, z * (1.0 + a), center))).r;
  float b = tex(mirrorUV(zoomUV(uv, z / (1.0 + a), center))).b;
  return vec4(r, g.g, b, g.a);
}
`;

const spinKick = `// 旋轉衝擊：打拍時轉一下再回正，帶旋轉模糊
// @duration 0.4
// @hit
// @param angle: float = 20 (-180..180) "旋轉角度（度）"
// @param blur: float = 1 (0..2) "旋轉模糊"
// @param zoom: float = 0.2 (0..1) "放大補邊"
// @param center: point = 0.5,0.5 "中心" @follow
// @param ease: curve = expoOut "回落曲線"
vec4 effect(vec2 uv) {
  float k = 1.0 - curve(ease, u_progress);
  float a = radians(angle) * k;
  float spread = radians(angle) * blur * k * 0.5;
  float z = 1.0 + zoom * k;
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 16; i++) {
    float f = float(i) / 15.0 - 0.5;
    acc += tex(mirrorUV(zoomUV(rotateUV(uv, a + f * spread, center), z, center)));
  }
  return acc / 16.0;
}
`;

const squash = `// 彈跳擠壓：畫面像果凍一樣壓扁再彈回
// @duration 0.6
// @hit
// @param amount: float = 0.2 (0..0.6) "擠壓量"
// @param bounces: float = 2 (0.5..6) "彈跳次數"
// @param damping: float = 5 (0..12) "阻尼"
// @param vertical: bool = false "垂直"
// @param center: point = 0.5,0.5 "中心" @follow
vec4 effect(vec2 uv) {
  float t = u_progress;
  float s = amount * exp(-damping * t) * cos(t * bounces * 2.0 * PI) * (1.0 - t);
  vec2 sc = (vertical ? vec2(1.0 + s, 1.0 - s) : vec2(1.0 - s, 1.0 + s)) * (1.0 + abs(s));
  return tex(mirrorUV((uv - center) / sc + center));
}
`;

const tilt3d = `// 3D 擺動：畫面帶透視地傾斜一下再擺回來
// @duration 0.6
// @hit
// @param tiltX: float = 0 (-60..60) "上下傾斜（度）"
// @param tiltY: float = 25 (-60..60) "左右傾斜（度）"
// @param persp: float = 2 (0.5..6) "鏡頭距離"
// @param swings: float = 1.5 (0..5) "擺動次數"
// @param damping: float = 4 (0..12) "阻尼"
// @param zoom: float = 1.1 (1..2) "放大補邊"
vec3 rX(vec3 v, float a) { float c = cos(a), s = sin(a); return vec3(v.x, c * v.y - s * v.z, s * v.y + c * v.z); }
vec3 rY(vec3 v, float a) { float c = cos(a), s = sin(a); return vec3(c * v.x + s * v.z, v.y, -s * v.x + c * v.z); }
vec4 effect(vec2 uv) {
  float t = u_progress;
  float k = exp(-damping * t) * cos(t * swings * 2.0 * PI) * (1.0 - t);
  float ax = radians(tiltX) * k;
  float ay = radians(tiltY) * k;
  // 從鏡頭射一條線到旋轉後的畫面平面，求交點在畫面上的座標
  vec3 n = rY(rX(vec3(0.0, 0.0, 1.0), ax), ay);
  vec3 cam = vec3(0.0, 0.0, -persp);
  vec3 d = vec3((uv - 0.5) * vec2(ASPECT, 1.0) / zoom, persp);
  float dn = dot(n, d);
  if (dn <= 1e-4) return vec4(0.0);
  vec3 hit = cam + d * (-dot(n, cam) / dn);
  vec3 l = rX(rY(hit, -ay), -ax);
  return tex(mirrorUV(l.xy / vec2(ASPECT, 1.0) + 0.5));
}
`;

const randomCam = `// 隨機運鏡：每次觸發推到畫面上隨機一個點（帶點傾斜），下一次觸發再移到新的點
// @duration 4
// @param zoom: float = 1.6 (1..4) "放大"
// @param zoomRand: float = 0.3 (0..1) "放大隨機"
// @param margin: float = 0.2 (0..0.45) "邊距"
// @param tilt: float = 8 (0..45) "傾斜（度）"
// @param blur: float = 0.5 (0..1) "動態模糊"
// @param seed: int = 0 (0..99) "隨機種子"
// @param ease: curve = expoOut "曲線"
struct Cam { vec2 c; float z; float a; };
// 第 n 次觸發的鏡頭；n < 0 = 原畫面（方塊開頭從原畫面推過去）
Cam camAt(float n) {
  if (n < 0.0) return Cam(vec2(0.5), 1.0, 0.0);
  float s = float(seed) * 7.31;
  float z = max(1.0, zoom * (1.0 + zoomRand * 0.5 * (rand(vec2(n, s + 3.1)) * 2.0 - 1.0)));
  vec2 p = margin + (1.0 - 2.0 * margin) * vec2(rand(vec2(n, s + 1.7)), rand(vec2(n, s + 2.3)));
  // 放大後鏡頭不拍到畫面外
  float h = 0.5 / z;
  p = clamp(p, vec2(h), vec2(1.0 - h));
  return Cam(p, z, radians(tilt) * (rand(vec2(n, s + 4.9)) * 2.0 - 1.0));
}
vec2 view(vec2 uv, Cam a, Cam b, float k) {
  float z = exp(mix(log(a.z), log(b.z), k));
  vec2 p = uv - 0.5;
  p.x *= ASPECT;
  p = rot(mix(a.a, b.a, k)) * p / z;
  p.x /= ASPECT;
  return mix(a.c, b.c, k) + p;
}
vec4 effect(vec2 uv) {
  Cam a = camAt(u_trigger - 1.0);
  Cam b = camAt(u_trigger);
  vec4 acc = vec4(0.0);
  // 一次運鏡延伸到下一次觸發前（曲線跑滿這次觸發的長度），不會半路停住
  for (int i = 0; i < 12; i++) {
    float t = u_local - blur * 0.08 * float(i) / 11.0;
    acc += tex(mirrorUV(view(uv, a, b, curve(ease, clamp(t / u_duration, 0.0, 1.0)))));
  }
  return acc / 12.0;
}
`;

const tileZoom = `// 鏡像拼貼：拉遠露出鏡像拼貼的畫面再推回來
// @duration 0.5
// @hit
// @param amount: float = 1 (0..4) "拉遠量"
// @param rotation: float = 0 (-180..180) "旋轉（度）"
// @param blur: float = 0.4 (0..1) "模糊"
// @param center: point = 0.5,0.5 "中心" @follow
// @param ease: curve = inOut3 "曲線"
vec4 effect(vec2 uv) {
  float k = sin(curve(ease, u_progress) * PI);
  float z = 1.0 / (1.0 + amount * k);
  float a = radians(rotation) * k;
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 12; i++) {
    float f = float(i) / 11.0;
    vec2 q = zoomUV(rotateUV(uv, a, center), z * (1.0 + f * blur * k * 0.15), center);
    acc += tex(mirrorUV(q));
  }
  return acc / 12.0;
}
`;

const twitch = `// 抽動 Twitch：隨機跳縮放、位移、旋轉、色差、亮度
// @duration 0.5
// @hit
// @param amount: float = 0.8 (0..1) "強度"
// @param speed: float = 16 (2..60) "跳動速度"
// @param zoom: float = 0.2 (0..0.6) "縮放跳動"
// @param offset: float = 0.04 (0..0.2) "位移跳動"
// @param rotation: float = 0.06 (0..0.4) "旋轉跳動"
// @param rgb: float = 0.015 (0..0.06) "色差"
// @param light: float = 0.3 (0..1) "亮度跳動"
// @param decay: float = 1 (0..6) "衰減"
vec4 effect(vec2 uv) {
  float st = floor(u_local * speed);
  // 有些格不跳，節奏比較自然
  float e = amount * pow(1.0 - u_progress, decay) * step(0.35, rand(vec2(st, 9.1)));
  float r1 = rand(vec2(st, 1.3));
  float r2 = rand(vec2(st, 2.7)) * 2.0 - 1.0;
  vec2 r3 = vec2(rand(vec2(st, 4.1)), rand(vec2(st, 5.9))) * 2.0 - 1.0;
  float r4 = rand(vec2(st, 7.3)) * 2.0 - 1.0;
  vec2 q = zoomUV(uv, 1.0 + zoom * e * r1, vec2(0.5));
  q = rotateUV(q, r2 * rotation * e, vec2(0.5)) + r3 * offset * e;
  float c = rgb * e * r4;
  vec4 g = tex(mirrorUV(q));
  vec4 col = vec4(tex(mirrorUV(q + vec2(c, 0.0))).r, g.g, tex(mirrorUV(q - vec2(c, 0.0))).b, g.a);
  col.rgb = min(col.rgb * (1.0 + light * e * (r1 * 2.0 - 0.6)), vec3(col.a));
  return col;
}
`;

const blurPulse = `// 模糊脈衝：打拍瞬間失焦，再對焦回來
// @duration 0.4
// @hit
// @param amount: float = 0.03 (0..0.12) "模糊量"
// @param zoom: float = 0.05 (0..0.3) "放大量"
// @param ease: curve = expoOut "回落曲線"
vec4 effect(vec2 uv) {
  float k = 1.0 - curve(ease, u_progress);
  vec2 q = zoomUV(uv, 1.0 + zoom * k, vec2(0.5));
  float r = amount * k;
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 32; i++) {
    float fi = float(i);
    float rr = sqrt((fi + 0.5) / 32.0) * r;
    float a = fi * 2.39996;
    acc += tex(mirrorUV(q + vec2(cos(a) / ASPECT, sin(a)) * rr));
  }
  return acc / 32.0;
}
`;

const duotone = `// 雙色調：用兩個顏色重新上色（適合拉長當整段濾鏡）
// @duration 3
// @param shadow: color = #1b0f45 "暗部"
// @param highlight: color = #ff5c8a "亮部"
// @param contrast: float = 1.2 (0.5..2) "對比"
// @param strength: float = 1 (0..1) "強度"
vec4 effect(vec2 uv) {
  vec4 c = tex(uv);
  if (c.a <= 0.0) return c;
  vec3 rgb = c.rgb / c.a;
  float l = clamp((dot(rgb, vec3(0.299, 0.587, 0.114)) - 0.5) * contrast + 0.5, 0.0, 1.0);
  return vec4(mix(rgb, mix(shadow, highlight, l), strength) * c.a, c.a);
}
`;

const sliceFx = `// 切片位移：畫面切成條狀，交錯滑開再歸位
// @duration 0.4
// @hit
// @param count: float = 6 (2..30) "切片數"
// @param amount: float = 0.3 (0..1) "位移量"
// @param blur: float = 0.5 (0..1) "模糊"
// @param vertical: bool = false "直向切片"
// @param ease: curve = expoOut "回落曲線"
vec4 effect(vec2 uv) {
  float k = 1.0 - curve(ease, u_progress);
  float id = floor((vertical ? uv.x : uv.y) * count);
  float dir = mod(id, 2.0) < 0.5 ? 1.0 : -1.0;
  float sh = dir * amount * k * (0.5 + rand(vec2(id, 7.0)));
  vec2 d = vertical ? vec2(0.0, 1.0) : vec2(1.0, 0.0);
  float bl = abs(sh) * blur * 0.4;
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 12; i++) acc += tex(mirrorUV(uv + d * (sh + bl * (float(i) / 11.0 - 0.5))));
  return acc / 12.0;
}
`;

const zoomEcho = `// 縮放殘影：往外擴散的一層層殘影
// @duration 0.5
// @hit
// @param copies: float = 5 (1..10) "殘影數"
// @param spread: float = 0.15 (0..0.6) "擴散"
// @param opacity: float = 0.5 (0..1) "殘影強度"
// @param center: point = 0.5,0.5 "中心" @follow
// @param ease: curve = expoOut "回落曲線"
vec4 effect(vec2 uv) {
  float k = 1.0 - curve(ease, u_progress);
  vec4 c = tex(uv);
  for (int i = 1; i <= 10; i++) {
    if (float(i) > copies) break;
    float f = float(i) / copies;
    vec4 e = tex(zoomUV(uv, 1.0 + spread * k * f, center)) * opacity * k * (1.0 - f * 0.7);
    c = c + e * (1.0 - c); // 濾色疊加
  }
  return c;
}
`;

// ───────── 轉場 ─────────

const lumaTr = `// 亮度溶解：亮的地方先變成下一段
// @param softness: float = 0.2 (0.01..1) "柔化"
// @param invert: bool = false "暗部先"
// @param ease: curve = inOut3 "曲線"
vec4 transition(vec2 uv) {
  vec4 a = getFrom(uv);
  float l = dot(a.rgb, vec3(0.299, 0.587, 0.114));
  float thr = invert ? l : 1.0 - l;
  float p = curve(ease, progress) * (1.0 + softness);
  float m = smoothstep(thr, thr + softness, p);
  return mix(a, getTo(uv), m);
}
`;

const blurTr = `// 模糊溶解：失焦後換到下一段再對焦
// @param amount: float = 0.04 (0..0.15) "模糊量"
// @param zoom: float = 0.1 (0..0.5) "放大量"
vec4 blurS(sampler2D s, vec2 uv, float r) {
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 32; i++) {
    float fi = float(i);
    float rr = sqrt((fi + 0.5) / 32.0) * r;
    float a = fi * 2.39996;
    acc += texture(s, mirrorUV(uv + vec2(cos(a) / ASPECT, sin(a)) * rr));
  }
  return acc / 32.0;
}
vec4 transition(vec2 uv) {
  float k = sin(progress * PI);
  vec2 q = zoomUV(uv, 1.0 + zoom * k, vec2(0.5));
  float r = amount * k;
  float m = smoothstep(0.3, 0.7, progress);
  vec4 a = m < 1.0 ? blurS(u_from, q, r) : vec4(0.0);
  vec4 b = m > 0.0 ? blurS(u_to, q, r) : vec4(0.0);
  return mix(a, b, m);
}
`;

const exposureTr = `// 過曝：亮部先爆白，再從白光中出現下一段
// @param peak: float = 4 (0..10) "曝光量"
// @param whiteout: float = 0.6 (0..1) "全白程度"
// @param tint: color = #ffffff "顏色"
vec4 transition(vec2 uv) {
  float k = max(sin(progress * PI), 0.0);
  float m = smoothstep(0.4, 0.6, progress);
  vec4 c = mix(getFrom(uv), getTo(uv), m);
  vec3 col = min(c.rgb * exp2(peak * k * k) * tint, vec3(c.a));
  col = mix(col, tint * c.a, pow(k, 4.0) * whiteout);
  return vec4(col, c.a);
}
`;

const shakeTr = `// 晃動切換：猛烈晃動中切到下一段
// @param strength: float = 0.08 (0..0.3) "晃動幅度"
// @param freq: float = 18 (2..60) "晃動次數"
// @param blur: float = 1 (0..3) "模糊量"
vec2 shakeAt(float t) { return vec2(noise1(t), noise1(t + 37.0)); }
vec4 transition(vec2 uv) {
  float env = sin(progress * PI);
  float t = progress * freq;
  vec2 off = shakeAt(t) * strength * env;
  vec2 vel = (shakeAt(t + 0.15) - shakeAt(t - 0.15)) * strength * env * blur;
  float z = 1.0 + strength * 2.5 * env;
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 16; i++) {
    float f = float(i) / 15.0 - 0.5;
    vec2 q = mirrorUV(zoomUV(uv, z, vec2(0.5)) + off + vel * f);
    acc += progress < 0.5 ? getFrom(q) : getTo(q);
  }
  return acc / 16.0;
}
`;

const sliceTr = `// 切片推移：一條條依序推出，換成下一段
// @param count: float = 8 (2..30) "切片數"
// @param stagger: float = 0.5 (0..0.9) "錯開"
// @param vertical: bool = false "直向切片"
// @param alternate: bool = true "交錯方向"
// @param ease: curve = inOut3 "曲線"
vec4 transition(vec2 uv) {
  float id = floor((vertical ? uv.x : uv.y) * count);
  float order = id / max(count - 1.0, 1.0);
  float lp = clamp((progress - order * stagger) / (1.0 - stagger), 0.0, 1.0);
  float e = curve(ease, lp);
  float sgn = alternate && mod(id, 2.0) >= 0.5 ? -1.0 : 1.0;
  vec2 d = vertical ? vec2(0.0, 1.0) : vec2(1.0, 0.0);
  vec2 q = uv + d * sgn * e;
  float a = dot(q, d);
  return a >= 0.0 && a <= 1.0 ? getFrom(q) : getTo(clamp(q - d * sgn, 0.0, 1.0));
}
`;

const splitTr = `// 中線分開：畫面從中間裂開，露出下一段
// @param vertical: bool = false "左右分開"
// @param zoom: float = 0.2 (0..1) "新畫面縮放"
// @param ease: curve = inOut3 "曲線"
vec4 transition(vec2 uv) {
  float p = curve(ease, progress);
  vec4 under = getTo(zoomUV(uv, 1.0 + zoom * (1.0 - p), vec2(0.5)));
  float s = (vertical ? uv.x : uv.y) < 0.5 ? -1.0 : 1.0;
  vec2 q = uv - (vertical ? vec2(s, 0.0) : vec2(0.0, s)) * p * 0.5;
  float qa = vertical ? q.x : q.y;
  bool inside = s < 0.0 ? qa >= 0.0 && qa < 0.5 : qa >= 0.5 && qa <= 1.0;
  if (!inside) return under;
  vec4 f = getFrom(q);
  return f + under * (1.0 - f.a);
}
`;

const shockwaveTr = `// 衝擊波轉場：一圈折射波紋擴散，波內是下一段
// @param strength: float = 0.05 (0..0.2) "扭曲量"
// @param width: float = 0.1 (0.02..0.4) "波寬"
// @param rgb: float = 0.5 (0..1) "色差"
// @param glow: float = 0.3 (0..1) "光環"
// @param center: point = 0.5,0.5 "中心" @follow
// @param ease: curve = inOut3 "曲線"
float m;
vec4 pick(vec2 q) { return mix(getTo(mirrorUV(q)), getFrom(mirrorUV(q)), m); }
vec4 transition(vec2 uv) {
  vec2 p = uv - center;
  p.x *= ASPECT;
  float maxR = length(vec2(max(center.x, 1.0 - center.x) * ASPECT, max(center.y, 1.0 - center.y)));
  float r0 = curve(ease, progress) * (maxR + width * 2.0);
  float d = length(p);
  float x = (d - r0) / width;
  float env = smoothstep(0.0, 0.1, progress);
  float k = -x * exp(-x * x * 2.0) * strength * env;
  vec2 off = d > 1e-4 ? p / d * k : vec2(0.0);
  off.x /= ASPECT;
  m = smoothstep(-0.5, 0.5, x);
  vec4 c = pick(uv + off);
  c.r = pick(uv + off * (1.0 + rgb)).r;
  c.b = pick(uv + off * (1.0 - rgb)).b;
  c.rgb = min(c.rgb + glow * exp(-x * x * 4.0) * env * c.a, vec3(c.a));
  return c;
}
`;

const lensTr = `// 鏡頭扭曲轉場：魚眼鼓起再切到下一段
// @param amount: float = 1.2 (0..3) "扭曲量"
// @param zoom: float = 0.3 (0..1) "放大量"
// @param center: point = 0.5,0.5 "中心" @follow
vec4 transition(vec2 uv) {
  float k = sin(progress * PI);
  vec2 p = uv - center;
  p.x *= ASPECT;
  float r2 = dot(p, p);
  p *= ((1.0 - amount * k * 0.3) + amount * k * r2) / (1.0 + zoom * k);
  p.x /= ASPECT;
  vec2 q = mirrorUV(p + center);
  return mix(getFrom(q), getTo(q), smoothstep(0.45, 0.55, progress));
}
`;

const liquidTr = `// 液化：畫面像水波一樣扭動著換到下一段
// @param amount: float = 0.06 (0..0.3) "扭曲量"
// @param freq: float = 8 (1..30) "波紋密度"
// @param speed: float = 3 (0..10) "流動速度"
vec4 transition(vec2 uv) {
  float k = sin(progress * PI);
  float t = progress * speed * 2.0 * PI;
  vec2 off = vec2(sin(uv.y * freq + t), cos(uv.x * freq * 0.8 - t * 0.7)) * amount * k;
  vec2 q = mirrorUV(uv + off);
  float m = clamp((progress - 0.5) * 3.0 + 0.5 + sin(uv.y * freq * 0.5 + uv.x * 3.0 + t) * 0.2 * k, 0.0, 1.0);
  return mix(getFrom(q), getTo(q), m);
}
`;

const twirlTr = `// 漩渦轉場：捲進漩渦再轉出下一段
// @param angle: float = 4 (-12..12) "旋轉量"
// @param radius: float = 0.8 (0.1..2) "範圍"
// @param center: point = 0.5,0.5 "中心" @follow
vec4 transition(vec2 uv) {
  float k = sin(progress * PI);
  vec2 p = uv - center;
  p.x *= ASPECT;
  float f = clamp(1.0 - length(p) / radius, 0.0, 1.0);
  p = rot(angle * k * f * f) * p;
  p.x /= ASPECT;
  vec2 q = mirrorUV(p + center);
  return mix(getFrom(q), getTo(q), smoothstep(0.4, 0.6, progress));
}
`;

const rgbSplitTr = `// RGB 分離轉場：色差拉開、放大，在最大處切換
// @param amount: float = 0.06 (0..0.2) "分離量"
// @param zoom: float = 0.2 (0..0.6) "放大量"
// @param angle: float = 0 (0..360) "角度（度）"
vec4 pick(vec2 q) { q = mirrorUV(q); return progress < 0.5 ? getFrom(q) : getTo(q); }
vec4 transition(vec2 uv) {
  float k = pow(max(sin(progress * PI), 0.0), 1.5);
  float r = radians(angle);
  vec2 o = vec2(cos(r) / ASPECT, sin(r)) * amount * k;
  vec2 q = zoomUV(uv, 1.0 + zoom * k, vec2(0.5));
  vec4 g = pick(q);
  return vec4(pick(q + o).r, g.g, pick(q - o).b, g.a);
}
`;

const mk = (id: string, kind: ModuleKind, name: string, code: string, rev?: number): Module => ({ id, kind, name, code, builtin: true, ...(rev ? { rev } : {}) });

export const RHYTHM_MODULES: Module[] = [
  mk('fx-shockwave', 'effect', '衝擊波 Shockwave', shockwave, 4),
  mk('fx-chromazoom', 'effect', 'RGB 變焦 Chromatic Zoom', chromaZoom, 4),
  mk('fx-spinkick', 'effect', '旋轉衝擊 Spin Kick', spinKick, 4),
  mk('fx-squash', 'effect', '彈跳擠壓 Squash', squash, 4),
  mk('fx-tilt3d', 'effect', '3D 擺動 3D Swing', tilt3d, 2),
  mk('fx-randomcam', 'effect', '隨機運鏡 Random Camera', randomCam, 2),
  mk('fx-tilezoom', 'effect', '鏡像拼貼 Tile Zoom', tileZoom, 4),
  mk('fx-twitch', 'effect', '抽動 Twitch', twitch, 2),
  mk('fx-blurpulse', 'effect', '模糊脈衝 Blur Pulse', blurPulse, 2),
  mk('fx-zoomecho', 'effect', '縮放殘影 Zoom Echo', zoomEcho, 4),
  mk('fx-slice', 'effect', '切片位移 Slice', sliceFx, 2),
  mk('fx-duotone', 'effect', '雙色調 Duotone', duotone),
  mk('tr-luma', 'transition', '亮度溶解 Luma Fade', lumaTr),
  mk('tr-blur', 'transition', '模糊溶解 Blur Dissolve', blurTr),
  mk('tr-exposure', 'transition', '過曝 Overexposure', exposureTr),
  mk('tr-shake', 'transition', '晃動切換 Shake', shakeTr),
  mk('tr-slice', 'transition', '切片推移 Slice', sliceTr),
  mk('tr-split', 'transition', '中線分開 Split', splitTr),
  mk('tr-shockwave', 'transition', '衝擊波 Shockwave', shockwaveTr, 3),
  mk('tr-lens', 'transition', '鏡頭扭曲 Lens Warp', lensTr, 3),
  mk('tr-liquid', 'transition', '液化 Liquid', liquidTr),
  mk('tr-twirl', 'transition', '漩渦 Twirl', twirlTr, 3),
  mk('tr-rgbsplit', 'transition', 'RGB 分離 RGB Split', rgbSplitTr),
];
