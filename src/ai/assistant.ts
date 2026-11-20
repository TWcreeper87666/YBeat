/**
 * AI 助手：設定（金鑰 / 模型，只存在這個瀏覽器）、聊天狀態、以及「產生 → 本機編譯 → 有錯就自動修正」的流程。
 */
import { $t } from '../i18n';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ModuleKind } from '../store';
import { ApiKeyError, BlockedError, RateLimitError, listModels, pickDefaultModel, streamChat, type ModelInfo, type Turn } from './gemini';
import { chatSystem, moduleSystem } from './prompt';
import { codeBlocks, detectKind, validateModule } from './validate';

/** 自動修正最多幾次（免費額度有限，不要一直重試） */
export const MAX_FIXES = 2;
/** 聊天送出時最多帶幾則舊訊息 */
const HISTORY = 12;

// ───────────── 設定 ─────────────

interface AiSettings {
  key: string;
  model: string;
  set(p: Partial<Pick<AiSettings, 'key' | 'model'>>): void;
}
export const useAiSettings = create<AiSettings>()(
  persist((set) => ({ key: '', model: '', set: (p) => set(p) }), { name: 'ybeat-ai', partialize: (s) => ({ key: s.key, model: s.model }) }),
);

export const useAiModels = create<{ list: ModelInfo[]; loading: boolean; error: string }>(() => ({ list: [], loading: false, error: '' }));

/** 讀這把金鑰能用的模型；沒選過模型就挑預設的。回傳錯誤訊息（成功 = ''） */
export async function refreshModels(key = useAiSettings.getState().key): Promise<string> {
  if (!key) return '';
  useAiModels.setState({ loading: true, error: '' });
  try {
    const list = await listModels(key);
    useAiModels.setState({ list, loading: false });
    const cur = useAiSettings.getState().model;
    if (!cur || !list.some((m) => m.id === cur)) useAiSettings.getState().set({ model: pickDefaultModel(list) });
    return '';
  } catch (e) {
    const msg = errorText(e);
    useAiModels.setState({ loading: false, error: msg });
    return msg;
  }
}

// ───────────── 錯誤 ─────────────

export interface AiError { kind: 'key' | 'rate' | 'blocked' | 'network' | 'other'; message: string; retryAfter?: number | null }

export function toAiError(e: unknown): AiError {
  if (e instanceof RateLimitError) return { kind: 'rate', message: e.message, retryAfter: e.retryAfter };
  if (e instanceof ApiKeyError) return { kind: 'key', message: e.message };
  if (e instanceof BlockedError) return { kind: 'blocked', message: e.message };
  if (e instanceof TypeError) return { kind: 'network', message: e.message };
  return { kind: 'other', message: String((e as Error)?.message ?? e) };
}
const errorText = (e: unknown) => toAiError(e).message;

/** 錯誤的簡短說明（完整訊息放 title） */
export function aiErrorText(e: AiError): string {
  if (e.kind === 'key') return $t('API 金鑰無效');
  if (e.kind === 'rate') return e.retryAfter ? $t('請求太頻繁，{0} 秒後再試', e.retryAfter) : $t('已達額度上限');
  if (e.kind === 'blocked') return $t('回覆被安全機制擋下');
  if (e.kind === 'network') return $t('無法連線');
  return e.message.slice(0, 120);
}


// ───────────── 產生 → 驗證 → 修正 ─────────────

export interface CheckResult { kind: ModuleKind; code: string; error: string | null }

/** 回覆裡第一個像模組的程式碼區塊，順便驗證 */
export function checkReply(text: string, hint?: ModuleKind): CheckResult | null {
  for (const b of codeBlocks(text)) {
    const kind = detectKind(b.code) ?? (hint && (b.lang === 'glsl' || b.lang === 'js' || b.lang === 'javascript') ? hint : null);
    if (kind) return { kind, code: b.code, error: validateModule(kind, b.code) };
  }
  return null;
}

const fixPrompt = (err: string) =>
  `The app could not compile that module:\n\`\`\`\n${err.slice(0, 1500)}\n\`\`\`\nReply with the full corrected module in one code block.`;

/**
 * 送一輪對話；回覆裡有模組就在本機驗證，編譯失敗會把錯誤丟回去讓 AI 修（最多 MAX_FIXES 次）。
 * 回傳新增的對話（含中間修正的回合）與最後的回覆。
 */
async function runWithFixes(o: {
  system: string;
  turns: Turn[];
  hint?: ModuleKind;
  signal?: AbortSignal;
  onText?: (t: string) => void;
  onFix?: (attempt: number) => void;
}): Promise<{ added: Turn[]; text: string; check: CheckResult | null; fixes: number }> {
  const { key, model } = useAiSettings.getState();
  if (!key) throw new ApiKeyError('no key');
  const added: Turn[] = [];
  let fixes = 0;
  for (;;) {
    const text = await streamChat({ key, model, system: o.system, turns: [...o.turns, ...added], signal: o.signal, onText: o.onText });
    added.push({ role: 'model', text });
    const check = checkReply(text, o.hint);
    if (!check?.error || fixes >= MAX_FIXES) return { added, text, check, fixes };
    fixes++;
    o.onFix?.(fixes);
    added.push({ role: 'user', text: fixPrompt(check.error) });
  }
}

