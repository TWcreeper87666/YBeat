import { beatTimeF, slowOrReverseSpans, speedCurve, speedSourceAt, type SpeedVariant } from '../src/engine/speedRamp';

let fails = 0;
const ok = (condition: boolean, message: string) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${message}`);
  if (!condition) fails++;
};
const T = (beat: number) => beat < 4 ? beat * 0.5 : 2 + (beat - 4) * 0.6;
ok(Math.abs(beatTimeF(T, 4.5) - 2.3) < 1e-9 && Math.abs(beatTimeF(T, 8.5) - 4.7) < 1e-9,
  'fractional beat interpolation and extrapolation');

for (const variant of ['beatPulse', 'hitRamp', 'drift', 'holdHit'] as SpeedVariant[]) {
  for (const intensity of [0, 0.5, 1]) {
    const speed = speedCurve(variant, 0, 8, T, intensity, { hitBeat: 6 });
    ok(!!speed, `${variant} produces a curve`);
    if (!speed) continue;
    const D = T(8) - T(0);
    const dt = D / 1000;
    const values = Array.from({ length: 1001 }, (_, i) => speedSourceAt(speed, 0, T, i * dt));
    const rates = values.slice(1).map((value, i) => (value - values[i]) / dt);
    ok(values.every(Number.isFinite) && rates.every((v) => v >= -1e-7 && v <= 4.02), `${variant} finite and forward`);
    ok(rates.every((v) => v === 0 || v >= 0.245), `${variant} respects minimum speed`);
    ok(Math.abs(values[0] - speed.sourceMin) < 1e-9 && Math.abs(values.at(-1)! - speed.sourceMax) < 1e-8,
      `${variant} window matches endpoints`);
    if (variant === 'beatPulse') {
      const atRate = (t: number) => (speedSourceAt(speed, 0, T, t + dt) - speedSourceAt(speed, 0, T, t)) / dt;
      ok(atRate(T(2)) > atRate((T(2) + T(3)) / 2) * 1.4, 'pulse peaks at a beat');
    }
    if (variant === 'hitRamp') {
      const early = rates[Math.floor((T(7) + 0.1) / dt)];
      const late = rates[Math.floor((D - 0.01) / dt)];
      ok(late > early + 0.4 && late > 1.9, 'ramp peaks at cut');
    }
    if (variant === 'drift') ok(speed.sourceMax / D <= 0.75 + 1e-8 && speed.sourceMax / D >= 0.5 - 1e-8,
      'drift average speed');
    if (variant === 'holdHit') {
      const frozen = speedSourceAt(speed, 0, T, T(6));
      ok(speed.knots[1].ease === 'hold' && speed.knots[1].source === speed.knots[2].source &&
        [6.05, 6.1, 6.2].every((b) => Math.abs(speedSourceAt(speed, 0, T, beatTimeF(T, b)) - frozen) < 1e-9),
      'hold is exact without a jump');
    }
  }
}
ok(speedCurve('beatPulse', 0, 1, T, 1) === null && speedCurve('drift', 0, 3, T, 1) === null &&
  speedCurve('holdHit', 0, 4, T, 1) === null, 'short and missing-hit curves rejected');

const reverseVariants: SpeedVariant[] = ['rewindToCut', 'reverseForwardB', 'rewindReturn', 'beatBoomerang'];
for (const variant of reverseVariants) for (const intensity of [0, 0.5, 1]) {
  const b1 = variant === 'beatBoomerang' ? 4 : 8;
  const curve = speedCurve(variant, 0, b1, T, intensity)!;
  ok(!!curve, `${variant} produces a curve`);
  const D = T(b1), dt = D / 10000;
  const values = Array.from({ length: 10001 }, (_, i) => speedSourceAt(curve, 0, T, i * dt));
  const rates = values.slice(1).map((v, i) => (v - values[i]) / dt);
  ok(rates.every((v) => Number.isFinite(v) && Math.abs(v) <= 4.02), `${variant} speed bound`);
  ok(Math.abs(Math.min(...values) - curve.sourceMin) < 0.001 &&
    Math.abs(Math.max(...values) - curve.sourceMax) < 0.001, `${variant} full curve bounds`);
  ok(curve.knots.every((k, i) => i === 0 ||
    Math.abs(speedSourceAt(curve, 0, T, beatTimeF(T, k.beat)) - k.source) < 1e-6), `${variant} continuous knots`);
  ok(slowOrReverseSpans(curve, 0, T).some((span) => span.t1 > span.t0), `${variant} slow or reverse spans`);
  const rateAt = (beat: number) => {
    const t = beatTimeF(T, beat);
    return (speedSourceAt(curve, 0, T, t + 0.0001) - speedSourceAt(curve, 0, T, t - 0.0001)) / 0.0002;
  };
  if (variant === 'rewindToCut') {
    const turn = b1 - (intensity < 0.5 ? 1 : 2);
    ok(Math.abs(rateAt(turn)) < 0.02 && curve.sourceMin === 0, 'rewind cut turn and start bound');
    ok(rates.at(-1)! < 0 && Math.abs(rates.at(-1)!) >= Math.max(...rates.filter((v) => v < 0).map(Math.abs)) - 0.02,
      'rewind fastest at cut');
  }
  if (variant === 'reverseForwardB') {
    ok(Math.abs(speedSourceAt(curve, 0, T, T(1))) < 1e-8 && curve.sourceMin === 0 && Math.abs(rateAt(1)) < 0.02,
      'reverse forward turns at beat one');
  }
  if (variant === 'rewindReturn') {
    ok(Math.abs(rateAt(4)) < 0.02 && Math.abs(rateAt(5)) < 0.02, 'rewind return turns on beats');
  }
  if (variant === 'beatBoomerang') for (let beat = 0; beat < b1; beat++) {
    const gain = speedSourceAt(curve, 0, T, T(beat + 1)) - speedSourceAt(curve, 0, T, T(beat));
    const q = T(beat + 1) - T(beat);
    ok(gain >= 0.25 * q - 1e-8 && gain <= 0.5 * q + 1e-8 &&
      Math.abs(rateAt(beat + 0.5)) < 0.02 && Math.abs(rateAt(beat + 0.75)) < 0.02,
    `boomerang beat ${beat} turn and gain`);
  }
}
ok(speedCurve('rewindToCut', 0, 2, T, 1) === null && speedCurve('reverseForwardB', 0, 2, T, 1) === null &&
  speedCurve('rewindReturn', 0, 3, T, 1) === null && speedCurve('beatBoomerang', 0, 5, T, 1) === null,
  'reverse variant length limits');

for (const variant of ['slowPocket', 'tapeStop', 'whooshRamp', 'beatStutter'] as const) {
  for (const intensity of [0.25, 0.8]) {
    const curve = speedCurve(variant, 0, 8, T, intensity)!;
    ok(!!curve, `${variant} produces a curve`);
    const end = T(8), dt = end / 20000;
    const values = Array.from({ length: 20001 }, (_, i) => speedSourceAt(curve, 0, T, i * dt));
    const rates = values.slice(1).map((v, i) => (v - values[i]) / dt);
    ok(values.every(Number.isFinite) && rates.every((v) => Number.isFinite(v) &&
      (variant === 'beatStutter' || v >= -1e-7) && (variant === 'beatStutter' || v <= 4.02)),
    `${variant} finite and bounded outside jumps`);
    ok(Math.abs(Math.min(...values) - curve.sourceMin) < 0.002 &&
      Math.abs(Math.max(...values) - curve.sourceMax) < 0.002, `${variant} source window`);
    if (variant === 'slowPocket') {
      ok(Math.abs(curve.sourceMax - end) < 1e-8 &&
        rates.every((v) => v >= 0.39 && v <= 2.02), 'pocket keeps average and speed bounds');
      ok(rates[Math.floor(T(2) / dt)] > rates[Math.floor((T(2) + T(3)) / (2 * dt))],
        'pocket bursts around beats');
    } else if (variant === 'tapeStop') {
      const hold = curve.knots.at(-2)!;
      ok(hold.ease === 'hold' && hold.source === curve.knots.at(-1)!.source &&
        Math.abs(speedSourceAt(curve, 0, T, end - 0.01) - hold.source) < 1e-9,
      'tape stop ends in an exact hold');
      ok(slowOrReverseSpans(curve, 0, T).some((span) => span.t1 >= end - 0.01),
        'tape stop uses frame cache');
    } else if (variant === 'whooshRamp') {
      const rateAt = (t: number) => (speedSourceAt(curve, 0, T, t) - speedSourceAt(curve, 0, T, t - 1e-5)) / 1e-5;
      ok(Math.abs(rateAt(T(7.5)) - 1) < 0.02 &&
        Math.abs(rateAt(end) - (2.5 + 1.5 * intensity)) < 0.02,
      'whoosh accelerates from half beat to cut');
    } else {
      const jumps = curve.knots.slice(0, -1).flatMap((k, i) =>
        curve.knots[i + 1].source < k.source ? [[k, curve.knots[i + 1]]] : []);
      const repeats = intensity < 0.5 ? 2 : 4;
      const slice = curve.sourceMax - speedSourceAt(curve, 0, T, T(7));
      ok(jumps.length === repeats - 1 && jumps.every(([a, b]) =>
        Math.abs(beatTimeF(T, b.beat) - beatTimeF(T, a.beat) - 1e-3) < 1e-9 &&
        Math.abs(a.source - curve.sourceMax) < 1e-8 && Math.abs(b.source - (curve.sourceMax - slice)) < 1e-8),
      'stutter repeats identical ranges with millisecond jumps');
      const spans = slowOrReverseSpans(curve, 0, T);
      ok(jumps.every(([a]) => spans.some((span) => span.t0 <= beatTimeF(T, a.beat) + 1e-5 &&
        span.t1 >= beatTimeF(T, a.beat) + 1e-3 - 1e-5)), 'every stutter jump uses frame cache');
      ok(rates.filter((v) => v < -4).length > 0 && rates.filter((v) => v > 4.02).length === 0,
        'large speed occurs only on backward jumps');
    }
  }
}
ok(speedCurve('slowPocket', 0, 1, T, 1) === null && !!speedCurve('tapeStop', 0, 1, T, 1) &&
  speedCurve('beatStutter', 0, 1, T, 1) === null && !!speedCurve('whooshRamp', 0, 1, T, 1),
  'phase two minimum lengths（卡帶停 1 拍也可以）');
{
  const one = speedCurve('tapeStop', 0, 1, T, 1)!;
  const hold = one.knots.find((k) => k.ease === 'hold')!;
  ok(one.knots[0].beat === 0 && one.knots[0].source === 0 && hold.beat === 0.75 && one.knots.at(-1)!.source === hold.source,
    '1 拍的卡帶停：一開始就減速，最後 1/4 拍停住');
}
if (fails) process.exit(1);
