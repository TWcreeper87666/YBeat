# 主體跳出變種：自動剪輯設計案

**範圍：**延伸 `auto-edit-plan.md` §3.4「主體跳出」與 §3.5「變化」。只規劃，不改程式。

## 1. 已核對的能力與限制

| 能力 | 目前用法與檔案 | 對主體跳出的結論 |
|---|---|---|
| 音樂事件 | `src/engine/musicAnalysis.ts` 的 `MusicInfo` 有 `sections`、`drops`、`accents`、逐拍 `energy` / `level`。`src/engine/autoEditApply.ts` 的 `MusicSource.time(i)` 把拍索引換為時間。 | 將落點設在 drop 或段落邊界；進場窗口用整數拍索引。 |
| 計畫 | `src/engine/autoEdit.ts` 的 `EditPlan` 只有 `shots` / `overlays`。`PlanOverlay` 是 `moduleId` + 範圍；`planItems` 將它變成 `FxItem`。 | 主體效果不是單一全畫面效果方塊。建議另加 `pops`。 |
| AI 去背 | `src/store.ts` 的 `Clip.aiMatte?: boolean`。`src/engine/matte.ts` 的 `ensureMatte`、`matteAt`、`requestMatte`、`prepareMattes`。 | 同一素材複製成上層 clip，設 `aiMatte: true`。圖片與影片都可用。 |
| 去背模型 | `src/engine/matteWorker.ts` 以 U²-Netp、320×320 輸入，輸出 8-bit 遮罩。執行後端固定 WASM。 | 只有「白色為主體」的 alpha；沒有反向選擇或主體框 API。細髮、細線會受 320px 限制。 |
| 遮罩快取 | `matte.ts` 依素材 id 存記憶體及 IndexedDB；圖片只有 key 0；影片依實際影格 PTS 存，逐格算。`matteIndex.ts` 的 `pickFrame` 在合理時間差內取相應影格。 | 同素材複製 clip 可共享遮罩資料；每個 clip 仍有自己的 GPU 貼圖。快取是素材層，不是效果變種層。 |
| 去背耗時 | `matte.ts` 的 `chain` 串列工作；影片先嘗試 `decodeRange`，失敗才逐格 seek。`matteFrames` 每秒取 60 個需求點，再按素材 fps 去重。 | 成本約隨使用影格數增長；首次模型下載、逐格 WASM 推論、解碼與 IndexedDB 寫入都會延遲。無可靠固定毫秒數。長影片勿整段預算。 |
| 未就緒 | `renderer.ts` 的 `matteTex` 查不到遮罩時呼叫 `requestMatte` 並回傳 null；`drawTex` 於 `u_useMatte=0` 畫原圖。`exporter.ts` 先呼叫 `prepareMattes`。 | 預覽會暫時顯示上層完整矩形，破壞效果。自動剪輯應先預算或採保守回退；匯出會等待。 |
| 遮罩 | `src/engine/mask.ts` 的 `Mask`：`shape`、`invert`、`x/y/w/h`、`feather`、`rotation`；`maskAt` 讀 `mask.*` keys。`maskShapes.ts` 支援 rect、ellipse、path、形狀庫與自訂圖。 | 這是幾何／距離場遮罩，不會直接讀 AI matte。羽化單位是畫面高度。 |
| 片段遮罩 | `src/modules/extra.ts` 的 `fx-clipmask`；設成 `ClipFx { base:true, mask }`。`renderer.ts` 將 base 排在片段效果最後，對 `fx-clipmask` 翻轉 `mask.invert` 後混合透明畫面。 | `mask.invert=false` 保留形狀內；`true` 挖掉形狀內。這不能做「AI 主體形狀的洞」。 |
| 片段動畫 | `src/engine/keyframes.ts` 的 `newKey(t,v,ease)`、`evalKeys`；`Ease` 可為 Bezier 或 `'hold'`。`Clip.keys` 可設 `x/y/scaleX/scaleY/rotation/opacity`；`transform.ts` 的 `clipTransformAt` 評估。 | 每拍階梯縮放用前一個 key 的 `ease:'hold'`；最後一段可改 Bezier。時間是 clip 內秒數。 |
| 變換原點 | `renderer.ts` 的 `CLIP_FS` 先以畫面中心為原點做位移、旋轉、縮放；`fitSize` 按 `cover/contain` 計算。 | `scaleX/scaleY` 不是繞主體中心。需要同步調整 `x/y`，或新增 pivot 能力。 |
| 逐拍片段特效 | `src/engine/trigger.ts` 的 `ClipFx.timing: {kind:'beat', every, d}`；`renderer.ts` 的 `drawClip` 以 `fxWindow` 在每個拍點重啟效果。`BeatEvery` 是 `0.5/1/2/4`。 | 可以讓上層主體 clip 每拍震動或脈衝。`FxItem.trigger` 是全畫面效果方塊的另一機制。 |
| 追蹤 | `src/engine/follow.ts` 的 `Subject` 只有 `{kind:'face'}` 或 `{kind:'box', anchors}`。`subjectAt`、`subjectRectInFrame` 查臉部或 ViT 框；`faceTrack.ts` / `boxTrack.ts` 提供框與中心。 | 可用已設定的 face/box 錨點定位；不能從 AI matte 自動得到主體框。`@follow` 只驅動模組 point 參數，沒有驅動 `Clip.transform`。 |
| 疊軌 | `src/engine/renderer.ts` 由 `videoTracks` 索引小到大繪製；上層 clip 以 premultiplied alpha 混到下層。`Clip.blend` 可為 normal/add/screen/multiply/subtract/lighten，預設 normal。 | 背景 v0、主體 v1、文字 v2。每條影片軌同時只取一段，複製品要佔不同軌。 |
| 套用限制 | `src/ai/projectTools.ts` 的 `applyProposals` / `add_items` 會視需要只建立**一條**影片軌，並把所有 clip 的 `track` 改成那一軌。 | 即使 `planItems` 輸出 v0/v1/v2，現行提交路徑也會壓平。第一期必改套用資料／軌道分配邏輯，無須改 renderer。 |

