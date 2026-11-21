// 從程式碼註解解析可調參數，自動產生 UI。
// 語法：// @param 名稱: 型別 = 預設值 (最小..最大) "顯示名稱" @box(點)
// 型別：float | int | bool | color | point | curve
// 例：  // @param speed: float = 1 (0.1..8) "速度"
//       // @param center: point = 0.5,0.5 "中心"        → uniform vec2（uv 座標）
//       // @param ease: curve = inOut "曲線"             → uniform vec4（cubic-bezier），用 curve(ease, x) 取值
//       // @param to: float = 0.2 (0..1) "大小" @box(center) → 預覽畫面上以 center 為中心畫出縮放後的畫面框

import { EASE_PRESETS, evalKeys, type Bez, type Keyframe } from './keyframes';

export type ParamType = 'float' | 'int' | 'bool' | 'color' | 'point' | 'curve';
/** point：[x, y]（畫面座標，0..1，y 向下）；curve：[x1, y1, x2, y2] */
export type ParamValue = number | boolean | string | number[];
export type ParamValues = Record<string, ParamValue>;

export interface ParamDef {
  name: string;
  type: ParamType;
  def: ParamValue;
  min: number;
  max: number;
  label: string;
  /** float 參數：預覽畫面上，以這個 point 參數為中心、以這個值為縮放倍率畫出畫面框 */
  box?: string;
  /** curve 參數：「無」選項的固定值（`@none(1)`，例如不淡入 = 一直是 1） */
  none?: number;
}

const RE =
  /\/\/\s*@param\s+(\w+)\s*:\s*(float|int|bool|color|point|curve)\s*=\s*(\S+?)(?:\s*\(\s*(-?[\d.]+)\s*\.\.\s*(-?[\d.]+)\s*\))?(?:\s*"([^"]*)")?(?:\s*@box\(\s*(\w+)\s*\))?(?:\s*@none\(\s*(-?[\d.]+)\s*\))?[ \t\r]*$/gm;

const cache = new Map<string, ParamDef[]>();

const nums = (raw: string) => raw.split(',').map((s) => parseFloat(s));
export const LINEAR: Bez = [0, 0, 1, 1];

function parseCurve(raw: string): Bez {
  const p = EASE_PRESETS.find((x) => x.id === raw);
  if (p && p.ease !== 'hold') return [...p.ease] as Bez;
  const n = nums(raw);
  return n.length === 4 && n.every(Number.isFinite) ? (n as Bez) : [...LINEAR] as Bez;
}

export function parseParams(code: string): ParamDef[] {
  const hit = cache.get(code);
  if (hit) return hit;
  const out: ParamDef[] = [];
  RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE.exec(code))) {
    const [, name, type, raw, mn, mx, label, box, none] = m;
    let def: ParamValue;
    if (type === 'bool') def = raw === 'true' || raw === '1';
    else if (type === 'color') def = /^#[0-9a-fA-F]{6}$/.test(raw) ? raw.toLowerCase() : '#ffffff';
    else if (type === 'point') {
      const n = nums(raw);
      def = n.length === 2 && n.every(Number.isFinite) ? n : [0.5, 0.5];
    } else if (type === 'curve') def = parseCurve(raw);
    else def = parseFloat(raw) || 0;
    const num = typeof def === 'number' ? def : 0;
    out.push({
      name,
      type: type as ParamType,
      def,
      min: mn !== undefined ? parseFloat(mn) : type === 'point' ? 0 : Math.min(0, num),
      max: mx !== undefined ? parseFloat(mx) : type === 'point' ? 1 : Math.max(1, num * 2),
      label: label || name,
      ...(box && type === 'float' ? { box } : {}),
      ...(none !== undefined && type === 'curve' ? { none: parseFloat(none) } : {}),
    });
  }
  if (cache.size > 300) cache.clear();
  cache.set(code, out);
  return out;
}

const arrLen = (t: ParamType) => (t === 'point' ? 2 : t === 'curve' ? 4 : 0);

/** 值的型別要跟宣告一致，不一致就用預設值 */
function valid(d: ParamDef, v: ParamValue | undefined): v is ParamValue {
  if (v === undefined) return false;
  const n = arrLen(d.type);
  if (n) return Array.isArray(v) && v.length === n && v.every((x) => typeof x === 'number' && Number.isFinite(x));
  return !Array.isArray(v) && typeof v === typeof d.def;
}

export function resolveParams(defs: ParamDef[], values: ParamValues | undefined): ParamValues {
  const o: ParamValues = {};
  for (const d of defs) {
    const v = values?.[d.name];
    o[d.name] = valid(d, v) ? v : d.def;
  }
  return o;
}

/** point 參數的兩個關鍵影格 channel */
export const pointCh = (name: string, axis: 0 | 1) => `${name}.${axis ? 'y' : 'x'}`;
/** channel id → point 參數名稱與軸（不是 point channel 就回傳 null） */
export function parsePointCh(ch: string): { name: string; axis: 0 | 1 } | null {
  const m = /^(\w+)\.([xy])$/.exec(ch);
  return m && m[1] !== 'mask' ? { name: m[1], axis: m[2] === 'y' ? 1 : 0 } : null;
}

/** 數值型（可以打關鍵影格、跟著音訊變化） */
export const isNumeric = (d: ParamDef) => d.type === 'float' || d.type === 'int';

/** 參數在某個時間的值（關鍵影格優先；point 的兩軸各自的 key） */
export function paramAt(d: ParamDef, values: ParamValues, keys: Record<string, Keyframe[]> | undefined, local: number): ParamValue {
  const v = values[d.name] ?? d.def;
  if (isNumeric(d)) {
    const k = keys?.[d.name];
    return k?.length ? evalKeys(k, local) : v;
  }
  if (d.type === 'point') {
    const p = (Array.isArray(v) ? v : d.def) as number[];
    return [0, 1].map((a) => {
      const k = keys?.[pointCh(d.name, a as 0 | 1)];
      return k?.length ? evalKeys(k, local) : p[a];
    });
  }
  return v;
}

export function hexToRgb(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** 讀取 // @duration 0.4 註解作為預設長度 */
export function parseDuration(code: string, fallback: number): number {
  const m = /\/\/\s*@duration\s+([\d.]+)/.exec(code);
  return m ? parseFloat(m[1]) || fallback : fallback;
}

/**
 * 衝擊特效（// @hit）：打一下就結束，畫面隨 u_progress 衰減 / 播完（衝擊變焦、閃白…），拉長會失去衝擊感。
 * 沒標的是持續特效：畫面不看進度，放多長都一樣（描邊、調色、手持晃動…）。
 */
export function isHitFx(m: { kind: string; code: string }): boolean {
  return m.kind === 'effect' && /\/\/\s*@hit\b/.test(m.code);
}
