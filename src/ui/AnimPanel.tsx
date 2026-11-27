/**
 * 動畫：素材庫分頁（內建範本 + 我的動畫）與屬性面板。
 * 動畫的關鍵影格以「拍」為單位；屬性面板的曲線編輯器用秒，這裡換算。
 */
import React, { useState } from 'react';
import { Save, X } from 'lucide-react';
import { $t } from '../i18n';
import { mediaUsable, uid, useStore } from '../store';
import { usePrefs, type AnimPreset } from '../prefs';
import { ANIM_PROPS, evalKeys, sortKeys, type AnimProp, type Keyframe } from '../engine/keyframes';
import { animBeatAt, animSecAt, type AnimItem, type AnimLayer, type AnimSlot } from '../engine/animation';
import { placeAnim } from '../engine/animPlace';
import { POP_VARIANTS, type PopVariant } from '../engine/subjectPop';
import { FavButton, LibFilter, LibToolbar, match, onBlank } from './Library';
import { startLibraryDrag } from './dnd';
import { useFavList, useFavorites } from './favorites';
import { EffectControls, type Channel, type Host, type Section } from './EffectControls';
import { DragNumber } from './DragNumber';
import { Switch } from './Toggle';
import { Title } from './LeftPanel';
import { ANIM_GROUPS, AnimDemo, animName } from './PopPicker';
import { confirmDialog, openMenu, promptDialog, toast, useDrag, useLayout, type MenuItem } from './uiStore';

// ───────────── 素材庫分頁 ─────────────

