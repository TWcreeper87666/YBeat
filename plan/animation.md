# 動畫：多圖層關鍵影格動畫（原「主體跳出」）

## 命名與通用化（使用者確認，優先於下面各節）

- 介面名稱一律叫「**動畫**」（英 Animation、日 アニメーション）；不再出現「主體跳出」。程式代號可沿用 `pop`／`PopItem`，或改成 `anim`，實作時統一即可。
- 動畫不是「14 種寫死的變體」，而是**通用的多圖層關鍵影格動畫**：一個動畫有 N 個圖層，每個圖層指向一個圖槽（可單獨換圖），各自有位置 X/Y、縮放、旋轉、透明度的關鍵影格（沿用 `engine/keyframes.ts` 的 Keyframe / ease），另外可設：去背（用槽的 AI 遮罩）、遮罩（用某個圖層的輪廓開窗或挖洞，取代 silhouetteWindow / subjectHole 的寫死邏輯）、模糊 / 黑白 / 變暗這類圖層效果（可以直接用現有的片段特效）。
- 關鍵影格的時間單位用**拍**（相對動畫開頭），放到時間軸時照實際拍距換成秒，所以同一個動畫換歌、換速度都跟著拍子走；沒有節拍時 1 拍 = 預設秒數。
- 現有 14 種主體跳出改成**內建範本資料**（`subjectPop.ts` 的 `expandPop` 公式轉成每種一份圖層 + 關鍵影格的資料），渲染只有一條通用路徑（`animLayers(item, t)`）。範本裡可以放「每拍一次」這類重複規則，或直接展開成關鍵影格。
- 「我的動畫」= 使用者存的範本（含圖層、關鍵影格、槽的素材指派）。
- 下面第 1～7 節的 `PopParams`（steps / scaleSteps / direction…）改成範本層級的「快速調整」參數（例如整體放大倍數、拍數），作用方式是縮放 / 重算關鍵影格，不是另一套渲染公式。

## 目標與現況

讓「主體跳出」成為可拖放、可替換每張圖、可即時調整及儲存的動畫資產。手動放置和自動剪輯產生的項目使用同一資料及渲染路徑。舊專案已展開的跳出保持原本的普通片段；開發階段不做反向辨識或遷移。

目前 `subjectPop.ts:PlanPop / expandPop` 只認主要 `mediaId`、可選的 `revealMediaId`，回傳 `PopLayer[]`；`autoEditApply.ts:planItems / popClip` 把它們永久展成片段並與底圖、揭露鏡頭設同一 `group`。`autoEdit.ts:planEdit` 只挑一個主體及揭露素材；`popInfo / popFrameCandidates` 對圖片或影片格做去背、評分與描邊。新模型須保留這些挑選能力，但不可再把多張素材藏在片段群組裡。

## 1. 資料模型與軌道

在 `store.ts` 加 `pops: PopItem[]`、`ItemType = … | 'pop'`、`LIST.pop`，`KIND_OF.pop = 'video'`。`PopItem` 佔**一條上層影片軌**的一個方塊；`track` 是疊放順序，和一般片段一樣受影片軌顯示、鎖定、搬移與刪除控制。放到片段／節拍時使用該片段上方的空影片軌，若同軌已有時間重疊的項目則找空軌或新增軌，不覆寫底片。普通特效軌的 `fxLevel` 合成順序照原軌道層級作用。

```ts
type PopSlotId = string; // 例如 subject, background, reveal, copy:0；變體可增至 N 槽
interface PopSlot {
  id: PopSlotId;
  role: 'subject' | 'background' | 'reveal' | 'copy' | 'other';
  label: string;
  mediaId: string | null;          // null = 待填，顯示缺圖提示
  sourceTime: number;              // 影片的原素材秒數；圖片為 0，預設整段定格
  crop?: Crop;                     // 原素材座標；換圖時重新檢查／重算
  cutout?: { mode: 'auto' | 'off'; face?: FaceBox; outline?: string };
  override?: {
    path?: { x: Keyframe[]; y: Keyframe[] }; // 項目內秒數、畫面正規化座標
    speed?: Keyframe[];          // 0..1 進度；單調遞增，決定該槽走路徑的速度
    scale?: Keyframe[]; rotation?: Keyframe[]; opacity?: Keyframe[];
  };
}
interface PopParams {
  steps: number;                 // 節拍數；有音樂時由節拍邊界決定各步時間
  scaleSteps: number[];          // 長度與 steps 對齊
  ease: Bez; direction: [number, number]; rotation: number;
  revealAt: number;              // 0..1，跳出項目內的揭露時點
  text: string; colors: Record<string, string>;
  maskGrowth?: number[];         // 剪影窗／挖洞每步倍率
}
interface PopItem extends ItemBase {
  id: string; variant: PopVariant; track: number; start: number; duration: number;
  slots: PopSlot[]; params: PopParams;
  beatTimes?: number[];          // 相對 start；無音樂時按 duration / steps 均分
  anchor?: { baseClipId?: string; revealClipId?: string }; // 編輯提示，渲染不依賴
  presetId?: string;             // 來源資訊；存好後的實例仍可獨立改
}
```

