// store 用了 localStorage（persist）：測試裡給一個空的
(globalThis as any).localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
(globalThis as any).window = globalThis;
console.warn = () => {};
import { useStore, type Media } from '../src/store';
import { resetHistory } from '../src/engine/history';
import { applyProposals, isEditTool, runProjectTool, type Proposal } from '../src/ai/projectTools';
import { deleteMyStyle, renameMyStyle, saveMyStyle, useAutoEdit } from '../src/engine/autoEditSettings';
import { RECIPES } from '../src/engine/autoEdit';
import { usePrefs } from '../src/prefs';
import { directorBatches, parseDirection } from '../src/ai/director';

let fails = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) fails++;
};
const run = (name: string, args: Record<string, unknown>, list: Proposal[] = []) => runProjectTool(name, args, list) as any;

const media: Media[] = [
  { id: 'v', name: 'v.mp4', kind: 'video', url: '', width: 1080, height: 1920, duration: 10, thumb: '', hasAudio: false },
  { id: 'i', name: 'i.jpg', kind: 'image', url: '', width: 1080, height: 1920, duration: 0, thumb: '', hasAudio: false },
];
useStore.setState({ media, clips: [], audios: [], effects: [], tracks: { video: [{}], fx: [{}], audio: [{}] }, selection: null, selected: [], loop: null });
usePrefs.setState({ fxCombos: [{ id: 'combo:x', name: 'My hit', fx: { moduleId: 'fx-crashzoom', params: {}, duration: 0.4 } }] });
resetHistory();
useAutoEdit.getState().reset();

ok(!isEditTool('get_auto_edit') && isEditTool('set_auto_edit'), 'get 是讀取、set 是修改');
const g = run('get_auto_edit', {});
ok(g.style === 'rhythm' && g.media.length === 2 && g.media.every((m: any) => m.on), '讀到預設設定與素材');
ok(g.transitions.some((t: any) => t.id === 'tr-crossfade' && typeof t.strength === 'number' && t.weight > 0), '轉場附強度與權重');
ok(g.effects.some((a: any) => a.id === 'combo:x') && g.fx_layers.length > 0, '列出可用特效（含我的組合）與特效層');

// 提議：風格 + 數字覆寫 + 只用某分類的轉場 + 換特效層
const list: Proposal[] = [];
const r = run('set_auto_edit', { style: 'hype', beats_per_shot: { high: 2 }, transitions: { only: ['category:basic'] }, fx_layers: [{ effect: 'combo:x', when: 'cut', levels: [2], chance: 0.5 }], density: 1.5 }, list);
ok(r.ok && list.length === 1 && list[0].op.op === 'auto_edit', `提議成功：${r.proposed}`);
ok(useAutoEdit.getState().recipe === 'rhythm', '按套用前不會改');
applyProposals(list);
const st = useAutoEdit.getState();
ok(st.recipe === 'custom' && st.params.beatsPerShot[2] === 2 && st.params.beatsPerShot[0] === RECIPES.hype.beatsPerShot[0], '風格先套預設、再覆寫數字 → 自訂');
const after = run('get_auto_edit', {});
ok(after.transitions.filter((t: any) => t.weight > 0).every((t: any) => t.cat === 'basic') && after.transitions.some((t: any) => t.weight > 0), '只留基本類轉場');
ok(st.rules.length === 1 && st.rules[0].moduleId === 'combo:x' && st.rules[0].when === 'cut' && st.rules[0].chance === 0.5 && st.density === 1.5, '特效層換掉、密度');
ok('error' in run('set_auto_edit', { fx_layers: [{ effect: 'fx-nope', when: 'beat' }] }), '不存在的特效 → 錯誤');
const sv: Proposal[] = [];
run('set_auto_edit', { style: 'velocity' }, sv);
applyProposals(sv);
ok(useAutoEdit.getState().recipe === 'velocity' && useAutoEdit.getState().rules.some((x) => x.moduleId === 'fx-zoompulse') && useAutoEdit.getState().speedsPer32 === 4, '選速度感：特效層、變速一起換');
const tw: Proposal[] = [];
run('set_auto_edit', { transition_weights: { 'tr-whip': 0 } }, tw);
applyProposals(tw);
ok(useAutoEdit.getState().trWeights['tr-whip'] === 0, '轉場權重');

