/**
 * AI 助手：設定（金鑰 / 模型，只存在這個瀏覽器）、聊天狀態、以及「產生 → 本機編譯 → 有錯就自動修正」的流程。
 */
import { $t } from '../i18n';
import { toast } from '../ui/uiStore';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ModuleKind } from '../store';
import { countdown, ApiKeyError, BlockedError, BusyError, RateLimitError, imagePart, listModels, pickDefaultModel, streamTurn, type ModelInfo, type Turn } from './gemini';
import { modulePixels, moduleShots, previewShot } from './frames';
import { renderProblem, renderPrompt } from './pixelCheck';
import { parseDuration } from '../engine/params';
import { chatSystem, moduleSystem, withCustom } from './prompt';
import { codeBlocks, detectKind, validateModule } from './validate';
import { TOOL_DECLS, mentionedModules, runTool, toolRefs } from './tools';
import { PROJECT_TOOL_DECLS, applyProposals, isEditTool, isProjectTool, projectSnapshot, runProjectTool, type Proposal } from './projectTools';
import { useStore } from '../store';
import { historyPath, mergeIntoStep, undo } from '../engine/history';

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
  /** AI 提議的修改回覆完就直接套用 */
  auto: boolean;
  set(p: Partial<Pick<AiSettings, 'key' | 'model' | 'custom' | 'look' | 'auto'>>): void;
}
export const useAiSettings = create<AiSettings>()(
  persist((set) => ({ key: '', model: '', custom: '', look: false, auto: false, set: (p) => set(p) }), { name: 'ybeat-ai', partialize: (s) => ({ key: s.key, model: s.model, custom: s.custom, look: s.look, auto: s.auto }) }),
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

/** 檢查畫面時用的長度：特效照 @duration，轉場 0.8 秒 */
const moduleDuration = (c: CheckResult) => (c.kind === 'effect' ? parseDuration(c.code, 0.5) : 0.8);

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
  /** 限流最多等幾秒自動重試（AI 自己接著說明時可以等久一點） */
  maxRateWait?: number;
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
  // 等待重試的倒數
  let stopTick = () => {};
  for (;;) {
    const r = await streamTurn({
      key, model, system: o.system, turns: [...o.turns, ...added], signal: o.signal, maxRateWait: o.maxRateWait,
      tools, toolMode: rounds < MAX_TOOL_ROUNDS ? 'AUTO' : 'NONE',
      onText: o.onText && ((t) => { stopTick(); o.onText!(join(before, t)); }),
      // 伺服器忙碌 / 限流、自動重試中：先在回覆的位置倒數（收到回覆就會蓋掉）
      onRetry: o.onText && ((n, wait) => {
        stopTick();
        stopTick = countdown(wait, (left) => o.onText!(join(before, $t('AI 忙碌，{0} 秒後重試（第 {1} 次）', left, n))));
      }),
    }).finally(() => stopTick());
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
    // 編譯過了：先讀回像素檢查（整片黑 / 全透明 / 沒變化），有問題就丟回去修（不用看圖）
    if (check && !check.error && check.kind !== 'remap' && fixes < MAX_FIXES) {
      let px: ReturnType<typeof modulePixels> = null;
      try { px = modulePixels(check.kind, check.code, moduleDuration(check)); } catch { /* 沒有 WebGL2：跳過 */ }
      const problem = px && renderProblem(check.kind, px.base, px.frames, px.other);
      if (px && problem) {
        fixes++;
        o.onFix?.(fixes);
        seen = { text, check };
        before = text;
        added.push({ role: 'user', text: renderPrompt(check.kind, problem, px.at, LOOKS_OK) });
        continue;
      }
    }
    if (check && !check.error && o.look && !looked && check.kind !== 'remap') {
      looked = true;
      const s = moduleShots(check.kind, check.code, moduleDuration(check));
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
  /** 自動剪輯的步驟（套用後產生時即時更新；running = 還在跑） */
  steps?: { lines: string[]; running: boolean; label?: string };
  /** 使用者訊息送出時的復原紀錄位置（「從這裡重來並復原修改」退回這裡） */
  path?: number[];
  /** 已套用：實際套用 / 跳過幾項；step = 產生的復原步驟（復原掉就算沒套用） */
  applied?: { done: number; skipped: number; step?: number };
  error?: AiError;
}

interface ChatState {
  msgs: ChatMsg[];
  busy: boolean;
  abort: AbortController | null;
  /** 要放回輸入框的文字（n 變了才放；從這裡重來時用） */
  draft: { text: string; n: number } | null;
}
export const useAiChat = create<ChatState>(() => ({ msgs: [], busy: false, abort: null, draft: null }));

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
  const user: ChatMsg = { id: uid(), role: 'user', text, attach, turns: [{ role: 'user', text: apiText }], path: historyPath(), ...(frame ? { image: frame.url } : {}) };
  // 專案快照、提到的模組只跟著這一次的問題送（紀錄裡不留，免得越疊越多）
  const named = namedModules(text, attach?.code);
  const snapText = `${apiText}${refBlock(text, attach?.code)}\n\n<project_snapshot>\n${projectSnapshot()}\n</project_snapshot>`;
  const withSnap: Turn = frame
    ? { role: 'user', text: snapText, img: true, parts: [{ text: snapText }, { text: `Attached: the current preview frame at the playhead (${useStore.getState().time.toFixed(2)}s).` }, imagePart(frame)] }
    : { role: 'user', text: snapText };
  const history = chatHistory(S.msgs);
  useAiChat.setState({ msgs: [...S.msgs, user] });
  runReply(null, withSnap, history, attach?.kind, named.length ? named.map((m) => m.name) : undefined);
}

/** 舊訊息只帶最近幾則；失敗的回覆、工具回合（讀到的程式碼很長）不帶；附圖的回合只留文字 */
const chatHistory = (msgs: ChatMsg[]): Turn[] =>
  msgs.filter((m) => !m.error).flatMap((m) => m.turns).filter((t) => !t.parts || t.img).map((t): Turn => (t.img ? { role: t.role, text: t.text } : t)).slice(-HISTORY);

/**
 * 送出一次 AI 回覆。keep = 不顯示、但要留在紀錄裡的使用者回合（AI 自己接著說明時用）；api = 這次實際送的回合。
 */
function runReply(keep: Turn | null, api: Turn, history: Turn[], hint?: ModuleKind, refs?: string[], maxRateWait?: number) {
  const S = useAiChat.getState();
  const reply: ChatMsg = { id: uid(), role: 'model', text: '', turns: [], streaming: true, ...(refs ? { refs } : {}) };
  const abort = new AbortController();
  useAiChat.setState({ msgs: [...S.msgs, reply], busy: true, abort });
  void (async () => {
    let done = false;
    try {
      const r = await runWithFixes({
        system: withCustom(chatSystem(), useAiSettings.getState().custom),
        turns: [...history, api],
        hint,
        signal: abort.signal,
        onText: (t) => patch(reply.id, { text: t }),
        onFix: (n) => patch(reply.id, { fixing: n }),
        onRefs: (refs) => patch(reply.id, { refs }),
        refs: reply.refs,
        project: true,
        onProposals: (proposals) => patch(reply.id, { proposals }),
        look: useAiSettings.getState().look,
        onLook: (seen) => patch(reply.id, { seen }),
        maxRateWait,
      });
      patch(reply.id, { text: r.text, turns: keep ? [keep, ...r.added] : r.added, streaming: false, fixing: undefined, fixes: r.fixes, check: r.check, refs: r.refs, proposals: r.proposals });
      done = r.proposals.length > 0;
    } catch (e) {
      if (abort.signal.aborted) patch(reply.id, { streaming: false, fixing: undefined, turns: [] });
      else patch(reply.id, { streaming: false, fixing: undefined, turns: [], error: toAiError(e) });
    } finally {
      useAiChat.setState({ busy: false, abort: null });
    }
    // 自動套用（AI 看完自動剪輯結果的那則不套，免得一直重剪）
    if (done && !keep && useAiSettings.getState().auto) applyChatProposalsToast(reply.id);
  })();
}

/** 這則回覆的修改目前還在（套用過、而且那一步沒被復原） */
export const isApplied = (m: ChatMsg) => !!m.applied && (m.applied.step === undefined || historyPath().includes(m.applied.step));

/** 套用某則回覆提議的修改（一步復原） */
export function applyChatProposals(msgId: string): { done: number; skipped: number } | null {
  const m = useAiChat.getState().msgs.find((x) => x.id === msgId);
  if (!m?.proposals?.length || isApplied(m)) return null;
  const gen = m.proposals.some((p) => p.op.op === 'auto_edit' && p.op.generate);
  let off = () => {};
  if (gen) {
    // 產生的步驟即時顯示在這則回覆下面
    patch(msgId, { steps: { lines: [], running: true } });
    void import('../engine/autoEditApply').then(({ useAutoEditRun }) => {
      off = useAutoEditRun.subscribe((s) => {
        if (s.running) patch(msgId, { steps: { lines: s.log, running: true, label: s.label } });
      });
    });
  }
  const before = historyPath();
  let after = before;
  const r = applyProposals(m.proposals, {
    onAutoEdit: (res) => {
      off();
      // 產生的剪輯（緊接在套用後、中間沒有別的編輯）跟套用的修改併成一步復原
      const now = historyPath();
      if (now.length === after.length + 1 && now.slice(0, -1).join() === after.join()) {
        const applied = useAiChat.getState().msgs.find((x) => x.id === msgId)?.applied;
        if (applied && (applied.step === undefined || !mergeIntoStep(applied.step))) patch(msgId, { applied: { ...applied, step: now[now.length - 1] } });
      }
      void import('../engine/autoEditApply').then(({ useAutoEditRun }) => {
        const lines = useAutoEditRun.getState().log;
        patch(msgId, { steps: { lines, running: false } });
        // 跑完：讓 AI 看結果說明（使用者取消的、已經在跑別的就不打擾）
        if (res && !res.cancelled) reviewAutoEdit(res, lines);
      });
    },
  });
  after = historyPath();
  patch(msgId, { applied: { ...r, ...(after.length > before.length || after.join() !== before.join() ? { step: after[after.length - 1] } : {}) } });
  return r;
}

/** 套用並跳出結果提示 */
export function applyChatProposalsToast(msgId: string) {
  const r = applyChatProposals(msgId);
  if (r) toast(r.skipped ? $t('已套用 {0} 項，{1} 項已不存在', r.done, r.skipped) : $t('已套用 {0} 項', r.done));
}

/** 自動剪輯跑完：把結果、步驟交給 AI，請它跟使用者說明（不顯示使用者訊息） */
function reviewAutoEdit(res: { ok: boolean; text: string }, lines: string[]) {
  if (useAiChat.getState().busy) return;
  const text = `[Auto edit finished — not typed by the user]\nResult: ${res.ok ? 'ok' : 'problem'} — ${res.text}\nSteps:\n${lines.map((l) => `- ${l}`).join('\n')}\n\n` +
    `Briefly tell the user (in their language) what was made: how many shots / effects, how the AI director arranged the media if it ran, and anything that went wrong. ` +
    `Then suggest one or two concrete next tweaks. Do not call tools unless the result clearly needs fixing.`;
  runReply({ role: 'user', text }, { role: 'user', text: `${text}\n\n<project_snapshot>\n${projectSnapshot()}\n</project_snapshot>` }, chatHistory(useAiChat.getState().msgs), undefined, undefined, 90);
}

export function stopChat() {
  useAiChat.getState().abort?.abort();
}
/** 從這則訊息之後專案還有幾步修改（只往後加、沒有分岔才算得出來；null = 退不回去） */
export function stepsSince(m: ChatMsg): number | null {
  if (!m.path) return null;
  const now = historyPath();
  if (now.length < m.path.length || m.path.some((id, i) => now[i] !== id)) return null;
  return now.length - m.path.length;
}

/** 從這則使用者訊息重來：拿掉它和之後的對話，文字放回輸入框；undoToo = 專案也復原到送出這則之前 */
export function rewindChat(msgId: string, undoToo = false) {
  const S = useAiChat.getState();
  const i = S.msgs.findIndex((m) => m.id === msgId);
  const m = S.msgs[i];
  if (!m || m.role !== 'user') return;
  stopChat();
  if (undoToo) {
    const n = stepsSince(m);
    for (let k = 0; k < (n ?? 0); k++) undo();
  }
  useAiChat.setState((s) => ({ msgs: s.msgs.slice(0, i), draft: { text: m.text, n: (s.draft?.n ?? 0) + 1 } }));
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