### 1.1 特效選用清單

下表的參數名已對照 `src/modules/builtin.ts`、`extra.ts`、`rhythm.ts`。片段特效放在 `Clip.effects`；全畫面點綴放在 `FxItem`。

| id | 有用參數 | 實際限制 |
|---|---|---|
| `fx-zoompulse` | `amount`、`blur`、`bounce`、`center @follow` | 影像取樣的縮放脈衝，不會改 clip 尺寸。用 `ClipFx.timing` 逐拍。 |
| `fx-shake`、`fx-shakeblur` | `strength`、`rotation`、`freq`、`decay`；後者另有 `blur` | `fx-shake` 在 `builtin.ts`，`fx-shakeblur` 在 `extra.ts`。可逐拍作用於主體 clip。 |
| `fx-flash`、`fx-rgb` | `intensity/decay/tint`；`amount/decay/radial/angle` | 用在主體 clip 可只影響主體；亮色加法可能溢出輪廓。 |
| `fx-entrance` | `fromScale`、`fromX`、`fromY`、`fromRot`、`ease`、`bg` | shader 越界回傳不透明 `bg`，不適合直接套在透明主體層；優先用 `Clip.keys`。 |
| `fx-outline` | `strength`、`lineColor`、`keep`、`glowLine` | 依畫面亮度找邊，**輸出 alpha=1**；套在 cutout clip 會蓋住背景，且非輪廓描邊。需新 alpha-aware 模組。 |
| `fx-glow` | `threshold`、`intensity`、`radius`、`tint`、`fade` | 亮部光暈，不以 matte 邊界發光；不能直接當主體輪廓光。 |
| `fx-zoomecho` | `copies`、`spread`、`opacity`、`center @follow`、`ease` | 同一 clip 的取樣殘影；與獨立多份主體堆疊不同。 |
| `fx-bw`、`fx-grade` | `contrast/amount/decay`；`contrast/saturation/vignette/tint` | 背景 clip 可局部黑白或降飽和。`fx-grade.saturation` 可設 0。 |
| `fx-blurpulse`、`fx-split` | `amount/zoom/ease`；`cols/rows/gap/gapColor/popIn` | 前者是瞬間模糊；後者複製整張輸入，非每格獨立的 cutout。 |
| `fx-clipmask` | `ClipFx.mask` 的 `shape/invert/feather` | 幾何裁切／挖洞；不接受 U²-Netp 貼圖。 |

## 2. 共用展開規則

記號：`b` 是落點拍；`T(i)=MusicSource.time(i)`；`Δ=T(b)-T(b-1)`；`A` 是主體素材；`B` 是落點後的完整鏡頭。`v0/v1/v2` 是由下到上的影片軌。落點前窗口預設 `[b-4,b)`，不能越過計畫範圍。所有 clip 的 `volume=0`。

```ts
// 規劃中的資料；不代表目前已存在。
type PopVariant =
  | 'step' | 'halo' | 'dim' | 'mono' | 'blur'
  | 'trail' | 'grid' | 'spin' | 'fly' | 'shakeFlash'
  | 'crossShot' | 'textBehind' | 'silhouetteWindow' | 'subjectHole';
type PopQuality = 'ready' | 'pending' | 'reject';
```

