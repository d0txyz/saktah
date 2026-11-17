// Builds assets/quran/surahs.json from Tanzil's quran-data.js metadata.
// The file is parsed as text (never executed).
// Run: node scripts/build-surahs.js
'use strict';

const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'assets', 'quran', 'quran-data.js');
const out = path.join(__dirname, '..', 'assets', 'quran', 'surahs.json');

const text = fs.readFileSync(src, 'utf8');
const block = text.slice(text.indexOf('QuranData.Sura = ['), text.indexOf('];', text.indexOf('QuranData.Sura = [')));

// Rows look like: [0, 7, 5, 1, 'الفاتحة', "Al-Faatiha", 'The Opening', 'Meccan'],
const row = /\[\s*(\d+),\s*(\d+),\s*(\d+),\s*(\d+),\s*(['"])(.*?)\5,\s*(['"])(.*?)\7,\s*(['"])(.*?)\9,\s*(['"])(.*?)\11\s*\]/g;

const surahs = [];
let m;
while ((m = row.exec(block)) !== null) {
  surahs.push({
    number: surahs.length + 1,
    ayahs: Number(m[2]),
    name: m[6],
    transliteration: m[8],
    english: m[10],
    type: m[12],
  });
}
if (surahs.length !== 114) throw new Error(`expected 114 surahs, parsed ${surahs.length}`);

const doc = {
  source: 'Tanzil Project quran-data.js (https://tanzil.net), Creative Commons Attribution 3.0',
  surahs,
};
fs.writeFileSync(out, JSON.stringify(doc, null, 1) + '\n');
console.log(`wrote ${surahs.length} surahs to ${path.relative(process.cwd(), out)}`);
