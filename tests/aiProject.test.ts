// store 用了 localStorage（persist）：測試裡給一個空的
(globalThis as any).localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
(globalThis as any).window = globalThis;
const warn = console.warn;
console.warn = () => {};
import { useStore } from '../src/store';
import { resetHistory, undo } from '../src/engine/history';
import { applyProposals, cleanParams, projectSnapshot, runProjectTool, scopeTargets, type Proposal } from '../src/ai/projectTools';
import { mentionedModules } from '../src/ai/tools';
import { sendChat, useAiChat, useAiSettings } from '../src/ai/assistant';
import { BUILTIN_MODULES } from '../src/modules/builtin';

let fails = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) fails++;
};

const media = [{ id: 'm1', name: 'v.mp4', kind: 'video', url: '', width: 1080, height: 1920, duration: 30, thumb: '', hasAudio: false }];
const mk = (id: string, start: number, duration: number, track = 0) => ({
  id, mediaId: 'm1', track, start, duration, in: 0, fit: 'cover', transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1 },
  keys: {}, remap: { moduleId: 'remap-speed', params: {} }, transitionIn: null, transitionOut: null, volume: 1, rate: 1, flipX: false,
});
const reset = () => {
  useStore.setState({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    media: media as any, clips: [mk('a', 0, 2), mk('b', 2, 2), mk('c', 5, 2)] as any, audios: [],
    effects: [{ id: 'e1', moduleId: 'fx-shake', params: {}, start: 0, duration: 1, track: 0 }],
    tracks: { video: [{}], fx: [{}], audio: [{}] },
    selection: { type: 'clip', id: 'b' }, selected: ['clip:b'], leftTab: 'media',
  });
  resetHistory();
};
const S = () => useStore.getState();
const run = (name: string, args: Record<string, unknown>, list: Proposal[] = []) => runProjectTool(name, args, list) as any;

// ── 讀取 ──
reset();
const tl = run('get_timeline', {});
ok(tl.clips.length === 3 && tl.clips[0].id === 'a' && tl.clips[0].name === 'v.mp4' && tl.effects[0].module === 'fx-shake', 'get_timeline 列出片段與特效');
ok(run('get_timeline', { from: 4.5 }).clips.map((c: any) => c.id).join() === 'c', 'get_timeline 依時間範圍過濾');
const sel = run('get_selection', {});
ok(sel.selected[0].type === 'clip' && sel.selected[0].id === 'b', 'get_selection');
ok(run('get_beats', {}).note?.includes('no beats'), '沒有音樂 → 沒有節拍');

// ── 剪接點規則 ──
ok(JSON.stringify(scopeTargets(S().clips, 0, 'cuts')) === JSON.stringify([{ clipId: 'b', side: 'in' }]), '剪接點：只有緊貼的 a|b');
ok(scopeTargets(S().clips, 0, 'all').length === 5, 'all：開頭 a、c + 剪接點 b + 結尾 b、c');

// ── 參數檢查 ──
const code = '// @param amount: float = 1 (0..2) "A"\n// @param on: bool = true\nvec4 effect(vec2 uv){return tex(uv);}';
const cp = cleanParams(code, { amount: 5, on: false, nope: 1 });
ok(cp.params.amount === 2 && cp.params.on === false && cp.unknown[0] === 'nope', '參數夾在範圍內、不認得的名稱列出來');
let threw = false;
try { cleanParams(code, { amount: 'big' }); } catch { threw = true; }
ok(threw, '型別錯誤要報錯');

// ── 提議：驗證錯誤丟回給 AI，不會加進清單 ──
const list: Proposal[] = [];
ok(run('add_effects', { moduleId: 'nope', blocks: [{ start: 0, duration: 1 }] }, list).error?.includes('unknown module'), '不存在的模組 → error');
ok(run('set_remap', { moduleId: 'fx-shake', clipIds: ['a'] }, list).error?.includes('expected remap'), '模組種類不對 → error');
ok(run('set_transitions', { moduleId: 'tr-iris', clipIds: ['zzz'] }, list).error?.includes('unknown clip'), '不存在的片段 → error');
ok(list.length === 0, '失敗的提議不加進清單');