export function AnimPanel() {
  const presets = usePrefs((x) => x.animPresets);
  const view = useLayout((s) => s.libView.anim ?? 'grid');
  const cat = useLayout((s) => (s.libFilterOpen.anim ? s.modCat.anim ?? 'all' : 'all'));
  const setCat = (c: string) => useLayout.getState().set({ modCat: { ...useLayout.getState().modCat, anim: c } });
  const [q, setQ] = useState('');
  const favorites = useFavList('anim');
  const fav = new Set(favorites);
  type Card = { id: string; name: string; variant: PopVariant; mine?: AnimPreset; group: string };
  const all: Card[] = [
    ...ANIM_GROUPS.flatMap((g) => g.items.map((v) => ({ id: v, name: animName(v), variant: v, group: g.id }))),
    ...presets.map((p) => ({ id: `my:${p.id}`, name: p.name, variant: (p.item.presetId as PopVariant) ?? 'step', mine: p, group: 'mine' })),
  ];
  const inCat = (c: Card, k: string) => k === 'all' || (k === 'fav' ? fav.has(c.id) : c.group === k);
  const cats = [
    { id: 'all', label: $t('全部') },
    { id: 'fav', label: $t('我的最愛') },
    ...ANIM_GROUPS.map((g) => ({ id: g.id, label: g.label() })),
    { id: 'mine', label: $t('我的動畫') },
  ].map((c) => ({ ...c, count: all.filter((x) => inCat(x, c.id)).length }));
  const list = all.filter((c) => inCat(c, cat) && match(c.name, q));
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
      <div className="lib-body" onDoubleClick={onBlank()}>
        {list.length === 0 && <p className="muted small center">{cat === 'mine' ? $t('還沒有我的動畫') : $t('沒有符合的動畫')}</p>}
        <div className={view === 'grid' ? 'lib-grid' : 'lib-list'}>
          {list.map((c) => (
            <div key={c.id} className="lib-item anim-item" title={c.name}
              onPointerDown={(e) => startLibraryDrag(e, { kind: 'anim', id: c.id }, c.name)}
              onDoubleClick={() => atPlayhead(c.id)}
              onContextMenu={(e) => itemMenu(e, c)}>
              <div className="lib-thumb anim-thumb"><AnimDemo v={c.variant} /></div>
              <FavButton on={fav.has(c.id)} toggle={() => useFavorites.getState().toggle('anim', c.id)} />
              <div className="lib-meta">
                <div className="lib-name">{c.name}</div>
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
const parseCh = (ch: string) => { const i = ch.lastIndexOf(':'); return { layerId: ch.slice(0, i), prop: ch.slice(i + 1) as AnimProp }; };

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
      const { layerId, prop } = parseCh(ch);
      const cur = useStore.getState().anims.find((x) => x.id === id);
      if (!cur) return;
      patchLayer(layerId, (l) => {
        const keys = { ...l.keys };
        if (list?.length) keys[prop] = toBeat(cur, list);
        else delete keys[prop];
        return { ...l, keys, ...(!list?.length && base !== undefined ? { base: { ...l.base, [prop]: base } } : {}) };
      });
    },
    setBase(ch, v) {
      const { layerId, prop } = parseCh(ch);
      patchLayer(layerId, (l) => ({ ...l, base: { ...l.base, [prop]: v } }));
    },
  };
}

const roleName = (s: AnimSlot, i: number) => ({
  subject: $t('主體'), background: $t('背景'), reveal: $t('揭露'), copy: $t('分身 {0}', i), other: $t('文字'),
} as Record<AnimSlot['role'], string>)[s.role];

/** 圖片位置的一列：縮圖、名稱；從素材分頁拖素材到這一列 = 換這一張 */
function SlotRow({ a, slot, index }: { a: AnimItem; slot: AnimSlot; index: number }) {
  const m = useStore((s) => (slot.mediaId ? s.media.find((x) => x.id === slot.mediaId) : undefined));
  const over = useDrag((x) => x.drag?.target?.kind === 'animSlot' && x.drag.target.animId === a.id && x.drag.target.slotId === slot.id);
  const ok = mediaUsable(m);
  const set = (p: Partial<AnimSlot>) => useStore.getState().updateAnim(a.id, { slots: a.slots.map((s) => (s.id === slot.id ? { ...s, ...p } : s)) });
  return (
    <div className={`anim-slot ${ok ? '' : 'missing'} ${over ? 'drop-here' : ''}`} data-anim-slot={`${a.id}|${slot.id}`}>
      <div className="anim-slot-thumb" style={ok && m.thumb ? { backgroundImage: `url(${m.thumb})` } : undefined} />
      <div className="anim-slot-text">
        <span className="anim-slot-role">{roleName(slot, index)}</span>
        <span className="anim-slot-name">{ok ? m.name : slot.mediaId ? $t('（素材遺失）') : $t('待補')}</span>
      </div>
      {ok && m.kind === 'video' && (
        <DragNumber value={slot.sourceTime} min={0} max={Math.max(0, m.duration - 0.05)} step={0.04} decimals={2} suffix="s" onChange={(v) => set({ sourceTime: v })} />
      )}
      {slot.cutout && <span className="anim-slot-cut" title={$t('去背')}><Switch v={slot.cutout.mode === 'auto'} on={(v) => set({ cutout: { ...slot.cutout, mode: v ? 'auto' : 'off' } })} /></span>}
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

export function AnimInspector({ id }: { id: string }) {
  const a = useStore((s) => s.anims.find((x) => x.id === id));
  const time = useStore((s) => s.time);
  if (!a) return null;
  const host = animHost(id)!;
  const beat = animBeatAt(a, Math.max(0, Math.min(a.duration, time - a.start)));
  // 畫出來的圖、還有拿來當遮罩輪廓的圖（剪影窗 / 主體挖洞的主體）都要列出來
  const used = new Set(a.layers.flatMap((l) => [l.slotId, ...(l.mask ? [l.mask.slotId] : [])]));
  const slots = a.slots.filter((s) => used.has(s.id) && s.role !== 'other');
  const slotOf = new Map(a.slots.map((s) => [s.id, s]));
  let copyN = 0;
  const slotNames = new Map(a.slots.map((s) => [s.id, roleName(s, s.role === 'copy' ? ++copyN : 0)]));
  const sections: Section[] = [
    {
      id: 'slots',
      title: $t('圖片'),
      footer: <div className="anim-slots">{slots.map((s, i) => <SlotRow key={s.id} a={a} slot={s} index={i + 1} />)}</div>,
    },
    ...a.layers.filter((l) => slotOf.get(l.slotId)?.role !== 'other').map((l, i): Section => ({
      id: `layer.${l.id}`,
      title: `${$t('圖層 {0}', i + 1)} · ${slotNames.get(l.slotId) ?? ''}`,
      channels: ANIM_PROPS.map(({ prop, label, step, suffix, min, max }): Channel => {
        const keys = l.keys[prop] ?? [];
        const base = l.base?.[prop] ?? DEF[prop];
        return { id: chId(l.id, prop), label, step, suffix, min, max, def: DEF[prop],
          value: keys.length ? evalKeys(keys, beat) : base, keys: toSec(a, keys) };
      }),
    })),
  ];
  return (
    <EffectControls
      host={host}
      sections={sections}
      titleMenu={() => [{ label: $t('另存成我的動畫…'), action: () => void saveAnimPreset(a) }]}
      title={<Title kind="k-anim" label={$t('動畫')} name={a.name ?? (a.presetId && (POP_VARIANTS as string[]).includes(a.presetId) ? animName(a.presetId as PopVariant) : $t('動畫'))}
        onRename={(n) => useStore.getState().renameItem('anim', a.id, n)}
        tag={<button className="ec-icon" title={$t('另存成我的動畫…')} onClick={() => void saveAnimPreset(a)}><Save size={12} /></button>} />}
    />
  );
}
