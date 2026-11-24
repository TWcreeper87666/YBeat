/**
 * AI 助手：設定（金鑰 / 模型，只存在這個瀏覽器）、聊天狀態、以及「產生 → 本機編譯 → 有錯就自動修正」的流程。
 */
import { $t } from '../i18n';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ModuleKind } from '../store';
import { ApiKeyError, BlockedError, BusyError, RateLimitError, imagePart, listModels, pickDefaultModel, streamTurn, type ModelInfo, type Turn } from './gemini';
import { moduleShots, previewShot } from './frames';
import { parseDuration } from '../engine/params';
import { chatSystem, moduleSystem, withCustom } from './prompt';
import { codeBlocks, detectKind, validateModule } from './validate';
import { TOOL_DECLS, mentionedModules, runTool, toolRefs } from './tools';
import { PROJECT_TOOL_DECLS, applyProposals, isEditTool, isProjectTool, projectSnapshot, runProjectTool, type Proposal } from './projectTools';
import { useStore } from '../store';

/** 自動修正最多幾次（免費額度有限，不要一直重試） */
export const MAX_FIXES = 2;
/** 聊天送出時最多帶幾則舊訊息 */
const HISTORY = 12;
/** 一次回覆裡最多幾輪工具呼叫 */
const MAX_TOOL_ROUNDS = 6;

// ───────────── 設定 ─────────────