共用「主體」片段：`makeClip({ mediaId:A, track:1, start:T(b-4), duration:T(b)-T(b-4), in:sourceIn, aiMatte:true, volume:0 })`。圖片 `in=0`；影片 `in` 要與下層同素材畫面對齊，且檢查可用長度。`Clip.keys` 的時間一律用 `T(i)-clip.start`；可用 `newKey` 產生。落點 `b` 以完整 `B` 的 `PlanShot` 硬切進入，主體上層 clip 在 `T(b)` 結束，不使用交疊轉場。

現在的 `planItems` 對 shot 只建 v0 clip，並在相鄰 shot 加 `transitionIn`。新增展開器必須先保留主體窗口與硬切；禁止該邊界的 `transitionIn`，避免「下一 frame 是完整圖片」被轉場混掉。若預算多個變種，按上層軌道、時間區間檢查衝突，不能重疊同軌 clip。

## 3. 變種目錄

下列每列皆先套用共用上層主體規則。`0/1/2/3` 表示從窗口起點數的拍。估算是增量開發量：小＝純展開／少量 UI；中＝新增分析或模組；大＝renderer 新合成能力。所有「可現做」仍須先修正 `add_items` 多軌套用。

| 變種 | 拍點與展開成現有項目 | 缺口／大小 | 何時選用 |
|---|---|---|---|
| `step` 階梯放大→全圖 | build 的 `b-4..b-1`，v0 放 A 完整畫面；v1 A 去背，`scaleX/Y` 在 0/1/2/3 拍設 1.00/1.20/1.45/1.75，前段 `hold`；`b` 硬切 v0 的 B 完整圖。 | 多軌套用、matte 品質量測：中。精確繞主體中心需 pivot：中。 | build→drop；高能量；圖片優先。主體要居中、未貼邊。 |
| `halo` 描邊光暈 | `b-2` v1 主體彈入，`b-1` 加一次亮邊，`b` 全圖。v0 A；v1 `aiMatte` + scale keys；預定新 `fx-matteoutline` 片段效果。現有 `fx-glow` 只可作亮部替代。 | alpha-aware 輪廓 shader：中；現有 `fx-outline` 不能用於透明層。 | drop 強拍；輪廓清楚、背景反差高；圖片或短影片。 |
| `dim` 暗背景浮出 | `b-2..b`：v0 A 加 `fx-grade`，`saturation` 降低、`vignette` 加重；v1 A 去背從 0.85→1.25。`b` 換完整 B。 | 背景暗度需新專用參數或覆蓋色層：小／中。現有 grade 只能近似。 | build 低能量轉 drop；主體面積中等。 |
| `mono` 彩色主體／黑白背景 | `b-4` v0 A 的 `Clip.effects=[fx-bw {amount:1,decay:0}]`；v1 原色 A 去背；`b-1` v1 放大；`b` 全圖。 | 無 renderer 缺口；多軌與 matte 評分：中。 | build/body；色彩鮮明的圖片或運動慢的影片。 |
| `blur` 清晰主體／模糊背景 | `b-2` v0 A 加模糊；v1 A 去背並固定清晰；`b-1` 脈衝；`b` 全圖。現有 `fx-blurpulse` 僅瞬態，不能穩定模糊。 | 新持續 `fx-blur` 或背景預烘焙：中。 | 中能量，背景雜亂但主體清楚；圖片佳。 |
| `trail` 殘影接力 | `b-3/b-2/b-1` 各新增 v1/v2/v3 的同源去背 clip，分別固定小/中/大 scale、降低 opacity 或用 `blend:'screen'`；每拍前一份保持至 `b`。可附 v3 `fx-zoomecho` 短 hit。 | 動態軌道數、碰撞／成本限制：中。`fx-zoomecho` 不是獨立分身。 | hype，密拍；主體小、邊乾淨；短窗口。 |
| `grid` 多格主體 | `b-2` 同源去背 A 分配到 v1..v4，`scaleX/Y≈0.45`、`x/y` 放四角，`opacity` 逐拍 0→1；`b` 全圖。`fx-split` 不可取代此法。 | 多軌展開與主體中心校正：中。 | body 節奏段；孤立主體、留白多；圖片。 |
| `spin` 旋轉分身 | `b-2` v1/v2/v3 複製 A matte；不同 `rotation`、`x/y`、`opacity`，逐拍 0.6→1.2 scale；`b` 全圖。 | 精確圍主體旋轉需 pivot：中。 | hype/drop；主體大致置中，邊界空間足。 |
| `fly` 滑入／飛入 | `b-2` v1 A matte，`x` 從 ±1.1→0、`rotation` 從 ±12°→0、`scale` 0.75→1.15；`b-1` hold；`b` 全圖。用 Bezier `back` 或 `expoOut`。 | 無 renderer 缺口；主體中心與安全裁切：小／中。不可直接用 `fx-entrance` 的不透明 `bg`。 | build/body，方向與前鏡頭動勢一致；圖片或短影片。 |
| `shakeFlash` 每拍震閃 | `b-4..b` v1 A matte；`Clip.effects` 加 `fx-shake` 或 `fx-shakeblur`，`timing:{kind:'beat',every:1,d:0.18}`；再加 `fx-flash` 的同型 timing；scale 用 hold 每拍加大。 | 無 renderer 缺口；要限制亮度與頻率：小。 | hype/drop，高能量，主體輪廓穩定。 |
| `crossShot` A 主體疊在 B | `b-2` v0 換 B 完整畫面，v1 保留 A 去背並以 x/opacity 淡入；`b-1` 主體放大；`b` v1 結束、v0 B 完整圖。 | A/B 時間對齊、不同 shot 的覆蓋排程：中。 | 段落邊界；A 與 B 色／形有對比；A matte 合格。 |
| `textBehind` 文字在主體後 | `b-2` v0 A 完整圖；v1 `makeTextClip` 放標題；v2 A 去背，從 0.9→1.3 scale；`b` 全圖或保留字。 | 文字內容與安全區、三軌套用：中。遮罩未好時會遮住文字。 | build 的標題／人物名；主體偏一側、中央可放字。 |
| `silhouetteWindow` 主體輪廓內看 B | `b-2` v0 A、v1 B，v1 alpha 只保留 A 的 matte 輪廓；`b-1` 輪廓擴張；`b` B 全圖。 | renderer 要讓 clip 取別的素材的 matte，並指定 source/反向：大。`fx-clipmask` 的 shape 不能引用 matte。 | drop 揭露；A 輪廓完整、B 主題相關；先限圖片。 |
| `subjectHole` 主體洞顯露下一鏡 | `b-2` v0 B、v1 A 完整圖；v1 的 alpha 設 `1 - matte(A)`；`b-1` 洞擴大；`b` 結束 v1、顯示 B。 | renderer 加 `matteInvert`／matte 膨脹或縮放遮罩：大。目前 `Clip.aiMatte` 只有布林值。 | drop 或 outro，輪廓大但不貼邊，背景 A 與 B 對比強。 |

