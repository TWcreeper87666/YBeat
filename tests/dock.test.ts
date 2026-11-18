import { C, R, T, findGroup, movePanel, panelsIn, showPanel, removePanel, type DockNode, type PanelId } from '../src/ui/dockTree';

let fails = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) fails++;
};
const LIB: PanelId[] = ['media', 'transition', 'effect', 'remap'];
const edit = () => C([R([T(LIB), T(['inspector']), T(['preview'])], [0.27, 0.33, 0.4]), T(['timeline'])], [0.6, 0.4]);
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

console.log(fails ? `\n${fails} 項失敗` : '\n全部通過');
process.exit(fails ? 1 : 0);
