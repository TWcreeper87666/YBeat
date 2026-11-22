import { $t, displayName } from '../i18n';
import { AlignCenter, AlignLeft, AlignRight, Bold, BookmarkPlus, CopyCheck, CircleCheck, Italic, Music, Pipette, Play, Plus, TriangleAlert, Pencil, ChevronDown, ChevronRight, ChevronUp, Eye, EyeOff, Sparkles, Trash2, SquareDashedMousePointer, SquareDashed, PenTool, Unlink, Link2, Unlink2, Zap, Crosshair } from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { cutTracks, type FxTrigger } from '../engine/trigger';
import { attachedAudioIds, keyOf, uid, type ClipFx, hasLinkedAudio, parseTrSel, type TrScope, type TransitionRef, type TrSide, laneOf, mediaUsable, spansOf, useStore, type AudioDrive, type AudioFrom, type BlendMode, type Clip, type FxItem, type Media, type ModuleKind } from '../store';
import { fxLevel } from '../engine/tracks';
import type { Module } from '../modules/builtin';
import { CATEGORIES, categoryOf } from '../modules/categories';
import { importFiles, pickFiles, relinkWithPicker, removeMedia, removeMediaEverywhere } from '../engine/media';
import { applyMediaBatch, planMediaBatch } from '../engine/mediaBatch';
import { nextStart } from '../engine/overlap';
import { FONTS, TEXT_PRESETS, DEFAULT_TEXT, MAX_STROKES, defaultShadow, newStroke, renderText, shadowOf, type Shadow, type Stroke, type TextStyle } from '../engine/text';
import { PaintEdit } from './PaintEdit';
import { clipGroupMenu, clipPropMenu, clipTitleMenu, fxParamMenu, fxTitleMenu, trPropMenu, type FxOwner } from './applyAll';
import { copyTransition, hasTransitionClipboard, pasteTransition } from './trSelect';
import { DEFAULT_MASK, type Mask } from '../engine/mask';
import { CLIP_MASK_ID } from '../modules/extra';
import { mediaBeats } from '../engine/beats';
import { shapeName } from '../engine/maskShapes';
import type { AnimProp, Bez, Keyframe } from '../engine/keyframes';
import { isNumeric, canFollow, isHitFx, paramAt, parseDuration, parseParams, parsePointCh, resolveParams, type ParamDef, type ParamValue, type ParamValues } from '../engine/params';
import { CurveEdit } from './CurveEdit';
import { updateText } from '../engine/textAnchor';
import { computeFrame, transitionWindow, sortClips, makeCtx } from '../engine/renderer';
import { DEFAULT_TRANSFORM, FITS, type Fit } from '../engine/transform';
import { plainSpeed } from '../engine/remap';
import { COMBO_PREFIX, fxCombo, stillDur, usePrefs, type FxCombo, type UserTextStyle } from '../prefs';
import { useFavList, useFavorites } from './favorites';
import { applyToAllCaptions, type CaptionPart } from '../engine/subtitles';
import { tc } from '../engine/rulerTicks';
import { CURVE_ID, curveCode, defaultCurveKeys, keysToCurve } from '../engine/remapCurve';

/** 混合模式選單（函式：語言在載入時決定） */
const BLENDS = (): Record<BlendMode, string> => ({
  normal: $t('一般'),
  add: $t('加亮（相加）'),
  screen: $t('濾色'),
  multiply: $t('色彩增值（相乘）'),
  subtract: $t('相減'),
  lighten: $t('變亮'),
});
import { useModuleThumb } from '../engine/thumbs';
import { startLibraryDrag } from './dnd';
import { itemName } from './names';
import { ensureMatte, matteCoverage, matteFrames, useMatte } from '../engine/matte';
import { cfxMaskKey, useMaskEdit } from './MaskEditor';
import { closeSource, openSource, useSource } from './SourcePanel';
import { useDock } from './Dock';
import { aspectOf, formatBitrate, formatBytes, formatFps, probeMedia, type MediaProbe } from '../engine/mediaInfo';
import { confirmDialog, openMenu, promptDialog, revealSelection, stopPreviewFx, toast, useColorPick, useLayout, usePreviewFx, type MenuItem } from './uiStore';
import { DragNumber } from './DragNumber';
import { ModuleCode } from './ModuleCode';
import { newModule, openModuleEditor } from './CodePanel';
import { FavButton, LibFilter, LibToolbar, byFavOrder, favSortOpts, match, onBlank, openPicker } from './Library';
import { MaskLibrary, ShapeThumb, addClipMask, ensureClipBaseMask, setMaskShape } from './MaskPanel';
import { openShapeDrawer } from './ShapeDrawer';
import { followMenu, followReset } from './followUi';
import { fitOf, followOf, tracking, type Follow, type FollowMap, type Subject } from '../engine/follow';
import { startBoxPick, stopBoxPick, useBoxPick, useSubjectStatus } from './subjectUi';
import { EffectControls, curveChannel, focusSection, cfxCh, clipChannels, clipHost, fxChannels, fxHost, maskChannels, updateStackFx, type Channel, type Section } from './EffectControls';
import { Check, Seg, SegToggles, Switch } from './Toggle';
import { hasFrom } from '../engine/audioReact';

// ───────────────────────── 素材 ─────────────────────────

const KIND_LABEL = { video: $t('影片'), image: $t('圖片'), audio: $t('音訊') } as const;

