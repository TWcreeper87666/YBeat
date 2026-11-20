# YBeat 與威力導演操作比較

記錄時間：2026-11-20。依威力導演官方教學與 YBeat 現有程式碼整理。第 1、2、3、6 項已實作；第 6 項的匯出設定使用置中的模態對話框。

## 建議順序

| 順序 | 功能 | YBeat 現況與建議 |
| --- | --- | --- |
| 1 | 專案封存與還原 | `src/engine/project.ts` 以 IndexedDB 自動儲存目前專案與素材。建議加入可攜的專案包匯出／匯入，以便備份及換電腦。 |
| 2 | 鎖定軌道 | `TrackState` 有隱藏、靜音、高度與排序，沒有鎖定。跨軌插入、波紋刪除、拖曳及貼上都應尊重鎖定。 |
| 3 | 字幕清單與 SRT 匯入／匯出 | 已有可造型的字幕文字片段。先加入集中校對、批次調整時間與 SRT 交換，再考慮語音轉字幕。 |
| 4 | 時間軸／片段標記 | 已有節拍線與吸附，缺少使用者命名、跳轉及吸附的標記點。 |
| 5 | 音樂自動避讓人聲 | 已有整段音量、淡入淡出與波形。可先做可編輯的音量曲線，再做自動降低背景音樂。 |
| 6 | 匯出設定與預設 | 已能輸出 MP4、30／60 fps 與循環範圍；影片位元率固定為 20 Mbps。可加入檔名、品質／檔案大小預設與 24 fps。 |
| 視效能再做 | 代理檔或區段預先渲染 | 已有降低預覽畫質與拖播放頭影格快取。若高解析度素材仍卡頓，再評估代理檔的儲存與快取成本。 |

物件追蹤、穩定器等較重的工具暫不優先；先補齊備份、時間軸保護與字幕流程。

## 參考資料

- [威力導演：封裝專案與素材](https://support.cyberlink.com/faq/powerdirector-export-issues-video-audio)
- [威力導演：時間軸軌道與鎖定](https://learning.cyberlink.com/powerdirector/how-to-use-timeline-tracks)
- [威力導演：字幕操作與 SRT](https://learning.cyberlink.com/powerdirector/how-to-add-subtitles)
- [威力導演：時間軸標記](https://learning.cyberlink.com/powerdirector/how-to-use-timeline-markers)
- [威力導演：音訊處理與自動避讓](https://learning.cyberlink.com/powerdirector/how-to-edit-audio)
- [威力導演：匯出影片](https://learning.cyberlink.com/powerdirector/how-to-export-video)
- [威力導演：代理檔設定](https://support.cyberlink.com/faq/powerdirector-preferences-changes-jan-2025)
