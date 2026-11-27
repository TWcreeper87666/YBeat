import { snapFrame } from '../engine/rulerTicks';
import { animDropDur, placeAnim, setAnimSlot } from '../engine/animPlace';
import { stopLibraryPreview } from './SourcePanel';
import { $t, displayName } from '../i18n';
import type React from 'react';
import { TR_BLOCK_DUR, attachedAudioIds, comboClipFx, keyOf, useStore, mediaUsable, parseKey, spansOf, type Clip, type FxItem, type PlacementGhost, type TimelineDropMode, type TrackKind } from '../store';
import { beginHistoryTransaction, endHistoryTransaction } from '../engine/history';
import { showPendingPlacement } from './Timeline';
import { parseDuration } from '../engine/params';
import { addMediaBlob, addMediaFiles, colorMedia } from '../engine/media';
import { fitInGap, fitStart } from '../engine/overlap';
import { laneSnapPoints } from '../engine/snap';
import { fxCombo, stillDur, userTextStyle } from '../prefs';
import { applyMediaBatch, planMediaBatch } from '../engine/mediaBatch';
import { TEXT_PRESETS } from '../engine/text';
import { moveKey } from './sortKeys';
import { setClipMask, setEffectMask } from './MaskPanel';
import { dropSong, dropToAutoEdit } from './AeSegments';
import { songMedia } from '../engine/autoEditSettings';
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
    const combo = fxCombo(payload.id);
    if (combo) return { dur: combo.fx.duration, label: combo.name, accepts: (k) => k === 'fx' };
    const m = s.modules.find((x) => x.id === payload.id);
    return { dur: m ? parseDuration(m.code, 0.5) : 0.5, label: m ? displayName(m.name) : '', accepts: (k) => k === 'fx' };
  }
  // 轉場拖到特效軌 = 轉場方塊
  if (payload.kind === 'module' && payload.moduleKind === 'transition') {
    const m = s.modules.find((x) => x.id === payload.id);
    return { dur: TR_BLOCK_DUR, label: m ? displayName(m.name) : '', accepts: (k) => k === 'fx' };
  }
  if (payload.kind === 'color') return { dur: stillDur(), label: payload.color, accepts: (k) => k === 'video' };
  if (payload.kind === 'text') {
    const p = userTextStyle(payload.preset) ?? TEXT_PRESETS.find((x) => x.id === payload.preset);
    return { dur: stillDur(), label: p?.name ?? '', accepts: (k) => k === 'video' };
  }
  if (payload.kind === 'files') return { dur: stillDur(), label: $t('{0} 個檔案', payload.count), accepts: (k) => k !== 'fx' };
  if (payload.kind === 'anim') return { dur: animDropDur(), label: $t('動畫'), accepts: (k) => k === 'video' };
  return null;
}

/** 這個拖曳內容可以放在哪種軌道（給時間軸顯示可放 / 不可放） */
export function laneAccepts(payload: DragPayload, kind: TrackKind): boolean {
  if (payload.kind === 'module' && payload.moduleKind === 'remap') return false;
  return laneDuration(payload)?.accepts(kind) ?? false;
}

