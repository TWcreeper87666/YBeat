/**
 * 修正去背的視窗（片段 / 動畫的圖片位置共用）：在 AI 遮罩上補上 / 擦掉（筆刷、套索）。
 * 去背掉的部分用紅色蓋著；修正存成素材 0~1 座標，影片 / 動態圖片每一格都套用。
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Brush, Lasso, Redo2, Undo2, X } from 'lucide-react';
import { $t } from '../i18n';
import { useStore, type Media } from '../store';
import { ensureMatte, matteAt, MATTE_SIZE, useMatte } from '../engine/matte';
import { animImage, frameIndexAt } from '../engine/animImage';
import { clipSource } from '../engine/remap';
import { EDIT_SIZE, editedMatte, editFor, type CutoutFix, type Pt } from '../engine/cutoutEdit';
import { patchAnimSlot } from '../engine/animPlace';
import { DragNumber } from './DragNumber';
import { Seg } from './Toggle';
import { confirmDialog } from './uiStore';
import { isTextField } from './focus';
import { dragPan } from './middlePan';
import { useLocalView, useWheelZoom, ZoomBadge } from './zoomView';

const S = EDIT_SIZE;
/** 右邊畫面區塊的留白（跟預覽一樣） */
const PAD = 14;
const round = (v: number) => Math.round(v * 10000) / 10000;

/** 動畫的圖片位置 */
export function SlotCutoutEditor({ animId, slotId, onClose }: { animId: string; slotId: string; onClose: () => void }) {
  const slot = useStore((s) => s.anims.find((a) => a.id === animId)?.slots.find((x) => x.id === slotId));
  const media = useStore((s) => s.media.find((m) => m.id === slot?.mediaId));
  if (!slot || !media) return null;
  const commit = (fix: CutoutFix[]) => {
    const cur = useStore.getState().anims.find((a) => a.id === animId)?.slots.find((x) => x.id === slotId);
    if (cur) patchAnimSlot(animId, slotId, { cutout: { ...cur.cutout, mode: 'auto', edit: fix.length ? { mediaId: media.id, fix } : undefined } });
  };
  return <CutoutEditor media={media} time={media.kind === 'image' ? 0 : +slot.sourceTime.toFixed(4)}
    init={editFor(slot.mediaId, slot.cutout?.edit)?.fix ?? []} onCommit={commit} onClose={onClose} />;
}

/** 時間軸上的片段（顯示播放頭那一格；修正套在每一格） */
export function ClipCutoutEditor({ clipId, onClose }: { clipId: string; onClose: () => void }) {
  const clip = useStore((s) => s.clips.find((c) => c.id === clipId));
  const media = useStore((s) => s.media.find((m) => m.id === clip?.mediaId));
  const [time] = useState(() => {
    const s = useStore.getState();
    if (!clip || !media) return 0;
    const local = Math.min(clip.duration, Math.max(0, s.time - clip.start));
    return media.kind === 'image' ? local : +clipSource(clip, local, media, new Map(s.modules.map((m) => [m.id, m]))).src.toFixed(4);
  });
  if (!clip || !media) return null;
  const commit = (fix: CutoutFix[]) => useStore.getState().updateClip(clip.id, { matteEdit: fix.length ? { mediaId: media.id, fix } : undefined });
  return <CutoutEditor media={media} time={time} init={editFor(clip.mediaId, clip.matteEdit)?.fix ?? []} onCommit={commit} onClose={onClose} />;
}

