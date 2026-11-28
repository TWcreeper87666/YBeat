import { useEffect, useMemo, useRef, useState } from 'react';
import { $t } from '../i18n';
import { audioBufferPeak, fadeGain, getAudioBuffer, pitchAnalysis, setScrubbing, usePitchAnalysis, waveformLevels, type PitchAnalysis } from '../engine/audio';
import { evalKeys } from '../engine/keyframes';
import { detectNotes, hzToMidi, midiName, type Note } from '../engine/pitchNotes';
import { uid, useStore, type AudioClip } from '../store';
import { dragPan } from './middlePan';
import { useLayout } from './uiStore';
import { ViewScrollbar, wheelViewAction } from './wheelView';

/**
 * 音訊編輯視窗上方的音高編輯畫面（像 Melodyne）：
 * - 左邊鋼琴鍵盤 = 縱軸（半音），上面時間刻度，最下面是輸出的波形（照聲道設定一條或兩條，跟著音量 / 淡入淡出 / 左右聲道音量變）
 * - 中間：原本的音高曲線（細線）+ 自動切出的音符塊（粗細 = 音量）；上下拖音符 = 改那個字的音調；空白處拖曳 = 框選音符
 * - 水平：滾輪捲動、Ctrl + 滾輪縮放；垂直：Shift + 滾輪捲動、Alt + 滾輪縮放，在鍵盤上滾輪捲動、Ctrl + 滾輪縮放、拖曳平移；中鍵拖曳 = 兩個方向一起平移
 */

/** 左邊鍵盤寬、上面時間刻度高、下面每條波形的高（px） */
const AXIS = 44;
const RULER = 18;
const LANE = 34;
/** 縱軸能捲動的範圍（MIDI：C1 ~ C8） */
const M_MIN = 24;
const M_MAX = 108;
/** 縱軸最少 / 最多顯示幾個半音 */
const SPAN_MIN = 6;
const SPAN_MAX = M_MAX - M_MIN;
/** 音量包絡每格幾秒（音符塊的粗細） */
const ENV_STEP = 0.005;
const BLACK = new Set([1, 3, 6, 8, 10]);
const isBlack = (m: number) => BLACK.has(((Math.round(m) % 12) + 12) % 12);

const regionFor = (a: AudioClip, note: Note) => a.regions?.find((r) => r.a < a.in + note.b && r.b > a.in + note.a);
const clampV = (v: [number, number]): [number, number] => {
  const span = Math.max(SPAN_MIN, Math.min(SPAN_MAX, v[1] - v[0]));
  const lo = Math.max(M_MIN, Math.min(M_MAX - span, v[0]));
  return [lo, lo + span];
};
/** 縱軸自動範圍：剛好放得下所有音符，上下各留 5 個半音 */
const fitPitch = (notes: Note[], shift: number): [number, number] => {
  if (!notes.length) return clampV([48, 72]);
  const ms = notes.map((n) => n.midi + shift);
  const lo = Math.min(...ms) - 5, hi = Math.max(...ms) + 5;
  const span = Math.max(12, hi - lo);
  return clampV([(lo + hi) / 2 - span / 2, (lo + hi) / 2 + span / 2]);
};

