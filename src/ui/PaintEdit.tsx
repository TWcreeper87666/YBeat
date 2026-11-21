import { $t } from '../i18n';
import type { Paint } from '../engine/text';
import { DragNumber } from './DragNumber';

/** 填色編輯：純色 / 線性漸層 / 放射漸層（文字本身與每一層外框共用） */
export function PaintEdit({ value, onChange }: { value: Paint; onChange: (p: Paint) => void }) {
  const set = (p: Partial<Paint>) => onChange({ ...value, ...p });
  const grad = value.type !== 'solid';
  return (
    <div className="paint-edit">
      <select className="select" value={value.type} onChange={(e) => set({ type: e.target.value as Paint['type'] })}>
        <option value="solid">{$t('純色')}</option>
        <option value="linear">{$t('線性漸層')}</option>
        <option value="radial">{$t('放射漸層')}</option>
      </select>
      <input type="color" className="color" value={value.color} onChange={(e) => set({ color: e.target.value })} />
      {grad && <input type="color" className="color" value={value.color2} onChange={(e) => set({ color2: e.target.value })} />}
      {value.type === 'linear' && <DragNumber variant="text" value={value.angle} min={-360} max={360} step={1} decimals={0} suffix="°" def={90} onChange={(v) => set({ angle: Math.round(v) })} />}
    </div>
  );
}