export function MediaPanel() {
  const panelRef = useRef<HTMLDivElement>(null);
  const media = useStore((s) => s.media);
  const clips = useStore((s) => s.clips);
  const audios = useStore((s) => s.audios);
  const view = useLayout((s) => s.libView.media ?? 'grid');
  // 分類籤收起來 = 全部
  const filter = useLayout((s) => (s.libFilterOpen.media ? s.mediaFilter : 'all'));
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<'added' | 'name' | 'type'>('added');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [anchorId, setAnchorId] = useState<string | null>(null);

  // 色板素材不顯示在這裡（在「色板」分頁）
  const library = useMemo(() => media.filter((m) => !m.color), [media]);
  const uses = (id: string) => clips.filter((c) => c.mediaId === id).length + audios.filter((a) => a.mediaId === id).length;
  const list = useMemo(() => {
    const l = library.filter((m) => (filter === 'all' || m.kind === filter) && match(m.name, q));
    if (sort === 'name') l.sort((a, b) => a.name.localeCompare(b.name));
    if (sort === 'type') l.sort((a, b) => a.kind.localeCompare(b.kind));
    return l;
  }, [library, filter, q, sort]);
  useEffect(() => {
    const visible = new Set(list.map((m) => m.id));
    setSelectedIds((ids) => ids.filter((id) => visible.has(id)));
    if (anchorId && !visible.has(anchorId)) setAnchorId(null);
  }, [list, anchorId]);
  const selected = new Set(selectedIds);
  const picked = selectedIds.map((id) => list.find((m) => m.id === id)).filter((m): m is Media => !!m);
  const missing = library.filter((m) => m.missing).length;
  const previewing = useSource((s) => (s.open ? s.mediaId : null));

  const selectMedia = (e: React.MouseEvent, m: Media) => {
    panelRef.current?.focus();
    if (e.shiftKey) {
      const from = list.findIndex((x) => x.id === anchorId);
      const to = list.findIndex((x) => x.id === m.id);
      const range = from < 0 ? [m.id] : list.slice(Math.min(from, to), Math.max(from, to) + 1).map((x) => x.id);
      setSelectedIds(e.ctrlKey || e.metaKey ? [...new Set([...selectedIds, ...range])] : range);
      return;
    }
    setAnchorId(m.id);
    if (e.ctrlKey || e.metaKey) { setSelectedIds((ids) => ids.includes(m.id) ? ids.filter((id) => id !== m.id) : [...ids, m.id]); return; }
    setSelectedIds([m.id]);
    if (m.missing) relinkWithPicker(m.id);
    else openSource(m.id);
  };

  /** 在時間軸上選取用到這些素材的片段，播放頭移到最前面那個、畫面捲過去 */
  const selectUses = (items: Media[]) => {
    const ids = new Set(items.map((m) => m.id));
    const st = useStore.getState();
    const attached = attachedAudioIds(st);
    const found = [
      ...st.clips.filter((c) => ids.has(c.mediaId)).map((c) => ({ type: 'clip' as const, it: c as { id: string; start: number; duration: number } })),
      ...st.audios.filter((a) => ids.has(a.mediaId) && !attached.has(a.id)).map((a) => ({ type: 'audio' as const, it: a as { id: string; start: number; duration: number } })),
    ].sort((a, b) => a.it.start - b.it.start);
    if (!found.length) return;
    st.selectKeys(found.map((x) => keyOf(x.type, x.it.id)));
    const first = found[0];
    useStore.setState({ selection: { type: first.type, id: first.it.id } });
    if (st.time < first.it.start || st.time >= first.it.start + first.it.duration) st.setTime(first.it.start);
    revealSelection();
  };

  const insertPicked = (items: Media[]) => {
    const plan = planMediaBatch(items.map((m) => m.id), useStore.getState().time);
    const count = plan ? applyMediaBatch(plan) : 0;
    if (count) { revealSelection(); toast($t('已插入 {0} 個素材', count)); }
  };

  const removePicked = async (items: Media[], everywhere = false) => {
    if (!items.length) return;
    if ((items.length > 1 || everywhere) && !await confirmDialog({
      title: everywhere ? $t('連時間軸一起移除 {0} 個素材？', items.length) : $t('移除 {0} 個素材？', items.length),
      message: everywhere ? $t('這些素材在時間軸上的所有片段也會移除。') : $t('使用中的片段會標記為遺失素材。'),
      ok: $t('移除'), danger: true,
    })) return;
    if (everywhere) {
      if (!removeMediaEverywhere(items.map((m) => m.id))) return void toast($t('鎖定軌道上的片段無法移除'), 'error');
    } else for (const m of items) removeMedia(m.id, true);
    setSelectedIds([]);
    setAnchorId(null);
    if (items.some((m) => m.id === previewing)) closeSource();
    toast($t('已移除 {0} 個素材', items.length));
  };

  const itemMenu = (e: React.MouseEvent, m: Media) => {
    e.preventDefault();
    e.stopPropagation();
    panelRef.current?.focus();
    const items = selected.has(m.id) ? picked : [m];
    if (!selected.has(m.id)) { setSelectedIds([m.id]); setAnchorId(m.id); }
    const n = uses(m.id);
    const inTimeline = items.some((item) => uses(item.id) > 0);
    const useCount = items.reduce((k, item) => k + uses(item.id), 0);
    openMenu(e.clientX, e.clientY, [
      { label: useCount ? $t('在時間軸上選取（{0}）', useCount) : $t('時間軸上沒有使用'), action: useCount ? () => selectUses(items) : undefined },
      { separator: true },
      { label: items.length > 1 ? $t('插入選取的 {0} 個素材', items.length) : $t('插入到播放頭'), action: items.some(mediaUsable) ? () => insertPicked(items) : undefined },
      { label: m.missing ? $t('重新連結檔案…') : $t('替換檔案…'), action: items.length === 1 ? () => relinkWithPicker(m.id) : undefined },
      { label: $t('素材資訊'), action: items.length === 1 && !m.missing ? () => { openSource(m.id); useDock.getState().activatePanel('inspector'); } : undefined },
      { separator: true },
      { label: items.length > 1 ? $t('移除選取的 {0} 個素材', items.length) : n ? $t('從素材庫移除（{0} 個片段使用中）', n) : $t('從素材庫移除'), action: () => removePicked(items), danger: true },
      { label: $t('從素材庫與時間軸移除'), action: inTimeline ? () => removePicked(items, true) : undefined, danger: true },
    ]);
  };

  const bgMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const L = useLayout.getState();
    const unused = library.filter((m) => !uses(m.id));
    const items: MenuItem[] = [
      { label: $t('匯入媒體…'), shortcut: 'Ctrl+O', action: async () => importFiles(await pickFiles()) },
      { separator: true },
      { label: $t('清單檢視'), checked: view === 'list', action: () => L.set({ libView: { ...L.libView, media: 'list' } }) },
      { label: $t('格狀檢視'), checked: view === 'grid', action: () => L.set({ libView: { ...L.libView, media: 'grid' } }) },
      { separator: true },
      { label: $t('依加入順序'), checked: sort === 'added', action: () => setSort('added') },
      { label: $t('依名稱排序'), checked: sort === 'name', action: () => setSort('name') },
      { label: $t('依類型排序'), checked: sort === 'type', action: () => setSort('type') },
      { separator: true },
      { label: $t('移除未使用的素材（{0}）', unused.length), danger: true, action: unused.length ? () => unused.forEach((m) => removeMedia(m.id)) : undefined },
    ];
    openMenu(e.clientX, e.clientY, items);
  };

  return (
    <div ref={panelRef} className="lib media-panel" tabIndex={0} onContextMenu={bgMenu} onKeyDown={(e) => {
      if ((e.key !== 'Delete' && e.key !== 'Backspace') || e.target instanceof HTMLInputElement || !picked.length) return;
      e.preventDefault(); e.stopPropagation();
      void removePicked(picked);
    }}>
      <LibToolbar id="media" query={q} setQuery={setQ} filter={{ active: filter !== 'all', reset: () => useLayout.getState().set({ mediaFilter: 'all' }) }}>
        <button className="lib-add" title={$t('匯入媒體 (Ctrl+O)')} onClick={async () => importFiles(await pickFiles())}><Plus size={15} /></button>
      </LibToolbar>
      <LibFilter
        id="media"
        cats={[
          ...(['all', 'video', 'image', 'audio'] as const).map((f) => ({ id: f, label: f === 'all' ? $t('全部') : KIND_LABEL[f], count: f === 'all' ? library.length : library.filter((m) => m.kind === f).length })),
        ]}
        cur={filter}
        set={(f) => useLayout.getState().set({ mediaFilter: f as typeof filter })}
      />
      <div className="lib-body" onClick={onBlank(() => { closeSource(); setSelectedIds([]); setAnchorId(null); })} onDoubleClick={onBlank(async () => importFiles(await pickFiles()))}>
        {missing > 0 && <div className="warn"><TriangleAlert size={13} /> {missing}{' '}{$t('個素材遺失')}</div>}
        {library.length === 0 && <p className="muted small center">{$t('還沒有素材')}<br />{$t('雙擊匯入')}</p>}
        {library.length > 0 && list.length === 0 && <p className="muted small center">{$t('沒有符合的素材')}</p>}
        <div className={view === 'grid' ? 'lib-grid' : 'lib-list'}>
          {list.map((m) => (
            <div
              key={m.id}
              className={`lib-item ${m.missing ? 'missing' : ''} ${previewing === m.id ? 'previewing' : ''} ${selected.has(m.id) ? 'selected' : ''}`}
              onPointerDown={(e) => {
                if (e.ctrlKey || e.metaKey || e.shiftKey || !mediaUsable(m)) return;
                const batch = selected.has(m.id) && picked.length > 1 ? picked.filter(mediaUsable) : [];
                if (batch.length > 1) startLibraryDrag(e, { kind: 'mediaBatch', ids: batch.map((x) => x.id) }, $t('{0} 個素材', batch.length), m.kind === 'audio' ? undefined : m.thumb);
                else startLibraryDrag(e, { kind: 'media', id: m.id }, m.name, m.kind === 'audio' ? undefined : m.thumb);
              }}
              onClick={(e) => selectMedia(e, m)}
              onContextMenu={(e) => itemMenu(e, m)}
              title={m.missing ? $t('{0}（遺失，點擊重新連結）', m.name) : m.name}
            >
              <div className={`lib-thumb ${m.kind}`} style={m.thumb ? { backgroundImage: `url(${m.thumb})` } : undefined}>
                {m.kind === 'audio' && <span className="note"><Music size={18} /></span>}
                {m.missing && <span className="miss"><TriangleAlert size={11} /> {$t('遺失')}</span>}
                {view === 'grid' && m.kind !== 'image' && <span className="dur">{m.duration.toFixed(1)}s</span>}
                {uses(m.id) > 0 && view === 'grid' && <span className="used" title={$t('已在時間軸上使用')}><CircleCheck size={11} /></span>}
              </div>
              <div className="lib-meta">
                <div className="lib-name">{previewing === m.id && <Play size={10} fill="currentColor" />} {m.name}</div>
                {view === 'list' && (
                  <div className="lib-sub">{KIND_LABEL[m.kind]}{m.kind !== 'image' ? ` · ${m.duration.toFixed(1)}s` : ` · ${m.width}×${m.height}`}{uses(m.id) ? $t(' · 使用 {0} 次', uses(m.id)) : ''}</div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ───────────────────────── 文字 / 字幕 ─────────────────────────

function TextThumb({ style }: { style: TextStyle }) {
  const url = useMemo(() => renderText(style).toDataURL(), [style]);
  return <div className="lib-thumb text-thumb" style={{ backgroundImage: `url(${url})` }} />;
}

export function TextPanel() {
  const view = useLayout((s) => s.libView.text ?? 'grid');
  const userStyles = usePrefs((s) => s.textStyles);
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<'all' | 'preset' | 'user'>('all');
  const styles = useMemo(() => TEXT_PRESETS.map((p) => ({ ...DEFAULT_TEXT, ...p.style })), []);
  const add = (id: string) => {
    const s = useStore.getState();
    s.addText(id, s.time, s.trackForInsert('video', s.time, stillDur()));
    revealSelection();
  };
  const items = [
    ...(cat !== 'user' ? TEXT_PRESETS.map((p, i) => ({ id: p.id, name: p.name, style: styles[i], user: undefined as UserTextStyle | undefined })) : []),
    ...(cat !== 'preset' ? userStyles.map((u) => ({ id: u.id, name: u.name, style: { ...DEFAULT_TEXT, ...u.style }, user: u })) : []),
  ].filter((x) => match(x.name, q));
  const itemMenu = (e: React.MouseEvent, u?: UserTextStyle) => {
    e.preventDefault();
    if (!u) return;
    const P = usePrefs.getState();
    openMenu(e.clientX, e.clientY, [
      {
        label: $t('重新命名…'),
        action: async () => {
          const n = await promptDialog({ title: $t('重新命名樣式'), value: u.name });
          if (n?.trim()) P.set({ textStyles: usePrefs.getState().textStyles.map((x) => (x.id === u.id ? { ...x, name: n.trim() } : x)) });
        },
      },
      { label: $t('刪除樣式'), danger: true, action: () => P.set({ textStyles: usePrefs.getState().textStyles.filter((x) => x.id !== u.id) }) },
    ]);
  };
  const empty = cat === 'user' && !userStyles.length ? $t('還沒有我的樣式') : $t('沒有符合的樣式');
  const previewing = usePreviewFx((s) => s.text?.preset);
  const togglePreview = (id: string, name: string) => {
    useStore.getState().setPlaying(false);
    usePreviewFx.setState({ fx: null, text: previewing === id ? null : { preset: id, name, t0: performance.now() } });
  };
  return (
    <div className="lib" onContextMenu={(e) => e.preventDefault()}>
      <LibToolbar id="text" query={q} setQuery={setQ} filter={{ active: cat !== 'all', reset: () => setCat('all') }}>
        <button className="lib-add" title={$t('在播放頭加入文字')} onClick={() => add('title')}><Plus size={15} /></button>
      </LibToolbar>
      <LibFilter
        id="text"
        cats={[
          { id: 'all', label: $t('全部') },
          { id: 'preset', label: $t('預設'), count: TEXT_PRESETS.length },
          { id: 'user', label: $t('我的樣式'), count: userStyles.length },
        ]}
        cur={cat}
        set={(v) => setCat(v as typeof cat)}
      />
      <div className="lib-body" onClick={onBlank(stopPreviewFx)} onDoubleClick={onBlank(() => add('title'))}>
        {!items.length && <p className="muted small center">{empty}</p>}
        <div className={view === 'grid' ? 'lib-grid mods' : 'lib-list'}>
          {items.map((it) => (
            <div
              key={it.id}
              className={`lib-item mod mk-text ${previewing === it.id ? 'previewing' : ''}`}
              onPointerDown={(e) => startLibraryDrag(e, { kind: 'text', preset: it.id }, it.name)}
              onClick={() => togglePreview(it.id, it.name)}
              onContextMenu={(e) => itemMenu(e, it.user)}
              title={it.name}
            >
              <TextThumb style={it.style} />
              <div className="lib-meta">
                <div className="lib-name">{previewing === it.id && <Play size={10} fill="currentColor" />} {it.name}</div>
                {view === 'list' && it.user && <div className="lib-sub">{$t('我的樣式')}</div>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** 把這個文字片段的樣式、位置、轉場、片段特效存成「我的樣式」 */
async function saveTextStyle(clipId: string) {
  const c = useStore.getState().clips.find((x) => x.id === clipId);
  if (!c?.text) return;
  const sample = c.text.text.split('\n')[0].trim().slice(0, 12) || $t('文字');
  const name = await promptDialog({ title: $t('存成我的樣式'), value: sample });
  if (!name?.trim()) return;
  const style: UserTextStyle = {
    id: `user:${uid()}`,
    name: name.trim(),
    style: { ...c.text, text: sample },
    transform: { ...c.transform },
    transitionIn: c.transitionIn ? structuredClone(c.transitionIn) : null,
    transitionOut: c.transitionOut ? structuredClone(c.transitionOut) : null,
    effects: structuredClone(c.effects ?? []),
  };
  const P = usePrefs.getState();
  P.set({ textStyles: [...P.textStyles, style] });
  toast($t('已存成我的樣式'));
}

function captionApplyMenu(e: React.MouseEvent, clipId: string) {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const run = (parts: CaptionPart[]) => {
    const n = applyToAllCaptions(clipId, parts);
    toast(n ? $t('已套用到 {0} 段字幕', n) : $t('沒有其他字幕'), n ? undefined : 'error');
  };
  openMenu(r.left, r.bottom, [
    { label: $t('套用樣式到全部字幕'), action: () => run(['style']) },
    { label: $t('套用位置到全部字幕'), action: () => run(['position']) },
    { label: $t('套用轉場到全部字幕'), action: () => run(['transition']) },
    { label: $t('套用片段特效到全部字幕'), action: () => run(['effects']) },
    { separator: true },
    { label: $t('全部套用到所有字幕'), action: () => run(['style', 'position', 'transition', 'effects']) },
  ]);
}

// ───────────────────────── 轉場 / 特效 / 變速 ─────────────────────────

function ModuleThumb({ m }: { m: Module }) {
  const url = useModuleThumb(m);
  return (
    <div className="lib-thumb mod" style={url ? { backgroundImage: `url(${url})` } : undefined}>
      {!url && <span className="loading" />}
      {isHitFx(m) && <span className="fx-short" title={$t('衝擊特效')}><Zap size={10} fill="currentColor" /></span>}
      {canFollow(m) && <span className="fx-face" title={$t('跟隨目標')}><Crosshair size={10} /></span>}
    </div>
  );
}

export function ModulePanel({ kind }: { kind: ModuleKind }) {
  return <ModuleLibrary kind={kind} />;
}

/**
 * 模組庫（轉場 / 特效 / 變速）。分頁與屬性面板的挑選視窗共用：
 * 有 onPick = 挑選模式（點一下就選、不試看、不能拖）
 */
export function ModuleLibrary({ kind, onPick, current }: { kind: ModuleKind; onPick?: (id: string) => void; current?: string }) {
  const all = useStore((s) => s.modules);
  const previewing = usePreviewFx((s) => s.fx?.moduleId);
  const view = useLayout((s) => s.libView[kind] ?? 'grid');
  const favorites = useFavList(kind);
  const cat = useLayout((s) => (s.libFilterOpen[kind] ? s.modCat[kind] ?? 'all' : 'all'));
  const [q, setQ] = useState('');

  const favSet = new Set(favorites);
  const ofKind = all.filter((m) => m.kind === kind);
  const inCat = (m: Module, c: string) =>
    c === 'all' || (c === 'fav' ? favSet.has(m.id) : c === 'hit' ? isHitFx(m) : c === 'hold' ? !isHitFx(m) : c === 'face' ? canFollow(m) : categoryOf(m) === c);
  const filtered = ofKind.filter((m) => match(m.name, q) && inCat(m, cat));
  const modules = cat === 'fav' ? byFavOrder(filtered, (m) => m.id, favorites) : filtered;
  // 我的組合（只有特效分頁；挑選視窗不顯示）
  const allCombos = usePrefs((s) => s.fxCombos);
  const combos = kind === 'effect' && !onPick ? allCombos : [];
  const comboList = cat === 'all' || cat === 'combo' ? combos.filter((c) => match(c.name, q)) : [];
  // 我的最愛：拖曳調整順序（挑選視窗、搜尋中不行）
  const gridRef = useRef<HTMLDivElement>(null);
  const sortable = cat === 'fav' && !q.trim() && !onPick;
  const sortOpts = (id: string) => (sortable ? favSortOpts(gridRef.current, id, modules.map((m) => m.id), kind) : undefined);
  const setCat = (c: string) => useLayout.getState().set({ modCat: { ...useLayout.getState().modCat, [kind]: c } });
  const toggleFav = (id: string) => useFavorites.getState().toggle(kind, id);
  const cats = [
    { id: 'all', label: $t('全部') },
    { id: 'fav', label: $t('我的最愛') },
    ...(combos.length ? [{ id: 'combo', label: $t('我的組合') }] : []),
    ...(kind === 'effect' ? [{ id: 'hit', label: $t('衝擊'), icon: <Zap size={11} fill="currentColor" /> }, { id: 'hold', label: $t('持續') }] : []),
    ...(kind === 'effect' || kind === 'transition' ? [{ id: 'face', label: $t('追蹤'), icon: <Crosshair size={11} /> }] : []),
    ...CATEGORIES[kind],
    { id: 'custom', label: $t('自訂') },
  ].filter((c) => c.id === 'all' || c.id === 'fav' || c.id === 'combo' || ofKind.some((m) => inCat(m, c.id)));

  const apply = (id: string) => {
    const s = useStore.getState();
    stopPreviewFx();
    if (kind === 'effect') {
      const m = s.modules.find((x) => x.id === id);
      const dur = fxCombo(id)?.fx.duration ?? (m ? parseDuration(m.code, 0.5) : 0.5);
      s.addEffect(id, s.time, s.trackForInsert('fx', s.time, dur));
      return revealSelection();
    }
    let clipId = s.selection?.type === 'clip' ? s.selection.id : s.selection?.type === 'transition' ? parseTrSel(s.selection.id).clipId : null;
    if (!clipId) {
      const ctx = makeCtx(s);
      for (let i = ctx.videoTracks.length - 1; i >= 0 && !clipId; i--) {
        const fr = computeFrame(ctx.videoTracks[i], s.time);
        clipId = fr.kind === 'clip' ? fr.clip.id : fr.kind === 'transition' ? (fr.B ?? fr.A)!.id : null;
      }
    }
    if (!clipId) return;
    if (kind === 'transition') s.setTransition(clipId, id);
    else s.setRemap(clipId, id);
  };

  const togglePreview = (id: string) => {
    useStore.getState().setPlaying(false);
    usePreviewFx.setState({ fx: previewing === id ? null : { moduleId: id, t0: performance.now() }, text: null });
  };

  const itemMenu = (e: React.MouseEvent, m: Module) => {
    e.preventDefault();
    e.stopPropagation();
    const S = useStore.getState();
    // 套用相關的放進「套用」子選單（變速只有一種，直接放）
    const applyItems: MenuItem[] = (() => {
      if (kind === 'remap') return [{ label: $t('套用到選取的片段'), action: () => apply(m.id) }];
      if (kind === 'effect') {
        const st = useStore.getState();
        const ids = st.selected.filter((k) => k.startsWith('clip:')).map((k) => k.slice(5));
        if (!ids.length && st.selection?.type === 'clip') ids.push(st.selection.id);
        return [
          { label: $t('在播放頭加入'), action: () => apply(m.id) },
          { label: $t('選取片段的片段特效'), action: ids.length ? () => ids.forEach((cid) => useStore.getState().addClipFx(cid, m.id)) : undefined },
        ];
      }
      const st = useStore.getState();
      const track = st.activeTrack?.kind === 'video' ? st.activeTrack.idx : st.selection?.type === 'clip' ? st.clips.find((c) => c.id === st.selection!.id)?.track ?? 0 : st.tracks.video.length - 1;
      const go = (scope: TrScope) => toast($t('已套用到 {0} 個位置', useStore.getState().applyTransitions(track, scope, { moduleId: m.id })));
      const name = $t('影片 {0}', track + 1);
      return [
        { label: $t('選取的片段'), action: () => apply(m.id) },
        { separator: true },
        { label: $t('「{0}」的所有剪接點', name), action: () => go('cuts') },
        { label: $t('「{0}」所有片段的開頭', name), action: () => go('heads') },
        { label: $t('「{0}」所有片段的結尾', name), action: () => go('tails') },
        { label: $t('「{0}」全部', name), action: () => go('all') },
      ];
    })();
    openMenu(e.clientX, e.clientY, [
      { label: favSet.has(m.id) ? $t('從我的最愛移除') : $t('加入我的最愛'), action: () => toggleFav(m.id) },
      { separator: true },
      ...(applyItems.length > 1 ? [{ label: $t('套用'), submenu: applyItems }] : applyItems),
      { label: $t('在預覽中試看'), action: () => togglePreview(m.id) },
      // 內建模組不能直接改：複製成自訂模組再編輯
      ...(m.builtin ? [] : [{ label: $t('編輯程式碼'), action: () => { stopPreviewFx(); openModuleEditor(m.id); } }]),
      { label: $t('複製為新模組'), action: () => openModuleEditor(S.forkModule(m.id)) },
      ...(m.builtin
        ? []
        : [
            { separator: true as const },
            { label: $t('刪除模組'), danger: true, action: () => { if (!S.removeModule(m.id)) toast($t('還有片段 / 特效在用這個模組，不能刪除'), 'error'); } },
          ]),
    ]);
  };

  const comboMenu = (e: React.MouseEvent, c: FxCombo) => {
    e.preventDefault();
    e.stopPropagation();
    const P = usePrefs.getState();
    const ids = (() => {
      const st = useStore.getState();
      const l = st.selected.filter((k) => k.startsWith('clip:')).map((k) => k.slice(5));
      if (!l.length && st.selection?.type === 'clip') l.push(st.selection.id);
      return l;
    })();
    openMenu(e.clientX, e.clientY, [
      { label: $t('在播放頭加入'), action: () => apply(c.id) },
      { label: $t('選取片段的片段特效'), action: ids.length ? () => ids.forEach((cid) => useStore.getState().addClipFx(cid, c.id)) : undefined },
      { label: $t('在預覽中試看'), action: () => togglePreview(c.id) },
      { separator: true },
      {
        label: $t('重新命名…'),
        action: async () => {
          const n = await promptDialog({ title: $t('重新命名組合'), value: c.name });
          if (n?.trim()) P.set({ fxCombos: usePrefs.getState().fxCombos.map((x) => (x.id === c.id ? { ...x, name: n.trim() } : x)) });
        },
      },
      { label: $t('刪除組合'), danger: true, action: () => P.set({ fxCombos: usePrefs.getState().fxCombos.filter((x) => x.id !== c.id) }) },
    ]);
  };

  const bgMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const L = useLayout.getState();
    openMenu(e.clientX, e.clientY, [
      { label: $t('新增自訂模組'), action: () => newModule(kind) },
      { separator: true },
      { label: $t('清單檢視'), checked: view === 'list', action: () => L.set({ libView: { ...L.libView, [kind]: 'list' } }) },
      { label: $t('格狀檢視'), checked: view === 'grid', action: () => L.set({ libView: { ...L.libView, [kind]: 'grid' } }) },
    ]);
  };

  return (
    <div className="lib" onContextMenu={(e) => (onPick ? e.preventDefault() : bgMenu(e))}>
      <LibToolbar id={kind} query={q} setQuery={setQ} filter={{ active: cat !== 'all', reset: () => setCat('all') }}>
        <button className="lib-add" title={$t('新增自訂模組')} onClick={() => newModule(kind)}><Plus size={15} /></button>
      </LibToolbar>
      <LibFilter id={kind} cats={cats.map((c) => ({ ...c, count: c.id === 'combo' ? combos.length : ofKind.filter((m) => inCat(m, c.id)).length + (c.id === 'all' ? combos.length : 0) }))} cur={cat} set={setCat} />
      <div className="lib-body" onClick={onBlank(onPick ? undefined : stopPreviewFx)} onDoubleClick={onBlank(onPick ? undefined : () => newModule(kind))}>
        {modules.length === 0 && comboList.length === 0 && (
          <p className="muted small center">{cat === 'fav' ? $t('還沒有我的最愛') : cat === 'custom' ? $t('還沒有自訂模組') : $t('沒有符合的模組')}</p>
        )}
        <div ref={gridRef} className={view === 'grid' ? 'lib-grid mods' : 'lib-list'}>
          {comboList.map((c) => {
            const m = all.find((x) => x.id === c.fx.moduleId);
            return (
              <div
                key={c.id}
                className={`lib-item mod mk-effect combo ${previewing === c.id ? 'previewing' : ''}`}
                onPointerDown={(e) => startLibraryDrag(e, { kind: 'module', id: c.id, moduleKind: 'effect' }, c.name)}
                onClick={() => togglePreview(c.id)}
                onContextMenu={(e) => comboMenu(e, c)}
                title={c.name}
              >
                {m ? <ModuleThumb m={m} /> : <div className="lib-thumb mod" />}
                {!!c.fx.stack?.length && <span className="combo-count">+{c.fx.stack.length}</span>}
                <div className="lib-meta">
                  <div className="lib-name">{previewing === c.id && <Play size={10} fill="currentColor" />} {c.name}</div>
                  {view === 'list' && <div className="lib-sub">{$t('我的組合')}</div>}
                </div>
              </div>
            );
          })}
          {modules.map((m) => (
            <div
              key={m.id}
              data-sort-key={sortable ? m.id : undefined}
              className={`lib-item mod mk-${kind} ${!onPick && previewing === m.id ? 'previewing' : ''} ${current === m.id ? 'current' : ''}`}
              onPointerDown={(e) => !onPick && startLibraryDrag(e, { kind: 'module', id: m.id, moduleKind: kind }, displayName(m.name), undefined, sortOpts(m.id))}
              onClick={() => (onPick ? onPick(m.id) : togglePreview(m.id))}
              onContextMenu={(e) => (onPick ? e.preventDefault() : itemMenu(e, m))}
              title={onPick ? $t('{0}（點一下加入）', displayName(m.name)) : displayName(m.name)}
            >
              <ModuleThumb m={m} />
              <FavButton on={favSet.has(m.id)} toggle={() => toggleFav(m.id)} />
              <div className="lib-meta">
                <div className="lib-name">{!onPick && previewing === m.id && <Play size={10} fill="currentColor" />} {displayName(m.name)}</div>
                {view === 'list' && !m.builtin && <div className="lib-sub">{$t('自訂')}</div>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** 速度模式：跟遮罩形狀一樣，按了打開「變速」素材庫的小視窗來挑 */
function RemapPick({ clip }: { clip: Clip }) {
  const m = useStore((s) => s.modules.find((x) => x.id === clip.remap.moduleId));
  return (
    <button
      className="shape-pick"
      title={$t('選擇速度模式')}
      onClick={(e) => openPicker(e.currentTarget, $t('變速'), () => <RemapPickerBody clipId={clip.id} />)}
    >
      {m && <RemapThumb m={m} />}
      <span className="shape-pick-name">{m ? displayName(m.name) : ''}</span>
      <ChevronDown size={12} />
    </button>
  );
}
function RemapThumb({ m }: { m: Module }) {
  const url = useModuleThumb(m);
  return <span className="remap-pick-thumb" style={url ? { backgroundImage: `url(${url})` } : undefined} />;
}
function RemapPickerBody({ clipId }: { clipId: string }) {
  const cur = useStore((s) => s.clips.find((c) => c.id === clipId)?.remap.moduleId);
  return <ModuleLibrary kind="remap" current={cur} onPick={(id) => useStore.getState().setRemap(clipId, id)} />;
}

// ───────────────────────── 屬性（效果控制） ─────────────────────────

// 從素材庫 / 時間軸把轉場、變速、片段特效、遮罩加到片段上 → 屬性面板捲到新加的那一塊
useStore.subscribe((s, p) => {
  if (s.clips === p.clips && s.effects === p.effects) return;
  const sel = s.selection;
  if (!sel) return;
  if ((sel.type === 'transition' && sel !== p.selection) || (sel.type === 'effect' && !p.effects.some((e) => e.id === sel.id))) return focusSection('@top');
  if (sel.type !== 'clip') return;
  const c = s.clips.find((x) => x.id === sel.id);
  const pc = p.clips.find((x) => x.id === sel.id);
  if (!c || !pc || c === pc) return;
  const added = (c.effects ?? []).find((f) => !(pc.effects ?? []).some((x) => x.id === f.id));
  if (added) return focusSection(added.base ? 'clipmask' : `cfx.${added.id}`);
  if (c.remap.moduleId !== pc.remap.moduleId) focusSection('speed');
});

export function InspectorPanel() {
  const sel = useStore((s) => s.selection);
  const source = useSource((s) => (s.open && s.inspect ? s.mediaId : null));
  if (source) return <div className="inspector-panel"><MediaInspector id={source} /></div>;
  return (
    <div className="inspector-panel">
      {!sel && <div className="empty">{$t('在時間軸上選取片段、轉場或特效')}</div>}
      {sel?.type === 'clip' && <ClipInspector id={sel.id} />}
      {sel?.type === 'transition' && <TransitionInspector key={sel.id} selId={sel.id} />}
      {sel?.type === 'effect' && <EffectInspector id={sel.id} />}
      {sel?.type === 'audio' && <AudioInspector id={sel.id} />}
    </div>
  );
}

/** 屬性面板標題：種類 + 名稱（可以重新命名，太長會變成 …） */
function Title({ kind, label, name, onRename }: { kind: string; label: string; name: string; onRename?: (n: string) => void }) {
  const [edit, setEdit] = useState(false);
  const finish = (v: string | null) => {
    setEdit(false);
    if (v !== null && v !== name) onRename?.(v);
  };
  return (
    <span className="ec-title">
      <span className={`kind ${kind}`}>{label}</span>
      {edit ? (
        <input
          className="name-input"
          autoFocus
          defaultValue={name}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={(e) => finish(e.currentTarget.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') finish(e.currentTarget.value);
            if (e.key === 'Escape') finish(null);
          }}
        />
      ) : (
        <span className="ec-name" title={onRename ? $t('{0}（雙擊重新命名）', name) : name} onDoubleClick={() => onRename && setEdit(true)}>
          {name}
        </span>
      )}
      {onRename && !edit && (
        <button className="ec-icon" title={$t('重新命名')} onClick={() => setEdit(true)}>
          <Pencil size={12} />
        </button>
      )}
    </span>
  );
}

function ModuleSelect({ kind, value, onChange, allowNone }: { kind: ModuleKind; value: string | null; onChange: (id: string | null) => void; allowNone?: boolean }) {
  const modules = useStore((s) => s.modules).filter((m) => m.kind === kind);
  return (
    <select className="select wide" value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
      {allowNone && <option value="">{$t('（無）')}</option>}
      {modules.map((m) => <option key={m.id} value={m.id}>{displayName(m.name)}</option>)}
    </select>
  );
}

/** 參數的單一控制項（不打 key 的） */
function ColorParamWidget({ value, onChange, onSample }: { value: string; onChange: (v: string) => void; onSample?: (hex: string) => void }) {
  const picking = useColorPick((s) => !!s.pick);
  return (
    <div className="color-pick-row">
      <input type="color" className="color" value={value} onChange={(e) => onChange(e.target.value)} />
      {onSample && <button className={`btn small-h ${picking ? 'on-accent' : ''}`} title={$t('吸取預覽顏色')} onClick={() => {
        const active = useColorPick.getState().pick;
        useColorPick.setState({ pick: active ? null : onSample });
      }}><Pipette size={13} /></button>}
    </div>
  );
}

/** point 參數（不打 key 的，例如轉場）：X / Y 兩個欄位，像素顯示 */
function PointWidget({ v, def, onChange, menu }: { v: number[]; def: number[]; onChange: (v: number[]) => void; menu?: MenuItem[] }) {
  const fmt = useStore((s) => s.format);
  return (
    <div className="point-row">
      {[0, 1].map((a) => (
        <DragNumber key={a} variant="text" value={v[a]} step={0.001} display={a ? fmt.h : fmt.w} suffix=" px" def={def[a]} menu={menu} onChange={(x) => onChange(a ? [v[0], x] : [x, v[1]])} />
      ))}
    </div>
  );
}

function ParamWidget({ d, v, onChange, sampleColor, menu }: { d: ParamDef; v: ParamValue; onChange: (v: ParamValue) => void; sampleColor?: boolean; menu?: MenuItem[] }) {
  if (d.type === 'point') return <PointWidget v={(Array.isArray(v) ? v : d.def) as number[]} def={d.def as number[]} onChange={onChange} menu={menu} />;
  if (d.type === 'curve') return <CurveEdit value={(Array.isArray(v) && v.length === 4 ? v : d.def) as Bez} onChange={onChange} none={d.none} />;
  if (d.type === 'bool') return <Switch v={Boolean(v)} on={onChange} />;
  if (d.type === 'color') return <ColorParamWidget value={String(v)} onChange={onChange} onSample={sampleColor ? onChange : undefined} />;
  return <DragNumber variant="text" value={Number(v)} step={d.type === 'int' ? 1 : undefined} min={d.min} max={d.max} decimals={d.type === 'int' ? 0 : undefined} def={Number(d.def)} menu={menu} onChange={(x) => onChange(d.type === 'int' ? Math.round(x) : x)} />;
}

/** menuOf：這個參數的右鍵選單多加的項目（例如「套用到同軌」），名稱和數值欄位都可以右鍵 */
const paramRows = (defs: ParamDef[], values: ParamValues, set: (p: ParamValues) => void, sampleColor = false, menuOf?: (d: ParamDef) => MenuItem[]) =>
  defs.map((d) => {
    const menu = menuOf?.(d);
    return { label: $t(d.label), menu, node: <ParamWidget d={d} v={values[d.name] ?? d.def} onChange={(v) => set({ ...values, [d.name]: v })} sampleColor={sampleColor && d.name === 'key'} menu={menu} /> };
  });


/**
 * 「資訊」：開始 / 長度 / 結束（＋素材）。
 * setDur：長度可以直接改（圖片、色板、文字、特效）；影片 / 音訊的長度受素材限制，用修剪。
 */
function infoRows(it: { start: number; duration: number }, media?: Media, setDur?: (v: number) => void) {
  const rows: { label: string; node: React.ReactNode }[] = [
    { label: $t('開始'), node: <span className="info-val">{tc(it.start)}</span> },
    {
      label: $t('長度'),
      node: setDur
        ? <DragNumber variant="text" value={it.duration} min={0.05} step={0.01} suffix="s" onChange={setDur} />
        : <span className="info-val">{it.duration.toFixed(2)}s</span>,
    },
    { label: $t('結束'), node: <span className="info-val">{tc(it.start + it.duration)}</span> },
  ];
  if (media) {
    const size = media.width && media.height ? `${media.width}×${media.height}` : '';
    const len = media.kind !== 'image' ? `${media.duration.toFixed(2)}s` : '';
    rows.push({ label: $t('素材'), node: <span className="info-val" title={media.name}>{[size, len].filter(Boolean).join(' · ') || media.name}</span> });
  }
  return rows;
}

/** 改速度導致片段變長時，不能蓋到同軌下一個片段：回傳允許的最大長度 */
function maxDurFor(type: 'clip' | 'audio' | 'effect', it: { id: string; start: number; duration: number; track: number }) {
  const s = useStore.getState();
  return nextStart(spansOf(s, new Set([`${type}:${it.id}`])), laneOf(type, it.track), it.start + it.duration) - it.start;
}

/** 變速時保持音調：開 = 只變速度；關 = 像錄音帶一樣音調跟著變 */
const PitchSwitch = ({ v, on }: { v: boolean; on: (v: boolean) => void }) => (
  <span className="pitch-row" title={$t('開：變速時音調不變（人聲不會變尖 / 變低沉）；關：音調跟著速度變')}>
    <Switch v={v} on={on} />
  </span>
);

/** 跟隨目標開關；調過位置時旁邊有「重設」 */
const FollowSwitch = ({ on, set, reset, apply }: { on: boolean; set: (v: boolean) => void; reset: FollowMap | null; apply: (m: FollowMap) => void }) => (
  <span className="row-inline">
    <Switch v={on} on={set} />
    {reset && <button className="link" onClick={() => apply(reset)}>{$t('重設')}</button>}
  </span>
);

/** 追蹤的進度 / 失敗重試（打開時就開始在背景算） */
function TrackStatus({ clip, media }: { clip: Clip; media: Media }) {
  const st = useSubjectStatus(clip, media);
  if (st.pct !== null) {
    return (
      <span className="matte-status">
        <span className="matte-bar"><i style={{ width: `${st.pct}%` }} /></span>
        <span className="muted small">{st.pct}%</span>
      </span>
    );
  }
  if (st.err) return <button className="btn small" title={st.err} onClick={st.retry}><TriangleAlert size={12} /> {$t('重試')}</button>;
  return <span className="muted small"><CircleCheck size={12} /> {$t('完成')}</span>;
}

/** 自訂目標：框選 / 重新框選（在目前這一格加錨點）、清除 */
function BoxTargetRow({ clip }: { clip: Clip }) {
  const picking = useBoxPick((s) => s.clipId === clip.id);
  const anchors = clip.subject?.kind === 'box' ? clip.subject.anchors : [];
  const pick = () => (picking ? stopBoxPick() : startBoxPick(clip.id));
  return (
    <span className="matte-status">
      <button className={`btn small-h ${picking ? 'on-accent' : ''}`} onClick={pick}>
        <SquareDashedMousePointer size={12} /> {anchors.length ? $t('重新框選') : $t('框選目標')}
      </button>
      {anchors.length > 1 && <span className="muted small">{$t('錨點 {0}', anchors.length)}</span>}
      {anchors.length > 0 && (
        <button className="btn small-h" title={$t('清除')} onClick={() => useStore.getState().updateClip(clip.id, { subject: { kind: 'box', anchors: [] } })}>
          <Trash2 size={12} />
        </button>
      )}
    </span>
  );
}

/** AI 去背的計算進度 / 失敗重試 */
function MatteStatus({ clip, media }: { clip: Clip; media: Media }) {
  useMatte((s) => s.ver);
  const job = useMatte((s) => s.jobs[media.id]);
  const err = useMatte((s) => s.errors[media.id]);
  const modules = useStore((s) => s.modules);
  const map = useMemo(() => new Map(modules.map((m) => [m.id, m])), [modules]);
  const retry = () => {
    useMatte.setState({ errors: { ...useMatte.getState().errors, [media.id]: '' } });
    void ensureMatte(media, matteFrames(clip, media, map));
  };
  // 跟時間軸的進度條、預覽同一個算法：片段裡有多少比例已經有遮罩
  const cov = matteCoverage(clip, media, map, 100);
  let ready = 0;
  for (const v of cov) ready += v;
  if (ready === cov.length) return <span className="muted small"><CircleCheck size={12} /> {$t('完成')}</span>;
  if (err && !job) return <button className="btn small" title={err} onClick={retry}><TriangleAlert size={12} /> {$t('重試')}</button>;
  return (
    <span className="matte-status">
      <span className="matte-bar"><i style={{ width: `${ready}%` }} /></span>
      <span className="muted small">{ready}%</span>
    </span>
  );
}

/** 文字片段的內容與樣式 */
function textSection(clip: Clip & { text: TextStyle }): Section {
  // 靠左 / 靠右對齊時，改內容或樣式後對齊的那一邊不動
  const set = (p: Partial<TextStyle>) => updateText(clip.id, p);
  const t = clip.text;
  const sh = shadowOf(t);
  // 所在的影片軌有接收字幕 → 可以把設定套用到全部字幕
  const captioned = !useStore.getState().tracks.video[clip.track]?.noCaptions;
  return {
    id: 'text',
    title: $t('文字'),
    actions: (
      <>
        {captioned && <button className="ec-icon" title={$t('套用到全部字幕')} onClick={(e) => captionApplyMenu(e, clip.id)}><CopyCheck size={13} /></button>}
        <button className="ec-icon" title={$t('存成我的樣式')} onClick={() => saveTextStyle(clip.id)}><BookmarkPlus size={13} /></button>
      </>
    ),
    rows: [
      {
        label: $t('內容'),
        node: <textarea className="text-area" rows={Math.min(6, Math.max(1, t.text.split('\n').length))} value={t.text} onChange={(e) => set({ text: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />,
      },
      {
        label: $t('字型'),
        node: (
          <select className="select wide" value={t.font} onChange={(e) => set({ font: e.target.value })}>
            {!FONTS.some((f) => f.id === t.font) && <option value={t.font}>{t.font}</option>}
            {FONTS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
        ),
      },
      { label: $t('大小'), node: <DragNumber variant="text" value={t.size} min={8} max={600} step={1} decimals={0} suffix=" px" def={DEFAULT_TEXT.size} onChange={(v) => set({ size: Math.round(v) })} /> },
      { label: $t('填色'), node: <PaintEdit value={t.fill} onChange={(fill) => set({ fill })} /> },
      {
        label: $t('樣式'),
        node: (
          // 粗體 / 斜體（各自開關）跟對齊（三選一）分成兩組
          <div className="seg-group">
            <SegToggles className="small-seg" items={[
              { key: 'b', v: !!t.bold, on: (v) => set({ bold: v }), label: <Bold size={13} />, title: $t('粗體') },
              { key: 'i', v: !!t.italic, on: (v) => set({ italic: v }), label: <Italic size={13} />, title: $t('斜體') },
            ]} />
            <Seg className="small-seg" value={t.align ?? 'center'} on={(a) => set({ align: a })} opts={[
              { v: 'left' as const, label: <AlignLeft size={13} />, title: $t('靠左') },
              { v: 'center' as const, label: <AlignCenter size={13} />, title: $t('置中') },
              { v: 'right' as const, label: <AlignRight size={13} />, title: $t('靠右') },
            ]} />
          </div>
        ),
      },
      { label: $t('行高'), node: <DragNumber variant="text" value={t.lineHeight} min={0.6} max={3} step={0.05} def={DEFAULT_TEXT.lineHeight} onChange={(v) => set({ lineHeight: v })} /> },
      // 多層外框：第一層最靠近字，後面每一層接在前一層外面
      {
        label: $t('外框'),
        node: (
          <button className="btn small-h" disabled={t.strokes.length >= MAX_STROKES} onClick={() => set({ strokes: [...t.strokes, newStroke(t.strokes.length ? '#ffffff' : '#000000', 8)] })}>
            <Plus size={12} /> {$t('新增外框')}
          </button>
        ),
      },
      ...t.strokes.flatMap((k, i) => {
        const setK = (p: Partial<Stroke>) => set({ strokes: t.strokes.map((x, j) => (j === i ? { ...x, ...p } : x)) });
        return [
          {
            label: $t('外框 {0}', i + 1),
            node: (
              <div className="stroke-head">
                <PaintEdit value={k.paint} onChange={(paint) => setK({ paint })} />
                <button className="ec-icon danger" title={$t('移除外框')} onClick={() => set({ strokes: t.strokes.filter((_, j) => j !== i) })}><Trash2 size={13} /></button>
              </div>
            ),
          },
          {
            label: $t('粗細 / 轉角'),
            node: (
              <div className="stroke-head">
                <DragNumber variant="text" value={k.width} min={0} max={60} step={0.5} suffix=" px" def={8} onChange={(width) => setK({ width })} />
                <select className="select" value={k.join} onChange={(e) => setK({ join: e.target.value as Stroke['join'] })}>
                  <option value="round">{$t('圓角')}</option>
                  <option value="miter">{$t('尖角')}</option>
                  <option value="bevel">{$t('斜切')}</option>
                </select>
              </div>
            ),
          },
        ];
      }),
      { label: $t('底框顏色'), node: <input type="color" className="color" value={t.bg} onChange={(e) => set({ bg: e.target.value })} /> },
      { label: $t('底框不透明度'), node: <DragNumber variant="text" value={t.bgOpacity} min={0} max={1} step={0.01} display={100} suffix="%" def={0} onChange={(v) => set({ bgOpacity: v })} /> },
      { label: $t('陰影'), node: <Switch v={!!sh} on={(v) => set({ shadow: v ? defaultShadow(t.size) : null })} /> },
      ...(sh
        ? (() => {
            const setSh = (p: Partial<Shadow>) => set({ shadow: { ...sh, ...p } });
            return [
              { label: $t('陰影顏色'), node: <input type="color" className="color" value={sh.color} onChange={(e) => setSh({ color: e.target.value })} /> },
              { label: $t('陰影不透明度'), node: <DragNumber variant="text" value={sh.opacity} min={0} max={1} step={0.01} display={100} suffix="%" def={0.8} onChange={(opacity) => setSh({ opacity })} /> },
              { label: $t('陰影角度'), node: <DragNumber variant="text" value={sh.angle} min={-360} max={360} step={1} decimals={0} suffix="°" def={90} onChange={(v) => setSh({ angle: Math.round(v) })} /> },
              { label: $t('陰影距離'), node: <DragNumber variant="text" value={sh.distance} min={0} max={200} step={0.5} suffix=" px" def={defaultShadow(t.size).distance} onChange={(distance) => setSh({ distance })} /> },
              { label: $t('陰影模糊'), node: <DragNumber variant="text" value={sh.blur} min={0} max={200} step={0.5} suffix=" px" def={defaultShadow(t.size).blur} onChange={(blur) => setSh({ blur })} /> },
            ];
          })()
        : []),
    ],
    onReset: () => set({ ...DEFAULT_TEXT, text: t.text }),
  };
}

function ClipInspector({ id }: { id: string }) {
  useMaskEdit((s) => s.key); // 遮罩「在預覽中編輯」狀態改變時重畫
  const clip = useStore((s) => s.clips.find((c) => c.id === id));
  const media = useStore((s) => s.media.find((m) => m.id === clip?.mediaId));
  const remapMod = useStore((s) => s.modules.find((m) => m.id === clip?.remap.moduleId));
  const time = useStore((s) => s.time);
  const modules = useStore((s) => s.modules);
  // 連結的音訊也要訂閱：只改音訊（音量、保持音調…）時片段本身沒變，不訂閱的話面板不會重畫
  const linkedAudio = useStore((s) => (clip?.link ? s.audios.find((a) => a.link === clip.link) : undefined));
  if (!clip) return null;
  const { updateClip } = useStore.getState();
  const host = clipHost(clip.id)!;
  const local = Math.min(clip.duration, Math.max(0, time - clip.start));
  const nowLocal = () => Math.min(clip.duration, Math.max(0, useStore.getState().time - clip.start));
  // 數值欄右鍵「套用到同軌」（等比例縮放時 X / Y 一起）
  const chs = clipChannels(clip, local).map((c) => ({ ...c, menu: clipPropMenu(clip.id, [c.id, ...(c.partner ? [c.partner.id] : [])] as AnimProp[], nowLocal) }));
  const isText = !!clip.text;
  const isVideo = !isText && media?.kind === 'video';

  /** 改速度參數時，長度與關鍵影格一起縮放（2× → 長度減半） */
  const onRemapParams = (p: ParamValues) => {
    if (clip.remap.moduleId === 'remap-speed') {
      const oldSp = Number(clip.remap.params.speed ?? 1);
      const newSp = Number(p.speed ?? 1);
      if (newSp > 0 && Math.abs(newSp - oldSp) > 1e-6) {
        const s = oldSp / newSp;
        const keys = Object.fromEntries(Object.entries(clip.keys).map(([k, l]) => [k, l!.map((x) => ({ ...x, t: x.t * s }))]));
        // 變慢會變長：最多長到下一個片段開頭（同軌不能重疊）
        return updateClip(clip.id, { remap: { ...clip.remap, params: p }, duration: Math.min(clip.duration * s, maxDurFor('clip', clip)), keys });
      }
    }
    updateClip(clip.id, { remap: { ...clip.remap, params: p } });
  };

  // 圖片 / 色板 / 文字的長度可以直接改（最多到同軌下一個片段）
  const still = isText || media?.kind === 'image';
  const setDur = still ? (v: number) => updateClip(clip.id, { duration: Math.max(0.05, Math.min(v, maxDurFor('clip', clip))) }) : undefined;
  const sections: Section[] = [
    { id: 'info', title: $t('資訊'), rows: infoRows(clip, isText ? undefined : media, setDur) },
    ...(isText ? [textSection(clip as Clip & { text: TextStyle })] : []),
    {
      id: 'motion',
      title: $t('運動'),
      menu: () => clipGroupMenu(clip.id, 'motion'),
      channels: chs.filter((c) => c.id !== 'opacity'),
      // 等比例縮放開關（鎖上：改縮放 X / Y 其中一個，另一個依比例跟著變；縮放可以是負數 = 翻轉）
      actions: (
        <button
          className={`ec-icon ${clip.scaleUnlinked ? '' : 'on'}`}
          title={clip.scaleUnlinked ? $t('縮放 X / Y 各自調整（點一下改成等比例）') : $t('等比例縮放（點一下讓 X / Y 各自調整）')}
          onClick={() => updateClip(clip.id, { scaleUnlinked: !clip.scaleUnlinked || undefined })}
        >
          {clip.scaleUnlinked ? <Unlink2 size={13} /> : <Link2 size={13} />}
        </button>
      ),
      onReset: () => {
        const keys = { ...clip.keys };
        delete keys.x; delete keys.y; delete keys.scaleX; delete keys.scaleY; delete keys.rotation;
        updateClip(clip.id, { keys, transform: { ...clip.transform, x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 } });
      },
    },
    {
      id: 'opacity',
      title: $t('不透明度'),
      menu: () => clipGroupMenu(clip.id, 'opacity'),
      channels: chs.filter((c) => c.id === 'opacity'),
      rows: [
        {
          label: $t('混合模式'),
          node: (
            <select className="select" value={clip.blend ?? 'normal'} onChange={(e) => updateClip(clip.id, { blend: e.target.value === 'normal' ? undefined : (e.target.value as BlendMode) })}>
              {Object.entries(BLENDS()).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          ),
        },
      ],
      onReset: () => {
        const keys = { ...clip.keys };
        delete keys.opacity;
        updateClip(clip.id, { keys, blend: undefined, transform: { ...clip.transform, opacity: 1 } });
      },
    },
  ];
  if (!isText) sections.push(
    {
      id: 'frame',
      title: $t('畫面'),
      menu: () => clipGroupMenu(clip.id, 'frame'),
      rows: [
        {
          label: $t('填滿模式'),
          node: (
            <select className="select" value={clip.fit} onChange={(e) => updateClip(clip.id, { fit: e.target.value as Fit })}>
              {Object.entries(FITS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          ),
        },
      ],
      onReset: () => updateClip(clip.id, { fit: 'cover', flipX: false, transform: { ...DEFAULT_TRANSFORM }, keys: {} }),
    },
  );
  sections.push(clipMaskSection(clip, local));
  if (!isText && media && (media.kind === 'video' || media.kind === 'image')) sections.push({
    id: 'matte',
    title: $t('AI 去背'),
    rows: [
      { label: $t('啟用'), node: <Switch v={!!clip.aiMatte} on={(v) => updateClip(clip.id, { aiMatte: v || undefined })} /> },
      ...(clip.aiMatte ? [{ label: $t('狀態'), node: <MatteStatus clip={clip} media={media} /> }] : []),
    ],
    onReset: () => updateClip(clip.id, { aiMatte: undefined }),
  });
  if (!isText && media && (media.kind === 'video' || media.kind === 'image')) {
    const setKind = (k: string) => {
      const subject: Subject | undefined = k === 'face' ? { kind: 'face' } : k === 'box' ? { kind: 'box', anchors: clip.subject?.kind === 'box' ? clip.subject.anchors : [] } : undefined;
      updateClip(clip.id, { subject });
      if (subject?.kind === 'box' && !subject.anchors.length) startBoxPick(clip.id);
      else stopBoxPick();
    };
    sections.push({
      id: 'track',
      title: $t('追蹤'),
      rows: [
        {
          label: $t('對象'),
          node: (
            <select className="select" value={clip.subject?.kind ?? ''} onChange={(e) => setKind(e.target.value)}>
              <option value="">{$t('無')}</option>
              <option value="face">{$t('臉部')}</option>
              <option value="box">{$t('自訂')}</option>
            </select>
          ),
        },
        ...(clip.subject?.kind === 'box' ? [{ label: $t('目標'), node: <BoxTargetRow clip={clip} /> }] : []),
        ...(tracking(clip) ? [{ label: $t('狀態'), node: <TrackStatus clip={clip} media={media} /> }] : []),
      ],
      onReset: () => (updateClip(clip.id, { subject: undefined }), stopBoxPick()),
    });
  }

  if (isVideo && remapMod && clip.remap.moduleId === CURVE_ID) {
    // 曲線模式：素材時間本身是一條關鍵影格曲線（往上正播、往下倒播、平的定格）
    const saveCurve = async () => {
      const keys = useStore.getState().clips.find((c) => c.id === clip.id)?.remap.keys ?? [];
      if (keys.length < 2) return toast($t('曲線至少要兩個關鍵影格'), 'error');
      const name = await promptDialog({ title: $t('存到素材庫'), value: $t('自訂曲線') });
      if (!name?.trim()) return;
      useStore.getState().createModule('remap', { name: name.trim(), code: curveCode(keysToCurve(keys, clip.duration)) });
      toast($t('已存到素材庫'));
    };
    sections.push({
      id: 'speed',
      title: $t('速度 / 時間重映射'),
      channels: [curveChannel(clip, media, local)],
      rows: [
        { label: $t('模式'), node: <RemapPick clip={clip} /> },
        { label: '', node: <button className="btn small-h" title={$t('把這條曲線存成變速素材，可以套用到其他片段')} onClick={saveCurve}><Plus size={12} /> {$t('存到素材庫')}</button> },
      ],
      onReset: () => updateClip(clip.id, { remap: { moduleId: CURVE_ID, params: {}, keys: defaultCurveKeys(clip.duration) } }),
    });
  } else if (isVideo && remapMod) {
    const defs = parseParams(remapMod.code);
    sections.push({
      id: 'speed',
      title: $t('速度 / 時間重映射'),
      rows: [
        { label: $t('模式'), node: <RemapPick clip={clip} /> },
        ...paramRows(defs, clip.remap.params, onRemapParams),
        ...(clip.remap.moduleId !== 'remap-speed'
          ? [{ label: $t('整體速率'), node: <DragNumber variant="text" value={clip.rate ?? 1} min={0.05} max={16} step={0.01} def={1} suffix="×" onChange={(v) => updateClip(clip.id, { rate: v })} /> }]
          : []),
      ],
      footer: <ModuleCode module={remapMod} onFork={(nid) => updateClip(clip.id, { remap: { ...clip.remap, moduleId: nid } })} />,
    });
  }
  const la = linkedAudio;
  if (isVideo && la) {
    // 連結的音訊跟影片是一體的：音量 / 淡入淡出直接在這裡調
    const { updateAudio } = useStore.getState();
    sections.push({
      id: 'sound',
      title: $t('聲音'),
      rows: [
        { label: $t('音量'), node: <DragNumber variant="text" value={la.volume} min={0} max={1} step={0.01} display={100} suffix="%" def={1} onChange={(v) => updateAudio(la.id, { volume: v })} /> },
        { label: $t('淡入'), node: <DragNumber variant="text" value={la.fadeIn} min={0} max={Math.min(10, la.duration)} step={0.01} suffix="s" def={0} onChange={(v) => updateAudio(la.id, { fadeIn: v })} /> },
        { label: $t('淡出'), node: <DragNumber variant="text" value={la.fadeOut} min={0} max={Math.min(10, la.duration)} step={0.01} suffix="s" def={0} onChange={(v) => updateAudio(la.id, { fadeOut: v })} /> },
        { label: $t('保持音調'), node: <PitchSwitch v={la.keepPitch !== false} on={(v) => updateAudio(la.id, { keepPitch: v })} /> },
        {
          label: '',
          node: (
            <button className="btn small-h" onClick={() => useStore.getState().unlinkSelected()} title={$t('把聲音分開成獨立的音訊片段')}>
              <Unlink size={12} /> {$t('取消影音連結')}
            </button>
          ),
        },
      ],
    });
  } else if (isVideo && media?.hasAudio && !clip.audioSplit) {
    const ok = plainSpeed(clip, new Map(modules.map((m) => [m.id, m]))) !== null;
    sections.push({
      id: 'sound',
      title: $t('聲音'),
      rows: [
        { label: $t('音量'), node: <DragNumber variant="text" value={clip.volume} min={0} max={1} step={0.01} display={100} suffix="%" def={1} onChange={(v) => updateClip(clip.id, { volume: v })} /> },
        { label: $t('保持音調'), node: <PitchSwitch v={clip.keepPitch !== false} on={(v) => updateClip(clip.id, { keepPitch: v })} /> },
        ...(!ok ? [{ label: '', node: <span className="muted small">{$t('目前的時間重映射不播放原音')}</span> }] : []),
      ],
    });
  }

  sections.push(...clipFxSections(clip, modules, local));
  return (
    <EffectControls
      host={host}
      sections={sections}
      extra={<AddClipFx clipId={clip.id} />}
      titleMenu={() => clipTitleMenu(clip.id)}
      title={
        <Title
          kind={isText ? 'k-text' : 'k-clip'}
          label={isText ? $t('文字') : $t('片段')}
          name={itemName('clip', clip, useStore.getState().media, modules)}
          onRename={(n) => useStore.getState().renameItem('clip', clip.id, n)}
        />
      }
    />
  );
}

type FxLike = { moduleId: string; params: ParamValues; keys?: Record<string, Keyframe[]>; mask?: Mask; audio?: Record<string, AudioDrive>; follow?: FollowMap };

/** 遮罩的屬性列：形狀（＋繪製）、在預覽中編輯、反轉，以及位置 / 大小等可打關鍵影格的屬性 */
function maskBlock(
  f: FxLike,
  local: number,
  update: (p: Partial<FxLike>) => void,
  o: { fresh: () => FxLike | undefined; editKey?: string; drawKey?: string; ch: (id: string) => string },
) {
  const mask = { ...DEFAULT_MASK, ...f.mask };
  const setMask = (p: Partial<typeof mask>) => update({ mask: { ...mask, ...p } });
  // 片段特效的遮罩要按「在預覽中編輯」才會出現可拖曳的框（避免跟片段本身的變換框打架）
  const editKey = o.editKey;
  const editing = !editKey || useMaskEdit.getState().key === editKey;
  // 「在預覽中編輯」：切換這個遮罩在預覽畫面上的編輯框（編輯時片段本身的變換框先藏起來）
  const toggleEdit = () => {
    if (!editKey) return;
    useMaskEdit.setState({ key: useMaskEdit.getState().key === editKey ? null : editKey });
  };
  const maskRows = [
    {
      label: $t('遮罩'),
      node: (
        <div className="shape-pick-row">
          <button
            className="shape-pick"
            title={$t('選擇遮罩形狀')}
            onClick={(e) =>
              openPicker(e.currentTarget, $t('遮罩形狀'), () => (
                <MaskLibrary
                  current={o.fresh()?.mask?.shape ?? 'none'}
                  allowNone
                  drawKey={o.drawKey}
                  onPick={(sh) => {
                    setMaskShape({ ...DEFAULT_MASK, ...o.fresh()?.mask }, sh, update);
                    if (sh !== 'none' && editKey) useMaskEdit.setState({ key: editKey });
                  }}
                />
              ))
            }
          >
            <ShapeThumb id={mask.shape} path={mask.path} />
            <span className="shape-pick-name">{shapeName(mask.shape)}</span>
            <ChevronDown size={12} />
          </button>
        {o.drawKey && (
          <button className="ec-icon shape-draw" title={$t('在畫面上繪製')} onClick={() => openShapeDrawer({ target: o.drawKey })}>
            <PenTool size={13} />
          </button>
        )}
        </div>
      ),
    },
    ...(mask.shape !== 'none' && editKey
      ? [{
          label: $t('預覽'),
          node: (
            <button className={`btn small-h ${editing ? 'on-accent' : ''}`} onClick={toggleEdit} title={$t('在預覽畫面上直接拖曳調整遮罩')}>
              <SquareDashedMousePointer size={12} /> {editing ? $t('編輯中') : $t('在預覽中編輯')}
            </button>
          ),
        }]
      : []),
    ...(mask.shape !== 'none'
      ? [
          { label: $t('反轉'), node: <Switch v={mask.invert} on={(v) => setMask({ invert: v })} /> },
        ]
      : []),
  ];
  const chs = mask.shape !== 'none' ? maskChannels(f as FxItem, local).map((c) => ({ ...c, id: o.ch(c.id) })) : [];
  const reset = () => update({ mask: undefined, keys: Object.fromEntries(Object.entries(f.keys ?? {}).filter(([k]) => !k.startsWith('mask.'))) });
  return { rows: maskRows, chs, reset };
}

/**
 * 一個特效的屬性區塊：參數（含音訊反應）、遮罩。特效軌的特效與片段特效共用。
 * compact：遮罩併進參數區塊（片段特效用，比較不佔空間）
 */
function effectSections(
  f: FxLike,
  mod: Module | undefined,
  local: number,
  update: (p: Partial<FxLike>) => void,
  o: { idBase: string; /** 從 store 拿最新的（挑選視窗開著時資料會變） */ fresh: () => FxLike | undefined; maskKey?: string; drawKey?: string; ch?: (id: string) => string; compact?: boolean; /** 這個特效是誰（右鍵「套用到相同特效」用） */ owner?: FxOwner; title?: string; actions?: React.ReactNode; badge?: React.ReactNode; dim?: boolean; onFork?: (id: string) => void; sampleColor?: boolean; /** 看的片段有追蹤：point 參數可以跟隨目標 */ tracking?: boolean; /** 加在主區塊最上面的列（特效軌方塊的追蹤軌道） */ topRows?: { label: string; node: React.ReactNode }[] },
): Section[] {
  const ch = o.ch ?? ((x: string) => x);
  const mapCh = (l: Channel[]) => l.map((c) => ({ ...c, id: ch(c.id) }));
  const defs = mod ? parseParams(mod.code) : [];
  const other = defs.filter((d) => d.type === 'bool' || d.type === 'color' || d.type === 'curve');
  const name = o.title ?? (mod ? displayName(mod.name) : $t('特效'));
  const { rows: maskRows, chs: maskChs, reset: resetMask } = maskBlock(f, local, update, { fresh: o.fresh, editKey: o.maskKey, drawKey: o.drawKey, ch });
  // 右鍵「套用到相同特效」：套用播放頭位置的值（point 參數兩軸一起）
  const owner = o.owner;
  const menuFor = (paramName: string) => {
    const d = defs.find((x) => x.name === paramName);
    if (!owner || !d) return undefined;
    return fxParamMenu(owner, d.name, () => {
      const cur = o.fresh() ?? f;
      return paramAt(d, resolveParams(defs, cur.params), cur.keys, local);
    });
  };
  // 挑選視窗開著時資料會變：一律以 store 裡最新的為準
  const setDrive = (n: string, v: AudioDrive | null) => {
    const cur = { ...((o.fresh() ?? f).audio ?? {}) };
    if (v) cur[n] = v;
    else delete cur[n];
    update({ audio: Object.keys(cur).length ? cur : undefined });
  };
  // 跟隨目標（看的片段有追蹤時）：模組標了 @follow 的 point 參數有開關，打開時不顯示 X / Y（位置跟著目標，拖預覽上的點調偏移）；
  // 沒標的 point 參數可以從右鍵打開
  const followable = o.tracking ? defs.filter((d) => d.type === 'point' && !d.fit && (d.follow || f.follow?.[d.name])) : [];
  // 跟著目標的點，和跟著它的範圍（@fit）：X / Y 都不顯示
  const following = new Set([...followable.filter((d) => followOf(d, f.follow)), ...(o.tracking ? defs.filter((d) => fitOf(d, defs, f.follow)) : [])].map((d) => d.name));
  const followRows = followable.map((d) => ({
    label: followable.length > 1 ? `${$t('跟隨目標')} · ${$t(d.label)}` : $t('跟隨目標'),
    node: <FollowSwitch on={following.has(d.name)} set={(v) => update({ follow: { ...(f.follow ?? {}), [d.name]: v ? { ...(f.follow?.[d.name] ?? {}) } : null } })} reset={followReset(d, f.follow)} apply={(m) => update({ follow: m })} />,
  }));
  const withMenu = (l: Channel[]) =>
    l
      .filter((c) => !following.has(parsePointCh(c.id)?.name ?? ''))
      .map((c) => {
        const name = parsePointCh(c.id)?.name ?? c.id;
        const d = defs.find((x) => x.name === name);
        const fm = d && o.tracking ? followMenu(d, f.follow, (m) => update({ follow: m })) : [];
        const dr = f.audio?.[name];
        const fresh = () => (o.fresh() ?? f).audio?.[name];
        const st = d?.type === 'int' ? 1 : d ? (d.max - d.min) / 200 || 0.01 : 0.01;
        const drive: Channel['drive'] = d && isNumeric(d) ? {
          on: !!dr,
          toggle: () => setDrive(name, fresh() ? null : { source: 'level', min: Number(d.def), max: d.max }),
          rows: dr ? [
            {
              label: $t('訊號'),
              node: <select className="select drive-pick" value={dr.source} onChange={(e) => { const x = fresh(); if (x) setDrive(name, { ...x, source: e.target.value as AudioDrive['source'] }); }}>
                <option value="level">{$t('跟著音量')}</option>
                <option value="beat">{$t('跟著節拍')}</option>
              </select>,
            },
            {
              label: $t('範圍'),
              node: <div className="drive-row">
                <DragNumber variant="text" value={dr.min} step={st} onChange={(v) => { const x = fresh(); if (x) setDrive(name, { ...x, min: v }); }} />
                <span className="muted">→</span>
                <DragNumber variant="text" value={dr.max} step={st} onChange={(v) => { const x = fresh(); if (x) setDrive(name, { ...x, max: v }); }} />
              </div>,
            },
            {
              label: $t('來源'),
              node: <SourcePick from={dr.from} title={`${$t(d.label)} · ${$t('來源')}`}
                body={() => <DriveSourceBody from={fresh()?.from} set={(from) => { const x = fresh(); if (x) setDrive(name, from ? { ...x, from } : (({ from: _, ...rest }) => rest)(x)); }} />} />,
            },
          ] : [],
        } : undefined;
        return { ...c, menu: [...fm, ...(menuFor(name) ?? [])], drive };
      });

  const sections: Section[] = [
    {
      id: `${o.idBase}`,
      title: name,
      badge: o.badge,
      actions: o.actions,
      dim: o.dim,
      menu: owner ? () => fxTitleMenu(owner) : undefined,
      rows: [...(o.topRows ?? []), ...followRows, ...paramRows(other, f.params, (p) => update({ params: p }), o.sampleColor, (d) => menuFor(d.name) ?? []), ...(o.compact ? maskRows : [])],
      channels: [...(mod ? mapCh(withMenu(fxChannels(f as FxItem, mod.code, local))) : []), ...(o.compact ? maskChs : [])],
      onReset: () => update({ params: {}, keys: {}, audio: undefined, ...(o.compact ? { mask: undefined } : {}) }),
      footer: (
        <>
          {mod && <ModuleCode module={mod} onFork={(nid) => (o.onFork ?? ((x: string) => update({ moduleId: x })))(nid)} />}
        </>
      ),
    },
  ];
  if (!o.compact) {
    sections.push({ id: `${o.idBase}.mask`, title: $t('遮罩'), rows: [{ ...maskRows[0], label: $t('形狀') }, ...maskRows.slice(1)], channels: maskChs, onReset: resetMask });
  }
  return sections;
}

/** 音訊反應的來源：顯示目前聽哪些軌道，按了打開小視窗挑（跟遮罩形狀、變速一樣） */
function SourcePick({ from, title, body }: { from: AudioFrom | undefined; title: string; body: () => React.ReactNode }) {
  const label = hasFrom(from)
    ? [...(from.audio ?? []).map((i) => $t('音訊 {0}', i + 1)), ...(from.video ?? []).map((i) => $t('影片 {0}', i + 1))].join('、')
    : $t('全部');
  return (
    <button className="shape-pick drive-pick" title={label} onClick={(e) => openPicker(e.currentTarget, title, body, { w: 220 })}>
      <span className="shape-pick-name">{label}</span>
      <ChevronDown size={12} />
    </button>
  );
}

/** 來源挑選視窗：全部，或勾選音訊軌 / 影片軌（影片片段本身的聲音），可以多選 */
function DriveSourceBody({ from, set }: { from: AudioFrom | undefined; set: (f: AudioFrom | undefined) => void }) {
  const tracks = useStore((s) => s.tracks);
  const flip = (kind: 'audio' | 'video', i: number) => {
    const cur = from?.[kind] ?? [];
    const l = cur.includes(i) ? cur.filter((x) => x !== i) : [...cur, i].sort((a, b) => a - b);
    const next: AudioFrom = { ...from, [kind]: l.length ? l : undefined };
    set(hasFrom(next) ? next : undefined);
  };
  return (
    <div className="src-pick">
      <Check v={!hasFrom(from)} on={() => set(undefined)}>{$t('全部')}</Check>
      <div className="src-pick-title">{$t('音訊軌')}</div>
      {tracks.audio.map((_, i) => <Check key={`a${i}`} v={!!from?.audio?.includes(i)} on={() => flip('audio', i)}>{$t('音訊 {0}', i + 1)}</Check>)}
      <div className="src-pick-title">{$t('影片軌')}</div>
      {tracks.video.map((_, i) => <Check key={`v${i}`} v={!!from?.video?.includes(i)} on={() => flip('video', i)}>{$t('影片 {0}', i + 1)}</Check>)}
    </div>
  );
}

/** 片段本身的遮罩（一個，排在所有片段特效之後；要疊更多遮罩用「加入片段遮罩…」） */
function clipMaskSection(clip: Clip, local: number): Section {
  const S = useStore.getState();
  const base = clip.effects?.find((f) => f.base);
  const fresh = () => useStore.getState().clips.find((c) => c.id === clip.id)?.effects?.find((x) => x.base);
  const update = (p: Partial<FxLike>) => {
    const id = fresh()?.id ?? ensureClipBaseMask(clip.id);
    if (id) S.updateClipFx(clip.id, id, p as Partial<ClipFx>);
  };
  const f: FxLike = base ?? { moduleId: CLIP_MASK_ID, params: {} };
  const key = base ? cfxMaskKey(base.id) : undefined;
  const { rows, chs } = maskBlock(f, local, update, {
    fresh,
    editKey: key,
    drawKey: key ?? `clip:${clip.id}`,
    ch: (c) => (base ? cfxCh(base.id, c) : c),
  });
  return { id: 'clipmask', title: $t('遮罩'), rows: [{ ...rows[0], label: $t('形狀') }, ...rows.slice(1)], channels: chs, onReset: () => {
    if (base) S.removeClipFx(clip.id, base.id);
  } };
}

/** 片段特效的區塊（每個特效一組，可以開關、排序、移除） */
function clipFxSections(clip: Clip, modules: Module[], local: number): Section[] {
  const S = useStore.getState();
  const list = (clip.effects ?? []).filter((f) => !f.base);
  return list.flatMap((f, i) => {
    const mod = modules.find((m) => m.id === f.moduleId);
    const off = f.enabled === false;
    const fresh = () => useStore.getState().clips.find((c) => c.id === clip.id)?.effects?.find((x) => x.id === f.id);
    const secs = effectSections(f, mod, local, (p) => S.updateClipFx(clip.id, f.id, p as Partial<ClipFx>), {
      idBase: `cfx.${f.id}`,
      fresh: () => useStore.getState().clips.find((c) => c.id === clip.id)?.effects?.find((x) => x.id === f.id),
      maskKey: cfxMaskKey(f.id),
      drawKey: cfxMaskKey(f.id),
      ch: (c) => cfxCh(f.id, c),
      compact: true,
      tracking: tracking(clip),
      owner: { kind: 'cfx', clipId: clip.id, id: f.id },
      sampleColor: mod?.id === 'fx-chromakey',
      dim: off,
      badge: <span className="kind k-fx cfx-badge">{$t('片段特效')} {i + 1}</span>,
      actions: (
        <>
          <button className="ec-icon" title={off ? $t('開啟這個特效') : $t('暫時關閉這個特效')} onClick={() => S.updateClipFx(clip.id, f.id, { enabled: off })}>
            {off ? <EyeOff size={13} /> : <Eye size={13} />}
          </button>
          <button className="ec-icon" title={$t('往上移（先套用）')} disabled={i === 0} onClick={() => S.moveClipFx(clip.id, f.id, -1)}><ChevronUp size={13} /></button>
          <button className="ec-icon" title={$t('往下移（後套用）')} disabled={i === list.length - 1} onClick={() => S.moveClipFx(clip.id, f.id, 1)}><ChevronDown size={13} /></button>
          <button className="ec-icon danger" title={$t('移除這個特效')} onClick={() => S.removeClipFx(clip.id, f.id)}><Trash2 size={13} /></button>
        </>
      ),
    });
    secs[0].timing = {
      id: `${clip.id}:${f.id}`,
      get: () => fresh()?.timing,
      set: (v) => useStore.getState().updateClipFx(clip.id, f.id, { timing: v }),
      start: clip.start,
      defD: mod ? parseDuration(mod.code, 0.5) : 0.5,
      len: clip.duration,
    };
    return secs;
  });
}

/** 「加入片段特效」/「加入片段遮罩」：打開挑選視窗（跟特效 / 遮罩分頁同一套素材庫） */
function AddClipFx({ clipId }: { clipId: string }) {
  return (
    <div className="ec-row add-cfx-row">
      <div className="ec-left ec-plain">
        <div className="btn-row cfx-add-row">
          <button
            className="btn small-h"
            title={$t('從特效庫挑一個特效，套用在這個片段上')}
            onClick={(e) => openPicker(e.currentTarget, $t('加入片段特效'), (close) => <ModuleLibrary kind="effect" onPick={(id) => { useStore.getState().addClipFx(clipId, id); close(); }} />)}
          >
            <Sparkles size={12} /> {$t('加入片段特效…')}
          </button>
          <button
            className="btn small-h"
            title={$t('加入片段遮罩：只保留遮罩範圍內的畫面')}
            onClick={(e) => openPicker(e.currentTarget, $t('加入片段遮罩'), (close) => <MaskLibrary onPick={(sh) => { close(); addClipMask(clipId, sh); }} />)}
          >
            <SquareDashed size={12} /> {$t('加入片段遮罩…')}
          </button>
        </div>
      </div>
      <div className="ec-right ec-dim" />
    </div>
  );
}

/** 把特效方塊（主特效 + 疊加 + 觸發 + 遮罩、長度）存成「我的組合」 */
async function saveFxCombo(fxId: string) {
  const f = useStore.getState().effects.find((e) => e.id === fxId);
  if (!f) return;
  const name = await promptDialog({ title: $t('存成組合'), value: itemName('effect', f, [], useStore.getState().modules) });
  if (!name?.trim()) return;
  const { id: _id, start: _s, track: _t, group: _g, name: _n, ...rest } = structuredClone(f);
  const P = usePrefs.getState();
  P.set({ fxCombos: [...P.fxCombos, { id: COMBO_PREFIX + uid(), name: name.trim(), fx: rest }] });
  toast($t('已存成組合'));
}

/** 特效方塊裡疊加的特效（跟片段特效一樣：開關、上下移、移除） */
function stackSections(fx: FxItem, modules: Module[], local: number): Section[] {
  const list = fx.stack ?? [];
  const setList = (l: ClipFx[]) => useStore.getState().updateEffect(fx.id, { stack: l.length ? l : undefined });
  const cur = () => useStore.getState().effects.find((e) => e.id === fx.id)?.stack ?? [];
  const move = (sid: string, dir: -1 | 1) => {
    const l = [...cur()];
    const i = l.findIndex((x) => x.id === sid);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= l.length) return;
    [l[i], l[j]] = [l[j], l[i]];
    setList(l);
  };
  return list.flatMap((f, i) => {
    const mod = modules.find((m) => m.id === f.moduleId);
    const off = f.enabled === false;
    return effectSections(f, mod, local, (p) => updateStackFx(fx.id, f.id, p as Partial<ClipFx>), {
      tracking: true,
      idBase: `sfx.${f.id}`,
      fresh: () => cur().find((x) => x.id === f.id),
      ch: (c) => cfxCh(f.id, c),
      compact: true,
      dim: off,
      badge: <span className="kind k-fx cfx-badge">{$t('疊加')} {i + 1}</span>,
      onFork: (nid) => updateStackFx(fx.id, f.id, { moduleId: nid }),
      actions: (
        <>
          <button className="ec-icon" title={off ? $t('開啟這個特效') : $t('暫時關閉這個特效')} onClick={() => updateStackFx(fx.id, f.id, { enabled: off ? undefined : false })}>
            {off ? <EyeOff size={13} /> : <Eye size={13} />}
          </button>
          <button className="ec-icon" title={$t('往上移（先套用）')} disabled={i === 0} onClick={() => move(f.id, -1)}><ChevronUp size={13} /></button>
          <button className="ec-icon" title={$t('往下移（後套用）')} disabled={i === list.length - 1} onClick={() => move(f.id, 1)}><ChevronDown size={13} /></button>
          <button className="ec-icon danger" title={$t('移除這個特效')} onClick={() => setList(cur().filter((x) => x.id !== f.id))}><Trash2 size={13} /></button>
        </>
      ),
    });
  });
}

/** 特效方塊：「加入特效…」疊加到這個方塊上 */
function AddStackFx({ fxId }: { fxId: string }) {
  const add = (moduleId: string) => {
    const f = useStore.getState().effects.find((e) => e.id === fxId);
    if (f) useStore.getState().updateEffect(fxId, { stack: [...(f.stack ?? []), { id: uid(), moduleId, params: {} }] });
  };
  return (
    <div className="ec-row add-cfx-row">
      <div className="ec-left ec-plain">
        <div className="btn-row cfx-add-row">
          <button
            className="btn small-h"
            title={$t('從特效庫挑一個特效，疊加在這個方塊上')}
            onClick={(e) => openPicker(e.currentTarget, $t('加入特效'), (close) => <ModuleLibrary kind="effect" onPick={(id) => { add(id); close(); }} />)}
          >
            <Sparkles size={12} /> {$t('加入特效…')}
          </button>
        </div>
      </div>
      <div className="ec-right ec-dim" />
    </div>
  );
}

/** 特效軌方塊（含疊加的特效）有沒有可以跟隨目標的 point 參數 */
function blockFollowable(fx: FxItem): boolean {
  const mods = useStore.getState().modules;
  return [fx, ...(fx.stack ?? [])].some((f) => {
    const m = mods.find((x) => x.id === f.moduleId);
    return !!m && parseParams(m.code).some((d) => d.type === 'point' && !d.fit && (d.follow || f.follow?.[d.name]));
  });
}

/**
 * 特效軌方塊：跟隨目標要看哪一條影片軌（自動 = 下面最上層有追蹤的片段）。
 * 有可以跟隨的參數就一直顯示（不管底下現在有沒有開了追蹤的片段，沒有就只是沒效果）。
 */
function subjectFromRows(fx: FxItem): { label: string; node: React.ReactNode }[] {
  if (!blockFollowable(fx)) return [];
  const s = useStore.getState();
  const lv = fxLevel(s.tracks, fx.track);
  const set = (v: string) => useStore.getState().updateEffect(fx.id, { subjectFrom: v === '' ? undefined : Number(v) });
  return [{
    label: $t('追蹤軌道'),
    node: (
      <select className="select" value={fx.subjectFrom ?? ''} onChange={(e) => set(e.target.value)}>
        <option value="">{$t('自動')}</option>
        {s.tracks.video.slice(0, lv).map((_, i) => <option key={i} value={i}>{$t('影片 {0}', i + 1)}</option>).reverse()}
      </select>
    ),
  }];
}

/** 「每個剪接點」看哪幾條影片軌：沒設定 = 這條特效軌下面的全部 */
function CutTrackPick({ fx }: { fx: FxItem }) {
  const tracks = useStore((s) => s.tracks);
  const on = cutTracks(fx, tracks);
  const toggle = (i: number) => {
    const next = on.includes(i) ? on.filter((x) => x !== i) : [...on, i].sort((a, b) => a - b);
    useStore.getState().updateEffect(fx.id, { trigger: { kind: 'cut', tracks: next } });
  };
  return (
    <SegToggles className="cut-tracks" items={tracks.video.map((_, i) => ({ key: String(i), v: on.includes(i), on: () => toggle(i), label: i + 1, title: $t('影片 {0}', i + 1) }))} />
  );
}

/** 轉場方塊：範圍內選定影片軌的每個剪接點自動套用這個轉場（片段自己有轉場的優先） */
function TransitionBlockInspector({ fx }: { fx: FxItem }) {
  const mod = useStore((s) => s.modules.find((m) => m.id === fx.moduleId));
  const { updateEffect } = useStore.getState();
  const defs = mod ? parseParams(mod.code) : [];
  const upd = (p: Partial<FxItem>) => updateEffect(fx.id, p);
  return (
    <PlainControls
      title={<Title kind="k-tr" label={$t('轉場方塊')} name={itemName('effect', fx, [], useStore.getState().modules)} onRename={(n) => useStore.getState().renameItem('effect', fx.id, n)} />}
      rows={[
        ...infoRows(fx, undefined, (v) => upd({ duration: Math.max(0.05, Math.min(v, maxDurFor('effect', fx))) })),
        { label: $t('影片軌'), node: <CutTrackPick fx={fx} /> },
        { label: $t('轉場'), node: <ModuleSelect kind="transition" value={fx.moduleId} onChange={(m) => m && upd({ moduleId: m, params: {} })} /> },
        { label: $t('長度'), node: <DragNumber variant="text" value={fx.trDur ?? 0.4} min={0.05} max={10} step={0.01} suffix="s" def={0.4} onChange={(v) => upd({ trDur: v })} /> },
        ...paramRows(defs, fx.params, (p) => upd({ params: p })),
      ]}
      titleMenu={() => fxTitleMenu({ kind: 'fx', id: fx.id })}
      footer={mod && <ModuleCode module={mod} onFork={(nid) => upd({ moduleId: nid })} />}
    />
  );
}

/** 觸發方式的選項（值 = select 的 value） */
const TRIGGERS: { v: string; label: () => string; trigger?: FxTrigger }[] = [
  { v: 'once', label: () => $t('整段一次') },
  { v: 'b0.5', label: () => $t('每半拍'), trigger: { kind: 'beat', every: 0.5 } },
  { v: 'b1', label: () => $t('每拍'), trigger: { kind: 'beat', every: 1 } },
  { v: 'b2', label: () => $t('每 2 拍'), trigger: { kind: 'beat', every: 2 } },
  { v: 'b4', label: () => $t('每小節'), trigger: { kind: 'beat', every: 4 } },
  { v: 'cut', label: () => $t('每個剪接點'), trigger: { kind: 'cut' } },
];
const triggerValue = (t?: FxTrigger) => (!t ? 'once' : t.kind === 'cut' ? 'cut' : `b${t.every}`);

function EffectInspector({ id }: { id: string }) {
  const fx = useStore((s) => s.effects.find((e) => e.id === id));
  const mod = useStore((s) => s.modules.find((m) => m.id === fx?.moduleId));
  const modules = useStore((s) => s.modules);
  const time = useStore((s) => s.time);
  if (!fx) return null;
  if (mod?.kind === 'transition') return <TransitionBlockInspector fx={fx} />;
  const { updateEffect } = useStore.getState();
  const host = fxHost(fx.id)!;
  const local = Math.min(fx.duration, Math.max(0, time - fx.start));
  const owner: FxOwner = { kind: 'fx', id };
  const sections: Section[] = [
    { id: 'info', title: $t('資訊'), rows: infoRows(fx, undefined, (v) => updateEffect(id, { duration: Math.max(0.05, Math.min(v, maxDurFor('effect', fx))) })) },
    {
      id: 'trigger',
      title: $t('觸發'),
      rows: [
        {
          label: $t('重新播放'),
          node: (
            <select className="select" value={triggerValue(fx.trigger)} onChange={(e) => updateEffect(id, { trigger: TRIGGERS.find((x) => x.v === e.target.value)?.trigger })}>
              {TRIGGERS.map((x) => <option key={x.v} value={x.v}>{x.label()}</option>)}
            </select>
          ),
        },
        ...(fx.trigger?.kind === 'cut' ? [{ label: $t('影片軌'), node: <CutTrackPick fx={fx} /> }] : []),
      ],
      onReset: () => updateEffect(id, { trigger: undefined }),
    },
    ...effectSections(fx, mod, local, (p) => updateEffect(id, p as Partial<FxItem>), { idBase: 'fx', drawKey: `fx:${fx.id}`, fresh: () => useStore.getState().effects.find((e) => e.id === id), owner, tracking: true, topRows: subjectFromRows(fx) }),
    ...stackSections(fx, modules, local),
  ];
  return (
    <EffectControls
      host={host}
      sections={sections}
      extra={<AddStackFx fxId={id} />}
      titleMenu={() => [...fxTitleMenu(owner), { separator: true }, { label: $t('存成組合…'), action: () => saveFxCombo(id) }]}
      title={<Title kind="k-fx" label={$t('特效')} name={itemName('effect', fx, [], useStore.getState().modules)} onRename={(n) => useStore.getState().renameItem('effect', fx.id, n)} />}
    />
  );
}

/** 沒有時間軸的屬性列表（轉場、音訊） */
type PlainRow = { label: string; node: React.ReactNode; menu?: MenuItem[] };

/** more：次要資訊，收在可展開的區塊裡（預設收起） */
function PlainControls({ title, rows, more, footer, titleMenu }: { title: React.ReactNode; rows: PlainRow[]; more?: { title: string; rows: PlainRow[] }; footer?: React.ReactNode; titleMenu?: () => MenuItem[] }) {
  const [moreOpen, setMoreOpen] = useState(false);
  const ctx = (get: MenuItem[] | (() => MenuItem[]) | undefined) => (e: React.MouseEvent) => {
    const items = typeof get === 'function' ? get() : get;
    if (!items?.length) return;
    e.preventDefault();
    e.stopPropagation();
    openMenu(e.clientX, e.clientY, items);
  };
  const row = (r: PlainRow, i: number) => (
    <div key={r.label + i} className="ec-row">
      <div className="ec-left ec-plain" onContextMenu={ctx(r.menu)}><span className="ec-label">{r.label}</span><div className="ec-node">{r.node}</div></div>
    </div>
  );
  return (
    <div className="ec plain">
      <div className="ec-row ec-header" onContextMenu={ctx(titleMenu)}><div className="ec-left">{title}</div></div>
      {rows.map(row)}
      {more && more.rows.length > 0 && (
        <>
          <div className="ec-row ec-section">
            <div className="ec-left" onClick={() => setMoreOpen(!moreOpen)}>
              <span className="twirl">{moreOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
              <span className="ec-sec-title">{more.title}</span>
            </div>
          </div>
          {moreOpen && more.rows.map(row)}
        </>
      )}
      {footer && <div className="ec-footer">{footer}</div>}
    </div>
  );
}

/** 轉場的跟隨目標：開關（跟隨中不顯示位置）、跟前一段或後一段 */
function trFollowRows(defs: ParamDef[], tr: TransitionRef, upd: (p: Partial<TransitionRef>) => void, prev: Clip | undefined, clip: Clip, side: TrSide) {
  if (!(tracking(clip) || tracking(prev))) return [];
  const followable = defs.filter((d) => d.type === 'point' && !d.fit && (d.follow || tr.follow?.[d.name]));
  return followable.flatMap((d) => {
    const cur = followOf(d, tr.follow);
    const put = (f: Follow | null) => upd({ follow: { ...(tr.follow ?? {}), [d.name]: f } });
    const rows: { label: string; node: React.ReactNode }[] = [{
      label: followable.length > 1 ? `${$t('跟隨目標')} · ${$t(d.label)}` : $t('跟隨目標'),
      node: <FollowSwitch on={!!cur} set={(v) => put(v ? { ...(tr.follow?.[d.name] ?? {}) } : null)} reset={followReset(d, tr.follow)} apply={(m) => upd({ follow: m })} />,
    }];
    // 轉入才有前後兩段可以選
    if (cur && side === 'in' && prev) {
      rows.push({
        label: $t('跟隨'),
        node: (
          <select className="select" value={cur.side ?? 'from'} onChange={(e) => put({ ...cur, side: e.target.value as 'from' | 'to' })}>
            <option value="from">{$t('前一段')}</option>
            <option value="to">{$t('後一段')}</option>
          </select>
        ),
      });
    }
    return rows;
  });
}

function TransitionInspector({ selId }: { selId: string }) {
  const { clipId, side } = parseTrSel(selId);
  const clip = useStore((s) => s.clips.find((c) => c.id === clipId));
  const clips = useStore((s) => s.clips);
  const tr = side === 'out' ? clip?.transitionOut : clip?.transitionIn;
  const mod = useStore((s) => s.modules.find((m) => m.id === tr?.moduleId));
  if (!clip || !tr) return null;
  const { updateTransition, setTransition, applyTransitions } = useStore.getState();
  const sorted = sortClips(clips.filter((c) => c.track === clip.track));
  const i = sorted.findIndex((c) => c.id === clipId);
  const w = transitionWindow(sorted[i - 1], clip, side, sorted[i + 1]);
  const maxD = w?.max ?? clip.duration;
  const defs = mod ? parseParams(mod.code) : [];
  // 跟隨目標：轉入的前一段 = 同軌前一個片段、後一段 = 這個片段；轉出只有這個片段
  const prevClip = side === 'out' ? undefined : sorted[i - 1];
  const trTracking = tracking(clip) || tracking(prevClip);
  const upd = (p: Partial<TransitionRef>) => updateTransition(clipId, p, side);
  const apply = (scope: TrScope) => toast($t('已套用到 {0} 個位置', applyTransitions(clip.track, scope, tr)));
  /** 同一條軌道上已經有的轉場，全部改成跟這個一樣 */
  const syncAll = () => {
    const st = useStore.getState();
    let n = 0;
    const clipsNew = st.clips.map((c) => {
      if (c.track !== clip.track) return c;
      const p: Partial<Clip> = {};
      if (c.transitionIn) p.transitionIn = { ...tr, params: { ...tr.params } };
      if (c.transitionOut) p.transitionOut = { ...tr, params: { ...tr.params } };
      n += Object.keys(p).length;
      return Object.keys(p).length ? { ...c, ...p } : c;
    });
    useStore.setState({ clips: clipsNew });
    toast($t('已更新 {0} 個轉場', n));
  };
  return (
    <>
      {!w && <div className="warn" style={{ margin: 8 }}>{$t('轉出不會生效')}</div>}
      <PlainControls
        title={<><Title kind="k-tr" label={side === 'out' ? $t('轉出') : $t('轉場')} name={mod ? displayName(mod.name) : ''} /><button className="link danger" onClick={() => setTransition(clipId, null, side)}>{$t('移除')}</button></>}
        rows={[
          { label: $t('轉場'), node: <ModuleSelect kind="transition" value={tr.moduleId} onChange={(m) => setTransition(clipId, m, side)} /> },
          { label: $t('長度'), menu: trPropMenu(clipId, side, 'duration'), node: <DragNumber variant="text" value={Math.min(tr.duration, maxD)} min={0.05} max={maxD} step={0.01} suffix="s" def={0.4} menu={trPropMenu(clipId, side, 'duration')} onChange={(v) => upd({ duration: v })} /> },
          ...trFollowRows(defs, tr, upd, prevClip, clip, side),
          ...paramRows(defs, tr.params, (p) => upd({ params: p }), false, (d) => [...(trTracking ? followMenu(d, tr.follow, (m) => upd({ follow: m })) : []), ...trPropMenu(clipId, side, { param: d.name })]).filter((_, k) =>
            !(trTracking && (followOf(defs[k], tr.follow) || fitOf(defs[k], defs, tr.follow))),
          ),
        ]}
        titleMenu={() => [
          { label: $t('複製轉場'), action: () => copyTransition(selId) },
          { label: $t('貼上轉場'), action: hasTransitionClipboard() ? () => pasteTransition() : undefined },
          { separator: true },
          {
            label: $t('套用到同軌'),
            submenu: [
              { label: $t('剪接點'), action: () => apply('cuts') },
              { label: $t('開頭'), action: () => apply('heads') },
              { label: $t('結尾'), action: () => apply('tails') },
              { separator: true },
              { label: $t('同步現有'), action: syncAll },
            ],
          },
        ]}
        footer={mod && <ModuleCode module={mod} onFork={(nid) => upd({ moduleId: nid })} />}
      />
    </>
  );
}

function AudioInspector({ id }: { id: string }) {
  const a = useStore((s) => s.audios.find((c) => c.id === id));
  const media = useStore((s) => s.media.find((m) => m.id === a?.mediaId));
  const attached = useStore((s) => !!a && attachedAudioIds(s).has(a.id));
  if (!a) return null;
  const { updateAudio } = useStore.getState();
  const bpm = mediaBeats(media)?.bpm;
  return (
    <PlainControls
      title={<Title kind="k-audio" label={$t('音訊')} name={a.name ?? media?.name ?? $t('（素材遺失）')} onRename={(n) => useStore.getState().renameItem('audio', a.id, n)} />}
      rows={[
        ...infoRows(a, media ?? undefined),
        { label: $t('音量'), node: <DragNumber variant="text" value={a.volume} min={0} max={1} step={0.01} display={100} suffix="%" def={1} onChange={(v) => updateAudio(id, { volume: v })} /> },
        { label: $t('淡入'), node: <DragNumber variant="text" value={a.fadeIn} min={0} max={Math.min(10, a.duration)} step={0.01} suffix="s" def={0} onChange={(v) => updateAudio(id, { fadeIn: v })} /> },
        { label: $t('淡出'), node: <DragNumber variant="text" value={a.fadeOut} min={0} max={Math.min(10, a.duration)} step={0.01} suffix="s" def={0} onChange={(v) => updateAudio(id, { fadeOut: v })} /> },
        { label: $t('速率'), node: <DragNumber variant="text" value={a.rate ?? 1} min={0.1} max={4} step={0.01} suffix="×" def={1} onChange={(v) => updateAudio(id, { rate: v, duration: Math.min(a.duration * ((a.rate ?? 1) / v), maxDurFor('audio', a)) })} /> },
        { label: $t('保持音調'), node: <PitchSwitch v={a.keepPitch !== false} on={(v) => updateAudio(id, { keepPitch: v })} /> },
        // 節拍格線的來源（連結在影片上的原音不提供）
        ...(attached
          ? []
          : [
              { label: $t('節拍格線'), node: <Switch v={a.beats !== false} on={(v) => updateAudio(id, { beats: v ? undefined : false })} /> },
              ...(a.beats !== false && bpm ? [{ label: 'BPM', node: <span className="muted">{bpm.toFixed(1)}</span> }] : []),
            ]),
      ]}
    />
  );
}

function useMediaProbe(m: Media | undefined) {
  const key = m && !m.missing ? m.url : undefined;
  const [probe, setProbe] = useState<MediaProbe | null>(null);
  useEffect(() => {
    setProbe(null);
    if (!m || !key) return;
    let alive = true;
    probeMedia(m.id, key, m.name).then((p) => alive && setProbe(p));
    return () => { alive = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return probe;
}

/** 素材庫點開的素材：檔案資訊 + 素材預覽的入點 / 出點 */
function MediaInspector({ id }: { id: string }) {
  const m = useStore((s) => s.media.find((x) => x.id === id));
  const uses = useStore((s) => s.clips.filter((c) => c.mediaId === id).length + s.audios.filter((a) => a.mediaId === id).length);
  const p = useMediaProbe(m);
  if (!m) return null;
  const val = (v: React.ReactNode) => <span className="info-val">{v}</span>;
  const bpm = m.kind === 'audio' ? mediaBeats(m)?.bpm : undefined;
  const timed = m.kind !== 'image';
  return (
    <PlainControls
      title={<Title kind="k-media" label={$t('素材')} name={m.name} />}
      rows={[
        { label: $t('類型'), node: val(p ? `${KIND_LABEL[m.kind]} · ${p.format}` : KIND_LABEL[m.kind]) },
        ...(m.kind !== 'audio' && m.width && m.height ? [{ label: $t('解析度'), node: val(`${m.width}×${m.height}`) }] : []),
        ...(timed ? [{ label: $t('長度'), node: val(`${m.duration.toFixed(2)}s`) }] : []),
        ...(p?.fps ? [{ label: $t('影格率'), node: val(`${formatFps(p.fps)} fps`) }] : []),
        ...(m.kind === 'video' ? [{ label: $t('聲音'), node: val(m.hasAudio ? $t('有') : $t('無')) }] : []),
        ...(bpm ? [{ label: 'BPM', node: val(bpm.toFixed(1)) }] : []),
        ...(p ? [{ label: $t('檔案大小'), node: val(formatBytes(p.size)) }] : []),
        { label: $t('使用次數'), node: val(uses) },
      ]}
      more={{
        title: $t('詳細資訊'),
        rows: [
          ...(m.kind !== 'audio' && m.width && m.height ? [{ label: $t('長寬比'), node: val(aspectOf(m.width, m.height)) }] : []),
          ...(p?.videoCodec ? [{ label: $t('影片編碼'), node: val(p.videoCodec) }] : []),
          ...(p?.audioCodec ? [{ label: $t('音訊編碼'), node: val(p.audioCodec) }] : []),
          ...(p?.sampleRate ? [{ label: $t('取樣率'), node: val(`${+(p.sampleRate / 1000).toFixed(1)} kHz`) }] : []),
          ...(p?.channels ? [{ label: $t('聲道'), node: val(p.channels === 1 ? $t('單聲道') : p.channels === 2 ? $t('立體聲') : $t('{0} 聲道', p.channels)) }] : []),
          ...(p && timed && m.duration > 0 ? [{ label: $t('位元率'), node: val(formatBitrate((p.size * 8) / m.duration)) }] : []),
          ...(p?.created ? [{ label: $t('建立日期'), node: val(new Date(p.created).toLocaleString()) }] : []),
          ...(p?.modified ? [{ label: $t('修改日期'), node: val(new Date(p.modified).toLocaleString()) }] : []),
        ],
      }}
    />
  );
}

export type { Clip, FxItem };
