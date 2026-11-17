// Saktah renderer: camera, calibration, practice loop and the breath strip.
'use strict';

const { SmartSpectraSDK, ProcessingStatus, ValidationCode, MetricType } = require('@smartspectra/node-sdk/renderer');
const { decodeMetrics } = require('@smartspectra/node-sdk/messages');
const QURAN_TEXT = require('../../assets/quran/quran-uthmani.txt');
const { surahs } = require('../../assets/quran/surahs.json');
const Q = require('../shared/quran');
const B = require('../shared/breath');

const S = 1e6; // µs per second
const nowUs = () => Date.now() * 1000; // SDK timestamps are anchored to this clock
const quran = Q.parseTanzil(QURAN_TEXT);
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
let apiKey = params.get('key') || '';

const AUTO_END_US = 1.8 * S; // silence after reciting that ends a phrase (held vowels can show 1.3 s of still lips)
const SETTLE_US = 8 * S;     // trace needed before calibration
const CUE_US = 3.5 * S;      // one guided breath in or out

/* ------------------------------------------------------------------ */
/* Signals from the SDK                                               */
/* ------------------------------------------------------------------ */

const sig = {
  upper: [], lower: [], talking: [],
  lastT: 0, lastTalkT: 0, firstT: 0,
  validation: { code: null, hint: '' },
  status: ProcessingStatus.kUninitialized,
};
const KEEP_US = 180 * S;

function num(ts) {
  if (ts == null) return 0;
  if (typeof ts === 'number') return ts;
  if (typeof ts === 'bigint') return Number(ts);
  if (typeof ts.toNumber === 'function') return ts.toNumber();
  return Number(ts);
}

function append(arr, items, map) {
  if (!items) return;
  for (const it of items) {
    const t = num(it.timestamp);
    if (!t || (arr.length && t <= arr[arr.length - 1].t)) continue;
    arr.push(map(it, t));
  }
  const cut = (arr.length ? arr[arr.length - 1].t : 0) - KEEP_US;
  let k = 0;
  while (k < arr.length && arr[k].t < cut) k++;
  if (k) arr.splice(0, k);
}

function onMetrics(buf) {
  let m;
  try { m = decodeMetrics(buf); } catch { return; }
  if (!m || m instanceof Uint8Array) return;
  const br = m.breathing || {};
  append(sig.upper, br.upperTrace, (x, t) => ({ t, v: x.value }));
  append(sig.lower, br.lowerTrace, (x, t) => ({ t, v: x.value }));
  append(sig.talking, m.face && m.face.talking, (x, t) => ({ t, detected: !!x.detected }));
  const lu = sig.upper[sig.upper.length - 1];
  if (lu) { sig.lastT = Math.max(sig.lastT, lu.t); if (!sig.firstT) sig.firstT = lu.t; }
  const lt = sig.talking[sig.talking.length - 1];
  if (lt) sig.lastTalkT = lt.t;
}

/* ------------------------------------------------------------------ */
/* SDK lifecycle                                                       */
/* ------------------------------------------------------------------ */

let sdk = null;
let cameraOn = false;

const VALIDATION_TEXT = {
  [ValidationCode.kNoFaceFound]: 'I cannot see a face yet.',
  [ValidationCode.kMultipleFacesFound]: 'More than one face is in view. Practise alone in the frame.',
  [ValidationCode.kFaceNotCentered]: 'Move to the middle of the frame.',
  [ValidationCode.kFaceSizeOutOfRange]: 'Move a little closer or further away.',
  [ValidationCode.kTooDark]: 'It is too dark. Face a window or a lamp.',
  [ValidationCode.kTooBright]: 'It is too bright behind or on you.',
  [ValidationCode.kChestNotVisible]: 'Tilt the camera so your shoulders and upper chest are in view.',
  [ValidationCode.kCameraTuning]: 'The camera is adjusting. Hold still.',
  [ValidationCode.kFrameRateTooLow]: 'The camera is running slowly. More light usually helps.',
  [ValidationCode.kExcessiveMotion]: 'Try to keep still.',
  [ValidationCode.kFaceTooClose]: 'Sit back a little.',
  [ValidationCode.kFaceTooFar]: 'Come a little closer.',
  [ValidationCode.kFaceTooHigh]: 'Lower the camera or sit up less.',
  [ValidationCode.kFaceTooLow]: 'Raise the camera a little.',
  [ValidationCode.kFaceNotForward]: 'Face the screen.',
};

