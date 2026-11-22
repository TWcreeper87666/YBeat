/**
 * AI 可以呼叫的工具（Gemini function calling）：查內建 / 自訂模組的程式碼。
 * 純函式：模組清單由呼叫端傳入，方便測試。
 */
import type { Module } from '../modules/builtin';
import { BUILTIN_MODULES } from '../modules/builtin';
import { categoryOf } from '../modules/categories';
import type { ToolDecl } from './gemini';

/** 一次最多讀幾個模組（避免一次塞太多程式碼） */
const MAX_GET = 6;

export const TOOL_DECLS: ToolDecl[] = [
  {
    name: 'get_modules',
    description: 'Read the full source code of modules by id (built-in or the user\'s own). Use it before imitating, combining or explaining an existing module.',
    parameters: {
      type: 'object',
      properties: { ids: { type: 'array', items: { type: 'string' }, description: `Module ids, at most ${MAX_GET}` } },
      required: ['ids'],
    },
  },
  {
    name: 'list_user_modules',
    description: 'List the modules the user created or edited in this project (id, kind, name). Built-ins are already listed in the system prompt.',
    parameters: { type: 'object', properties: {} },
  },
];

/** 系統提示裡的內建模組目錄：一行一個 */
export function builtinCatalog(): string {
  return BUILTIN_MODULES.map((m) => `${m.id} | ${m.kind} | ${categoryOf(m)} | ${m.name}`).join('\n');
}

const BUILTIN_CODE = new Map(BUILTIN_MODULES.map((m) => [m.id, m.code]));
/** 使用者自己做的，或改過程式碼的內建模組 */
const isUserModule = (m: Module) => !m.builtin || BUILTIN_CODE.get(m.id) !== m.code;

export function runTool(name: string, args: Record<string, unknown>, modules: Module[]): Record<string, unknown> {
  if (name === 'get_modules') {
    const ids = (Array.isArray(args.ids) ? args.ids : [args.ids]).map(String).filter(Boolean);
    const found: { id: string; kind: string; name: string; code: string }[] = [];
    const missing: string[] = [];
    for (const id of ids.slice(0, MAX_GET)) {
      const m = modules.find((x) => x.id === id) ?? BUILTIN_MODULES.find((x) => x.id === id);
      if (m) found.push({ id: m.id, kind: m.kind, name: m.name, code: m.code });
      else missing.push(id);
    }
    return { modules: found, ...(missing.length ? { missing } : {}), ...(ids.length > MAX_GET ? { note: `only the first ${MAX_GET} ids were read` } : {}) };
  }
  if (name === 'list_user_modules') {
    return { modules: modules.filter(isUserModule).map((m) => ({ id: m.id, kind: m.kind, name: m.name, edited_builtin: !!m.builtin })) };
  }
  return { error: `unknown tool: ${name}` };
}

/** 模組名稱裡可以拿來比對的詞：連續的中日文（≥2 字）、英文片語（≥3 個字母） */
function nameTerms(name: string): string[] {
  const out: string[] = [];
  for (const m of name.matchAll(/[぀-ヿ㐀-鿿]{2,}|[A-Za-z][A-Za-z0-9 '-]*[A-Za-z0-9]/g)) {
    const t = m[0].trim();
    if (/[぀-鿿]/.test(t) || t.replace(/[^A-Za-z]/g, '').length >= 3) out.push(t.toLowerCase());
  }
  return out;
}

/**
 * 使用者在問題裡提到的模組（名稱或 id 完全出現在文字裡），先把程式碼附上，AI 就不用再花一個請求去讀。
 * 長的名稱先比（「Shake Blur」優先於「Shake」），最多 max 個。
 */
export function mentionedModules(text: string, modules: Module[], max = 2): Module[] {
  const low = text.toLowerCase();
  const hits: { m: Module; len: number; at: number }[] = [];
  for (const m of modules) {
    let best: { len: number; at: number } | null = null;
    for (const t of [m.id.toLowerCase(), ...nameTerms(m.name)]) {
      const at = low.indexOf(t);
      if (at >= 0 && (!best || t.length > best.len)) best = { len: t.length, at };
    }
    if (best) hits.push({ m, ...best });
  }
  // 被更長的名稱涵蓋的就不算（「Shake」落在已經比到的「Shake Blur」裡）
  hits.sort((a, b) => b.len - a.len);
  const taken: [number, number][] = [];
  const out: Module[] = [];
  for (const h of hits) {
    if (taken.some(([a, b]) => h.at >= a && h.at + h.len <= b)) continue;
    taken.push([h.at, h.at + h.len]);
    out.push(h.m);
    if (out.length >= max) break;
  }
  return out;
}

/** 工具呼叫讀了哪些模組（顯示用的名稱） */
export function toolRefs(name: string, args: Record<string, unknown>, modules: Module[]): string[] {
  if (name !== 'get_modules') return [];
  const ids = (Array.isArray(args.ids) ? args.ids : [args.ids]).map(String).slice(0, MAX_GET);
  return ids.map((id) => (modules.find((x) => x.id === id) ?? BUILTIN_MODULES.find((x) => x.id === id))?.name).filter((n): n is string => !!n);
}
