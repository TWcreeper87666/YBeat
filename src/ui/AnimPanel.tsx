/**
 * 動畫：素材庫分頁（內建範本 + 我的動畫）與屬性面板。
 * 動畫的關鍵影格以「拍」為單位；屬性面板的曲線編輯器用秒，這裡換算。
 */
import React, { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronUp, Crop as CropIcon, Eye, EyeOff, Play, Save, Scissors, Sparkles, Trash2, X } from 'lucide-react';
import { $t } from '../i18n';
import { mediaUsable, uid, useStore, type BlendMode } from '../store';
import { DEFAULT_MASK } from '../engine/mask';
import { CLIP_MASK_ID } from '../modules/extra';
import { animMaskCh, animMaskKey, layerMaskCh, layerMaskKey, useMaskEdit } from './MaskEditor';
import { CropDialog, isFullCrop } from './RangePicker';
import { SlotCutoutEditor } from './CutoutEditor';
import { slotEdit } from '../engine/cutoutEdit';
import { usePrefs, type AnimPreset } from '../prefs';
import { ANIM_PROPS, evalKeys, sortKeys, type AnimProp, type Keyframe } from '../engine/keyframes';
import { animBeatAt, animSecAt, animTransformAt, type AnimItem, type AnimLayer, type AnimSlot } from '../engine/animation';
import { addAnimLayerFx, patchAnimSlot, placeAnim, setAnimSameMedia, usedImageSlots } from '../engine/animPlace';
import { imageMenu } from './animImageMenu';
import { FavButton, LibFilter, LibToolbar, match, onBlank, openPicker, usePickerAnchor } from './Library';
import { AnimMediaPicker } from './AnimMediaPicker';
import { startLibraryDrag } from './dnd';
import { useFavList, useFavorites } from './favorites';
import { EffectControls, fxBasePatch, registerHostKind, type Channel, type Host, type Section } from './EffectControls';
import { DragNumber } from './DragNumber';
import { Seg, Switch } from './Toggle';
import { BLENDS, effectSections, maskBlock, ModuleLibrary, Title, type FxLike } from './LeftPanel';
import { ANIM_GROUPS, templateName } from './PopPicker';
import { AnimThumb } from './AnimThumb';
import { placeholderFor } from './animTrial';
import { slotNames } from './animNames';
import { confirmDialog, openMenu, promptDialog, stopPreviewFx, toast, useDrag, useLayout, usePreviewFx, type MenuItem } from './uiStore';

// ───────────── 素材庫分頁 ─────────────