async function startCamera() {
  if (sdk) { try { await sdk.destroy(); } catch {} }
  releaseStream();
  sdk = new SmartSpectraSDK({
    apiKey,
    requestedMetrics: [
      MetricType.CHEST_BREATHING,
      MetricType.ABDOMEN_BREATHING,
      MetricType.BREATHING_RATE,
      MetricType.TALKING,
    ],
    enableTelemetry: false,
  });
  sdk.on('streamAvailable', (stream) => { $('cam-big').srcObject = stream; $('cam-small').srcObject = stream; });
  sdk.on('metrics', onMetrics);
  sdk.on('processingStatus', (st) => { sig.status = st; console.info('status', st); });
  sdk.on('validationStatus', (code, _ts, hint) => {
    if (code !== sig.validation.code) console.info('validation', code, hint);
    sig.validation = { code, hint };
  });
  sdk.on('error', (code, message) => {
    console.error('SmartSpectra error', code, message);
    const keyProblem = /auth|key|401|403/i.test(String(message));
    toast(keyProblem ? 'The SmartSpectra key was not accepted. Check it and try again.'
      : /network/i.test(String(message)) ? 'The connection dropped and breath reading stopped. Press Restart camera when you are back online.'
      : `Camera error: ${message}`);
    // The session has ended on the SDK side: offer a restart instead of
    // listening to a camera that no longer reports.
    cameraOn = false;
    $('btn-stop').textContent = 'Restart camera';
  });
  // Saktah opens the camera itself at 640x480. Every frame travels from this
  // window to the SDK engine, and full 720p frames were too heavy to keep the
  // 25 fps the SDK needs.
  stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { width: { ideal: CAP_W }, height: { ideal: CAP_H }, frameRate: { ideal: 30 } },
  });
  $('cam-big').srcObject = stream;
  $('cam-small').srcObject = stream;
  sdk.useMediaStream(stream);
  await sdk.start();
  cameraOn = true;
  $('btn-stop').textContent = 'Stop camera';
}

// Capture size: 16:9 like the SDK's own default, lighter than 720p.
// Developers can override with ?cap=WxH (main passes SAKTAH_CAPTURE).
const [CAP_W, CAP_H] = (params.get('cap') || '960x540').split('x').map(Number);

let stream = null;
function releaseStream() {
  if (stream) for (const t of stream.getTracks()) t.stop();
  stream = null;
}

// The main process calls this and waits for it before closing the window,
// so the SDK engine is never torn down mid-frame.
window.__saktahShutdown = async () => {
  // stop() resolves once the SDK pipeline has drained; destroying a running
  // session defers native teardown past the moment the app quits.
  if (sdk && cameraOn) { try { await sdk.stop(); } catch {} }
  try { if (sdk) await sdk.destroy(); } catch {}
  sdk = null;
  releaseStream();
  return true;
};

// Developer heartbeat: is data flowing, and how far behind is it?
if (params.get('dev') === '1') {
  let last = { u: 0, l: 0, t: 0 };
  setInterval(() => {
    if (!cameraOn) return;
    const track = stream && stream.getVideoTracks()[0];
    const st = track ? track.getSettings() : {};
    console.info('beat', JSON.stringify({
      screen, status: sig.status, validation: sig.validation.code,
      cap: st.width ? `${st.width}x${st.height}@${Math.round(st.frameRate || 0)}` : null,
      newUpper: sig.upper.length - last.u, newLower: sig.lower.length - last.l, newTalk: sig.talking.length - last.t,
      lagS: sig.lastT ? +((nowUs() - sig.lastT) / S).toFixed(2) : null,
    }));
    last = { u: sig.upper.length, l: sig.lower.length, t: sig.talking.length };
  }, 5000);
}

async function stopCamera() {
  if (!sdk) return;
  try { await sdk.stop(); } catch {}
  releaseStream();
  cameraOn = false;
  $('btn-stop').textContent = 'Start camera';
  toast('Camera stopped. Nothing was saved.');
}

