// 剪輯（AMV / Velocity Edit）常用的特效與轉場
import type { Module, ModuleKind } from './builtin';

const shakeBlur = `// 模糊晃動：相機震動 + 依晃動方向的動態模糊（edit 最常用）
// @duration 0.4
// @param strength: float = 0.05 (0..0.2) "晃動幅度"
// @param freq: float = 24 (1..80) "頻率"
// @param blur: float = 1 (0..3) "模糊量"
// @param rotation: float = 0.04 (0..0.3) "旋轉"
// @param decay: float = 2 (0..6) "衰減"
vec2 shakeAt(float t) { return vec2(noise1(t), noise1(t + 37.0)); }
vec4 effect(vec2 uv) {
  float env = pow(1.0 - u_progress, decay);
  float t = u_local * freq;
  vec2 off = shakeAt(t) * strength * env;
  vec2 vel = (shakeAt(t + 0.2) - shakeAt(t - 0.2)) * strength * env * blur;
  float a = noise1(t + 91.0) * rotation * env;
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 16; i++) {
    float f = float(i) / 15.0 - 0.5;
    vec2 p = rotateUV(uv, a, vec2(0.5));
    p = zoomUV(p, 1.0 + strength * 2.0 * env, vec2(0.5)) + off + vel * f;
    acc += tex(mirrorUV(p));
  }
  return acc / 16.0;
}
`;

const motionBlur = `// 方向動態模糊
// @duration 0.4
// @param amount: float = 0.06 (0..0.3) "模糊長度"
// @param angle: float = 0 (0..360) "角度（度）"
// @param decay: float = 1.5 (0..6) "衰減（0 = 固定）"
vec4 effect(vec2 uv) {
  float e = amount * pow(1.0 - u_progress, decay);
  float r = radians(angle);
  vec2 d = vec2(cos(r), sin(r) * ASPECT) * e;
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 24; i++) acc += tex(mirrorUV(uv + d * (float(i) / 23.0 - 0.5)));
  return acc / 24.0;
}
`;

const zoomPulse = `// 縮放脈衝（Zoom Bounce）：鼓點上彈一下
// @duration 0.35
// @param amount: float = 0.15 (0..1) "放大量"
// @param blur: float = 0.4 (0..1) "放射模糊"
// @param bounce: bool = true "回彈"
vec4 effect(vec2 uv) {
  float p = u_progress;
  float k = p < 0.2 ? easeOutExpo(p / 0.2) : 1.0 - easeInOutCubic((p - 0.2) / 0.8);
  if (bounce) k -= 0.25 * sin(PI * clamp((p - 0.55) / 0.45, 0.0, 1.0));
  vec2 c = vec2(0.5);
  vec2 base = zoomUV(uv, 1.0 + amount * k, c);
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 12; i++) acc += tex(mirrorUV(mix(base, c, float(i) / 11.0 * blur * max(k, 0.0) * 0.12)));
  return acc / 12.0;
}
`;

const glitch = `// 故障 Glitch：橫向切片位移 + RGB 分離 + 方塊雜訊
// @duration 0.4
// @param amount: float = 0.7 (0..1) "強度"
// @param slices: float = 24 (4..80) "切片數"
// @param speed: float = 30 (1..60) "跳動速度"
// @param rgb: float = 0.02 (0..0.08) "色差"
// @param decay: float = 1 (0..6) "衰減"
vec4 effect(vec2 uv) {
  float e = amount * pow(1.0 - u_progress, decay);
  float tt = floor(u_local * speed);
  float row = floor(uv.y * slices);
  float r = rand(vec2(row, tt));
  float shift = (r - 0.5) * 0.25 * e * step(1.0 - e * 0.8, rand(vec2(row * 1.7, tt + 3.0)));
  vec2 blk = floor(uv * vec2(8.0, 14.0));
  float b = step(1.0 - e * 0.25, rand(blk + tt));
  vec2 p = uv + vec2(shift + b * (rand(blk) - 0.5) * 0.1, 0.0);
  float c = rgb * e * (0.5 + r);
  return vec4(tex(mirrorUV(p + vec2(c, 0.0))).r, tex(mirrorUV(p)).g, tex(mirrorUV(p - vec2(c, 0.0))).b, 1.0);
}
`;

