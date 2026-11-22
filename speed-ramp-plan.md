# 節拍變速與倒抽：自動剪輯設計案

**範圍：**延伸自動剪輯的影片片段變速。速度峰值、停頓、倒抽與回正須對齊節拍及剪接點；本文只規劃，不改程式。以下「拍」均指配樂時間軸的拍，不是素材的拍。

## 1. 已核對的能力與限制

| 能力 | 目前用法與檔案 | 對 velocity edit 的結論 |
|---|---|---|
| 片段資料 | `src/store.ts` 的 `Clip.remap = {moduleId, params, keys?}`、`in`、`duration`、`rate`；`makeClip` 預設 `remap-speed` | 計畫套用時可直接產生 `remap-curve` keys，無須變更專案的片段格式；自動剪輯目前尚未設定 remap。 |
| 時間映射 | `src/engine/remap.ts` 的 `clipSource` 將片段 local time 映至素材秒數；曲線模式算 `in + evalKeys(keys, local)`，並以 1/60 秒差分估計播放速率 | keys 的 `t` 是片段內秒數，`v` 是**相對 `in` 的素材秒數**。斜率正／負／零分別是正播／倒播／定格；不要求單調。素材時間最後會夾在 `[0, media.duration - 0.02]`。 |
| 一般模組路徑 | `clipSource` 對模組呼叫 `remap(local * clip.rate, params, {dur: clip.duration * rate, srcDur, in})`，再加 `clip.in` | 曲線 keys 路徑不乘 `clip.rate`。產生的曲線片段應固定 `rate: 1`；不能把已由 keys 表示的速度再當作一般模組速率處理。 |
| 自訂曲線 | `src/engine/remapCurve.ts` 的 `CurvePoint=[t,v,ease]` 為相對片長的比例，`curveToKeys` 展開成秒；`evalCurve`／`evalKeys` 用每段起點的 cubic Bezier 或 `hold` | 可表達任意**分段素材時間曲線**，包括下降段。它不是直接編輯速度函數；要由速度積分成位置 keys。極端 Bezier 控制點可造成過衝與短暫反向，產生器須約束。 |
| 曲線預設 | `src/modules/builtin.ts` 的 `curvePreset`／`remapFor` (`src/store.ts`) 將內建預設轉為 `remap-curve` keys | 預設以**片段比例**佈點，不知道音樂拍點；velocity edit 應按 `MusicSource.time(i)` 寫絕對秒數 keys。`remapFor` 只以正向最高值與 `avail` 壓縮，無法替負偏移、跨內部 cut 或品質做完整檢查。 |
| `remap-speed` | `src/modules/builtin.ts`：`speed` 0.1–8；`reverse` 將 `dur * speed - t * speed` | 只能常速正播或倒播。`plainSpeed` (`remap.ts`) 僅對非倒播的此模組回傳速率，其他 remap 回 `null`。 |
| `remap-strobe` | `builtin.ts`：`floor(t * fps)/fps * speed`，`fps` 1–30、`speed` 0.1–4 | 是固定抽幀，不是按 1/2、1/4 拍重複同一小段；節拍 stutter 要生成 keys。 |
| `remap-pingpong` | `builtin.ts`：正播至片長 0.5 處，再倒回起點；兩段 Bezier | 能倒抽，但翻轉點不在指定拍，且兩半的時間與素材位移相同；不能直接做「最後兩拍突然加速倒抽」。 |
| `remap-reverse-forward` | `builtin.ts`：由相對 `in` 的 0.5 倍片長倒回 0，再正播回原點 | 可作 B 片段先倒播後正播的基底；回正點固定在片長一半。 |
| `remap-boomerang` | `builtin.ts`：0→0.4→0.15→0.6（均為片長比例的素材位移） | 已有正／倒／正的形狀，但拍點和幅度固定；節拍版須重新生成 keys。 |
| `remap-ramp` | `builtin.ts`：0→0.9（片長 0.3）→1.02（0.7）→1.92（1）；各段 Bezier | 快→慢→快的現成示例；預設最高消耗 1.92 倍片長素材，不會自動落在 beat hit 上。 |
| `remap-easein/out` | `builtin.ts`：0→1，分別用漸快／漸慢 Bezier | 只有整段單向速度變化；無每拍峰值，也無倒播。 |
| `remap-freeze` | `builtin.ts`：0→0.4，在片長 0.4–0.6 保持 0.4，末尾到 0.8 | 能定格；`hold` 若兩端值不一致會跳來源時間，應只在刻意 stutter 時使用。 |
| 影片預覽 | `src/engine/renderer.ts` 的 `drawClipRaw` 每格呼叫 `clipSource`；`syncVideo` 在速率 0.0625–16 時用 `<video>.playbackRate` 並校正漂移，其餘暫停後設定 `currentTime` | 正向平滑變速可用原生播放，但速率跳變需不斷調 `playbackRate`，大漂移會 seek。負速、近零速與極快段逐格 seek；倒播預覽有明確卡頓風險。 |
| 預覽快取 | `src/engine/scrubCache.ts` 的 `scrubFrameAt` 最多 480 張、至少每 0.25 秒一張、高 200px；`renderer.drawClipRaw` 僅在**暫停拖曳**且精確格落後時使用 | 不能作為播放中平滑短倒播的影格快取。長 GOP／4K 的反覆反向 seek 會看到舊格、停頓或跳格；影片貼圖在 seek 中保留上一格。 |
| 預讀與共用 | `renderer.updateChains`、`manageVideos` 只對 `plainSpeed` 常速片段做連續播放串接與提前原生預播；曲線片段只提前 seek 起點 | 曲線片段在剪接點的解碼啟動較脆弱；轉場同時要讀 A/B 時可能更慢。 |
| 匯出 | `src/engine/exporter.ts` 的 `exportMp4` 逐格呼叫 `renderer.prepareExact`、`render`、`VideoEncoder.encode`；`prepareExact` 依來源秒數對 `<video>` seek，`waitEvent` 有 4 秒 timeout | 匯出按時間軸逐格產生，倒播不因即時時鐘而掉格；但每個反向格可能重新解碼 GOP，匯出很慢。timeout 解決等待卡死，不是保證已取得正確影格；須實測並處理失敗。WebCodecs 在此是**編碼**，未見反向用的 `VideoDecoder` 快取。 |
| 音訊 | `src/engine/audio.ts` 的 `audioPlan` 對影片原音只接受 `plainSpeed`；變速時 `stretch.ts` 處理可用的正向常速保音高 | `autoEditApply.planItems` 已用 `makeClip(... volume: 0)`；曲線／倒播影片不會有原音，配樂仍是獨立音訊。若另有連結／分離的音訊片段，需保持原有規則，不能宣稱其會自動倒播。 |
| 素材分析 | `src/engine/mediaAnalysis.ts` 的 `MediaInfo {step,duration,motion,quality,cuts}`、`bestIn`、`scoreWindow` | `bestIn(info,dur,wantMotion,avoid,rng,highlights)` 可選連續來源窗口，優先避開 `cuts`；若找不到，會**退回忽略 cuts**，velocity edit 應在此之後再嚴格驗證，不可直接接受回傳值。 |
| 編排與套用 | `src/engine/autoEdit.ts` 的 `PlanShot {b0,b1,mediaId,in,motion?,transition?}`、`planEdit`；`src/engine/autoEditApply.ts` 的 `planFor`／`planItems` | 現有 `planEdit` 以原本片長挑 `in`，`planItems` 再以 `media.duration - duration` 夾住，對快轉消耗更多來源或倒播需要前置素材均不足；需連動改窗口計算與夾值。 |
| 面板與能量 | `src/engine/autoEditSettings.ts` 的 `popOn/popVariants/popsPer32`，`src/ui/AutoEditPanel.tsx` 的主開關與 `SegToggles`；`src/engine/energyShape.ts` 的 `shapeMusic` | 可比照主體跳出加主開關／變種／每 32 拍上限。`shapeMusic` 改 `energy/level/sections.energy`，但保留 drops、accents、段落邊界；選型用變形後能量，拍點仍用原節拍。 |
| AI 設定 | `src/ai/autoEditTools.ts` 的 `AUTO_EDIT_DECLS`、`readAutoEdit`、`parseAutoEditArgs`／`AutoEditPatch` | 增加可讀回、可驗證的 `speed_ramps` 欄位；AI 只能調面板設定，不應提供任意 JS remap 程式碼。 |