/* ------------------------------------------------------------------ */
/* Screens                                                             */
/* ------------------------------------------------------------------ */

function show(name) {
  for (const el of document.querySelectorAll('.screen')) el.toggleAttribute('data-active', el.id === `screen-${name}`);
  screen = name;
}
let screen = 'welcome';

let toastTimer = null;
function toast(text, ms = 4000) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

/* 1. Welcome --------------------------------------------------------- */

if (!apiKey) $('key-row').hidden = false;

$('btn-consent').addEventListener('click', async () => {
  if (!apiKey) {
    apiKey = $('key-input').value.trim();
    if (!apiKey) { toast('Paste your SmartSpectra API key first.'); $('key-input').focus(); return; }
  }
  $('btn-consent').disabled = true;
  show('setup');
  try {
    await startCamera();
    runCalibration();
  } catch (e) {
    console.error(e);
    toast(`Could not start the camera: ${e.message || e}`, 8000);
    show('welcome');
    $('btn-consent').disabled = false;
  }
});

/* 2. Setup and calibration ------------------------------------------ */

let calib = null; // { channel, polarity, minRise, amplitude, agreement }

function setupText(title, body) { $('setup-title').textContent = title; $('setup-body').textContent = body; }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred, timeoutMs) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) return false;
    await wait(150);
  }
  return true;
}

function hintLoop() {
  const v = sig.validation;
  const el = $('setup-hint');
  if (sig.status !== ProcessingStatus.kRunning) { el.textContent = 'Starting the camera…'; el.classList.remove('warn'); }
  else if (v.code != null && v.code !== ValidationCode.kOk) { el.textContent = VALIDATION_TEXT[v.code] || v.hint || 'Adjusting…'; el.classList.add('warn'); }
  else { el.textContent = 'You are in view. Hold still.'; el.classList.remove('warn'); }
  drawStrip($('setup-strip'), { windowUs: 12 * S, showTalk: false });
  if (screen === 'setup') requestAnimationFrame(hintLoop);
}

async function runCalibration(attempt = 1) {
  requestAnimationFrame(hintLoop);
  $('btn-skip-calib').hidden = true;
  setupText('Sit so your face and shoulders are in view', 'Good, even light on your face works best. Sit still and breathe normally while the camera settles.');
  const settled = await waitFor(() => sig.status === ProcessingStatus.kRunning && sig.firstT && sig.lastT - sig.firstT > SETTLE_US, 45000);
  if (!settled) {
    setupText('The camera has not settled yet', 'Check the hint under the picture. You can keep waiting, or carry on with default settings.');
    $('btn-skip-calib').hidden = false;
    await waitFor(() => sig.lastT - sig.firstT > SETTLE_US, 120000);
  }

  setupText('Two slow breaths', 'Follow the circle: breathe in as it grows, out as it shrinks. This teaches Saktah how your breathing looks on this camera.');
  const cue = $('breath-cue');
  const dot = $('cue-dot');
  cue.hidden = false;
  const phases = [];
  for (let i = 0; i < 2; i++) {
    for (const kind of ['in', 'out']) {
      $('cue-word').textContent = kind === 'in' ? 'Breathe in' : 'Breathe out';
      dot.classList.toggle('big', kind === 'in');
      const from = nowUs();
      await wait(CUE_US / 1000);
      // Leave out the reaction time at the start of each cue.
      phases.push({ kind, from: from + 0.5 * S, to: nowUs() + 0.2 * S });
    }
  }
  cue.hidden = true;
  setupText('Reading your breaths…', 'One moment.');
  await waitFor(() => sig.lastT >= phases[phases.length - 1].to + 0.5 * S, 8000);

  const span = (arr) => arr.filter((x) => x.t >= phases[0].from - 2 * S);
  const options = ['upper', 'lower']
    .map((channel) => ({ channel, c: B.calibrate(span(sig[channel]), phases) }))
    .filter((o) => o.c)
    .sort((a, b) => (b.c.agreement - a.c.agreement) || (b.c.amplitude / (b.c.noise || 1) - a.c.amplitude / (a.c.noise || 1)));
  const best = options[0];
  console.info('calibration options', JSON.stringify(options.map((o) => ({ ch: o.channel, ...o.c }))),
    'samples upper', sig.upper.length, 'talking', sig.talking.length);
  if (best && best.c.agreement >= 0.75) {
    calib = { channel: best.channel, ...best.c };
    console.info('calibration', JSON.stringify(calib));
    setupText('Ready', 'Saktah can see your breathing. Recite a phrase, then stop and breathe. Breaths taken before the stop are marked.');
    await wait(1400);
    enterPractice();
    return;
  }
  if (attempt < 2) {
    setupText('Let us try that once more', 'Make the breaths slow and deep, and keep your shoulders in view.');
    await wait(2200);
    return runCalibration(attempt + 1);
  }
  setupText('Your breathing was hard to read', 'More light on your face and a still posture usually fix this. You can also carry on with default settings, which are less precise.');
  $('btn-skip-calib').hidden = false;
}

