import { EXTRA_MODULES } from './extra';
export type ModuleKind = 'effect' | 'transition' | 'remap';
export interface Module {
  id: string;
  kind: ModuleKind;
  name: string;
  code: string;
  builtin?: boolean;
  /** 內建模組的版本：改了內建程式碼就 +1，舊存檔裡的同 id 程式碼會被新版取代 */
  rev?: number;
}

// ───────────────────────── 特效（GLSL）─────────────────────────
// 寫一個 vec4 effect(vec2 uv)；可用：tex(uv)、u_progress(0→1)、u_local(秒)、
// u_duration、u_time、ASPECT、PI、rand()、noise1()、rotateUV()、zoomUV()、mirrorUV()、easeXxx()、curve(曲線參數, x)

const crashZoom = `// 衝擊變焦：一開始猛衝進去再快速回穩
// @duration 0.4
// @param amount: float = 0.6 (0..2) "變焦量"
// @param blur: float = 0.6 (0..1) "放射模糊"
// @param zoomOut: bool = false "反向（拉遠）"
// @param center: point = 0.5,0.5 "中心"
// @param ease: curve = expoOut "曲線"
vec4 effect(vec2 uv) {
  float k = 1.0 - curve(ease, u_progress);      // 1 → 0
  float z = zoomOut ? 1.0 / (1.0 + amount * k) : 1.0 + amount * k;
  vec2 c = center;
  vec2 base = zoomUV(uv, z, c);
  float s = blur * k * 0.25;
  vec4 col = vec4(0.0);
  for (int i = 0; i < 16; i++) {
    float f = float(i) / 15.0;
    col += tex(mirrorUV(mix(base, c, f * s)));
  }
  return col / 16.0;
}
`;

const shake = `// 相機震動：鼓點上放一小段就很有感
// @duration 0.35
// @param strength: float = 0.04 (0..0.2) "位移幅度"
// @param rotation: float = 0.05 (0..0.4) "旋轉幅度"
// @param freq: float = 30 (1..80) "頻率"
// @param decay: float = 2 (0..6) "衰減"
vec4 effect(vec2 uv) {
  float env = pow(1.0 - u_progress, decay);
  float t = u_local * freq;
  vec2 off = vec2(noise1(t), noise1(t + 37.0)) * strength * env;
  float a = noise1(t + 91.0) * rotation * env;
  vec2 p = rotateUV(uv, a, vec2(0.5));
  p = zoomUV(p, 1.0 + strength * 2.0 * env, vec2(0.5)) + off;
  return tex(mirrorUV(p));
}
`;

const flash = `// 曝光閃白
// @duration 0.25
// @param intensity: float = 1 (0..3) "強度"
// @param decay: float = 3 (0.5..8) "衰減"
// @param tint: color = #ffffff "顏色"
vec4 effect(vec2 uv) {
  vec4 c = tex(uv);
  float e = intensity * pow(1.0 - u_progress, decay);
  c.rgb += tint * e;
  return c;
}
`;

const rgbSplit = `// RGB 色差分離
// @duration 0.4
// @param amount: float = 0.02 (0..0.1) "分離量"
// @param decay: float = 1.5 (0..6) "衰減"
// @param radial: bool = true "放射狀"
// @param angle: float = 0 (0..6.283) "方向（非放射時）"
vec4 effect(vec2 uv) {
  float e = amount * pow(1.0 - u_progress, decay);
  vec2 dir = radial ? (uv - 0.5) * 2.0 : vec2(cos(angle), sin(angle));
  vec4 c = tex(uv);
  c.r = tex(uv + dir * e).r;
  c.b = tex(uv - dir * e).b;
  return c;
}
`;

const lens = `// 魚眼 / 鏡頭扭曲
// @duration 0.4
// @param amount: float = 0.6 (-1..2) "扭曲量"
// @param decay: float = 2 (0..6) "衰減"
// @param center: point = 0.5,0.5 "中心"
vec4 effect(vec2 uv) {
  float k = amount * pow(1.0 - u_progress, decay);
  vec2 p = uv - center;
  p.x *= ASPECT;
  float r2 = dot(p, p);
  p *= (1.0 - k * 0.3) + k * r2;
  p.x /= ASPECT;
  return tex(mirrorUV(p + center));
}
`;