### 1.1 記號與共用曲線

令 `T(i)=MusicSource.time(i)`，片段 `[b0,b1)` 的 local beat knot 為 `τᵢ=T(i)-T(b0)`，`D=τ_b1`；`u(t)=clipSource.src(t)-clip.in` 是來源相對秒數，`v(t)=du/dt` 是播放速率。表中的 `q` 是實際相鄰拍長，不能假設 BPM 固定；半拍使用兩個實際 beat time 的內插。

產生曲線時，先選每段速率輪廓 `v(t)`，以 `u(t)=u(0)+∫₀ᵗv(x)dx` 求來源位置，再把拍點、峰值和轉向點寫成 `newKey(τ,u,ease)`。線性 ease `[0,0,1,1]` 給固定斜率；平滑 ramp 可用單調 Bezier，必要時增加中間 knots 近似積分。`hold` 只用於相同 `u` 的定格段或有意跳格的 stutter。若兩段要在拍點「速度峰值」連續，端點相同還不夠，需讓左右導數接近；一般 Bezier 預設不保證此事。

## 2. 共用展開規則

1. 先由既有 `planEdit` 決定 shot、hard cut、轉場；之後用獨立 seed 選 velocity 事件，以免開關變速改變原本片段順序。短 shot、圖片、缺影片或與 pop 的揭露窗口衝突者跳過。
2. 選型以變形後的 `music.level`、`sections.energy/kind` 和 drops 為主；`MediaInfo.motion` 只是一段取樣差分，不能當精確光流。高動態偏向清楚可見的短 slow-mo，中動態偏向 ramp；低動態可用 freeze／輕微 ramp，避免在無動作素材上做倒抽。
3. 先計算整條 `u(t)` 的 `u_min/u_max`，再選 `in`。對任一格均須 `0 ≤ in+u(t) ≤ media.duration-0.02`；合法起點是 `[-u_min, media.duration-0.02-u_max]`。負的 `u_min` 代表需保留倒播前的來源素材；只檢查片段首尾不夠。
4. 把來源實際消耗窗口 `W=u_max-u_min` 傳給 `bestIn`，取得窗口起點 `w0` 後設 `shot.in=w0-u_min`，不要再用 wall duration 夾 `in`。如果沿用舊 `PlanShot.in` 作選段中心，可搜尋其附近合法 `w0`；每次都驗證整條曲線。
5. 對 `[w0,w0+W]` 加上取樣／seek 容差（例如至少一個來源格，或 `MediaInfo.step/2`），嚴格拒絕跨 `MediaInfo.cuts`。`bestIn` 退回忽略 cuts 的結果要再檢查；若沒有安全窗口，降級為較小速率／較短倒抽／常速 shot。
6. 來源區域的 `usedVideo` 應記錄實際 `[w0,w0+W]`，而非 wall duration；`scoreWindow` 的畫質、運動量與 highlights 也要看同一窗口。分析關閉或 `info` 缺失時，至少做上下界檢查，並限制到正向保守變種。
7. 對轉場，`PlanShot.transition` 屬於 B，`planItems` 在 B 片段設 `transitionIn`；倒抽跨剪接點應分別生成 A 的尾段與 B 的頭段，兩者的 `τ` 都從各自 clip 起點算。視覺 hit 要看 `renderer.transitionWindow` 的實際混合窗口，不能假設轉場第一格就是硬切。
8. 曲線的拍點要用 `T` 換成秒，最後 `planItems` 設 `c.remap={moduleId:'remap-curve',params:{},keys}` 並保持 `rate=1`、`volume=0`。生成後用 `clipSource` 在拍點、轉向點、端點與兩側採樣檢查，確保無素材邊界夾住造成的假定格。