$('btn-skip-calib').addEventListener('click', () => {
  // Fallback: threshold from the spread of the trace so far, polarity as reported.
  const tr = sig.upper.slice(-30 * 30);
  const vals = tr.map((x) => x.v).sort((a, b) => a - b);
  const spread = vals.length > 10 ? vals[Math.floor(vals.length * 0.9)] - vals[Math.floor(vals.length * 0.1)] : 1;
  calib = { channel: 'upper', polarity: 1, minRise: Math.max(spread * 0.3, 1e-6), amplitude: spread, agreement: 0, fallback: true };
  enterPractice();
});

/* 3. Practice -------------------------------------------------------- */

const practice = {
  surah: 1,
  mode: 'ayah',
  segments: [],
  order: [],      // indexes into segments being practised
  pos: 0,         // position in order
  results: new Map(), // segment index -> { attempts, firstClean, clean, broken, bestUs }
  phrase: null,   // { idx, from, live: 'waiting'|'reciting'|'checking'|'result', end, verdict, breaths }
};

function fillSurahs() {
  const sel = $('sel-surah');
  sel.innerHTML = '';
  for (const s of surahs) {
    const o = document.createElement('option');
    o.value = s.number;
    o.textContent = `${s.number}. ${s.transliteration} (${s.english})`;
    sel.appendChild(o);
  }
  sel.value = practice.surah;
}

function setMode(mode) {
  practice.mode = mode;
  for (const b of document.querySelectorAll('.seg button')) b.setAttribute('aria-checked', String(b.dataset.mode === mode));
  $('mode-note').textContent = mode === 'ayah'
    ? 'Each whole ayah in one breath. Phrases still break where a stop is compulsory.'
    : 'A phrase at every mark where stopping is allowed. Breathe at the marks, not between them.';
}

function loadSurah(n, only = null) {
  practice.surah = n;
  const meta = surahs[n - 1];
  practice.segments = Q.segmentSurah(quran, n, meta.ayahs, practice.mode);
  practice.order = only || practice.segments.map((s) => s.index);
  practice.pos = 0;
  if (!only) practice.results = new Map();
  armPhrase();
}

function enterPractice() {
  show('practice');
  fillSurahs();
  setMode(practice.mode);
  loadSurah(practice.surah);
  requestAnimationFrame(practiceLoop);
}

function current() { return practice.segments[practice.order[practice.pos]]; }

function armPhrase() {
  const seg = current();
  practice.phrase = { idx: seg.index, from: nowUs(), live: 'waiting', end: null, verdict: null, breaths: [] };
  $('verdict').hidden = true;
  renderMushaf();
  renderRail();
}

