'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseTanzil, segmentAyah, segmentSurah } = require('../src/shared/quran');

const quran = parseTanzil(fs.readFileSync(path.join(__dirname, '..', 'assets', 'quran', 'quran-uthmani.txt'), 'utf8'));
const surahs = require('../assets/quran/surahs.json').surahs;

test('loads all 6236 ayat', () => {
  assert.equal(quran.verses.size, 6236);
  const total = surahs.reduce((n, s) => n + s.ayahs, 0);
  assert.equal(total, 6236);
});

test('segments never change the text: joining them gives the ayah back', () => {
  for (const s of surahs) {
    for (const mode of ['ayah', 'stops']) {
      const segs = segmentSurah(quran, s.number, s.ayahs, mode);
      for (let a = 1; a <= s.ayahs; a++) {
        const joined = segs.filter((g) => g.ayah === a).map((g) => g.text).join(' ');
        assert.equal(joined, quran.verses.get(`${s.number}:${a}`), `${s.number}:${a} ${mode}`);
      }
    }
  }
});

test('basmalah is its own phrase, except in Al-Fatihah and At-Tawbah', () => {
  const ikhlas = segmentSurah(quran, 112, 4, 'ayah');
  assert.equal(ikhlas[0].end.id, 'basmalah');
  assert.equal(ikhlas[0].text, quran.basmalah);
  assert.equal(segmentSurah(quran, 1, 7, 'ayah')[0].end.id, 'ayah');
  assert.notEqual(segmentSurah(quran, 9, 129, 'ayah')[0].end.id, 'basmalah');
});

test('a do-not-stop mark never ends a phrase', () => {
  for (const s of surahs) {
    for (const g of segmentSurah(quran, s.number, s.ayahs, 'stops')) {
      assert.notEqual(g.end.id, 'la');
      assert.ok(!g.text.endsWith('ۙ'), `${s.number}:${g.ayah} ends on a do-not-stop mark`);
    }
  }
});

test('three-dot pair: stop at the first of the two only', () => {
  // 2:2 has the pair around "fihi".
  const segs = segmentAyah(quran.verses.get('2:2'), 'stops');
  assert.equal(segs.length, 2);
  assert.equal(segs[0].end.id, 'muanaqah');
  assert.equal(segs[1].end.id, 'ayah');
});

test('ayah mode keeps the whole ayah unless a stop is compulsory', () => {
  const segs = segmentAyah(quran.verses.get('2:2'), 'ayah');
  assert.equal(segs.length, 1);
});
