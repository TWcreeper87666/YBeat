/**
 * 自動剪輯的套用端：時間軸上的音樂 → 分析 → planEdit → 換成秒數 → Proposal（add_items，一步復原）。
 * 計畫本身（拍號）由 autoEdit.ts 產生；這裡只負責拍號 ↔ 時間軸秒數、片段 / 特效方塊的細節。
 */
import { attachedAudioIds, makeClip, uid, useStore, type AudioClip, type Clip, type FxItem, type Media } from '../store';
import { beatSource, mediaBeats, type Beat } from './beats';
import { getAudioBuffer } from './audio';
import { analyzeMusic, bandEnvelopes, type Bands, type MusicInfo } from './musicAnalysis';
import { DEFAULT_OPTIONS, planEdit, type EditPlan, type PlanMedia, type PlanOptions, type Recipe } from './autoEdit';
import { footage, musicClips, useAutoEdit, type AutoEditSettings } from './autoEditSettings';
import { $t } from '../i18n';
import { setBusy, toast } from '../ui/uiStore';
import { sampleAll, type Sampled } from './mediaSampler';
import { shapeMusic } from './energyShape';
import { directMedia } from '../ai/director';
import { useAiSettings } from '../ai/assistant';
export { useAutoEdit, type AutoEditSettings };
import { accentOpt, comboAccentOpt, transitionOpt } from './autoEditPools';
import { fxCombo, usePrefs } from '../prefs';
import { newKey } from './keyframes';
import { isHitFx, parseDuration } from './params';
import { snapFrame } from './rulerTicks';
import { applyProposals, type Proposal } from '../ai/projectTools';
import { beginHistoryTransaction, docChanged, endHistoryTransaction, snapshotDoc, type HistoryDoc } from './history';
import { beatLead } from '../ui/beatGrid';

type S = ReturnType<typeof useStore.getState>;

export { footage, musicClips };

export interface MusicSource {
  audio: AudioClip;
  media: Media;
  /** 片段範圍內的節拍（素材秒數） */
  beats: Beat[];
  /** 第 i 拍在時間軸上的秒數；0 = 片段開頭、beats.length = 片段結尾 */
  time: (i: number) => number;
}

export function musicSource(s: S, audioId: string): MusicSource | null {
  const audio = s.audios.find((a) => a.id === audioId);
  const media = audio && s.media.find((m) => m.id === audio.mediaId);
  const info = mediaBeats(media);
  if (!audio || !media || !info) return null;
  const rate = audio.rate || 1;
  const end = audio.in + audio.duration * rate;
  const beats = info.beats.filter((b) => b.t >= audio.in - 1e-6 && b.t < end);
  if (beats.length < 8) return null;
  const lead = beatLead();
  const t0 = audio.start, t1 = audio.start + audio.duration;
  const raw = beats.map((b, i) => (i === 0 ? t0 : snapFrame(audio.start + (b.t - audio.in) / rate - lead)));
  // 保證遞增（對齊格線後可能撞在一起）
  for (let i = 1; i < raw.length; i++) raw[i] = Math.max(raw[i], raw[i - 1] + 1 / 60);
  const time = (i: number) => (i <= 0 ? t0 : i >= raw.length ? t1 : Math.min(raw[i], t1));
  return { audio, media, beats, time };
}

const bandCache = new WeakMap<AudioBuffer, Bands>();
async function bandsOf(m: Media): Promise<Bands | undefined> {
  const buf = await getAudioBuffer(m.url).catch(() => null);
  if (!buf) return undefined;
  let b = bandCache.get(buf);
  if (!b) {
    const n = buf.length;
    const mono = new Float32Array(n);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < n; i++) mono[i] += d[i] / buf.numberOfChannels;
    }
    b = bandEnvelopes(mono, buf.sampleRate);
    bandCache.set(buf, b);
  }
  return b;
}

const musicCache = new Map<string, MusicInfo>();
export async function analyzeSource(src: MusicSource): Promise<MusicInfo> {
  const key = `${src.media.id}:${src.beats[0].t}:${src.beats.length}`;
  const hit = musicCache.get(key);
  if (hit) {
    if (useAutoEdit.getState().analysis?.info !== hit) useAutoEdit.getState().set({ analysis: { audioId: src.audio.id, info: hit } });
    return hit;
  }
  const bands = await bandsOf(src.media);
  const info = analyzeMusic(src.beats, src.media.peaks ?? [], src.media.peaksPerSec || 100, bands);
  musicCache.set(key, info);
  useAutoEdit.getState().set({ analysis: { audioId: src.audio.id, info } });
  return info;
}

export function planFor(src: MusicSource, music: MusicInfo, media: Media[], recipe: Recipe, seed: number, options: PlanOptions = DEFAULT_OPTIONS, range?: [number, number], extra?: Map<string, Partial<PlanMedia>>): EditPlan {
  const n = src.beats.length;
  const pm: PlanMedia[] = media.map((m) => ({ ...extra?.get(m.id), id: m.id, kind: m.kind === 'video' ? 'video' : 'image', duration: m.kind === 'video' ? m.duration : Infinity }));
  return planEdit({ beats: src.beats.map((b, i) => ({ t: src.time(i), down: b.down })), music, media: pm, recipe, seed, options, range: range ?? [0, n] });
}