function renderMushaf() {
  const seg = current();
  const parts = practice.segments.filter((g) => g.ayah === seg.ayah);
  const box = $('mushaf');
  box.innerHTML = '';
  const p = document.createElement('p');
  p.className = 'ayah-line';
  parts.forEach((g, i) => {
    const span = document.createElement('span');
    span.className = 'seg-text';
    const r = practice.results.get(g.index);
    if (g.index === seg.index) span.classList.add('current');
    if (g.index === seg.index && practice.phrase && practice.phrase.verdict) span.classList.add(practice.phrase.verdict === 'clean' ? 'clean' : practice.phrase.verdict === 'broken' ? 'broken' : 'x');
    else if (r) span.classList.add(r.lastClean ? 'clean' : 'broken');
    span.textContent = g.text;
    p.appendChild(span);
    if (i < parts.length - 1) p.appendChild(document.createTextNode(' '));
  });
  const no = document.createElement('span');
  no.className = 'ayah-no';
  no.textContent = `﴿${Q.arabicNumber(seg.ayah)}﴾`;
  p.appendChild(document.createTextNode(' '));
  p.appendChild(no);
  box.appendChild(p);

  const meta = surahs[seg.surah - 1];
  const partTxt = seg.parts > 1 ? `, phrase ${seg.part} of ${seg.parts}` : '';
  $('where').textContent = `${meta.transliteration} · Ayah ${seg.ayah}${partTxt} · ends at: ${seg.end.name.toLowerCase()}`;
}

function renderRail() {
  let clean = 0, broken = 0;
  for (const r of practice.results.values()) { if (r.lastClean) clean++; else broken++; }
  $('t-clean').textContent = clean;
  $('t-broken').textContent = broken;
  const total = practice.order.length;
  $('progress-bar').style.width = `${(100 * practice.pos) / Math.max(1, total)}%`;
  $('progress-label').textContent = `Phrase ${Math.min(practice.pos + 1, total)} of ${total}`;
}

function setState(text, cls) {
  const el = $('state');
  el.textContent = text;
  el.className = `state ${cls || ''}`;
}

function verdict(text, cls) {
  const el = $('verdict');
  el.textContent = text;
  el.className = `verdict ${cls}`;
  el.hidden = false;
}

function finishPhrase(endT) {
  const ph = practice.phrase;
  if (!ph || ph.live === 'checking' || ph.live === 'result') return;
  ph.live = 'checking';
  ph.end = endT;
  setState('Checking', 'checking');
  const t0 = Date.now();
  const tryEval = () => {
    // Wait until the SDK has delivered the trace a little past the end.
    if (sig.lastT < endT + 0.8 * S && Date.now() - t0 < 4000) { setTimeout(tryEval, 120); return; }
    judge(ph);
  };
  tryEval();
}

function analysisWindow(from, to) {
  const tr = sig[calib.channel].filter((x) => x.t >= from - 3 * S && x.t <= to + 1.5 * S);
  const inhales = tr.length > 5 ? B.findInhales(tr, { polarity: calib.polarity, minRise: calib.minRise }) : [];
  const spans = B.talkingSpans(sig.talking.filter((x) => x.t >= from - 1 * S && x.t <= to + 0.2 * S));
  return { inhales, spans };
}

function judge(ph) {
  if (ph !== practice.phrase) return;
  const { inhales, spans } = analysisWindow(ph.from, ph.end);
  // Even fast recitation takes about this long: a flicker of lip movement
  // is not the whole phrase.
  const words = (current() && current().words) || 1;
  const r = B.evaluatePhrase({ inhales, spans, from: ph.from, to: ph.end, minTalkUs: (0.5 + 0.15 * words) * S });
  console.info('phrase', JSON.stringify({
    idx: ph.idx, status: r.status,
    talkS: r.talkEnd ? +((r.talkEnd - r.talkStart) / S).toFixed(2) : 0,
    spans: spans.length, inhales: inhales.map((b) => +(((b.start + b.peak) / 2 - ph.from) / S).toFixed(2)),
    flagged: r.breaths.length, lagS: +((nowUs() - sig.lastT) / S).toFixed(2),
  }));
  devPhrase(ph, r, inhales, spans);
  ph.live = 'result';
  ph.verdict = r.status;
  ph.breaths = r.breaths;
  const seg = current();

  if (r.status === 'silent' || r.status === 'short') {
    verdict(r.status === 'short'
      ? 'I only saw part of that phrase. Keep your face toward the camera and recite it again.'
      : 'I did not see you recite. Begin whenever you are ready.', 'silent');
    setState('Listening with the camera', '');
    setTimeout(() => { if (practice.phrase === ph) armPhrase(); }, 1800);
    return;
  }

  const durUs = r.talkEnd - r.talkStart;
  const res = practice.results.get(seg.index) || { attempts: 0, firstClean: null, bestUs: 0, brokenCount: 0 };
  res.attempts++;
  if (res.firstClean === null) res.firstClean = r.status === 'clean';
  res.lastClean = r.status === 'clean';
  if (r.status === 'clean') res.bestUs = Math.max(res.bestUs, durUs);
  else res.brokenCount++;
  res.words = seg.words;
  practice.results.set(seg.index, res);
  renderMushaf();
  renderRail();

  if (r.status === 'clean') {
    verdict(`One breath. Held for ${(durUs / S).toFixed(1)} seconds.`, 'clean');
    setState('Well held', '');
    setTimeout(() => { if (practice.phrase === ph) next(); }, 1600);
  } else {
    const at = r.breaths[0];
    const into = ((at.start + at.peak) / 2 - r.talkStart) / S;
    verdict(`A breath ${into.toFixed(1)} seconds in, before the stop. Take a full breath and try the phrase again.`, 'broken');
    setState('Try again', '');
    setTimeout(() => {
      if (practice.phrase !== ph) return;
      // Re-arm on the same phrase but keep the colour until they start again.
      practice.phrase = { idx: seg.index, from: nowUs(), live: 'waiting', end: null, verdict: 'broken', breaths: ph.breaths, retry: true };
      setState('Your turn', '');
    }, 2400);
  }
}