## 3. 變種目錄

下表的 `a,c,h,r` 均由事件強度與實際拍長決定，並受品質門檻約束；「曲線」指產生 `remap-curve` keys。難度含規劃與驗證，不代表預覽性能已達標。

| 變種 | 拍點與 `u(t)`／速度形狀 | 既有表達／缺口 | 選用條件與規模 |
|---|---|---|---|
| `beatPulse` 每拍慢快慢 | 每拍 `[T(i),T(i+1)]` 以半拍為中心：`v(t)=v_s+(v_h-v_s)·tri((t-T(i))/q)`，峰在半拍或依重音移到拍點前；`u=∫v`，相鄰拍面積受限 | 曲線可做；`remap-ramp` 只有整段一次快慢快，不對拍。需積分／導數連續的 keys 生成器 | 中高能量、可見運動、連續 2–4 拍；中。預設唯一開啟變種，強度先小。 |
| `hitRamp` 衝入剪接 | A 最後一拍 `v=v_s+(v_h-v_s)E((t-T(b-1))/q)`，`u=∫v`；`v_h` 峰在 cut `T(b)`，B 從合法來源點正播 | 曲線＋現有 hard cut；`remap-easein` 有形狀但非拍點／來源長度；需檢查 A 尾端素材 | build→drop、硬切或 `tr-flash`，中高 motion；小。 |
| `slowPocket` 拍間慢動作 | 在兩個 hit 中間 `v=v_s`、hit 附近短窗 `v_h`，以平滑接頭，滿足 `∫v` 的素材窗口；不作全段固定慢速 | 曲線可做；`remap-speed` 不足；需限低速可解碼與避免長時間重複格 | 中能量 body、有明顯連續動作；中。 |
| `rewindToCut` 剪前倒抽 | A 前段正向 `u↑`；在 `T(b-r)` 達 `u_p`，末 `r=1–2` 拍 `u(t)=u_p-a·E((t-T(b-r))/(T(b)-T(b-r)))`，且倒抽最快點靠近 cut | `remap-pingpong` 有正倒兩段但固定比例；曲線可做。需負速預覽／大量反向 seek | drop 前、明顯 whip/flash 轉場、動作乾淨且來源窗口無 cut；大。 |
| `reverseForwardB` 轉場後回正 | B 開頭來源從 `u=h` 倒到 `u=0`，在指定 `T(b+1)` 回正，再積分正向 `v(t)`；轉向點速率須接近 0，接著在下拍加速 | `remap-reverse-forward` 形狀可用但中點固定；曲線可按拍定位。需 B 起點前後充足來源與轉場雙解碼 | drop／段落開頭，`tr-zoomblur`／`tr-whip`，高 motion；大。 |
| `rewindReturn` A 內正倒正 | `u(τ₀)=0 → u(τ₁)=a → u(τ₂)=a-r → u(τ₃)=a-r+f`，轉向點壓在連續拍上；倒抽段可比正向短而快 | `remap-boomerang` 有同類三段但固定 0.4/0.55 比例；需拍點 keys／來源檢查 | 高能量、長於 3 拍的 shot，局部動作反覆有辨識度；大。 |
| `tapeStop` drop 停帶 | cut/drop 前 `v(t)=v₀(1-E(x))` 減到 0；最後 `u` 保持常數 1/4–1/2 拍，B 在 drop 正播 | `remap-freeze`／曲線可做；現有音訊不跟影片停帶，若需配樂停帶須獨立音訊設計 | drop 前短暫留白、低至中 motion；中。 |
| `holdHit` 擊點定格 | `u` 正向至 `T(b)`，`[T(b),T(b+1/2)]` 固定 `u_b`，再平滑追上；不得用不同值的 hold 製造無意跳格 | `remap-freeze` 可示範，曲線按拍展開；需確保後段來源消耗和速率上限 | 重音、人物姿勢／物件輪廓清楚；小。 |
| `beatStutter` 半／四拍切片重複 | 選一段長 `δ=q/4` 的來源：每個子拍 `u(t)=u₀+v·((t-t₀) mod δ)`，邊界刻意跳回 `u₀`；最後在 beat cut 離開 | `remap-strobe` 只抽格；曲線需每個子拍一組重置 keys，`hold`／同時刻 keys 的排序和 jump 行為須明定 | 高能量、glitch/flash、最多 1–2 拍；中，預覽高風險。 |
| `beatBoomerang` 逐拍短倒抽 | 每拍 `u₀→u₀+a→u₀+a-r→u₀+a-r+f`；轉向點設在 1/2、3/4 拍，下一拍正向接續 | `remap-boomerang` 單次固定形狀；曲線需逐拍平移與連續端點 | hype／drop 後動作密集短片段；大，先列實驗。 |
| `whooshRamp` 甩鏡加速 | A 的最後半拍 `v` 平滑由 1 上升到 `v_h`，在 `T(b)` 與 `tr-whip`／`tr-zoomblur` 的視覺峰相遇；B 從中速回落 | 曲線＋既有轉場。需以 `transitionWindow` 定位混合峰，並檢查雙片段來源窗口 | 高能量、運動方向吻合、已選甩鏡／變焦轉場；中。 |
| `lowEnergyDrift` 低能量緩速 | 4–8 拍 `v(t)=v_l+ε·E(t/D)`，`0<v_l<1`；`u=∫v`，維持微動且不在每拍做峰值 | `remap-easeout` 可近似但固定整段端點；曲線可精確配 `energy` | intro／break／低能量、平穩有動作畫面；小。 |