// ───────────── 聊天 ─────────────

/** 附加在問題裡的模組（id = 程式碼分頁的分頁 id，可以把回覆套用回去） */
export interface Attach { id?: string; name: string; kind: ModuleKind; code: string }
export interface ChatMsg {
  id: string;
  role: 'user' | 'model';
  text: string;
  attach?: Attach;
  /** 送給 API 的實際內容（含附加的程式碼、中間修正的回合） */
  turns: Turn[];
  streaming?: boolean;
  fixing?: number;
  fixes?: number;
  check?: CheckResult | null;
  error?: AiError;
}

interface ChatState {
  msgs: ChatMsg[];
  busy: boolean;
  abort: AbortController | null;
}
export const useAiChat = create<ChatState>(() => ({ msgs: [], busy: false, abort: null }));

const uid = () => Math.random().toString(36).slice(2, 10);
const LANG_OF: Record<ModuleKind, string> = { effect: 'glsl', transition: 'glsl', remap: 'js' };

function patch(id: string, p: Partial<ChatMsg>) {
  useAiChat.setState({ msgs: useAiChat.getState().msgs.map((m) => (m.id === id ? { ...m, ...p } : m)) });
}

export function sendChat(text: string, attach?: Attach) {
  const S = useAiChat.getState();
  if (S.busy || !text.trim()) return;
  const apiText = attach
    ? `${text}\n\nCurrent ${attach.kind} module "${attach.name}":\n\`\`\`${LANG_OF[attach.kind]}\n${attach.code}\n\`\`\``
    : text;
  const user: ChatMsg = { id: uid(), role: 'user', text, attach, turns: [{ role: 'user', text: apiText }] };
  const reply: ChatMsg = { id: uid(), role: 'model', text: '', turns: [], streaming: true };
  const abort = new AbortController();
  // 舊訊息只帶最近幾則；失敗的回覆不帶
  const history = S.msgs.filter((m) => !m.error).flatMap((m) => m.turns).slice(-HISTORY);
  useAiChat.setState({ msgs: [...S.msgs, user, reply], busy: true, abort });
  void (async () => {
    try {
      const r = await runWithFixes({
        system: chatSystem(),
        turns: [...history, ...user.turns],
        hint: attach?.kind,
        signal: abort.signal,
        onText: (t) => patch(reply.id, { text: t }),
        onFix: (n) => patch(reply.id, { fixing: n }),
      });
      patch(reply.id, { text: r.text, turns: r.added, streaming: false, fixing: undefined, fixes: r.fixes, check: r.check });
    } catch (e) {
      if (abort.signal.aborted) patch(reply.id, { streaming: false, fixing: undefined, turns: [] });
      else patch(reply.id, { streaming: false, fixing: undefined, turns: [], error: toAiError(e) });
    } finally {
      useAiChat.setState({ busy: false, abort: null });
    }
  })();
}

export function stopChat() {
  useAiChat.getState().abort?.abort();
}
export function clearChat() {
  stopChat();
  useAiChat.setState({ msgs: [] });
}

// ───────────── 程式碼分頁：讓 AI 修改目前的模組 ─────────────

export async function editModule(o: {
  kind: ModuleKind;
  name: string;
  code: string;
  request: string;
  signal?: AbortSignal;
  onText?: (t: string) => void;
  onFix?: (n: number) => void;
}): Promise<{ code: string | null; note: string; error: string | null; fixes: number }> {
  const turns: Turn[] = [
    { role: 'user', text: `Current ${o.kind} module "${o.name}":\n\`\`\`${LANG_OF[o.kind]}\n${o.code}\n\`\`\`\n\nChange request: ${o.request}` },
  ];
  const r = await runWithFixes({ system: moduleSystem(), turns, hint: o.kind, signal: o.signal, onText: o.onText, onFix: o.onFix });
  // 說明文字 = 程式碼區塊以外的部分
  const blocks = codeBlocks(r.text);
  const note = blocks.length ? (r.text.slice(0, blocks[0].start) + r.text.slice(blocks[0].end)).trim() : r.text.trim();
  if (!r.check) return { code: null, note, error: null, fixes: r.fixes };
  if (r.check.kind !== o.kind) return { code: null, note, error: `expected a ${o.kind} module, got ${r.check.kind}`, fixes: r.fixes };
  return { code: r.check.code, note, error: r.check.error, fixes: r.fixes };
}
