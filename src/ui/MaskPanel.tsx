import { $t } from '../i18n';
import { Ban, Plus, CircleHelp, PenTool } from 'lucide-react';
import React, { useState } from 'react';
import { useStore, type FxItem } from '../store';
import { DEFAULT_MASK, type Mask, type MaskShape } from '../engine/mask';
import { allShapes, shapeFromImage, shapeInfo, useMaskLib, type ShapeInfo } from '../engine/maskShapes';
import { pickFiles } from '../engine/media';
import { CLIP_MASK_ID } from '../modules/extra';
import { FavButton, LibFilter, LibToolbar, match } from './Library';
import { startLibraryDrag } from './dnd';
import { cfxMaskKey, useMaskEdit } from './MaskEditor';
import { openShapeDrawer } from './ShapeDrawer';
import { confirmDialog, openMenu, promptDialog, toast, useLayout, type MenuItem } from './uiStore';

/**
 * 遮罩形狀庫：跟「色板」很像，只是挑的是形狀。
 * 分頁：點一下 = 套用到選取的片段（加片段遮罩）/ 特效（換遮罩形狀），也可以拖到時間軸的片段或特效上。
 * 挑選視窗（屬性面板的遮罩欄位、加入片段遮罩）用同一個元件，帶 onPick。
 */

// ───────────── 套用 ─────────────

/** 新遮罩框的大小：照形狀原本的比例（矩形 / 橢圓沿用以前的 80% × 60%） */
function sizeFor(shape: MaskShape): { w: number; h: number } {
  if (shape === 'rect' || shape === 'ellipse') return { w: 0.8, h: 0.6 };
  const aspect = shapeInfo(shape)?.aspect ?? 1;
  const { w: FW, h: FH } = useStore.getState().format;
  let h = 0.5;
  let w = (h * FH * aspect) / FW;
  if (w > 0.8) {
    h *= 0.8 / w;
    w = 0.8;
  }
  return { w, h };
}

/** 改遮罩形狀：原本沒有遮罩 → 依形狀比例給大小；換成自訂形狀 → 保持高度、寬度照圖片比例 */
export function setMaskShape(cur: Mask, shape: MaskShape, update: (p: { mask: Mask }) => void) {
  const next: Mask = { ...cur, shape };
  // 換成別的形狀：遮罩自己的鋼筆路徑就不要了
  delete next.path;
  delete next.pen;
  if (shape !== 'none' && cur.shape === 'none') Object.assign(next, sizeFor(shape));
  else if (shape.startsWith('custom:')) {
    const { w: FW, h: FH } = useStore.getState().format;
    next.w = (cur.h * FH * (shapeInfo(shape)?.aspect ?? 1)) / FW;
  }
  update({ mask: next });
}

/** 片段遮罩 = 一個特殊的片段特效（沿用遮罩的關鍵影格、預覽拖曳編輯、分割 / 合併處理）。這裡是「疊加」的那種 */
export function addClipMask(clipId: string, shape: MaskShape) {
  if (shape === 'none') return;
  const S = useStore.getState();
  S.addClipFx(clipId, CLIP_MASK_ID);
  const f = useStore.getState().clips.find((c) => c.id === clipId)?.effects?.at(-1);
  if (!f) return;
  S.updateClipFx(clipId, f.id, { mask: { ...DEFAULT_MASK, shape, ...sizeFor(shape) } });
  useMaskEdit.setState({ key: cfxMaskKey(f.id) }); // 加了片段遮罩就直接在預覽上調整
}

/** 片段本身的遮罩（屬性面板的「遮罩」區塊；每個片段最多一個） */
export const clipBaseMask = (clipId: string) => useStore.getState().clips.find((c) => c.id === clipId)?.effects?.find((f) => f.base);

/** 片段本身的遮罩：還沒有就建立；回傳它的 id */
export function ensureClipBaseMask(clipId: string): string | null {
  const cur = clipBaseMask(clipId);
  if (cur) return cur.id;
  const S = useStore.getState();
  if (!S.clips.some((c) => c.id === clipId)) return null;
  S.addClipFx(clipId, CLIP_MASK_ID);
  const f = useStore.getState().clips.find((c) => c.id === clipId)?.effects?.at(-1);
  if (!f) return null;
  S.updateClipFx(clipId, f.id, { base: true });
  return f.id;
}

/** 設定片段本身的遮罩形狀（形狀庫點一下 / 拖到片段上） */
export function setClipMask(clipId: string, shape: MaskShape, edit = true) {
  if (shape === 'none') {
    const f = clipBaseMask(clipId);
    if (f) useStore.getState().updateClipFx(clipId, f.id, { mask: { ...DEFAULT_MASK, ...f.mask, shape: 'none' } });
    return;
  }
  const id = ensureClipBaseMask(clipId);
  if (!id) return;
  const f = clipBaseMask(clipId)!;
  setMaskShape({ ...DEFAULT_MASK, ...f.mask }, shape, (p) => useStore.getState().updateClipFx(clipId, id, p));
  if (edit) useMaskEdit.setState({ key: cfxMaskKey(id) });
}