/** 依滑鼠位置計算放置目標；alt = 按住 Alt：素材 / 色板放到影片或圖片片段上直接取代 */
export function computeTarget(payload: DragPayload, x: number, y: number, alt = false): DropTarget {
  const els = elementsAt(x, y);
  const s = useStore.getState();
  const clipEl = els.find((e) => e.dataset.key?.startsWith('clip:'));
  const clip = clipEl ? s.clips.find((c) => c.id === clipEl.dataset.key!.slice(5)) : undefined;

  // 拖到自動剪輯分頁：音訊（或拖到「音樂」卡片上的影片）= 換歌；影片 / 圖片 = 加入指定片段
  if ((payload.kind === 'media' || payload.kind === 'mediaBatch') && els.some((e) => e.classList?.contains('ae-segs-drop'))) {
    const ids = payload.kind === 'media' ? [payload.id] : payload.ids;
    const onSong = els.some((e) => e.classList?.contains('ae-song-drop'));
    const song = ids.length === 1 && songMedia(s).find((m) => m.id === ids[0] && (m.kind === 'audio' || onSong));
    if (song) return { kind: 'aeSong', mediaId: song.id, whole: alt };
    if (onSong) return null;
    return ids.some((id) => { const m = s.media.find((x) => x.id === id); return mediaUsable(m) && m.kind !== 'audio'; }) ? { kind: 'autoEdit', whole: alt } : null;
  }
  // 素材拖到動畫的圖片位置（屬性面板裡的那一列）：換那一張
  if (payload.kind === 'media') {
    const slotEl = els.find((e) => e.dataset.animSlot);
    if (slotEl) {
      const [animId, slotId] = slotEl.dataset.animSlot!.split('|');
      const m = s.media.find((x) => x.id === payload.id);
      return mediaUsable(m) && m.kind !== 'audio' ? { kind: 'animSlot', animId, slotId } : null;
    }
  }
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
    } else if (sel?.type === 'effect' && payload.moduleKind === 'effect') {
      // 特效方塊：預設疊加，按住 Alt = 取代（轉場方塊只能取代）
      const fx = s.effects.find((f) => f.id === sel.id);
      const trBlock = !!fx && s.modules.find((m) => m.id === fx.moduleId)?.kind === 'transition';
      t = { kind: 'effect', fxId: sel.id, ...(!alt && !trBlock ? { stack: true } : {}) };
    }
    insp.classList.toggle('drop-here', !!t);
    return t;
  }

  // 特效拖到時間軸上的特效方塊：按住 Alt 才直接取代，否則跟素材一樣放在軌道上（重疊時再選覆蓋 / 插入…）
  const fxUnder = (() => {
    const fxEl = els.find((e) => e.dataset.key?.startsWith('effect:'));
    return fxEl ? s.effects.find((f) => f.id === fxEl.dataset.key!.slice(7)) : undefined;
  })();
  const isTrBlock = (f: FxItem | undefined) => !!f && s.modules.find((m) => m.id === f.moduleId)?.kind === 'transition';
  if (payload.kind === 'module' && payload.moduleKind === 'effect') {
    const fx = fxUnder;
    if (fx && alt && !isTrBlock(fx)) return { kind: 'effect', fxId: fx.id };
    if (fx) return laneTarget();
    // 拖到影片 / 文字片段上：變成這個片段的片段特效
    if (clip) return { kind: 'clip', clipId: clip.id, action: 'effect', valid: true };
  }

  // 轉場拖到特效軌上的轉場方塊：按住 Alt 才換掉方塊的轉場
  if (payload.kind === 'module' && payload.moduleKind === 'transition' && fxUnder) {
    if (alt && isTrBlock(fxUnder)) return { kind: 'effect', fxId: fxUnder.id };
    return laneTarget();
  }

  // 轉場拖到時間軸上已經有的轉場方塊 → 換掉那個轉場（長度保留）。
  // 要先判斷：剪接點的轉場方塊有一半蓋在前一個片段上，不先判斷會被當成放到前一個片段
  if (payload.kind === 'module' && payload.moduleKind === 'transition') {
    const trEl = els.find((e) => e.dataset.tr);
    if (trEl) {
      const [clipId, side] = trEl.dataset.tr!.split(':');
      if (s.clips.some((c) => c.id === clipId)) return { kind: 'clip', clipId, action: side === 'out' ? 'transitionOut' : 'transition', valid: true };
    }
  }

  // 片段上的放置：轉場 / 變速 / 重新連結遺失素材
  if (payload.kind === 'module' && payload.moduleKind !== 'effect' && (clip || payload.moduleKind === 'remap')) {
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
  // 按住 Alt：圖片 / 影片 / 色板拖到影片或圖片片段上 → 直接取代那個片段的素材（文字片段、音訊素材不算）
  if (alt && clip && !clip.text && (payload.kind === 'media' || payload.kind === 'color')) {
    const nm = payload.kind === 'media' ? s.media.find((x) => x.id === payload.id) : undefined;
    if (payload.kind === 'color' || (mediaUsable(nm) && nm.kind !== 'audio')) return { kind: 'clip', clipId: clip.id, action: 'replace', valid: !s.tracks.video[clip.track]?.locked };
  }

  return laneTarget();

  function laneTarget(): DropTarget {
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

  // Ghost placement snaps to visible timeline items across every track.
  const pps = s.pps;
  // 時間軸最小單位是一格（1/60 秒）
  let time = Math.max(0, snapFrame((x - laneEl.getBoundingClientRect().left) / pps));
  if (payload.kind === 'mediaBatch') {
    const items = planMediaBatch(payload.ids, time, { kind: lane, track: idx });
    if (!items?.length) return null;
    return { kind: 'lane', lane, idx, time: items[0].start, duration: info.dur, label: info.label, items };
  }
  const attached = attachedAudioIds(s);
  const snapItems = [
    ...s.clips,
    ...s.effects,
    ...s.audios.filter((a) => !attached.has(a.id)),
  ];
  const pts = laneSnapPoints(snapItems, s.time, info.dur);
  let best = SNAP_PX / pps;
  let snapped: number | null = null;
  if (s.snap) {
    for (const p of pts) {
      if (p >= 0 && Math.abs(p - time) < best) { best = Math.abs(p - time); time = p; snapped = p; }
    }
  }
  useSnapLine.setState({ t: snapped });
  // 素材 / 色板：放在游標位置；跟其他片段重疊時，放開後再選覆蓋、取代、插入…
  if (payload.kind === 'media' || payload.kind === 'color') {
    const lk = `${lane}:${idx}`;
    const spans = spansOf(s).filter((o) => o.lane === lk);
    const hits = spans.filter((o) => time < o.start + o.duration - 1e-4 && o.start < time + info.dur - 1e-4);
    if (!hits.length) return { kind: 'lane', lane, idx, time, duration: info.dur, label: info.label };
    const nm = payload.kind === 'media' ? s.media.find((m) => m.id === payload.id) : undefined;
    let replaceId: string | undefined;
    if (lane === 'video' && nm?.kind !== 'audio') {
      const cands = s.clips.filter((c) => c.track === idx && !c.text && time < c.start + c.duration - 1e-4 && c.start < time + info.dur - 1e-4);
      const overlapLen = (c: Clip) => Math.min(c.start + c.duration, time + info.dur) - Math.max(c.start, time);
      replaceId = (clip && cands.includes(clip) ? clip : cands.sort((a, b) => overlapLen(b) - overlapLen(a))[0])?.id;
    }
    let gap = Infinity;
    for (const o of spans) if (o.start + o.duration > time + 1e-4) gap = Math.min(gap, Math.max(0, o.start - time));
    const fit = gap >= 0.05 && gap < info.dur - 1e-4 ? { duration: gap, speed: nm?.kind === 'video' && info.dur / gap <= 8 + 1e-4 } : null;
    return { kind: 'lane', lane, idx, time, duration: info.dur, label: info.label, overlap: { fit, replaceId } };
  }
  // 特效 / 轉場方塊：放在游標位置；跟其他方塊重疊時，放開後再選覆蓋、插入…（游標下的方塊可以取代）
  if (payload.kind === 'module' && lane === 'fx') {
    const lk = `${lane}:${idx}`;
    const spans = spansOf(s).filter((o) => o.lane === lk);
    const hits = spans.filter((o) => time < o.start + o.duration - 1e-4 && o.start < time + info.dur - 1e-4);
    if (!hits.length) return { kind: 'lane', lane, idx, time, duration: info.dur, label: info.label };
    const tr = payload.moduleKind === 'transition';
    const replaceId = fxUnder && fxUnder.track === idx && isTrBlock(fxUnder) === tr ? fxUnder.id : undefined;
    let gap = Infinity;
    for (const o of spans) if (o.start + o.duration > time + 1e-4) gap = Math.min(gap, Math.max(0, o.start - time));
    const fit = gap >= 0.05 && gap < info.dur - 1e-4 ? { duration: gap, speed: false } : null;
    return { kind: 'lane', lane, idx, time, duration: info.dur, label: info.label, overlap: { fit, replaceId } };
  }
  // 動畫：照游標位置（放下時會吸附到拍、放到底下片段的上面那條空軌，不在這條軌上找空位）
  if (payload.kind === 'anim') return { kind: 'lane', lane, idx, time, duration: info.dur, label: info.label };
  // 同一軌不能重疊：放到最近的空位；圖片 / 色板 / 文字放進空隙時縮短到剛好填滿
  const flexible = payload.kind === 'text';
  const fit = flexible ? fitInGap(spansOf(s), `${lane}:${idx}`, time, info.dur) : { start: fitStart(spansOf(s), `${lane}:${idx}`, time, info.dur), duration: info.dur };
  return { kind: 'lane', lane, idx, time: fit.start, duration: fit.duration, label: info.label };
  }
}