### 3.1 每種變種的片段細節

以下補充展開時的欄位。每段仍須通過第 5 節門檻。`S(i)=T(i)-T(b0)` 是上層 clip 的 local 秒數。

**`step`：最接近原需求的基本款。**

- `b0=b-4`；下層 v0 可用同源 A 原圖，維持 `fit:'cover'`。
- 上層 v1 的 `keys.scaleX` 與 `keys.scaleY` 完全相同；`S(0..3)` 用 `hold`，`S(4)` 是 clip 終點。
- `b-1` 到 `b` 可選擇 `[0.16,1,0.3,1]` 做最後衝大；若要嚴格逐拍階梯，維持 `hold`。
- 若 B=A 且是圖片，`b` 的完整圖用未開 `aiMatte` 的新 shot；若 B 是影片，須指定 `revealIn`。
- `b` 禁止 `transitionIn`；上層 `duration=T(b)-T(b0)`，避免落點殘留一格。

**`halo`：輪廓成為打拍訊號。**

- v1 仍是 A 的去背 clip，位置與 scale 可沿用 `step` 的前兩拍。
- 現有 `fx-glow` 可以加在 v0 的完整背景上，產生亮部氛圍；不能視作輪廓。
- 現有 `fx-outline` 的 `return vec4(...,1.0)` 會把 v1 透明區變不透明，首版不得套在 v1。
- 新模組應由輸入 alpha 邊界算線，輸出仍是 premultiplied alpha；參數用 `width/color/intensity`。
- 落點前一拍做一次輪廓脈衝，`b` 直接換 B，不保留白邊。

**`dim`：背景退後，主體向前。**

- v0 是未去背的 A；`fx-grade` 放 v0 `Clip.effects`，不是最上層 `FxItem`。
- `saturation:0` 會偏向黑白；若只求暗背景，目前可提高 `vignette`，但中央不一定變暗。
- 真正均勻壓暗可新增 `fx-dim`，或用純黑素材／文字層加 opacity；後者需先建立可依賴的色板項目。
- v1 A matte 保持原色，避免背景的 grading 一起套上去。
- `b` 撤掉 v0/v1 的構圖，回到 B 的完整色彩。

