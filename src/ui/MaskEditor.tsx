import React from 'react';
import { create } from 'zustand';
import { useStore } from '../store';
import { $t, displayName } from '../i18n';
import { maskAt, maskKey, type Mask } from '../engine/mask';
import { upsertKey } from '../engine/keyframes';
import { cfxCh, clipHost, fxHost } from './EffectControls';

/** 正在預覽畫面上編輯的片段特效遮罩（特效軌的特效選取時一律可以編輯） */
export const useMaskEdit = create<{ key: string | null }>(() => ({ key: null }));
export const cfxMaskKey = (fxId: string) => `cfx:${fxId}`;

type Vals = Partial<Record<'x' | 'y' | 'w' | 'h' | 'feather' | 'rotation', number>>;
interface Target { key: string; label: string; mask: Mask; set(v: Vals): void; active: boolean }

/** 依目前選取，收集要顯示的遮罩 */
function useTargets(): Target[] {
  const sel = useStore((s) => s.selection);
  const time = useStore((s) => s.time);
  const effects = useStore((s) => s.effects);
  const clips = useStore((s) => s.clips);
  const modules = useStore((s) => s.modules);
  const editKey = useMaskEdit((s) => s.key);
  const out: Target[] = [];
  const name = (id: string) => {
    const m = modules.find((x) => x.id === id);
    return m ? displayName(m.name) : '';
  };
  if (sel?.type === 'effect') {
    const fx = effects.find((f) => f.id === sel.id);
    if (fx) {
      const local = time - fx.start;
      const m = local >= 0 && local < fx.duration ? maskAt(fx.mask, fx.keys, local) : null;
      if (m) {
        out.push({
          key: `fx:${fx.id}`,
          label: name(fx.moduleId),
          mask: m,
          active: true,
          set: (vals) => {
            const host = fxHost(fx.id);
            if (!host) return;
            for (const [p, v] of Object.entries(vals)) {
              const cur = useStore.getState().effects.find((x) => x.id === fx.id);
              const k = cur?.keys?.[maskKey(p)];
              if (k?.length) host.setKeys(maskKey(p), upsertKey(k, local, v));
              else host.setBase(maskKey(p), v);
            }
          },
        });
      }
    }
  }
  if (sel?.type === 'clip') {
    const c = clips.find((x) => x.id === sel.id);
    if (c) {
      const local = time - c.start;
      for (const f of c.effects ?? []) {
        if (f.enabled === false || local < 0 || local >= c.duration) continue;
        const m = maskAt(f.mask, f.keys, local);
        if (!m) continue;
        out.push({
          key: cfxMaskKey(f.id),
          label: name(f.moduleId),
          mask: m,
          active: editKey === cfxMaskKey(f.id),
          set: (vals) => {
            const host = clipHost(c.id);
            if (!host) return;
            for (const [p, v] of Object.entries(vals)) {
              const cur = useStore.getState().clips.find((x) => x.id === c.id)?.effects?.find((x) => x.id === f.id);
              const k = cur?.keys?.[maskKey(p)];
              if (k?.length) host.setKeys(cfxCh(f.id, maskKey(p)), upsertKey(k, local, v));
              else host.setBase(cfxCh(f.id, maskKey(p)), v);
            }
          },
        });
      }
    }
  }
  return out;
}

const HANDLES: { k: string; sx: -1 | 0 | 1; sy: -1 | 0 | 1 }[] = [
  { k: 'nw', sx: -1, sy: -1 }, { k: 'n', sx: 0, sy: -1 }, { k: 'ne', sx: 1, sy: -1 }, { k: 'e', sx: 1, sy: 0 },
  { k: 'se', sx: 1, sy: 1 }, { k: 's', sx: 0, sy: 1 }, { k: 'sw', sx: -1, sy: 1 }, { k: 'w', sx: -1, sy: 0 },
];

