/**
 * 框選的範圍限制：框框不能拉出所在的面板（分頁）。
 * 按下時記住面板的位置，之後滑鼠座標都夾在這個範圍內。
 * box 沒給的話用 el 最近的 .panel-host（停靠面板），找不到就用 el 自己。
 */
export function marqueeClamp(el: Element, box?: Element | null) {
  const host = box ?? el.closest('.panel-host') ?? el;
  const r = host.getBoundingClientRect();
  return (x: number, y: number): [number, number] => [
    Math.min(r.right - 1, Math.max(r.left, x)),
    Math.min(r.bottom - 1, Math.max(r.top, y)),
  ];
}
