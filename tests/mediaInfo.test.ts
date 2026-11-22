import { strict as assert } from 'node:assert';
import { aspectOf, codecName, formatBitrate, formatBytes, formatFps, formatOf, parseWav } from '../src/engine/mediaInfo';

assert.equal(formatOf('video/mp4', 'a.mp4'), 'MP4');
assert.equal(formatOf('video/quicktime', 'a.mov'), 'MOV');
assert.equal(formatOf('', 'clip.MKV'), 'MKV', '沒有 MIME 看副檔名');
assert.equal(formatOf('image/jpeg', 'x'), 'JPEG');

assert.equal(codecName('avc1.640028'), 'H.264');
assert.equal(codecName('hvc1.1.6.L93.B0'), 'H.265');
assert.equal(codecName('mp4a.40.2'), 'AAC');
assert.equal(codecName('apch'), 'ProRes');
assert.equal(codecName('xyz9'), 'xyz9', '不認得就原樣');

assert.equal(formatBytes(512), '512 B');
assert.equal(formatBytes(1536), '1.5 KB');
assert.equal(formatBytes(12.3 * 1024 * 1024), '12 MB');
assert.equal(formatBytes(1.4 * 1024 ** 3), '1.4 GB');

assert.equal(formatBitrate(8_500_000), '8.5 Mbps');
assert.equal(formatBitrate(25_000_000), '25 Mbps');
assert.equal(formatBitrate(192_000), '192 kbps');

assert.equal(aspectOf(1920, 1080), '16:9');
assert.equal(aspectOf(1080, 1920), '9:16');
assert.equal(aspectOf(1366, 768), '1.78:1', '約分後數字太大用小數');

assert.equal(formatFps(30), '30');
assert.equal(formatFps(30000 / 1001), '29.97');

// 最小的 WAV 標頭：RIFF / WAVE / fmt（2 聲道、44100 Hz）
const buf = new ArrayBuffer(44);
const v = new DataView(buf);
const put = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
put(0, 'RIFF'); put(8, 'WAVE'); put(12, 'fmt ');
v.setUint32(16, 16, true);
v.setUint16(20, 1, true);
v.setUint16(22, 2, true);
v.setUint32(24, 44100, true);
assert.deepEqual(parseWav(v), { channels: 2, sampleRate: 44100 });
assert.equal(parseWav(new DataView(new ArrayBuffer(12))), null);

console.log('mediaInfo OK');
