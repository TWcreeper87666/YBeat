# 提案：特效 / 轉場共用的「點、框、曲線」參數

狀態：**已實作（2026-11-21，使用者同意）**。共用型別在 `src/engine/params.ts`，面板 `src/ui/CurveEdit.tsx`、預覽把手 `src/ui/ParamGizmos.tsx`。

## 現況

- 特效、轉場都是 GLSL 腳本，用 `// @param 名稱: 型別 = 預設` 宣告參數，自動產生介面（`src/engine/params.ts`、`ParamControls`）。
- 型別只有 `float | int | bool | color`。像「縮放推出」的中心是兩個獨立 float `cx`、`cy`，結束大小是 `to`，只能在面板拖數字。
- 轉場的緩動寫死在 shader 裡（`easeInOutCubic(progress)`），使用者改不了。
- 特效（`FxItem` / `ClipFx`）的數值參數可以打關鍵影格；轉場（`TransitionRef`）沒有。

## 提案：在 `@param` 加三個共用型別（腳本可以直接用）

| 型別 | 宣告範例 | GLSL uniform | 面板 | 預覽畫面 |
|---|---|---|---|---|
| `point` | `// @param center: point = 0.5,0.5 "中心"` | `vec2 center` | X / Y 兩個拖曳數字 | 十字把手，可直接拖 |
| `curve` | `// @param ease: curve = inOut "曲線"` | `vec4 ease`（bezier） | 小型曲線編輯器＋預設選單（線性、緩入緩出、急停、過衝回彈…沿用 `EASE_PRESETS`） | — |
| float 加 `@box(點)` | `// @param to: float = 0.2 (0..1) "結束大小" @box(center)` | `float to` | 照舊 | 以該點為中心畫出虛線框（畫面比例），拖角落改大小 |

- GLSL 共用函式：`float curve(vec4 b, float x)`，例：`float p = curve(ease, progress);`
- 預設值也可以直接寫數字：`curve = 0.42,0,0.58,1`。
- 預覽畫面的把手沿用遮罩框的樣式（`.mask-gizmo`、`.mask-h`）跟吸附規則。選取特效、片段特效或轉場時顯示；轉場的把手在播放頭落在轉場範圍時出現。
- 特效的 `point` 可以打關鍵影格，拆成兩個 channel：`center.x`、`center.y`（存在現有的 `keys` 裡，不用新欄位）。`curve` 不打關鍵影格。
- AI 助手的提示詞（`src/ai/prompt.ts`）、驗證、新模組範本、使用教學同步說明新型別。

## 內建模組改寫

- 有中心的（縮放推入 / 推出、縮放模糊、衝擊變焦、速度線、萬花筒、漩渦…）：`cx, cy` → `center: point`。
- 有大小的（縮放推入的起始大小、縮放推出的結束大小）：加 `@box(center)`。
- 所有轉場和有衰減的特效：寫死的 `easeXxx(progress)` → `ease: curve`，預設值等同目前的曲線，所以外觀不變。
- 內建模組 `rev` +1，舊存檔的程式碼會被新版取代。

## 存檔格式變更

```ts
// src/engine/params.ts
export type ParamValue = number | boolean | string | number[];  // 新增 number[]
// point → [x, y]；curve → [x1, y1, x2, y2]
```

- `TransitionRef`、`FxItem`、`ClipFx` 的結構不變，只有 `params` 裡多了陣列值。
- 舊存檔裡的 `cx`、`cy` 數值會變成沒人用的欄位，`resolveParams` 遇到型別不合會用預設值 → **不寫轉換程式碼**（開發階段）。已經調過中心的舊轉場會回到置中。

## 不在這次範圍

- 轉場參數的關鍵影格（轉場本身很短，用曲線控制就夠）。
- 旋轉把手、多點路徑之類更複雜的預覽控制。