### 3.1 各變種的拍點設計細節

**`beatPulse`：**

- 以一個 hit 拍 `h` 為中心，設 `T(h)-q/4`、`T(h)`、`T(h)+q/4` 三個速率控制點；hit 上為局部最高速，兩側返回較低速。
- 若 shot 只有一拍，只用一次峰值；若連續多拍，每拍的面積按來源可用長度縮放，避免累積到素材尾端。
- 產生器應以每段線性速率積分為二次 `u(t)`，再用 2–3 個位置 keys 近似，而不是把「速度數字」直接塞進 `Keyframe.v`。

**`hitRamp`：**

- 最後一拍的起點已有來源位置 `u₀`；終點 `u₁=u₀+∫v`，並讓 cut 前一個輸出格達到最高正速。
- B 的第一格使用自己的 `in`，不必與 A 的來源位置連續；視覺連續由轉場或相似動作提供。
- 硬切可直接打在 `T(b)`；若有轉場，須將 hit 對準視覺主畫面真正換手的一格。

**`slowPocket`：**

- 讓重音之間停留在 0.4–0.7 倍速，重音附近以短暫 1.2–2 倍速補回來源位移。
- 慢段至少需展示數個不同的來源格；不足時改用 `holdHit`，避免看起來像無意卡頓。
- `MediaInfo.motion` 高但畫質低的素材，慢動作會放大壓縮瑕疵，應換成短 `hitRamp`。

