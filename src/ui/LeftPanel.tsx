import { $t, displayName } from '../i18n';
import { AlignCenter, AlignLeft, AlignRight, Bold, CircleCheck, Italic, Music, Palette, Pipette, Play, Plus, TriangleAlert, Upload, Pencil, ChevronDown, ChevronUp, Eye, EyeOff, Sparkles, Trash2, SquareDashedMousePointer, SquareDashed, PenTool, Unlink, Link2, Unlink2 } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { attachedAudioIds, type ClipFx, hasLinkedAudio, parseTrSel, type TrScope, type TransitionRef, laneOf, mediaUsable, spansOf, useStore, type AudioDrive, type BlendMode, type Clip, type FxItem, type Media, type ModuleKind } from '../store';
import type { Module } from '../modules/builtin';
import { CATEGORIES, categoryOf } from '../modules/categories';
import { colorMedia, colorName, importFiles, pickFiles, relinkWithPicker, removeMedia } from '../engine/media';
import { nextStart } from '../engine/overlap';
import { FONTS, TEXT_PRESETS, DEFAULT_TEXT, renderText, type TextStyle } from '../engine/text';
import { DEFAULT_MASK, type Mask } from '../engine/mask';
import { CLIP_MASK_ID } from '../modules/extra';
import { mediaBeats } from '../engine/beats';
import { shapeName } from '../engine/maskShapes';
import type { Keyframe } from '../engine/keyframes';
import { parseDuration, parseParams, type ParamDef, type ParamValue, type ParamValues } from '../engine/params';
import { computeFrame, transitionWindow, sortClips, makeCtx } from '../engine/renderer';
import { DEFAULT_TRANSFORM, FITS, type Fit } from '../engine/transform';
import { plainSpeed } from '../engine/remap';

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
import { openSource } from './SourcePanel';
import { openMenu, revealSelection, stopPreviewFx, toast, useLayout, usePreviewFx, type MenuItem } from './uiStore';
import { DragNumber } from './DragNumber';
import { ModuleCode } from './ModuleCode';
import { newModule, openModuleEditor } from './CodePanel';
import { FavButton, LibFilter, LibToolbar, match, openPicker } from './Library';
import { MaskLibrary, ShapeThumb, addClipMask, ensureClipBaseMask, setMaskShape } from './MaskPanel';
import { openShapeDrawer } from './ShapeDrawer';
import { EffectControls, cfxCh, clipChannels, clipHost, fxChannels, fxHost, maskChannels, type Channel, type Section } from './EffectControls';

// ───────────────────────── 素材 ─────────────────────────

const KIND_LABEL = { video: $t('影片'), image: $t('圖片'), audio: $t('音訊') } as const;

const SWATCHES = [
  '#000000', '#ffffff', '#1d1f27', '#3a3f4d', '#8a90a2', '#ff3d6e',
  '#ff5d5d', '#ff8a3d', '#ffb02e', '#ffe066', '#b8f35d', '#29d3c2',
  '#2ec4f1', '#3a7bff', '#6a4cff', '#9b6bff', '#f15bb5', '#7a2048',
];

// ── 自訂顏色：HSV 內部狀態（灰色時色相不會跑掉） ──
type Hsv = { h: number; s: number; v: number };
function hsvToHex({ h, s, v }: Hsv) {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    const c = v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
    return Math.round(c * 255).toString(16).padStart(2, '0');
  };
  return `#${f(5)}${f(3)}${f(1)}`;
}
function hexToHsv(hex: string, prevH = 0): Hsv | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const x = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16) / 255);
  const mx = Math.max(r, g, b), d = mx - Math.min(r, g, b);
  let h = prevH;
  if (d > 0) {
    h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  return { h, s: mx ? d / mx : 0, v: mx };
}

const RECENT_KEY = 'ybeat.recentColors';
function loadRecent(): string[] {
  try { const a = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]'); return Array.isArray(a) ? a.filter((x) => typeof x === 'string').slice(0, 12) : []; } catch { return []; }
}

