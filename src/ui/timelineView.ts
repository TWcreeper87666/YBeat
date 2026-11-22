/**
 * 時間軸的檢視狀態（縮放、捲動位置、播放頭）存在這個瀏覽器：重新整理（F5）、或時間軸面板重新打開時回到原本的地方。
 * 不進專案檔（只是怎麼看，不是內容）。
 */
import { useStore } from '../store';
import { PPS_MAX, PPS_MIN } from '../engine/rulerTicks';

const KEY = 'ybeat-timeline-view';
interface View { pps: number; time: number; sl: number; st: number }

let cur: View | null = (() => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<View> | null;
    if (!v || ![v.pps, v.time, v.sl, v.st].every((x) => typeof x === 'number' && isFinite(x))) return null;
    return v as View;
  } catch {
    return null;
  }
})();

let timer = 0;
function write() {
  clearTimeout(timer);
  timer = 0;
  try {
    if (cur) localStorage.setItem(KEY, JSON.stringify(cur));
  } catch {
    /* 存不了就算了 */
  }
}
const writeSoon = () => {
  if (!timer) timer = window.setTimeout(write, 300);
};

/** 開啟時（畫面出來之前）：縮放、播放頭回到上次的位置 */
export function restoreTimelineView() {
  if (!cur) return;
  useStore.setState({ pps: Math.min(PPS_MAX, Math.max(PPS_MIN, cur.pps)), time: Math.max(0, cur.time) });
}

/** 時間軸面板：記下捲動位置；回傳上次的捲動位置（沒有 = null） */
export function savedScroll(): { sl: number; st: number } | null {
  return cur ? { sl: cur.sl, st: cur.st } : null;
}

export function rememberScroll(sl: number, st: number) {
  const s = useStore.getState();
  cur = { pps: s.pps, time: s.time, sl, st };
  writeSoon();
}

// 縮放、播放頭一變就記下來（捲動位置由時間軸面板自己記）
useStore.subscribe((s, p) => {
  if (s.pps === p.pps && s.time === p.time) return;
  cur = { pps: s.pps, time: s.time, sl: cur?.sl ?? 0, st: cur?.st ?? 0 };
  writeSoon();
});
// 關掉 / 重新整理前把還沒寫的寫進去
window.addEventListener('pagehide', write);