const strobe = `// 頻閃 Strobe / Flicker
// @duration 0.5
// @param rate: float = 12 (1..30) "每秒次數"
// @param depth: float = 0.85 (0..1) "深度"
// @param white: bool = false "閃白（否則閃黑）"
// @param random: bool = true "隨機節奏"
vec4 effect(vec2 uv) {
  float i = floor(u_local * rate);
  float on = random ? step(0.5, rand(vec2(i, 7.0))) : mod(i, 2.0);
  vec4 c = tex(uv);
  c.rgb = mix(c.rgb, white ? vec3(1.0) : vec3(0.0), on * depth);
  return c;
}
`;

const invert = `// 反相閃
// @duration 0.2
// @param amount: float = 1 (0..1) "強度"
// @param decay: float = 2 (0..8) "衰減"
vec4 effect(vec2 uv) {
  vec4 c = tex(uv);
  c.rgb = mix(c.rgb, 1.0 - c.rgb, amount * pow(1.0 - u_progress, decay));
  return c;
}
`;

const hueShift = `// 色相偏移 / 顏色脈衝
// @duration 1
// @param shift: float = 180 (0..360) "色相旋轉（度）"
// @param animate: bool = true "隨時間旋轉"
// @param saturation: float = 1.2 (0..2) "飽和"
vec3 hueRotate(vec3 c, float a) {
  vec3 k = vec3(0.57735);
  float ca = cos(a);
  return c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca);
}
vec4 effect(vec2 uv) {
  vec4 c = tex(uv);
  c.rgb = hueRotate(c.rgb, radians(shift) * (animate ? u_progress : 1.0));
  float l = dot(c.rgb, vec3(0.299, 0.587, 0.114));
  c.rgb = mix(vec3(l), c.rgb, saturation);
  return clamp(c, 0.0, 1.0);
}
`;

const glow = `// 光暈 Glow（亮部擴散，類似 Deep Glow）
// @duration 1
// @param threshold: float = 0.6 (0..1) "亮度門檻"
// @param intensity: float = 1.2 (0..4) "強度"
// @param radius: float = 0.025 (0..0.08) "半徑"
// @param tint: color = #ffffff "顏色"
// @param fade: bool = false "隨時間淡出"
vec3 bright(vec2 p) {
  vec3 c = tex(p).rgb;
  return c * smoothstep(threshold, threshold + 0.15, max(c.r, max(c.g, c.b)));
}
vec4 effect(vec2 uv) {
  vec4 c = tex(uv);
  vec3 acc = vec3(0.0);
  for (int i = 0; i < 12; i++) {
    float a = float(i) / 12.0 * 2.0 * PI;
    for (int j = 1; j <= 3; j++) acc += bright(uv + vec2(cos(a), sin(a) * ASPECT) * radius * float(j) / 3.0);
  }
  c.rgb += acc / 36.0 * intensity * tint * (fade ? 1.0 - u_progress : 1.0);
  return c;
}
`;

const wave = `// 波浪扭曲 Wave Warp
// @duration 0.8
// @param amplitude: float = 0.02 (0..0.1) "振幅"
// @param waves: float = 6 (1..30) "波數"
// @param speed: float = 4 (0..20) "速度"
// @param vertical: bool = false "垂直方向"
// @param decay: float = 0 (0..6) "衰減"
vec4 effect(vec2 uv) {
  float e = amplitude * pow(1.0 - u_progress, decay);
  float ph = u_local * speed * 2.0 * PI;
  vec2 p = uv;
  if (vertical) p.y += sin(uv.x * waves * 2.0 * PI + ph) * e;
  else p.x += sin(uv.y * waves * 2.0 * PI + ph) * e;
  return tex(mirrorUV(p));
}
`;

const twirl = `// 漩渦 Twirl
// @duration 0.5
// @param angle: float = 3 (-10..10) "旋轉量"
// @param radius: float = 0.6 (0.1..1.5) "範圍"
// @param decay: float = 2 (0..6) "衰減"
vec4 effect(vec2 uv) {
  vec2 p = uv - 0.5;
  p.x *= ASPECT;
  float k = angle * pow(1.0 - u_progress, decay) * smoothstep(radius, 0.0, length(p));
  p = rot(k) * p;
  p.x /= ASPECT;
  return tex(mirrorUV(p + 0.5));
}
`;

