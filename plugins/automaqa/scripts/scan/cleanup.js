#!/usr/bin/env node
// Post-scan cleanup for automaqa:scan.
//   node cleanup.js --raw <scan-tmp/<run>/raw> --model <specs/_scan/<run>/model> [--keep-raw]
// 1. Deletes the raw dump folder (full snapshots / element lists / logs contain real names,
//    emails, phone numbers) unless --keep-raw.
// 2. Scans the model folder's text files for personal-data patterns and reports hits.
// Exit code 0 = clean, 2 = personal data found in the model (fix before sharing).
const fs = require('fs');
const path = require('path');

const PII = {
  email: /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g,
  phone: /(?:\+?\d{1,3}[\s.\-]?)?(?:\(\d{3}\)|\b\d{3})[\s.\-]?\d{3}[\s.\-]?\d{4}\b/g,
  dob: /(?:DOB|Date of Birth|Birth ?date)\s*[:\-]?\s*[0-9/\-.]{6,10}/gi,
  digits: /\b\d{9,}\b/g,
};
const TEXT_EXT = new Set(['.txt', '.md', '.json', '.jsonl', '.html', '.csv', '.yaml', '.yml']);

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

function piiCheck(dir) {
  const hits = [];
  for (const f of walk(dir)) {
    if (!TEXT_EXT.has(path.extname(f).toLowerCase())) continue;
    const text = fs.readFileSync(f, 'utf8');
    for (const [kind, rx] of Object.entries(PII)) {
      rx.lastIndex = 0;
      const m = text.match(rx);
      if (m && m.length) hits.push({ file: f, kind, count: m.length });
    }
  }
  return hits;
}

function deleteRaw(dir) {
  if (!dir || !fs.existsSync(dir)) return { deleted: false, files: 0 };
  const files = walk(dir).length;
  fs.rmSync(dir, { recursive: true, force: true });
  return { deleted: true, files };
}

function cli() {
  const a = process.argv.slice(2);
  const get = k => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
  const raw = get('--raw'), model = get('--model');
  const res = { raw: a.includes('--keep-raw') ? { deleted: false, kept: true } : deleteRaw(raw), pii: model ? piiCheck(model) : [] };
  console.log(JSON.stringify(res, null, 1));
  process.exit(res.pii.length ? 2 : 0);
}

if (require.main === module) cli();
module.exports = { piiCheck, deleteRaw };