/** 飽和度 / 明度方塊 */
function SvPad({ hsv, onChange }: { hsv: Hsv; onChange: (h: Hsv) => void }) {
  const down = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    const at = (ev: { clientX: number; clientY: number }) => {
      const r = el.getBoundingClientRect();
      onChange({ h: hsv.h, s: Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), v: Math.min(1, Math.max(0, 1 - (ev.clientY - r.top) / r.height)) });
    };
    at(e);
    const mv = (ev: PointerEvent) => at(ev);
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
  };
  return (
    <div className="cpk-pad" style={{ backgroundColor: `hsl(${hsv.h} 100% 50%)` }} onPointerDown={down}>
      <i style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: hsvToHex(hsv) }} />
    </div>
  );
}

/** 色板：拖到影片軌、或雙擊加到結尾 */
function ColorSwatches() {
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv('#ff3d6e')!);
  const [draft, setDraft] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>(loadRecent);
  const custom = hsvToHex(hsv);
  const media = useStore((s) => s.media);
  const used = new Set(media.filter((m) => m.name.startsWith(colorName('').trim())).map((m) => m.name));
  const remember = (c: string) => {
    if (SWATCHES.includes(c)) return;
    const next = [c, ...recent.filter((x) => x !== c)].slice(0, 12);
    setRecent(next);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* 無痕模式等 */ }
  };
  const pick = (c: string) => { const n = hexToHsv(c, hsv.h); if (n) setHsv(n); };
  const add = async (c: string) => {
    remember(c);
    const m = await colorMedia(c);
    if (m) {
      useStore.getState().addClip(m.id);
      revealSelection();
    }
  };
  const swatch = (c: string, cls = '') => (
    <div
      key={c}
      className={`swatch ${cls} ${used.has(colorName(c)) ? 'used' : ''} ${c === custom ? 'cur' : ''}`}
      style={{ background: c }}
      title={$t('{0}（拖到影片軌）', c)}
      onPointerDown={(e) => { pick(c); startLibraryDrag(e, { kind: 'color', color: c }, c); }}
      onDoubleClick={() => add(c)}
    />
  );
  const commitDraft = () => {
    if (draft !== null) pick(draft.startsWith('#') ? draft : `#${draft}`);
    setDraft(null);
  };
  return (
    <div className="swatches-wrap">
      <div className="swatches">{SWATCHES.map((c) => swatch(c))}</div>
      <div className="cpk">
        <SvPad hsv={hsv} onChange={setHsv} />
        <input
          type="range"
          className="cpk-hue"
          min={0}
          max={359}
          value={Math.round(hsv.h)}
          onChange={(e) => setHsv({ ...hsv, h: +e.target.value })}
          style={{ '--thumb': `hsl(${hsv.h} 100% 50%)` } as React.CSSProperties}
        />
        <div className="cpk-row">
          <div
            className="cpk-chip"
            style={{ background: custom }}
            title={$t('{0}（拖到影片軌）', custom)}
            onPointerDown={(e) => { remember(custom); startLibraryDrag(e, { kind: 'color', color: custom }, custom); }}
          />
          <label className="cpk-hex">
            <span>#</span>
            <input
              value={draft ?? custom.slice(1).toUpperCase()}
              maxLength={7}
              spellCheck={false}
              onChange={(e) => { setDraft(e.target.value); const n = hexToHsv(e.target.value, hsv.h); if (n && /^#?[0-9a-f]{6}$/i.test(e.target.value.trim())) setHsv(n); }}
              onBlur={commitDraft}
              onKeyDown={(e) => { if (e.key === 'Enter') { commitDraft(); (e.target as HTMLInputElement).blur(); } if (e.key === 'Escape') { setDraft(null); (e.target as HTMLInputElement).blur(); } }}
            />
          </label>
          <label className="cpk-native" title={$t('系統顏色選擇器')}>
            <Pipette size={14} />
            <input type="color" value={custom} onChange={(e) => pick(e.target.value)} />
          </label>
          <span className="spacer" />
          <button className="btn primary small cpk-add" onClick={() => add(custom)}><Plus size={13} />{$t('加到結尾')}</button>
        </div>
        {recent.length > 0 && <div className="cpk-recent">{recent.map((c) => swatch(c, 'mini'))}</div>}
      </div>
    </div>
  );
}

export function MediaPanel() {
  const media = useStore((s) => s.media);
  const clips = useStore((s) => s.clips);
  const audios = useStore((s) => s.audios);
  const addClip = useStore((s) => s.addClip);
  const view = useLayout((s) => s.libView.media ?? 'grid');
  // 分類籤收起來 = 全部
  const filter = useLayout((s) => (s.libFilterOpen.media ? s.mediaFilter : 'all'));
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<'added' | 'name' | 'type'>('added');

  const uses = (id: string) => clips.filter((c) => c.mediaId === id).length + audios.filter((a) => a.mediaId === id).length;
  const list = useMemo(() => {
    const l = media.filter((m) => (filter === 'all' || m.kind === filter) && match(m.name, q));
    if (sort === 'name') l.sort((a, b) => a.name.localeCompare(b.name));
    if (sort === 'type') l.sort((a, b) => a.kind.localeCompare(b.kind));
    return l;
  }, [media, filter, q, sort]);
  const missing = media.filter((m) => m.missing).length;
  /** 色板分頁：不用先打開分類籤也能直接切過去（素材庫是空的時候也找得到） */
  const toggleColors = () => {
    const L = useLayout.getState();
    if (filter === 'color') L.set({ mediaFilter: 'all' });
    else L.set({ mediaFilter: 'color', libFilterOpen: { ...L.libFilterOpen, media: true } });
  };

  const itemMenu = (e: React.MouseEvent, m: Media) => {
    e.preventDefault();
    e.stopPropagation();
    const n = uses(m.id);
    openMenu(e.clientX, e.clientY, [
      { label: $t('預覽素材'), action: mediaUsable(m) ? () => openSource(m.id) : undefined },
      { label: $t('加到時間軸結尾'), action: mediaUsable(m) ? () => { addClip(m.id); revealSelection(); } : undefined },
      { label: m.missing ? $t('重新連結檔案…') : $t('替換檔案…'), action: () => relinkWithPicker(m.id) },
      { separator: true },
      { label: n ? $t('從素材庫移除（{0} 個片段使用中）', n) : $t('從素材庫移除'), action: () => removeMedia(m.id), danger: true },
    ]);
  };

  const bgMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const L = useLayout.getState();
    const unused = media.filter((m) => !uses(m.id));
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
    <div className="lib" onContextMenu={bgMenu}>
      <LibToolbar id="media" query={q} setQuery={setQ} filter={{ active: filter !== 'all', reset: () => useLayout.getState().set({ mediaFilter: 'all' }) }}>
        <button className="lib-add" title={$t('匯入媒體 (Ctrl+O)')} onClick={async () => importFiles(await pickFiles())}><Plus size={15} /></button>
        <button className={`lib-add ${filter === 'color' ? 'on' : ''}`} title={$t('色板')} onClick={toggleColors}><Palette size={14} /></button>
      </LibToolbar>
      <LibFilter
        id="media"
        cats={[
          ...(['all', 'video', 'image', 'audio'] as const).map((f) => ({ id: f, label: f === 'all' ? $t('全部') : KIND_LABEL[f], count: f === 'all' ? media.length : media.filter((m) => m.kind === f).length })),
          { id: 'color', label: $t('色板'), icon: <Palette size={12} /> },
        ]}
        cur={filter}
        set={(f) => useLayout.getState().set({ mediaFilter: f as typeof filter })}
      />
      {filter === 'color' ? (
        <div className="lib-body"><ColorSwatches /></div>
      ) : (
      <div className="lib-body">
        {missing > 0 && <div className="warn"><TriangleAlert size={13} /> {missing}{' '}{$t('個素材遺失')}</div>}
        {media.length === 0 && (
          <div className="lib-empty">
            <button className="btn primary" onClick={async () => importFiles(await pickFiles())}><Upload size={14} /> {$t('匯入影片 / 圖片 / 音樂')}</button>
            <button className="btn" onClick={toggleColors}><Palette size={14} /> {$t('色板')}</button>
          </div>
        )}
        {media.length > 0 && list.length === 0 && <p className="muted small center">{$t('沒有符合的素材')}</p>}
        <div className={view === 'grid' ? 'lib-grid' : 'lib-list'}>
          {list.map((m) => (
            <div
              key={m.id}
              className={`lib-item ${m.missing ? 'missing' : ''}`}
              onPointerDown={(e) => mediaUsable(m) && startLibraryDrag(e, { kind: 'media', id: m.id }, m.name, m.kind === 'audio' ? undefined : m.thumb)}
              onClick={() => (m.missing ? relinkWithPicker(m.id) : openSource(m.id, false))}
              onDoubleClick={() => mediaUsable(m) && openSource(m.id)}
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
                <div className="lib-name">{m.name}</div>
                {view === 'list' && (
                  <div className="lib-sub">{KIND_LABEL[m.kind]}{m.kind !== 'image' ? ` · ${m.duration.toFixed(1)}s` : ` · ${m.width}×${m.height}`}{uses(m.id) ? $t(' · 使用 {0} 次', uses(m.id)) : ''}</div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
      )}
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
  const styles = useMemo(() => TEXT_PRESETS.map((p) => ({ ...DEFAULT_TEXT, ...p.style })), []);
  const add = (id: string) => {
    const s = useStore.getState();
    const p = TEXT_PRESETS.find((x) => x.id === id);
    s.addText(id, s.time, s.trackForInsert('video', s.time, p?.duration ?? 3));
    revealSelection();
  };
  return (
    <div className="lib">
      <div className="lib-bar">
        <span className="muted small">{$t('文字 / 字幕')}</span>
        <span className="spacer" />
        <button className="lib-add" title={$t('在播放頭加入文字')} onClick={() => add('title')}><Plus size={15} /></button>
      </div>
      <div className="lib-body">
        <div className={view === 'grid' ? 'lib-grid mods' : 'lib-list'}>
          {TEXT_PRESETS.map((p, i) => (
            <div
              key={p.id}
              className="lib-item mod mk-text"
              onPointerDown={(e) => startLibraryDrag(e, { kind: 'text', preset: p.id }, p.name)}
              title={p.name}
            >
              <TextThumb style={styles[i]} />
              <div className="lib-meta"><div className="lib-name">{p.name}</div></div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ───────────────────────── 轉場 / 特效 / 變速 ─────────────────────────

function ModuleThumb({ m }: { m: Module }) {
  const url = useModuleThumb(m);
  return <div className="lib-thumb mod" style={url ? { backgroundImage: `url(${url})` } : undefined}>{!url && <span className="loading" />}</div>;
}

export function ModulePanel({ kind }: { kind: ModuleKind }) {
  return <ModuleLibrary kind={kind} />;
}

/**
 * 模組庫（轉場 / 特效 / 變速）。分頁與屬性面板的挑選視窗共用：
 * 有 onPick = 挑選模式（點一下就選、不試看、不能拖）
 */
export function ModuleLibrary({ kind, onPick }: { kind: ModuleKind; onPick?: (id: string) => void }) {
  const all = useStore((s) => s.modules);
  const previewing = usePreviewFx((s) => s.fx?.moduleId);
  const view = useLayout((s) => s.libView[kind] ?? 'grid');
  const favorites = useLayout((s) => s.favorites);
  const cat = useLayout((s) => (s.libFilterOpen[kind] ? s.modCat[kind] ?? 'all' : 'all'));
  const [q, setQ] = useState('');

  const favSet = new Set(favorites);
  const ofKind = all.filter((m) => m.kind === kind);
  const inCat = (m: Module, c: string) => c === 'all' || (c === 'fav' ? favSet.has(m.id) : categoryOf(m) === c);
  const modules = ofKind.filter((m) => match(m.name, q) && inCat(m, cat));
  const setCat = (c: string) => useLayout.getState().set({ modCat: { ...useLayout.getState().modCat, [kind]: c } });
  const toggleFav = (id: string) => {
    const f = useLayout.getState().favorites;
    useLayout.getState().set({ favorites: f.includes(id) ? f.filter((x) => x !== id) : [...f, id] });
  };
  const cats = [
    { id: 'all', label: $t('全部') },
    { id: 'fav', label: $t('我的最愛') },
    ...CATEGORIES[kind],
    { id: 'custom', label: $t('自訂') },
  ].filter((c) => c.id === 'all' || c.id === 'fav' || ofKind.some((m) => inCat(m, c.id)));

  const apply = (id: string) => {
    const s = useStore.getState();
    stopPreviewFx();
    if (kind === 'effect') {
      const m = s.modules.find((x) => x.id === id);
      s.addEffect(id, s.time, s.trackForInsert('fx', s.time, m ? parseDuration(m.code, 0.5) : 0.5));
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
    if (kind === 'remap') return;
    useStore.getState().setPlaying(false);
    usePreviewFx.setState({ fx: previewing === id ? null : { moduleId: id, t0: performance.now() } });
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
      { label: $t('在預覽中試看'), action: kind !== 'remap' ? () => togglePreview(m.id) : undefined },
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
        {!onPick && <button className="lib-add" title={$t('新增自訂模組')} onClick={() => newModule(kind)}><Plus size={15} /></button>}
      </LibToolbar>
      <LibFilter id={kind} cats={cats.map((c) => ({ ...c, count: ofKind.filter((m) => inCat(m, c.id)).length }))} cur={cat} set={setCat} />
      <div className="lib-body">
        {modules.length === 0 && (
          <p className="muted small center">{cat === 'fav' ? $t('還沒有我的最愛') : cat === 'custom' ? $t('還沒有自訂模組') : $t('沒有符合的模組')}</p>
        )}
        <div className={view === 'grid' ? 'lib-grid mods' : 'lib-list'}>
          {modules.map((m) => (
            <div
              key={m.id}
              className={`lib-item mod mk-${kind} ${!onPick && previewing === m.id ? 'previewing' : ''}`}
              onPointerDown={(e) => !onPick && startLibraryDrag(e, { kind: 'module', id: m.id, moduleKind: kind }, displayName(m.name))}
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

// ───────────────────────── 屬性（效果控制） ─────────────────────────

export function InspectorPanel() {
  const sel = useStore((s) => s.selection);
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
function ParamWidget({ d, v, onChange }: { d: ParamDef; v: ParamValue; onChange: (v: ParamValue) => void }) {
  if (d.type === 'bool') return <label className="switch"><input type="checkbox" checked={Boolean(v)} onChange={(e) => onChange(e.target.checked)} /><span /></label>;
  if (d.type === 'color') return <input type="color" className="color" value={String(v)} onChange={(e) => onChange(e.target.value)} />;
  return <DragNumber variant="text" value={Number(v)} step={d.type === 'int' ? 1 : undefined} min={d.min} max={d.max} decimals={d.type === 'int' ? 0 : undefined} def={Number(d.def)} onChange={(x) => onChange(d.type === 'int' ? Math.round(x) : x)} />;
}

const paramRows = (defs: ParamDef[], values: ParamValues, set: (p: ParamValues) => void) =>
  defs.map((d) => ({ label: $t(d.label), node: <ParamWidget d={d} v={values[d.name] ?? d.def} onChange={(v) => set({ ...values, [d.name]: v })} /> }));

/** 改速度導致片段變長時，不能蓋到同軌下一個片段：回傳允許的最大長度 */
function maxDurFor(type: 'clip' | 'audio', it: { id: string; start: number; duration: number; track: number }) {
  const s = useStore.getState();
  return nextStart(spansOf(s, new Set([`${type}:${it.id}`])), laneOf(type, it.track), it.start + it.duration) - it.start;
}

/** 變速時保持音調：開 = 只變速度；關 = 像錄音帶一樣音調跟著變 */
const PitchSwitch = ({ v, on }: { v: boolean; on: (v: boolean) => void }) => (
  <span className="pitch-row" title={$t('開：變速時音調不變（人聲不會變尖 / 變低沉）；關：音調跟著速度變')}>
    <Switch v={v} on={on} />
  </span>
);

const Switch = ({ v, on }: { v: boolean; on: (v: boolean) => void }) => (
  <label className="switch"><input type="checkbox" checked={v} onChange={(e) => on(e.target.checked)} /><span /></label>
);

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
  const set = (p: Partial<TextStyle>) => {
    const cur = useStore.getState().clips.find((c) => c.id === clip.id);
    if (cur?.text) useStore.getState().updateClip(clip.id, { text: { ...cur.text, ...p } });
  };
  const t = clip.text;
  return {
    id: 'text',
    title: $t('文字'),
    rows: [
      {
        label: $t('內容'),
        node: <textarea className="text-area" rows={Math.min(6, Math.max(2, t.text.split('\n').length))} value={t.text} onChange={(e) => set({ text: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />,
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
      { label: $t('顏色'), node: <input type="color" className="color" value={t.color} onChange={(e) => set({ color: e.target.value })} /> },
      {
        label: $t('樣式'),
        node: (
          <div className="seg small-seg">
            <button className={t.bold ? 'on' : ''} onClick={() => set({ bold: !t.bold })} title={$t('粗體')}><Bold size={13} /></button>
            <button className={t.italic ? 'on' : ''} onClick={() => set({ italic: !t.italic })} title={$t('斜體')}><Italic size={13} /></button>
            {(['left', 'center', 'right'] as const).map((a) => (
              <button key={a} className={t.align === a ? 'on' : ''} onClick={() => set({ align: a })} title={a === 'left' ? $t('靠左') : a === 'center' ? $t('置中') : $t('靠右')}>
                {a === 'left' ? <AlignLeft size={13} /> : a === 'center' ? <AlignCenter size={13} /> : <AlignRight size={13} />}
              </button>
            ))}
          </div>
        ),
      },
      { label: $t('行高'), node: <DragNumber variant="text" value={t.lineHeight} min={0.6} max={3} step={0.05} def={DEFAULT_TEXT.lineHeight} onChange={(v) => set({ lineHeight: v })} /> },
      { label: $t('描邊顏色'), node: <input type="color" className="color" value={t.stroke} onChange={(e) => set({ stroke: e.target.value })} /> },
      { label: $t('描邊粗細'), node: <DragNumber variant="text" value={t.strokeW} min={0} max={60} step={0.5} suffix=" px" def={0} onChange={(v) => set({ strokeW: v })} /> },
      {
        label: $t('描邊轉角'),
        node: (
          <div className="seg small-seg">
            {(['round', 'miter', 'bevel'] as const).map((j) => (
              <button key={j} className={(t.strokeJoin ?? 'round') === j ? 'on' : ''} onClick={() => set({ strokeJoin: j })}>
                {j === 'round' ? $t('圓角') : j === 'miter' ? $t('尖角') : $t('斜切')}
              </button>
            ))}
          </div>
        ),
      },
      { label: $t('底框顏色'), node: <input type="color" className="color" value={t.bg} onChange={(e) => set({ bg: e.target.value })} /> },
      { label: $t('底框不透明度'), node: <DragNumber variant="text" value={t.bgOpacity} min={0} max={1} step={0.01} display={100} suffix="%" def={0} onChange={(v) => set({ bgOpacity: v })} /> },
      { label: $t('陰影'), node: <Switch v={t.shadow} on={(v) => set({ shadow: v })} /> },
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
  const { updateClip, setRemap } = useStore.getState();
  const host = clipHost(clip.id)!;
  const local = Math.min(clip.duration, Math.max(0, time - clip.start));
  const chs = clipChannels(clip, local);
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

  const sections: Section[] = [
    ...(isText ? [textSection(clip as Clip & { text: TextStyle })] : []),
    {
      id: 'motion',
      title: $t('運動'),
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
  if (!isText && media && (media.kind === 'video' || media.kind === 'image')) sections.push({
    id: 'matte',
    title: $t('AI 去背'),
    rows: [
      { label: $t('啟用'), node: <Switch v={!!clip.aiMatte} on={(v) => updateClip(clip.id, { aiMatte: v || undefined })} /> },
      ...(clip.aiMatte ? [{ label: $t('狀態'), node: <MatteStatus clip={clip} media={media} /> }] : []),
    ],
    onReset: () => updateClip(clip.id, { aiMatte: undefined }),
  });
  sections.push(clipMaskSection(clip, local));

  if (isVideo && remapMod) {
    const defs = parseParams(remapMod.code);
    sections.push({
      id: 'speed',
      title: $t('速度 / 時間重映射'),
      rows: [
        { label: $t('模式'), node: <ModuleSelect kind="remap" value={clip.remap.moduleId} onChange={(m) => m && setRemap(clip.id, m)} /> },
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

type FxLike = { moduleId: string; params: ParamValues; keys?: Record<string, Keyframe[]>; mask?: Mask; audio?: Record<string, AudioDrive> };

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
 * 一個特效的屬性區塊：參數、遮罩、音訊反應。特效軌的特效與片段特效共用。
 * compact：遮罩併進參數區塊（片段特效用，比較不佔空間）
 */
function effectSections(
  f: FxLike,
  mod: Module | undefined,
  local: number,
  update: (p: Partial<FxLike>) => void,
  o: { idBase: string; /** 從 store 拿最新的（挑選視窗開著時資料會變） */ fresh: () => FxLike | undefined; maskKey?: string; drawKey?: string; ch?: (id: string) => string; compact?: boolean; title?: string; actions?: React.ReactNode; badge?: React.ReactNode; dim?: boolean; onFork?: (id: string) => void },
): Section[] {
  const ch = o.ch ?? ((x: string) => x);
  const mapCh = (l: Channel[]) => l.map((c) => ({ ...c, id: ch(c.id) }));
  const defs = mod ? parseParams(mod.code) : [];
  const other = defs.filter((d) => d.type === 'bool' || d.type === 'color');
  const name = o.title ?? (mod ? displayName(mod.name) : $t('特效'));
  const { rows: maskRows, chs: maskChs, reset: resetMask } = maskBlock(f, local, update, { fresh: o.fresh, editKey: o.maskKey, drawKey: o.drawKey, ch });

  const sections: Section[] = [
    {
      id: `${o.idBase}`,
      title: name,
      badge: o.badge,
      actions: o.actions,
      dim: o.dim,
      rows: [...paramRows(other, f.params, (p) => update({ params: p })), ...(o.compact ? maskRows : [])],
      channels: [...(mod ? mapCh(fxChannels(f as FxItem, mod.code, local)) : []), ...(o.compact ? maskChs : [])],
      onReset: () => update({ params: {}, keys: {}, ...(o.compact ? { mask: undefined } : {}) }),
      footer: mod && <ModuleCode module={mod} onFork={(nid) => (o.onFork ?? ((x: string) => update({ moduleId: x })))(nid)} />,
    },
  ];
  if (!o.compact) {
    sections.push({ id: `${o.idBase}.mask`, title: $t('遮罩'), rows: [{ ...maskRows[0], label: $t('形狀') }, ...maskRows.slice(1)], channels: maskChs, onReset: resetMask });
  }
  // 音訊反應：數值參數跟著音量 / 節拍變化
  const numeric = defs.filter((d) => d.type === 'float' || d.type === 'int');
  if (numeric.length) {
    const setDrive = (n: string, v: AudioDrive | null) => {
      const cur = { ...(f.audio ?? {}) };
      if (v) cur[n] = v;
      else delete cur[n];
      update({ audio: Object.keys(cur).length ? cur : undefined });
    };
    sections.push({
      id: `${o.idBase}.audio`,
      title: o.compact ? `${name} · ${$t('音訊反應')}` : $t('音訊反應'),
      dim: o.dim,
      rows: numeric.map((d) => {
        const dr = f.audio?.[d.name];
        const st = d.type === 'int' ? 1 : (d.max - d.min) / 200 || 0.01;
        return {
          label: $t(d.label),
          node: (
            <div className="drive-row">
              <select
                className="select"
                value={dr?.source ?? ''}
                onChange={(e) => {
                  const src = e.target.value as AudioDrive['source'] | '';
                  setDrive(d.name, src ? { source: src, min: dr?.min ?? Number(d.def), max: dr?.max ?? d.max } : null);
                }}
              >
                <option value="">{$t('不使用')}</option>
                <option value="level">{$t('跟著音量')}</option>
                <option value="beat">{$t('跟著節拍')}</option>
              </select>
              {dr && (
                <>
                  <DragNumber variant="text" value={dr.min} step={st} onChange={(v) => setDrive(d.name, { ...dr, min: v })} />
                  <span className="muted">→</span>
                  <DragNumber variant="text" value={dr.max} step={st} onChange={(v) => setDrive(d.name, { ...dr, max: v })} />
                </>
              )}
            </div>
          ),
        };
      }),
      onReset: () => update({ audio: undefined }),
    });
  }
  return sections;
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
    return effectSections(f, mod, local, (p) => S.updateClipFx(clip.id, f.id, p as Partial<ClipFx>), {
      idBase: `cfx.${f.id}`,
      fresh: () => useStore.getState().clips.find((c) => c.id === clip.id)?.effects?.find((x) => x.id === f.id),
      maskKey: cfxMaskKey(f.id),
      drawKey: cfxMaskKey(f.id),
      ch: (c) => cfxCh(f.id, c),
      compact: true,
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

function EffectInspector({ id }: { id: string }) {
  const fx = useStore((s) => s.effects.find((e) => e.id === id));
  const mod = useStore((s) => s.modules.find((m) => m.id === fx?.moduleId));
  const time = useStore((s) => s.time);
  if (!fx) return null;
  const { updateEffect } = useStore.getState();
  const host = fxHost(fx.id)!;
  const local = Math.min(fx.duration, Math.max(0, time - fx.start));
  const sections = effectSections(fx, mod, local, (p) => updateEffect(id, p as Partial<FxItem>), { idBase: 'fx', drawKey: `fx:${fx.id}`, fresh: () => useStore.getState().effects.find((e) => e.id === id) });
  return (
    <EffectControls
      host={host}
      sections={sections}
      title={<Title kind="k-fx" label={$t('特效')} name={itemName('effect', fx, [], useStore.getState().modules)} onRename={(n) => useStore.getState().renameItem('effect', fx.id, n)} />}
    />
  );
}

/** 沒有時間軸的屬性列表（轉場、音訊） */
function PlainControls({ title, rows, footer }: { title: React.ReactNode; rows: { label: string; node: React.ReactNode }[]; footer?: React.ReactNode }) {
  return (
    <div className="ec plain">
      <div className="ec-row ec-header"><div className="ec-left">{title}</div></div>
      {rows.map((r, i) => (
        <div key={r.label + i} className="ec-row">
          <div className="ec-left ec-plain"><span className="ec-label">{r.label}</span><div className="ec-node">{r.node}</div></div>
        </div>
      ))}
      {footer && <div className="ec-footer">{footer}</div>}
    </div>
  );
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
          { label: $t('長度'), node: <DragNumber variant="text" value={Math.min(tr.duration, maxD)} min={0.05} max={maxD} step={0.01} suffix="s" def={0.4} onChange={(v) => upd({ duration: v })} /> },
          ...paramRows(defs, tr.params, (p) => upd({ params: p })),
          {
            label: $t('套用到同軌'),
            node: (
              <div className="btn-row">
                <button className="btn small-h" onClick={() => apply('cuts')} title={$t('套用到這條軌道的所有剪接點')}>{$t('剪接點')}</button>
                <button className="btn small-h" onClick={() => apply('heads')} title={$t('套用到這條軌道所有片段的開頭（從透明轉入）')}>{$t('開頭')}</button>
                <button className="btn small-h" onClick={() => apply('tails')} title={$t('套用到這條軌道所有片段的結尾（轉到透明）')}>{$t('結尾')}</button>
                <button className="btn small-h" onClick={syncAll} title={$t('這條軌道上已經有的轉場，全部改成跟這個一樣（種類、參數、長度）')}>{$t('同步現有')}</button>
              </div>
            ),
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

export type { Clip, FxItem };
