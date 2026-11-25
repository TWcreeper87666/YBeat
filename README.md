# YBeat

程式化短影音剪輯器（瀏覽器版，預設 9:16、1080×1920，可切換其他比例）。
特效、轉場、變速都是**可即時修改的程式碼模組**，程式碼裡的 `// @param` 註解會自動變成 UI 控制項。

```bash
npm install
npm run dev      # http://localhost:5173（請用 Chrome / Edge；需要 WebGL2、WebCodecs）
npm test         # tests/*.test.ts（esbuild 打包後用 node 跑）
npm run build    # tsc --noEmit + vite build
```

待辦事項在 [`todo.md`](todo.md)。

---

## 功能總覽

### 素材與預覽
- **素材分頁**：匯入影片 / 圖片 / 音樂（也可以直接把檔案拖進視窗）、**色板**（純色素材）。
  單擊素材 = 在「素材預覽」打開；雙擊 = 打開並切到素材預覽分頁；右鍵有「預覽素材 / 加到時間軸結尾 / 替換 / 移除」。
- **文字分頁**：字幕 / 標題樣式預設，拖到影片軌或按 ＋ 加在播放頭。文字片段可改內容、字型、顏色、描邊（圓角 / 尖角 / 斜切）、底框、陰影。
- **素材預覽（Source 分頁）**：播放 / 拖曳進度條（不會暫停）、入點 / 出點把手（可拖、I / O 設定、Shift 吸附）、「插入片段」放到選中軌道的播放頭。
  滑鼠在這個分頁上時 Space / I / O 作用在它。點特效 / 轉場試看時也會顯示在這裡（共用一個常駐的 WebGL 渲染器）。
- **預覽**：可直接拖曳片段移動 / 縮放 / 旋轉；特效遮罩可在預覽上拖曳編輯。跟時間軸互動時自動從 Source 切回預覽。
- **設定（齒輪 / Ctrl+,）**：輸出比例（9:16、16:9、1:1、4:5、3:4、4:3、21:9）、預覽畫質（完整 / 75% / 50% / 33%，匯出一律完整）、
  時間軸上層軌道顯示在下方或上方（預設下方）、語言（繁中 / English / 日本語，右上角地球圖示也可切換，切換會存檔後重新整理）。

### 時間軸
- 軌道種類：影片軌、特效軌（調整圖層，只作用在「它下面」的影片軌）、音訊軌。音訊軌可以排在任何位置；新增的軌道一律放在**所有軌道的最下方**。
- 點軌道標籤 / 空白處 = **選中軌道**（底色變亮），插入片段、文字、特效會放到選中的軌道；那裡被佔用就在旁邊自動新增一條。
- **同一條軌道上的項目不能重疊**。片段拖曳、貼上、再製及拉長邊緣若碰到其他片段，會顯示覆蓋／插入等選項；拉長右邊緣時，插入只推動原結尾之後的內容。吸附時會畫一條跨軌道的黃色虛線。
- 軌道高度可拖曳標籤下緣調整（雙擊恢復），可隱藏 / 靜音、**拖曳到任何位置換順序**（影片 / 特效 / 音訊軌可以任意交錯；拖到目標軌道上半 = 插在上面、下半 = 下面；右鍵也有上移 / 下移 / 移到最上 / 最下），刪除軌道（有東西會確認；至少保留一條影片軌）。
- **影音連結**：有聲音的影片拖進來會自動建立連結的音訊，**畫在影片片段下半部（一體）**，不佔音訊軌。屬性面板的「聲音」直接調這段音訊。
  右鍵「取消影音連結」→ 音訊變成獨立片段，放到影片軌的下一條音訊軌（有空位）或在正下方新增一條。
- **群組**（Ctrl+G / Ctrl+Shift+G）、**合併相接片段**（Ctrl+J，限同一段素材的連續部分）、重新命名（右鍵或屬性標題雙擊）。
- **轉場**：拖到片段上。三種位置：剪接點（以剪接點為中心）、片段開頭（前面沒片段 → 從透明轉入）、片段結尾（拖到片段後半段 → 轉到透明）。
  轉場右鍵 / 屬性面板可批次套用到整條軌道的剪接點 / 開頭 / 結尾 / 同步現有。拖兩側改長度會吸附。