/** 特效軌上的特效：換遮罩形狀 */
export function setEffectMask(fxId: string, shape: MaskShape) {
  const S = useStore.getState();
  const fx = S.effects.find((f) => f.id === fxId);
  if (!fx) return;
  setMaskShape({ ...DEFAULT_MASK, ...fx.mask }, shape, (p) => S.updateEffect(fxId, p as Partial<FxItem>));
}

/** 鋼筆畫新形狀時套用到哪裡：選取的片段（片段本身的遮罩）/ 特效軌的特效；沒選 = 只存進形狀庫 */
function drawKeyForSelection(): string | undefined {
  const s = useStore.getState();
  const sel = s.selection;
  if (sel?.type === 'clip' && s.clips.some((c) => c.id === sel.id)) return `clip:${sel.id}`;
  if (sel?.type === 'effect' && s.effects.some((f) => f.id === sel.id)) return `fx:${sel.id}`;
  return undefined;
}

/** 分頁裡點一下：套用到目前選取的東西 */
function applyToSelection(shape: MaskShape) {
  const s = useStore.getState();
  const sel = s.selection;
  if (sel?.type === 'clip' && s.clips.some((c) => c.id === sel.id)) return setClipMask(sel.id, shape);
  if (sel?.type === 'effect') {
    setEffectMask(sel.id, shape);
    return toast($t('已設定特效的遮罩形狀'));
  }
  toast($t('先在時間軸上選取片段或特效，或把形狀拖到片段上'), 'error');
}

// ───────────── 縮圖 ─────────────

/** 形狀縮圖（跟著文字顏色） */
export function ShapeThumb({ id, className, path }: { id: string; className?: string; /** id = 'path'：遮罩自己的路徑 */ path?: string }) {
  const cls = `shape-thumb ${className ?? ''}`;
  if (id === 'none') return <span className={cls}><Ban size={14} /></span>;
  const info = id === 'path' ? (path ? { path, aspect: 1, png: undefined } : undefined) : shapeInfo(id);
  if (!info) return <span className={cls}><CircleHelp size={14} /></span>;
  if (info.path) {
    const wide = info.aspect >= 1;
    return (
      <span className={cls}>
        <svg viewBox="0 0 200 200" preserveAspectRatio="none" style={wide ? { width: '100%', height: `${100 / info.aspect}%` } : { height: '100%', width: `${100 * info.aspect}%` }}>
          <path d={info.path} fillRule="evenodd" fill="currentColor" />
        </svg>
      </span>
    );
  }
  const wide = info.aspect >= 1;
  return (
    <span className={cls}>
      <span
        className="shape-png"
        style={{ WebkitMaskImage: `url(${info.png})`, maskImage: `url(${info.png})`, ...(wide ? { width: '100%', height: `${100 / info.aspect}%` } : { height: '100%', width: `${100 * info.aspect}%` }) }}
      />
    </span>
  );
}

/** 拖曳時的小圖（白色形狀） */
function dragThumb(info: ShapeInfo) {
  if (info.png) return info.png;
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="-20 -20 240 240"><path d="${info.path}" fill="#fff" fill-rule="evenodd"/></svg>`)}`;
}

// ───────────── 形狀庫 ─────────────

async function importShapes() {
  const files = await pickFiles('image/*,.svg', true);
  let n = 0;
  for (const f of files) {
    const s = await shapeFromImage(f);
    if (s) {
      useMaskLib.getState().add(s);
      n++;
    } else toast($t('「{0}」讀不到形狀（整張是空的或無法解碼）', f.name), 'error');
  }
  if (n) {
    // 匯入後切到「自訂」分類（打開分類籤，才看得到現在篩的是哪一類）
    const L = useLayout.getState();
    L.set({ modCat: { ...L.modCat, mask: 'custom' }, libFilterOpen: { ...L.libFilterOpen, mask: true } });
    toast($t('已加入 {0} 個自訂形狀', n));
  }
}

export function MaskPanel() {
  return <MaskLibrary />;
}

