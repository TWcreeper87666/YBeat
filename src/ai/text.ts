/** 從 AI 回覆裡找程式碼、判斷模組種類（純函式，方便測試） */
import type { ModuleKind } from '../store';

export interface CodeBlock { lang: string; code: string; start: number; end: number }

/** 回覆裡的 ``` 程式碼區塊（還沒收完的最後一塊也算，串流中可以先顯示） */
export function codeBlocks(text: string): CodeBlock[] {
  const out: CodeBlock[] = [];
  const re = /```([\w+-]*)[^\n]*\n([\s\S]*?)(?:```|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    out.push({ lang: m[1].toLowerCase(), code: m[2].replace(/\n$/, ''), start: m.index, end: m.index + m[0].length });
    if (m[0].length === 0) re.lastIndex++;
  }
  return out;
}

/** 看程式碼長相判斷是哪種模組（不是模組 = null） */
export function detectKind(code: string): ModuleKind | null {
  if (/\bfunction\s+remap\s*\(/.test(code)) return 'remap';
  if (/\bvec4\s+transition\s*\(\s*vec2/.test(code)) return 'transition';
  if (/\bvec4\s+effect\s*\(\s*vec2/.test(code)) return 'effect';
  return null;
}

/** 模組名稱：程式碼第一行註解（「// 名稱：說明」取冒號前面） */
export function guessName(code: string): string | null {
  const m = /^\s*\/\/[ \t]*([^@\s][^\n]*)/.exec(code);
  if (!m) return null;
  const n = m[1].split(/[:：]/)[0].trim();
  return n && n.length <= 24 ? n : null;
}

