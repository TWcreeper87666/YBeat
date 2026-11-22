import { beatTimeF, speedCurve, speedSourceAt, type SpeedVariant } from '../src/engine/speedRamp';

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
if (fails) process.exit(1);