// ── 提議不會改專案 ──
const before = S().clips;
ok(run('set_transitions', { moduleId: 'tr-iris', track: 0, scope: 'cuts', duration: 0.5 }, list).ok, '提議轉場');
ok(run('add_effects', { moduleId: 'fx-shake', blocks: [{ start: 0, duration: 4 }], trigger: 'bar' }, list).ok, '提議特效方塊');
ok(run('set_remap', { moduleId: 'remap-boomerang', clipIds: ['c'] }, list).ok, '提議變速');
ok(run('add_clip_effects', { moduleId: 'fx-rgb', clipIds: ['a', 'b'] }, list).ok, '提議片段特效');
ok(run('remove', { targets: [{ kind: 'effect', id: 'e1' }] }, list).ok, '提議刪除');
ok(S().clips === before && S().effects.length === 1 && list.length === 5, '提議階段專案沒有變');

// ── 套用：一步復原、選取不跳 ──
const selBefore = S().selection;
let selChanged = 0;
const unsub = useStore.subscribe((n, p) => { if (n.selection !== p.selection) selChanged++; });
const r = applyProposals(list);
unsub();
ok(selChanged === 0 && S().selection === selBefore, '套用過程中選取完全沒變（面板不會跳到屬性）');
const s = S();
const b = s.clips.find((c) => c.id === 'b')!;
ok(b.transitionIn?.moduleId === 'tr-iris' && b.transitionIn.duration === 0.5, '轉場套用到剪接點');
ok(!s.clips.find((c) => c.id === 'a')!.transitionIn, '非剪接點不動');
const blk = s.effects.find((e) => e.moduleId === 'fx-shake' && e.duration === 4);
ok(!!blk && blk.trigger?.kind === 'beat' && blk.trigger.every === 4, '特效方塊帶節拍觸發（每小節）');
ok(blk!.track === 1 && s.tracks.fx.length === 2 && !s.effects.some((e) => e.id === 'e1'), '依序套用：新方塊跟 e1 重疊 → 新增特效軌；之後刪掉 e1');
ok(s.clips.find((c) => c.id === 'c')!.remap.moduleId === 'remap-curve' && !!s.clips.find((c) => c.id === 'c')!.remap.keys?.length, '變速套用（曲線預設 → 曲線關鍵影格）');
ok(s.clips.filter((c) => c.effects?.some((f) => f.moduleId === 'fx-rgb')).length === 2, '片段特效套用到兩個片段');
ok(r.done === 1 + 1 + 1 + 2 + 1 && r.skipped === 0, `套用數量 ${r.done}`);
ok(s.selection?.id === 'b' && s.leftTab === 'media', '套用後選取 / 分頁不跳');
undo();
ok(S().clips === before && S().effects.length === 1 && S().effects[0].id === 'e1', '一次復原整批');

// ── 套用時目標已經不見 → 跳過 ──
reset();
const l2: Proposal[] = [];
run('set_remap', { moduleId: 'remap-boomerang', clipIds: ['a', 'c'] }, l2);
useStore.setState({ clips: S().clips.filter((c) => c.id !== 'c') });
const r2 = applyProposals(l2);
ok(r2.done === 1 && r2.skipped === 1, '刪掉的片段跳過');

// ── 特效軌被佔用 → 自動新增軌道 ──
reset();
const l3: Proposal[] = [];
run('add_effects', { moduleId: 'fx-flash', blocks: [{ start: 0.5, duration: 1 }] }, l3);
applyProposals(l3);
const fl = S().effects.find((e) => e.moduleId === 'fx-flash')!;
ok(S().tracks.fx.length === 2 && fl.track === 1 && fl.start === 0.5, '沒有空位就新增特效軌，不改開始時間');

