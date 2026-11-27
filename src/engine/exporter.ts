import { ensureShapes } from './maskShapes';
import { prepareMattes } from './matte';
import { prepareSubjects } from './follow';
import { $t } from '../i18n';
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import { projectDuration, useStore } from '../store';
import { getRenderer, makeCtx } from './renderer';
import { SAMPLE_RATE, mixdown, stopAudioPreview } from './audio';
import { DemuxCache, SequentialVideoReader } from './matteDecode';

export function downloadBlob(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

/** 先找顯示卡的硬體編碼器（NVENC / Quick Sync…），沒有才讓瀏覽器自己選（可能是軟體編碼） */
async function pickVideoConfig(w: number, h: number, fps: number, bitrate: number) {
  for (const hw of ['prefer-hardware', 'no-preference'] as const) {
    for (const codec of ['avc1.640034', 'avc1.640033', 'avc1.4d0034', 'avc1.42003e']) {
      const c: VideoEncoderConfig = { codec, width: w, height: h, bitrate, framerate: fps, hardwareAcceleration: hw };
      if ((await VideoEncoder.isConfigSupported(c)).supported) return c;
    }
  }
  return null;
}

async function pickAudioConfig() {
  if (typeof AudioEncoder === 'undefined') return null;
  const opts = [
    { codec: 'mp4a.40.2', mux: 'aac' as const },
    { codec: 'opus', mux: 'opus' as const },
  ];
  for (const o of opts) {
    const c: AudioEncoderConfig = { codec: o.codec, sampleRate: SAMPLE_RATE, numberOfChannels: 2, bitrate: 192_000 };
    if ((await AudioEncoder.isConfigSupported(c)).supported) return { config: c, mux: o.mux };
  }
  return null;
}

/** 逐幀離線渲染 → WebCodecs 硬體編碼 → MP4（含混音，不會掉幀） */
/** range：只輸出這段（例如循環範圍）；沒給 = 整個專案 */
export async function exportMp4(fps: number, range?: { a: number; b: number }, bitrate = 20_000_000): Promise<Blob> {
  const r = getRenderer();
  if (!r) throw new Error($t('渲染器尚未就緒'));
  if (typeof VideoEncoder === 'undefined') throw new Error($t('此瀏覽器不支援 WebCodecs，請使用 Chrome / Edge'));

  const st0 = useStore.getState();
  const start = range ? Math.max(0, range.a) : 0;
  const dur = range ? Math.min(projectDuration(st0), range.b) - start : projectDuration(st0);
  if (dur <= 0) throw new Error($t('時間軸是空的'));
  const total = Math.ceil(dur * fps);
  const ctx = makeCtx(st0);
  // 匯出畫面馬上出來（準備遮罩、去背可能要一陣子），準備中也可以取消
  useStore.setState({ playing: false, exporting: { progress: 0, cancel: false, t: start, a: start, b: start + dur, prep: true } });
  const stopIfCancelled = () => { if (useStore.getState().exporting?.cancel) throw new Error($t('已取消')); };
  let vConfig: VideoEncoderConfig | null;
  try {
    // 自訂遮罩形狀要先解碼好（預覽時是背景載入）
    const fxs = [...st0.effects, ...st0.clips.flatMap((c) => c.effects ?? [])];
    await ensureShapes(fxs.map((f) => f.mask?.shape ?? 'none'));
    stopIfCancelled();
    // AI 去背：遮罩要先全部算好
    await prepareMattes(st0.clips, ctx.media, ctx.modules);
    stopIfCancelled();
    await prepareSubjects(st0.clips, ctx.media, ctx.modules);
    stopIfCancelled();
    vConfig = await pickVideoConfig(st0.format.w, st0.format.h, fps, bitrate);
    if (!vConfig) throw new Error($t('找不到可用的 H.264 編碼設定'));
  } catch (e) {
    useStore.setState({ exporting: null });
    throw e;
  }
  const { w: FW, h: FH } = st0.format;
  // 匯出一律用全解析度（預覽可能是縮小的）；匯出中預覽迴圈不會改大小
  r.setSize(FW, FH);
  r.pauseAll();
  stopAudioPreview();

  let encodeError: unknown = null;
  let encoder: VideoEncoder | null = null;
  const readers = new Map<string, SequentialVideoReader>();
  const demuxCache = new DemuxCache();
  /** 這一格用到的片段（沒用到的解碼器馬上關掉，硬體解碼器的數量有限） */
  const usedNow = new Set<string>();
  const unsupported = new Set<string>();
  const seekClips = new Set<string>();
  try {
    const mixed = await mixdown(st0, ctx.modules, dur, start);
    const aPick = mixed ? await pickAudioConfig() : null;
    // 有聲音但編不了：不要默默匯出無聲影片
    if (mixed && !aPick) throw new Error($t('找不到可用的音訊編碼設定'));

    const target = new ArrayBufferTarget();
    const muxer = new Muxer({
      target,
      video: { codec: 'avc', width: FW, height: FH, frameRate: fps },
      audio: aPick ? { codec: aPick.mux, sampleRate: SAMPLE_RATE, numberOfChannels: 2 } : undefined,
      fastStart: 'in-memory',
      firstTimestampBehavior: 'offset',
    });

    // 音訊：一次編碼完
    if (mixed && aPick) {
      const ae = new AudioEncoder({ output: (c, m) => muxer.addAudioChunk(c, m), error: (e) => (encodeError = e) });
      ae.configure(aPick.config);
      const L = mixed.getChannelData(0), R = mixed.getChannelData(1);
      const N = 1024;
      for (let i = 0; i < mixed.length; i += N) {
        const n = Math.min(N, mixed.length - i);
        const data = new Float32Array(n * 2);
        data.set(L.subarray(i, i + n), 0);
        data.set(R.subarray(i, i + n), n);
        const ad = new AudioData({ format: 'f32-planar', sampleRate: SAMPLE_RATE, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round((i / SAMPLE_RATE) * 1e6), data });
        ae.encode(ad);
        ad.close();
      }
      await ae.flush();
      ae.close();
    }

    encoder = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => (encodeError = e) });
    encoder.configure(vConfig);
    const cancelled = () => !!useStore.getState().exporting?.cancel;
    const frameFor = async (clip: { id: string }, media: { id: string; url: string }, sourceTime: number) => {
      if (unsupported.has(media.id) || seekClips.has(clip.id)) return null;
      usedNow.add(clip.id);
      try {
        let reader = readers.get(clip.id);
        if (!reader) {
          reader = await SequentialVideoReader.open(media.url, demuxCache);
          readers.set(clip.id, reader);
        }
        const frame = await reader.frameAt(sourceTime, () => !cancelled());
        if (cancelled()) throw new Error('export cancelled');
        if (!frame) {
          reader.close();
          readers.delete(clip.id);
          seekClips.add(clip.id);
        }
        return frame;
      } catch (e) {
        if (cancelled()) throw e;
        console.warn('Sequential export decode unavailable; using video seek', media.id, e);
        readers.get(clip.id)?.close();
        readers.delete(clip.id);
        unsupported.add(media.id);
        return null;
      }
    };
    // 按取消：卡在某一格（等影片跳轉）時也馬上停
    const untilCancel = () => new Promise<'cancel'>((res) => {
      const id = setInterval(() => { if (cancelled()) { clearInterval(id); res('cancel'); } }, 100);
      stopWatch.push(() => clearInterval(id));
    });
    const stopWatch: (() => void)[] = [];
    const t0 = performance.now();
    useStore.setState((s) => ({ exporting: s.exporting && { ...s.exporting, prep: undefined } }));
    try {
      for (let i = 0; i < total; i++) {
        if (cancelled()) throw new Error($t('已取消'));
        if (encodeError) throw encodeError;
        const t = start + i / fps;
        usedNow.clear();
        if (await Promise.race([r.prepareExact(ctx, t, frameFor), untilCancel()]) === 'cancel') throw new Error($t('已取消'));
        stopWatch.splice(0).forEach((f) => f());
        // 片段播完了：關掉它的解碼器（匯出時間只往後走，不會再用到）
        for (const [id, reader] of readers) if (!usedNow.has(id)) { reader.close(); readers.delete(id); }
        r.render(ctx, t, 'export');
        const frame = new VideoFrame(r.canvas, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) });
        encoder.encode(frame, { keyFrame: i % (fps * 2) === 0 });
        frame.close();
        while (encoder.encodeQueueSize > 6 && !encodeError && !cancelled()) await new Promise((res) => setTimeout(res, 1));
        if (i % 5 === 0) {
          // 預估剩下的時間：照目前的平均速度（前 2 秒還不準，不顯示）
          const spent = (performance.now() - t0) / 1000, p = (i + 1) / total;
          const eta = spent > 2 ? (spent / p) * (1 - p) : undefined;
          // 不要蓋掉使用者剛按的取消
          useStore.setState((s) => ({ exporting: s.exporting && { ...s.exporting, progress: i / total, t, ...(eta !== undefined ? { eta } : {}) } }));
        }
      }
    } finally {
      stopWatch.forEach((f) => f());
    }
    await encoder.flush();
    if (encodeError) throw encodeError;
    muxer.finalize();
    return new Blob([target.buffer], { type: 'video/mp4' });
  } finally {
    r.clearExportFrames();
    readers.forEach((reader) => reader.close());
    demuxCache.clear();
    if (encoder && encoder.state !== 'closed') encoder.close();
    useStore.setState({ exporting: null });
  }
}