**`mono`：最穩定的分色款。**

- v0 的 `ClipFx` 用 `moduleId:'fx-bw'`、`params:{amount:1,decay:0}`，不設 timing，整段保持黑白。
- v1 同源 A，`aiMatte:true`，不放 B&W 效果，仍是原色。
- v0/v1 的 `fit`、`in`、`rate`、`remap`、`start` 必須一致；只有 v1 的 `keys` 可變。
- 圖片先做；影片若主體快速移動，先用首／中／末 matte 檢查 bbox 穩定性。
- `b` 選全彩 B；若 B=A，視覺上就是彩色主體擴張成整張彩色畫面。

**`blur`：景深式跳出。**

- v0 A 加持續模糊，v1 A matte 保持清晰；兩者來源時間必須同步。
- `fx-blurpulse` 有 `@hit`，其模糊隨進度消退，不適合從 `b-2` 穩定維持到 `b`。
- 可先以 `fx-blurpulse` 的 `ClipFx.timing` 做一拍試驗款，但變種名稱應標成「瞬間模糊」。
- 正式款要新增可持續的 `fx-blur`，並確認模糊輸出不改 alpha。
- 背景細節太多、matte 邊有輕微毛刺時，模糊背景可降低破綻；前景邊仍須檢查。

**`trail`：同一主體的多個節拍殘影。**

- 在 `b-3` 建第一個 v1、`b-2` 建 v2、`b-1` 建 v3；各自 `start` 不同，`duration` 統一到 `T(b)`。
- 三份 clip 共享 A 的素材 id 與對應時間範圍；圖片無同步問題，影片需為每份 `in` 補起點位移。
- 舊副本 `transform.opacity` 設 0.25/0.45，新副本設 1；可用 `blend:'screen'` 做發亮疊加。
- 每份 `scaleX/Y` 不同，`x/y` 只小幅錯開，讓輪廓仍可辨認。
- `fx-zoomecho` 是單張輸入內部的縮放取樣，可當附加打拍，不能替代三份有不同出現時間的 clip。

**`grid`：分格填滿節奏。**

- v1..v4 各是一份 `aiMatte` A；`scaleX/Y≈0.45`，位置約在 `x/y=±0.23` 的四組組合。
- 由 `b-2` 起每半拍或每拍讓一格 `opacity` 由 0→1；每份保留到 `T(b)`。
- 實際 `x/y` 需按畫幅與素材比例校正；上面的數值只是版型初值。
- `fx-split` 在 shader 裡重採整張輸入，而且格子共用一個 clip，無法獨立逐格進場。
- 如果影像滿版、主體已很大，四份會彼此擋住，應退回 `step`。

**`spin`：繞中心的旋轉複製品。**

- v1..v3 共用 A matte，`rotation` 先取 -15/0/+15 度，再於落點前回到 0。
- 用不同 `x/y` 及 `opacity` 當分身層；不要把 `fx-mirror` 當旋轉複製。
- 若主體 bbox 中心不在畫面中央，現在的變換原點會讓副本沿錯的中心打轉。
- 第一批只允許中心 bbox 合格的圖片；後續加入從 bbox 推出的 x/y 補償。
- `b` 所有分身同時結束，避免最後一幀殘留。

**`fly`：用 clip 變換完成透明進場。**

- 從左進：v1 `keys.x=[newKey(0,-1.1,ease),newKey(S(2),0,ease)]`；右進改正號。
- `scaleX/Y` 同時由 0.75→1.15；`rotation` 由 -12→0，避免只是平移。
- `opacity` 前半拍由 0→1；Bezier 可用 `EASE_PRESETS` 的 `back` 或 `expoOut` 值。
- 若 y 方向飛入，使用 `keys.y`；x/y 量是畫面寬／高的比例，不是像素。
- `fx-entrance` 的 `bg` 為不透明填色，故不能直接作用在透明 cutout 上。

**`shakeFlash`：高能量逐拍刺激。**

- v1 的 `effects` 含兩個 `ClipFx`：`fx-shake` 及 `fx-flash`；各有自己的 `id`、`params`、`timing`。
- `timing:{kind:'beat',every:1,d:0.18}` 會在 clip 範圍內每拍重播，不需要產生多個效果區塊。
- `fx-flash.params.intensity` 先限制在低於模組預設的值；太亮會吃掉 matte 邊界。
- `fx-rgb` 可代替 flash 作較低亮度版本；都只作用在 v1，背景不閃。
- 打拍速度很快時，以拍距裁短 `d`，避免上次 hit 尚未完就開始下一次。