// ── 調整參數 ──
reset();
const l4: Proposal[] = [];
const up = run('update_params', { targets: [{ kind: 'effect', id: 'e1' }], params: { zzz: 1 } }, l4);
ok(up.ok && up.warnings?.[0]?.includes('zzz'), '不認得的參數 → 警告');

// ── 快照 ──
reset();
const snap = projectSnapshot();
ok(snap.includes('selected:') && snap.includes('- clip b ') && snap.includes('remap remap-speed params: speed'), '快照：選取的片段連參數');
ok(snap.includes('beats: none') && /\na v0 0-2 video/.test(snap) && snap.includes('e1 fx0 0-1 fx-shake'), '快照：節拍、片段、特效方塊');

// ── 提到的模組 ──
const mods = BUILTIN_MODULES;
const names = (t: string) => mentionedModules(t, mods).map((m) => m.id).join();
ok(names('照內建的圓形擴散做一個方形版本') === 'tr-iris', '中文名稱');
ok(names('add shake blur here') === 'fx-shakeblur', '長名稱優先，不重複算短的');
ok(names('make the IRIS bigger, and add Shake') === 'fx-shake,tr-iris' || names('make the IRIS bigger, and add Shake') === 'tr-iris,fx-shake', '英文不分大小寫、最多兩個');
ok(names('how do I add keyframes?') === '', '沒提到就不附');

// ── 關鍵影格 / 作用範圍 ──
{
  reset();
  useStore.setState({ clips: S().clips.map((c) => (c.id === 'b' ? { ...c, effects: [{ id: 'f1', moduleId: 'fx-shake', params: {} }] } : c)) });
  let list: Proposal[] = [];
  let r = run('set_keyframes', { targets: [{ kind: 'effect', id: 'e1' }], param: 'strength', keys: [{ t: 0, v: 0 }, { t: 1, v: 9 }] }, list);
  ok(r.ok && list.length === 1, 'set_keyframes 提議');
  ok(!!run('set_keyframes', { targets: [{ kind: 'effect', id: 'e1' }], param: 'nope', keys: [] }).error, '不存在的參數 → 錯誤');
  applyProposals(list);
  const k = S().effects[0].keys?.strength;
  ok(k?.length === 2 && k[1].v === 0.2, '套用：關鍵影格、超出範圍的值夾到上限');
  list = [];
  run('set_keyframes', { targets: [{ kind: 'effect', id: 'e1' }], param: 'strength', keys: [] }, list);
  applyProposals(list);
  ok(!S().effects[0].keys?.strength && S().effects[0].params.strength === 0, '空的 keys = 關掉動畫，值留在第一個關鍵影格');

  list = [];
  r = run('set_effect_timing', { targets: [{ kind: 'clip_fx', clipId: 'b', fxId: 'f1' }], mode: 'hits', hits: [{ t: 1, d: 0.3 }, { t: 0, d: 5 }] }, list);
  ok(r.ok, 'set_effect_timing 提議');
  ok(!!run('set_effect_timing', { targets: [{ kind: 'effect', id: 'e1' }], mode: 'whole' }).error, '特效方塊不能設作用範圍');
  applyProposals(list);
  const tm = S().clips.find((c) => c.id === 'b')!.effects![0].timing;
  ok(tm?.kind === 'hits' && tm.hits.length === 2 && tm.hits[0].t === 0 && tm.hits[0].d === 1, '套用：排序、重疊截短');
  list = [];
  run('set_effect_timing', { targets: [{ kind: 'clip_fx', clipId: 'b', fxId: 'f1' }], mode: 'beat', every: 4, d: 0.5 }, list);
  applyProposals(list);
  ok(JSON.stringify(S().clips.find((c) => c.id === 'b')!.effects![0].timing) === JSON.stringify({ kind: 'beat', every: 4, d: 0.5 }), '每小節觸發');
  useStore.setState({ selection: { type: 'clip', id: 'b' }, selected: ['clip:b'] });
  ok(projectSnapshot().includes('active: every 4 beat'), '快照列出片段特效的作用範圍');
}