export function AnimPanel() {
  const presets = usePrefs((x) => x.animPresets);
  const view = useLayout((s) => s.libView.anim ?? 'grid');
  const cat = useLayout((s) => (s.libFilterOpen.anim ? s.modCat.anim ?? 'all' : 'all'));
  const setCat = (c: string) => useLayout.getState().set({ modCat: { ...useLayout.getState().modCat, anim: c } });
  const [q, setQ] = useState('');
  const favorites = useFavList('anim');
  const fav = new Set(favorites);
  type Card = { id: string; name: string; mine?: AnimPreset; group: string };
  const all: Card[] = [
    ...ANIM_GROUPS.flatMap((g) => g.items.map((v) => ({ id: v, name: templateName(v)!, group: g.id }))),
    ...presets.map((p) => ({ id: `my:${p.id}`, name: p.name, mine: p, group: 'mine' })),
  ];
  const inCat = (c: Card, k: string) => k === 'all' || (k === 'fav' ? fav.has(c.id) : c.group === k);
  const cats = [
    { id: 'all', label: $t('全部') },
    { id: 'fav', label: $t('我的最愛') },
    ...ANIM_GROUPS.map((g) => ({ id: g.id, label: g.label() })),
    { id: 'mine', label: $t('我的動畫') },
  ].map((c) => ({ ...c, count: all.filter((x) => inCat(x, c.id)).length }));
  const list = all.filter((c) => inCat(c, cat) && match(c.name, q));
  const previewing = usePreviewFx((s) => s.anim?.source);
  const [hover, setHover] = useState<string | null>(null);
  /** 點卡片：在「預覽」循環試看（再點一次從頭播）；timeline = 用時間軸畫面 */
  const trial = (c: Card, timeline = false) => {
    useStore.getState().setPlaying(false);
    usePreviewFx.setState({ fx: null, text: null, anim: { source: c.id, name: c.name, t0: performance.now(), ...(timeline ? { timeline } : {}) } });
  };
  const atPlayhead = (id: string) => {
    const s = useStore.getState();
    const tr = s.activeTrack?.kind === 'video' ? s.activeTrack.idx : 0;
    if (!placeAnim(id, tr, s.time)) toast($t('這裡不能放'), 'error');
  };
  const itemMenu = (e: React.MouseEvent, c: Card) => {
    e.preventDefault();
    const items: MenuItem[] = [
      { label: fav.has(c.id) ? $t('從我的最愛移除') : $t('加入我的最愛'), action: () => useFavorites.getState().toggle('anim', c.id) },
      { label: $t('插入到播放頭'), action: () => atPlayhead(c.id) },
      { label: $t('用時間軸畫面試看'), shortcut: $t('Alt+點擊'), action: () => trial(c, true) },
    ];
    if (c.mine) {
      const p = c.mine;
      items.push(
        { separator: true },
        { label: $t('重新命名…'), action: async () => {
          const n = await promptDialog({ title: $t('重新命名'), value: p.name });
          if (n?.trim()) usePrefs.getState().set({ animPresets: usePrefs.getState().animPresets.map((x) => (x.id === p.id ? { ...x, name: n.trim() } : x)) });
        } },
        { label: $t('刪除'), danger: true, action: async () => {
          if (!(await confirmDialog({ title: $t('刪除「{0}」？', p.name), message: $t('已經放在時間軸上的動畫不受影響。'), ok: $t('刪除'), danger: true }))) return;
          usePrefs.getState().set({ animPresets: usePrefs.getState().animPresets.filter((x) => x.id !== p.id) });
          useFavorites.getState().remove('anim', c.id);
        } },
      );
    }
    openMenu(e.clientX, e.clientY, items);
  };
  return (
    <div className="lib anim-lib" onContextMenu={(e) => e.preventDefault()}>
      <LibToolbar id="anim" query={q} setQuery={setQ} filter={{ active: cat !== 'all', reset: () => setCat('all') }} />
      <LibFilter id="anim" cats={cats} cur={cat} set={setCat} />
      <div className="lib-body" onClick={onBlank(stopPreviewFx)} onDoubleClick={onBlank()}>
        {list.length === 0 && <p className="muted small center">{cat === 'mine' ? $t('還沒有我的動畫') : $t('沒有符合的動畫')}</p>}
        <div className={view === 'grid' ? 'lib-grid' : 'lib-list'}>
          {list.map((c) => (
            <div key={c.id} className={`lib-item anim-item ${previewing === c.id ? 'previewing' : ''}`} title={c.name}
              onClick={(e) => trial(c, e.altKey)}
              onPointerEnter={() => setHover(c.id)} onPointerLeave={() => setHover((h) => (h === c.id ? null : h))}
              onPointerDown={(e) => startLibraryDrag(e, { kind: 'anim', id: c.id }, c.name)}
              onDoubleClick={() => atPlayhead(c.id)}
              onContextMenu={(e) => itemMenu(e, c)}>
              <div className="lib-thumb anim-thumb"><AnimThumb source={c.id} live={hover === c.id || previewing === c.id} /></div>
              <FavButton on={fav.has(c.id)} toggle={() => useFavorites.getState().toggle('anim', c.id)} />
              <div className="lib-meta">
                <div className="lib-name">{previewing === c.id && <Play size={10} fill="currentColor" />} {c.name}</div>
                {view === 'list' && c.mine && <div className="lib-sub">{$t('我的動畫')}</div>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ───────────── 屬性面板 ─────────────

const DEF: Record<AnimProp, number> = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1 };
const chId = (layerId: string, prop: AnimProp) => `${layerId}:${prop}`;
const allCh = (prop: AnimProp) => `all:${prop}`;
const parseCh = (ch: string) => { const i = ch.lastIndexOf(':'); return { layerId: ch.slice(0, i), prop: ch.slice(i + 1) as AnimProp }; };

// ───── 圖層上的特效（跟片段特效一樣調參數 / 關鍵影格；關鍵影格是動畫內的秒數） ─────

type LayerFx = NonNullable<AnimLayer['effects']>[number];
/** 圖層特效的 channel：afx:<圖層>:<特效>:<參數> */
const afxCh = (layerId: string, fxId: string, param: string) => `afx:${layerId}:${fxId}:${param}`;
const parseAfx = (ch: string) => {
  if (!ch.startsWith('afx:')) return null;
  const [, layerId, fxId, ...rest] = ch.split(':');
  return { layerId, fxId, param: rest.join(':') };
};
const findFx = (animId: string, layerId: string, fxId: string) =>
  useStore.getState().anims.find((x) => x.id === animId)?.layers.find((l) => l.id === layerId)?.effects?.find((f) => f.id === fxId);
function patchLayerFx(animId: string, layerId: string, fn: (list: LayerFx[]) => LayerFx[]) {
  const a = useStore.getState().anims.find((x) => x.id === animId);
  if (a) useStore.getState().updateAnim(animId, { layers: a.layers.map((l) => (l.id === layerId ? { ...l, effects: fn(l.effects ?? []) } : l)) });
}
const updateFx = (animId: string, layerId: string, fxId: string, p: Partial<LayerFx>) =>
  patchLayerFx(animId, layerId, (list) => list.map((f) => (f.id === fxId ? { ...f, ...p } : f)));
function moveFx(animId: string, layerId: string, fxId: string, dir: -1 | 1) {
  patchLayerFx(animId, layerId, (list) => {
    const i = list.findIndex((f) => f.id === fxId), j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return list;
    const next = [...list];
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  });
}

/** 整體遮罩的 channel（`whole:mask.x`）→ `mask.x` */
type StoredMask = NonNullable<AnimItem['mask']>;
/** 遮罩的 channel → 哪一個遮罩（整體 `whole:mask.x` / 圖層 `lmask:<圖層>:mask.x`）、讀寫方法、屬性名（mask.x） */
function maskOfCh(ch: string): { prop: string; get: (x: AnimItem) => StoredMask | undefined; put: (x: AnimItem, v: StoredMask | undefined) => Partial<AnimItem> } | null {
  if (ch.startsWith('whole:')) return { prop: ch.slice(6), get: (x) => x.mask, put: (_x, v) => ({ mask: v }) };
  if (!ch.startsWith('lmask:')) return null;
  const [, layerId, ...rest] = ch.split(':');
  return { prop: rest.join(':'), get: (x) => x.layers.find((l) => l.id === layerId)?.clipMask,
    put: (x, v) => ({ layers: x.layers.map((l) => (l.id === layerId ? { ...l, clipMask: v } : l)) }) };
}

/** 關鍵影格：拍 ↔ 項目內秒數 */
const toSec = (a: AnimItem, list: Keyframe[]) => list.map((k) => ({ ...k, t: animSecAt(a, k.t) }));
const toBeat = (a: AnimItem, list: Keyframe[]) => sortKeys(list.map((k) => ({ ...k, t: animBeatAt(a, k.t) })));

function animHost(id: string): Host | null {
  const a = useStore.getState().anims.find((x) => x.id === id);
  if (!a) return null;
  const patchLayer = (layerId: string, fn: (l: AnimLayer) => AnimLayer) => {
    const cur = useStore.getState().anims.find((x) => x.id === id);
    if (cur) useStore.getState().updateAnim(id, { layers: cur.layers.map((l) => (l.id === layerId ? fn(l) : l)) });
  };
  return {
    owner: `anim:${id}`,
    start: a.start,
    duration: a.duration,
    setKeys(ch, list, base) {
      const fx = parseAfx(ch);
      if (fx) {
        const f = findFx(id, fx.layerId, fx.fxId);
        if (!f) return;
        const keys = { ...(f.keys ?? {}) };
        if (list?.length) keys[fx.param] = sortKeys(list);
        else delete keys[fx.param];
        return updateFx(id, fx.layerId, fx.fxId, { keys, ...(!list?.length && base !== undefined ? fxBasePatch(f, fx.param, base) : {}) });
      }
      const wm = maskOfCh(ch);
      if (wm) {
        const cur = useStore.getState().anims.find((x) => x.id === id);
        if (!cur) return;
        const old = wm.get(cur);
        const keys = { ...old?.keys };
        if (list?.length) keys[wm.prop] = toBeat(cur, list);
        else delete keys[wm.prop];
        const mask = { ...DEFAULT_MASK, ...old?.mask, ...(!list?.length && base !== undefined ? { [wm.prop.slice(5)]: base } : {}) };
        return useStore.getState().updateAnim(id, wm.put(cur, { mask, ...(Object.keys(keys).length ? { keys } : {}) }));
      }
      const { layerId, prop } = parseCh(ch);
      const cur = useStore.getState().anims.find((x) => x.id === id);
      if (!cur) return;
      if (layerId === 'all') {
        const keys = { ...cur.keys };
        if (list?.length) keys[prop] = toBeat(cur, list);
        else delete keys[prop];
        return useStore.getState().updateAnim(id, { keys,
          ...(!list?.length && base !== undefined ? { transform: { ...DEF, ...cur.transform, [prop]: base } } : {}) });
      }
      patchLayer(layerId, (l) => {
        const keys = { ...l.keys };
        if (list?.length) keys[prop] = toBeat(cur, list);
        else delete keys[prop];
        return { ...l, keys, ...(!list?.length && base !== undefined ? { base: { ...l.base, [prop]: base } } : {}) };
      });
    },
    setBase(ch, v) {
      const fx = parseAfx(ch);
      if (fx) {
        const f = findFx(id, fx.layerId, fx.fxId);
        return void (f && updateFx(id, fx.layerId, fx.fxId, fxBasePatch(f, fx.param, v)));
      }
      const wm = maskOfCh(ch);
      if (wm) {
        const cur = useStore.getState().anims.find((x) => x.id === id);
        const old = cur && wm.get(cur);
        if (cur) useStore.getState().updateAnim(id, wm.put(cur, { ...old, mask: { ...DEFAULT_MASK, ...old?.mask, [wm.prop.slice(5)]: v } }));
        return;
      }
      const { layerId, prop } = parseCh(ch);
      if (layerId === 'all') {
        const cur = useStore.getState().anims.find((x) => x.id === id);
        if (cur) useStore.getState().updateAnim(id, { transform: { ...DEF, ...cur.transform, [prop]: v } });
        return;
      }
      patchLayer(layerId, (l) => ({ ...l, base: { ...l.base, [prop]: v } }));
    },
  };
}

// 關鍵影格的拖曳 / 刪除 / 複製貼上 / 曲線編輯都透過這裡找到動畫的關鍵影格
registerHostKind('anim', {
  host: animHost,
  keys(id, ch) {
    const a = useStore.getState().anims.find((x) => x.id === id);
    if (!a) return [];
    const fx = parseAfx(ch);
    if (fx) return findFx(id, fx.layerId, fx.fxId)?.keys?.[fx.param] ?? [];
    const wm = maskOfCh(ch);
    if (wm) return toSec(a, wm.get(a)?.keys?.[wm.prop] ?? []);
    const { layerId, prop } = parseCh(ch);
    if (layerId === 'all') return toSec(a, a.keys?.[prop] ?? []);
    return toSec(a, a.layers.find((l) => l.id === layerId)?.keys[prop] ?? []);
  },
  all(id) {
    const a = useStore.getState().anims.find((x) => x.id === id);
    return [
      ...Object.entries(a?.keys ?? {}).flatMap(([prop, list]) => (list ?? []).map((k) => ({ ch: allCh(prop as AnimProp), id: k.id }))),
      ...Object.entries(a?.mask?.keys ?? {}).flatMap(([k, list]) => list.map((x) => ({ ch: animMaskCh(k), id: x.id }))),
      ...(a?.layers ?? []).flatMap((l) => [
      ...Object.entries(l.keys).flatMap(([prop, list]) => (list ?? []).map((k) => ({ ch: chId(l.id, prop as AnimProp), id: k.id }))),
      ...Object.entries(l.clipMask?.keys ?? {}).flatMap(([k, list]) => list.map((x) => ({ ch: layerMaskCh(l.id, k), id: x.id }))),
      ...(l.effects ?? []).flatMap((f) => Object.entries(f.keys ?? {}).flatMap(([param, list]) => list.map((k) => ({ ch: afxCh(l.id, f.id, param), id: k.id })))),
      ]),
    ];
  },
});

/** 圖片位置的一列：縮圖、名稱；從素材分頁拖素材到這一列 = 換這一張 */
function SlotRow({ a, slot, name }: { a: AnimItem; slot: AnimSlot; name: string }) {
  const m = useStore((s) => (slot.mediaId ? s.media.find((x) => x.id === slot.mediaId) : undefined));
  const over = useDrag((x) => x.drag?.target?.kind === 'animSlot' && x.drag.target.animId === a.id && x.drag.target.slotId === slot.id);
  const ok = mediaUsable(m);
  // 還沒放圖：縮圖顯示預覽用的示範圖（淡一點）
  const ph = slot.mediaId ? null : placeholderFor(a, slot.id);
  const set = (p: Partial<AnimSlot>) => patchAnimSlot(a.id, slot.id, p);
  // 「選擇素材」視窗是這一列打開的：標起來
  const pickRef = useRef<HTMLButtonElement>(null);
  const anchor = usePickerAnchor();
  const picking = !!anchor && anchor === pickRef.current;
  const [cropping, setCropping] = useState(false);
  const [fixing, setFixing] = useState(false);
  return (
    <div className={`anim-slot ${ok ? '' : 'missing'} ${over ? 'drop-here' : ''} ${picking ? 'picking' : ''} ${slot.hidden ? 'off' : ''}`} data-anim-slot={`${a.id}|${slot.id}`}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); openMenu(e.clientX, e.clientY, imageMenu([a.id], slot.id)); }}>
      <button ref={pickRef} data-picker-anchor className="anim-slot-pick" title={$t('選擇素材')}
        onClick={(e) => openPicker(e.currentTarget, $t('選擇素材'), (close) => <AnimMediaPicker animId={a.id} slotId={slot.id} onDone={close} />)}>
        <div className={`anim-slot-thumb ${ph ? 'placeholder' : ''}`} style={ok && m.thumb ? { backgroundImage: `url(${m.thumb})` } : ph ? { backgroundImage: `url(${ph.url})` } : undefined} />
        <div className="anim-slot-text">
          <span className="anim-slot-role">{name}</span>
          <span className="anim-slot-name">{ok ? m.name : slot.mediaId ? $t('（素材遺失）') : $t('待補')}</span>
        </div>
      </button>
      {ok && m.kind === 'video' && (
        <DragNumber value={slot.sourceTime} min={0} max={Math.max(0, m.duration - 0.05)} step={0.04} decimals={2} suffix="s" onChange={(v) => set({ sourceTime: v })} />
      )}
      {ok && (m.kind === 'video' || m.kind === 'image') && (
        <button className={`ec-icon ${isFullCrop(slot.crop) ? '' : 'on'}`} title={$t('裁切')} onClick={() => setCropping(true)}><CropIcon size={13} /></button>
      )}
      {cropping && ok && createPortal(<CropDialog m={m} time={slot.sourceTime} init={slot.crop} onCommit={(crop) => set({ crop })} onClose={() => setCropping(false)} />, document.body)}
      {ok && slot.cutout?.mode === 'auto' && (m.kind === 'video' || m.kind === 'image') && (
        <button className={`ec-icon ${slotEdit(slot) ? 'on' : ''}`} title={$t('修正去背')} onClick={() => setFixing(true)}><Scissors size={13} /></button>
      )}
      {fixing && createPortal(<SlotCutoutEditor animId={a.id} slotId={slot.id} onClose={() => setFixing(false)} />, document.body)}
      {slot.cutout && <span className="anim-slot-cut" title={$t('去背')}><Switch v={slot.cutout.mode === 'auto'} on={(v) => set({ cutout: { ...slot.cutout, mode: v ? 'auto' : 'off' } })} /></span>}
      <button className={`ec-icon ${slot.hidden ? 'on' : ''}`} title={slot.hidden ? $t('顯示') : $t('隱藏')} onClick={() => set({ hidden: slot.hidden ? undefined : true })}>{slot.hidden ? <EyeOff size={13} /> : <Eye size={13} />}</button>
      {slot.mediaId && <button className="ec-icon" title={$t('清除')} onClick={() => set({ mediaId: null })}><X size={12} /></button>}
    </div>
  );
}

/** 另存成我的動畫（同名 = 覆蓋） */
async function saveAnimPreset(a: AnimItem) {
  const name = (await promptDialog({ title: $t('另存成我的動畫'), value: a.name ?? '' }))?.trim();
  if (!name) return;
  const P = usePrefs.getState();
  const old = P.animPresets.find((p) => p.name === name);
  const item: AnimItem = { ...structuredClone(a), id: 'preset', start: 0, track: 0, take: undefined, locked: undefined, group: undefined, link: undefined, name };
  const preset: AnimPreset = { id: old?.id ?? uid(), name, item };
  P.set({ animPresets: old ? P.animPresets.map((p) => (p.id === old.id ? preset : p)) : [...P.animPresets, preset] });
  toast($t('已存成我的動畫'));
}

/** 圖層上的特效：每個一個區塊（跟片段特效一樣：開關、上下移、移除、參數 / 關鍵影格），多一列「觸發」 */
function fxSections(a: AnimItem, l: AnimLayer, local: number, modules: ReturnType<typeof useStore.getState>['modules']): Section[] {
  const list = l.effects ?? [];
  return list.map((f, i) => {
    const mod = modules.find((m) => m.id === f.moduleId);
    const off = f.enabled === false;
    const set = (p: Partial<LayerFx>) => updateFx(a.id, l.id, f.id, p);
    return effectSections(f, mod, local, (p) => set(p as Partial<LayerFx>), {
      idBase: `afx.${l.id}.${f.id}`,
      fresh: () => findFx(a.id, l.id, f.id),
      ch: (c) => afxCh(l.id, f.id, c),
      dim: off,
      badge: <span className="kind k-fx cfx-badge">{$t('特效')}</span>,
      topRows: [{
        label: $t('觸發'),
        node: <Seg value={f.beatEvery ?? 0} on={(v) => set({ beatEvery: v ? v as 1 | 2 : undefined })}
          opts={[{ v: 0, label: $t('整段') }, { v: 1, label: $t('每拍') }, { v: 2, label: $t('隔拍') }]} />,
      }],
      actions: (
        <>
          <button className="ec-icon" title={off ? $t('開啟這個特效') : $t('暫時關閉這個特效')} onClick={() => set({ enabled: off })}>
            {off ? <EyeOff size={13} /> : <Eye size={13} />}
          </button>
          <button className="ec-icon" title={$t('往上移（先套用）')} disabled={i === 0} onClick={() => moveFx(a.id, l.id, f.id, -1)}><ChevronUp size={13} /></button>
          <button className="ec-icon" title={$t('往下移（後套用）')} disabled={i === list.length - 1} onClick={() => moveFx(a.id, l.id, f.id, 1)}><ChevronDown size={13} /></button>
          <button className="ec-icon danger" title={$t('移除這個特效')} onClick={() => patchLayerFx(a.id, l.id, (x) => x.filter((y) => y.id !== f.id))}><Trash2 size={13} /></button>
        </>
      ),
    })[0];
  });
}

/**
 * 動畫的遮罩（整體 / 圖層，跟片段遮罩同一套：形狀、繪製、在預覽中編輯、反轉、關鍵影格）。
 * ch：channel 的前綴（`whole:` / `lmask:<圖層>:`）；key：預覽上編輯 / 繪製的對象
 */
function animMaskBlock(a: AnimItem, local: number, chOf: (c: string) => string, key: string) {
  const ref = maskOfCh(chOf('mask.x'))!;
  const asFx = (x: AnimItem): FxLike => {
    const m = ref.get(x);
    return { moduleId: CLIP_MASK_ID, params: {}, mask: m?.mask, keys: Object.fromEntries(Object.entries(m?.keys ?? {}).map(([k, l]) => [k, toSec(x, l)])) };
  };
  const fresh = () => useStore.getState().anims.find((x) => x.id === a.id);
  const clear = () => { const cur = fresh(); if (cur) useStore.getState().updateAnim(a.id, ref.put(cur, undefined)); };
  const update = (p: Partial<FxLike>) => {
    const cur = fresh();
    if (!cur) return;
    if (('mask' in p && !p.mask) || p.mask?.shape === 'none') return clear();
    const old = ref.get(cur);
    const keys = p.keys
      ? Object.fromEntries(Object.entries(p.keys).filter(([k]) => k.startsWith('mask.')).map(([k, l]) => [k, toBeat(cur, l)]))
      : old?.keys;
    useStore.getState().updateAnim(a.id, ref.put(cur, { mask: p.mask ?? old?.mask ?? DEFAULT_MASK, ...(keys && Object.keys(keys).length ? { keys } : {}) }));
  };
  const { rows, chs } = maskBlock(asFx(a), local, update, {
    fresh: () => { const x = fresh(); return x && asFx(x); },
    editKey: key, drawKey: key, ch: chOf,
  });
  return { rows, chs, clear };
}

function wholeMaskSection(a: AnimItem, local: number): Section {
  const { rows, chs, clear } = animMaskBlock(a, local, animMaskCh, animMaskKey(a.id));
  return { id: 'allmask', title: $t('遮罩'), rows: [{ ...rows[0], label: $t('形狀') }, ...rows.slice(1)], channels: chs, onReset: clear };
}

export function AnimInspector({ id }: { id: string }) {
  useMaskEdit((s) => s.key); // 遮罩「在預覽中編輯」狀態改變時重畫
  const a = useStore((s) => s.anims.find((x) => x.id === id));
  const time = useStore((s) => s.time);
  const modules = useStore((s) => s.modules);
  if (!a) return null;
  const host = animHost(id)!;
  const beat = animBeatAt(a, Math.max(0, Math.min(a.duration, time - a.start)));
  const local = Math.max(0, Math.min(a.duration, time - a.start));
  // 畫出來的圖、還有拿來當遮罩輪廓的圖（剪影窗 / 主體挖洞的主體）都要列出來
  const slots = usedImageSlots(a);
  const slotOf = new Map(a.slots.map((s) => [s.id, s]));
  const names = slotNames(a);
  // 圖層自己的遮罩（跟著圖層動）
  const layerMask = (l: AnimLayer) => animMaskBlock(a, local, (c) => layerMaskCh(l.id, c), layerMaskKey(a.id, l.id));
  const setLayer = (layerId: string, p: Partial<AnimLayer>) => {
    const cur = useStore.getState().anims.find((x) => x.id === id);
    if (cur) useStore.getState().updateAnim(id, { layers: cur.layers.map((x) => (x.id === layerId ? { ...x, ...p } : x)) });
  };
  const sections: Section[] = [
    {
      id: 'all', title: $t('整體'),
      channels: ANIM_PROPS.map(({ prop, label, step, suffix, min, max }): Channel => ({
        id: allCh(prop), label, step, suffix, min, max, def: DEF[prop],
        value: animTransformAt(a, beat)[prop], keys: toSec(a, a.keys?.[prop] ?? []),
      })),
    },
    wholeMaskSection(a, local),
    {
      id: 'slots',
      title: $t('圖片'),
      menu: () => imageMenu([a.id]),
      rows: slots.length > 1 ? [{ label: $t('全用同一張'), node: <Switch v={!!a.sameMedia} on={(v) => setAnimSameMedia(a.id, v)} /> }] : undefined,
      footer: <div className="anim-slots" onContextMenu={(e) => { e.preventDefault(); openMenu(e.clientX, e.clientY, imageMenu([a.id])); }}>{slots.map((s) => <SlotRow key={s.id} a={a} slot={s} name={names.get(s.id) ?? ''} />)}</div>,
    },
    // 文字層（文字在主體後面）沒有圖片，但文字和位置要能改
    ...a.layers.filter((l) => slotOf.get(l.slotId)?.role !== 'other' || l.text !== undefined).map((l) => ({ l, lm: layerMask(l) })).flatMap(({ l, lm }, i): Section[] => [{
      id: `layer.${l.id}`,
      defaultCollapsed: a.layers.length > 3,
      title: `${$t('圖層 {0}', i + 1)} · ${names.get(l.slotId) ?? ''}`,
      rows: [
        ...(l.text !== undefined ? [{ label: $t('文字'), node: <input className="text-input" value={l.text}
          onChange={(e) => setLayer(l.id, { text: e.target.value })} /> }] : []),
        { label: $t('混合模式'), node: (
          <select className="select" value={l.blend ?? 'normal'}
            onChange={(e) => setLayer(l.id, { blend: e.target.value === 'normal' ? undefined : e.target.value as BlendMode })}>
            {Object.entries(BLENDS()).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        ) },
        ...lm.rows,
      ],
      actions: (
        <button className="ec-icon" title={$t('加入特效…')}
          onClick={(e) => openPicker(e.currentTarget, $t('加入特效'), (close) => <ModuleLibrary kind="effect" onPick={(mid) => { addAnimLayerFx(a.id, l.id, mid); close(); }} />)}>
          <Sparkles size={13} />
        </button>
      ),
      channels: ANIM_PROPS.map(({ prop, label, step, suffix, min, max }): Channel => {
        const keys = l.keys[prop] ?? [];
        const base = l.base?.[prop] ?? DEF[prop];
        return { id: chId(l.id, prop), label, step, suffix, min, max, def: DEF[prop],
          value: keys.length ? evalKeys(keys, beat) : base, keys: toSec(a, keys) };
      }).concat(lm.chs),
    }, ...fxSections(a, l, local, modules)]),
  ];
  return (
    <EffectControls
      host={host}
      sections={sections}
      titleMenu={() => [{ label: $t('另存成我的動畫…'), action: () => void saveAnimPreset(a) }]}
      title={<Title kind="k-anim" label={$t('動畫')} name={a.name ?? templateName(a.presetId) ?? $t('動畫')}
        onRename={(n) => useStore.getState().renameItem('anim', a.id, n)}
        tag={<button className="ec-icon" title={$t('另存成我的動畫…')} onClick={() => void saveAnimPreset(a)}><Save size={12} /></button>} />}
    />
  );
}