const speedLines = `// 速度線（漫畫集中線）
// @duration 0.6
// @param count: float = 90 (10..300) "線條數量"
// @param thickness: float = 0.35 (0.01..1) "線條密度"
// @param inner: float = 0.3 (0..1) "內圈半徑"
// @param speed: float = 14 (0..60) "閃動速度"
// @param opacity: float = 0.85 (0..1) "不透明度"
// @param tint: color = #ffffff "顏色"
// @param center: point = 0.5,0.5 "中心"
vec4 effect(vec2 uv) {
  vec4 c = tex(uv);
  vec2 p = uv - center;
  p.x *= ASPECT;
  float ang = atan(p.y, p.x) / (2.0 * PI) + 0.5;
  float r = length(p);
  float id = floor(ang * count);
  float n = rand(vec2(id, floor(u_local * speed)));
  float line = step(1.0 - thickness, n);
  float fr = fract(ang * count);
  float w = smoothstep(0.0, 0.5, fr) * smoothstep(1.0, 0.5, fr);
  float mask = line * w * smoothstep(inner, inner + 0.3, r + n * 0.1);
  c.rgb = mix(c.rgb, tint, mask * opacity);
  return c;
}
`;

const entrance = `// 進場變換：位置 / 縮放 / 旋轉 + 過衝回彈
// @duration 0.6
// @param fromScale: float = 1.8 (0.1..4) "起始縮放"
// @param fromX: float = 0 (-1..1) "起始 X"
// @param fromY: float = -0.3 (-1..1) "起始 Y"
// @param fromRot: float = 0.4 (-3.14..3.14) "起始旋轉"
// @param ease: curve = back "曲線"
// @param bg: color = #000000 "背景色"
vec4 effect(vec2 uv) {
  float p = curve(ease, u_progress);
  float s = mix(fromScale, 1.0, p);
  vec2 off = mix(vec2(fromX, fromY), vec2(0.0), p);
  float a = mix(fromRot, 0.0, p);
  vec2 q = uv - off;
  q = rotateUV(q, a, vec2(0.5));
  q = zoomUV(q, s, vec2(0.5));
  if (any(lessThan(q, vec2(0.0))) || any(greaterThan(q, vec2(1.0)))) return vec4(bg, 1.0);
  return tex(q);
}
`;

const grade = `// 調色 + 暗角（適合拉長當整段濾鏡）
// @duration 3
// @param contrast: float = 1.15 (0.5..2) "對比"
// @param saturation: float = 1.25 (0..2) "飽和"
// @param vignette: float = 0.4 (0..1) "暗角"
// @param tint: color = #ffffff "色調"
vec4 effect(vec2 uv) {
  vec4 c = tex(uv);
  c.rgb = (c.rgb - 0.5) * contrast + 0.5;
  float l = dot(c.rgb, vec3(0.299, 0.587, 0.114));
  c.rgb = mix(vec3(l), c.rgb, saturation) * tint;
  vec2 p = uv - 0.5;
  p.x *= ASPECT;
  c.rgb *= 1.0 - vignette * smoothstep(0.3, 0.9, length(p) * 1.4);
  return clamp(c, 0.0, 1.0);
}
`;

// ───────────────────────── 轉場（GLSL）─────────────────────────
// 寫一個 vec4 transition(vec2 uv)；可用：getFrom(uv)、getTo(uv)、progress(0→1)、u_from、u_to

const crossfade = `// 溶接
// @param ease: curve = inOut3 "曲線"
vec4 transition(vec2 uv) {
  float p = curve(ease, progress);
  return mix(getFrom(uv), getTo(uv), p);
}
`;