function next() {
  if (practice.pos < practice.order.length - 1) { practice.pos++; armPhrase(); }
  else showSummary();
}
function prev() { if (practice.pos > 0) { practice.pos--; armPhrase(); } }

// Phrase logic runs on a timer so it keeps time even when the window is
// hidden (requestAnimationFrame pauses then). Drawing uses animation frames.
setInterval(() => { if (screen === 'practice') practiceTick(); }, 100);

function practiceLoop() {
  if (screen !== 'practice') return;
  drawStrip($('strip'), { windowUs: 14 * S, showTalk: true, phrase: practice.phrase });
  requestAnimationFrame(practiceLoop);
}

function practiceTick() {
  const ph = practice.phrase;
  if (ph && cameraOn) {
    const spans = B.talkingSpans(sig.talking.filter((x) => x.t >= ph.from));
    const talkingNow = spans.length > 0 && spans[spans.length - 1].open;
    $('live-dot').classList.toggle('talking', talkingNow);
    if (ph.live === 'waiting') {
      setState(ph.retry ? 'Your turn' : 'Recite when ready', '');
      if (spans.length) {
        ph.live = 'reciting';
        if (ph.retry) { ph.verdict = null; $('verdict').hidden = true; renderMushaf(); }
      }
    }
    if (ph.live === 'reciting') {
      setState('Reciting', 'reciting');
      const last = spans[spans.length - 1];
      // The SDK clock: whichever stream has reached furthest.
      const clock = Math.max(sig.lastT, sig.lastTalkT);
      if (last && !last.open && clock - last.end >= AUTO_END_US) finishPhrase(last.end + 0.1 * S);
      // Talking updates stopped while "talking": treat the last update as the end.
      else if (last && last.open && sig.lastT - sig.lastTalkT >= AUTO_END_US) finishPhrase(sig.lastTalkT);
    }
    const v = sig.validation;
    const hint = v.code != null && v.code !== ValidationCode.kOk ? (VALIDATION_TEXT[v.code] || v.hint) : '';
    if ($('practice-hint').textContent !== hint) $('practice-hint').textContent = hint;
  } else if (!cameraOn) {
    setState('Camera off', '');
  }
}

$('sel-surah').addEventListener('change', (e) => { loadSurah(Number(e.target.value)); e.target.blur(); });
for (const b of document.querySelectorAll('.seg button')) {
  b.addEventListener('click', () => { setMode(b.dataset.mode); loadSurah(practice.surah); });
}
$('btn-finish').addEventListener('click', () => showSummary());
$('btn-stop').addEventListener('click', async () => {
  if (cameraOn) await stopCamera();
  else { try { await startCamera(); armPhrase(); } catch (e) { toast(`Could not start the camera: ${e.message || e}`); } }
});

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'e') { exportSignals(); return; }
  if (screen !== 'practice' || e.target.tagName === 'SELECT') return;
  if (e.code === 'Space') {
    e.preventDefault();
    const ph = practice.phrase;
    if (ph && (ph.live === 'reciting' || ph.live === 'waiting')) finishPhrase(nowUs());
  } else if (e.key === 'r' || e.key === 'R') armPhrase();
  else if (e.key === 'ArrowLeft') next();   // right-to-left text: left moves forward
  else if (e.key === 'ArrowRight') prev();
});

