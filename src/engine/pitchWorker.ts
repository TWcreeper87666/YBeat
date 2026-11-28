import { detectPitch, pitchMarks, type PitchMark } from './psola';

export type PitchRequest = { id: number; mono: Float32Array; sr: number };
export type PitchResponse = { id: number; f0: Float32Array; hop: number; marks: PitchMark[] };

self.onmessage = (event: MessageEvent<PitchRequest>) => {
  const { id, mono, sr } = event.data;
  const { f0, hop } = detectPitch(mono, sr);
  const marks = pitchMarks(mono, sr, { f0, hop });
  (self as unknown as Worker).postMessage({ id, f0, hop, marks } satisfies PitchResponse, [f0.buffer]);
};
