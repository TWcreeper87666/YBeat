---
name: clip-hunt
description: 幫節奏 edit 蒐集素材：依人物 / 主題搜尋 YouTube、下載影片，自動挑出動感大的 5~10 秒片段並切好放進 samples/<代號>/clips。使用者說「幫我找 / 蒐集某人的影片、片段、素材來剪」時使用。
---

# clip-hunt：蒐集節奏 edit 素材

工具：`yt-dlp`、`ffmpeg`、`python`（numpy）。腳本：`.claude/skills/clip-hunt/hunt.py`。
輸出放在 `samples/<代號>/`（已被 .gitignore 排除），代號用跟人物無關的中性名稱（例如 `set1`）。
這是公開 repo：skill、程式碼、註解、commit 訊息都不要寫出任何真實人物的名字或縮寫，人名只出現在指令參數和 `samples/`（不進 git）裡。

## 流程

1. **想關鍵字**（6~10 組）：人名 + 會有大動作 / 大聲音的場合，例如
   `演唱會 / 嗨翻 / 激動 / 吶喊 / 跳舞 / 唱歌 / 跑步 / 名場面 / 經典 / 爆笑 / 比賽 / 頒獎 / 得獎 / 揮手`，
   再加上這個人自己的招牌場面或名言。避免「完整版 / 直播 / 專訪」這類長而靜態的片。
2. **搜尋**：
   ```
   python .claude/skills/clip-hunt/hunt.py search --out samples/<代號> -q "<人名> 演唱會" -q "<人名> 激動" ...
   ```
   看 `candidates.tsv`，把明顯不相干的（同名、只有旁白、懶人包圖卡）挑掉，記下要下載的 id。
3. **下載**（久，用 `run_in_background`）：
   ```
   python .claude/skills/clip-hunt/hunt.py fetch --out samples/<代號> --ids=<id>,<id>,...
   ```
   `--ids=` 一定要用等號（id 可能以 `-` 開頭）。不給就下載 candidates.tsv 全部。已下載的會跳過。
4. **切片段**：
   ```
   python .claude/skills/clip-hunt/hunt.py clips --out samples/<代號> --min 5 --max 10
   ```
   - **主角一定要清楚出現**：用 `public/models` 的 YuNet + SFace 認臉。片段裡至少 `--presence`（預設 90%）
     的時間看得到主角，臉高至少佔畫面 `--min-face`（預設 16%）。
   - 主角預設自動判定（出現在最多部影片裡的臉）；認錯人時用 `--ref 照片1.jpg 照片2.jpg` 指定。
   - 分數 = 0.55 × 畫面動態 + 0.3 × 音量 + 0.15 × 臉大小；片段不跨鏡頭切換（`--allow-cuts` 可以跨），
     每部最多 `--per-video` 段，低於 `--threshold` 的丟掉。重跑會清掉舊的 clips；分析結果存在 `cache/`，重跑很快。
5. **確認主角**：用 Read 看 `<out>/ref.jpg`（每部影片認到的主角拼圖）。如果裡面有別人，
   代表自動判定認錯了，要找主角照片用 `--ref` 重跑。
6. **抽查片段**：每段在第 1 秒、第 4 秒各抓一格，用 ffmpeg `tile` 拼成總覽圖，再用 Read 看。
   主角太小、被字幕蓋住、畫面太暗的，就調高 `--min-face` / `--presence` 重跑。
7. **回報**：列出 `clips/index.tsv` 前幾名（檔名、長度、標題、YouTube 時間點連結），
   告訴使用者資料夾位置，請他自己看片挑選。不要自己開瀏覽器或播放器檢查。

## 注意

- 分數只看動態和音量：新聞台跑馬燈、主播棚、圖卡也可能混進來，請使用者看過再用。
- 片段數不夠 → 加關鍵字再跑一次 search / fetch / clips；太多靜態片段 → 調高 `--threshold`。
- `raw/` 是整部原片，很佔空間（40 部 1080p 約 3GB；預設已改 720p）。切完、使用者確認不再重切後，問他要不要刪 `raw/`。
- 素材版權屬原頻道，只供使用者自己剪輯；公開發布時提醒標註來源（index.tsv 有連結）。
