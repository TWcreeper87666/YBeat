import { $t, displayName } from '../i18n';
import type React from 'react';
import { useStore, mediaUsable, spansOf, type TrackKind } from '../store';
import { parseDuration } from '../engine/params';
import { addMediaBlob, colorMedia } from '../engine/media';
import { fitInGap, fitStart } from '../engine/overlap';
import { stillDur } from '../prefs';
import { applyMediaBatch, planMediaBatch } from '../engine/mediaBatch';
import { TEXT_PRESETS } from '../engine/text';
import { setClipMask, setEffectMask } from './MaskPanel';
import { confirmDialog, revealSelection, toast, useDrag, useSnapLine, type DragPayload, type DragState, type DropTarget } from './uiStore';

const SNAP_PX = 10;

function elementsAt(x: number, y: number) {
  return document.elementsFromPoint(x, y) as HTMLElement[];
}

function laneDuration(payload: DragPayload): { dur: number; label: string; accepts: (k: TrackKind) => boolean } | null {
  const s = useStore.getState();
  if (payload.kind === 'media') {
    const m = s.media.find((x) => x.id === payload.id);
    if (!mediaUsable(m)) return null;
    if (m.kind === 'audio') return { dur: m.duration, label: m.name, accepts: (k) => k === 'audio' };
    return {
      dur: m.kind === 'video' ? m.duration : stillDur(),
      label: m.name,
      accepts: (k) => k === 'video' || (k === 'audio' && m.hasAudio),
    };
  }
  if (payload.kind === 'mediaBatch') {
    const items = payload.ids.map((id) => s.media.find((m) => m.id === id)).filter(mediaUsable);
    if (!items.length) return null;
    const dur = items.reduce((n, m) => n + (m.kind === 'image' ? stillDur() : m.duration), 0);
    return { dur, label: $t('{0} 個素材', items.length), accepts: (k) => items.some((m) => (m.kind === 'audio' ? 'audio' : 'video') === k) };
  }
  if (payload.kind === 'module' && payload.moduleKind === 'effect') {
    const m = s.modules.find((x) => x.id === payload.id);
    return { dur: m ? parseDuration(m.code, 0.5) : 0.5, label: m ? displayName(m.name) : '', accepts: (k) => k === 'fx' };
  }
  if (payload.kind === 'color') return { dur: stillDur(), label: payload.color, accepts: (k) => k === 'video' };
  if (payload.kind === 'text') {
    const p = TEXT_PRESETS.find((x) => x.id === payload.preset);
    return { dur: stillDur(), label: p?.name ?? '', accepts: (k) => k === 'video' };
  }
  if (payload.kind === 'files') return { dur: stillDur(), label: $t('{0} 個檔案', payload.count), accepts: (k) => k !== 'fx' };
  return null;
}

/** 這個拖曳內容可以放在哪種軌道（給時間軸顯示可放 / 不可放） */
export function laneAccepts(payload: DragPayload, kind: TrackKind): boolean {
  if (payload.kind === 'module' && payload.moduleKind !== 'effect') return false;
  return laneDuration(payload)?.accepts(kind) ?? false;
}