`subjectPop.ts` 定義各變體的槽規格與預設參數，而非固定兩個素材欄位：`step/fly/mono/…` 至少有 `background + subject`；`crossShot/silhouetteWindow/subjectHole` 加 `reveal`；`trail/grid/spin` 預設把多個 `copy` 槽指向同張主體，但每槽有自己的 `mediaId/sourceTime/cutout/override`，可逐張換。每個可見圖層指向一個槽；同槽可被多層重用。未填必要槽可放入時間軸並顯示佔位，預覽／匯出須提示缺圖，不應悄悄取用別的圖。

`anchor` 只供「從片段放入」與定位顯示；項目自己的背景、揭露槽已保存素材與影格，刪除／搬動底片不會讓跳出失效。放在底片上時預設取底片當 `background`，取目前影格當 `subject`；揭露槽預設取下一個鏡頭的首格，找不到則留待填。完整背景由跳出項目自行繪製，避免底片被換／移動後效果改變。揭露後交棒給底下剪接的鏡頭；放置時可將項目終點對齊該鏡頭開頭，但不自動修改其轉場或運鏡。`autoEditApply.ts:planItems` 現有的揭露鏡頭對齊修正需保留在自動剪輯產片流程。

## 2. 渲染與效能

把 `subjectPop.ts:expandPop` 的變體公式重構為純函式 `popLayers(item, t): PopRenderLayer[]`（`t` 為專案秒數）：輸出當前有效圖層、`slotId`、z 順序、各圖層的變換／透明度、特效、遮罩及素材取樣時間；不讀 store、不建立持久片段。`PlanPop` 只作規劃中間資料，再轉成 `PopItem`。共用 `engine/keyframes.ts:evalKeys` 計算每槽路徑與進度曲線；先算 `speed` 的進度，再沿 `path` 取位置。預設公式須涵蓋現有 14 種變體，`steps` 不可寫死為四拍；數值範圍與陣列長度在建項／改參數時正規化。

在 `renderer.ts:makeCtx / render` 把 `PopItem` 加入影片軌合成；在該軌繪圖時按 `popLayers` 逐層呼叫共用的素材取樣、`drawTex`、混合與片段特效能力，避免把生成的片段寫回 store。若用暫時 `Clip` 適配 `drawClip / drawClipRaw`，其 id 必須穩定為 `popId:slotId:layerId`，且禁止產生影片原音或普通轉場。`prepareExact` 必須收集同一時刻所有 pop 槽的圖片與影片影格，走和預覽相同的展開結果；匯出逐格 seek 及圖片解碼，不可只改 `render`。

`matte.ts:ensureMatte / matteAt` 依每槽 `mediaId + sourceTime` 取得 AI 遮罩；替換素材／影格時重新跑 `autoEditApply.ts:popInfo` 的 `keepFace / scoreMatte / popFraming / traceMatte` 邏輯（移到可共用的分析函式）。`silhouetteWindow / subjectHole` 的遮罩形狀來自指定 `subject` 槽，覆在 `reveal/background` 槽的畫面上；遮罩需按該槽的 crop、cover、位移與倍率對齊，不能直接沿用舊 `PlanPop.path`。四格／飛入／旋轉時輪廓也要跟圖層變換；若無合格 matte，顯示可修正狀態，不輸出錯誤的整張去背圖。

快取以素材 id、原始影格時間、crop、face、輸出比例與遮罩設定為鍵，重用同槽／同幀的紋理和遮罩；槽改動時只失效該槽，項目參數改動只重算幾何。限制同時預取的影片格及 GPU 貼圖，遠離播放頭時釋放，避免 N 槽的四格／拖影每幀重做 AI 分析。`renderer.ts:makeCtx` 的參照快取鍵必須納入 `pops`。

## 3. 編輯介面

