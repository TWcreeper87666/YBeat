# AI 助手：之後可以加的功能

狀態：**提案中，等使用者挑要做哪些**

## 目前能做的

- 回答使用問題（參考 `TUTORIAL` + 快捷鍵）。
- 寫 / 改特效、轉場、變速模組；本機編譯，失敗自動修正（最多 2 次）。
- 自己讀模組程式碼：系統提示有全部內建模組的目錄，`get_modules` 讀程式碼、`list_user_modules` 列出自訂 / 改過的模組（`src/ai/tools.ts`）。工具回合不帶進之後的對話紀錄。

## 建議（依價值排序）

### 1. 讓 AI 直接操作專案（推薦）

可以說「每個重拍加震動」「所有接點換成甩鏡」「副歌那段加速」。

讀取工具：

| 工具 | 回傳 |
| --- | --- |
| `get_timeline()` | 軌道、片段（id、開始、長度、素材名稱、已套用的轉場 / 變速 / 片段特效）、特效軌方塊 |
| `get_beats(from?, to?)` | 節拍時間點、BPM、重拍 |
| `get_selection()` | 目前選取的片段 / 特效 / 轉場、播放頭位置 |

寫入工具（對應現有 store action）：

| 工具 | store |
| --- | --- |
| `add_effect(moduleId, start, duration, track?, params?)` | `addEffect` + `updateEffect` |
| `set_transition(clipIds, moduleId, side, duration?, params?)` | `setTransition` / `applyTransitions` |
| `set_remap(clipIds, moduleId, params?)` | `setRemap` |
| `add_clip_fx(clipIds, moduleId, params?)` | `addClipFx` |
| `update_params(targetId, params)` | `updateEffect` / `updateClipFx` / `updateTransition` |

要決定的事：

- **一次回覆的所有寫入合成一步復原**（`src/engine/history.ts` 要能包一個批次）。
- **先預覽再套用**：AI 回傳的是操作清單，聊天裡顯示摘要（「加 12 個震動」），按「套用」才執行；還是直接執行、靠復原。建議先預覽。
- 數量上限（例如一次最多 200 個操作），避免模型失控塞滿時間軸。
- 片段數量多時 `get_timeline` 要能分段或只回傳摘要，省額度。

### 2. 讓 AI 看到畫面

Gemini 可以看圖。

- 寫模組時：把模組在 progress 0 / 0.5 / 1 的畫面（套在目前預覽的素材或測試圖上）縮小成 JPEG 傳回去，讓它檢查效果對不對，不只是能不能編譯。
- 問問題時：附加目前預覽畫面（類似現在附加模組的迴紋針），可以問「這段怎麼調比較好看」。
- 注意：圖片很耗額度，預設不附加、小尺寸（例如 384px）。

### 3. 只調參數，不改程式碼

「節奏再快一點」「中心移到左上」「顏色換成藍色」→ 直接改選取特效的 `@param` 值或關鍵影格，不用重寫模組。比較快、省額度、不會弄壞程式碼。可以當作第 1 項的 `update_params` 先做。

### 4. 檢查畫面輸出

編譯通過但畫面壞掉的情況（整片黑、全透明、NaN、跟原圖完全一樣）也當成錯誤：用隱藏的 WebGL2 實際算幾格、讀回像素檢查，有問題就跟編譯錯誤一樣丟回去讓 AI 修。不需要看圖能力，成本低。

### 5. 字幕

- 校對錯字、翻譯成另一種語言（新增一條字幕軌）。
- 太長的字幕拆行 / 拆成兩段。
- 依節拍調整出現時間。

## 建議順序

4（小、獨立）→ 3 → 1 → 2 → 5
