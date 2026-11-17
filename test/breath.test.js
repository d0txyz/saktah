'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MS, findInhales, talkingSpans, evaluatePhrase, calibrate } = require('../src/shared/breath');

const S = 1000 * MS;
const FPS = 30;
const T0 = 1_763_300_000_000_000; // an epoch-like start in µs

// Deterministic noise.
function rng(seed) {
  let x = seed;
  return () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648) - 0.5;
}

// Build a trace from a list of legs: { to: level, dur: seconds }.
// Polarity -1 flips the sign so "breathing in" goes down, like some cameras.
function buildTrace(legs, { polarity = 1, noise = 0.02, start = 0 } = {}) {
  const r = rng(7);
  const out = [];
  let level = start;
  let t = T0;
  for (const leg of legs) {
    const n = Math.max(1, Math.round(leg.dur * FPS));
    const from = level;
    for (let k = 1; k <= n; k++) {
      level = from + (leg.to - from) * (k / n);
      t += S / FPS;
      out.push({ t: Math.round(t), v: polarity * level + noise * r() });
    }
  }
  return out;
}

// Talking updates from spans given in seconds from T0.
function talk(spans) {
  const out = [{ t: T0, detected: false }];
  for (const [a, b] of spans) {
    out.push({ t: T0 + a * S, detected: true });
    out.push({ t: T0 + b * S, detected: false });
  }
  return out;
}

// One recited phrase: inhale (0.7 s), then a slow exhale while speaking.
const phrase = (speak) => [{ to: 1, dur: 0.7 }, { to: 0, dur: speak }];

test('finds each quick inhale before a long spoken exhale', () => {
  const trace = buildTrace([{ to: 0, dur: 1 }, ...phrase(4), ...phrase(5), ...phrase(3), { to: 0, dur: 1 }]);
  const inh = findInhales(trace, { minRise: 0.3 });
  assert.equal(inh.length, 3);
});

test('works when the camera trace is upside down', () => {
  const trace = buildTrace([{ to: 0, dur: 1 }, ...phrase(4), ...phrase(4), { to: 0, dur: 1 }], { polarity: -1 });
  assert.equal(findInhales(trace, { polarity: -1, minRise: 0.3 }).length, 2);
  // With the wrong polarity it would see the exhales instead; calibration fixes that.
});

test('noise and small wobbles are not breaths', () => {
  const legs = [{ to: 0, dur: 1 }];
  for (let i = 0; i < 20; i++) legs.push({ to: 0.08, dur: 0.15 }, { to: 0, dur: 0.15 });
  const trace = buildTrace(legs, { noise: 0.05 });
  assert.equal(findInhales(trace, { minRise: 0.3 }).length, 0);
});

test('a phrase recited in one breath is clean', () => {
  // Breath in at 1.0-1.7 s, recite 1.8-5.6 s, breathe again at the stop.
  const trace = buildTrace([{ to: 0, dur: 1 }, ...phrase(4), { to: 1, dur: 0.7 }, { to: 0.6, dur: 1 }]);
  const spans = talkingSpans(talk([[1.8, 5.6]]));
  const r = evaluatePhrase({ inhales: findInhales(trace, { minRise: 0.3 }), spans, from: T0 + 1.5 * S, to: T0 + 7.5 * S });
  assert.equal(r.status, 'clean');
});

test('a breath taken in the middle of the phrase breaks it', () => {
  // Recite 1.8-3.6, gasp at 3.6-4.2 (quick inhale), carry on 4.3-6.5.
  const trace = buildTrace([{ to: 0, dur: 1 }, { to: 1, dur: 0.7 }, { to: 0.5, dur: 1.9 }, { to: 1, dur: 0.6 }, { to: 0, dur: 2.3 }, { to: 0.4, dur: 1 }]);
  const spans = talkingSpans(talk([[1.8, 3.6], [4.3, 6.5]]));
  const inhales = findInhales(trace, { minRise: 0.3 });
  const r = evaluatePhrase({ inhales, spans, from: T0 + 1.5 * S, to: T0 + 8 * S });
  assert.equal(r.status, 'broken');
  assert.equal(r.breaths.length, 1);
  const mid = (r.breaths[0].start + r.breaths[0].peak) / 2;
  assert.ok(mid > T0 + 3.5 * S && mid < T0 + 4.4 * S, 'breath marked where it happened');
});