// 自己的風格
{
  saveMyStyle('我的');
  const mine = useAutoEdit.getState().myStyles[0];
  ok(!!mine && useAutoEdit.getState().recipe === `my:${mine.id}` && mine.trWeights['tr-whip'] === 0, '另存風格並選中');
  saveMyStyle('我的');
  ok(useAutoEdit.getState().myStyles.length === 1, '同名覆蓋');
  const ms: Proposal[] = [];
  run('set_auto_edit', { style: 'calm' }, ms);
  run('set_auto_edit', { style: '我的' }, ms);
  applyProposals(ms);
  ok(useAutoEdit.getState().recipe === `my:${mine.id}` && run('get_auto_edit', {}).style === '我的', 'AI 可以選自己的風格');
  renameMyStyle(mine.id, '改名');
  ok(useAutoEdit.getState().myStyles[0].name === '改名', '改名');
  useAutoEdit.getState().reset();
  ok(useAutoEdit.getState().myStyles.length === 1, '重設不會清掉自己的風格');
  deleteMyStyle(mine.id);
  ok(!useAutoEdit.getState().myStyles.length, '刪除');
}

// 錯誤
ok('error' in run('set_auto_edit', { transitions: { only: ['tr-nope'] } }), '不存在的 id → 錯誤');
ok('error' in run('set_auto_edit', { media: { disable: ['all'] } }), '素材不能全關');
ok('error' in run('set_auto_edit', { range: 'loop' }), '沒有循環範圍 → 錯誤');
ok('error' in run('set_auto_edit', {}), '什麼都沒改 → 錯誤');
const w = run('set_auto_edit', { transition_rate: 3 });
ok(w.ok && w.warnings?.length, '超出範圍會夾住並警告');
const gen: Proposal[] = [];
run('set_auto_edit', { generate: true, replace_last: true }, gen);
ok(gen[0]?.op.op === 'auto_edit' && (gen[0].op as any).generate && (gen[0].op as any).replaceLast, '只要求產生一版');

// AI 導演設定
const dl: Proposal[] = [];
run('set_auto_edit', { director_note: '開頭放風景' }, dl);
applyProposals(dl);
ok(useAutoEdit.getState().director && useAutoEdit.getState().directorNote === '開頭放風景', '給指示會順便打開 AI 導演');
ok(run('get_auto_edit', {}).director_note === '開頭放風景', '讀得到導演指示');

// 能量曲線
const el: Proposal[] = [];
run('set_auto_edit', { energy: { points: [{ at: 0.5, offset: 0.8 }], contrast: 1.5 } }, el);
applyProposals(el);
const sh = useAutoEdit.getState().shape;
ok(sh.points.length === 3 && sh.points[0].x === 0 && sh.points[2].x === 1 && sh.points[1].y === 0.8 && sh.contrast === 1.5, '曲線控制點（頭尾自動補上）、對比');
ok(run('get_auto_edit', {}).energy.points.length === 3, '讀得到曲線');
const er: Proposal[] = [];
run('set_auto_edit', { energy: { reset: true } }, er);
applyProposals(er);
ok(useAutoEdit.getState().shape.points.every((p) => p.y === 0) && useAutoEdit.getState().shape.contrast === 1, '曲線重設');

// 主體跳出
ok(run('get_auto_edit', {}).subject_pop.variants.join() === 'step', '主體跳出預設只開逐拍放大');
const pl: Proposal[] = [];
run('set_auto_edit', { subject_pop: { variants: ['step', 'fly'], per_32: 2 } }, pl);
applyProposals(pl);
ok(useAutoEdit.getState().popVariants.join() === 'step,fly' && useAutoEdit.getState().popsPer32 === 2 && useAutoEdit.getState().popOn, '改主體跳出的種類與次數');
ok('error' in run('set_auto_edit', { subject_pop: { variants: ['explode'] } }), '不認得的種類 → 錯誤');
const off: Proposal[] = [];
run('set_auto_edit', { subject_pop: { on: false } }, off);
applyProposals(off);
ok(!useAutoEdit.getState().popOn, '可以整個關掉');

