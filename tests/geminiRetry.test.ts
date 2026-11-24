/** Gemini 呼叫的自動重試：伺服器忙碌 / 網路錯誤會重試，金鑰錯誤、已經收到內容就不重試 */
import { streamTurn, ApiKeyError, BusyError } from '../src/ai/gemini';

let fails = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) fails++;
};

const sse = (chunks: string[]) => new Response(new ReadableStream({
  start(c) {
    for (const x of chunks) c.enqueue(new TextEncoder().encode(x));
    c.close();
  },
}), { status: 200 });
const textChunk = (t: string) => `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: t }] } }] })}\n`;
const err = (status: number, message: string) => new Response(JSON.stringify({ error: { message } }), { status });

const base = { key: 'k', model: 'm', system: '', turns: [{ role: 'user' as const, text: 'hi' }] };

async function main() {
  // 503 兩次 → 第三次成功
  {
    let n = 0;
    const retries: number[] = [];
    globalThis.fetch = (async () => (++n <= 2 ? err(503, 'This model is currently experiencing high demand.') : sse([textChunk('ok')]))) as typeof fetch;
    const r = await streamTurn({ ...base, onRetry: (a) => retries.push(a) });
    ok(r.text === 'ok' && n === 3, '伺服器忙碌兩次，第三次成功');
    ok(retries.join() === '1,2', '每次重試都有通知（第 1、2 次）');
  }
  // 串流裡回報的忙碌錯誤（HTTP 200 但 data 是 error）也重試
  {
    let n = 0;
    globalThis.fetch = (async () => (++n === 1 ? sse([`data: ${JSON.stringify({ error: { code: 503, message: 'overloaded' } })}\n`]) : sse([textChunk('fine')]))) as typeof fetch;
    const r = await streamTurn(base);
    ok(r.text === 'fine' && n === 2, '串流中的過載錯誤也會重試');
  }
  // 金鑰錯誤：不重試
  {
    let n = 0;
    globalThis.fetch = (async () => (n++, err(401, 'bad key'))) as typeof fetch;
    let e: unknown = null;
    try { await streamTurn(base); } catch (x) { e = x; }
    ok(e instanceof ApiKeyError && n === 1, '金鑰錯誤不重試');
  }
  // 已經收到內容後才出錯：不重試（不然文字會重複）
  {
    let n = 0;
    globalThis.fetch = (async () => (n++, sse([textChunk('half'), `data: ${JSON.stringify({ error: { code: 503, message: 'overloaded' } })}\n`]))) as typeof fetch;
    let e: unknown = null;
    try { await streamTurn(base); } catch (x) { e = x; }
    ok(e instanceof BusyError && n === 1, '收到部分內容後出錯不重試');
  }
  // 取消：等待中的重試立刻停
  {
    const ac = new AbortController();
    globalThis.fetch = (async () => err(503, 'unavailable')) as typeof fetch;
    const t0 = Date.now();
    const p = streamTurn({ ...base, signal: ac.signal, onRetry: () => ac.abort() });
    let e: unknown = null;
    try { await p; } catch (x) { e = x; }
    ok(!!e && Date.now() - t0 < 500, '取消後不再等待重試');
  }
  if (fails) {
    console.log(`\n${fails} 個失敗`);
    process.exit(1);
  }
}
void main();
