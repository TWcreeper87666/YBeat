import { strict as assert } from 'node:assert';
import { describe, it } from './logicHarness';
import { audioPlanes } from '../src/engine/tabRecord';

/** 假的 AudioData：L = 0.5、R = -0.25（照格式存） */
function fake(format: AudioSampleFormat, channels = 2) {
  const n = 4;
  const L = 0.5, R = -0.25;
  return {
    format, numberOfFrames: n, numberOfChannels: channels,
    copyTo(dest: ArrayBufferView, o: AudioDataCopyToOptions) {
      if (o.format) throw new Error('不應該要瀏覽器轉換');
      const v = (c: number) => (c === 0 ? L : R);
      const s16 = (x: number) => Math.round(x * 32768);
      if (format === 'f32-planar') (dest as Float32Array).fill(v(o.planeIndex));
      else if (format === 's16-planar') (dest as Int16Array).fill(s16(v(o.planeIndex)));
      else for (let i = 0; i < n * channels; i++) {
        const x = v(i % channels);
        (dest as Float32Array | Int16Array)[i] = format === 'f32' ? x : s16(x);
      }
    },
  } as unknown as AudioData;
}

describe('分頁錄音：各種聲音格式都正確拆成左右聲道', () => {
  for (const f of ['f32-planar', 'f32', 's16-planar', 's16'] as AudioSampleFormat[]) {
    it(f, () => {
      const [l, r] = audioPlanes(fake(f));
      assert.ok(l.every((x) => Math.abs(x - 0.5) < 1e-4), `${f} 左`);
      assert.ok(r.every((x) => Math.abs(x + 0.25) < 1e-4), `${f} 右`);
    });
  }
  it('單聲道：左右一樣', () => {
    const [l, r] = audioPlanes(fake('f32', 1));
    assert.deepEqual([...l], [...r]);
  });
});