// 跟拍變速
ok(run('get_auto_edit', {}).speed_ramps.variants.join() === 'beatPulse', '跟拍變速預設只開每拍快慢');
const sl: Proposal[] = [];
run('set_auto_edit', { speed_ramps: { variants: ['beatPulse', 'hitRamp'], intensity: 3 } }, sl);
applyProposals(sl);
ok(useAutoEdit.getState().speedVariants.join() === 'beatPulse,hitRamp' && useAutoEdit.getState().speedIntensity === 1, '改變速種類、強度夾在 0..1');
ok('error' in run('set_auto_edit', { speed_ramps: { variants: ['rewind'] } }), '還沒做的種類 → 錯誤');

// AI 導演的回覆解析
const reply = 'Sure:\n```json\n{"media":[{"id":"v","roles":["drop","nope"],"weight":1.4,"highlights":[3,99],"note":"best"},{"id":"i","roles":["intro"],"weight":0,"highlights":[1]},{"id":"ghost","roles":["drop"]}]}\n```';
const d = parseDirection(reply, media);
ok(d.size === 2 && !d.has('ghost'), '不認得的 id 略過');
ok(d.get('v')!.roles.join() === 'drop' && d.get('v')!.weight === 1 && d.get('v')!.highlights.join() === '3', '段落名稱、優先度、時間點都檢查過');
ok(d.get('i')!.weight === 0 && d.get('i')!.highlights.length === 0, '圖片沒有時間點；0 = 不用');
let threw = false;
try { parseDirection('no json here', media); } catch { threw = true; }
ok(threw, '沒有 JSON → 錯誤');

// 導演分批：每批不超過上限，順序不變，單一素材超過上限自己一批
{
  const items = [{ id: 'a', n: 30 }, { id: 'b', n: 30 }, { id: 'c', n: 10 }, { id: 'd', n: 80 }, { id: 'e', n: 0 }];
  const b = directorBatches(items, (x) => x.n, 60);
  ok(JSON.stringify(b.map((l) => l.map((x) => x.id))) === '[["a","b"],["c"],["d"],["e"]]', `分批（${JSON.stringify(b.map((l) => l.map((x) => x.id)))}）`);
}

// 轉場權重用 [{ id, weight }]（Gemini 不支援對照表的 schema）
{
  const l: Proposal[] = [];
  run('set_auto_edit', { transition_weights: [{ id: 'tr-whip', weight: 2.5 }] }, l);
  applyProposals(l);
  ok(useAutoEdit.getState().trWeights['tr-whip'] === 2.5, '轉場權重：陣列寫法');
}

// 要用 / 避開的範圍：放寬半個間隔、夾在影片長度內、合併重疊；圖片沒有範圍
{
  const vlen = media.find((m) => m.id === 'v')!.duration;
  const r = '{"media":[{"id":"v","roles":["drop"],"weight":1,"use":[[2,4]],"avoid":[[6,6],[7,9],[vlen,999],"x"]},{"id":"i","roles":["intro"],"weight":1,"avoid":[[0,1]]}]}'.replace('vlen', String(vlen - 0.5));
  const dd = parseDirection(r, media, new Map([['v', 2]]));
  const v = dd.get('v')!;
  ok(JSON.stringify(v.avoid.slice(0, 1)) === '[[5,10]]', `避開：單張放寬、重疊合併（${JSON.stringify(v.avoid)}）`);
  ok(v.avoid.every(([, b]) => b <= vlen), '避開：不超過影片長度');
  ok(JSON.stringify(v.use) === '[[1,5]]' && v.highlights.includes(1) && v.highlights.includes(4.5), '要用的範圍變成加分的時間點');
  ok(dd.get('i')!.avoid.length === 0, '圖片沒有範圍');
}

if (fails) {
  console.log(`\n${fails} 個失敗`);
  process.exit(1);
}