**`rewindToCut`：**

- A 在倒抽起點前保持正向；最後 1–2 拍先減速至零，接著讓負速幅度增大，cut 前達到短促回捲峰值。
- `u_min` 未必在片段起點；若末尾回捲超過起點，`shot.in` 必須往來源後方移，留下前置素材。
- 優先搭配有遮擋或高動態的 cut；靜態場景的重複畫面容易顯得像播放錯誤。

**`reverseForwardB`：**

- B 的第一格取自來源較後方，第一拍回捲至較早的影格，在回正拍速度接近零，下一拍迅速正向離開。
- 若 A/B 使用同一來源也仍需各自驗證窗口；若 B 的回正點落在素材自己的 cut，整個事件取消。
- 進場轉場期間 A、B 可能同時被渲染，負速 B 的預覽成本會與 A 的解碼成本疊加。

**`rewindReturn`：**

- 在 `τ₁`、`τ₂` 兩個轉向拍附近先降速至零，再反向／回正；若用線性斜率直接換號，會形成突兀的速度跳變。
- 片段至少 3–4 拍，且每段有足夠來源格；三段都太短時回退為單次 `beatPulse`。
- 若想在 cut 前結束，第三段端點須在 cut 的前一格，不讓最後一格因 clamp 而定格。

**`tapeStop`：**