const crashZoomTr = `// 衝擊變焦轉場：前一段衝進去，下一段從放大狀態回穩
// @param strength: float = 1.2 (0..3) "變焦強度"
// @param blur: float = 0.7 (0..1) "放射模糊"
// @param center: point = 0.5,0.5 "中心"
vec4 radial(sampler2D s, vec2 uv, float z, float b) {
  vec2 c = center;
  vec2 base = zoomUV(uv, z, c);
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 16; i++) {
    float f = float(i) / 15.0;
    acc += texture(s, mirrorUV(mix(base, c, f * b)));
  }
  return acc / 16.0;
}
vec4 transition(vec2 uv) {
  if (progress < 0.5) {
    float k = easeInExpo(progress * 2.0);
    return radial(u_from, uv, 1.0 + strength * k, blur * k * 0.3);
  }
  float k = 1.0 - easeOutExpo((progress - 0.5) * 2.0);
  return radial(u_to, uv, 1.0 + strength * k, blur * k * 0.3);
}
`;

const whipPan = `// 高速甩鏡 + 方向動態模糊
// @param vertical: bool = false "垂直方向"
// @param reverse: bool = false "反向"
// @param blur: float = 0.25 (0..0.6) "模糊長度"
// @param ease: curve = inOut3 "曲線"
vec4 strip(vec2 q, vec2 d, float sgn) {
  float a = dot(q, d);
  bool fromSide = sgn > 0.0 ? a < 1.0 : a >= 0.0;
  return fromSide ? getFrom(mirrorUV(q)) : getTo(mirrorUV(q - d * sgn));
}
vec4 transition(vec2 uv) {
  vec2 d = vertical ? vec2(0.0, 1.0) : vec2(1.0, 0.0);
  float sgn = reverse ? -1.0 : 1.0;
  float e = curve(ease, progress);
  float b = sin(progress * PI) * blur;
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 24; i++) {
    float f = float(i) / 23.0 - 0.5;
    acc += strip(uv + d * sgn * (e + f * b), d, sgn);
  }
  return acc / 24.0;
}
`;

const spin = `// 旋轉衝擊
// @param turns: float = 1 (0..4) "圈數"
// @param zoom: float = 0.5 (0..2) "拉遠量"
// @param blur: float = 0.6 (0..1.5) "旋轉模糊"
// @param center: point = 0.5,0.5 "中心"
// @param ease: curve = inOut3 "曲線"
vec4 transition(vec2 uv) {
  float e = curve(ease, progress);
  float a = e * turns * 2.0 * PI;
  float z = 1.0 / (1.0 + zoom * sin(progress * PI));
  float spread = blur * sin(progress * PI) * 0.5;
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 14; i++) {
    float f = float(i) / 13.0 - 0.5;
    vec2 q = mirrorUV(zoomUV(rotateUV(uv, a + f * spread, center), z, center));
    acc += progress < 0.5 ? getFrom(q) : getTo(q);
  }
  return acc / 14.0;
}
`;

const diagonal = `// 斜切遮罩
// @param angle: float = 0.785 (0..6.283) "角度"
// @param softness: float = 0.01 (0..0.3) "邊緣柔化"
// @param lineWidth: float = 0.012 (0..0.06) "邊線寬"
// @param lineColor: color = #ffffff "邊線顏色"
// @param ease: curve = inOut3 "曲線"
vec4 transition(vec2 uv) {
  vec2 d = vec2(cos(angle), sin(angle));
  vec2 p = uv - 0.5;
  p.x *= ASPECT;
  float proj = dot(p, d);
  float ext = abs(d.x) * ASPECT * 0.5 + abs(d.y) * 0.5 + softness + lineWidth;
  float edge = mix(-ext, ext, curve(ease, progress));
  float m = smoothstep(edge - softness, edge + softness, proj);
  vec4 c = mix(getTo(uv), getFrom(uv), m);
  float line = (1.0 - smoothstep(lineWidth, lineWidth + 0.003, abs(proj - edge))) * step(0.0001, lineWidth);
  return mix(c, vec4(lineColor, 1.0), line);
}
`;

const iris = `// 圓形擴散遮罩
// @param center: point = 0.5,0.5 "中心"
// @param softness: float = 0.02 (0..0.3) "邊緣柔化"
// @param ease: curve = inOut3 "曲線"
vec4 transition(vec2 uv) {
  vec2 p = uv - center;
  p.x *= ASPECT;
  float maxR = length(vec2(max(center.x, 1.0 - center.x) * ASPECT, max(center.y, 1.0 - center.y)));
  float r = curve(ease, progress) * (maxR + softness);
  float m = smoothstep(r - softness, r, length(p));
  return mix(getTo(uv), getFrom(uv), m);
}
`;