- **片段特效**：特效拖到影片 / 文字片段上 = 只作用在那個片段，可疊加、排序、開關；拖到特效軌 = 調整圖層；拖到特效軌上的特效 = 取代（有關鍵影格會確認）。
- 點片段不會移動播放頭（拖曳時，播放頭原本在片段裡才跟著片段一起移動）；**雙擊片段 / 特效 = 打開編輯視窗**；Home / End 在有選取時跳到選取片段的頭尾。
- 用按鈕 / 選單加入項目後，時間軸會捲到新項目並閃一下。拖播放頭時，長 GOP 影片會先用快取的小張影格（`scrubCache.ts`）。

### 屬性面板（效果控制）
- 左側數值（拖曳 / 點擊輸入算式 / 右鍵重設），⏱ 開關動畫，◇ 打關鍵影格；右側是片段內時間軸。
- 關鍵影格：上方尺規才拖播放頭；下面空白處拖曳 = 框選，雙擊 = 加關鍵影格；點選（Ctrl 切換、Shift 加選）、整組拖曳（吸附播放頭與其他 key）。
  最後點的是關鍵影格區時，Delete / Ctrl+C / X / V / A / Alt+←→ 作用在關鍵影格。展開曲線可調 cubic-bezier 緩動。
- **遮罩**（每個特效都有）：無 / 矩形 / 橢圓、反轉、位置 / 大小 / 羽化 / 旋轉可打 key；快速設定（置中、全畫面、上半、下半、重設）。
  特效軌的遮罩直接在預覽上拖；片段特效的遮罩要按「在預覽中編輯」。
- **音訊反應**：任一數值參數可設「跟著音量 / 跟著節拍」與最小～最大值（來源 = 整個專案正在發聲的聲音）。

### 素材庫（特效 / 轉場 / 變速）
分類、★ 我的最愛、自訂模組；單擊試看（顯示在 Source 分頁）、拖曳套用、右鍵更多套用方式與「編輯程式碼 / 複製為新模組」。

### AI 功能（都在瀏覽器裡跑）
- **AI 去背**：U²-Netp 逐格算遮罩，結果快取在 IndexedDB。
- **追蹤**（片段屬性 → 追蹤）：
  - 臉部：YuNet 偵測最大的那張臉；側臉、低頭、背對鏡頭偵測不到的地方改用 VitTrack 追著頭接起來。
  - 自訂：在預覽上框任何東西（車、球、遊戲角色…），VitTrack 一格一格往前後追；飄掉時在別的時間點再框一次（多錨點）。
  - 縮放、旋轉這類有中心的特效 / 轉場會自動跟著目標（`@follow`）；馬賽克、跟隨放大的範圍跟著目標大小（`@fit`）。
- **AI 助手**（Gemini，自己的 API 金鑰，只存在這個瀏覽器、直接從瀏覽器呼叫）：回答使用問題、寫 / 改特效模組（本機編譯，失敗自動修正）、
  操作專案（加特效、換轉場、打關鍵影格、設追蹤、校對 / 翻譯字幕…，先列出修改，按「套用」才執行、一步復原）、可以附加預覽畫面給它看。

### 專案檔
- 專案自動存在瀏覽器（IndexedDB）。
- 「匯出專案包」= `.ybeat`：專案 + 用到的素材原始檔打包成一個檔案（`src/engine/ybeatPack.ts`），可以搬到別台電腦「匯入專案包」。

## 快捷鍵（完整列表在 說明 → 快捷鍵一覽 / F1）

