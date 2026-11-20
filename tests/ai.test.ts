import { codeBlocks, detectKind, guessName } from '../src/ai/text';
import { hunks, lineDiff } from '../src/ai/diff';
import { RateLimitError, ApiKeyError, BlockedError, listModels, pickDefaultModel, streamChat } from '../src/ai/gemini';

let fails = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) fails++;
};

// ── 程式碼區塊 / 模組種類 ──
const reply = 'Here:\n```glsl\n// Neon Edge: glow\nvec4 effect(vec2 uv) { return tex(uv); }\n```\nDone.\n```js\nfunction remap(t, p, info) { return t; }\n```';
const bs = codeBlocks(reply);
ok(bs.length === 2 && bs[0].lang === 'glsl' && bs[1].lang === 'js', '找到兩個程式碼區塊');
ok(detectKind(bs[0].code) === 'effect' && detectKind(bs[1].code) === 'remap', '判斷模組種類');
ok(detectKind('vec4 transition(vec2 uv) { return getTo(uv); }') === 'transition', '轉場');
ok(detectKind('float x = 1.0;') === null, '不是模組');
ok(guessName(bs[0].code) === 'Neon Edge', '第一行註解當名稱');
ok(guessName('// @param a: float = 1\nvec4 effect') === null, '@param 不當名稱');
const live = codeBlocks('text\n```glsl\nvec4 effect(vec2 uv) {');
ok(live.length === 1 && live[0].code.startsWith('vec4'), '串流中還沒收完的區塊也抓得到');

// ── diff ──
const d = lineDiff('a\nb\nc', 'a\nB\nc');
ok(d.map((x) => x.op).join('') === ' -+ ', '逐行差異');
const big = Array.from({ length: 20 }, (_, i) => `l${i}`);
const h = hunks(lineDiff(big.join('\n'), big.map((x, i) => (i === 10 ? 'X' : x)).join('\n')), 2);
ok(h[0] === null && h[h.length - 1] === null && h.filter(Boolean).length === 6, '只留變動附近的行，其他折疊');

// ── Gemini（假的 fetch） ──
type Call = { url: string; init?: RequestInit };
const calls: Call[] = [];
function sse(events: unknown[]) {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\r\n\r\n`).join('');
  // 故意切成很小的片段，測試跨片段的行
  const enc = new TextEncoder().encode(body);
  return new Response(new ReadableStream({
    start(c) { for (let i = 0; i < enc.length; i += 7) c.enqueue(enc.slice(i, i + 7)); c.close(); },
  }), { status: 200 });
}
let next: () => Response = () => new Response('{}');
(globalThis as any).fetch = async (url: string, init?: RequestInit) => { calls.push({ url, init }); return next(); };

(async () => {
  next = () => sse([
    { candidates: [{ content: { parts: [{ text: 'thinking…', thought: true }] } }] },
    { candidates: [{ content: { parts: [{ text: 'Hel' }] } }] },
    { candidates: [{ content: { parts: [{ text: 'lo 世界' }] }, finishReason: 'STOP' }] },
  ]);
  const seen: string[] = [];
  const out = await streamChat({ key: 'K', model: 'gemini-x', system: 'S', turns: [{ role: 'user', text: 'hi' }], onText: (t) => seen.push(t) });
  ok(out === 'Hello 世界', '串流組合文字（跳過思考部分、跨片段的 UTF-8）');
  ok(seen[seen.length - 1] === out && seen.length === 2, '每段都回報累積的全文');
  const c = calls[calls.length - 1];
  ok(c.url.includes('/models/gemini-x:streamGenerateContent?alt=sse'), '呼叫串流端點');
  ok((c.init!.headers as Record<string, string>)['x-goog-api-key'] === 'K', '金鑰放在 header，不放網址');
  const body = JSON.parse(String(c.init!.body));
  ok(body.systemInstruction.parts[0].text === 'S' && body.contents[0].role === 'user', '系統提示與對話格式');

  next = () => new Response(JSON.stringify({ error: { code: 429, message: 'quota', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '17s' }] } }), { status: 429 });
  try { await streamChat({ key: 'K', model: 'm', system: '', turns: [] }); ok(false, '429 要丟錯'); }
  catch (e) { ok(e instanceof RateLimitError && e.retryAfter === 17, '429 → RateLimitError，帶建議等待秒數'); }

  next = () => new Response(JSON.stringify({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.' } }), { status: 400 });
  try { await streamChat({ key: 'K', model: 'm', system: '', turns: [] }); ok(false, '金鑰錯要丟錯'); }
  catch (e) { ok(e instanceof ApiKeyError, '金鑰無效 → ApiKeyError'); }

  next = () => sse([{ promptFeedback: { blockReason: 'SAFETY' } }]);
  try { await streamChat({ key: 'K', model: 'm', system: '', turns: [] }); ok(false, '被擋要丟錯'); }
  catch (e) { ok(e instanceof BlockedError, '被安全機制擋下 → BlockedError'); }

  next = () => new Response(JSON.stringify({ models: [
    { name: 'models/gemini-2.0-flash', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-2.5-flash-lite', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.5-flash-lite-preview', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
    { name: 'models/gemini-embedding-001', supportedGenerationMethods: ['embedContent', 'generateContent'] },
  ] }));
  const list = await listModels('K');
  ok(list.map((m) => m.id).join(',') === 'gemini-3.5-flash-lite-preview,gemini-2.5-flash-lite,gemini-2.0-flash', '模型清單：只留文字模型，新的在前');
  ok(pickDefaultModel(list) === 'gemini-2.5-flash-lite', '預設挑穩定版的 flash-lite');

  console.log(fails ? `\n${fails} 項失敗` : '\n全部通過');
  if (fails) process.exit(1);
})();
