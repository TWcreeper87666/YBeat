# `.ybeat` 專案檔格式調整提案

狀態：提案中，等使用者同意

## 現況

| 項目 | 目前做法 |
|---|---|
| 入口 | `src/App.tsx` 的「匯出／匯入專案包」呼叫 `src/engine/project.ts` 的 `exportProjectPack`／`importProjectPack`；檔名為 `YBeat_project.ybeat`。 |
| 檔案 | 單一 JSON Blob，`type: 'ybeat-project'`、`version: 1`，包含 `project`（素材資料、片段、特效、音訊、軌道、畫面格式、模組）及以素材 id 為鍵的 `blobs`。每個 blob 是 MIME type 與 base64 字串。 |
| 匯出 | 從目前 store 複製專案資料，清除素材的 blob URL；依素材順序從 IndexedDB `media` store 讀取 Blob，以 `FileReader.readAsDataURL` 逐一轉成 base64，最後 `JSON.stringify` 整包並下載。找不到 Blob 的素材仍留在專案資料，但不寫入 `blobs`。 |
| 匯入 | `file.text()` 讀取整檔、`JSON.parse`，檢查基本欄位；對每個素材以 `atob` 解碼 base64，切成 64 KiB 的 ArrayBuffer 建立 Blob。接著在一個 IndexedDB 交易中清除舊 `media` 並寫入新 Blob，建立 object URL、替換目前 store，最後自動儲存。缺少 Blob 的素材標為 `missing`。 |
| 本機儲存 | `project` 與 `media` 分別存在 IndexedDB；這套自動儲存流程與 `.ybeat` 檔案匯出／匯入是兩件事。 |

## 問題

1. **檔案大小**：二進位素材改成 base64，光素材內容就約增加三分之一；JSON 物件、影片縮圖 data URL、音訊波形與其他專案資料另計。以根目錄實際檔案 `sample.jpg`（156,682 bytes）與 `sample2.jpg`（72,463 bytes）量測，兩張原始檔共 **229,145 bytes**，base64 共 **305,532 bytes**，增加 **76,387 bytes（33.3%）**。量測方法是 Node.js 讀取檔案後執行 `Buffer.toString('base64')`，只比較素材本體，不是完整 `.ybeat` 大小。
2. **匯出／匯入速度**：匯出對每個素材依序等待 IndexedDB 讀取與 `FileReader` 編碼，再對整包做一次 JSON 序列化。匯入一次讀取與解析全部 JSON，再逐素材以 JavaScript 迴圈解碼。耗時隨素材總量增加；目前沒有瀏覽器端實測秒數，不能把程式結構推論當成速度數據。
3. **記憶體峰值**：匯出期間 `blobs` 保留所有 base64 字串，`JSON.stringify` 又產生整包文字，建立下載 Blob 時可能再複製。匯入期間整檔文字、解析後的字串、`atob` 結果、64 KiB 分塊與解碼後 Blob 可能同時存在。實際峰值取決於瀏覽器的字串與 Blob 實作，尚未量測。
4. **重複的素材**：時間軸多個片段引用同一個 `mediaId` 時，現行檔案只存該素材一次；但同一原始檔若被多次加入素材庫，`addMediaBlob` 每次產生新 id 並各存一份，匯出也依 id 各放一份。重複的檔案內容沒有合併。

## 提案

把 `.ybeat` 改為「小型 JSON 清單＋原始二進位素材」的單檔容器，保留目前 `project` 的資料語意與各 `mediaId` 的引用方式。

- 匯出時依素材 id 讀取 Blob，採分塊計算內容雜湊（SHA-256）與長度；相同內容只在檔案的資料區放一次。清單將每個 `mediaId` 指向對應的資料項目，素材庫中的多筆紀錄及片段引用仍各自保留。對雜湊相同的項目也核對長度；雜湊與長度是檔案識別及匯入完整性檢查依據。
- 清單記錄素材的 MIME type、長度、相對資料區的位移與雜湊。匯出以 `Blob` 片段組合檔頭、清單和原始素材，不建立整包 base64 字串。相同內容的素材只附加一個 Blob。
- 匯入先讀取固定檔頭與有限長度的清單，驗證版本、必要欄位、引用、位移／長度是否落在檔案範圍內及資料項目是否重疊；以 `file.slice()` 取得素材 Blob。對資料分塊驗證雜湊後，才在 IndexedDB 交易中取代素材；驗證失敗時保留目前專案。匯入完成後依原本流程建立 URL、標記缺少素材並儲存專案。
- 顯示匯出／匯入進度，讓大型素材處理期間可見目前階段與數量。實作時以瀏覽器實測確認 `Blob` 組合、`slice()` 與 IndexedDB 寫入的實際記憶體行為。
- 驗收時使用相同專案，在同一瀏覽器量測 `.ybeat` 大小、匯出／匯入耗時與記憶體峰值；至少包含少量圖片、大型影片，以及同檔案重複加入素材庫三種案例。素材占比高且沒有重複的專案，預期可移除 base64 帶來的約 25% 素材區體積；其他改善幅度以實測為準。

## 存檔格式變更

| 區段 | 建議內容 |
|---|---|
| 檔頭 | 固定 8 bytes 標記 `YBEAT2\0\0`，接 8 bytes little-endian 無號整數，表示 UTF-8 清單長度。 |
| 清單 | JSON：`type: 'ybeat-project'`、`version: 2`、原有 `project`、`mediaAssets`（`mediaId` → 資料項目 key）、`assets`（key → MIME type、相對位移、長度、SHA-256）。只存中繼資料，不內嵌素材位元組。 |
| 資料區 | 各不重複素材的原始 bytes 串接；位移相對資料區起點，缺少原始 Blob 的素材不列入 `mediaAssets`。 |

確切欄位名稱與位元組排列在實作前定稿，並用固定樣本檔驗證。匯入須限制不合理的清單長度、檢查整數溢位與重疊區間，避免損壞檔案造成過量配置或錯誤切片。

## 不在範圍內的項目

- IndexedDB 自動儲存格式與儲存時機。
- 影片／音訊轉碼、壓縮與畫質調整；素材在檔案中維持原始 bytes。
- 縮圖、波形、AI 分析快取的重新設計。
- 以內容雜湊合併素材庫中的紀錄或改寫時間軸 `mediaId`；本提案只消除專案檔內重複的素材位元組。
