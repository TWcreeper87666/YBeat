/**
 * Gemini API（Google AI Studio 的免費 / 付費金鑰都能用），直接從瀏覽器呼叫，不經過任何伺服器。
 * 只用 REST + fetch，不另外裝 SDK。
 */

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

/** API 的原始 part（文字 / functionCall / functionResponse，可能帶 thoughtSignature） */
export type Part = Record<string, any>;
/** parts 有值時照原樣送出（工具呼叫的回合、附圖）；沒有就用 text。img = 附了圖（之後的對話紀錄只留 text） */
export interface Turn { role: 'user' | 'model'; text: string; parts?: Part[]; img?: true }

/** 圖片 part */
export const imagePart = (s: { mime: string; data: string }): Part => ({ inlineData: { mimeType: s.mime, data: s.data } });
export interface ToolDecl { name: string; description: string; parameters: Record<string, unknown> }
export interface FnCall { name: string; args: Record<string, unknown>; id?: string }

/** 被限流（免費額度用完 / 每分鐘次數到了）；retryAfter = 建議等幾秒 */
export class RateLimitError extends Error {
  constructor(message: string, public retryAfter: number | null) {
    super(message);
  }
}
export class ApiKeyError extends Error {}
export class BlockedError extends Error {}
/** 暫時性的錯誤（伺服器忙碌 / 過載 / 5xx）：等一下再試通常就好 */
export class BusyError extends Error {}

const BUSY_MSG = /high demand|overloaded|unavailable|try again later|internal error|deadline/i;

async function fail(res: Response): Promise<never> {
  let msg = `HTTP ${res.status}`;
  let retry: number | null = null;
  try {
    const j = await res.json();
    const e = j?.error ?? j?.[0]?.error;
    if (e?.message) msg = e.message;
    for (const d of e?.details ?? []) {
      const m = /^(\d+(?:\.\d+)?)s$/.exec(d?.retryDelay ?? '');
      if (m) retry = Math.ceil(parseFloat(m[1]));
    }
  } catch { /* 不是 JSON */ }
  if (res.status === 429) throw new RateLimitError(msg, retry);
  if (res.status >= 500 || BUSY_MSG.test(msg)) throw new BusyError(msg);
  if (res.status === 400 && /api key/i.test(msg)) throw new ApiKeyError(msg);
  if (res.status === 401 || res.status === 403) throw new ApiKeyError(msg);
  throw new Error(msg);
}

export interface ModelInfo { id: string; name: string }

/** 這把金鑰能用的模型（只留能產生文字的 Gemini 模型，新的排前面） */
export async function listModels(key: string, signal?: AbortSignal): Promise<ModelInfo[]> {
  const out: ModelInfo[] = [];
  let page = '';
  for (let i = 0; i < 5; i++) {
    const res = await fetch(`${BASE}/models?pageSize=200${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`, { headers: { 'x-goog-api-key': key }, signal });
    if (!res.ok) await fail(res);
    const j = await res.json();
    for (const m of j.models ?? []) {
      const id = String(m.name ?? '').replace(/^models\//, '');
      if (!/^gemini/i.test(id)) continue;
      if (!(m.supportedGenerationMethods ?? []).includes('generateContent')) continue;
      if (/embedding|image|tts|audio|live/i.test(id)) continue;
      out.push({ id, name: m.displayName ?? id });
    }
    page = j.nextPageToken ?? '';
    if (!page) break;
  }
  return out.sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }));
}

/** 沒選過模型時的預設：最新的 flash-lite（免費額度最寬鬆），沒有就最新的 flash */
/** 預設模型：目前免費額度最多 */
export const DEFAULT_MODEL = 'gemini-3.5-flash-lite';

export function pickDefaultModel(list: ModelInfo[]): string {
  if (list.some((m) => m.id === DEFAULT_MODEL)) return DEFAULT_MODEL;
  const stable = list.filter((m) => !/preview|exp/i.test(m.id));
  const pool = stable.length ? stable : list;
  return (pool.find((m) => /flash-lite/i.test(m.id)) ?? pool.find((m) => /flash/i.test(m.id)) ?? pool[0])?.id ?? '';
}

/**
 * 串流產生回覆：每收到一段文字就呼叫 onText（累積後的全文），結束回傳全文。
 */
export async function streamChat(o: Parameters<typeof streamTurn>[0]): Promise<string> {
  return (await streamTurn(o)).text;
}

type TurnOpts = {
  key: string;
  model: string;
  system: string;
  turns: Turn[];
  tools?: ToolDecl[];
  toolMode?: 'AUTO' | 'NONE';
  signal?: AbortSignal;
  onText?: (full: string) => void;
  /** 暫時性錯誤、等一下要重試時通知（第幾次、等幾秒） */
  onRetry?: (attempt: number, waitSec: number, reason: string) => void;
  /** 限流最多等幾秒就自動重試（沒有 = MAX_RATE_WAIT；自動進行的請求可以等久一點） */
  maxRateWait?: number;
};