/** 執行放置 */
export async function applyDrop(payload: DragPayload, target: DropTarget, files?: File[], point?: { x: number; y: number }) {
  const s = useStore.getState();
  if (!target) {
    if (files) await importMany(files);
    return;
  }
  if (target.kind === 'animSlot') {
    if (payload.kind === 'media') setAnimSlot(target.animId, target.slotId, payload.id);
    return;
  }
  if (payload.kind === 'anim') {
    if (target.kind === 'lane' && !placeAnim(payload.id, target.idx, target.time)) toast($t('這裡不能放'), 'error');
    return;
  }
  if (target.kind === 'aeSong') {
    dropSong(target.mediaId, target.whole);
    return;
  }
  if (target.kind === 'autoEdit') {
    if (payload.kind === 'media' || payload.kind === 'mediaBatch') dropToAutoEdit(payload.kind === 'media' ? [payload.id] : payload.ids, target.whole);
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
    if (payload.kind !== 'module') return;
    if (target.stack) {
      const f = s.effects.find((e) => e.id === target.fxId);
      if (!f) return;
      s.updateEffect(f.id, { stack: [...(f.stack ?? []), ...comboClipFx(payload.id)] });
      toast($t('已疊加到特效'));
    } else await replaceFx(target.fxId, payload.id);
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
    // Alt + 拖曳：只換這一個片段的素材
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
  if ((payload.kind === 'media' || payload.kind === 'color') && target.overlap) {
    const overlap = target.overlap;
    const mediaId = async () => (payload.kind === 'media' ? payload.id : (await colorMedia(payload.color))?.id);
    const choose = async (mode: TimelineDropMode) => {
      const id = await mediaId();
      if (!id) return;
      beginHistoryTransaction();
      let ok = false;
      try {
        const st = useStore.getState();
        const known = new Set([...st.clips, ...st.audios].map((x) => x.id));
        place(id, target.time);
        const after = useStore.getState();
        const keys = after.selected.filter((k) => !known.has(parseKey(k).id));
        if (!keys.length) return;
        after.patchItems(Object.fromEntries(keys.map((k) => [k, { start: target.time }])));
        useStore.getState().resolveTimelineDrop(keys, mode);
        ok = true;
      } finally {
        endHistoryTransaction(ok); // 出錯也要結束，不然之後的變更都不會進復原紀錄
      }
    };
    const replaceId = overlap.replaceId;
    const replace = replaceId ? async () => {
      const id = await mediaId();
      if (id && useStore.getState().replaceClipMedia(replaceId, id)) toast($t('已取代片段的素材'));
    } : undefined;
    const preview: PlacementGhost[] = [{ type: target.lane === 'audio' ? 'audio' : 'clip', track: target.idx, start: target.time, duration: target.duration, label: target.label, thumb: payload.kind === 'media' ? s.media.find((m) => m.id === payload.id)?.thumb : undefined }];
    const p = point ?? { x: innerWidth / 2, y: innerHeight / 2 };
    showPendingPlacement({ fit: overlap.fit, preview }, p.x, p.y, (mode) => { void choose(mode); }, replace);
    return;
  }
  if (payload.kind === 'module' && target.overlap) {
    const overlap = target.overlap;
    const choose = (mode: TimelineDropMode) => {
      beginHistoryTransaction();
      let ok = false;
      try {
        const known = new Set(useStore.getState().effects.map((x) => x.id));
        useStore.getState().addEffect(payload.id, target.time, target.idx);
        const added = useStore.getState().effects.filter((x) => !known.has(x.id)).map((x) => keyOf('effect', x.id));
        if (!added.length) return;
        useStore.getState().patchItems(Object.fromEntries(added.map((k) => [k, { start: target.time }])));
        useStore.getState().resolveTimelineDrop(added, mode);
        ok = true;
      } finally {
        endHistoryTransaction(ok);
      }
    };
    const replaceId = overlap.replaceId;
    const replace = replaceId ? () => void replaceFx(replaceId, payload.id) : undefined;
    const preview: PlacementGhost[] = [{ type: 'effect', track: target.idx, start: target.time, duration: target.duration, label: target.label }];
    const p = point ?? { x: innerWidth / 2, y: innerHeight / 2 };
    showPendingPlacement({ fit: overlap.fit, preview }, p.x, p.y, choose, replace);
    return;
  }
  if (payload.kind === 'media') place(payload.id, target.time);
  else if (payload.kind === 'module') s.addEffect(payload.id, target.time, target.idx);
  else if (payload.kind === 'text') s.addText(payload.preset, target.time, target.idx, target.duration);
  else if (payload.kind === 'color') {
    const m = await colorMedia(payload.color);
    if (m) place(m.id, target.time);
  }
  else if (files) {
    let t = target.time;
    await addMediaFiles(files, (m) => { t += place(m.id, t); });
  }
}

/** 特效方塊換成另一個模組（有關鍵影格時先確認） */
async function replaceFx(fxId: string, moduleId: string) {
  const fx = useStore.getState().effects.find((f) => f.id === fxId);
  if (!fx || fx.moduleId === moduleId) return;
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
  useStore.getState().replaceEffect(fx.id, moduleId);
}

async function importMany(files: File[]) {
  const { ok: n } = await addMediaFiles(files);
  if (n) toast($t('已匯入 {0} 個檔案', n));
  else toast($t('無法匯入這些檔案'), 'error');
}

/** 素材庫項目：按下後拖超過 4px 才開始拖曳；回傳 true 代表變成拖曳（外部應取消 click） */
/**
 * 素材庫卡片的拖曳排序（共用）：拖曳中游標在 container 裡 = 調整順序，拖出去 = 照常放到時間軸。
 * 可以排序的卡片要加 data-sort-key（跟 keys 同一套 key、同樣的順序）。
 */
export interface SortOpts {
  container: HTMLElement;
  /** 被拖的那張卡片的 key */
  key: string;
  /** 目前顯示順序的所有 key */
  keys: string[];
  apply(next: string[]): void;
}

/** 游標位置在第幾張卡片前面（照格狀 / 清單的閱讀順序：由上而下、由左而右） */
function sortIndex(container: HTMLElement, x: number, y: number): number {
  const els = [...container.querySelectorAll<HTMLElement>('[data-sort-key]')];
  for (let i = 0; i < els.length; i++) {
    const r = els[i].getBoundingClientRect();
    if (y < r.top) return i;
    if (y <= r.bottom && x < r.left + r.width / 2) return i;
  }
  return els.length;
}

function showSortMark(container: HTMLElement | null, index: number | null) {
  document.querySelectorAll('.sort-before, .sort-after, .sorting').forEach((el) => el.classList.remove('sort-before', 'sort-after', 'sorting'));
  if (!container || index === null) return;
  const els = [...container.querySelectorAll<HTMLElement>('[data-sort-key]')];
  if (!els.length) return;
  container.classList.add('sorting');
  if (index < els.length) els[index].classList.add('sort-before');
  else els[els.length - 1].classList.add('sort-after');
}

export function startLibraryDrag(e: React.PointerEvent, payload: DragPayload, label: string, thumb?: string, sort?: SortOpts) {
  if (e.button !== 0) return;
  const x0 = e.clientX, y0 = e.clientY;
  let started = false;
  // 沒給縮圖：用項目本身的縮圖（模組 / 文字樣式）
  if (!thumb) {
    const bg = (e.currentTarget as HTMLElement).querySelector<HTMLElement>('.lib-thumb');
    const m = bg && /url\("?(.*?)"?\)/.exec(getComputedStyle(bg).backgroundImage);
    if (m) thumb = m[1];
  }
  let last = { x: x0, y: y0, alt: e.altKey };
  let sortAt: number | null = null;
  const update = () => {
    // 還在素材庫的格子裡：排序模式，不放到時間軸
    if (sort) {
      const r = sort.container.getBoundingClientRect();
      const inside = last.x >= r.left && last.x <= r.right && last.y >= r.top && last.y <= r.bottom;
      sortAt = inside ? sortIndex(sort.container, last.x, last.y) : null;
      showSortMark(sort.container, sortAt);
      if (inside) {
        document.body.classList.remove('drag-no');
        document.body.classList.add('drag-ok');
        useDrag.setState({ drag: { payload, label, thumb, x: last.x, y: last.y, target: null } as DragState });
        return;
      }
    }
    const target = computeTarget(payload, last.x, last.y, last.alt);
    document.body.classList.toggle('drag-ok', !!target);
    document.body.classList.toggle('drag-no', !target);
    useDrag.setState({ drag: { payload, label, thumb, x: last.x, y: last.y, target } as DragState });
  };
  const move = (ev: PointerEvent) => {
    if (!started && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return;
    started = true;
    last = { x: ev.clientX, y: ev.clientY, alt: ev.altKey };
    update();
  };
  // 拖曳中按下 / 放開 Alt：滑鼠沒動也要馬上切換取代模式
  const altKey = (ev: KeyboardEvent) => {
    if (ev.key !== 'Alt' || !started) return;
    ev.preventDefault();
    last = { ...last, alt: ev.type === 'keydown' };
    update();
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('keydown', esc);
    window.removeEventListener('keydown', altKey);
    window.removeEventListener('keyup', altKey);
    const d = useDrag.getState().drag;
    useDrag.setState({ drag: null });
    useSnapLine.setState({ t: null });
    document.body.classList.remove('drag-ok', 'drag-no');
    document.querySelector('.panel-inspector')?.classList.remove('drop-here');
    showSortMark(null, null);
    if (started && sort && sortAt !== null) {
      suppressClick();
      const next = moveKey(sort.keys, sort.key, sortAt);
      if (next !== sort.keys) sort.apply(next);
      return;
    }
    if (started && d) {
      suppressClick();
      // 拖到時間軸 / 片段上 = 已經用上了，結束試看
      if (d.target) stopLibraryPreview();
      applyDrop(payload, d.target, undefined, { x: d.x, y: d.y });
    }
  };
  const esc = (ev: KeyboardEvent) => {
    if (ev.key !== 'Escape') return;
    started = false;
    sortAt = null;
    useDrag.setState({ drag: null });
    up();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('keydown', esc);
  window.addEventListener('keydown', altKey);
  window.addEventListener('keyup', altKey);
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