**`crossShot`：主體先跨到下一景。**

- B 必須在 `b-2` 就成為 v0；因此 `shots` 需把 B 的起點提前，或切出 B 的預露段。
- A 的 v1 從 `b-2` 到 `b`，其 `in` 依原 A shot 的來源時間延續，不可把 A 影片重新從 0 播。
- `keys.x` 可做短水平移動，`keys.opacity` 在第一拍 0→1，第二拍保持。
- B 為圖片可固定；B 為影片必須確認提前兩拍仍在媒體可用時間內。
- `b` 只讓 v1 A 結束，v0 B 持續；這是一個「前景撤除」硬切。

**`textBehind`：標題被主體擋住。**

- v0 A 原圖、v1 `makeTextClip(presetId,modules,{start,duration,track:1})`、v2 A matte。
- `makeTextClip` 會補 `DEFAULT_TEXT`；文字內容需要來自標題設定或 AI 導演的短字串。
- 文本放在主體 bbox 後方，不能只放固定中央；若無 bbox，先用使用者選擇的位置。
- `Clip.aiMatte` 尚未就緒時，v2 完整矩形會蓋住 v1 文字，故此款必須等待整個窗口。
- 文字若要留到 B 畫面，v1 的 `duration` 可跨過 `T(b)`；v2 必須在 `T(b)` 結束。

**`silhouetteWindow`：輪廓內是下一鏡。**

- 現有資料只能讓 `aiMatte` 作用在 clip 自己的 `mediaId`；B clip 不能引用 A 的 matte。
- 新欄位可考慮 `matteSource:{mediaId,sourceTime}`，但影片 A/B 每格時間映射須明確。
- v0 A 原圖；v1 B 的 alpha 乘 A 的 matte，畫面只在 A 的輪廓內顯出 B。
- `b-1` 若要輪廓變大，應對 matte 取樣座標／形態膨脹，而不是放大整張 B 畫面。
- `b` 撤除遮罩，B 變完整圖。現有 `Mask.shape` 與 `fx-clipmask` 皆做不到動態 AI 輪廓。

**`subjectHole`：在 A 上挖主體形狀的洞。**

- v0 B 原圖；v1 A 原圖，但 alpha 乘 `1 - matte(A)`，讓 B 從 A 的主體位置露出。
- `Mask.invert=true` 只反轉 rect/ellipse/path 等形狀，並非 `Clip.aiMatte` 的反轉。
- 欄位需區分「保留主體」與「移除主體」，避免 `aiMatte` 布林值承載兩種意義。
- 洞若要逐拍擴大，可在 matte 空間做中心縮放或形態膨脹；須避免外框裁切。
- 洞外仍是 A；`b` v1 結束後畫面完整變成 B，才能完成揭露。

### 3.2 精確度邊界

- 「下一個 frame」應在 `T(b)` 當格硬切。`MusicSource.time` 已 snap 到專案影格，但短窗口仍須檢查 `duration >= 1/60`。
- 對影片 A，複製品應共用同一 `in/rate/remap`；相同來源時間才會讓彩色主體對齊黑白／暗背景。動態圖片亦需同起點。
- `scaleX/Y` 的 1 是素材按 `fit` 的原本顯示尺寸。主體離畫面中心時，階梯放大會向畫面邊緣漂。第一期只收居中主體；第二期以 matte bbox 計算 `x/y` 補償。
- `ClipFx.timing` 的 `d` 是秒，不能誤填拍數。beat 觸發點來自全域 `triggerBeats`，窗口內無拍時不會重播。
- 複製堆疊會增加影片解碼與多個 WebGL pass。先限制同時最多 4 個主體副本；高解析、長影片應偏好單副本。

## 4. 計畫資料與套用路徑

選 `EditPlan.pops`，不擴充 `PlanOverlay`。`PlanOverlay` 的語義是單一 `FxItem`；主體效果同時產生多個 clip、軌道、片段效果與硬切約束。保留 `overlays` 原狀，也較易回放種子與統計。

```ts
interface PlanPop {
  b0: number;                 // 進場窗口起拍
  b1: number;                 // 揭露拍，半開區間 [b0,b1)
  variant: PopVariant;
  subjectMediaId: string;     // A
  revealMediaId: string;      // B；可等於 A
  subjectIn: number;          // A 的素材秒數；圖片為 0
  revealIn: number;           // B 的素材秒數；圖片為 0
  scaleSteps?: number[];      // 依拍逐段；由展開器驗證長度
  direction?: 'left' | 'right' | 'up' | 'down';
  copies?: number;            // grid/trail/spin 有上限
  quality: PopQuality;        // 規劃時的 matte 狀態
}
interface EditPlan {
  seed: number; recipe: string;
  shots: PlanShot[];
  overlays: PlanOverlay[];
  pops: PlanPop[];
}
interface PlanOptions {
  // 現有欄位省略。
  popVariants: PopVariant[];
  popsPer32: number;
}
```