/** 依滑鼠位置計算放置目標 */
export function computeTarget(payload: DragPayload, x: number, y: number): DropTarget {
  const els = elementsAt(x, y);
  const s = useStore.getState();
  const clipEl = els.find((e) => e.dataset.key?.startsWith('clip:'));
  const clip = clipEl ? s.clips.find((c) => c.id === clipEl.dataset.key!.slice(5)) : undefined;

  // 拖到「屬性」面板：套用到目前選取的項目（特效 → 片段特效 / 取代特效軌上的特效；轉場 → 進場；變速 → 時間重映射）
  const insp = els.find((e) => e.classList?.contains('panel-inspector'));
  document.querySelector('.panel-inspector')?.classList.toggle('drop-here', false);
  // 遮罩形狀：片段 → 加片段遮罩；特效 → 換遮罩形狀（拖到屬性面板 = 套用到選取的項目）
  if (payload.kind === 'mask') {
    if (insp) {
      const sel = s.selection;
      const t: DropTarget = sel?.type === 'clip' && s.clips.some((c) => c.id === sel.id) ? { kind: 'clip', clipId: sel.id, action: 'mask', valid: true } : sel?.type === 'effect' ? { kind: 'effect', fxId: sel.id } : null;
      insp.classList.toggle('drop-here', !!t);
      return t;
    }
    const fxEl = els.find((e) => e.dataset.key?.startsWith('effect:'));
    if (fxEl) return { kind: 'effect', fxId: fxEl.dataset.key!.slice(7) };
    if (clip) return { kind: 'clip', clipId: clip.id, action: 'mask', valid: true };
    return null;
  }
  if (insp && payload.kind === 'module') {
    const sel = s.selection;
    let t: DropTarget = null;
    if (sel?.type === 'clip' && s.clips.some((c) => c.id === sel.id)) {
      const c = s.clips.find((x) => x.id === sel.id)!;
      const m = s.media.find((x) => x.id === c.mediaId);
      const action = payload.moduleKind === 'effect' ? 'effect' : payload.moduleKind === 'transition' ? 'transition' : 'remap';
      t = { kind: 'clip', clipId: c.id, action, valid: action !== 'remap' || m?.kind === 'video' };
    } else if (sel?.type === 'effect' && payload.moduleKind === 'effect') t = { kind: 'effect', fxId: sel.id };
    insp.classList.toggle('drop-here', !!t);
    return t;
  }

  // 特效拖到時間軸上的特效片段 → 取代
  if (payload.kind === 'module' && payload.moduleKind === 'effect') {
    const fxEl = els.find((e) => e.dataset.key?.startsWith('effect:'));
    const fx = fxEl ? s.effects.find((f) => f.id === fxEl.dataset.key!.slice(7)) : undefined;
    if (fx) return { kind: 'effect', fxId: fx.id };
    // 拖到影片 / 文字片段上：變成這個片段的片段特效
    if (clip) return { kind: 'clip', clipId: clip.id, action: 'effect', valid: true };
  }

  // 片段上的放置：轉場 / 變速 / 重新連結遺失素材
  if (payload.kind === 'module' && payload.moduleKind !== 'effect') {
    if (!clip) return null;
    if (payload.moduleKind === 'transition') {
      // 放在片段後段、而且後面沒有緊貼的片段 → 轉出（轉到透明）；其他 → 進場（前面沒片段就從透明轉入）
      const next = s.clips.find((c) => c.track === clip.track && c.id !== clip.id && Math.abs(clip.start + clip.duration - c.start) < 0.01);
      const r = clipEl!.getBoundingClientRect();
      if (!next && (x - r.left) / r.width > 0.6) return { kind: 'clip', clipId: clip.id, action: 'transitionOut', valid: true };
      return { kind: 'clip', clipId: clip.id, action: 'transition', valid: true };
    }
    const m = s.media.find((x) => x.id === clip.mediaId);
    return { kind: 'clip', clipId: clip.id, action: 'remap', valid: m?.kind === 'video' };
  }
  if (clip && (payload.kind === 'media' || payload.kind === 'files')) {
    const old = s.media.find((x) => x.id === clip.mediaId);
    if (!mediaUsable(old)) {
      let valid = true;
      if (payload.kind === 'media') {
        const nm = s.media.find((x) => x.id === payload.id);
        valid = mediaUsable(nm) && nm.kind !== 'audio';
      }
      return { kind: 'clip', clipId: clip.id, action: 'relink', valid };
    }
  }
  // 圖片 / 影片 / 色板拖到時間軸上的影片或圖片片段 → 直接取代這個片段的素材（文字片段、音訊素材不算）
  if (clip && !clip.text && (payload.kind === 'media' || payload.kind === 'color' || payload.kind === 'files')) {
    const nm = payload.kind === 'media' ? s.media.find((x) => x.id === payload.id) : undefined;
    if (payload.kind !== 'media' || (mediaUsable(nm) && nm.kind !== 'audio')) return { kind: 'clip', clipId: clip.id, action: 'replace', valid: true };
  }

  const laneEl = els.find((e) => e.dataset.laneKind);
  if (!laneEl) {
    useSnapLine.setState({ t: null });
    return null;
  }
  const lane = laneEl.dataset.laneKind as TrackKind;
  const idx = Number(laneEl.dataset.laneIdx);
  if (s.tracks[lane][idx]?.locked) return null;
  const info = laneDuration(payload);
  if (!info || !info.accepts(lane)) return null;

  // 時間：游標位置，吸附到同軌片段的頭尾
  const pps = s.pps;
  let time = Math.max(0, (x - laneEl.getBoundingClientRect().left) / pps);
  if (payload.kind === 'mediaBatch') {
    const items = planMediaBatch(payload.ids, time, { kind: lane, track: idx });
    if (!items?.length) return null;
    return { kind: 'lane', lane, idx, time: items[0].start, duration: info.dur, label: info.label, items };
  }
  const list = lane === 'video' ? s.clips : lane === 'fx' ? s.effects : s.audios;
  const pts = [0, s.time];
  for (const it of list) if (it.track === idx) pts.push(it.start, it.start + it.duration, it.start - info.dur);
  let best = SNAP_PX / pps;
  let snapped: number | null = null;
  for (const p of pts) {
    if (p >= 0 && Math.abs(p - time) < best) { best = Math.abs(p - time); time = p; snapped = p; }
  }
  if (!s.snap) snapped = null;
  useSnapLine.setState({ t: snapped });
  // 同一軌不能重疊：放到最近的空位；圖片 / 色板 / 文字放進空隙時縮短到剛好填滿
  const flexible = payload.kind === 'color' || payload.kind === 'text' || (payload.kind === 'media' && s.media.find((m) => m.id === payload.id)?.kind === 'image');
  const fit = flexible ? fitInGap(spansOf(s), `${lane}:${idx}`, time, info.dur) : { start: fitStart(spansOf(s), `${lane}:${idx}`, time, info.dur), duration: info.dur };
  return { kind: 'lane', lane, idx, time: fit.start, duration: fit.duration, label: info.label };
}

