/**
 * 「跟隨臉部」的介面：point 參數的右鍵選單項目、標示圖示。
 */
import { $t } from '../i18n';
import { ScanFace } from 'lucide-react';
import { followOf, type Follow, type FollowMap } from '../engine/follow';
import type { ParamDef } from '../engine/params';
import type { MenuItem } from './uiStore';

/** point 參數的右鍵選單：跟隨臉部開關、重設偏移 */
export function followMenu(d: ParamDef, map: FollowMap | undefined, set: (m: FollowMap) => void): MenuItem[] {
  if (d.type !== 'point') return [];
  const cur = followOf(d, map);
  const put = (f: Follow | null) => set({ ...(map ?? {}), [d.name]: f });
  const items: MenuItem[] = [{ label: $t('跟隨臉部'), checked: !!cur, action: () => put(cur ? null : { ...(map?.[d.name] ?? {}), target: 'face' }) }];
  if (cur?.offset) items.push({ label: $t('重設偏移'), action: () => put({ ...cur, offset: undefined }) });
  items.push({ separator: true });
  return items;
}

/** 標在參數名稱旁邊：這個參數正在跟著臉 */
export const FollowIcon = () => (
  <span className="follow-ico" title={$t('跟隨臉部')}>
    <ScanFace size={11} />
  </span>
);
