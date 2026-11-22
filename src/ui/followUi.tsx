/**
 * 「跟隨目標」的介面：point 參數的右鍵選單項目、標示圖示。
 */
import { $t } from '../i18n';
import { Crosshair } from 'lucide-react';
import { followOf, type Follow, type FollowMap } from '../engine/follow';
import type { ParamDef } from '../engine/params';
import type { MenuItem } from './uiStore';

/** point 參數的右鍵選單：跟隨目標開關、重設偏移 */
export function followMenu(d: ParamDef, map: FollowMap | undefined, set: (m: FollowMap) => void): MenuItem[] {
  if (d.type !== 'point' || d.fit) return [];
  const cur = followOf(d, map);
  const put = (f: Follow | null) => set({ ...(map ?? {}), [d.name]: f });
  const items: MenuItem[] = [{ label: $t('跟隨目標'), checked: !!cur, action: () => put(cur ? null : { ...(map?.[d.name] ?? {}) }) }];
  if (cur?.offset) items.push({ label: $t('重設偏移'), action: () => put({ ...cur, offset: undefined }) });
  items.push({ separator: true });
  return items;
}

/** 跟隨中的點調過位置（偏移）：回到目標正中 */
export function followReset(d: ParamDef, map: FollowMap | undefined): FollowMap | null {
  const cur = followOf(d, map);
  return cur?.offset ? { ...(map ?? {}), [d.name]: { ...cur, offset: undefined } } : null;
}

/** 標在參數名稱旁邊：這個參數正在跟著目標 */
export const FollowIcon = () => (
  <span className="follow-ico" title={$t('跟隨目標')}>
    <Crosshair size={11} />
  </span>
);