`planEdit` 在 shot 分配後選 drop／build 邊界，再檢查 A/B 是否能覆蓋 `[b0,b1)`。若落點的 B 是下一個 `PlanShot`，沿用它；若 `A=B`，要求來源時間在揭露格連續或明確重置。給 pop 使用的邊界加入 hard cut，並排除同拍的 `dropHit` 過曝組合。選擇用 seed 的既有 `random`，且遵守每 32 拍預算與最小間距（建議 16 拍）。

`planItems` 先展開普通 `PlanShot`，再呼叫純函式 `expandPop(pop, shots, T, media, availableTracks)`：切掉或縮短 pop 窗口中的 v0 shot、建背景與上層複製品、寫 `keys` / `effects`、清除揭露邊界 `transitionIn`。不可直接 append 到原有片段清單，否則同一 v0 軌會重疊且 `computeFrame` 只取其中一段。最後用多軌意圖提交：`add_items` 不可再無條件把所有 clip 改成同一 `vt`；需把相對軌索引映射到新建的連續影片軌，保留其他現有專案軌道與 effects 的 level。輸出 `{ clips, effects }` 的形狀可維持，軌道數可由最大 `clip.track` 推出，但提交時須驗證所有索引及鎖定狀態。

`src/engine/autoEditSettings.ts` 加 `popOff: PopVariant[]`、`popsPer32`，預設只開 `step/mono/fly/shakeFlash`，並加入 reset/history。`src/ui/AutoEditPanel.tsx` 仿 `PickList` 的 `trOff/fxOff` 加「主體跳出」區塊、頻率及每個變種勾選；顯示需要 AI 去背的計算提示與目前可用素材數。`autoEditApply.ts` 的 `planOptions` 將勾選轉成 `popVariants`，不是把它混入 accents。

`src/ai/autoEditTools.ts` 的 `AUTO_EDIT_DECLS` 對 `get_auto_edit` 回傳變種 id、名稱、是否啟用、就緒／待算；`set_auto_edit` 加 `subject_pops: PICK('subject pops')` 及 `pops_per_32`，沿用 `pick` 驗證、`AutoEditPatch` 提議與使用者套用機制。`src/ai/director.ts` 的 `Direction` 可加 `popSuitability?: 0..1`、`popSubject?: 'person'|'object'|'unknown'`、`popMoment?: number[]`。AI 只提供素材語義與候選時刻，最後仍由規則及本機 matte 品質量測決定，不能只憑文字判定輪廓。

## 5. 素材品質門檻與等待策略

`matteCoverage(clip,media,modules,n)` **只回傳各時間段有沒有快取遮罩**，不是主體佔比。品質量測可直接讀 `matteAt(media,t).data`，做成純函式 `scoreMatte(mask: Uint8Array, size=320)`，由 `ensureMatte` 取 1 張圖片或影片窗口的首／中／末 3 張後呼叫。不要把逐格遮罩資料放進 `EditPlan`；只放小型摘要，避免計畫膨脹。

| 指標 | 建議計算 | 初始門檻與用途 |
|---|---|---|
| 面積比 | `mean(mask > 128)`／總像素。 | 建議 0.08–0.65；過小看不見，過大難放大。依版型可調。 |
| bbox 與中心 | 取 `mask > 128` 的最小外框、質心。 | bbox 左右／上下至少留 5% 空間；`step/spin/grid` 再要求中心落在中央 60%。 |
| 貼邊 | 外框 3% 邊帶內的高 alpha 像素比例。 | 高於 2% 先拒絕放大、旋轉、挖洞；可改用 mono。 |
| 邊緣品質 | 在 0.1–0.9 alpha 過渡帶計數，檢查極薄碎片／離散連通域；三張間 bbox IoU。 | 先作保守分級，不宣稱能自動判斷髮絲品質。影片跨格位移過大或閃爍時拒絕。 |
| 可用性 | `matteAt` 是否覆蓋窗口取樣；`useMatte.jobs/errors`。 | `ready/pending/reject`。錯誤或預算逾時退回普通剪接／全畫面 accent。 |

