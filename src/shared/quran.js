// Qur'an text loading and breath segmentation.
//
// The text is the Tanzil Uthmani text, shown verbatim. Segmenting only decides
// where one practice phrase ends and the next begins; no character is changed.
'use strict';

// Pause marks (waqf signs) in the Uthmani text.
const MARKS = {
  'ۘ': { id: 'lazim', name: 'Compulsory stop', stop: 'must' },      // small high meem
  'ۗ': { id: 'qala', name: 'Stopping is better', stop: 'may' },     // small high qaf-lam-alif
  'ۚ': { id: 'jaiz', name: 'Stopping is allowed', stop: 'may' },    // small high jeem
  'ۖ': { id: 'sala', name: 'Joining is better', stop: 'may' },      // small high sad-lam-alif
  'ۛ': { id: 'muanaqah', name: 'Stop at one of the pair', stop: 'pair' }, // three dots
  'ۙ': { id: 'la', name: 'Do not stop here', stop: 'never' },        // small high lam-alif
};

const MODES = {
  // Whole ayah in one breath; split only where stopping is compulsory.
  ayah: new Set(['lazim']),
  // Break at every place a stop is permitted.
  stops: new Set(['lazim', 'qala', 'jaiz', 'sala', 'muanaqah']),
};

function parseTanzil(text) {
  const verses = new Map(); // "s:a" -> text
  let basmalah = null;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw || raw.startsWith('#')) continue;
    const first = raw.indexOf('|');
    const second = raw.indexOf('|', first + 1);
    if (first < 0 || second < 0) continue;
    const s = Number(raw.slice(0, first));
    const a = Number(raw.slice(first + 1, second));
    const body = raw.slice(second + 1);
    verses.set(`${s}:${a}`, body);
    if (s === 1 && a === 1) basmalah = body;
  }
  return { verses, basmalah };
}

function markOf(token) {
  return token.length === 1 && MARKS[token] ? MARKS[token] : null;
}

// Split one ayah into practice segments.
// Returns [{ text, words, end: { id, name } }]
function segmentAyah(text, mode = 'stops', { basmalah = null, isFirstAyah = false } = {}) {
  const allowed = MODES[mode] || MODES.stops;
  const segments = [];
  let body = text;

  // Tanzil prefixes the first ayah of most surahs with the basmalah. It is
  // recited as its own phrase, so it gets its own segment.
  if (isFirstAyah && basmalah && body.startsWith(basmalah + ' ')) {
    segments.push({ text: basmalah, words: countWords(basmalah), end: { id: 'basmalah', name: 'End of the basmalah' } });
    body = body.slice(basmalah.length + 1);
  }

  const tokens = body.split(' ');
  let current = [];
  let pairSeen = false;
  for (const tok of tokens) {
    current.push(tok);
    const mark = markOf(tok);
    if (!mark) continue;
    let breakHere = allowed.has(mark.id);
    if (mark.id === 'muanaqah') {
      // Of a pair of three-dot marks you stop at one, not both. Offer the first.
      breakHere = breakHere && !pairSeen;
      pairSeen = true;
    }
    if (breakHere) {
      const t = current.join(' ');
      segments.push({ text: t, words: countWords(t), end: { id: mark.id, name: mark.name } });
      current = [];
    }
  }
  if (current.length) {
    const t = current.join(' ');
    segments.push({ text: t, words: countWords(t), end: { id: 'ayah', name: 'End of the ayah' } });
  }
  return segments;
}

function countWords(t) {
  return t.split(' ').filter((w) => w && !markOf(w)).length;
}

// All practice segments for a surah, in order.
function segmentSurah(quran, surah, ayahCount, mode = 'stops') {
  const out = [];
  for (let a = 1; a <= ayahCount; a++) {
    const text = quran.verses.get(`${surah}:${a}`);
    if (text == null) throw new Error(`missing ayah ${surah}:${a}`);
    const segs = segmentAyah(text, mode, { basmalah: quran.basmalah, isFirstAyah: a === 1 && surah !== 1 && surah !== 9 });
    segs.forEach((seg, i) => out.push({ ...seg, surah, ayah: a, part: i + 1, parts: segs.length, index: out.length }));
  }
  return out;
}

// Arabic-Indic digits for ayah numbers.
function arabicNumber(n) {
  return String(n).replace(/\d/g, (d) => String.fromCharCode(0x0660 + Number(d)));
}

module.exports = { MARKS, MODES, parseTanzil, segmentAyah, segmentSurah, countWords, arabicNumber };