| 快捷鍵 | 功能 |
|---|---|
| Space | 播放 / 暫停（滑鼠在 Source 分頁上時作用在 Source） |
| ← → / Shift | 逐格 / 1 秒 |
| ↑ ↓ | 上 / 下一個剪接點 |
| Home / End | 開頭 / 結尾（有選取時：選取片段的頭尾） |
| S、Ctrl+B | 在播放頭分割 |
| Q / W | 修剪開頭 / 結尾到播放頭 |
| Ctrl+C / X / V / D | 複製 / 剪下 / 貼上到播放頭 / 再製 |
| Delete、Shift+Delete、Alt+Delete | 刪除、波紋刪除、波紋刪除（所有軌道一起推，被擋住的軌道只推到不重疊）；沒有選取時 = 移除選中軌道上播放頭所在的空白 |
| Alt+← → | 選取項目移動一格（Shift = 10 格） |
| Ctrl+J | 合併相接片段 |
| Ctrl+G / Ctrl+Shift+G | 群組 / 解除群組 |
| Ctrl+Z、Ctrl+Shift+Z / Ctrl+Y | 復原、重做 |
| N | 磁吸開關 |
| = / - / \\ | 時間軸放大 / 縮小 / 符合視窗 |
| Ctrl+O / Ctrl+E / Ctrl+S / Ctrl+, | 匯入 / 匯出 / 存檔 / 設定 |

---

## 模組規格

### 參數註解（三種模組通用）
```
// @param 名稱: 型別 = 預設值 (最小..最大) "顯示名稱"
// 型別：float | int | bool | color | point（畫面座標 x,y）| curve（cubic-bezier，用 curve(名稱, x) 取值）
// @duration 0.4      ← 特效拖進時間軸時的預設長度

// 附加標記（寫在 @param 那一行最後）：
//   @follow             point：片段有追蹤時預設跟著目標
//   @fit(點, 倍率參數)   point 當寬、高：點跟著目標時 = 目標大小 × 倍率
//   @box(點)            float：在預覽上以那個點為中心畫出縮放後的畫面框
//   @none(值)           curve：「無」選項的固定值
```

### 特效（GLSL）
```glsl
vec4 effect(vec2 uv) { return tex(uv); }
```
可用：`tex(uv)`、`u_progress`（0→1）、`u_local`（秒）、`u_duration`、`u_time`、`u_resolution`、
**`u_level`（目前音量 0~1）、`u_beat`（節拍脈衝，打到拍 = 1 然後衰減）**、
`ASPECT`、`PI`、`rand()`、`noise1()`、`rotateUV()`、`zoomUV()`、`mirrorUV()`、`easeOutExpo()` 等。
片段特效的輸入是透明圖層（只有那個片段），輸出會再疊回畫面。

### 轉場（GLSL）
```glsl
vec4 transition(vec2 uv) { return mix(getFrom(uv), getTo(uv), progress); }
```
開頭 / 結尾轉場時，`getFrom` 或 `getTo` 是透明的（premultiplied alpha）。

### 時間重映射（JavaScript）
```js
function remap(t, p, info) { return t * p.speed; }  // 回傳素材時間（秒）
```
`info = { dur, srcDur, in }`，可用 `ease.inOutCubic / outExpo / outBack / clamp ...`。

---

## 架構（給接手的人 / 新 session）

技術：React 18 + zustand + Vite + TypeScript，WebGL2 渲染，WebCodecs + mp4-muxer 匯出，lucide-react 圖示。