interface AiSettings {
  key: string;
  model: string;
  /** 自訂指示：接在系統提示後面 */
  custom: string;
  /** 寫好模組後，把套在預覽畫面上的結果給 AI 看一次（多一個請求） */
  look: boolean;
  set(p: Partial<Pick<AiSettings, 'key' | 'model' | 'custom' | 'look'>>): void;
}
export const useAiSettings = create<AiSettings>()(
  persist((set) => ({ key: '', model: '', custom: '', look: false, set: (p) => set(p) }), { name: 'ybeat-ai', partialize: (s) => ({ key: s.key, model: s.model, custom: s.custom, look: s.look }) }),
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

export interface AiError { kind: 'key' | 'rate' | 'blocked' | 'network' | 'busy' | 'other'; message: string; retryAfter?: number | null }

export function toAiError(e: unknown): AiError {
  if (e instanceof RateLimitError) return { kind: 'rate', message: e.message, retryAfter: e.retryAfter };
  if (e instanceof ApiKeyError) return { kind: 'key', message: e.message };
  if (e instanceof BlockedError) return { kind: 'blocked', message: e.message };
  if (e instanceof BusyError) return { kind: 'busy', message: e.message };
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
  if (e.kind === 'busy') return $t('AI 伺服器忙碌，已重試 4 次，請稍後再試');
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

const LOOKS_OK = 'LOOKS_OK';
const lookPrompt = (kind: ModuleKind, at: number[]) =>
  `The app rendered your ${kind} module with its default parameters on the user's current preview frame. Image 1 = the original frame; images 2-${at.length + 1} = the module at progress ${at.join(', ')}` +
  (kind === 'transition' ? ' (outgoing clip = the preview frame, incoming clip = a test card).' : '.') +
  ` Check that it visibly does what was asked (not black, not unchanged, nothing broken or off-center). If it looks right, reply with exactly ${LOOKS_OK}. Otherwise reply with the full corrected module in one code block and one short sentence on what was wrong.`;

const fixPrompt = (err: string) =>
  `The app could not compile that module:\n\`\`\`\n${err.slice(0, 1500)}\n\`\`\`\nReply with the full corrected module in one code block.`;

/**
 * 送一輪對話；AI 可以先呼叫工具（讀模組程式碼），回覆裡有模組就在本機驗證，
 * 編譯失敗會把錯誤丟回去讓 AI 修（最多 MAX_FIXES 次）。
 * 回傳新增的對話（含工具、中間修正的回合）、最後的回覆、讀過的模組名稱。
 */
async function runWithFixes(o: {
  system: string;
  turns: Turn[];
  hint?: ModuleKind;
  signal?: AbortSignal;
  onText?: (t: string) => void;
  onFix?: (attempt: number) => void;
  onRefs?: (names: string[]) => void;
  /** 一開始就附上的模組（顯示在「參考」） */
  refs?: string[];
  /** 可以操作專案（聊天才有；程式碼分頁的 AI 修改沒有） */
  project?: boolean;
  onProposals?: (list: Proposal[]) => void;
  /** 編譯通過的模組套在預覽畫面上給 AI 看一次；onLook = 給 AI 看的圖（data URL） */
  look?: boolean;
  onLook?: (urls: string[]) => void;
}): Promise<{ added: Turn[]; text: string; check: CheckResult | null; fixes: number; refs: string[]; proposals: Proposal[] }> {
  const { key, model } = useAiSettings.getState();
  if (!key) throw new ApiKeyError('no key');
  const added: Turn[] = [];
  const refs: string[] = [...(o.refs ?? [])];
  const proposals: Proposal[] = [];
  const tools = o.project ? [...TOOL_DECLS, ...PROJECT_TOOL_DECLS] : TOOL_DECLS;
  let fixes = 0;
  let rounds = 0;
  // 看畫面：只看一次；看完 AI 說沒問題 → 回到看之前的回覆
  let looked = false;
  let seen: { text: string; check: CheckResult } | null = null;
  // 工具呼叫前已經說的話（這次回覆裡要接著顯示）
  let before = '';
  const join = (a: string, b: string) => (a && b ? `${a}\n\n${b}` : a || b);
  for (;;) {
    const r = await streamTurn({
      key, model, system: o.system, turns: [...o.turns, ...added], signal: o.signal,
      tools, toolMode: rounds < MAX_TOOL_ROUNDS ? 'AUTO' : 'NONE',
      onText: o.onText && ((t) => o.onText!(join(before, t))),
      // 伺服器忙碌、自動重試中：先在回覆的位置顯示狀態（收到回覆就會蓋掉）
      onRetry: o.onText && ((n, wait) => o.onText!(join(before, $t('AI 忙碌，{0} 秒後重試（第 {1} 次）', wait, n)))),
    });
    if (r.calls.length && rounds < MAX_TOOL_ROUNDS) {
      rounds++;
      const modules = useStore.getState().modules;
      const responses = r.calls.map((c) => (o.project && isProjectTool(c.name) ? runProjectTool(c.name, c.args, proposals) : runTool(c.name, c.args, modules)));
      added.push({ role: 'model', text: r.text, parts: r.parts });
      added.push({
        role: 'user', text: '',
        parts: r.calls.map((c, i) => ({ functionResponse: { name: c.name, ...(c.id ? { id: c.id } : {}), response: responses[i] } })),
      });
      if (proposals.length) o.onProposals?.([...proposals]);
      for (const c of r.calls) for (const n of toolRefs(c.name, c.args, modules)) if (!refs.includes(n)) refs.push(n);
      if (refs.length) o.onRefs?.([...refs]);
      before = join(before, r.text);
      // 這輪只有修改、而且全部成功：不用再問一次 AI（省一個請求），卡片自己會說明要改什麼
      if (o.project && r.calls.every((c) => isEditTool(c.name)) && responses.every((x) => !('error' in x))) {
        const text = before;
        // 給之後的對話看的紀錄：AI 沒說話就用修改摘要
        added.push({ role: 'model', text: text || `Proposed (waiting for the user to press Apply): ${proposals.map((p) => p.summary).join('; ')}` });
        return { added, text, check: null, fixes, refs, proposals };
      }
      continue;
    }
    let text = join(before, r.text);
    before = '';
    added.push({ role: 'model', text: seen ? r.text : text });
    if (seen) {
      // 看完畫面的回覆：沒有新的程式碼 = 原本的就好（不是 OK 的話把意見接在後面）
      const prev = seen;
      seen = null;
      text = r.text;
      if (!checkReply(text, o.hint)) {
        const note = text.trim().startsWith(LOOKS_OK) ? '' : text.trim();
        return { added, text: join(prev.text, note), check: prev.check, fixes, refs, proposals };
      }
    }
    const check = checkReply(text, o.hint);
    if (check && !check.error && o.look && !looked && check.kind !== 'remap') {
      looked = true;
      const s = moduleShots(check.kind, check.code, check.kind === 'effect' ? parseDuration(check.code, 0.5) : 0.8);
      if (s) {
        seen = { text, check };
        before = text;
        o.onLook?.(s.shots.map((x) => x.url));
        const prompt = lookPrompt(check.kind, s.at);
        added.push({ role: 'user', text: `${prompt} [images omitted]`, img: true, parts: [{ text: prompt }, ...s.shots.map(imagePart)] });
        continue;
      }
    }
    if (!check?.error || fixes >= MAX_FIXES) return { added, text, check, fixes, refs, proposals };
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
  /** AI 讀過的模組（名稱） */
  refs?: string[];
  /** AI 提議的專案修改（按「套用」才執行） */
  proposals?: Proposal[];
  /** 使用者附加的預覽畫面（data URL） */
  image?: string;
  /** 給 AI 看過的模組畫面（data URL；第一張是原始畫面） */
  seen?: string[];
  /** 已套用：實際套用 / 跳過幾項 */
  applied?: { done: number; skipped: number };
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

/** 問題裡提到的模組（排除正在改的那個） */
const namedModules = (text: string, exclude?: string) => mentionedModules(text, useStore.getState().modules).filter((m) => m.code !== exclude);
/** 把提到的模組程式碼先附上，AI 不用再花一個請求讀 */
function refBlock(text: string, exclude?: string): string {
  const list = namedModules(text, exclude);
  if (!list.length) return '';
  const code = list.map((m) => `Module ${m.id} (${m.kind}, "${m.name}"):\n\`\`\`${LANG_OF[m.kind]}\n${m.code.trim().slice(0, 6000)}\n\`\`\``).join('\n\n');
  return `\n\n<referenced_modules>\n${code}\n</referenced_modules>`;
}

function patch(id: string, p: Partial<ChatMsg>) {
  useAiChat.setState({ msgs: useAiChat.getState().msgs.map((m) => (m.id === id ? { ...m, ...p } : m)) });
}

export function sendChat(text: string, attach?: Attach, withFrame = false) {
  const S = useAiChat.getState();
  if (S.busy || !text.trim()) return;
  const apiText = attach
    ? `${text}\n\nCurrent ${attach.kind} module "${attach.name}":\n\`\`\`${LANG_OF[attach.kind]}\n${attach.code}\n\`\`\``
    : text;
  const frame = withFrame ? previewShot() : null;
  const user: ChatMsg = { id: uid(), role: 'user', text, attach, turns: [{ role: 'user', text: apiText }], ...(frame ? { image: frame.url } : {}) };
  // 專案快照、提到的模組只跟著這一次的問題送（紀錄裡不留，免得越疊越多）
  const named = namedModules(text, attach?.code);
  const snapText = `${apiText}${refBlock(text, attach?.code)}\n\n<project_snapshot>\n${projectSnapshot()}\n</project_snapshot>`;
  const withSnap: Turn = frame
    ? { role: 'user', text: snapText, img: true, parts: [{ text: snapText }, { text: `Attached: the current preview frame at the playhead (${useStore.getState().time.toFixed(2)}s).` }, imagePart(frame)] }
    : { role: 'user', text: snapText };
  const reply: ChatMsg = { id: uid(), role: 'model', text: '', turns: [], streaming: true, ...(named.length ? { refs: named.map((m) => m.name) } : {}) };
  const abort = new AbortController();
  // 舊訊息只帶最近幾則；失敗的回覆、工具回合（讀到的程式碼很長）不帶；附圖的回合只留文字
  const history = S.msgs.filter((m) => !m.error).flatMap((m) => m.turns).filter((t) => !t.parts || t.img).map((t): Turn => (t.img ? { role: t.role, text: t.text } : t)).slice(-HISTORY);
  useAiChat.setState({ msgs: [...S.msgs, user, reply], busy: true, abort });
  void (async () => {
    try {
      const r = await runWithFixes({
        system: withCustom(chatSystem(), useAiSettings.getState().custom),
        turns: [...history, withSnap],
        hint: attach?.kind,
        signal: abort.signal,
        onText: (t) => patch(reply.id, { text: t }),
        onFix: (n) => patch(reply.id, { fixing: n }),
        onRefs: (refs) => patch(reply.id, { refs }),
        refs: reply.refs,
        project: true,
        onProposals: (proposals) => patch(reply.id, { proposals }),
        look: useAiSettings.getState().look,
        onLook: (seen) => patch(reply.id, { seen }),
      });
      patch(reply.id, { text: r.text, turns: r.added, streaming: false, fixing: undefined, fixes: r.fixes, check: r.check, refs: r.refs, proposals: r.proposals });
    } catch (e) {
      if (abort.signal.aborted) patch(reply.id, { streaming: false, fixing: undefined, turns: [] });
      else patch(reply.id, { streaming: false, fixing: undefined, turns: [], error: toAiError(e) });
    } finally {
      useAiChat.setState({ busy: false, abort: null });
    }
  })();
}

/** 套用某則回覆提議的修改（一步復原） */
export function applyChatProposals(msgId: string): { done: number; skipped: number } | null {
  const m = useAiChat.getState().msgs.find((x) => x.id === msgId);
  if (!m?.proposals?.length || m.applied) return null;
  const r = applyProposals(m.proposals);
  patch(msgId, { applied: r });
  return r;
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
  onLook?: (urls: string[]) => void;
}): Promise<{ code: string | null; note: string; error: string | null; fixes: number }> {
  const turns: Turn[] = [
    { role: 'user', text: `Current ${o.kind} module "${o.name}":\n\`\`\`${LANG_OF[o.kind]}\n${o.code}\n\`\`\`\n\nChange request: ${o.request}${refBlock(o.request, o.code)}` },
  ];
  const r = await runWithFixes({ system: withCustom(moduleSystem(), useAiSettings.getState().custom), turns, hint: o.kind, signal: o.signal, onText: o.onText, onFix: o.onFix, look: useAiSettings.getState().look, onLook: o.onLook });
  // 說明文字 = 程式碼區塊以外的部分
  const blocks = codeBlocks(r.text);
  const note = blocks.length ? (r.text.slice(0, blocks[0].start) + r.text.slice(blocks[0].end)).trim() : r.text.trim();
  if (!r.check) return { code: null, note, error: null, fixes: r.fixes };
  if (r.check.kind !== o.kind) return { code: null, note, error: `expected a ${o.kind} module, got ${r.check.kind}`, fixes: r.fixes };
  return { code: r.check.code, note, error: r.check.error, fixes: r.fixes };
}