- 在 `ui/dockTree.ts:PanelId`、`ui/Dock.tsx:PANELS/LIB/PRESETS`、`App.tsx` 加「主體跳出」分頁。`LeftPanel.tsx` 新 `PopLibrary` 沿用 `.lib → LibToolbar → LibFilter → .lib-body`、搜尋、格／列檢視；卡片沿用 `PopPicker.tsx:POP_ORDER / PopDemoCard` 的 CSS/SVG 動畫，點選可循環預覽。分類：全部、背景／進場／換畫面、我的主體跳出。
- 在 `ui/uiStore.ts:DragPayload / DropTarget` 與 `ui/dnd.ts:computeTarget / laneAccepts` 加 pop 拖放。落在影片軌、片段或節拍處皆產生一個 `PopItem`；使用 `beatGrid.ts:beatSnapPoints` 和現有 `snap` 開關，預設以落點最近節拍為起點、依實際拍距算長度；無節拍用固定秒數。放置預覽顯示一個方塊及必要槽是否齊備，片段上放置時從該片段填槽。
- `Timeline.tsx:renderLane` 加 `PopView`，方塊顯示變體動畫縮圖、槽數、缺圖警示、鎖與 take 標記；選取是 `pop:id`，拖曳／修剪整個項目而非內層。播放頭顯示目前步數。點擊方塊開 `LeftPanel.tsx:InspectorPanel` 的 `PopInspector`。
- Inspector 第一區是**全部槽的縮圖清單**，包含背景、主體、揭露與每個 copy；每槽獨立有「從素材選取／從影片取格」、時間碼、裁切、去背狀態及重算入口。素材 tab 拖到槽縮圖替換**該槽**，拖到 pop 方塊則先高亮槽選擇器，避免默默全換；影片格用現有 `SourcePanel` 的選格／時間碼操作。替換 copy 不影響其他 copy。預覽畫布點中圖層可聚焦對應槽並拖動路徑控制點。
- Inspector 其餘區用 `EffectControls.tsx:Channel/Host` 的關鍵影格列及 `CurveEdit.tsx:CurveEdit/EasePresetsMini`：共用步數、逐步縮放、緩動、飛行方向、旋轉、顏色、文字、揭露時點；每槽有獨立的路徑 X/Y、速度進度、縮放／旋轉／透明度。要擴充 `Host` 解析 `pop:<id>:<slotId>`，並讓畫布／曲線編輯器操作同一份 keys；拖曳中的改動即時重繪，使用 `history.ts` 的交易把一次拖曳算一步。速度進度單調限制與路徑座標提示要明示。

## 4. 自動剪輯與一般操作

`autoEdit.ts:planEdit` 繼續產出 `plan.pops` 並保留 reveal 選鏡；`autoEditApply.ts:planItems` 回傳 `{ clips, effects, pops }`。把虛擬影片格 `Footage.srcId/from` 轉成每槽真實 `mediaId/sourceTime`，背景從當前底圖、揭露從預定下一鏡頭填入。對 `trail/grid/spin` 建出可逐一替換的 copy 槽，預設仍複製主體；不再呼叫 `popClip` 產生永久圖層，也不以 `group` 把底圖與揭露鏡頭綁死。自動產生的 `PopItem.take` 與其他項目相同。

`autoEditApply.ts:takeItems/takeSig/canReplaceLast/runAutoEdit` 納入 pops：鎖住的 pop 原 id／參數／槽原封不動保留並改標新 take，其時間範圍加入 `locked.shots`，阻止新鏡頭／跳出覆蓋；未鎖的上一版 pop 刪除重建。`takeSig` 仍忽略 `locked`，但手改槽／曲線會改摘要，維持目前「上一版手改後不可直接替換」規則。需同時檢查鎖住 pop 的底片關係：因渲染自足，底片被換不會讓 pop 消失，但新的鏡頭規劃應避開鎖住範圍。

`store.ts` 的 `spansOf`、選取／群組、碰撞移動、軌道增刪／重排、`projectDuration`、複製貼上與刪除迴圈都納入 pop。貼上複製槽與參數、生成新 id、去掉 `take/locked`，不複製 `anchor` 指向的舊 clip；刪除 pop 不刪底片。**不支援分割 pop**：`split/splitAtTimes` 略過並在選單禁用，因切半會破壞步數、遮罩及揭露語意；可修剪起訖並將步點重映射。鎖住項目可改槽與參數、不可移動／修剪／分割，沿用 `store.ts:itemFixed` 語意。復原／重做把 `pops` 納入 `history.ts:Doc/sameProj`，單次槽替換、放置、Auto Edit 套用都應可復原。

## 5. 我的主體跳出與儲存

在 `prefs.ts:usePrefs` 仿 `fxCombos` 加 `popPresets`，存變體、參數、槽角色及每槽 override，附可選的預設素材 id／影格；卡片可改名、刪除、再拖放。**偏好設定跨專案，但素材 id 不保證跨專案存在**：拖入新專案時查 `media`，找不到就將該槽設為待填，並標明缺圖；不把 Blob 複製到 localStorage。使用者按「存到我的主體跳出」後存的是當下樣式與槽配置，已放置項目不連動後續預設修改。若日後需要可攜且內含素材的預設，另設匯入／匯出規格。

