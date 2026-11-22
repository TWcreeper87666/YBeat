import { $t } from '../i18n';
import type { ParamDef, ParamValue, ParamValues } from '../engine/params';
import { DragNumber } from './DragNumber';
import { Switch } from './Toggle';

/** 由程式碼中的 // @param 註解自動產生的調整 UI */
export function ParamControls({ defs, values, onChange }: { defs: ParamDef[]; values: ParamValues; onChange: (v: ParamValues) => void }) {
  if (defs.length === 0) return <div className="muted small">{$t('這個模組沒有宣告 @param 參數。')}</div>;
  const set = (name: string, v: ParamValue) => onChange({ ...values, [name]: v });
  return (
    <div className="params">
      {defs.map((d) => {
        const v = values[d.name] ?? d.def;
        const modified = values[d.name] !== undefined && values[d.name] !== d.def;
        return (
          <div className="param" key={d.name}>
            <label title={$t('{0}（右鍵數值可重設）', d.name)} className={modified ? 'modified' : ''}>
              {$t(d.label)}
            </label>
            {(d.type === 'float' || d.type === 'int') && (
              <DragNumber
                value={Number(v)}
                min={d.min}
                max={d.max}
                step={d.type === 'int' ? 1 : undefined}
                decimals={d.type === 'int' ? 0 : undefined}
                def={Number(d.def)}
                onChange={(x) => set(d.name, d.type === 'int' ? Math.round(x) : x)}
              />
            )}
            {d.type === 'bool' && (
              <Switch v={Boolean(v)} on={(x) => set(d.name, x)} />
            )}
            {d.type === 'color' && <input type="color" value={String(v)} onChange={(e) => set(d.name, e.target.value)} />}
          </div>
        );
      })}
    </div>
  );
}

/** 單一數值（Blender 風格拖曳欄位） */
export function Slider({ label, value, min, max, step, onChange, reset, suffix }: { label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void; reset?: number; suffix?: string }) {
  return (
    <div className="param">
      <label>{label}</label>
      <DragNumber value={value} min={min} max={max} step={step} def={reset} onChange={onChange} suffix={suffix} />
    </div>
  );
}