- 用 1/2–1 拍減速至零，在 drop 前短暫停住；真正 drop 播放 B 的新來源影格。
- 只有影片速度停住。若設計要求音樂也做 tape-stop，需另行編排獨立配樂音訊，不能用影片 remap 假裝達成。
- 定格格優先選清晰、主體可辨的來源時間；若該格接近來源 cut，改用較早的一格。

**`holdHit`：**

- 在重音 `T(h)` 抵達有辨識度的 pose，平坦的 `u(t)=u_h` 覆蓋 1/4–1/2 拍。
- 平段結束後用有限正速恢復，不要用 `hold` 直接跳到更後面的來源位置。
- 人物特寫與清晰姿勢較適合；運鏡模糊格的定格需要品質分數先過關。

**`beatStutter`：**

- 重複單元用 `q/2` 或 `q/4`；每次重複都從相同 `u₀` 重新正播到 `u₀+δv`，在子拍邊界刻意跳回。
- 在 keys 中以邊界前後相差一個極小時間的兩個值表示跳回，避免同時刻 keys 的排序歧義。
- 限制 2–4 次重複並檢查每次至少跨數個來源格；無法滿足時改用 `remap-strobe` 的抽幀感，但不宣稱它是重播。

**`beatBoomerang`：**

- 每拍的正、倒、正三段來源位移不必相等；確保拍尾值與下一拍起點相等，避免非刻意跳格。
- 轉向點若密到只有 1–2 個輸出格，縮小重複拍數，不要硬塞完整三段。
- 該變種與逐拍 `fx-zoompulse` 可對齊，但視覺與解碼負擔相加，應有獨立頻率上限。

**`whooshRamp`：**

- `tr-whip` 的方向與素材畫面動作方向若未知，只採短的正向速度峰；有可信動作向量後再偏好方向一致的素材。
- 混合轉場不是硬切：`T(b)` 可能是轉場窗口起點或另一位置，須由 `transitionWindow` 的結果決定 hit 的有效畫面時間。
- A 末端與 B 起端都需合法來源窗口；缺一端就保留原轉場與常速。

**`lowEnergyDrift`：**

- 速度維持正值且緩慢變化，4–8 拍只做一次弧線；不強迫每拍都產生峰值。
- 來源總消耗小於 wall duration，因此 `bestIn` 可以搜尋更短窗口；仍需避開內部 cut。
- 低能量 section 若影片運動近零，維持常速或改用圖片 Ken Burns，避免無意義的 0.5 倍慢放。

### 3.2 變種品質邊界

- 預設只開 `beatPulse`，且限制為正速、溫和速率（起始建議約 0.5–2 倍）與有限次數；其餘由使用者開啟後才選。這避免在尚無反向影格快取時讓預設預覽顯著卡頓。
- 倒播、`beatStutter` 與極短定格要有**來源幀數**門檻：若有效移動小於 2–3 個來源格，只會看到同格反覆；`MediaProbe.fps` (`src/engine/mediaInfo.ts`) 可作估算，但可能缺值，未知時採保守門檻。
- 曲線的連續段限定 `u` 在兩端間單調，除明確設計的轉向；限制速率、加速度與一次事件的反向 seek 次數。`back` 型 Bezier 可能過衝，不作預設速度接頭。
- 同一 shot 最多一個主要速度事件，冷卻至少 4–8 拍；`PlanPop` 揭露前窗口、短 shot、素材 cut 附近、片段轉場端點要互斥或明確協調。速度峰值對齊視覺 hit，不能僅對齊 `PlanShot.b1` 數字。
- 若 `MediaInfo` 的 `motion` 低、品質差、cut 密集或未分析，不選倒播；`bestIn` 的 fallback 若跨 cut 就降級。缺少真正光流／動作方向分析時，不承諾「甩鏡方向相配」。
- `renderer.syncVideo` 正速上限為 16、下限為 0.0625，但這是播放機制閾值，不是品質承諾。第一期預設上限應遠低於 16；快於來源 fps 可自然跳格，慢速只能重複格，沒有光流補幀。
- 匯出驗收需逐格比對來源時間與輸出畫面。`prepareExact` 的 `waitEvent` timeout 可能讓過慢 seek 後沿用舊畫面；現階段不能以「已呼叫 prepareExact」作正確性保證。