### 檔案
| 檔案 | 內容 |
|---|---|
| `src/store.ts` | 主要狀態（zustand）：片段 / 特效 / 音訊 / 軌道 / 模組 / 選取 / 所有編輯動作。也有 `spansOf`、`displayRows`、`visualRows`、`fxLevel`、`attachedAudioIds`、影音連結同步（檔尾的 subscribe） |
| `src/engine/renderer.ts` | WebGL2 管線：影片軌由下往上疊 → 特效軌依 level 插在影片軌之間（調整圖層）→ 片段特效（`drawClip` 先畫在透明圖層）→ 轉場（cut / head / tail）→ 遮罩（`MASK_FS`）→ 輸出。`setSize` 處理比例 / 預覽畫質 |
| `src/engine/tracks.ts` | 軌道模型與顯示順序：`fxLevel`、`visualRows`、`displayRows`、`tracksFromOrder`（任意顯示順序 → 影片 index / 特效 level / 音訊 row），有測試（720 種排列全驗） |
| `src/engine/snap.ts` | 變換框縮放的 Shift 吸附（框邊吸到畫面四邊 / 中線 / 網格線），有測試 |
| `src/engine/overlap.ts` | 同軌不重疊的計算（`fitStart`、`resolveShift`…），有單元測試 |
| `src/engine/text.ts` | 文字樣式、預設、canvas 繪製（快取） |
| `src/engine/mask.ts` | 遮罩型別與 `maskAt`（關鍵影格 key：`mask.x` 等） |
| `src/engine/audioReact.ts` | 音量 / 節拍訊號（從 media.peaks 查表，匯出結果與預覽相同） |
| `src/engine/stretch.ts` | 保持音調的變速（WSOLA，純函式，有測試）；`audio.ts` 只處理片段用到的那段並快取，之後以 1× 播放 |
| `src/engine/scrubCache.ts` | 拖播放頭用的低解析度影格快取（ImageBitmap 以 flipY 儲存，給 WebGL 用） |
| `src/engine/audio.ts` | 音訊預覽與匯出混音共用 `audioPlan`；預覽用 Web Audio（AudioBufferSourceNode 在 AudioContext 時鐘上排程，時間軸跳動 / 內容改變才重排），預覽的 `<video>` 一律靜音；`audioMuted`（連結音訊跟著影片軌靜音） |
| `src/engine/exporter.ts` | 逐幀渲染 + WebCodecs H.264 + AAC |
| `src/engine/project.ts` | IndexedDB 自動存檔 / 還原（含 `format`） |
| `src/engine/history.ts` | 復原 / 重做（監看 clips / effects / audios / tracks，400ms 內合併） |
| `src/ui/Timeline.tsx` | 時間軸（memo 化的 ClipView / FxView / AudioView / TransitionView、拖曳、吸附、軌道） |
| `src/ui/LeftPanel.tsx` | 素材 / 文字 / 模組庫、屬性面板（ClipInspector、EffectInspector、`effectSections` 共用、TransitionInspector…） |
| `src/ui/EffectControls.tsx` | 屬性面板的關鍵影格表格、曲線、關鍵影格選取 / 快捷鍵；片段特效的 channel id 是 `cfx:<特效id>:<參數>` |
| `src/ui/SourcePanel.tsx` | 素材預覽 + 特效 / 轉場試看 |
| `src/ui/EditorWindow.tsx` | 編輯視窗（針對單一片段 / 特效的置中對話框，Enter / 屬性標題按鈕 / 右鍵開啟）：把 inspector 與 preview 的 host 搬進來、Dock 顯示佔位；開著時 `loop` = 項目範圍（關閉還原），播放列用 `useEditorScope` 只顯示項目；自動排版看輸出比例：橫式 → 預覽上 / 屬性下（屬性左欄固定 420px，關鍵影格時間軸變寬），直式 → 屬性左 / 預覽右；預覽的滾輪是檢視縮放（`usePreviewView`，改 canvas 顯示大小，不是縮放物件），拖空白 / 中鍵平移；`editorLayout` / `editorSplit` 記在 useLayout |
| `src/ui/Preview.tsx` / `MaskEditor.tsx` | 預覽、變換框、遮罩編輯框 |
| `src/ui/Dock.tsx` / `dockTree.ts` | 可拖曳停駐的版面（有測試） |
| `src/engine/matte.ts`、`matteWorker.ts` | AI 去背（U²-Netp，Web Worker + onnxruntime-web） |
| `src/engine/face.ts`、`faceTrack.ts`、`faceWorker.ts` | 臉部偵測（YuNet）、挑臉 / 平滑 / 內插、追丟的空洞用 VitTrack 補；臉的特徵（SFace） |
| `src/engine/faceLead.ts` | 自動剪輯認主角：臉對齊、特徵分群、只有別人的範圍 |
| `src/engine/boxTrack.ts`、`vitTrack.ts`、`trackWorker.ts` | 自訂目標追蹤（VitTrack）、錨點、結果快取 |
| `src/engine/follow.ts` | 片段追蹤的目標（`Clip.subject`）、point 參數跟隨、素材 ↔ 畫面座標換算 |
| `src/engine/jobNeed.ts` | 背景運算（去背 / 偵測 / 追蹤）沒有片段需要了就停下 |
| `src/engine/ybeatPack.ts` | `.ybeat` 專案包容器 |
| `src/ai/` | AI 助手：`gemini.ts`（API）、`assistant.ts`（流程）、`prompt.ts`、`projectTools.ts`（操作專案）、`frames.ts`（畫面截圖） |
| `src/ui/helpText.ts` | 說明 → 使用教學（`TUTORIAL`） |
| `src/ui/uiStore.ts` | UI 狀態（版面設定、選單、確認 / 輸入對話框、拖曳、吸附線、reveal…） |
| `src/modules/builtin.ts`、`extra.ts`、`categories.ts` | 內建模組原始碼與分類 |
| `src/i18n.ts`、`i18n.en.ts`、`i18n.ja.ts` | 多語系 |