/** 素材在 time 的那一格（影片 / 圖片 / 動態圖片） */
function Frame({ media, time }: { media: Media; time: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const anim = media.kind === 'image' ? animImage(media) : null;
  useEffect(() => {
    if (!anim || !ref.current) return;
    const img = anim.frames[frameIndexAt(anim.starts, anim.total, time)];
    const c = ref.current;
    c.width = img.width;
    c.height = img.height;
    c.getContext('2d')!.drawImage(img, 0, 0);
  }, [anim, time]);
  if (anim) return <canvas ref={ref} className="cut-frame" />;
  if (media.kind === 'video') return <video src={media.url} muted playsInline preload="auto" onLoadedMetadata={(e) => { e.currentTarget.currentTime = time; }} />;
  return <img src={media.url} alt="" draggable={false} />;
}

function CutoutEditor({ media, time, init, onCommit, onClose }: { media: Media; time: number; init: CutoutFix[]; onCommit: (fix: CutoutFix[]) => void; onClose: () => void }) {
  const [fix, setFixState] = useState<CutoutFix[]>(init);
  const [undo, setUndo] = useState<CutoutFix[][]>([]);
  const [redo, setRedo] = useState<CutoutFix[][]>([]);
  const [op, setOp] = useState<'add' | 'erase'>('add');
  const [tool, setTool] = useState<'brush' | 'lasso'>('brush');
  const [brush, setBrush] = useState(0.04);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [lasso, setLasso] = useState<{ op: CutoutFix['op']; pts: Pt[] } | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const space = useRef(false);
  const { view, get: getView, setView, reset: resetView } = useLocalView();
  // 滾輪縮放；Shift + 滾輪 = 筆刷大小（Shift 時有些瀏覽器把滾動放在 deltaX）
  useWheelZoom(wrap, getView, setView, { min: 0.25, max: 16, origin: 'center', intercept: (e) => {
    if (!e.shiftKey) return false;
    const d = e.deltaY || e.deltaX;
    setBrush((b) => Math.min(0.3, Math.max(0.005, b * Math.pow(1.0015, -d))));
    return true;
  } });
  /** 平移：中鍵、或按住空白鍵拖曳 */
  const panCapture = (e: React.PointerEvent) => {
    if (e.button !== 1 && !(e.button === 0 && space.current)) return;
    const v0 = getView();
    dragPan(e, (dx, dy) => setView({ ...v0, px: v0.px + dx, py: v0.py + dy }));
  };
  const overlay = useRef<HTMLCanvasElement>(null);
  const fixRef = useRef(fix);
  fixRef.current = fix;
  const aspect = (media.width || 1) / (media.height || 1);
  useMatte((s) => s.ver); // AI 遮罩算好時重畫
  const ai = matteAt(media, time);
  useEffect(() => { if (!ai) void ensureMatte(media, [media.kind === 'image' ? 0 : time]); }, [media, time, !ai]); // eslint-disable-line react-hooks/exhaustive-deps

  const setFix = (next: CutoutFix[]) => { fixRef.current = next; setFixState(next); };
  const remember = () => { setUndo((u) => [...u.slice(-49), fixRef.current]); setRedo([]); };

  // 去背掉的地方蓋紅色
  useEffect(() => {
    const c = overlay.current;
    if (!c) return;
    const g = c.getContext('2d')!;
    if (!ai) return g.clearRect(0, 0, S, S);
    const data = editedMatte({ data: ai.data, size: MATTE_SIZE }, fix, aspect);
    const img = g.createImageData(S, S);
    for (let i = 0; i < data.length; i++) {
      img.data[i * 4] = 255; img.data[i * 4 + 1] = 40; img.data[i * 4 + 2] = 70;
      img.data[i * 4 + 3] = (255 - data[i]) * 0.6;
    }
    g.putImageData(img, 0, 0);
  }, [ai, fix, aspect]);

  // 「符合視窗」時畫面的大小：放得進右邊的區塊、比例跟素材一樣（跟預覽一樣）
  const [box, setBox] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const upd = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    upd();
    const ro = new ResizeObserver(upd);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const availW = Math.max(1, box.w - PAD * 2), availH = Math.max(1, box.h - PAD * 2);
  const W = Math.min(availW, availH * aspect), H = W / aspect;
  const norm = (e: { clientX: number; clientY: number }): Pt => {
    const r = stage.current!.getBoundingClientRect();
    return [round(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))), round(Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)))];
  };

  /** 在畫面上畫：筆刷 = 邊拖邊塗；套索 = 圍起來的區域，放開時套用。Alt = 反過來（補上 ↔ 擦掉） */
  const draw = (e: React.PointerEvent) => {
    if (e.button !== 0 || !ai) return;
    e.preventDefault();
    const o: CutoutFix['op'] = e.altKey ? (op === 'add' ? 'erase' : 'add') : op;
    const pts: Pt[] = [norm(e)];
    const before = fixRef.current;
    remember();
    const push = () => (tool === 'brush' ? setFix([...before, { op: o, pts: [...pts], brush }]) : setLasso({ op: o, pts: [...pts] }));
    push();
    const move = (ev: PointerEvent) => {
      const p = norm(ev);
      const last = pts[pts.length - 1];
      if (Math.hypot((p[0] - last[0]) * aspect, p[1] - last[1]) < 0.003) return;
      pts.push(p);
      push();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (tool !== 'lasso') return;
      setLasso(null);
      if (pts.length > 2) setFix([...before, { op: o, pts }]);
      else setUndo((u) => u.slice(0, -1));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const step = (from: CutoutFix[][], setFrom: typeof setUndo, setTo: typeof setUndo) => {
    const prev = from[from.length - 1];
    if (!prev) return;
    setTo((r) => [...r, fixRef.current]);
    setFrom((u) => u.slice(0, -1));
    setFix(prev);
  };
  const doUndo = () => step(undo, setUndo, setRedo);
  const doRedo = () => step(redo, setRedo, setUndo);
  const clearAll = () => { remember(); setFix([]); };
  /** 跟打開時比有沒有改（畫了又復原回去 = 沒改） */
  const changed = () => JSON.stringify(fixRef.current) !== JSON.stringify(init);
  /** 完成：沒改就直接關掉（不留一步復原紀錄） */
  const ok = () => { if (changed()) onCommit(fixRef.current); onClose(); };
  /** 取消：有變更時先確認 */
  const cancel = async () => {
    if (changed()
      && !(await confirmDialog({ title: $t('捨棄變更？'), message: $t('修正還沒套用。'), ok: $t('捨棄'), danger: true }))) return;
    onClose();
  };

  // 鍵盤（跟編輯視窗一樣）：Esc 取消、Ctrl+Enter 完成；Ctrl+Z / Ctrl+Y 復原重做、[ ] 調筆刷大小
  const keys = useRef({ doUndo, doRedo, ok, cancel });
  keys.current = { doUndo, doRedo, ok, cancel };
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      // 確認視窗開著時讓給它
      if (document.querySelector('.overlay .dialog')) return;
      const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
      if (e.key === 'Enter' && mod) keys.current.ok();
      else if (isTextField(e.target)) return;
      else if (mod && k === 'z' && !e.shiftKey) keys.current.doUndo();
      else if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) keys.current.doRedo();
      else if (e.key === 'Escape') void keys.current.cancel();
      else if (e.code === 'Space') { space.current = true; if (e.repeat) { e.preventDefault(); return; } }
      else if (e.key === '[') setBrush((b) => Math.max(0.005, b / 1.25));
      else if (e.key === ']') setBrush((b) => Math.min(0.3, b * 1.25));
      else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    const up = (e: KeyboardEvent) => { if (e.code === 'Space') space.current = false; };
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    return () => { window.removeEventListener('keydown', down, true); window.removeEventListener('keyup', up, true); };
  }, []);

  const px = (v: number) => `${v}px`;
  /** 左邊工具欄的一列（跟屬性面板一樣的排法） */
  const row = (label: string, node: React.ReactNode, title?: string) => (
    <div className="ec-row"><div className="ec-left ec-plain" title={title}><span className="ec-label">{label}</span><div className="ec-node">{node}</div></div></div>
  );
  const section = (title: string) => <div className="ec-row ec-section"><div className="ec-left"><span className="ec-sec-title">{title}</span></div></div>;
  return (
    <div className="overlay cut-overlay">
      <div className="editor-window cut-window modal-window" role="dialog" aria-label={$t('修正去背')}>
        <div className="editor-head">
          <span className="editor-title">{$t('修正去背')}</span>
          <span className="editor-name" title={media.name}>{media.name}</span>
          <span className="spacer" />
          <span className="editor-history">
            <button className="title-icon" disabled={!undo.length} title={$t('復原 (Ctrl+Z)')} onClick={doUndo}><Undo2 size={15} /></button>
            <button className="title-icon" disabled={!redo.length} title={$t('重做 (Ctrl+Shift+Z)')} onClick={doRedo}><Redo2 size={15} /></button>
          </span>
          <button className="btn primary small-h" title={$t('完成 (Ctrl+Enter)')} onClick={ok}>{$t('完成')}</button>
          <button className="title-icon" title={$t('取消 (Esc)')} onClick={() => void cancel()}><X size={16} /></button>
        </div>
        <div className="editor-body cut-body">
          <div className="editor-props">
            <div className="ec plain cut-props">
              {section($t('筆刷'))}
              {row($t('模式'), <Seg value={op} on={setOp} opts={[{ v: 'add', label: $t('補上') }, { v: 'erase', label: $t('擦掉') }]} />)}
              {row($t('工具'), <Seg value={tool} on={setTool} opts={[
                { v: 'brush', label: <Brush size={13} />, title: $t('筆刷') },
                { v: 'lasso', label: <Lasso size={13} />, title: $t('套索') },
              ]} />)}
              {tool === 'brush' && row($t('大小'),
                <DragNumber value={brush * 100} min={0.5} max={30} step={0.5} decimals={1} suffix="%" onChange={(v) => setBrush(v / 100)} />, $t('Shift + 滾輪'))}
              {section($t('修正'))}
              {row($t('全部清除'), <button className="btn small-h" disabled={!fix.length} onClick={clearAll}>{$t('清除')}</button>)}
            </div>
          </div>
          <div ref={wrap} className={`editor-preview cut-view ${tool}`}
            onPointerDownCapture={panCapture}
            onPointerMove={(e) => { const r = wrap.current!.getBoundingClientRect(); setCursor({ x: e.clientX - r.left, y: e.clientY - r.top }); }}
            onPointerLeave={() => setCursor(null)}
            onDoubleClick={(e) => e.target === e.currentTarget && resetView()}>
            <div ref={stage} className="cut-stage" onPointerDown={draw} style={{
              width: px(W * view.z), height: px(H * view.z),
              left: px((box.w - W * view.z) / 2 + view.px), top: px((box.h - H * view.z) / 2 + view.py) }}>
              <Frame media={media} time={time} />
              <canvas ref={overlay} width={S} height={S} />
              {lasso && (
                <svg viewBox="0 0 1 1" preserveAspectRatio="none">
                  <polyline className={`lasso ${lasso.op}`} points={lasso.pts.map((p) => p.join(',')).join(' ')} />
                </svg>
              )}
            </div>
            {cursor && tool === 'brush' && ai && <i className="cut-cursor" style={{ left: cursor.x, top: cursor.y, width: brush * H * view.z, height: brush * H * view.z }} />}
            {!ai && <div className="cut-wait">{$t('去背計算中')}</div>}
            <ZoomBadge z={view.z} fit onReset={resetView} title={$t('檢視縮放（滾輪縮放、中鍵或空白鍵拖曳平移；點一下回到符合視窗）')} />
          </div>
        </div>
      </div>
    </div>
  );
}