/** 倒數 sec 秒：馬上顯示一次，之後每秒 show(剩幾秒)，到 1 為止；回傳停止的函式 */
export function countdown(sec: number, show: (left: number) => void): () => void {
  let left = Math.max(1, Math.ceil(sec));
  show(left);
  const t = setInterval(() => {
    if (left <= 1) return clearInterval(t);
    show(--left);
  }, 1000);
  return () => clearInterval(t);
}

/** 重試的等待秒數（第 1、2、3、4 次） */
const RETRY_WAIT = [1, 2, 4, 8];
/** 限流要求等太久就不重試（直接回報，讓使用者決定） */
const MAX_RATE_WAIT = 30;

const sleep = (sec: number, signal?: AbortSignal) => new Promise<void>((res, rej) => {
  if (signal?.aborted) return rej(new DOMException('aborted', 'AbortError'));
  const t = setTimeout(res, sec * 1000);
  signal?.addEventListener('abort', () => { clearTimeout(t); rej(new DOMException('aborted', 'AbortError')); }, { once: true });
});

/**
 * 串流一輪：回傳文字、原始 parts（要原樣送回去，思考型模型的 thoughtSignature 在裡面）、工具呼叫。
 * toolMode = 'NONE'：對話裡有工具回合但這輪不准再呼叫。
 * 伺服器忙碌、網路斷線、短暫限流：還沒收到任何內容就自動重試（最多 4 次，等 1 / 2 / 4 / 8 秒）。
 */
export async function streamTurn(o: TurnOpts): Promise<{ text: string; parts: Part[]; calls: FnCall[] }> {
  for (let attempt = 0; ; attempt++) {
    let got = false;
    try {
      return await streamOnce({ ...o, onText: (t) => { got = true; o.onText?.(t); } });
    } catch (e) {
      if (o.signal?.aborted || got || attempt >= RETRY_WAIT.length) throw e;
      let wait: number | null = null;
      if (e instanceof BusyError) wait = RETRY_WAIT[attempt];
      else if (e instanceof RateLimitError) wait = e.retryAfter !== null && e.retryAfter <= (o.maxRateWait ?? MAX_RATE_WAIT) ? Math.max(e.retryAfter, RETRY_WAIT[attempt]) : null;
      // 網路錯誤（fetch 失敗、串流中斷）
      else if (e instanceof TypeError) wait = RETRY_WAIT[attempt];
      if (wait === null) throw e;
      o.onRetry?.(attempt + 1, wait, e instanceof Error ? e.message : String(e));
      await sleep(wait, o.signal);
    }
  }
}

async function streamOnce(o: TurnOpts): Promise<{ text: string; parts: Part[]; calls: FnCall[] }> {
  const res = await fetch(`${BASE}/models/${encodeURIComponent(o.model)}:streamGenerateContent?alt=sse`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': o.key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: o.system }] },
      contents: o.turns.map((t) => ({ role: t.role, parts: t.parts ?? [{ text: t.text }] })),
      ...(o.tools?.length
        ? { tools: [{ functionDeclarations: o.tools }], toolConfig: { functionCallingConfig: { mode: o.toolMode ?? 'AUTO' } } }
        : {}),
    }),
    signal: o.signal,
  });
  if (!res.ok || !res.body) await fail(res);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let full = '';
  let finish = '';
  let blocked = '';
  const parts: Part[] = [];
  const calls: FnCall[] = [];
  const plain = (p: Part | undefined) => !!p && typeof p.text === 'string' && !p.thought && !p.thoughtSignature && Object.keys(p).length === 1;
  const handle = (line: string) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let j: any;
    try { j = JSON.parse(data); } catch { return; }
    if (j.error) {
      const m = String(j.error.message ?? 'error');
      throw (j.error.code >= 500 || BUSY_MSG.test(m) ? new BusyError(m) : new Error(m));
    }
    if (j.promptFeedback?.blockReason) blocked = j.promptFeedback.blockReason;
    const c = j.candidates?.[0];
    if (c?.finishReason) finish = c.finishReason;
    for (const p of (c?.content?.parts ?? []) as Part[]) {
      if (p.functionCall) calls.push({ name: String(p.functionCall.name ?? ''), args: p.functionCall.args ?? {}, ...(p.functionCall.id ? { id: p.functionCall.id } : {}) });
      // 思考型模型的「想法」部分（thought: true）不顯示；沒帶簽章的想法也不用送回去
      if (p.thought && !p.thoughtSignature) continue;
      // 串流切碎的純文字併成一個 part
      if (plain(p) && plain(parts[parts.length - 1])) parts[parts.length - 1] = { text: parts[parts.length - 1].text + p.text };
      else parts.push(p);
      if (!p.thought && typeof p.text === 'string' && p.text) {
        full += p.text;
        o.onText?.(full);
      }
    }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      handle(buf.slice(0, i).replace(/\r$/, ''));
      buf = buf.slice(i + 1);
    }
  }
  if (buf) handle(buf);
  if (!full && !calls.length && (blocked || /SAFETY|PROHIBITED|BLOCKLIST|RECITATION/.test(finish))) throw new BlockedError(blocked || finish);
  return { text: full, parts, calls };
}
