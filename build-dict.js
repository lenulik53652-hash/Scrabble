// Expands the Slovak hunspell dictionary (data/sk.aff + data/sk.dic) into data/words.txt.
// Usage: node build-dict.js
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, 'data');
const aff = fs.readFileSync(path.join(dir, 'sk.aff'), 'utf8').split('\n');
const dic = fs.readFileSync(path.join(dir, 'sk.dic'), 'utf8').split('\n').slice(1);

// --- parse affix rules ---
const rules = { PFX: {}, SFX: {} };
for (const raw of aff) {
  const line = raw.replace(/#.*/, '').trim();
  const p = line.split(/\s+/);
  if (p[0] !== 'PFX' && p[0] !== 'SFX') continue;
  const [kind, flag] = p;
  if (p[2] === 'Y' || p[2] === 'N') {
    rules[kind][flag] = { cross: p[2] === 'Y', items: [] };
    continue;
  }
  const strip = p[2] === '0' ? '' : p[2];
  const add = p[3] === '0' ? '' : p[3].split('/')[0];
  const cond = p[4] || '.';
  const re = new RegExp(kind === 'SFX' ? `(?:${cond})$` : `^(?:${cond})`);
  rules[kind][flag].items.push({ strip, add, re });
}

function apply(kind, flag, word) {
  const r = rules[kind][flag];
  if (!r) return [];
  const out = [];
  for (const { strip, add, re } of r.items) {
    if (!re.test(word)) continue;
    if (kind === 'SFX') {
      if (strip && !word.endsWith(strip)) continue;
      out.push(word.slice(0, word.length - strip.length) + add);
    } else {
      if (strip && !word.startsWith(strip)) continue;
      out.push(add + word.slice(strip.length));
    }
  }
  return out;
}

// --- exclusions: interjections (citoslovcia), abbreviations (skratky), foreign words ---
const excluded = new Set(
  fs.readFileSync(path.join(dir, 'excluded.txt'), 'utf8')
    .split('\n').map(s => s.trim().toLowerCase()).filter(s => s && !s.startsWith('#'))
);

const ALLOWED = /^[aáäbcčdďeéfghiíjklĺľmnňoóôpqrŕsštťuúvwxyýzž]+$/;
const TILE_LETTERS = /^[aáäbcčdďeéfghiíjklĺľmnňoóôprŕsštťuúvxyýzž]+$/; // no q, w
const words = new Set();

// Curated 2-letter words (the dictionary contains many abbreviations at this length).
const TWO_LETTER = new Set(('aj ak ba bi bo bu by ci de do du ha he hi ho hu ja je ju ka ku la ma me mi mu my ' +
  'na ne ni no ny od on os po ra re sa se si so ta ti to tu ty vo vy za ze zo ač až ať čo či že ťa úd').split(' '));
const VOWEL = /[aáäeéiíoóôuúyý]/;
const SYLLABIC = /[rlŕĺ]/;
const ROMAN = /^m{0,3}(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})$/;

for (const line of dic) {
  if (!line) continue;
  const [stem, flags = ''] = line.split('/');
  // Capitalised stems are names, places, abbreviations -> skipped.
  if (stem !== stem.toLowerCase()) continue;
  const forms = new Set([stem]);
  const sfx = [], pfx = [];
  for (const f of flags) {
    if (rules.SFX[f]) sfx.push(f);
    if (rules.PFX[f]) pfx.push(f);
  }
  const sfxForms = [];
  for (const f of sfx) for (const w of apply('SFX', f, stem)) { forms.add(w); if (rules.SFX[f].cross) sfxForms.push(w); }
  for (const f of pfx) {
    if (!rules.PFX[f].cross) { for (const w of apply('PFX', f, stem)) forms.add(w); continue; }
    for (const w of apply('PFX', f, stem)) forms.add(w);
    for (const s of sfxForms) for (const w of apply('PFX', f, s)) forms.add(w);
  }
  for (const w of forms) {
    if (w.length < 2 || w.length > 15) continue;
    if (!TILE_LETTERS.test(w)) continue;
    if (excluded.has(w)) continue;
    if (w.length === 2 && !TWO_LETTER.has(w)) continue;
    if (!VOWEL.test(w) && (w.length < 3 || !SYLLABIC.test(w))) continue;
    if (w.length >= 3 && ROMAN.test(w)) continue;
    words.add(w);
  }
}

// Words missing from the source dictionary (e.g. vowel-less nouns); bypass all filters.
const extraFile = path.join(dir, 'extra-words.txt');
if (fs.existsSync(extraFile)) {
  for (const w of fs.readFileSync(extraFile, 'utf8').split('\n').map(s => s.trim().toLowerCase())) {
    if (w && !w.startsWith('#')) words.add(w);
  }
}

fs.writeFileSync(path.join(dir, 'words.txt'), [...words].sort().join('\n') + '\n');
console.log(`Wrote ${words.size} words`);
