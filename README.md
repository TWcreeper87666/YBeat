# BeatSync Editor

程式化短影音剪輯器（9:16、1080×1920）。特效、轉場、變速都是**可即時修改的程式碼模組**，
程式碼裡的 `// @param` 註解會自動變成 UI 控制項。

```bash
npm install
npm run dev     # http://localhost:5173 （請用 Chrome / Edge）
```

## 操作
- 素材分頁：匯入影片 / 圖片 / 音樂 → 拖到時間軸，或雙擊加到結尾（素材與專案自動存在瀏覽器 IndexedDB）
- 多軌：影片軌（上層蓋下層，可做子母畫面）、特效軌、音訊軌；軌道標籤可隱藏 👁 / 靜音 🔊，底部「+」新增軌道；片段可上下拖到別的軌
- 轉場：拖到**後一個片段**上（同軌、兩片段需相接，拖曳會自動吸附）
- 畫面：選取片段後在左側調 縮放 / 位置 / 旋轉 / 不透明度 / 填滿模式（裁切、完整、模糊背景）/ 翻轉；
  勾「動態」做起點 → 終點的動畫。也可直接在預覽上拖曳移動、拖角落縮放、拖上方圓點旋轉（Shift 15°）、滾輪縮放
- 點時間軸上的任何東西 → 左側「</> 編輯器」顯示參數 UI + 程式碼；右鍵開啟編輯選單

| 快捷鍵 | 功能 |
|---|---|
| Space | 播放 / 暫停 |
| S、Ctrl+B | 在播放頭分割（選取的片段，沒選就分割播放頭下所有片段） |
| Ctrl+C / X / V | 複製 / 剪下 / 貼上到播放頭 |
| Ctrl+D | 再製（貼在原片段後面） |
| Delete、Shift+Delete | 刪除、波紋刪除（後面片段往前補） |
| Ctrl+Z、Ctrl+Shift+Z / Ctrl+Y | 復原、重做 |
| ← →（+Shift） | 逐格（一秒） |
| Ctrl+滾輪 | 縮放時間軸 |

## 模組規格

### 參數註解（三種模組通用）
```
// @param 名稱: 型別 = 預設值 (最小..最大) "顯示名稱"
// 型別：float | int | bool | color
// @duration 0.4      ← 特效拖進時間軸時的預設長度
```

### 特效（GLSL）
```glsl
vec4 effect(vec2 uv) { return tex(uv); }
```
可用：`tex(uv)`、`u_progress`（0→1）、`u_local`（秒）、`u_duration`、`u_time`、`u_resolution`、
`ASPECT`、`PI`、`rand()`、`noise1()`、`rotateUV()`、`zoomUV()`、`mirrorUV()`、`easeOutExpo()` 等。

### 轉場（GLSL）
```glsl
vec4 transition(vec2 uv) { return mix(getFrom(uv), getTo(uv), progress); }
```

### 時間重映射（JavaScript）
```js
function remap(t, p, info) { return t * p.speed; }  // 回傳素材時間（秒）
```
`info = { dur, srcDur, in }`，可用 `ease.inOutCubic / outExpo / outBack / clamp ...`。

## 架構
- `src/engine/renderer.ts`：WebGL2 管線（素材 cover → 轉場 → 特效 ping-pong → 輸出）
- `src/engine/remap.ts`：決定性時間映射 `getSourceTime`
- `src/engine/exporter.ts`：逐幀渲染 + WebCodecs H.264 + mp4-muxer
- `src/modules/builtin.ts`：內建模組原始碼
- `src/engine/history.ts`：復原 / 重做；`project.ts`：IndexedDB 自動存檔；`audio.ts`：音訊預覽與匯出混音
- 模組程式碼存在 localStorage；素材與時間軸存在 IndexedDB