const flashCut = `// 閃白切換
// @param peak: float = 1.5 (0..4) "峰值亮度"
// @param tint: color = #ffffff "顏色"
vec4 transition(vec2 uv) {
  vec4 c = progress < 0.5 ? getFrom(uv) : getTo(uv);
  float f = 1.0 - abs(progress - 0.5) * 2.0;
  c.rgb += tint * f * f * peak;
  return c;
}
`;

// ───────────────────────── 時間重映射（JavaScript）─────────────────────────
// function remap(t, p, info) → 回傳「素材時間（秒，相對片段起點 in）」
// t：片段內時間（秒）；p：參數；info：{ dur 片段長度, srcDur 素材總長, in 素材起點 }
// 可用 ease.inOutCubic / ease.outExpo / ease.outBack ... 與 ease.clamp

const remapSpeed = `// 變速 / 倒放
// @param speed: float = 1 (0.1..8) "速度"
// @param reverse: bool = false "倒放"
function remap(t, p, info) {
  const s = t * p.speed;
  return p.reverse ? info.dur * p.speed - s : s;
}
`;

const remapStrobe = `// 抽幀（低格數卡頓感）
// @param fps: float = 8 (1..30) "格數"
// @param speed: float = 1 (0.1..4) "速度"
function remap(t, p, info) {
  return (Math.floor(t * p.fps) / p.fps) * p.speed;
}
`;

const remapCurve = `// 曲線：素材時間用關鍵影格控制（在屬性面板的「速度」區塊編輯）
// 曲線往上 = 正播、往下 = 倒播、越陡越快、平的 = 定格
function remap(t, p, info) {
  return t;
}
`;

/** 曲線預設：套用後變成可以在屬性面板編輯的曲線（// @curve，比例：t、v 都是相對片段長度） */
const curvePreset = (name: string, k: string) => `// ${name}（套用後可以在屬性面板調整曲線）
// @curve ${k}
function remap(t, p, info) {
  return ease.curve(CURVE, t / info.dur) * info.dur;
}
const CURVE = ${k};
`;
const curve_remap_pingpong = curvePreset('正播後倒播', '[[0,0,[0.42,0,0.58,1]],[0.5,0.5,[0.42,0,0.58,1]],[1,0,[0,0,1,1]]]');
const curve_remap_reverse_forward = curvePreset('倒播後正播', '[[0,0.5,[0.42,0,0.58,1]],[0.5,0,[0.42,0,0.58,1]],[1,0.5,[0,0,1,1]]]');
const curve_remap_boomerang = curvePreset('Boomerang 倒抽', '[[0,0,[0,0,1,1]],[0.4,0.4,[0.42,0,0.58,1]],[0.55,0.15,[0,0,1,1]],[1,0.6,[0,0,1,1]]]');
const curve_remap_ramp = curvePreset('速度斜坡 Speed Ramp', '[[0,0,[0,0,0.58,1]],[0.3,0.9,[0,0,1,1]],[0.7,1.02,[0.42,0,1,1]],[1,1.92,[0,0,1,1]]]');
const curve_remap_easein = curvePreset('漸快', '[[0,0,[0.42,0,1,1]],[1,1,[0,0,1,1]]]');
const curve_remap_easeout = curvePreset('漸慢', '[[0,0,[0,0,0.58,1]],[1,1,[0,0,1,1]]]');
const curve_remap_freeze = curvePreset('中段定格', '[[0,0,[0,0,1,1]],[0.4,0.4,"hold"],[0.6,0.4,[0,0,1,1]],[1,0.8,[0,0,1,1]]]');

const mk = (id: string, kind: ModuleKind, name: string, code: string, rev?: number): Module => ({ id, kind, name, code, builtin: true, ...(rev ? { rev } : {}) });