const mirror = `// 鏡像 Mirror
// @duration 2
// @param mode: int = 0 (0..3) "模式 0左右 1上下 2四格 3反向"
vec4 effect(vec2 uv) {
  vec2 p = uv;
  if (mode == 0 || mode == 2) p.x = p.x < 0.5 ? p.x : 1.0 - p.x;
  if (mode == 1 || mode == 2) p.y = p.y < 0.5 ? p.y : 1.0 - p.y;
  if (mode == 3) p.x = p.x > 0.5 ? p.x : 1.0 - p.x;
  return tex(p);
}
`;

const split = `// 分割畫面 Split Screen（同畫面重複多格）
// @duration 1
// @param cols: int = 2 (1..6) "欄"
// @param rows: int = 3 (1..6) "列"
// @param gap: float = 0.006 (0..0.05) "間隔"
// @param gapColor: color = #000000 "間隔顏色"
// @param popIn: bool = true "逐格出現"
vec4 effect(vec2 uv) {
  vec2 n = vec2(float(cols), float(rows));
  vec2 cell = floor(uv * n);
  vec2 f = fract(uv * n);
  float idx = cell.x + (n.y - 1.0 - cell.y) * n.x;
  if (popIn && idx / (n.x * n.y) > u_progress * 1.6) return vec4(gapColor, 1.0);
  vec2 g = vec2(gap) * n * 0.5;
  if (any(lessThan(f, g)) || any(greaterThan(f, 1.0 - g))) return vec4(gapColor, 1.0);
  // 每格用裁切保持比例
  float r = n.y / n.x;
  if (r > 1.0) f.y = 0.5 + (f.y - 0.5) / r; else f.x = 0.5 + (f.x - 0.5) * r;
  return tex(f);
}
`;

const kaleido = `// 萬花筒 Kaleidoscope
// @duration 1
// @param segments: float = 6 (2..16) "分割數"
// @param spin: float = 0.5 (-4..4) "旋轉速度"
// @param zoom: float = 1 (0.3..3) "縮放"
vec4 effect(vec2 uv) {
  vec2 p = uv - 0.5;
  p.x *= ASPECT;
  float a = atan(p.y, p.x) + u_local * spin;
  float r = length(p) / zoom;
  float seg = 2.0 * PI / segments;
  a = abs(mod(a, seg) - seg * 0.5);
  vec2 q = vec2(cos(a), sin(a)) * r;
  q.x /= ASPECT;
  return tex(mirrorUV(q + 0.5));
}
`;

const pixelate = `// 像素化 / 馬賽克
// @duration 0.4
// @param size: float = 40 (2..200) "格子大小（px）"
// @param decay: float = 2 (0..6) "衰減（0 = 固定）"
vec4 effect(vec2 uv) {
  float s = max(1.0, size * pow(1.0 - u_progress, decay));
  vec2 px = u_resolution / s;
  return tex((floor(uv * px) + 0.5) / px);
}
`;

const bw = `// 黑白高反差
// @duration 0.4
// @param contrast: float = 1.8 (1..4) "對比"
// @param amount: float = 1 (0..1) "混合"
// @param decay: float = 0 (0..6) "衰減"
vec4 effect(vec2 uv) {
  vec4 c = tex(uv);
  float l = clamp((dot(c.rgb, vec3(0.299, 0.587, 0.114)) - 0.5) * contrast + 0.5, 0.0, 1.0);
  c.rgb = mix(c.rgb, vec3(l), amount * pow(1.0 - u_progress, decay));
  return c;
}
`;

const vhs = `// VHS 掃描線
// @duration 2
// @param lines: float = 400 (50..1000) "掃描線數"
// @param grain: float = 0.08 (0..0.4) "雜訊"
// @param bleed: float = 0.004 (0..0.02) "色彩溢出"
// @param jitter: float = 0.003 (0..0.02) "抖動"
vec4 effect(vec2 uv) {
  float tt = floor(u_local * 30.0);
  vec2 p = uv;
  p.x += (rand(vec2(floor(uv.y * 120.0), tt)) - 0.5) * jitter;
  vec4 c = vec4(tex(p + vec2(bleed, 0.0)).r, tex(p).g, tex(p - vec2(bleed, 0.0)).b, 1.0);
  c.rgb *= 0.85 + 0.15 * sin(uv.y * lines * PI);
  c.rgb += (rand(uv * u_resolution + tt) - 0.5) * grain;
  return clamp(c, 0.0, 1.0);
}
`;