/** 執行放置 */
export async function applyDrop(payload: DragPayload, target: DropTarget, files?: File[]) {
  const s = useStore.getState();
  if (!target) {
    if (files) await importMany(files);
    return;
  }
  if (payload.kind === 'mediaBatch') {
    if (target.kind !== 'lane') return;
    const plan = target.items ?? planMediaBatch(payload.ids, target.time, { kind: target.lane, track: target.idx });
    if (plan?.length && applyMediaBatch(plan)) revealSelection();
    return;
  }
  if (payload.kind === 'mask') {
    if (target.kind === 'effect') {
      setEffectMask(target.fxId, payload.shape);
      toast($t('已設定特效的遮罩形狀'));
    } else if (target.kind === 'clip') setClipMask(target.clipId, payload.shape);
    return;
  }
  if (target.kind === 'effect') {
    const fx = s.effects.find((f) => f.id === target.fxId);
    if (!fx || payload.kind !== 'module' || fx.moduleId === payload.id) return;
    const hasKeys = Object.entries(fx.keys ?? {}).some(([k, l]) => !k.startsWith('mask.') && l.length);
    if (hasKeys) {
      const ok = await confirmDialog({
        title: $t('取代特效？'),
        message: $t('這個特效有設定關鍵影格，換成新的特效後，參數與關鍵影格都會被清除（遮罩會保留）。'),
        ok: $t('取代'),
        danger: true,
      });
      if (!ok) return;
    }
    useStore.getState().replaceEffect(fx.id, payload.id);
    return;
  }
  if (target.kind === 'clip') {
    if (!target.valid) return toast($t('這裡不能放'), 'error');
    const clip = s.clips.find((c) => c.id === target.clipId);
    if (!clip) return;
    if (payload.kind === 'module') {
      if (target.action === 'effect') {
        s.addClipFx(clip.id, payload.id);
        toast($t('已加到片段特效'));
        return;
      }
      if (target.action === 'transition') s.setTransition(clip.id, payload.id, 'in');
      else if (target.action === 'transitionOut') s.setTransition(clip.id, payload.id, 'out');
      else s.setRemap(clip.id, payload.id);
      return;
    }
    let newId: string | null = null;
    if (payload.kind === 'media') newId = payload.id;
    else if (payload.kind === 'color') newId = (await colorMedia(payload.color))?.id ?? null;
    else if (files?.length) newId = (await addMediaBlob(files[0], files[0].name))?.id ?? null;
    if (!newId) return;
    // 取代：只換這一個片段
    if (target.action === 'replace') {
      if (useStore.getState().replaceClipMedia(clip.id, newId)) toast($t('已取代片段的素材'));
      else toast($t('這裡不能放'), 'error');
      return;
    }
    // 重新連結（素材遺失）
    const old = s.media.find((m) => m.id === clip.mediaId);
    useStore.getState().relinkMedia(clip.mediaId, newId);
    toast($t('已重新連結{0}', old ? $t('「{0}」', old.name) : ''));
    return;
  }
  // 軌道
  const place = (mediaId: string, time: number) => {
    const st = useStore.getState();
    const m = st.media.find((x) => x.id === mediaId);
    if (!mediaUsable(m)) return 0;
    if (target.lane === 'audio' || m.kind === 'audio') st.addAudio(mediaId, time, target.lane === 'audio' ? target.idx : 0);
    // 圖片：用放置目標算好的長度（放進空隙時已經縮短）
    else st.addClip(mediaId, time, target.lane === 'video' ? target.idx : 0, m.kind === 'image' && !files ? { in: 0, duration: target.duration } : undefined);
    const after = useStore.getState();
    const sel = after.selection;
    const it = sel && [...after.clips, ...after.audios].find((x) => x.id === sel.id);
    return it ? it.duration : 0;
  };
  if (payload.kind === 'media') place(payload.id, target.time);
  else if (payload.kind === 'module') s.addEffect(payload.id, target.time, target.idx);
  else if (payload.kind === 'text') s.addText(payload.preset, target.time, target.idx, target.duration);
  else if (payload.kind === 'color') {
    const m = await colorMedia(payload.color);
    if (m) place(m.id, target.time);
  }
  else if (files) {
    let t = target.time;
    for (const f of files) {
      const m = await addMediaBlob(f, f.name).catch(() => null);
      if (m) t += place(m.id, t);
    }
  }
}

