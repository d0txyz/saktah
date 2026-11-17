// Breath detection for recitation practice.
//
// Inputs come straight from the SmartSpectra SDK, aligned by the SDK's own
// capture timestamps (microseconds):
//   trace:   [{ t, v }]          chest or abdomen breathing movement trace
//   talking: [{ t, detected }]   talking detection updates
//
// The rule being trained: in tajwid you only take a breath at a permitted stop.
// A pause in the middle of a phrase is fine if no breath is taken (a saktah);
// a breath taken while the phrase is still going breaks it.
'use strict';

const MS = 1000; // microseconds per millisecond

// Moving average over a time window. Keeps the timestamps.
function smooth(samples, windowUs = 150 * MS) {
  const out = new Array(samples.length);
  let lo = 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i].v;
    while (samples[i].t - samples[lo].t > windowUs) sum -= samples[lo++].v;
    out[i] = { t: samples[i].t, v: sum / (i - lo + 1) };
  }
  return out;
}

// Zigzag pivots with a hysteresis of `h`, on a trace oriented so that
// breathing in makes the value go up.
function pivots(samples, polarity, h) {
  const out = [];
  if (samples.length === 0) return { pivots: out, dir: 0, ext: null };
  let dir = 0;
  let ext = polarity * samples[0].v;
  let extIdx = 0;
  let lo = ext, loIdx = 0, hi = ext, hiIdx = 0;
  for (let i = 1; i < samples.length; i++) {
    const v = polarity * samples[i].v;
    if (dir === 0) {
      if (v > hi) { hi = v; hiIdx = i; }
      if (v < lo) { lo = v; loIdx = i; }
      if (hi - lo >= h) {
        // First swing decides the starting direction.
        if (hiIdx > loIdx) { out.push({ type: 'min', i: loIdx, t: samples[loIdx].t, v: lo }); dir = 1; ext = hi; extIdx = hiIdx; }
        else { out.push({ type: 'max', i: hiIdx, t: samples[hiIdx].t, v: hi }); dir = -1; ext = lo; extIdx = loIdx; }
      }
      continue;
    }
    if (dir === 1) {
      if (v > ext) { ext = v; extIdx = i; }
      else if (ext - v >= h) {
        out.push({ type: 'max', i: extIdx, t: samples[extIdx].t, v: ext });
        dir = -1; ext = v; extIdx = i;
      }
    } else {
      if (v < ext) { ext = v; extIdx = i; }
      else if (v - ext >= h) {
        out.push({ type: 'min', i: extIdx, t: samples[extIdx].t, v: ext });
        dir = 1; ext = v; extIdx = i;
      }
    }
  }
  return { pivots: out, dir, ext: dir === 0 ? null : { i: extIdx, t: samples[extIdx].t, v: ext } };
}

// Inhales = rises from a trough to the next peak.
// `provisional` marks the last rise when its peak is not confirmed yet.
function findInhales(trace, { polarity = 1, minRise, minDurUs = 200 * MS, maxDurUs = 4000 * MS, smoothUs = 150 * MS } = {}) {
  if (!(minRise > 0)) throw new Error('findInhales needs a positive minRise');
  const s = smooth(trace, smoothUs);
  const { pivots: p, dir, ext } = pivots(s, polarity, minRise);
  const out = [];
  const consider = (min, max, provisional) => {
    const rise = max.v - min.v;
    const dur = max.t - min.t;
    if (rise >= minRise && dur >= minDurUs && dur <= maxDurUs) {
      out.push({ start: min.t, peak: max.t, rise, provisional });
    }
  };
  for (let k = 0; k + 1 < p.length; k++) {
    if (p[k].type === 'min' && p[k + 1].type === 'max') consider(p[k], p[k + 1], false);
  }
  const last = p[p.length - 1];
  if (dir === 1 && last && last.type === 'min' && ext) consider(last, ext, true);
  return out;
}

// Talking spans [{ start, end }] from detection updates. A span still open at
// the last update ends at that update's time.
function talkingSpans(talking) {
  const spans = [];
  let open = null;
  for (const u of talking) {
    if (u.detected && open == null) open = u.t;
    else if (!u.detected && open != null) { spans.push({ start: open, end: u.t }); open = null; }
  }
  if (open != null && talking.length) spans.push({ start: open, end: talking[talking.length - 1].t, open: true });
  return spans;
}

// Judge one phrase.
//   from, to: when the phrase was on screen (SDK clock, µs)
//   minTalkUs: reciting shorter than this cannot be the whole phrase
// Returns { status: 'clean' | 'broken' | 'short' | 'silent', breaths, talkStart, talkEnd }
function evaluatePhrase({ inhales, spans, from, to, graceUs = 250 * MS, minTalkUs = 0 }) {
  const inside = spans.filter((sp) => sp.end > from && sp.start < to);
  if (inside.length === 0) return { status: 'silent', breaths: [], talkStart: null, talkEnd: null };
  const talkStart = Math.max(from, inside[0].start);
  const talkEnd = Math.min(to, inside[inside.length - 1].end);
  const breaths = inhales.filter((b) => {
    const mid = (b.start + b.peak) / 2;
    return mid > talkStart + graceUs && mid < talkEnd - graceUs;
  });
  // A breath inside the reciting is a break however long it was; with no
  // breath, a too-short stretch of lip movement is not a clean phrase.
  const status = breaths.length ? 'broken' : talkEnd - talkStart < minTalkUs ? 'short' : 'clean';
  return { status, breaths, talkStart, talkEnd };
}

// Calibration from guided breaths.
//   phases: [{ kind: 'in' | 'out', from, to }]
// Returns { polarity, amplitude, minRise, agreement } or null if unusable.
function calibrate(trace, phases, { smoothUs = 150 * MS, riseFraction = 0.3 } = {}) {
  const s = smooth(trace, smoothUs);
  const delta = (from, to) => {
    const pts = s.filter((x) => x.t >= from && x.t <= to);
    if (pts.length < 3) return null;
    return pts[pts.length - 1].v - pts[0].v;
  };
  const ins = [], outs = [];
  for (const ph of phases) {
    const d = delta(ph.from, ph.to);
    if (d == null) continue;
    (ph.kind === 'in' ? ins : outs).push(d);
  }
  if (ins.length === 0 || outs.length === 0) return null;
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const polarity = mean(ins) - mean(outs) >= 0 ? 1 : -1;
  const agree = [...ins.map((d) => Math.sign(d) === polarity), ...outs.map((d) => Math.sign(d) === -polarity)];
  const agreement = agree.filter(Boolean).length / agree.length;
  const amps = [...ins, ...outs].map(Math.abs).sort((a, b) => a - b);
  const amplitude = amps[Math.floor(amps.length / 2)];
  // Noise floor: what is left after smoothing, over the whole calibration.
  const resid = trace.map((x, i) => x.v - s[i].v);
  const sd = Math.sqrt(mean(resid.map((r) => r * r)));
  const minRise = Math.max(riseFraction * amplitude, 4 * sd);
  if (!(amplitude > 0)) return null;
  return { polarity, amplitude, minRise, agreement, noise: sd };
}

module.exports = { MS, smooth, pivots, findInhales, talkingSpans, evaluatePhrase, calibrate };