/** 時間範圍 → 拍號範圍（頭尾各取範圍內最近的一拍；範圍蓋到片段頭尾就用片段頭尾） */
export function beatRange(src: MusicSource, a: number, b: number): [number, number] | null {
  const n = src.beats.length;
  let b0 = 0;
  while (b0 < n && src.time(b0) < a - 1e-6) b0++;
  let b1 = n;
  while (b1 > b0 && src.time(b1) > b + 1e-6) b1--;
  return b1 - b0 >= 1 ? [b0, b1] : null;
}

/** 計畫 → 片段與特效方塊（時間軸秒數） */
export function planItems(plan: EditPlan, src: MusicSource, s: S): { clips: Clip[]; effects: FxItem[] } {
  const T = src.time;
  const mediaOf = new Map(s.media.map((m) => [m.id, m]));
  const lin = [0, 0, 1, 1] as [number, number, number, number];
  const clips: Clip[] = [];
  for (const sh of plan.shots) {
    const m = mediaOf.get(sh.mediaId);
    const start = T(sh.b0);
    const duration = T(sh.b1) - start;
    if (!m || duration < 1 / 60) continue;
    let inn = 0;
    if (m.kind === 'video') inn = Math.max(0, Math.min(sh.in, m.duration - duration));
    const c = makeClip({ mediaId: m.id, start, duration, in: inn, volume: 0 });
    if (sh.motion) {
      const { from: a, to: b } = sh.motion;
      c.keys = {
        scaleX: [newKey(0, a.scale, lin), newKey(duration, b.scale, lin)],
        scaleY: [newKey(0, a.scale, lin), newKey(duration, b.scale, lin)],
        x: [newKey(0, a.x, lin), newKey(duration, b.x, lin)],
        y: [newKey(0, a.y, lin), newKey(duration, b.y, lin)],
      };
    }
    const prev = clips[clips.length - 1];
    if (sh.transition && prev && Math.abs(prev.start + prev.duration - start) < 1e-6) {
      const beat = T(sh.b0 + 1) - start;
      const d = Math.min(sh.transition.beats * beat, prev.duration, duration);
      if (d >= 1 / 30) c.transitionIn = { moduleId: sh.transition.moduleId, params: {}, duration: d };
    }
    clips.push(c);
  }
  const effects: FxItem[] = [];
  for (const o of plan.overlays) {
    const start = T(o.b0);
    let duration = T(o.b1) - start;
    const combo = fxCombo(o.moduleId);
    if (combo) {
      // 我的組合：整組（主特效 + 疊加 + 觸發）放上去；衝擊型只打一下
      const fx = structuredClone(combo.fx);
      const main = s.modules.find((x) => x.id === fx.moduleId);
      if (!main) continue;
      if (!o.everyBeat && !fx.trigger && isHitFx(main)) duration = Math.min(duration, fx.duration || parseDuration(main.code, 0.5));
      if (duration < 1 / 60) continue;
      effects.push({ ...fx, stack: fx.stack?.map((x) => ({ ...x, id: uid() })), id: uid(), start, duration, track: 0 });
      continue;
    }
    const mod = s.modules.find((x) => x.id === o.moduleId);
    if (!mod) continue;
    // 衝擊特效只打一下：方塊長度 = 模組的 @duration（不超過計畫的範圍）
    if (!o.everyBeat && isHitFx(mod)) duration = Math.min(duration, parseDuration(mod.code, 0.5));
    if (duration < 1 / 60) continue;
    effects.push({
      id: uid(), moduleId: o.moduleId, params: { ...(o.params ?? {}) }, start, duration, track: 0,
      ...(o.everyBeat ? { trigger: { kind: 'beat' as const, every: 1 as const } } : {}),
    });
  }
  return { clips, effects };
}

// ───────────── 面板設定 / 執行 ─────────────

/** 設定 → 編排器的選項（只留目前存在的模組 / 組合） */
export function planOptions(st: AutoEditSettings, s: S = useStore.getState()): PlanOptions {
  const tr = s.modules.filter((m) => m.kind === 'transition' && !st.trOff.includes(m.id)).map(transitionOpt);
  const fx = s.modules.filter((m) => m.kind === 'effect' && !st.fxOff.includes(m.id)).map(accentOpt);
  const combos = usePrefs.getState().fxCombos.filter((c) => !st.fxOff.includes(c.id)).map((c) => comboAccentOpt(c, s.modules));
  const dropHit = st.dropHit && (s.modules.some((m) => m.id === st.dropHit) || fxCombo(st.dropHit)) ? st.dropHit : null;
  return { transitions: tr, accents: [...fx, ...combos], dropHit, kenBurns: st.kenBurns, order: st.order };
}

/** 上一版：產生前 / 產生後的專案（「再一版」= 回到產生前再產生，跟復原紀錄裡後來的面板設定變更無關） */
let last: { before: HistoryDoc; after: HistoryDoc } | null = null;
/** 上一版之後還沒有其他修改（「再一版」會先拿掉上一版） */
export const canReplaceLast = () => !!last && !docChanged(last.after);