const BASE_MODULES: Module[] = [
  mk('fx-crashzoom', 'effect', '衝擊變焦 Crash Zoom', crashZoom, 2),
  mk('fx-shake', 'effect', '相機震動 Shake', shake),
  mk('fx-flash', 'effect', '閃白 Flash', flash),
  mk('fx-rgb', 'effect', 'RGB 色差', rgbSplit),
  mk('fx-lens', 'effect', '魚眼扭曲 Lens', lens, 2),
  mk('fx-speedlines', 'effect', '速度線 Speed Lines', speedLines, 2),
  mk('fx-entrance', 'effect', '進場變換 Entrance', entrance, 2),
  mk('fx-grade', 'effect', '調色 Grade', grade),
  mk('tr-crossfade', 'transition', '溶接 Crossfade', crossfade, 2),
  mk('tr-crashzoom', 'transition', '衝擊變焦 Crash Zoom', crashZoomTr, 2),
  mk('tr-whip', 'transition', '甩鏡 Whip Pan', whipPan, 2),
  mk('tr-spin', 'transition', '旋轉 Spin', spin, 2),
  mk('tr-diagonal', 'transition', '斜切 Diagonal Wipe', diagonal, 2),
  mk('tr-iris', 'transition', '圓形擴散 Iris', iris, 2),
  mk('tr-flash', 'transition', '閃白 Flash Cut', flashCut),
  mk('remap-speed', 'remap', '變速 / 倒放', remapSpeed),
  mk('remap-curve', 'remap', '曲線', remapCurve),
  mk('remap-pingpong', 'remap', '正播後倒播', curve_remap_pingpong),
  mk('remap-reverse-forward', 'remap', '倒播後正播', curve_remap_reverse_forward),
  mk('remap-boomerang', 'remap', 'Boomerang 倒抽', curve_remap_boomerang),
  mk('remap-ramp', 'remap', '速度斜坡 Speed Ramp', curve_remap_ramp),
  mk('remap-easein', 'remap', '漸快', curve_remap_easein),
  mk('remap-easeout', 'remap', '漸慢', curve_remap_easeout),
  mk('remap-freeze', 'remap', '中段定格', curve_remap_freeze),
  mk('remap-strobe', 'remap', '抽幀 Strobe', remapStrobe),
];

const ORDER: Record<ModuleKind, number> = { effect: 0, transition: 1, remap: 2 };
/** 內建模組：依種類排序（同種類內保持原順序） */
export const BUILTIN_MODULES: Module[] = [...BASE_MODULES, ...EXTRA_MODULES]
  .map((m, i) => ({ m, i }))
  .sort((a, b) => ORDER[a.m.kind] - ORDER[b.m.kind] || a.i - b.i)
  .map((x) => x.m);

export const NEW_MODULE_TEMPLATES: Record<ModuleKind, string> = {
  effect: `// 新特效：寫 vec4 effect(vec2 uv)
// 可用：tex(uv)、u_progress(0→1)、u_local(秒)、u_time、ASPECT、easeOutExpo()、curve(曲線參數, x) ...
// 參數型別：float、int、bool、color、point（中心點，可在預覽上拖）、curve（緩動曲線）
// @duration 0.5
// @param amount: float = 0.8 (0..1) "強度"
vec4 effect(vec2 uv) {
  vec4 c = tex(uv);
  c.rgb = mix(c.rgb, 1.0 - c.rgb, amount * (1.0 - u_progress));
  return c;
}
`,
  transition: `// 新轉場：寫 vec4 transition(vec2 uv)
// 可用：getFrom(uv)、getTo(uv)、progress(0→1)、curve(曲線參數, x)
// @param slide: float = 1 (0..2) "滑動量"
// @param ease: curve = inOut3 "曲線"
vec4 transition(vec2 uv) {
  float e = curve(ease, progress);
  vec2 off = vec2(0.0, e * slide);
  return uv.y + off.y < 1.0 ? getFrom(uv + off) : getTo(uv + off - vec2(0.0, 1.0));
}
`,
  remap: `// 新時間重映射：function remap(t, p, info) 回傳素材時間（秒）
// @param speed: float = 2 (0.1..8) "速度"
function remap(t, p, info) {
  return ease.outExpo(t / info.dur) * info.dur * p.speed;
}
`,
};