async function importMany(files: File[]) {
  let n = 0;
  for (const f of files) if (await addMediaBlob(f, f.name).catch(() => null)) n++;
  if (n) toast($t('已匯入 {0} 個檔案', n));
  else toast($t('無法匯入這些檔案'), 'error');
}

/** 素材庫項目：按下後拖超過 4px 才開始拖曳；回傳 true 代表變成拖曳（外部應取消 click） */
export function startLibraryDrag(e: React.PointerEvent, payload: DragPayload, label: string, thumb?: string) {
  if (e.button !== 0) return;
  const x0 = e.clientX, y0 = e.clientY;
  let started = false;
  // 沒給縮圖：用項目本身的縮圖（模組 / 文字樣式）
  if (!thumb) {
    const bg = (e.currentTarget as HTMLElement).querySelector<HTMLElement>('.lib-thumb');
    const m = bg && /url\("?(.*?)"?\)/.exec(getComputedStyle(bg).backgroundImage);
    if (m) thumb = m[1];
  }
  const move = (ev: PointerEvent) => {
    if (!started && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return;
    started = true;
    const target = computeTarget(payload, ev.clientX, ev.clientY);
    document.body.classList.toggle('drag-ok', !!target);
    document.body.classList.toggle('drag-no', !target);
    useDrag.setState({ drag: { payload, label, thumb, x: ev.clientX, y: ev.clientY, target } as DragState });
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('keydown', esc);
    const d = useDrag.getState().drag;
    useDrag.setState({ drag: null });
    useSnapLine.setState({ t: null });
    document.body.classList.remove('drag-ok', 'drag-no');
    document.querySelector('.panel-inspector')?.classList.remove('drop-here');
    if (started && d) {
      suppressClick();
      applyDrop(payload, d.target);
    }
  };
  const esc = (ev: KeyboardEvent) => {
    if (ev.key !== 'Escape') return;
    started = false;
    useDrag.setState({ drag: null });
    up();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('keydown', esc);
}

/** 拖曳結束後吞掉緊接著的 click，避免誤觸 */
function suppressClick() {
  const stop = (e: Event) => {
    e.stopPropagation();
    e.preventDefault();
  };
  window.addEventListener('click', stop, { capture: true, once: true });
  setTimeout(() => window.removeEventListener('click', stop, { capture: true }), 50);
}

/** 從作業系統拖檔案進來：任何地方都能放，時間軸上會顯示位置 */
export function installFileDrop() {
  let depth = 0;
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    depth++;
  });
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (!hasFiles(e)) return;
    e.dataTransfer!.dropEffect = 'copy';
    const payload: DragPayload = { kind: 'files', count: e.dataTransfer!.items.length };
    useDrag.setState({ drag: { payload, label: $t('匯入 {0} 個檔案', payload.count), x: e.clientX, y: e.clientY, target: computeTarget(payload, e.clientX, e.clientY) } });
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    if (--depth <= 0) {
      depth = 0;
      useDrag.setState({ drag: null });
    }
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    const d = useDrag.getState().drag;
    useDrag.setState({ drag: null });
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (!files.length) return;
    applyDrop({ kind: 'files', count: files.length }, d?.target ?? null, files);
  });
}