`project.ts:Saved/refsOf/sameStore/save/loadProject/newProject/packProject/importProjectPack` 加 `pops` 並把槽引用算入遺失素材、色板保留與清理；`ybeatPack.ts` 容器本身只包 `Saved` JSON 與素材，不需另建渲染資料。專案資料格式可新增欄位；舊專案缺 `pops` 讀成 `[]`，舊展開片段照原樣保留，不寫 pop 遷移器。

## 6. AI 工具

`ai/projectTools.ts` 的 snapshot、查詢、`Op.add_items` 驗證與套用要認得 pop，至少能列出變體、時間、槽狀態並安全新增／修改／刪除 pop；驗證 media id、sourceTime、參數界限與所需槽，不接受任意遮罩路徑或無界的 key 陣列。`ai/autoEditTools.ts` 保留目前變體開關／規劃選項，生成後回傳 pop 數與缺槽狀態；其呼叫 `runAutoEdit` 的「再一版」行為與 UI 相同。AI 的素材替換應指定 `popId + slotId`，不可再假設只有單一 `mediaId`。

## 7. 分階段交付與驗證

| 階段 | 可交付結果 | 主要檔案 | 必要測試 |
|---|---|---|---|
| 1. 核心項目 ✅ | 預設槽模型、手動建立及儲存／復原，可在時間軸看到 pop 方塊 | `subjectPop.ts`, `store.ts`, `tracks.ts`, `history.ts`, `project.ts`, `Timeline.tsx` | 槽數／複製槽獨立、貼上新 id、軌道碰撞、鎖住、舊專案讀取、專案包 round trip |
| 2. 渲染 ✅ | 全變體以新項目在預覽與匯出正確播放；缺圖清楚提示 | `subjectPop.ts`, `renderer.ts`, `matte.ts`, `autoEditApply.ts` 的共用 matte 分析、`project.ts` | `popLayers` 各變體／步數／路徑速度、換槽後 matte 失效、窗／洞遮罩、同時多槽影片格及 `prepareExact` 的預覽匯出對照 |
| 3. 素材庫與編輯 ✅（每層曲線用屬性面板的關鍵影格；畫布上直接拖路徑還沒做） | 分頁拖放、槽替換、即時參數與每槽曲線、我的預設 | `Dock.tsx`, `dockTree.ts`, `App.tsx`, `LeftPanel.tsx`, `PopPicker.tsx`, `dnd.ts`, `uiStore.ts`, `EffectControls.tsx`, `CurveEdit.tsx`, `prefs.ts`, `styles.css`, `i18n.en.ts`, `i18n.ja.ts`, `helpText.ts` | 節拍吸附、拖到指定槽、影片取格、參數改後即時預覽、預設跨專案缺圖提示；`tsc` + 相關 UI 測試 |
| 4. 自動剪輯與 AI | Auto Edit 直接產 pop；鎖住與再一版完整可用 | `autoEdit.ts`, `autoEditApply.ts`, `projectTools.ts`, `autoEditTools.ts`, `store.ts` | 自動產 N 槽、虛擬格轉真實素材時間、鎖住保留／避讓、take 簽名與手改、再一版、撤銷重做；全套 `npm test` |

每階段應可獨立開啟專案、正常播放／匯出已有內容；第 1 階段的新 pop 尚未渲染時先隱藏新增入口，待第 2 階段才開啟手動建立。依 `CLAUDE.md`，資料模型、renderer、store 變更跑 `npx tsc --noEmit -p .` 與完整 `npm test`；UI 文字同步 `helpText.ts` 和英、日文翻譯。

## 已決定（使用者確認）

1. 放在空白處：允許必要圖槽待填，時間軸與屬性面板明示缺圖，之後拖素材進槽補上。
2. 「我的主體跳出」保存每槽的素材指派；跨專案找不到素材時該槽轉為待填。
3. 放在片段上：不改底下的片段，只把結尾吸附到現有剪接點；揭露槽預設取下一個鏡頭的第一格。

## 補充（審閱時加的）

- `beatTimes` 是放置當下的拍點；項目被搬動或修剪後，若時間軸有節拍格線，要依新位置重新對到格線上的拍子（無節拍則照 duration / steps 均分），不然會跟音樂錯開。測試要涵蓋搬動後重新對拍。

## 摘要

- 新增單一 `PopItem`，內含可擴充的 N 個獨立素材槽，位於上層影片軌。
- 每個槽可換素材或影片格，擁有自己的去背、路徑與速度曲線。
- `popLayers(item, t)` 即時計算圖層；預覽與逐格匯出共用結果。
- 底圖與揭露鏡頭僅作放置參考；跳出保存自己的素材，不依賴片段群組。
- Auto Edit 直接產生 pop，並納入鎖住、再一版、復原與複製貼上。
- 我的預設沿用偏好設定，跨專案缺素材時顯示待填槽。
- 待確認空白放置、預設是否記住素材，以及手動放置是否應改動下一鏡頭。