const letterbox = `// 電影黑邊
// @duration 3
// @param size: float = 0.12 (0..0.4) "黑邊高度"
// @param animate: bool = true "滑入"
// @param barColor: color = #000000 "顏色"
vec4 effect(vec2 uv) {
  float s = size * (animate ? easeOutExpo(min(1.0, u_local / 0.5)) : 1.0);
  if (uv.y < s || uv.y > 1.0 - s) return vec4(barColor, 1.0);
  return tex(uv);
}
`;

const lightLeak = `// 漏光 Light Leak
// @duration 1.5
// @param intensity: float = 0.8 (0..2) "強度"
// @param warm: color = #ff7a2e "主色"
// @param second: color = #ff2e8a "副色"
// @param speed: float = 0.6 (0..3) "飄移速度"
vec4 effect(vec2 uv) {
  vec4 c = tex(uv);
  float t = u_local * speed;
  vec2 p = uv;
  p.x *= ASPECT;
  vec2 a = vec2((0.2 + 0.3 * sin(t * 1.3)) * ASPECT, 0.3 + 0.4 * cos(t * 0.7));
  vec2 b = vec2((0.8 + 0.2 * cos(t * 1.1)) * ASPECT, 0.7 + 0.3 * sin(t * 0.9));
  float la = exp(-pow(length(p - a) * 2.2, 2.0));
  float lb = exp(-pow(length(p - b) * 2.6, 2.0));
  vec3 light = (warm * la + second * lb) * intensity * sin(PI * u_progress);
  c.rgb = 1.0 - (1.0 - c.rgb) * (1.0 - clamp(light, 0.0, 1.0));
  return c;
}
`;

const grainFx = `// 底片顆粒
// @duration 3
// @param amount: float = 0.1 (0..0.5) "顆粒量"
// @param size: float = 1.5 (1..6) "顆粒大小"
// @param mono: bool = true "單色"
vec4 effect(vec2 uv) {
  vec4 c = tex(uv);
  vec2 g = floor(uv * u_resolution / size);
  float tt = floor(u_local * 24.0);
  vec3 n = mono ? vec3(rand(g + tt)) : vec3(rand(g + tt), rand(g + tt + 1.3), rand(g + tt + 2.7));
  c.rgb += (n - 0.5) * amount;
  return clamp(c, 0.0, 1.0);
}
`;