/* 4. Summary --------------------------------------------------------- */

function showSummary() {
  const meta = surahs[practice.surah - 1];
  const done = [...practice.results.entries()];
  const first = done.filter(([, r]) => r.firstClean).length;
  let longest = null;
  for (const [i, r] of done) if (r.bestUs && (!longest || r.bestUs > longest.r.bestUs)) longest = { i, r };
  const retry = done.filter(([, r]) => r.brokenCount > 0);

  $('sum-title').textContent = `${meta.transliteration}: ${done.length} phrase${done.length === 1 ? '' : 's'} recited`;
  $('sum-first').textContent = done.length ? `${first} of ${done.length}` : '0';
  $('sum-longest').textContent = longest ? `${(longest.r.bestUs / S).toFixed(1)} s` : 'None yet';
  $('sum-retry').textContent = String(retry.length);

  const list = $('sum-list');
  list.innerHTML = '';
  for (const [i, r] of retry) {
    const g = practice.segments[i];
    const row = document.createElement('div');
    row.className = 'row';
    const t = document.createElement('span');
    t.textContent = g.text;
    const meta2 = document.createElement('span');
    meta2.className = 'meta';
    meta2.textContent = `Ayah ${g.ayah} · ${r.brokenCount} of ${r.attempts} with a breath`;
    row.append(t, meta2);
    list.appendChild(row);
  }
  $('btn-again').disabled = retry.length === 0;
  $('btn-again').onclick = () => { show('practice'); loadSurah(practice.surah, retry.map(([i]) => i)); requestAnimationFrame(practiceLoop); };
  show('summary');
}

$('btn-new').addEventListener('click', () => { show('practice'); loadSurah(practice.surah); requestAnimationFrame(practiceLoop); });

/* ------------------------------------------------------------------ */
/* Breath strip                                                        */
/* ------------------------------------------------------------------ */

function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