### 資料模型重點
- 每種軌道各自用 index（`clip.track` 等），項目只能放在同種類的軌道上。重新排列軌道一律走 `reorderTracks(顯示順序)`，它會重算 index / level / row 並把項目的 `track` 重新對應。
  每種軌道各自用 index（`clip.track` 等）。影片 / 特效的**顯示順序 = 圖層順序**（`visualRows`）；
  特效軌的 `level` = 它下面有幾條影片軌；音訊軌的 `row` = 它上面有幾條影片 / 特效軌（`displayRows` 組出完整順序）。
- `Clip` 可以有 `text`（文字片段，`mediaId` 為空）、`effects`（片段特效）、`transitionIn` / `transitionOut`、`link`（影音連結）、`group`、`name`。
- 連結在影片上的音訊（`attachedAudioIds`）不出現在音訊軌、不參與碰撞；`store.ts` 檔尾的 subscribe 會讓影片與音訊的 start / duration / in / 速度保持同步。
- 存放位置：模組程式碼 → localStorage（`ybeat-modules`）；版面 / 設定 → localStorage（`ybeat-layout`、`ybeat-dock`、`ybeat-lang`）；
  素材檔案與時間軸 → IndexedDB（`ybeat`）。

### 開發慣例
- 程式碼註解用中文。UI 不用 emoji，圖示一律用 `lucide-react`。
- **教學文字不放在介面上**（例如「也可以拖到…」「右鍵有更多…」這種說明）：統一寫進「說明 → 使用教學」（`src/ui/helpText.ts` 的 `TUTORIAL`）。介面上只留空狀態與狀態訊息。
- **多語系**：介面字串寫中文並包 `$t('中文', ...args)`（`{0}` `{1}` 佔位），新增字串時要同步加到 `i18n.en.ts` 與 `i18n.ja.ts`
  （日文缺字會退回英文、再退回中文）。模組名稱用 `displayName()`，`// @param` 的顯示名稱用 `$t(d.label)`。
  語言在載入時決定，模組層級的常數也可以用 `$t`。
- 新的 store 動作要考慮：同軌不重疊（`fitStart` / `resolveShift`）、連結 / 群組（`expand` 選取擴展、`freshIds`）、分割 / 合併 / 變速時關鍵影格與片段特效要一起處理。
- 每次改完：`npx tsc --noEmit && npm test && npx vite build`。

---

## 第三方模型

`public/models/` 裡的模型都在瀏覽器用 [onnxruntime-web](https://github.com/microsoft/onnxruntime) 執行，各自依原本的授權散布：

| 檔案 | 用途 | 來源 | 授權 |
|---|---|---|---|
| `u2netp.onnx` | AI 去背 | [U-2-Net](https://github.com/xuebinqin/U-2-Net)（U²-Netp） | Apache 2.0 |
| `face_detection_yunet_2023mar.onnx` | 臉部偵測 | [OpenCV Zoo – YuNet](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet) | MIT |
| `object_tracking_vittrack_2023sep.onnx` | 目標追蹤 | [OpenCV Zoo – VitTrack](https://github.com/opencv/opencv_zoo/tree/main/models/object_tracking_vittrack) | Apache 2.0 |
| `face_recognition_sface_2021dec_int8.onnx` | 自動剪輯認主角 | [OpenCV Zoo – SFace](https://github.com/opencv/opencv_zoo/tree/main/models/face_recognition_sface)（int8） | Apache 2.0 |