// ── 跟隨臉部 ──
{
  reset();
  useStore.setState({ clips: S().clips.map((c) => (c.id === 'b' ? { ...c, effects: [{ id: 'z1', moduleId: 'fx-crashzoom', params: {} }] } : c)) });
  useStore.setState({ selection: { type: 'clip', id: 'b' }, selected: ['clip:b'] });
  ok(projectSnapshot().includes('(follows face)'), '快照：內建縮放類預設跟隨');
  const list: Proposal[] = [];
  ok(!!run('set_follow', { targets: [{ kind: 'effect', id: 'e1' }], param: 'center', on: true }).error, '沒有這個 point 參數 → 錯誤');
  run('set_follow', { targets: [{ kind: 'clip_fx', clipId: 'b', fxId: 'z1' }], param: 'center', on: false }, list);
  applyProposals(list);
  ok(S().clips.find((c) => c.id === 'b')!.effects![0].follow?.center === null, '關掉跟隨（蓋過模組預設）');
  ok(!projectSnapshot().includes('(follows face)'), '快照跟著更新');
  const l2: Proposal[] = [];
  ok(!!run('set_face_tracking', { clipIds: ['zz'], on: true }).error, '不存在的片段 → 錯誤');
  run('set_face_tracking', { clipIds: ['b'], on: true }, l2);
  applyProposals(l2);
  ok(S().clips.find((c) => c.id === 'b')!.faceTrack === true && projectSnapshot().includes('face-tracking'), '片段打開臉部追蹤、快照標示');
}

// ── 字幕 ──
{
  reset();
  const text = (t: string) => ({ text: t, font: 'x', size: 60, fill: { type: 'solid', color: '#fff' }, bold: false, italic: false, align: 'center', lineHeight: 1.2, strokes: [], bg: '#000', bgOpacity: 0, shadow: null });
  const sub = (id: string, start: number, duration: number, t: string) => ({ ...mk(id, start, duration, 1), mediaId: '', text: text(t), transform: { x: 0, y: 0.3, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1 } });
  useStore.setState({ clips: [...S().clips, sub('s1', 0, 2, '你好世屆'), sub('s2', 2, 4, '這是一段很長的字幕應該拆開')] as any, tracks: { video: [{}, {}], fx: [{}], audio: [{}] }, format: { w: 1080, h: 1920 } as any });
  ok(projectSnapshot().includes('s1 v1 0-2 "你好世屆"'), '快照列出字幕');
  ok(run('get_subtitles', {}).subtitles.length === 2, 'get_subtitles');
  ok(!!run('edit_subtitles', { items: [{ clipId: 'a', text: 'x' }] }).error, '不是文字片段 → 錯誤');
  ok(!!run('edit_subtitles', { items: [{ clipId: 's1', end: 3 }] }).error, '跟同軌下一段重疊 → 錯誤');

  let list: Proposal[] = [];
  run('edit_subtitles', { items: [{ clipId: 's1', text: '你好世界', end: 1.5 }] }, list);
  applyProposals(list);
  const s1 = S().clips.find((c) => c.id === 's1')!;
  ok(s1.text!.text === '你好世界' && s1.duration === 1.5, '校對 + 調時間');

  list = [];
  run('split_subtitles', { items: [{ clipId: 's2', parts: ['這是一段很長的字幕', '應該拆開'] }] }, list);
  ok(list[0]?.summary.includes('1') === true, 'split_subtitles 提議');
  applyProposals(list);
  const pieces = S().clips.filter((c) => c.track === 1 && c.start >= 2).sort((a, b) => a.start - b.start);
  ok(pieces.length === 2 && pieces[0].text!.text === '這是一段很長的字幕' && pieces[1].text!.text === '應該拆開', '拆成兩段、文字對上');
  ok(Math.abs(pieces[1].start - (2 + 4 * 9 / 13)) < 1e-6, '沒給時間 → 依字數分配');
  ok(!!run('split_subtitles', { items: [{ clipId: 's1', parts: ['a', 'b'], times: [0.05] }] }).error, '切點太靠邊 → 錯誤');

  list = [];
  run('translate_subtitles', { items: [{ clipId: 's1', text: 'Hello world' }] }, list);
  applyProposals(list);
  const tr = S().clips.find((c) => c.text?.text === 'Hello world')!;
  const orig = S().clips.find((c) => c.id === 's1')!;
  ok(!!tr && tr.track === 2 && orig.track === 1 && tr.start === orig.start && tr.duration === orig.duration, '翻譯：新軌道在原字幕軌正上方、時間相同');
  ok(tr.transform.y < orig.transform.y, '翻譯：畫面上放在原字幕上方');
  undo();
  ok(!S().clips.some((c) => c.text?.text === 'Hello world') && S().tracks.video.length === 2, '一步復原（含新軌道）');
}

