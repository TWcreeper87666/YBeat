import { strict as assert } from 'node:assert';
import { describe, it } from './logicHarness';
import { clipSource, ease, getRemapFn, plainSpeed, setRemapErrorReporter } from '../src/engine/remap';
import type { Clip, Media, Module } from '../src/store';

const media = { duration: 10 } as Media;
const clip = (patch: Partial<Clip> = {}) => ({ duration: 4, in: 2, rate: 1, remap: { moduleId: 'none', params: {} }, ...patch }) as Clip;
const moduleOf = (id: string, code: string) => ({ id, code, kind: 'remap' }) as Module;

describe('remap 純邏輯', () => {
  it('easing 端點與 clamp', () => {
    for (const name of ['linear', 'inCubic', 'outCubic', 'inOutCubic', 'inExpo', 'outExpo', 'outBack', 'inOutBack']) {
      assert.ok(Math.abs(ease[name](0)) < 1e-9, name);
      assert.ok(Math.abs(ease[name](1) - 1) < 1e-9, name);
    }
    assert.equal(ease.clamp(-1), 0);
    assert.equal(ease.clamp(3, 1, 2), 2);
  });

  it('編譯 remap 函式並快取同 id 的新版程式', () => {
    const a = moduleOf('unit-remap', 'function remap(t) { return t * 2; }');
    const b = moduleOf('unit-remap', 'function remap(t) { return t * 3; }');
    const fn = getRemapFn(a)!;
    assert.equal(fn(2, {}, { dur: 4, srcDur: 10, in: 0 }), 4);
    assert.equal(getRemapFn(a), fn);
    assert.equal(getRemapFn(b)!(2, {}, { dur: 4, srcDur: 10, in: 0 }), 6);
  });

  it('一般速度、反向與片段 rate', () => {
    const speed = moduleOf('remap-speed', '// @param speed: float = 1 (0.1..10)\nfunction remap(t, p) { return t * p.speed; }');
    const modules = new Map([['remap-speed', speed]]);
    assert.equal(plainSpeed(clip({ remap: { moduleId: 'none', params: {} } }), modules), null);
    assert.equal(plainSpeed(clip({ remap: { moduleId: 'remap-speed', params: {} } }), new Map()), 1);
    assert.equal(plainSpeed(clip({ rate: 1.5, remap: { moduleId: 'remap-speed', params: { speed: 2 } } }), modules), 3);
    assert.equal(plainSpeed(clip({ rate: 1.5, remap: { moduleId: 'remap-none', params: {} } }), modules), 1.5);
    assert.equal(plainSpeed(clip({ remap: { moduleId: 'remap-reverse', params: {} } }), modules), null);
  });

  it('來源時間受 in、rate 與素材尾端限制', () => {
    const modules = new Map<string, Module>();
    const normal = clipSource(clip(), 2, media, modules);
    assert.equal(normal.src, 4);
    assert.ok(Math.abs(normal.rate - 1) < 1e-9);
    assert.ok(Math.abs(clipSource(clip({ rate: 2 }), 1, media, modules).rate - 2) < 1e-9);
    assert.deepEqual(clipSource(clip({ in: 9.9 }), 3, media, modules), { src: 9.98, rate: 0 });
  });

  it('程式執行錯誤時回退原時間並通報', () => {
    const reports: string[] = [];
    setRemapErrorReporter((_id, message) => { if (message) reports.push(message); });
    try {
      const module = moduleOf('unit-throws', 'function remap() { throw new Error("boom"); }');
      const result = clipSource(clip({ remap: { moduleId: module.id, params: {} } }), 1, media, new Map([[module.id, module]]));
      assert.equal(result.src, 3);
      assert.ok(reports.some((message) => message.includes('boom')));
    } finally {
      setRemapErrorReporter(() => {});
    }
  });
});

