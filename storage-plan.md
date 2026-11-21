# 儲存結構調整提案：我的最愛

狀態：**已實作（2026-11-21，使用者同意）**。`src/ui/favorites.ts`，localStorage key `ybeat-favorites`。舊資料轉換的程式碼已移除（開發階段，使用者的瀏覽器已經套用新版）。

## 現況

| 分頁 | 我的最愛存在哪 | localStorage key | 內容 |
|---|---|---|---|
| 轉場 / 特效 / 變速 | `useLayout().favorites`（`src/ui/uiStore.ts`） | `ybeat-layout` | **三個分頁共用一個陣列**，模組 id 混在一起 |
| 遮罩 | `useMaskLib().favorites`（`src/engine/maskShapes.ts`） | `ybeat-masks` | 形狀 id |
| 色板 | `useColorLib().favorites`（`src/ui/ColorPanel.tsx`） | `ybeat-colors` | 色碼 |

## 問題

1. **轉場 / 特效 / 變速共用一個陣列**：在「特效」的我的最愛拖曳排序時，只能調整其中特效的相對順序，轉場和變速的項目要原地保留（目前用 `reorderSubset` 處理，`src/ui/sortKeys.ts`）。功能上沒問題，但每個用到的地方都要記得「先挑出這個分頁的、改完再塞回去」，容易出錯。
2. **使用者資料跟介面版面放在一起**：`ybeat-layout` 主要是面板寬度、檢視模式這類可以隨時重設的介面狀態，`useLayout` 也有一個 `reset()` 會把整包設回預設值（目前沒有地方呼叫）。如果之後加了「重設介面」，我的最愛會被一起清掉。
3. **每個分頁各存一處**：新增分頁（例如文字樣式）要再決定存哪，讀寫方式不一致。

## 提案

新增一個獨立的 store `useFavorites`（localStorage key：`ybeat-favorites`），每個分頁各一個有順序的陣列：

```ts
type LibId = 'transition' | 'effect' | 'remap' | 'mask' | 'color' | 'text';
interface Favorites {
  lists: Partial<Record<LibId, string[]>>;
  has(lib: LibId, id: string): boolean;
  toggle(lib: LibId, id: string): void;
  set(lib: LibId, list: string[]): void;  // 拖曳排序後整個換掉
}
```

- 各分頁只讀寫自己的陣列，拖曳排序直接 `set(lib, next)`，不需要 `reorderSubset`。
- `useLayout` / `useMaskLib` / `useColorLib` 拿掉 favorites 欄位。
- 介面版面跟使用者資料分開，之後重設介面不會影響我的最愛。

## 舊資料怎麼處理

（已完成並移除轉換程式碼）當時的轉換方式：

- `ybeat-layout.favorites` → 依模組的 kind 分到 `transition` / `effect` / `remap`
- `ybeat-masks.favorites` → `mask`
- `ybeat-colors.favorites` → `color`

## 影響範圍

`src/ui/uiStore.ts`、`src/engine/maskShapes.ts`、`src/ui/ColorPanel.tsx`、`src/ui/LeftPanel.tsx`（模組庫）、`src/ui/MaskPanel.tsx`、`src/ui/Library.tsx`（`favSortOpts` 可以簡化）。