## 4. 計畫資料與套用路徑

```ts
type SpeedVariant = 'beatPulse' | 'hitRamp' | 'slowPocket' | 'rewindToCut'
  | 'reverseForwardB' | 'rewindReturn' | 'tapeStop' | 'holdHit'
  | 'beatStutter' | 'beatBoomerang' | 'whooshRamp' | 'lowEnergyDrift';
interface PlanSpeed {
  variant: SpeedVariant;
  // 拍號可為小數；source 是相對 shot.in 的素材秒數，不是速度。
  knots: { beat: number; source: number; ease: 'hold' | [number, number, number, number] }[];
  sourceMin: number; sourceMax: number; // 選段／品質驗證用，可由 knots 與段內極值重算
}
interface PlanShot {
  b0: number; b1: number; mediaId: string; in: number;
  speed?: PlanSpeed;
  // 既有 motion、transition 欄位保留
}
interface PlanOptions {
  speed?: { variants: SpeedVariant[]; per32: number; intensity: number };
}
```

`knots.beat` 用全域拍號含小數，經 `T` 的分段線性內插轉成 `newKey(T(beat)-T(b0), source, ease)`。計畫保存來源**位置**而非瞬時速率，與 `Clip.remap.keys` 完全對應；`sourceMin/Max` 只作可讀快取，套用前仍重算含 Bezier 過衝的極值。若未來要讓計畫可跨節拍分析版本重播，需同時保存 beat grid 版本或直接存秒數，目前 `EditPlan` 是一次生成的一次性結果。

`planEdit` 的 shot 選段流程先以目前算法得到影片候選，再對符合條件的 shot 產生 `PlanSpeed`，重新用真實 `W` 尋找來源窗口；若候選影片無合法窗口，先縮小曲線，仍不合法就把 `speed` 移除。`usedVideo` 必須在速度確定後才登記，否則後面 shot 會避錯範圍。若速度設計牽涉 A/B，兩個 `PlanShot.speed` 應作同一事件原子驗證；任一端失敗就兩端退回一般剪接。

`planItems` 先將 `sh.in` 當已驗證的素材基點，曲線片段不可再用現有 `media.duration-duration` 夾值；建 `Clip` 後把 `speed.knots` 轉為 `remap-curve` keys。缺模組／無 keys／來源窗口不合法時，回退原本常速 `makeClip`。`transitionIn` 仍以原有 `sh.transition` 轉成秒數；若速度事件指定硬切，規劃階段要取消互斥的轉場，不在套用階段偷偷換。

`AutoEditSettings` 建議加 `speedOn`、`speedVariants`、`speedsPer32`、`speedIntensity`。`AutoEditPanel.tsx` 比照主體跳出：主開關、12 個變種開關與次數／強度；初始 `speedOn=true`、`speedVariants=['beatPulse']`，倒播選項旁提示「高解析或長 GOP 預覽可能卡頓」。`planOptions` 只送已啟用變種，並與目前影片分析開關協調：分析關閉時禁用需避內部 cut 的倒播變種。

`AUTO_EDIT_DECLS` 的 `get_auto_edit` 回報 `{speed_ramps:{on,variants,per_32,intensity}}`；`set_auto_edit` 同名欄位提供固定 enum、數字邊界與未知值拒絕，`parseAutoEditArgs` 轉成 `AutoEditPatch`，沿用目前「使用者按 Apply 才套用」路徑。AI 只選變種與強度，曲線由確定性規劃器生成，避免 AI 提供無效／越界 keys。