function MaskBox({ t, W, H }: { t: Target; W: number; H: number }) {
  const m = t.mask;
  const cx = (0.5 + m.x) * W, cy = (0.5 + m.y) * H;
  const w = Math.max(2, m.w * W), h = Math.max(2, m.h * H);
  const f = m.feather * H;

  /** 拖曳：移動 / 旋轉 / 羽化 / 8 個把手（對邊固定；Shift 等比、Alt 以中心縮放） */
  const begin = (e: React.PointerEvent, mode: 'move' | 'rot' | 'feather' | { sx: number; sy: number }) => {
    if (e.button !== 0 || !t.active) return;
    e.stopPropagation();
    e.preventDefault();
    const layer = (e.currentTarget as HTMLElement).closest('.gizmo-layer')!.getBoundingClientRect();
    const P = (ev: { clientX: number; clientY: number }) => ({ x: ev.clientX - layer.left, y: ev.clientY - layer.top });
    const m0 = { ...m };
    const th = (m0.rotation * Math.PI) / 180, c = Math.cos(th), s = Math.sin(th);
    const C0 = { x: (0.5 + m0.x) * W, y: (0.5 + m0.y) * H };
    const hw0 = (m0.w * W) / 2, hh0 = (m0.h * H) / 2;
    const toLocal = (p: { x: number; y: number }) => {
      const dx = p.x - C0.x, dy = p.y - C0.y;
      return { x: c * dx + s * dy, y: -s * dx + c * dy };
    };
    const toScreen = (l: { x: number; y: number }) => ({ x: C0.x + c * l.x - s * l.y, y: C0.y + s * l.x + c * l.y });
    const p0 = P(e);
    const a0 = Math.atan2(p0.y - C0.y, p0.x - C0.x);
    document.body.classList.add('mask-dragging');
    const move = (ev: PointerEvent) => {
      const p = P(ev);
      if (mode === 'move') {
        let x = m0.x + (p.x - p0.x) / W, y = m0.y + (p.y - p0.y) / H;
        if (ev.shiftKey) {
          if (Math.abs(x) < 0.03) x = 0;
          if (Math.abs(y) < 0.03) y = 0;
        }
        return t.set({ x, y });
      }
      if (mode === 'rot') {
        let r = m0.rotation + ((Math.atan2(p.y - C0.y, p.x - C0.x) - a0) * 180) / Math.PI;
        if (ev.shiftKey) r = Math.round(r / 15) * 15;
        return t.set({ rotation: Math.round(r * 10) / 10 });
      }
      const L = toLocal(p);
      if (mode === 'feather') return t.set({ feather: Math.max(0, (L.x - hw0) / H) });
      const { sx, sy } = mode;
      let hw = hw0, hh = hh0, lx = 0, ly = 0;
      if (ev.altKey) {
        if (sx) hw = Math.abs(L.x);
        if (sy) hh = Math.abs(L.y);
        if (ev.shiftKey && sx && sy) {
          const k = Math.max(hw / hw0, hh / hh0);
          hw = hw0 * k;
          hh = hh0 * k;
        }
      } else {
        const ox = -sx * hw0, oy = -sy * hh0; // 對邊（固定不動）
        if (sx) hw = Math.abs(L.x - ox) / 2;
        if (sy) hh = Math.abs(L.y - oy) / 2;
        if (ev.shiftKey && sx && sy) {
          const k = Math.max(hw / hw0, hh / hh0);
          hw = hw0 * k;
          hh = hh0 * k;
        }
        if (sx) lx = ox + Math.sign(L.x - ox || sx) * hw;
        if (sy) ly = oy + Math.sign(L.y - oy || sy) * hh;
      }
      const C = toScreen({ x: lx, y: ly });
      t.set({ x: C.x / W - 0.5, y: C.y / H - 0.5, w: Math.max(4, 2 * hw) / W, h: Math.max(4, 2 * hh) / H });
    };
    const up = () => {
      document.body.classList.remove('mask-dragging');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div
      className={`mask-gizmo ${m.shape} ${m.invert ? 'inv' : ''} ${t.active ? 'active' : 'passive'}`}
      style={{ left: cx - w / 2, top: cy - h / 2, width: w, height: h, transform: `rotate(${m.rotation}deg)` }}
      title={t.active ? $t('拖曳移動（Shift 吸附中心）、拖把手調整大小（Shift 等比、Alt 以中心縮放）、上方圓點旋轉、右側菱形羽化') : t.label}
      onPointerDown={(e) => t.active && begin(e, 'move')}
    >
      {f > 0.5 && <div className={`mask-feather ${m.shape}`} style={{ inset: -f }} />}
      {f > 0.5 && <div className={`mask-feather in ${m.shape}`} style={{ inset: Math.min(f, Math.min(w, h) / 2 - 1) }} />}
      <span className="mask-tag">
        {t.label} · {$t('遮罩')}
        {m.invert ? $t('（反轉）') : ''}
      </span>
      {t.active && (
        <>
          {HANDLES.map((hd) => (
            <div key={hd.k} className={`mask-h ${hd.k}`} onPointerDown={(e) => begin(e, { sx: hd.sx, sy: hd.sy })} />
          ))}
          <div className="mask-rot" onPointerDown={(e) => begin(e, 'rot')} title={$t('拖曳旋轉（Shift = 15° 一格）')} />
          <div className="mask-fh" style={{ left: `calc(100% + ${f}px)` }} onPointerDown={(e) => begin(e, 'feather')} title={$t('拖曳調整羽化')} />
        </>
      )}
    </div>
  );
}

/** 預覽畫面上的遮罩框 */
export function MaskGizmos({ W, H }: { W: number; H: number }) {
  const targets = useTargets();
  if (!W || !targets.length) return null;
  return (
    <>
      {targets.map((t) => (
        <MaskBox key={t.key} t={t} W={W} H={H} />
      ))}
    </>
  );
}
