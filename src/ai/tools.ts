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

/** 工具呼叫讀了哪些模組（顯示用的名稱） */
export function toolRefs(name: string, args: Record<string, unknown>, modules: Module[]): string[] {
  if (name !== 'get_modules') return [];
  const ids = (Array.isArray(args.ids) ? args.ids : [args.ids]).map(String).slice(0, MAX_GET);
  return ids.map((id) => (modules.find((x) => x.id === id) ?? BUILTIN_MODULES.find((x) => x.id === id))?.name).filter((n): n is string => !!n);
}
