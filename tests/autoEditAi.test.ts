// store 用了 localStorage（persist）：測試裡給一個空的
(globalThis as any).localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
(globalThis as any).window = globalThis;
console.warn = () => {};
import { useStore, type Media } from '../src/store';
import { resetHistory } from '../src/engine/history';
import { applyProposals, isEditTool, runProjectTool, type Proposal } from '../src/ai/projectTools';
import { useAutoEdit } from '../src/engine/autoEditSettings';
import { RECIPES } from '../src/engine/autoEdit';
import { usePrefs } from '../src/prefs';
import { parseDirection } from '../src/ai/director';

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
ok(g.transitions.some((t: any) => t.id === 'tr-crossfade' && typeof t.strength === 'number' && t.on), '轉場附強度');
ok(g.accents.some((a: any) => a.id === 'combo:x' && a.type === 'hit' && a.on), '我的組合列在點綴裡');
ok(g.accents.some((a: any) => a.id === 'fx-chromakey' && !a.on), '工具型特效預設關');

// 提議：風格 + 數字覆寫 + 只用某分類的轉場 + 關掉 combo
const list: Proposal[] = [];
const r = run('set_auto_edit', { style: 'hype', beats_per_shot: { high: 2 }, transitions: { only: ['category:basic'] }, accents: { disable: ['combos'] }, drop_hit: 'none' }, list);
ok(r.ok && list.length === 1 && list[0].op.op === 'auto_edit', `提議成功：${r.proposed}`);
ok(useAutoEdit.getState().recipe === 'rhythm', '按套用前不會改');
applyProposals(list);
const st = useAutoEdit.getState();
ok(st.recipe === 'custom' && st.params.beatsPerShot[2] === 2 && st.params.beatsPerShot[0] === RECIPES.hype.beatsPerShot[0], '風格先套預設、再覆寫數字 → 自訂');
const after = run('get_auto_edit', {});
ok(after.transitions.filter((t: any) => t.on).every((t: any) => t.cat === 'basic') && after.transitions.some((t: any) => t.on), '只留基本類轉場');
ok(st.fxOff.includes('combo:x') && st.dropHit === null, '關掉組合、drop 強調關掉');

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

if (fails) {
  console.log(`\n${fails} 個失敗`);
  process.exit(1);
}