const outline = `// 描邊 / 線稿（Edge）
// @duration 1
// @param strength: float = 2 (0..6) "線條強度"
// @param lineColor: color = #ffffff "線條顏色"
// @param keep: float = 0.3 (0..1) "保留原畫面"
// @param glowLine: bool = true "線條發光"
float lum(vec2 p) { return dot(tex(p).rgb, vec3(0.299, 0.587, 0.114)); }
vec4 effect(vec2 uv) {
  vec2 px = 1.5 / u_resolution;
  float gx = lum(uv + vec2(px.x, 0.0)) - lum(uv - vec2(px.x, 0.0));
  float gy = lum(uv + vec2(0.0, px.y)) - lum(uv - vec2(0.0, px.y));
  float e = clamp(length(vec2(gx, gy)) * strength * 4.0, 0.0, 1.0);
  vec3 base = tex(uv).rgb * keep;
  vec3 col = glowLine ? base + lineColor * e : mix(base, lineColor, e);
  return vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

// ───────── 轉場 ─────────

const pixelTr = `// 像素化轉場
// @param maxSize: float = 60 (4..200) "最大格子（px）"
vec4 transition(vec2 uv) {
  float k = 1.0 - abs(progress * 2.0 - 1.0);
  float s = max(1.0, maxSize * k * k);
  vec2 px = u_resolution / s;
  vec2 q = (floor(uv * px) + 0.5) / px;
  return progress < 0.5 ? getFrom(q) : getTo(q);
}
`;

const glitchTr = `// 故障轉場
// @param amount: float = 1 (0..2) "強度"
// @param slices: float = 30 (4..80) "切片數"
vec4 transition(vec2 uv) {
  float k = sin(progress * PI) * amount;
  float tt = floor(progress * 40.0);
  float row = floor(uv.y * slices);
  vec2 p = vec2(uv.x + (rand(vec2(row, tt)) - 0.5) * 0.3 * k, uv.y);
  bool useTo = rand(vec2(row * 3.1, tt)) < progress;
  vec4 a = useTo ? getTo(mirrorUV(p)) : getFrom(mirrorUV(p));
  vec2 q = mirrorUV(p + vec2(0.03 * k, 0.0));
  a.r = useTo ? getTo(q).r : getFrom(q).r;
  return a;
}
`;

const stretch = `// 拉伸擠壓 Stretch
// @param vertical: bool = false "垂直"
// @param power: float = 6 (1..20) "拉伸量"
vec4 transition(vec2 uv) {
  float p = easeInOutCubic(progress);
  vec2 q = uv - 0.5;
  float k = p < 0.5 ? 1.0 + power * pow(p * 2.0, 2.0) : 1.0 + power * pow((1.0 - p) * 2.0, 2.0);
  if (vertical) q.y /= k; else q.x /= k;
  q += 0.5;
  return p < 0.5 ? getFrom(mirrorUV(q)) : getTo(mirrorUV(q));
}
`;

const clockWipe = `// 時鐘擦除 Radial Wipe
// @param softness: float = 0.02 (0..0.2) "柔化"
// @param reverse: bool = false "逆時針"
vec4 transition(vec2 uv) {
  vec2 p = uv - 0.5;
  p.x *= ASPECT;
  float a = atan(p.x, -p.y) / (2.0 * PI) + 0.5;
  if (reverse) a = 1.0 - a;
  float pr = progress * (1.0 + 2.0 * softness) - softness;
  float m = smoothstep(pr - softness, pr + softness, a);
  return mix(getTo(uv), getFrom(uv), m);
}
`;

const zoomBlurTr = `// 縮放模糊轉場（拉遠 → 推近）
// @param strength: float = 0.6 (0..2) "縮放量"
// @param blur: float = 0.5 (0..1) "模糊"
// @param cx: float = 0.5 (0..1) "中心 X"
// @param cy: float = 0.5 (0..1) "中心 Y"
vec4 radialS(sampler2D s, vec2 uv, float z, float b) {
  vec2 c = vec2(cx, cy);
  vec2 base = zoomUV(uv, z, c);
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 14; i++) acc += texture(s, mirrorUV(mix(base, c, float(i) / 13.0 * b)));
  return acc / 14.0;
}
vec4 transition(vec2 uv) {
  float k = sin(progress * PI);
  float z = 1.0 / (1.0 + strength * k);
  return progress < 0.5 ? radialS(u_from, uv, z, blur * k * 0.3) : radialS(u_to, uv, z, blur * k * 0.3);
}
`;

const chromaKey = `// 去背（色鍵）：把指定顏色變透明。建議拖到片段上當片段特效
// @param key: color = #00ff00 "去背顏色"
// @param similarity: float = 0.4 (0..1) "相似度"
// @param smoothness: float = 0.08 (0..0.5) "邊緣柔化"
// @param spill: float = 0.5 (0..1) "溢色抑制"
vec2 chroma(vec3 c) { return vec2(-0.169 * c.r - 0.331 * c.g + 0.5 * c.b, 0.5 * c.r - 0.419 * c.g - 0.081 * c.b); }
vec4 effect(vec2 uv) {
  vec4 s = tex(uv);
  if (s.a <= 0.0) return s;
  vec3 c = s.rgb / s.a; // 輸入是 premultiplied
  float d = distance(chroma(c), chroma(key)) * 2.0;
  float a = smoothstep(similarity * 0.5, similarity * 0.5 + smoothness, d);
  // 溢色：邊緣殘留的去背顏色往灰階拉
  float sp = pow(clamp(1.0 - d / max(similarity + smoothness, 1e-3), 0.0, 1.0), 1.5) * spill;
  float luma = dot(c, vec3(0.299, 0.587, 0.114));
  c = mix(c, vec3(luma), sp);
  float outA = s.a * a;
  return vec4(c * outA, outA);
}
`;

const scaleIn = `// 縮放推入：新畫面從小放大蓋上來
// @param from: float = 0.3 (0..1) "起始大小"
// @param cx: float = 0.5 (0..1) "中心 X"
// @param cy: float = 0.5 (0..1) "中心 Y"
vec4 transition(vec2 uv) {
  float p = easeOutBack(clamp(progress, 0.0, 1.0));
  float z = mix(from, 1.0, p);
  vec2 q = zoomUV(uv, z, vec2(cx, cy));
  vec4 b = getFrom(zoomUV(uv, 1.0 + progress * 0.15, vec2(cx, cy))) * (1.0 - progress * 0.4);
  if (q.x < 0.0 || q.x > 1.0 || q.y < 0.0 || q.y > 1.0) return b;
  vec4 t = getTo(q) * smoothstep(0.0, 0.25, progress);
  return t + b * (1.0 - t.a);
}
`;

const scaleOut = `// 縮放推出：舊畫面縮小飛走，露出新畫面
// @param to: float = 0.2 (0..1) "結束大小"
// @param spin: float = 0 (-2..2) "旋轉圈數"
// @param cx: float = 0.5 (0..1) "中心 X"
// @param cy: float = 0.5 (0..1) "中心 Y"
vec4 transition(vec2 uv) {
  float p = easeInOutCubic(clamp(progress, 0.0, 1.0));
  vec2 c = vec2(cx, cy);
  vec2 q = rotateUV(zoomUV(uv, mix(1.0, to, p), c), -spin * 2.0 * PI * p, c);
  vec4 b = getTo(zoomUV(uv, mix(0.85, 1.0, p), c));
  if (q.x < 0.0 || q.x > 1.0 || q.y < 0.0 || q.y > 1.0) return b;
  vec4 f = getFrom(q) * (1.0 - smoothstep(0.75, 1.0, progress));
  return f + b * (1.0 - f.a);
}
`;

const pushTr = `// 推移：新畫面把舊畫面推出去（帶一點動態模糊）
// @param dir: int = 0 (0..3) "方向（0 左 1 右 2 上 3 下）"
// @param blur: float = 0.4 (0..1) "模糊"
vec4 transition(vec2 uv) {
  float p = easeInOutCubic(clamp(progress, 0.0, 1.0));
  vec2 d = dir == 0 ? vec2(-1.0, 0.0) : dir == 1 ? vec2(1.0, 0.0) : dir == 2 ? vec2(0.0, 1.0) : vec2(0.0, -1.0);
  float sp = sin(progress * PI) * blur * 0.08;
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 8; i++) {
    vec2 o = uv - d * p + d * sp * (float(i) / 7.0 - 0.5);
    vec2 f = o;
    vec2 t = o + d;
    bool inF = f.x >= 0.0 && f.x <= 1.0 && f.y >= 0.0 && f.y <= 1.0;
    acc += inF ? getFrom(f) : getTo(clamp(t, 0.0, 1.0));
  }
  return acc / 8.0;
}
`;

const flipTr = `// 翻轉：像卡片一樣水平翻面
// @param depth: float = 0.4 (0..1) "透視"
vec4 transition(vec2 uv) {
  float p = easeInOutCubic(clamp(progress, 0.0, 1.0));
  float a = p * PI;
  float w = abs(cos(a));
  if (w < 1e-3) return vec4(0.0);
  float x = (uv.x - 0.5) / w;
  float side = p < 0.5 ? 1.0 : -1.0;
  // 簡單透視：靠近的一側比較高
  float persp = 1.0 + depth * sin(a) * x * side;
  float y = (uv.y - 0.5) / persp + 0.5;
  vec2 q = vec2(x + 0.5, y);
  if (q.x < 0.0 || q.x > 1.0 || q.y < 0.0 || q.y > 1.0) return vec4(0.0);
  vec4 c = p < 0.5 ? getFrom(q) : getTo(vec2(q.x, q.y));
  return c * (0.6 + 0.4 * w);
}
`;

const rewindTr = `// 倒帶：VHS 倒帶感的抖動條紋與色偏
// @param amount: float = 0.6 (0..1) "強度"
vec4 transition(vec2 uv) {
  float k = sin(progress * PI) * amount;
  float band = floor(uv.y * 40.0);
  float jitter = (rand(vec2(band, floor(progress * 30.0))) - 0.5) * 0.12 * k;
  float roll = fract(uv.y + progress * 3.0 * k);
  vec2 q = vec2(uv.x + jitter, mix(uv.y, roll, k * 0.35));
  vec4 a = progress < 0.5 ? getFrom(q) : getTo(q);
  vec4 r = progress < 0.5 ? getFrom(q + vec2(0.012 * k, 0.0)) : getTo(q + vec2(0.012 * k, 0.0));
  vec4 b = progress < 0.5 ? getFrom(q - vec2(0.012 * k, 0.0)) : getTo(q - vec2(0.012 * k, 0.0));
  vec4 c = vec4(r.r, a.g, b.b, a.a);
  float line = step(0.97, fract(uv.y * 120.0 + progress * 50.0)) * k * 0.3;
  return c + vec4(vec3(line), 0.0) * c.a;
}
`;

/** 片段遮罩：特效本身輸出透明，渲染時遮罩會自動反轉 → 只保留遮罩範圍內的畫面 */
export const CLIP_MASK_ID = 'fx-clipmask';
const clipMask = `// 片段遮罩：只保留遮罩範圍內的畫面（遮罩外變透明）
// 在屬性面板的「遮罩」設定形狀、位置、羽化；反轉 = 挖掉遮罩範圍
vec4 effect(vec2 uv) { return vec4(0.0); }
`;

const mk = (id: string, kind: ModuleKind, name: string, code: string, rev?: number): Module => ({ id, kind, name, code, builtin: true, ...(rev ? { rev } : {}) });

export const EXTRA_MODULES: Module[] = [
  mk('fx-shakeblur', 'effect', '模糊晃動 Shake Blur', shakeBlur),
  mk('fx-motionblur', 'effect', '動態模糊 Motion Blur', motionBlur),
  mk('fx-zoompulse', 'effect', '縮放脈衝 Zoom Bounce', zoomPulse),
  mk('fx-glitch', 'effect', '故障 Glitch', glitch),
  mk('fx-strobe', 'effect', '頻閃 Strobe', strobe),
  mk('fx-invert', 'effect', '反相閃 Invert', invert),
  mk('fx-hue', 'effect', '色相偏移 Hue Shift', hueShift),
  mk('fx-glow', 'effect', '光暈 Glow', glow),
  mk('fx-wave', 'effect', '波浪扭曲 Wave Warp', wave),
  mk('fx-twirl', 'effect', '漩渦 Twirl', twirl),
  mk('fx-mirror', 'effect', '鏡像 Mirror', mirror),
  mk('fx-split', 'effect', '分割畫面 Split Screen', split),
  mk('fx-kaleido', 'effect', '萬花筒 Kaleidoscope', kaleido),
  mk('fx-pixelate', 'effect', '像素化 Pixelate', pixelate),
  mk('fx-bw', 'effect', '黑白高反差 B&W', bw),
  mk('fx-vhs', 'effect', 'VHS 掃描線', vhs),
  mk('fx-letterbox', 'effect', '電影黑邊 Letterbox', letterbox),
  mk('fx-lightleak', 'effect', '漏光 Light Leak', lightLeak),
  mk('fx-grain', 'effect', '底片顆粒 Grain', grainFx),
  mk('fx-outline', 'effect', '描邊 Outline', outline),
  mk('fx-chromakey', 'effect', '去背 Chroma Key', chromaKey),
  mk(CLIP_MASK_ID, 'effect', '片段遮罩 Clip Mask', clipMask),
  mk('tr-pixelate', 'transition', '像素化 Pixelate', pixelTr),
  mk('tr-glitch', 'transition', '故障 Glitch', glitchTr),
  mk('tr-stretch', 'transition', '拉伸 Stretch', stretch),
  mk('tr-clock', 'transition', '時鐘擦除 Radial', clockWipe),
  mk('tr-zoomblur', 'transition', '縮放模糊 Zoom Blur', zoomBlurTr, 2),
  mk('tr-scalein', 'transition', '縮放推入 Scale In', scaleIn),
  mk('tr-scaleout', 'transition', '縮放推出 Scale Out', scaleOut),
  mk('tr-push', 'transition', '推移 Push', pushTr),
  mk('tr-flip', 'transition', '翻轉 Flip', flipTr),
  mk('tr-rewind', 'transition', '倒帶 Rewind', rewindTr),
];
