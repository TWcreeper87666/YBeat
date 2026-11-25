import { C, R, T, PANEL_MIN, closeGroup, dissolveGroup, joinAll, neighborGroup, dragSash, minSize, findGroup, moveGroup, movePanel, panelsIn, showPanel, removePanel, type DockNode, type PanelId } from '../src/ui/dockTree';

let fails = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) fails++;
};
const LIB: PanelId[] = ['media', 'transition', 'effect', 'remap'];
const edit = () => C([R([T(LIB), T(['inspector']), T(['preview'])], [0.27, 0.33, 0.4]), T(['timeline'])], [0.6, 0.4]);
const mapActive = (l: DockNode, p: PanelId): DockNode => (l.type === 'tabs' ? (l.tabs.includes(p) ? { ...l, active: p } : l) : { ...l, children: l.children.map((c) => mapActive(c, p)) });
const groupOf = (l: DockNode | null, p: PanelId) => findGroup(l, (g) => g.tabs.includes(p))!;
const sum = (n: DockNode): boolean => n.type === 'tabs' || (Math.abs(n.sizes.reduce((a, b) => a + b, 0) - 1) < 1e-6 && n.children.every(sum));
const show = (n: DockNode | null): string => (!n ? 'null' : n.type === 'tabs' ? `[${n.tabs.join(',')}]` : `${n.dir}(${n.children.map(show).join(' | ')})`);

// 1. 預覽拖到整個版面右側：時間軸要讓出空間（預覽佔滿整個高度）
{
  const l = edit();
  const out = movePanel(l, 'preview', groupOf(l, 'preview').id, { kind: 'root', side: 'right' })!;
  console.log('   ', show(out));
  ok(out.type === 'split' && out.dir === 'row', '根節點變成左右分割');
  ok(out.type === 'split' && show(out.children[out.children.length - 1]) === '[preview]', '預覽在最右側');
  ok(out.type === 'split' && panelsIn(out.children[0]).includes('timeline'), '時間軸在左邊那一塊（不再橫跨預覽下方）');
  ok(sum(out), '比例總和 = 1');
}

// 2. 拖到群組右邊 = 分割那個群組
{
  const l = edit();
  const out = movePanel(l, 'inspector', groupOf(l, 'inspector').id, { kind: 'group', group: groupOf(l, 'timeline').id, zone: 'right' })!;
  console.log('   ', show(out));
  ok(show(out) === 'col(row([media,transition,effect,remap] | [preview]) | row([timeline] | [inspector]))', '屬性分到時間軸右邊');
  ok(sum(out), '比例總和 = 1');
}

// 3. 拖到群組中間 = 併入
{
  const l = edit();
  const out = movePanel(l, 'preview', groupOf(l, 'preview').id, { kind: 'group', group: groupOf(l, 'inspector').id, zone: 'center' })!;
  ok(groupOf(out, 'preview').tabs.join() === 'inspector,preview', '預覽併入屬性群組');
  ok(groupOf(out, 'preview').active === 'preview', '併入後變成作用中分頁');
}

// 4. 分頁列內換順序
{
  const l = edit();
  const g = groupOf(l, 'media');
  const out = movePanel(l, 'media', g.id, { kind: 'tabs', group: g.id, index: 3 })!;
  ok(groupOf(out, 'media').tabs.join() === 'transition,effect,media,remap', '素材移到第 3 個位置');
  const out2 = movePanel(l, 'remap', g.id, { kind: 'tabs', group: g.id, index: 0 })!;
  ok(groupOf(out2, 'remap').tabs.join() === 'remap,media,transition,effect', '變速移到最前面');
}

// 5. 拖到其他群組的分頁列
{
  const l = edit();
  const out = movePanel(l, 'effect', groupOf(l, 'effect').id, { kind: 'tabs', group: groupOf(l, 'timeline').id, index: 0 })!;
  ok(groupOf(out, 'effect').tabs.join() === 'effect,timeline', '特效插到時間軸群組最前面');
}

// 6. 單一分頁的群組拖到自己邊緣 → 不動
{
  const l = edit();
  const g = groupOf(l, 'preview');
  const out = movePanel(l, 'preview', g.id, { kind: 'group', group: g.id, zone: 'left' })!;
  ok(show(out) === show(l), '不變');
}

// 7. 移走後空群組會被移除、同方向巢狀分割會攤平
{
  const l = edit();
  const out = movePanel(l, 'inspector', groupOf(l, 'inspector').id, { kind: 'group', group: groupOf(l, 'preview').id, zone: 'center' })!;
  console.log('   ', show(out));
  ok(show(out) === 'col(row([media,transition,effect,remap] | [preview,inspector]) | [timeline])', '空群組移除');
  ok(sum(out), '比例總和 = 1');
  const out2 = movePanel(edit(), 'timeline', groupOf(edit(), 'timeline').id, { kind: 'root', side: 'bottom' });
  ok(!!out2 && out2.type === 'split' && out2.dir === 'col', '時間軸拖到底部：仍是上下分割');
}