export type AutoEditError = 'noMusic' | 'noMedia' | 'noRange' | 'noKey' | 'empty';
/** 進度：音樂 / 素材分析（第幾個、共幾個）/ AI 導演 */
export type AutoEditProgress = { stage: 'music' } | { stage: 'media'; i: number; n: number; name: string } | { stage: 'director' };

/** 依目前的設定產生一版並套用（一步復原）；replaceLast：上一版之後沒有其他修改 → 先復原上一版 */
export async function runAutoEdit(replaceLast = false, onProgress: (p: AutoEditProgress) => void = () => {}): Promise<{ shots: number; effects: number; warn?: string } | { error: AutoEditError }> {
  const st = useAutoEdit.getState();
  let s = useStore.getState();
  const audioId = st.audioId && s.audios.some((a) => a.id === st.audioId) ? st.audioId : musicClips(s)[0]?.id;
  const src0 = audioId ? musicSource(s, audioId) : null;
  if (!audioId || !src0) return { error: 'noMusic' };
  const media = footage(s).filter((m) => !st.mediaOff.includes(m.id));
  if (!media.length) return { error: 'noMedia' };
  if (st.director && !useAiSettings.getState().key) return { error: 'noKey' };
  onProgress({ stage: 'music' });
  const music = shapeMusic(await analyzeSource(src0), st.shape);

  // 素材分析（影片）；AI 導演要看圖，圖片也取一張
  const extra = new Map<string, Partial<PlanMedia>>();
  let warn: string | undefined;
  const need = media.filter((m) => (st.analyze && m.kind === 'video') || st.director);
  const sampled = need.length ? await sampleAll(need, (i, n, name) => onProgress({ stage: 'media', i, n, name })) : new Map<string, Sampled>();
  if (st.analyze) for (const [id, x] of sampled) if (x.info) extra.set(id, { info: x.info });
  if (st.director) {
    onProgress({ stage: 'director' });
    try {
      const dir = await directMedia(music, media, sampled, st.directorNote);
      for (const [id, d] of dir) extra.set(id, { ...extra.get(id), roles: d.roles, weight: d.weight, highlights: d.highlights });
      useAutoEdit.getState().set({ direction: Object.fromEntries(dir) });
    } catch (e) {
      // 導演失敗（額度、網路）：照樣剪，只是沒有 AI 的分配
      warn = e instanceof Error ? e.message : String(e);
    }
  }

  // 拿掉上一版 + 放上新的一版 = 一步復原
  const before = snapshotDoc();
  const replace = replaceLast && canReplaceLast() ? last!.before : null;
  beginHistoryTransaction();
  let ok = false;
  let shots = 0, nfx = 0;
  try {
    if (replace) {
      const { aux: _aux, ...proj } = replace;
      useStore.setState(proj);
    }
    s = useStore.getState();
    const src = musicSource(s, audioId);
    if (!src) return { error: 'noMusic' };
    let range: [number, number] | undefined;
    if (st.range === 'loop') {
      const r = s.loop && beatRange(src, s.loop.a, s.loop.b);
      if (!r) return { error: 'noRange' };
      range = r;
    }
    const seed = (Math.random() * 2 ** 31) >>> 0;
    const plan = planFor(src, music, media, st.params, seed, planOptions(st, s), range, extra);
    const { clips, effects } = planItems(plan, src, s);
    if (!clips.length) return { error: 'empty' };
    const p: Proposal = { summary: 'auto edit', op: { op: 'add_items', clips, effects } };
    applyProposals([p]);
    ok = true;
    shots = clips.length;
    nfx = effects.length;
  } finally {
    endHistoryTransaction(ok);
  }
  last = { before: replace ?? before, after: snapshotDoc() };
  return { shots, effects: nfx, ...(warn ? { warn } : {}) };
}

/** 產生一版（顯示進度與結果）；replaceLast = 再一版 */
export async function generateAutoEdit(replaceLast = false) {
  setBusy($t('分析音樂…'));
  try {
    const r = await runAutoEdit(replaceLast, (p) => setBusy(
      p.stage === 'music' ? $t('分析音樂…') : p.stage === 'media' ? $t('分析素材 {0}/{1}：{2}', p.i, p.n, p.name) : $t('AI 導演分配素材…'),
    ));
    if ('error' in r) {
      const msg = {
        noMusic: $t('沒有節拍：先在音訊軌放音樂'), noMedia: $t('沒有可用的素材'), noRange: $t('循環範圍裡沒有節拍'),
        noKey: $t('AI 導演需要 API 金鑰'), empty: $t('沒有產生任何片段'),
      }[r.error];
      toast(msg, 'error');
    } else {
      toast($t('已產生 {0} 個鏡頭', r.shots));
      if (r.warn) toast($t('AI 導演失敗，改用一般分配：{0}', r.warn), 'error');
    }
  } catch (e) {
    toast($t('自動剪輯失敗：{0}', e instanceof Error ? e.message : e), 'error');
  } finally {
    setBusy(null);
  }
}