先在素材分析階段對候選 A 呼叫 `ensureMatte` 的少量時間點，計算摘要後再選 pop。若真正使用影片 pop，於展示前準備整個窗口的 `matteFrames`；`prepareMattes` 已處理匯出，但預覽目前會先出現完整矩形。此視覺故障不能靠 `quality:'pending'` 自動消失。第一期預覽只在所需影格全數就緒時啟用 pop；未完成則產生正常 shot／accent 的退回版本。若要生成後非同步升級 pop，需用一次可復原的專案替換，並清楚顯示進度；不要讓 renderer 靜默顯示錯誤畫面。

## 6. 分期

| 階段 | 交付與大小 | 工作性質／驗證 |
|---|---|---|
| 1：可用核心 | `step/mono/fly/shakeFlash`；`PlanPop`、品質摘要、拍點選擇、`expandPop`、多軌 `add_items`。**中**。不改 renderer。 | 大多是純邏輯，適合 Codex + 單元測試：拍索引轉秒、hold key、硬切、來源對齊、軌道映射、無 matte 回退。UI 只加清單與進度。 |
| 2：多層編排 | `crossShot/textBehind/trail/grid/spin/dim`；主體 bbox 中心補償、複製上限、衝突排程。**中**。 | 純邏輯與少量 UI。用可視預覽查 alpha 邊、文字層級和影片時間同步。 |
| 3：新效果模組 | 真正 `fx-matteoutline`、持續 `fx-blur`、alpha-aware glow；完成 `halo/blur`。**中**。 | GLSL 模組與 renderer 合成測試；需檢查 premultiplied alpha。 |
| 4：輪廓反轉 | `silhouetteWindow/subjectHole`；matte source / invert / 膨脹、相容匯出。**大**。 | renderer 與資料模型。用圖片、影片、鏡像、不同 fit、遮罩未就緒場景做視覺驗證。 |
| 5：AI 提示 | 導演候選 pop 主體／時刻；AI 設定工具讀寫。**小～中**。 | AI 提示可晚於規則版；本機品質門檻始終保留。 |

首版成功標準：build 到 drop 的前 4 拍可見主體逐拍長大，落點第一格是完整 B；預覽與匯出同樣對齊；matte 未就緒時不出現上層完整矩形；關掉所有變種時產出與現有自動剪輯一致。

## 7. 第 4 期儲存結構變更提案（已作廢）

狀態：**作廢**（2026-11-23）。改用既有的片段遮罩：把圖片的去背結果描成輪廓路徑，存在片段自己的遮罩（`Mask.path`，跟鋼筆畫的一樣，不進形狀庫），不用新增片段欄位。影片當主體時（每格輪廓不同）才需要下面的欄位，目前不做。以下保留原文備查。

原狀態：提案中。第 2、3、5 期不改儲存結構，已經在做；第 4 期（`silhouetteWindow` 剪影窗、`subjectHole` 主體挖洞）需要在片段上多兩個欄位，會寫進專案檔，照規則先提案。

### 要加的欄位（`Clip`，都是選填）

```ts
interface Clip {
  aiMatte?: boolean;          // 既有：開 AI 去背（白 = 留下）
  /** 新：反轉去背：留下背景、挖掉主體（subjectHole） */
  matteInvert?: boolean;
  /** 新：用另一個素材的去背遮罩（silhouetteWindow：B 只在 A 的主體輪廓裡出現）；沒有 = 用自己的 */
  matteFrom?: string;         // media id（第 4 期只支援圖片）
}
```

### 影響

- **舊專案**：兩個欄位都選填，沒有就是現在的行為，不需要轉換程式碼（也照規則不寫轉換）。
- **繪製**：`renderer.ts` 的 `drawClipRaw` 決定遮罩來源（`matteFrom` 的素材，圖片時間固定 0），shader 加一個 `u_matteInvert`：`col *= invert ? 1 - m : m`。遮罩沒好時照現在的規則先畫原圖並排進背景計算；匯出前 `prepareMattes` 也要算 `matteFrom` 的素材。
- **屬性面板**：AI 去背開著時多兩個選項（反轉、遮罩來源）；介面文字照規則保持短。
- **專案包 / 復原**：欄位跟著片段一起存、一起復原，`.ybeat` 專案包不用改（`matteFrom` 指向的素材本來就在專案裡；素材被刪除時當作沒有）。
- **自動剪輯**：`silhouetteWindow`、`subjectHole` 兩種變化預設關，跟其他種類一樣可以在面板開關。

### 要你決定

1. 同意加這兩個欄位嗎？
2. 反轉 / 遮罩來源要不要也放進屬性面板讓手動剪輯用（建議要，成本很小）？