// ── 請求次數：只有修改、而且成功 → 只送一次 ──
(async () => {
  const bodies: any[] = [];
  let reply: (n: number) => unknown[] = () => [];
  (globalThis as any).fetch = async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init!.body)));
    const enc = new TextEncoder().encode(reply(bodies.length).map((e) => `data: ${JSON.stringify(e)}\r\n\r\n`).join(''));
    return new Response(new ReadableStream({ start(c) { c.enqueue(enc); c.close(); } }), { status: 200 });
  };
  const call = (name: string, args: unknown) => ({ candidates: [{ content: { parts: [{ functionCall: { name, args } }] }, finishReason: 'STOP' }] });
  const text = (t: string) => ({ candidates: [{ content: { parts: [{ text: t }] }, finishReason: 'STOP' }] });
  const done = () => new Promise<void>((r) => { const t = setInterval(() => { if (!useAiChat.getState().busy) { clearInterval(t); r(); } }, 5); });
  useAiSettings.setState({ key: 'K', model: 'm' });

  reset();
  reply = () => [call('add_effects', { moduleId: 'fx-shake', blocks: [{ start: 0, duration: 2 }], trigger: 'bar' })];
  sendChat('add shake on every downbeat');
  await done();
  let last = useAiChat.getState().msgs.at(-1)!;
  ok(bodies.length === 1 && last.proposals?.length === 1 && !last.error, `修改成功 → 只送 1 次請求（實際 ${bodies.length}）`);
  const sent = bodies[0].contents.at(-1).parts[0].text as string;
  ok(sent.includes('<project_snapshot>') && sent.includes('<referenced_modules>') && sent.includes('Module fx-shake'), '問題附上專案快照與提到的模組');
  ok(last.refs?.[0] === '相機震動 Shake', '附上的模組顯示在「參考」');
  ok(last.turns.at(-1)?.role === 'model' && last.turns.at(-1)!.text.includes('Proposed'), '紀錄裡留下修改摘要，之後的對話看得到');

  // 下一次對話：舊的快照不帶
  bodies.length = 0;
  reply = () => [text('ok')];
  sendChat('thanks');
  await done();
  const hist = bodies[0].contents.map((c: any) => c.parts.map((p: any) => p.text ?? '').join('')).join('\n');
  ok((hist.match(/<project_snapshot>/g) ?? []).length === 1 && !hist.includes('functionCall'), '紀錄不重複帶快照、不帶工具回合');

  // 修改失敗 → 讓 AI 修正（第二次請求）
  useAiChat.setState({ msgs: [] });
  bodies.length = 0;
  reply = (n) => (n === 1 ? [call('add_effects', { moduleId: 'nope', blocks: [{ start: 0, duration: 1 }] })] : [call('add_effects', { moduleId: 'fx-flash', blocks: [{ start: 0, duration: 1 }] })]);
  sendChat('add a flash');
  await done();
  last = useAiChat.getState().msgs.at(-1)!;
  ok(bodies.length === 2 && last.proposals?.length === 1, `修改失敗 → 再問一次（實際 ${bodies.length} 次）`);

  console.warn = warn;
  console.log(fails ? `\n${fails} 項失敗` : '\n全部通過');
  if (fails) process.exit(1);
})();
