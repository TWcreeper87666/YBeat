# 本機小模型：還可以加哪些

條件：在瀏覽器跑（onnxruntime-web / transformers.js / MediaPipe），檔案小，授權可以商用。
下面的大小、授權都是**查資料得到的，還沒在 YBeat 裡實際跑過、量過速度**。正式加入前，每個模型都要用目前的 onnxruntime-web 版本驗證：算子支不支援、記憶體峰值、速度、權重的授權（不能只看程式碼的授權）。

現有：YuNet（人臉）、SFace（主角辨識）、VitTrack（追蹤補洞）、U²-Netp（去背），全部在 Worker 裡用 WASM 跑。

## 優先順序

| # | 模型 | 用途 → 對應功能 | 大小 / 授權 | 注意 |
|---|---|---|---|---|
| 1 | Beat This! small | 拍點 + 下拍，取代 `beats.ts` 從音量估出來的格線 | ~8 MB / MIT | 已有現成的 ONNX（WebGPU）：huggingface.co/musetric/beat-this-onnx。要自己寫 mel 頻譜前處理，輸出要跟官方版本比對 |
| 2 | Whisper tiny 多語 INT8 | 自動字幕，接 `subtitles.ts` | ~41 MB / MIT | transformers.js（onnx-community/whisper-tiny）。逐字時間戳在 WebGPU 上有已知問題（transformers.js #820）；歌詞辨識差，主要給口白用。base 版 ~77 MB 當「較準」的選項 |
| 3 | Silero VAD | 人聲區間：字幕分段、背景音樂避讓人聲（todo） | ~2 MB / MIT | 最划算 |
| 4 | TransNetV2 | 素材內的切鏡點 → `autoEdit` 不挑跨場景的片段 | ~31 MB / MIT | 只有第三方 ONNX，要比對數值；輸入是 48×27、每 100 格一個窗口 |
| 5 | RNNoise → DeepFilterNet3 | 人聲降噪 | RNNoise 幾 MB / BSD；DFN3 單檔 ~16 MB / MIT 或 Apache | DFN3 單檔 ONNX：huggingface.co/kimtos-labs/denoiser-dfn3（非官方轉檔）。RNNoise 是 48 kHz，要逐格保存狀態 |

## 之後可以考慮

- MediaPipe Pose Lite（~6 MB，Apache）：抓動作的高峰來卡點；缺點是要多一套 runtime
- MODNet（~25 MB，Apache）/ MediaPipe Selfie：人像去背，頭髮邊緣比 U²-Netp 好
- RIFE 4.x（~23 MB，MIT）：讓慢動作變順，整段跑很慢
- CLIP ViT-B/32 INT8（~154 MB）：用文字搜素材，檔案偏大
- GTCRN / DTLN：更小的降噪模型，可以拿來跟 RNNoise 比較
- UVR-MDX（~30 MB）：人聲 / 伴奏分離，權重授權還沒確認

## 排除

- madmom：模型是 CC BY-NC-SA（非商用）
- RMBG-1.4、MobileCLIP 的權重、Moonshine 舊版中文模型：非商用
- SenseVoice / Paraformer：中文很好，但 INT8 也要 240 MB 以上
- BiRefNet-lite：~178 MB，太大

## 模型管理：用到才下載、可以單獨刪除

### 模型清單 `src/engine/models.ts`

每個模型一筆資料，所有功能都透過這裡拿模型，不直接寫 URL：

```ts
interface ModelDef {
  id: string;            // 'beat-this' | 'whisper-tiny' | 'silero-vad' | 'yunet' ...
  name: string;          // 顯示名稱（i18n）
  feature: string;       // 用在哪個功能：「拍點偵測」「自動字幕」…
  files: { url: string; bytes: number; sha256: string }[];  // 一個模型可能有好幾個檔（Whisper 的 encoder / decoder）
  license: string;
  /** 刪除模型時一起清掉的分析結果（IndexedDB 資料庫名稱），沒有 = 只刪模型 */
  caches?: string[];
}
```

- `ensureModel(id, onProgress)`：已經下載 → 直接回傳；沒有 → 下載（顯示進度）、驗證 sha256、存起來。同時有多個地方要同一個模型時，共用同一次下載
- 存在 **Cache Storage**（`caches.open('ybeat-models')`）：大檔案存取快，Worker 也讀得到，刪除時單獨刪一個 key 就好
- `navigator.storage.persist()`：第一次下載模型時申請，避免瀏覽器空間不夠時把模型清掉

### 第一次用到時

- 例如按下「自動字幕」，但 Whisper 還沒下載 → 跳出小視窗：模型名稱、大小、授權，按「下載」/「取消」
- 下載中：在狀態列顯示進度（跟現有的背景分析進度一樣的位置），可以取消
- 模型很小（< 5 MB，例如 Silero VAD、YuNet）→ 不問，直接下載
- 離線、下載失敗 → 功能顯示「模型無法下載」，不影響其他功能

### 設定 → AI 模型（新分頁，或放進現有的「儲存空間」旁邊）

一列一個模型：

| 名稱 | 功能 | 大小 | 狀態 | 操作 |
|---|---|---|---|---|
| Whisper tiny | 自動字幕 | 41 MB | 已下載 | 刪除 |
| Beat This! | 拍點偵測 | 8 MB | 未下載 | 下載 |

- 刪除：只刪模型，或連那個功能的分析結果一起刪（例如刪 YuNet 時一起清掉「臉部追蹤」的快取），用 `Check` 選
- 最上面顯示全部模型用掉的空間；「全部刪除」
- `storageUsage.ts` 的儲存空間清單加一列「AI 模型」

### 模型放在哪裡（要決定）

1. **跟網站一起部署**（`public/models/`，跟現在一樣）：同一個網域、不依賴外部服務；但部署包會變大（加完前五名約多 100 MB）
2. **從 Hugging Face 下載**：部署包不變大，大部分模型本來就在上面；但要依賴外部服務（不會送出使用者資料，只下載檔案），而且第三方的轉檔可能被刪掉或改掉 → 用 sha256 鎖定版本、URL 指到固定的 commit

建議：自己轉檔 / 改過的模型（Beat This 的前處理版本等）放 `public/models/`，現成的大模型（Whisper）從 Hugging Face 固定 commit 下載。

### 現有的四個模型

YuNet、SFace、VitTrack、U²-Netp 也改成走 `ensureModel`，一樣可以在設定裡刪除（刪掉後下次用到再下載）。它們都很小，所以不會跳出詢問。

### 其他

- 音訊類模型共用一個 Worker 和 16 kHz 單聲道的重新取樣
- 分析結果照現在 face / matte 的做法存在 IndexedDB、不進專案檔
