import { strict as assert } from 'node:assert';
import { parseLrc, parseSrt, writeLrc, writeSrt } from '../src/engine/subtitles';
import { makeClip } from '../src/store';
import { DEFAULT_TEXT } from '../src/engine/text';

const cues = parseSrt('\uFEFF1\r\n00:00:01,250 --> 00:00:03,500\r\n第一行\r\n第二行\r\n\r\n2\r\n00:00:04.000 --> 00:00:05.125\r\nNext\r\n');
assert.deepEqual(cues, [
  { start: 1.25, end: 3.5, text: '第一行\n第二行' },
  { start: 4, end: 5.125, text: 'Next' },
]);
const clips = cues.map((c) => makeClip({ mediaId: '', start: c.start, duration: c.end - c.start, text: { ...DEFAULT_TEXT, text: c.text } }));
assert.deepEqual(parseSrt(writeSrt(clips)), cues);
const lrc = writeLrc(clips);
assert.deepEqual(parseLrc(lrc).map(({ start, text }) => ({ start, text })), cues.map(({ start, text }) => ({ start, text: text.replace('\n', ' ') })));
console.log('PASS SRT parse/export round trip');