export function AudioWave({ id }: { id: string }) {
  const a = useStore((s) => s.audios.find((x) => x.id === id));
  const media = useStore((s) => s.media.find((m) => m.id === a?.mediaId));
  const time = useStore((s) => s.time);
  usePitchAnalysis((s) => s.version);
  const [buf, setBuf] = useState<AudioBuffer | null>(null);
  const [analysis, setAnalysis] = useState<PitchAnalysis | null>(null);
  const [ready, setReady] = useState(false);
  /** 選取的音符（index）；primary = 最後點的那個（鍵盤 / 標籤以它為準） */
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [label, setLabel] = useState<{ x: number; y: number; text: string } | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const dur = a?.duration ?? 0;
  const rate = a?.rate ?? 1;
  const sourceEnd = a ? a.in + a.duration * rate : 0;
  // 輸出的聲道：立體聲 / 對調 = 兩條（各自是哪個素材聲道），其他 = 一條
  const stereoSrc = (buf?.numberOfChannels ?? 2) > 1;
  const lanes: { label: string; src: number[]; side: -1 | 0 | 1 }[] = !stereoSrc ? [{ label: '', src: [0], side: 0 }]
    : a?.channels === 'left' ? [{ label: 'L', src: [0], side: 0 }]
    : a?.channels === 'right' ? [{ label: 'R', src: [1], side: 0 }]
    : a?.channels === 'mono' ? [{ label: '', src: [0, 1], side: 0 }]
    : a?.channels === 'swap' ? [{ label: 'L', src: [1], side: -1 }, { label: 'R', src: [0], side: 1 }]
    : [{ label: 'L', src: [0], side: -1 }, { label: 'R', src: [1], side: 1 }];
  const WAVE = lanes.length * LANE + 6;
  const waveRef = useRef(WAVE);
  waveRef.current = WAVE;
  /** 水平：片段內秒數；垂直：MIDI 音高（下 → 上） */
  const [view, setView] = useState<[number, number]>([0, dur]);
  const [pv, setPv] = useState<[number, number]>([48, 72]);
  const viewRef = useRef(view);
  viewRef.current = view;
  const pvRef = useRef(pv);
  pvRef.current = pv;
  const bar = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  const notes = useMemo(() => (analysis ? detectNotes(analysis.f0, analysis.hop, analysis.sr) : []), [analysis]);
  // 音量包絡（各聲道取最大，整段正規化到 0~1）：音符塊的粗細、下面的波形都用它
  const env = useMemo(() => {
    if (!buf || !a) return null;
    const sr = buf.sampleRate, step = Math.max(1, Math.round(ENV_STEP * sr));
    const first = Math.max(0, Math.floor(a.in * sr)), last = Math.min(buf.length, Math.ceil(sourceEnd * sr));
    const out = new Float32Array(Math.max(1, Math.ceil((last - first) / step)));
    const chans = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i));
    let max = 1e-6;
    for (let k = 0; k < out.length; k++) {
      let sum = 0, n = 0;
      for (let i = first + k * step, end = Math.min(last, i + step); i < end; i += 2, n++) {
        let v = 0;
        for (const c of chans) v = Math.max(v, Math.abs(c[i]));
        sum += v * v;
      }
      out[k] = n ? Math.sqrt(sum / n) : 0;
      max = Math.max(max, out[k]);
    }
    for (let k = 0; k < out.length; k++) out[k] /= max;
    return out;
  }, [buf, a?.in, sourceEnd]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setView([0, dur]); setSelected(new Set()); }, [id, dur]);
  useEffect(() => setSelected(new Set()), [notes]);
  useEffect(() => {
    setBuf(null);
    if (!media?.url) return;
    let alive = true;
    void getAudioBuffer(media.url).then((b) => { if (alive) setBuf(b); });
    return () => { alive = false; };
  }, [media?.url]);
  useEffect(() => {
    setAnalysis(null);
    setReady(false);
    if (!media?.url || !a) return;
    let alive = true;
    void pitchAnalysis(media.url, a.in, sourceEnd).then((r) => { if (alive) { setAnalysis(r); setReady(true); } });
    return () => { alive = false; };
  }, [media?.url, a?.in, sourceEnd]); // eslint-disable-line react-hooks/exhaustive-deps
  // 分析好了（或換了片段）：縱軸自動對準音符
  useEffect(() => { setPv(fitPitch(notes, a?.pitch ?? 0)); }, [notes]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = bar.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // 播放 / 跳轉跑出顯示範圍：捲過去
  useEffect(() => {
    if (!a) return;
    const t = time - a.start;
    const [v0, v1] = viewRef.current;
    if (t >= v0 && t <= v1) return;
    const sp = v1 - v0;
    const n0 = Math.max(0, Math.min(dur - sp, t - sp * 0.1));
    setView([n0, n0 + sp]);
  }, [time, dur]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 座標換算 ──
  const ph = Math.max(1, size.h - RULER - WAVE); // 音高區的高度
  const pw = Math.max(1, size.w - AXIS);
  const xOf = (t: number) => AXIS + ((t - view[0]) / Math.max(1e-6, view[1] - view[0])) * pw;
  const yOf = (m: number) => RULER + ((pv[1] - m) / (pv[1] - pv[0])) * ph;
  const rowH = ph / (pv[1] - pv[0]);
  const shiftOf = (note: Note) => (a?.pitch ?? 0) + (a ? (regionFor(a, note)?.pitch ?? 0) : 0);
  const inPitch = (y: number) => y >= RULER && y < RULER + ph;
  const hit = (x: number, y: number) => {
    if (x < AXIS || !inPitch(y)) return -1;
    return notes.findIndex((n) => x >= xOf(n.a / rate) && x <= xOf(n.b / rate) && Math.abs(y - yOf(n.midi + shiftOf(n))) <= Math.max(6, rowH * 0.5));
  };

  /** 一次改好幾個音符的音調（null = 還原）；整批一次寫進去 */
  const writePitches = (list: { note: Note; pitch: number | null }[]) => {
    const clip = useStore.getState().audios.find((x) => x.id === id);
    if (!clip || !list.length) return;
    let regions = clip.regions ?? [];
    for (const { note, pitch } of list) {
      const first = clip.in + note.a, last = clip.in + note.b;
      const old = regions.find((r) => r.a < last && r.b > first);
      regions = regions.filter((r) => r.b <= first || r.a >= last);
      if (pitch !== null && Math.abs(pitch) > 0.005) regions.push({ ...old, id: old?.id ?? uid(), a: first, b: last, pitch });
    }
    useStore.getState().updateAudio(id, { regions: [...regions].sort((x, y) => x.a - y.a) });
  };
  const pitchOf = (note: Note) => (a ? (regionFor(a, note)?.pitch ?? 0) : 0);
  /** 音符塊在畫面上的範圍（框選用） */
  const boxOf = (n: Note) => { const yc = yOf(n.midi + shiftOf(n)); return { x0: xOf(n.a / rate), x1: xOf(n.b / rate), y0: yc - rowH * 0.5, y1: yc + rowH * 0.5 }; };

  // ── 滾輪：水平照時間軸規則；在鍵盤上 = 垂直 ──
  useEffect(() => {
    const el = bar.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      const r = el.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      const onKeys = x < AXIS;
      const hpx = Math.max(1, r.height - RULER - waveRef.current);
      // 垂直縮放（以游標為中心）：Alt + 滾輪（任何地方）、鍵盤上 Ctrl + 滾輪
      const vZoom = (delta: number) => {
        const [m0, m1] = pvRef.current, sp = m1 - m0;
        const at = m1 - Math.max(0, Math.min(1, (y - RULER) / hpx)) * sp;
        const ns = Math.max(SPAN_MIN, Math.min(SPAN_MAX, sp * 1.0015 ** delta));
        setPv(clampV([at - ((at - m0) / sp) * ns, at - ((at - m0) / sp) * ns + ns]));
      };
      if (e.altKey && !e.ctrlKey && !e.metaKey) {
        const delta = e.deltaY || e.deltaX;
        if (!delta) return;
        e.preventDefault();
        return vZoom(delta);
      }
      const action = wheelViewAction(e, onKeys ? 'vertical' : useLayout.getState().wheelScroll);
      if (action.kind !== 'zoom' && !action.delta) return;
      e.preventDefault();
      if (onKeys && action.kind === 'zoom') return vZoom(action.delta);
      if (action.kind === 'scrollY') {
        const [m0, m1] = pvRef.current;
        const d = (action.delta / hpx) * (m1 - m0);
        return setPv(clampV([m0 - d, m1 - d]));
      }
      const [v0, v1] = viewRef.current, span = v1 - v0, wpx = Math.max(1, r.width - AXIS);
      if (action.kind === 'scrollX') {
        const n = Math.max(0, Math.min(dur - span, v0 + (action.delta / wpx) * span));
        return setView([n, n + span]);
      }
      const anchor = v0 + Math.max(0, Math.min(1, (x - AXIS) / wpx)) * span;
      const next = Math.max(Math.min(0.05, dur), Math.min(dur, span * 1.0015 ** action.delta));
      const n = Math.max(0, Math.min(dur - next, anchor - ((anchor - v0) / span) * next));
      setView([n, n + next]);
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [dur]);

  // ── 畫面 ──
  useEffect(() => {
    const el = canvas.current;
    if (!el || !a || !size.w || !size.h) return;
    const dpr = window.devicePixelRatio || 1;
    el.width = Math.round(size.w * dpr);
    el.height = Math.round(size.h * dpr);
    const ctx = el.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = size.w, h = size.h;
    const css = getComputedStyle(el);
    const c = (name: string, fb: string) => css.getPropertyValue(name).trim() || fb;
    const text = c('--text', '#ddd'), muted = c('--muted', '#888'), line = c('--line', '#333'), lineStrong = c('--line-strong', '#555');
    const accent = c('--accent', '#5b8cff'), accentBright = c('--accent-bright', '#8fb0ff'), sunken = c('--sunken', '#111'), panel2 = c('--panel2', '#222'), wave = c('--wave', muted);
    const [v0, v1] = view, span = Math.max(1e-6, v1 - v0);
    const pitchTop = RULER, pitchBot = RULER + ph;
    ctx.clearRect(0, 0, w, h);

    // 半音的列：黑鍵的列暗一點（鋼琴捲軸）、每個 C 一條比較明顯的線
    ctx.save();
    ctx.beginPath(); ctx.rect(AXIS, pitchTop, w - AXIS, ph); ctx.clip();
    for (let m = Math.floor(pv[0]); m <= Math.ceil(pv[1]); m++) {
      const yTop = yOf(m + 0.5), yBot = yOf(m - 0.5);
      if (isBlack(m)) { ctx.fillStyle = sunken; ctx.globalAlpha = 0.55; ctx.fillRect(AXIS, yTop, w - AXIS, yBot - yTop); }
      if (((m % 12) + 12) % 12 === 0) { ctx.globalAlpha = 0.8; ctx.fillStyle = lineStrong; ctx.fillRect(AXIS, Math.round(yBot) - 0.5, w - AXIS, 1); }
    }
    ctx.globalAlpha = 1;
    // 時間格線
    const tick = Math.pow(10, Math.floor(Math.log10(Math.max(0.01, span / 6))));
    const step = [1, 2, 5, 10].map((n) => n * tick).find((n) => span / n <= 9) ?? tick * 10;
    ctx.fillStyle = line;
    for (let t = Math.ceil(v0 / step) * step; t <= v1; t += step) ctx.fillRect(Math.round(xOf(t)) - 0.5, pitchTop, 1, ph);

    if (analysis) {
      // 原本的音高曲線
      const srcAt = (i: number) => (i * analysis.hop) / analysis.sr;
      const curve = (pick: (srcT: number) => number | null) => {
        ctx.beginPath();
        let on = false;
        for (let i = 0; i < analysis.f0.length; i++) {
          const hz = analysis.f0[i], srcT = srcAt(i), t = srcT / rate;
          const sh = hz ? pick(srcT) : null;
          if (sh === null || t < v0 - 0.05 || t > v1 + 0.05) { on = false; continue; }
          const x = xOf(t), y = yOf(hzToMidi(hz) + sh);
          if (on) ctx.lineTo(x, y); else ctx.moveTo(x, y);
          on = true;
        }
        ctx.stroke();
      };
      ctx.lineWidth = 1;
      ctx.strokeStyle = muted; ctx.globalAlpha = 0.7;
      curve(() => a.pitch ?? 0);

      // 音符塊：粗細跟著音量（像 Melodyne 的 blob）
      notes.forEach((note, i) => {
        const x0 = xOf(note.a / rate), x1 = xOf(note.b / rate);
        if (x1 < AXIS || x0 > w) return;
        const edited = !!regionFor(a, note)?.pitch;
        const yc = yOf(note.midi + shiftOf(note));
        const half = (k: number) => {
          const e = env ? env[Math.min(env.length - 1, Math.max(0, Math.floor(k / ENV_STEP)))] : 0.6;
          return Math.max(2.5, rowH * (0.15 + 0.4 * Math.sqrt(e)));
        };
        const steps = Math.max(2, Math.min(200, Math.ceil((x1 - x0) / 3)));
        ctx.beginPath();
        for (let s = 0; s <= steps; s++) {
          const k = note.a + ((note.b - note.a) * s) / steps;
          const x = x0 + ((x1 - x0) * s) / steps;
          if (s === 0) ctx.moveTo(x, yc - half(k)); else ctx.lineTo(x, yc - half(k));
        }
        for (let s = steps; s >= 0; s--) {
          const k = note.a + ((note.b - note.a) * s) / steps;
          ctx.lineTo(x0 + ((x1 - x0) * s) / steps, yc + half(k));
        }
        ctx.closePath();
        ctx.globalAlpha = edited ? 0.85 : 0.5;
        ctx.fillStyle = edited ? accent : text;
        ctx.fill();
        if (selected.has(i)) { ctx.globalAlpha = 1; ctx.strokeStyle = accentBright; ctx.lineWidth = 1.5; ctx.stroke(); }
      });
      // 改過的音符：變調後的曲線
      ctx.globalAlpha = 1; ctx.lineWidth = 1.5; ctx.strokeStyle = accentBright;
      curve((srcT) => {
        const note = notes.find((n) => srcT >= n.a && srcT < n.b);
        return note && regionFor(a, note)?.pitch ? shiftOf(note) : null;
      });
      ctx.lineWidth = 1;
    }
    ctx.restore();

    // 左邊鍵盤
    ctx.fillStyle = panel2; ctx.fillRect(0, pitchTop, AXIS, ph);
    ctx.save();
    ctx.beginPath(); ctx.rect(0, pitchTop, AXIS, ph); ctx.clip();
    ctx.font = '10px sans-serif'; ctx.textBaseline = 'middle';
    for (let m = Math.floor(pv[0]); m <= Math.ceil(pv[1]); m++) {
      const yTop = yOf(m + 0.5), yBot = yOf(m - 0.5);
      if (isBlack(m)) { ctx.fillStyle = sunken; ctx.globalAlpha = 1; ctx.fillRect(0, yTop, AXIS * 0.6, yBot - yTop); }
      else { ctx.fillStyle = line; ctx.globalAlpha = 1; ctx.fillRect(0, Math.round(yBot) - 0.5, AXIS, 1); }
      const isC = ((m % 12) + 12) % 12 === 0;
      if (isC || (!isBlack(m) && rowH >= 13)) {
        ctx.globalAlpha = isC ? 1 : 0.7; ctx.fillStyle = isC ? text : muted;
        ctx.fillText(midiName(m), AXIS - 24, (yTop + yBot) / 2);
      }
    }
    ctx.restore();
    ctx.globalAlpha = 1;
    ctx.fillStyle = lineStrong; ctx.fillRect(AXIS - 1, pitchTop, 1, ph);

    // 上面時間刻度
    ctx.fillStyle = panel2; ctx.fillRect(0, 0, w, RULER);
    ctx.fillStyle = muted; ctx.font = '10px sans-serif'; ctx.textBaseline = 'middle';
    for (let t = Math.ceil(v0 / step) * step; t <= v1; t += step) {
      const x = xOf(t);
      if (x < AXIS) continue;
      ctx.fillRect(Math.round(x) - 0.5, RULER - 5, 1, 5);
      ctx.fillText(`${t.toFixed(step < 1 ? (step < 0.1 ? 2 : 1) : 0)}s`, x + 3, RULER / 2);
    }
    ctx.fillStyle = line; ctx.fillRect(0, RULER - 1, w, 1);

    // 下面的波形：輸出的聲道（一條或兩條），大小跟著音量（關鍵影格）、淡入淡出、平衡
    const wy = pitchBot;
    ctx.fillStyle = panel2; ctx.fillRect(0, wy, w, WAVE);
    ctx.fillStyle = line; ctx.fillRect(0, wy, w, 1);
    if (buf) {
      const peak = audioBufferPeak(buf);
      const chans = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i));
      // 每一格（px）的增益：音量 × 淡入淡出；兩個聲道時再乘上左 / 右聲道的音量
      const val = (ch: 'volume' | 'volL' | 'volR', base: number, local: number) => Math.max(0, a.keys?.[ch]?.length ? evalKeys(a.keys[ch]!, local) : base);
      const gains = new Float32Array(pw), gl = new Float32Array(pw), gr = new Float32Array(pw);
      for (let x = 0; x < pw; x++) {
        const local = v0 + ((x + 0.5) / pw) * span;
        gains[x] = val('volume', a.volume, local) * fadeGain(a, local);
        gl[x] = val('volL', a.volL ?? 1, local);
        gr[x] = val('volR', a.volR ?? 1, local);
      }
      ctx.font = '10px sans-serif'; ctx.textBaseline = 'middle';
      lanes.forEach((lane, li) => {
        const levels = waveformLevels(lane.src.map((k) => chans[Math.min(k, chans.length - 1)]), buf.sampleRate, a.in + v0 * rate, span * rate, pw, peak);
        const mid = wy + 3 + LANE * li + LANE / 2, amp = LANE / 2 - 2;
        if (li) { ctx.fillStyle = line; ctx.globalAlpha = 0.6; ctx.fillRect(AXIS, wy + 3 + LANE * li, w - AXIS, 1); ctx.globalAlpha = 1; }
        ctx.fillStyle = wave;
        for (let x = 0; x < levels.length; x++) {
          const side = lane.side === -1 ? gl[x] : lane.side === 1 ? gr[x] : 1;
          const v = Math.min(1, levels[x] * gains[x] * side) * amp;
          ctx.fillRect(AXIS + x, mid - v, 1, Math.max(1, v * 2));
        }
        if (lane.label) { ctx.fillStyle = muted; ctx.fillText(lane.label, AXIS - 14, mid); }
      });
    }
  }, [a, buf, env, view, pv, size, analysis, notes, selected, WAVE]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!a) return null;

  // ── 滑鼠 ──
  const seek = (clientX: number) => {
    const r = bar.current!.getBoundingClientRect(), [v0, v1] = viewRef.current;
    useStore.getState().setTime(a.start + v0 + Math.max(0, Math.min(1, (clientX - r.left - AXIS) / Math.max(1, r.width - AXIS))) * (v1 - v0));
  };
  /** 拖曳平移：dx 水平、dy 垂直（px） */
  const panBy = (v: [number, number], p: [number, number], dx: number, dy: number, horizontal: boolean) => {
    const r = bar.current!.getBoundingClientRect();
    if (horizontal) {
      const span = v[1] - v[0], n = Math.max(0, Math.min(dur - span, v[0] - (dx / Math.max(1, r.width - AXIS)) * span));
      setView([n, n + span]);
    }
    const d = (dy / Math.max(1, r.height - RULER - WAVE)) * (p[1] - p[0]);
    setPv(clampV([p[0] + d, p[1] + d]));
  };
  const listen = (el: HTMLElement, pointerId: number, move: (ev: PointerEvent) => void, done?: () => void) => {
    el.setPointerCapture(pointerId);
    const up = () => {
      done?.();
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  const down = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const v = viewRef.current, p = pvRef.current;
    if (e.button === 1) return dragPan(e, (dx, dy) => panBy(v, p, dx, dy, true));
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.focus();
    const el = e.currentTarget;
    // 鍵盤上拖曳 = 上下平移
    if (x < AXIS && inPitch(y)) {
      const y0 = e.clientY;
      return listen(el, e.pointerId, (ev) => panBy(v, p, 0, ev.clientY - y0, false));
    }
    const index = hit(x, y);
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    if (index >= 0) {
      // Ctrl / Shift + 點：加入 / 移出選取；點選取中的音符 = 整組一起拖
      let sel = selected;
      if (additive) {
        sel = new Set(selected);
        if (sel.has(index)) sel.delete(index); else sel.add(index);
        setSelected(sel);
        if (!sel.has(index)) return;
      } else if (!selected.has(index)) {
        sel = new Set([index]);
        setSelected(sel);
      }
      const group = [...sel].filter((k) => notes[k]).map((k) => ({ note: notes[k], start: pitchOf(notes[k]) }));
      const main = notes[index], y0 = e.clientY, start = pitchOf(main), base = main.midi + (a.pitch ?? 0);
      return listen(el, e.pointerId, (ev) => {
        const raw = start + (y0 - ev.clientY) / rowH;
        // 對齊半音：以按住的那個音符為準，其他音符移一樣多
        const pitch = ev.altKey ? Math.round(raw * 100) / 100 : Math.round(base + raw) - base;
        const delta = pitch - start;
        writePitches(group.map((g) => ({ note: g.note, pitch: Math.max(-24, Math.min(24, g.start + delta)) })));
        setLabel({ x: ev.clientX - r.left, y: ev.clientY - r.top, text: `${midiName(base + pitch)} ${pitch >= 0 ? '+' : ''}${pitch.toFixed(ev.altKey ? 2 : 1)}${group.length > 1 ? ` · ${group.length}` : ''}` });
      }, () => setLabel(null));
    }
    // 音高區的空白處：拖曳 = 框選音符（Ctrl / Shift = 加選）；沒拖動 = 移動播放頭、取消選取
    if (inPitch(y)) {
      const before = additive ? selected : new Set<number>();
      const cx = e.clientX, cy = e.clientY;
      let moved = false;
      return listen(el, e.pointerId, (ev) => {
        if (!moved && Math.hypot(ev.clientX - cx, ev.clientY - cy) < 3) return;
        moved = true;
        const box = { x0: Math.min(cx, ev.clientX), y0: Math.min(cy, ev.clientY), x1: Math.max(cx, ev.clientX), y1: Math.max(cy, ev.clientY) };
        setMarquee(box);
        const lx0 = box.x0 - r.left, lx1 = box.x1 - r.left, ly0 = box.y0 - r.top, ly1 = box.y1 - r.top;
        const next = new Set(before);
        notes.forEach((n, k) => { const b = boxOf(n); if (b.x1 >= lx0 && b.x0 <= lx1 && b.y1 >= ly0 && b.y0 <= ly1) next.add(k); });
        setSelected(next);
      }, () => {
        setMarquee(null);
        if (moved) return;
        if (!additive) setSelected(new Set());
        seek(cx);
      });
    }
    // 時間刻度 / 波形 = 移動播放頭（拖曳時出聲）
    seek(e.clientX);
    let moved = false;
    const x0 = e.clientX;
    listen(el, e.pointerId, (ev) => {
      if (!moved && Math.abs(ev.clientX - x0) < 2) return;
      if (!moved) { moved = true; setScrubbing(true); }
      seek(ev.clientX);
    }, () => setScrubbing(false));
  };
  const hover = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.buttons) return;
    const r = e.currentTarget.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    e.currentTarget.style.cursor = x < AXIS && inPitch(y) ? 'grab' : hit(x, y) >= 0 ? 'ns-resize' : 'crosshair';
  };
  const dbl = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    if (x < AXIS && inPitch(y)) return setPv(fitPitch(notes, a.pitch ?? 0)); // 鍵盤上雙擊 = 縱軸對準音符
    const i = hit(x, y);
    if (i >= 0) writePitches([{ note: notes[i], pitch: null }]);
  };
  const key = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') return;
    // Ctrl + A = 全選音符
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault(); e.stopPropagation();
      return setSelected(new Set(notes.map((_, k) => k)));
    }
    const group = [...selected].filter((k) => notes[k]).map((k) => notes[k]);
    if (!group.length) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault(); e.stopPropagation();
      return writePitches(group.map((note) => ({ note, pitch: null })));
    }
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    e.stopPropagation();
    const d = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 12 : 1);
    writePitches(group.map((note) => ({ note, pitch: Math.max(-24, Math.min(24, pitchOf(note) + d)) })));
  };
  const head = size.w ? xOf(time - a.start) : -1;

  return (
    <div className="audio-wave" ref={bar} tabIndex={0} onPointerDown={down} onPointerMove={hover} onDoubleClick={dbl} onKeyDown={key}>
      <canvas ref={canvas} className="wave" />
      {!ready && <span className="audio-wave-status">{$t('分析音高中…')}</span>}
      {ready && !notes.length && <span className="audio-wave-status">{$t('沒有偵測到人聲')}</span>}
      {label && <span className="audio-wave-drag-label" style={{ left: label.x, top: label.y }}>{label.text}</span>}
      {marquee && bar.current && (() => {
        const r = bar.current.getBoundingClientRect();
        return <div className="marquee" style={{ left: marquee.x0 - r.left, top: marquee.y0 - r.top, width: marquee.x1 - marquee.x0, height: marquee.y1 - marquee.y0 }} />;
      })()}
      {head >= AXIS && head <= size.w && <i className="audio-wave-head" style={{ left: head }} />}
      <div className="audio-wave-hbar" style={{ left: AXIS }}>
        <ViewScrollbar a={view[0]} b={view[1]} dur={dur} onChange={setView} />
      </div>
      <div className="audio-wave-vbar" style={{ top: RULER, bottom: WAVE }}>
        <ViewScrollbar vertical a={M_MAX - pv[1]} b={M_MAX - pv[0]} dur={M_MAX - M_MIN} onChange={([x, y]) => setPv(clampV([M_MAX - y, M_MAX - x]))} />
      </div>
    </div>
  );
}