test('a pause without a breath (a saktah) stays clean', () => {
  // Recite 1.8-3.6, hold still 3.6-4.2 with no breath, carry on 4.2-6.5.
  const trace = buildTrace([{ to: 0, dur: 1 }, { to: 1, dur: 0.7 }, { to: 0.55, dur: 1.9 }, { to: 0.55, dur: 0.6 }, { to: 0, dur: 2.3 }, { to: 0.8, dur: 0.7 }]);
  const spans = talkingSpans(talk([[1.8, 3.6], [4.2, 6.5]]));
  const r = evaluatePhrase({ inhales: findInhales(trace, { minRise: 0.3 }), spans, from: T0 + 1.5 * S, to: T0 + 8 * S });
  assert.equal(r.status, 'clean');
});

test('the breath at the stop itself is never counted against you', () => {
  // Phrase ends at 5.6 and the breath starts right at the stop.
  const trace = buildTrace([{ to: 0, dur: 1 }, ...phrase(4.1), { to: 1, dur: 0.6 }, { to: 0.9, dur: 1 }]);
  const spans = talkingSpans(talk([[1.8, 5.75]]));
  const r = evaluatePhrase({ inhales: findInhales(trace, { minRise: 0.3 }), spans, from: T0 + 1.5 * S, to: T0 + 7.5 * S });
  assert.equal(r.status, 'clean');
});

test('no talking while the phrase was up means nothing to judge', () => {
  const trace = buildTrace([{ to: 0, dur: 1 }, ...phrase(4)]);
  const r = evaluatePhrase({ inhales: findInhales(trace, { minRise: 0.3 }), spans: [], from: T0, to: T0 + 6 * S });
  assert.equal(r.status, 'silent');
});

test('calibration finds the polarity and a sensible threshold', () => {
  for (const polarity of [1, -1]) {
    // Two guided cycles: in 3 s, out 3 s.
    const trace = buildTrace([{ to: 0, dur: 1 }, { to: 1.2, dur: 3 }, { to: 0, dur: 3 }, { to: 1.1, dur: 3 }, { to: 0, dur: 3 }], { polarity, noise: 0.03 });
    const phases = [
      { kind: 'in', from: T0 + 1 * S, to: T0 + 4 * S },
      { kind: 'out', from: T0 + 4 * S, to: T0 + 7 * S },
      { kind: 'in', from: T0 + 7 * S, to: T0 + 10 * S },
      { kind: 'out', from: T0 + 10 * S, to: T0 + 13 * S },
    ];
    const c = calibrate(trace, phases);
    assert.equal(c.polarity, polarity);
    assert.equal(c.agreement, 1);
    assert.ok(c.minRise > 0.2 && c.minRise < 0.6, `minRise ${c.minRise}`);
  }
});

test('an unfinished rise at the end is reported as provisional', () => {
  const trace = buildTrace([{ to: 0, dur: 1 }, { to: 1, dur: 0.8 }]);
  const inh = findInhales(trace, { minRise: 0.3 });
  assert.equal(inh.length, 1);
  assert.equal(inh[0].provisional, true);
});

test('evaluatePhrase: too little reciting is short, not clean', () => {
  const S = 1e6;
  const spans = [{ start: 1 * S, end: 1.3 * S }];
  const r = evaluatePhrase({ inhales: [], spans, from: 0, to: 5 * S, minTalkUs: 1.5 * S });
  assert.equal(r.status, 'short');
  const brk = evaluatePhrase({ inhales: [{ start: 1.1 * S, peak: 1.2 * S, rise: 5 }], spans: [{ start: 0.5 * S, end: 1.6 * S }], from: 0, to: 5 * S, minTalkUs: 3 * S });
  assert.equal(brk.status, 'broken');
});
