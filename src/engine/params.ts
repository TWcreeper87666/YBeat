// 從程式碼註解解析可調參數，自動產生 UI。
// 語法：// @param 名稱: 型別 = 預設值 (最小..最大) "顯示名稱"
// 型別：float | int | bool | color
// 例：  // @param speed: float = 1 (0.1..8) "速度"

export type ParamType = 'float' | 'int' | 'bool' | 'color';
export type ParamValue = number | boolean | string;
export type ParamValues = Record<string, ParamValue>;

export interface ParamDef {
  name: string;
  type: ParamType;
  def: ParamValue;
  min: number;
  max: number;
  label: string;
}

const RE =
  /\/\/\s*@param\s+(\w+)\s*:\s*(float|int|bool|color)\s*=\s*(\S+?)(?:\s*\(\s*(-?[\d.]+)\s*\.\.\s*(-?[\d.]+)\s*\))?(?:\s*"([^"]*)")?[ \t\r]*$/gm;

const cache = new Map<string, ParamDef[]>();

export function parseParams(code: string): ParamDef[] {
  const hit = cache.get(code);
  if (hit) return hit;
  const out: ParamDef[] = [];
  RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE.exec(code))) {
    const [, name, type, raw, mn, mx, label] = m;
    let def: ParamValue;
    if (type === 'bool') def = raw === 'true' || raw === '1';
    else if (type === 'color') def = /^#[0-9a-fA-F]{6}$/.test(raw) ? raw.toLowerCase() : '#ffffff';
    else def = parseFloat(raw) || 0;
    const num = typeof def === 'number' ? def : 0;
    out.push({
      name,
      type: type as ParamType,
      def,
      min: mn !== undefined ? parseFloat(mn) : Math.min(0, num),
      max: mx !== undefined ? parseFloat(mx) : Math.max(1, num * 2),
      label: label || name,
    });
  }
  if (cache.size > 300) cache.clear();
  cache.set(code, out);
  return out;
}

export function resolveParams(defs: ParamDef[], values: ParamValues | undefined): ParamValues {
  const o: ParamValues = {};
  for (const d of defs) {
    const v = values?.[d.name];
    o[d.name] = v === undefined || typeof v !== typeof d.def ? d.def : v;
  }
  return o;
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
