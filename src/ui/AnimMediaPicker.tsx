/**
 * 動畫的圖片位置：點了打開的挑選小視窗（跟遮罩形狀一樣），列出專案裡的圖片 / 影片，點一下就換。
 */
import React, { useState } from 'react';
import { $t } from '../i18n';
import { mediaUsable, useStore } from '../store';
import { patchAnimSlot } from '../engine/animPlace';
import { LibFilter, LibToolbar, match } from './Library';
import { useLayout } from './uiStore';

export function AnimMediaPicker({ animId, slotId, onDone }: { animId: string; slotId: string; onDone: () => void }) {
  const media = useStore((s) => s.media);
  const current = useStore((s) => s.anims.find((a) => a.id === animId)?.slots.find((x) => x.id === slotId)?.mediaId);
  const view = useLayout((s) => s.libView.animMedia ?? 'grid');
  const cat = useLayout((s) => (s.libFilterOpen.animMedia ? s.modCat.animMedia ?? 'all' : 'all'));
  const setCat = (c: string) => useLayout.getState().set({ modCat: { ...useLayout.getState().modCat, animMedia: c } });
  const [q, setQ] = useState('');
  const usable = media.filter((m) => (m.kind === 'image' || m.kind === 'video') && !m.color && mediaUsable(m));
  const cats = (['all', 'image', 'video'] as const).map((id) => ({
    id, label: id === 'all' ? $t('全部') : id === 'image' ? $t('圖片') : $t('影片'),
    count: id === 'all' ? usable.length : usable.filter((m) => m.kind === id).length,
  }));
  const list = usable.filter((m) => (cat === 'all' || m.kind === cat) && match(m.name, q));
  const pick = (id: string) => {
    patchAnimSlot(animId, slotId, { mediaId: id, sourceTime: 0 });
    onDone();
  };
  return (
    <div className="lib" onContextMenu={(e) => e.preventDefault()}>
      <LibToolbar id="animMedia" query={q} setQuery={setQ} filter={{ active: cat !== 'all', reset: () => setCat('all') }} />
      <LibFilter id="animMedia" cats={cats} cur={cat} set={setCat} />
      <div className="lib-body">
        {list.length === 0 && <p className="muted small center">{usable.length ? $t('沒有符合的素材') : $t('還沒有素材')}</p>}
        <div className={view === 'grid' ? 'lib-grid' : 'lib-list'}>
          {list.map((m) => (
            <div key={m.id} className={`lib-item ${current === m.id ? 'current' : ''}`} title={m.name} onClick={() => pick(m.id)}>
              <div className={`lib-thumb ${m.kind}`} style={m.thumb ? { backgroundImage: `url(${m.thumb})` } : undefined}>
                {view === 'grid' && m.kind === 'video' && <span className="dur">{m.duration.toFixed(1)}s</span>}
              </div>
              <div className="lib-meta"><div className="lib-name">{m.name}</div></div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