function drawStrip(canvas, { windowUs, showTalk, phrase }) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const channel = calib ? calib.channel : 'upper';
  const pol = calib ? calib.polarity : 1;
  const end = sig.lastT || nowUs();
  const start = end - windowUs;
  const x = (t) => ((t - start) / windowUs) * w;
  const tr = sig[channel].filter((p) => p.t >= start);

  if (showTalk) {
    ctx.fillStyle = cssVar('--talk');
    for (const sp of B.talkingSpans(sig.talking.filter((p) => p.t >= start - 2 * S))) {
      const a = Math.max(0, x(sp.start)), b = Math.min(w, x(sp.end));
      if (b > a) ctx.fillRect(a, 0, b - a, h);
    }
  }

  if (phrase) {
    ctx.strokeStyle = cssVar('--rule');
    ctx.lineWidth = 1;
    for (const t of [phrase.from, phrase.end].filter(Boolean)) {
      if (t < start) continue;
      ctx.beginPath(); ctx.moveTo(x(t), 0); ctx.lineTo(x(t), h); ctx.stroke();
    }
  }

  if (tr.length < 2) {
    ctx.fillStyle = cssVar('--muted');
    ctx.font = '13px ' + cssVar('--sans');
    ctx.fillText('Waiting for your breathing…', 12, h / 2);
    return;
  }
  const vals = tr.map((p) => pol * p.v).sort((a, b) => a - b);
  const lo = vals[Math.floor(vals.length * 0.02)], hi = vals[Math.floor(vals.length * 0.98)];
  const pad = (hi - lo) * 0.15 || 1;
  const y = (v) => h - 8 - ((pol * v - (lo - pad)) / ((hi + pad) - (lo - pad))) * (h - 16);

  ctx.strokeStyle = cssVar('--line');
  ctx.lineWidth = 1.6;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  tr.forEach((p, i) => { const px = x(p.t), py = y(p.v); if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); });
  ctx.stroke();

  if (calib && showTalk) {
    const inh = B.findInhales(tr, { polarity: calib.polarity, minRise: calib.minRise });
    const flagged = new Set((phrase && phrase.breaths || []).map((b) => b.start));
    for (const b of inh) {
      const a = x(b.start), c = x(b.peak);
      const isBad = flagged.has(b.start);
      ctx.fillStyle = isBad ? cssVar('--broken') : cssVar('--muted');
      ctx.globalAlpha = isBad ? 0.9 : 0.35;
      ctx.fillRect(a, h - 6, Math.max(3, c - a), 6);
      ctx.globalAlpha = 1;
      if (isBad) {
        ctx.beginPath(); ctx.moveTo((a + c) / 2, 4); ctx.lineTo((a + c) / 2 - 6, -4 + 14); ctx.lineTo((a + c) / 2 + 6, -4 + 14); ctx.closePath(); ctx.fill();
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Developer export (Ctrl+Shift+E): breathing trace and talking flags   */
/* only, for tuning. No video or images exist to export.               */
/* ------------------------------------------------------------------ */

// Dev mode only (main sets ?dev=1 when SAKTAH_DEV=1). Lines go out on the
// console channel and the main process appends them to ./recordings.
const DEV = params.get('dev') === '1';
const pack = (arr, k) => arr.map((x) => [x.t, k === 'detected' ? (x.detected ? 1 : 0) : +x.v.toFixed(4)]);

function devPhrase(ph, r, inhales, spans) {
  if (!DEV) return;
  const from = ph.from - 3 * S, to = ph.end + 1.5 * S;
  const win = (arr) => arr.filter((x) => x.t >= from && x.t <= to);
  console.info('SAKTAH_PHRASE ' + JSON.stringify({
    idx: ph.idx, seg: current() && { surah: current().surah, ayah: current().ayah, part: current().part, words: current().words },
    from: ph.from, end: ph.end, status: r.status, breaths: r.breaths, talkStart: r.talkStart, talkEnd: r.talkEnd,
    inhales, spans, calib,
    upper: pack(win(sig.upper)), lower: pack(win(sig.lower)), talking: pack(win(sig.talking), 'detected'),
  }));
}

function exportSignals() {
  if (!DEV) return;
  console.info('SAKTAH_EXPORT ' + JSON.stringify({
    exportedAt: new Date().toISOString(), calib,
    upper: pack(sig.upper), lower: pack(sig.lower), talking: pack(sig.talking, 'detected'),
    results: [...practice.results.entries()],
  }));
  toast('Signals written to recordings.');
}

// Developer preview without a camera or key: ?demo=1 shows the practice
// screen; ?demo=sim also feeds a scripted, clearly synthetic signal so the
// practice loop can be exercised. Never used for the real app or the video.
if (params.get('demo')) {
  calib = { channel: 'upper', polarity: 1, minRise: 0.3 };
  enterPractice();
  if (params.get('demo') === 'sim') startSimulator();
}

function startSimulator() {
  cameraOn = true;
  // Script of legs: [level, seconds, talking]. Alternates a clean phrase and
  // one with a breath in the middle.
  const clean = [[0, 1.2, false], [1, 0.7, false], [0.1, 3.8, true], [0.1, 1.8, false]];
  const broken = [[1, 0.7, false], [0.5, 1.8, true], [1, 0.6, false], [0.1, 2.0, true], [0.1, 1.8, false]];
  const script = [...clean, ...broken];
  let leg = 0, legT = 0, level = 0, from = 0;
  let t = nowUs();
  sig.firstT = t;
  setInterval(() => {
    // Catch up to the wall clock at 30 samples a second, even if timers were throttled.
    while (t + S / 30 <= nowUs()) {
      const [to, dur, talking] = script[leg];
      legT += 1 / 30;
      level = from + (to - from) * Math.min(1, legT / dur);
      t += S / 30;
      sig.upper.push({ t, v: level + (Math.random() - 0.5) * 0.03 });
      sig.talking.push({ t, detected: talking });
      sig.lastT = t; sig.lastTalkT = t;
      if (legT >= dur) { leg = (leg + 1) % script.length; legT = 0; from = level; }
    }
    for (const a of [sig.upper, sig.talking]) if (a.length > 6000) a.splice(0, a.length - 6000);
  }, 100);
}
