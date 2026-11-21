# 儲存結構調整提案：片段特效的時間範圍

狀態：**提案中，等使用者同意**

## 問題

片段特效（`ClipFx`）沒有自己的時間，`u_progress = 片段內時間 / 片段長度`。衝擊類特效套在長片段上會被拉長，而且整段每一格都在跑 shader。

## 結構

```ts
/** 特效的一次播放（片段內時間，秒） */
interface Hit { t: number; d: number }

type FxTiming =
  | { kind: 'hits'; hits: Hit[] }                   // 手動：已排序、不重疊
  | { kind: 'beat'; every: BeatEvery; d: number }   // 自動：片段範圍內每 N 拍播一次
  | { kind: 'cut'; d: number };                     // （之後）每個剪接點

interface ClipFx {
  // ...
  /** 沒有 = 整段 */
  timing?: FxTiming;
}
```

- 每個 Hit 是一次獨立播放：`u_local = local - t`、`u_progress = (local - t) / d`。
- 不在任何 Hit 裡 → **整個特效跳過，不跑 shader**。
- `beat` 不存展開後的時間點：節拍改了、片段移動了會自動跟上。需要個別微調時可以「轉成手動」，展開成 `hits`。
- `BeatEvery` 沿用 `src/engine/trigger.ts`，跟特效軌方塊的觸發同一套。

### 為什麼不用 `@on` 關鍵影格

| | `@on` 關鍵影格 | `hits` |
|---|---|---|
| 一次播放 | 一開一關兩個關鍵影格配對出來 | 一個物件 `{t, d}` |
| 不合法狀態 | 連續兩個開、先關後開…都要處理 | 不可能出現 |
| 改長度 | 要移動「關」那個關鍵影格 | 改 `d` |
| 找目前這一段 | 二分搜尋後還要往後找「關」 | 二分搜尋 |
| 複製參數 / 套用到相同特效 | 會跟參數關鍵影格混在一起 | 分開 |
| 節拍自動觸發 | 要展開存成一堆關鍵影格 | 存一個規則 |

## 渲染（`src/engine/renderer.ts`）

共用一個函式，特效軌方塊和片段特效都用：

```ts
/** 這一格特效從哪開始、多長；null = 不作用 */
function fxWindow(timing: FxTiming | undefined, local: number, len: number): { t0: number; d: number } | null
```

- `hits`：對 `t` 二分搜尋，O(log n)。
- `beat`：節拍陣列本來就排序過，用 `trigger.ts` 現有的 `lowerBound`，O(log n)。
- 回傳 null → `runEffect` 整個跳過（省一次全畫面的 pass，衝擊類特效大部分時間都是這個情況）。

## 預設

- 模組 `@duration` ≤ 1 秒：`{ kind: 'hits', hits: [{ t: 0, d: @duration }] }`（放上去就是打一下）。
- 比較長的（調色、雙色調、手持晃動、電影黑邊…）：不設 `timing`，整段。

## 編輯

- 切割片段：`hits` 依切點分到兩段（跨切點的那個截斷）；`beat` 兩段都保留同一個規則。
- 屬性面板：特效區塊多一列「作用」，時間軸那一欄把每個 Hit 畫成小方塊：拖曳移動、拖兩端改長度、Delete 刪除；右鍵「在播放頭觸發」「每拍觸發 ▸」「整段」「轉成手動」。
- 參數關鍵影格仍然用片段內時間，不受影響。

## 影響範圍

- `src/store.ts`：型別、預設 timing、切割
- `src/engine/trigger.ts`：`fxWindow`；特效軌方塊改用同一個函式
- `src/engine/renderer.ts`：片段特效依 `fxWindow` 決定 local / duration / 跳過
- `src/ui/EffectControls.tsx`、`src/ui/LeftPanel.tsx`：「作用」列（Hit 方塊的拖曳編輯、右鍵選單）
- `src/i18n.en.ts`、`src/i18n.ja.ts`
- `tests/`：`fxWindow`（hits、beat、邊界）、切割分配