export function MaskLibrary({ onPick, current, allowNone, drawKey }: { onPick?: (shape: MaskShape) => void; current?: string; allowNone?: boolean; /** 鋼筆畫的形狀套用到哪個遮罩（挑選視窗用；沒給 = 看目前選取） */ drawKey?: string }) {
  const lib = useMaskLib();
  const view = useLayout((s) => s.libView.mask ?? 'grid');
  const cat = useLayout((s) => (s.libFilterOpen.mask ? s.modCat.mask ?? 'all' : 'all'));
  const setCat = (c: string) => useLayout.getState().set({ modCat: { ...useLayout.getState().modCat, mask: c } });
  const [q, setQ] = useState('');
  const shapes = allShapes();
  const fav = new Set(lib.favorites);
  const inCat = (s: ShapeInfo, c: string) => c === 'all' || (c === 'fav' ? fav.has(s.id) : s.cat === c);
  const cats = [
    { id: 'all', label: $t('全部') },
    { id: 'fav', label: $t('我的最愛') },
    { id: 'basic', label: $t('基本') },
    { id: 'symbol', label: $t('符號') },
    { id: 'custom', label: $t('自訂') },
  ].map((c) => ({ ...c, count: shapes.filter((s) => inCat(s, c.id)).length }));
  const list = shapes.filter((s) => inCat(s, cat) && match(s.name, q));

  const pick = (id: string) => (onPick ? onPick(id) : applyToSelection(id));

  const itemMenu = (e: React.MouseEvent, s: ShapeInfo) => {
    e.preventDefault();
    e.stopPropagation();
    const items: MenuItem[] = [
      { label: fav.has(s.id) ? $t('從我的最愛移除') : $t('加入我的最愛'), action: () => lib.toggleFav(s.id) },
      { label: onPick ? $t('使用這個形狀') : $t('套用到選取的片段 / 特效'), action: () => pick(s.id) },
    ];
    if (s.cat === 'custom') {
      const custom = lib.customs.find((c) => c.id === s.id);
      items.push(
        { separator: true },
        ...(custom?.pen ? [{ label: $t('編輯形狀…'), action: () => openShapeDrawer({ id: s.id }) }] : []),
        {
          label: $t('重新命名…'),
          action: async () => {
            const n = await promptDialog({ title: $t('重新命名形狀'), value: s.name });
            if (n?.trim()) lib.rename(s.id, n.trim());
          },
        },
        {
          label: $t('刪除形狀'),
          danger: true,
          action: async () => {
            const ok = await confirmDialog({ title: $t('刪除形狀？'), message: $t('已經用了這個形狀的遮罩會變成「形狀遺失」（改用矩形顯示），可以再換成別的形狀。'), ok: $t('刪除'), danger: true });
            if (ok) lib.remove(s.id);
          },
        },
      );
    }
    openMenu(e.clientX, e.clientY, items);
  };

  const empty = cat === 'fav' ? $t('還沒有我的最愛') : cat === 'custom' ? $t('還沒有自訂形狀') : $t('沒有符合的形狀');

  return (
    <div className="lib mask-lib" onContextMenu={(e) => e.preventDefault()}>
      <LibToolbar id="mask" query={q} setQuery={setQ} filter={{ active: cat !== 'all', reset: () => setCat('all') }}>
        <button className="lib-add" title={$t('畫新形狀')} onClick={() => openShapeDrawer({ target: drawKey ?? drawKeyForSelection() })}><PenTool size={14} /></button>
        <button className="lib-add" title={$t('匯入自訂形狀（PNG / SVG 圖片）')} onClick={importShapes}><Plus size={15} /></button>
      </LibToolbar>
      <LibFilter id="mask" cats={cats} cur={cat} set={setCat} />
      <div className="lib-body">
        {list.length === 0 && <p className="muted small center">{empty}</p>}
        <div className={view === 'grid' ? 'lib-grid shapes' : 'lib-list'}>
          {allowNone && cat === 'all' && !q && (
            <div className={`lib-item shape-item ${current === 'none' ? 'current' : ''}`} onClick={() => pick('none')} title={$t('不使用遮罩')}>
              <div className="lib-thumb shape-cell"><ShapeThumb id="none" /></div>
              <div className="lib-meta"><div className="lib-name">{$t('無')}</div></div>
            </div>
          )}
          {list.map((s) => (
            <div
              key={s.id}
              className={`lib-item shape-item ${current === s.id ? 'current' : ''}`}
              onPointerDown={(e) => !onPick && startLibraryDrag(e, { kind: 'mask', shape: s.id }, s.name, dragThumb(s))}
              onClick={() => pick(s.id)}
              onContextMenu={(e) => itemMenu(e, s)}
              title={s.name}
            >
              <div className="lib-thumb shape-cell"><ShapeThumb id={s.id} /></div>
              <FavButton on={fav.has(s.id)} toggle={() => lib.toggleFav(s.id)} />
              <div className="lib-meta">
                <div className="lib-name">{s.name}</div>
                {view === 'list' && s.cat === 'custom' && <div className="lib-sub">{$t('自訂')}</div>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