// 8. 先放右邊再放回底部（來回拖不會壞掉）
{
  let l: DockNode | null = edit();
  l = movePanel(l, 'preview', groupOf(l, 'preview').id, { kind: 'root', side: 'right' });
  l = movePanel(l, 'preview', groupOf(l, 'preview').id, { kind: 'root', side: 'left' });
  l = movePanel(l, 'timeline', groupOf(l, 'timeline').id, { kind: 'root', side: 'bottom' });
  console.log('   ', show(l));
  ok(panelsIn(l).sort().join() === ['effect', 'inspector', 'media', 'preview', 'remap', 'timeline', 'transition'].join(), '面板一個都沒少');
  ok(sum(l!), '比例總和 = 1');
}

// 9. 關掉再打開
{
  const l = removePanel(edit(), 'inspector');
  ok(!panelsIn(l).includes('inspector'), '屬性已關閉');
  const back = showPanel(l, 'inspector');
  ok(panelsIn(back).includes('inspector'), '屬性重新打開');
}

// 整組移動：素材庫群組拖到時間軸右邊，分頁與作用中分頁都保留
{
  const l = mapActive(edit(), 'effect');
  const g = groupOf(l, 'media');
  const out = moveGroup(l, g.id, { kind: 'group', group: groupOf(l, 'timeline').id, zone: 'right' })!;
  console.log('   ', show(out));
  ok(groupOf(out, 'media').tabs.join() === LIB.join(), '整組分頁一起移動、順序不變');
  ok(groupOf(out, 'media').active === 'effect', '作用中分頁不變');
  ok(show(out).includes('row([timeline] | [media,transition,effect,remap])'), '放在時間軸右邊');
  ok(sum(out), '比例總和 = 1');
  const self = moveGroup(l, g.id, { kind: 'group', group: g.id, zone: 'left' });
  ok(self === l, '拖到自己身上不動');
  const merged = moveGroup(l, g.id, { kind: 'tabs', group: groupOf(l, 'inspector').id, index: 0 })!;
  ok(groupOf(merged, 'inspector').tabs.join() === [...LIB, 'inspector'].join(), '整組插入到別的分頁列');
}

// 最小尺寸：分頁組取最大值 + 分頁列；左右分割加總寬度、上下分割加總高度
{
  const g = T(['media', 'preview']);
  const m = minSize(g);
  ok(m.w === Math.max(PANEL_MIN.media.w, PANEL_MIN.preview.w) + 2 && m.h === Math.max(PANEL_MIN.media.h, PANEL_MIN.preview.h) + 31, '分頁組：取最大的那個分頁');
  const l = edit();
  const ml = minSize(l);
  const row = minSize((l as any).children[0]);
  ok(row.w === minSize(T(LIB)).w + minSize(T(['inspector'])).w + minSize(T(['preview'])).w + 8, '左右分割：寬度加總（含分隔線）');
  ok(ml.h === row.h + minSize(T(['timeline'])).h + 4 && ml.w === Math.max(row.w, minSize(T(['timeline'])).w), '上下分割：高度加總、寬度取最大');
}
// 拖分隔線：不能小於最小尺寸
{
  const total = 1000;
  const mins = [300, 300, 200];
  const a = dragSash([0.4, 0.4, 0.2], 0, -0.3, mins, total);
  ok(Math.abs(a[0] - 0.3) < 1e-9 && Math.abs(a[0] + a[1] - 0.8) < 1e-9 && a[2] === 0.2, '往左拖太多：停在左邊的最小寬度');
  const b = dragSash([0.4, 0.4, 0.2], 0, 0.3, mins, total);
  ok(Math.abs(b[1] - 0.3) < 1e-9, '往右拖太多：停在右邊的最小寬度');
  const c = dragSash([0.5, 0.5], 0, 0.1, [300, 300], 400);
  ok(Math.abs(c[0] - 0.5) < 1e-9, '兩邊都放不下：照最小尺寸的比例分');
}

// 群組右鍵：關閉、解散、合併全部
{
  const l = edit();
  const lib = groupOf(l, 'media');
  const c = closeGroup(l, lib.id)!;
  ok(!panelsIn(c).includes('media') && panelsIn(c).includes('inspector') && sum(c), '關閉群組：裡面的分頁都消失，其他不變');
  ok(neighborGroup(l, lib.id)?.tabs.includes('inspector') === true, '相鄰群組：同一列的下一格');
  ok(neighborGroup(l, groupOf(l, 'preview').id)?.tabs.includes('inspector') === true, '最後一格：找上一格');
  ok(neighborGroup(l, groupOf(l, 'timeline').id)?.tabs.includes('preview') === true, '時間軸：上一格是分割 → 取最靠近分界的群組');
  const d = dissolveGroup(l, lib.id)!;
  const ins = groupOf(d, 'inspector');
  ok(LIB.every((p) => ins.tabs.includes(p)) && ins.tabs.length === LIB.length + 1 && sum(d), '解散群組：分頁併到相鄰群組');
  ok(dissolveGroup(T(['media']), groupOf(T(['media']), 'media').id) !== null, '只有一個群組：不動');
  const j = joinAll(l, groupOf(l, 'preview').id)!;
  ok(j.type === 'tabs' && j.tabs.length === panelsIn(l).length && j.active === 'preview', '合併所有群組：一個群組、保留目前分頁');
}

console.log(fails ? `\n${fails} 項失敗` : '\n全部通過');
process.exit(fails ? 1 : 0);
