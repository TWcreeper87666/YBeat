import { strict as assert } from 'node:assert';
(globalThis as any).localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
console.warn = () => {};
import {
  addCue, applyToAllCaptions, captionList, formatTc, mergeCueWithNext, parseLrc, parseSrt, parseTc,
  readingSpeed, replaceInCaptions, setTrackCaptions, splitCue, writeLrc, writeSrt,
} from '../src/engine/subtitles';
import { makeClip, useStore, type Clip } from '../src/store';
import { DEFAULT_TEXT } from '../src/engine/text';

const cues = parseSrt('﻿1\r\n00:00:01,250 --> 00:00:03,500\r\n第一行\r\n第二行\r\n\r\n2\r\n00:00:04.000 --> 00:00:05.125\r\nNext\r\n');
assert.deepEqual(cues, [
  { start: 1.25, end: 3.5, text: '第一行\n第二行' },
  { start: 4, end: 5.125, text: 'Next' },
]);
const clips = cues.map((c) => makeClip({ mediaId: '', start: c.start, duration: c.end - c.start, text: { ...DEFAULT_TEXT, text: c.text } }));
assert.deepEqual(parseSrt(writeSrt(clips)), cues);
const lrc = writeLrc(clips);
assert.deepEqual(parseLrc(lrc).map(({ start, text }) => ({ start, text })), cues.map(({ start, text }) => ({ start, text: text.replace('\n', ' ') })));
console.log('PASS SRT parse/export round trip');

// 時間碼
assert.equal(formatTc(83.456), '01:23.46');
assert.equal(formatTc(3723.5), '1:02:03.50');
assert.equal(parseTc('83.5'), 83.5);
assert.equal(parseTc('1:23.45'), 83.45);
assert.equal(parseTc('0:01:23,450'), 83.45);
assert.ok(Number.isNaN(parseTc('abc')) && Number.isNaN(parseTc('1::2')) && Number.isNaN(parseTc('1.5:20')));
console.log('PASS 時間碼格式 / 解析');

assert.ok(readingSpeed('這是一段非常非常非常長的字幕文字', 1).fast);
assert.ok(!readingSpeed('短字幕', 2).fast);
assert.ok(!readingSpeed('Hello there, friend', 2).fast);
console.log('PASS 每秒字數判斷');

// 字幕編輯
const cap = (id: string, start: number, duration: number, text: string): Clip => makeClip({ id, mediaId: '', track: 1, start, duration, caption: true, fit: 'contain', text: { ...DEFAULT_TEXT, text } });
const reset = () => useStore.setState({ media: [], clips: [cap('a', 0, 2, 'Hello world'), cap('b', 3, 2, '第二段')], audios: [], effects: [], tracks: { video: [{}, {}], fx: [], audio: [] }, selection: null, selected: [] });

reset();
const added = addCue(2.5)!;
let s = useStore.getState();
let c = s.clips.find((x) => x.id === added)!;
assert.ok(c.caption && c.track === 1 && c.start === 2.5 && Math.abs(c.duration - 0.5) < 1e-9 && c.text!.text === '', '新字幕接在播放頭所在空位，長度不超過下一段');
reset();
const added2 = addCue(1)!;
c = useStore.getState().clips.find((x) => x.id === added2)!;
assert.ok(c.start === 2 && Math.abs(c.duration - 1) < 1e-9, '播放頭在字幕裡 → 接在那段後面');
console.log('PASS 新增字幕');

reset();
const back = splitCue('a', 1, 5)!;
s = useStore.getState();
const a = s.clips.find((x) => x.id === 'a')!, b = s.clips.find((x) => x.id === back)!;
assert.ok(a.duration === 1 && b.start === 1 && b.duration === 1, '時間切在播放頭');
assert.equal(a.text!.text, 'Hello');
assert.equal(b.text!.text, 'world');
console.log('PASS 分割字幕');

reset();
assert.ok(mergeCueWithNext('a'));
s = useStore.getState();
assert.ok(!s.clips.some((x) => x.id === 'b'));
c = s.clips.find((x) => x.id === 'a')!;
assert.ok(c.duration === 5 && c.text!.text === 'Hello world第二段');
assert.ok(!mergeCueWithNext('a'), '最後一段沒有下一段');
console.log('PASS 合併字幕');

reset();
useStore.getState().updateClip('a', { text: { ...DEFAULT_TEXT, text: 'Hello world', size: 50, color: '#ff0000' }, transform: { ...cap('x', 0, 1, '').transform, y: 0.42 } });
assert.equal(applyToAllCaptions('a', ['style', 'position']), 1);
c = useStore.getState().clips.find((x) => x.id === 'b')!;
assert.ok(c.text!.size === 50 && c.text!.color === '#ff0000' && c.text!.text === '第二段' && c.transform.y === 0.42, '樣式 / 位置套用，內容不變');
console.log('PASS 套用到全部字幕');

reset();
assert.equal(replaceInCaptions('o', '0'), 2);
assert.equal(useStore.getState().clips.find((x) => x.id === 'a')!.text!.text, 'Hell0 w0rld');
assert.equal(captionList(useStore.getState().clips).length, 2);
console.log('PASS 尋找取代');

// 鎖定的軌道不改
reset();
useStore.setState({ tracks: { video: [{}, { locked: true }], fx: [], audio: [] } });
assert.equal(splitCue('a', 1), null);
assert.ok(!mergeCueWithNext('a'));
assert.equal(replaceInCaptions('o', '0'), 0);
console.log('PASS 鎖定軌道不受影響');

// 不接收某條影片軌的字幕
reset();
useStore.setState({ clips: [...useStore.getState().clips, { ...cap('c', 0, 2, 'other track o'), track: 0 }] });
assert.equal(captionList(useStore.getState().clips, useStore.getState().tracks).length, 3);
setTrackCaptions(0, false);
s = useStore.getState();
assert.deepEqual(captionList(s.clips, s.tracks).map((x) => x.id), ['a', 'b']);
assert.equal(replaceInCaptions('o', '0'), 2, '不接收的軌道不取代');
assert.equal(s.clips.find((x) => x.id === 'c')!.text!.text, 'other track o');
assert.equal(applyToAllCaptions('a', ['style']), 1, '不接收的軌道不套用');
setTrackCaptions(0, true);
assert.equal(captionList(useStore.getState().clips, useStore.getState().tracks).length, 3);
console.log('PASS 選擇接收哪些影片軌的字幕');
