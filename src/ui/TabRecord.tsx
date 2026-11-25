/**
 * 錄製分頁：素材分頁工具列的按鈕（錄製中顯示秒數，再按一次停止），
 * 停止後跳出選範圍的視窗（跟自動剪輯加影片同一個），選好的每一段各存成一個素材。
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ScreenShare, Square } from 'lucide-react';
import { $t } from '../i18n';
import { uid, type Media } from '../store';
import { addMediaBlob } from '../engine/media';
import { canRecordTab, recordingMp4, startTabRecording, stopTabRecording, useTabRec, type Recording } from '../engine/tabRecord';
import { tc } from '../engine/rulerTicks';
import { dropScrub } from '../engine/scrubCache';
import { setBusy, toast } from './uiStore';
import { RangePicker, isFullCrop, type Crop } from './RangePicker';

const start = () => startTabRecording().catch((e) => {
  console.warn(e);
  toast($t('無法錄製分頁'), 'error');
});

/** 工具列按鈕 */
export function TabRecButton() {
  const phase = useTabRec((s) => s.phase);
  const since = useTabRec((s) => s.since);
  const [, tick] = useState(0);
  useEffect(() => {
    if (phase !== 'recording') return;
    const id = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(id);
  }, [phase]);
  if (!canRecordTab()) return null;
  if (phase === 'recording') {
    const s = Math.floor((performance.now() - since) / 1000);
    return (
      <button className="lib-add lib-rec on" title={$t('停止錄製')} onClick={stopTabRecording}>
        <Square size={11} fill="currentColor" /> {Math.floor(s / 60)}:{String(s % 60).padStart(2, '0')}
      </button>
    );
  }
  return (
    <button className="lib-add" title={$t('錄製分頁')} disabled={phase !== 'idle'} onClick={() => void start()}>
      <ScreenShare size={14} />
    </button>
  );
}

const stamp = () => {
  const d = new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((x) => String(x).padStart(2, '0')).join('-');
};

/** 錄完的選範圍視窗（放在 App，面板關著也會出現） */
export function TabRecHost() {
  const done = useTabRec((s) => s.done);
  const [view, setView] = useState<{ rec: Recording; full: Blob; m: Media } | null>(null);
  const [ranges, setRanges] = useState<{ a: number; b: number; crop?: Crop }[]>([]);
  // 「加入」是先 commit 再馬上 close：close 要看到剛加的那段，不能等 state 更新
  const picked = useRef<{ a: number; b: number; crop?: Crop }[]>([]);

  useEffect(() => {
    if (!done) return;
    // 先拿走（清掉 done 會讓這個 effect 再跑一次，但那次 done 是 null，不會打斷這裡）
    useTabRec.setState({ done: null });
    setBusy($t('處理錄影…'));
    recordingMp4(done).then((full) => {
      const name = `${$t('分頁錄影')} ${stamp()}`;
      const m: Media = { id: 'tabrec-' + uid(), name, kind: 'video', url: URL.createObjectURL(full), width: done.w, height: done.h, duration: done.duration, thumb: '', hasAudio: !!done.audio };
      picked.current = [];
      setRanges([]);
      setView({ rec: done, full, m });
    }).catch((e) => {
      console.warn(e);
      toast($t('無法錄製分頁'), 'error');
    }).finally(() => setBusy(null));
  }, [done]);

  if (!view) return null;
  const close = async () => {
    const { rec, full, m } = view;
    setView(null);
    const list = picked.current;
    let n = 0;
    try {
      for (let i = 0; i < list.length; i++) {
        const { a, b } = list[i];
        const crop = isFullCrop(list[i].crop) ? undefined : list[i].crop;
        const whole = a <= 0.02 && b >= rec.duration - 0.02 && !crop;
        const label = list.length > 1 ? $t('處理錄影 {0}/{1}', i + 1, list.length) : $t('處理錄影…');
        setBusy(label);
        const blob = whole ? full : await recordingMp4(rec, a, b, (f) => setBusy(`${label} ${Math.round(f * 100)}%`), crop);
        const name = list.length > 1 ? `${m.name} (${tc(a).replace(/:/g, '-')})` : m.name;
        if (await addMediaBlob(blob, name + '.mp4')) n++;
      }
    } catch (e) {
      console.warn(e);
      toast($t('無法錄製分頁'), 'error');
    } finally {
      setBusy(null);
      dropScrub(m.id);
      URL.revokeObjectURL(m.url);
    }
    if (n) toast($t('已匯入 {0} 個檔案', n));
  };
  return createPortal(
    <RangePicker
      key={view.m.id}
      m={view.m}
      init={{ a: 0, b: view.m.duration }}
      others={ranges}
      outsideClose={false}
      crop
      onCommit={(a, b, crop) => {
        if (picked.current.some((x) => x.a === a && x.b === b && JSON.stringify(x.crop) === JSON.stringify(crop))) return;
        picked.current = [...picked.current, { a, b, crop }];
        setRanges(picked.current);
      }}
      onClose={() => void close()}
    />,
    document.body,
  );
}