`shapeMusic` 已在 `runAutoEdit` 的規劃前執行；速度事件應使用其 `energy/level/sections.energy` 決定密度與強度，保持原 `drops/accents/sections.b0,b1` 的節拍位置。能量曲線調低後應減少高強度倒抽；調高時也不能跳過來源與解碼門檻。與主體跳出、特效點綴分別使用獨立亂數和事件預算，避免調整速度開關使既有剪接與主體跳出重排。

## 5. 素材品質門檻與驗收

| 關卡 | 檢查 | 不通過時 |
|---|---|---|
| 範圍 | `u_min/u_max` 含 Bezier 內部極值；`in+u` 落在 `[0,duration-0.02]`，轉向前後均有可用素材 | 縮小幅度或改常速；不可依賴 `clipSource` 夾值。 |
| 內部剪接 | `MediaInfo.cuts` 不落在來源窗口及容差內；`bestIn` fallback 再驗證 | 換窗口、換素材、改安全變種。 |
| 畫質與運動 | `scoreWindow`／`MediaInfo.quality/motion` 在真正來源窗口評分；慢動作需足夠來源格 | 降低強度，低運動畫面改 `lowEnergyDrift`／常速。 |
| 節拍 | beat、半拍、drop、cut 對應 `T` 後的 frame grid；檢查峰值與轉向點容差 ≤ 一個輸出格 | 重算 keys 或不選。 |
| 曲線 | 有限值、時間遞增、合法 Bezier x 控制點、預期的速度符號、速率／加速度界、非刻意 jump 為零 | 回退常速。 |
| 預覽 | 普通 H.264、長 GOP、4K、同時 A/B 轉場；記錄倒播段實際顯示格與播放頭差距 | 未達標的變種保留手動開啟或待 decode 工作。 |
| 匯出 | 30/60 fps 逐格核對畫面來源時間；反向、停頓、轉向、轉場邊界；timeout 時須顯式失敗／重試 | 不視為可交付的自動變種。 |
| 音訊 | 自動生成影片 `volume=0`，獨立配樂連續且落在原拍點；連結音訊不被默默反向 | 修正套用規則或跳過該素材。 |

## 6. 分期

| 階段 | 交付與對應變種 | 必要工作／驗收 |
|---|---|---|
| 1：無解碼變更 | `beatPulse`、保守 `hitRamp`、`lowEnergyDrift`、短 `holdHit`；預設只開 `beatPulse` | 純邏輯：beat→key 積分、選段窗口、cut 檢查、`PlanSpeed`、`planItems`、面板／AI 欄位。Codex 可先做確定性規劃與邊界測試：變 BPM、極短 shot、來源尾端、cut、能量曲線、seed 穩定性、聲音保持靜音。 |
| 2：可選的高風格變種 | `slowPocket`、`tapeStop`、`whooshRamp`、`beatStutter`；`rewindToCut`／`reverseForwardB` 可作實驗開關 | 測 `syncVideo` 在密集速率變化時的漂移和轉場雙 seek；匯出對 timeout 顯式錯誤。重複小片段若 seek 過多需限制次數。 |
| 3：反向解碼 | `rewindToCut`、`reverseForwardB`、`rewindReturn`、`beatBoomerang` 正式開放 | 在事件來源窗口預解碼**全解析可用的短影格序列**，依 PTS 索引正反取格、限制記憶體並作 LRU／取消機制；預覽與匯出共用或各自驗證一致性。長 GOP、4K、兩素材轉場與不同 fps 都需壓力測試；若採 WebCodecs `VideoDecoder`，需處理容器解封裝、關鍵影格起點與解碼順序。 |

第一期的純邏輯測試應直接驗證 `clipSource` 在每個事件的正向／零速／反向區段、素材窗口和 beat hit；這些測試比只比對 key 陣列更能抓出曲線方向或 `in` 的錯誤。即使邏輯通過，反向變種仍以解碼驗收結果決定預設與正式上線時機。
