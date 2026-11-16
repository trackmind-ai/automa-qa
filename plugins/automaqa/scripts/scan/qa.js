#!/usr/bin/env node
// Quality check — FAILS the build (exit code 1) when:
//   1. an acceptance criterion, data rule, tooltip, expandable, form or open question is missing its ID (or the ID is malformed / duplicated)
//   2. a number has no "seen on <date>" (unless the item is tagged number_kind:"rule" = a limit, threshold or format)
//   3. an exact-text quote does not appear in the scan evidence
//   4. a screen section has no rule (no acceptance criterion points at it)
//   5. personal data is found (patterns + a deny-list of names harvested from the scan)
//
//   node qa.js <source.json> [--evidence <dir|file>] [--names <names.txt>] [--require-evidence]
const fs = require('fs');
const path = require('path');
const ids = require('./ids');

const MONTH = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*';
const SEEN_ON = new RegExp(`seen on\\s+(?:\\d{4}-\\d{2}-\\d{2}|\\d{1,2}\\s+${MONTH}\\s+\\d{4})`, 'i');
const ws = s => String(s).replace(/[ \s]+/g, ' ').trim();

function stripNonNumbers(t) {
  return String(t)
    .replace(/"[^"]*"|'[^']*'|“[^”]*”|‘[^’]*’/g, ' ')              // quoted exact text is checked separately
    .replace(/\b(?:AC-P|TR|ER|D|T|E|Q|F|G)-\d+\b/g, ' ')                                       // IDs
    .replace(/\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, ' ')                        // dates
    .replace(new RegExp(`\\b\\d{1,2}\\s+${MONTH}\\s+\\d{4}\\b`, 'gi'), ' ')
    .replace(/\bsections?\s+\d+(?:\.\d+)*(?:\s*(?:to|and|-)\s*\d+(?:\.\d+)*)?/gi, ' ')           // section references
    .replace(/\bv\d+(?:\.\d+)?\b/gi, ' ');
}
function needsSeen(text) { return /\d/.test(stripNonNumbers(text)); }
function numberOk(item, text) { return !needsSeen(text) || item.number_kind === 'rule' || (SEEN_ON.test(text) || (item.seen && SEEN_ON.test(String(item.seen)) && /seen on/i.test(text))); }

function loadEvidence(p) {
  if (!p) return null; const parts = [];
  const read = f => { try { parts.push(fs.readFileSync(f, 'utf8')); } catch (_) { /* skip */ } };
  const st = fs.statSync(p);
  if (st.isFile()) read(p); else (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (/\.(txt|json|jsonl)$/i.test(e.name)) read(f); } })(p);
  return ws(parts.join('\n'));
}

function check(src, { evidence = null, names = [], requireEvidence = false } = {}) {
  const fail = []; const skipped = []; const f = (code, msg) => fail.push({ code, msg });
  // 1. IDs
  ids.validateIds(src).forEach(m => f('id', m));
  const known = new Set(ids.collect(src).map(x => x.id));
  // 2. numbers
  const nums = [];
  for (const c of src.criteria || []) nums.push(['criterion ' + (c.id || c.key), c, c.text]);
  for (const r of src.data_rules || []) nums.push(['data rule ' + (r.id || r.key), r, r.rule]);
  for (const q of src.open_questions || []) nums.push(['open question ' + (q.id || q.key), q, q.seen]);
  for (const s of src.screens || []) for (const e of s.elements || []) if (e.must) nums.push([`screen ${s.key} element "${e.element}"`, e, e.must]);
  for (const [label, item, text] of nums) if (text && !numberOk(item, text)) f('number', `${label}: has a number without "seen on <date>" (add it, or tag number_kind:"rule" for a limit/threshold): ${String(text).slice(0, 90)}`);
  // 4. every screen has a rule
  for (const s of src.screens || []) if (!(src.criteria || []).some(c => c.screen === s.key && c.status !== 'retired')) f('rule', `screen "${s.key}" has no acceptance criterion`);
  // criteria must belong to a real screen or be global
  for (const c of src.criteria || []) if (c.screen && c.screen !== 'global' && !(src.screens || []).some(s => s.key === c.screen)) f('rule', `criterion ${c.id || c.key} points at unknown screen "${c.screen}"`);
  // sheet map references
  for (const sm of src.sheet_map || []) for (const id of String(sm.criteria || '').match(/(?:AC-P|D-)\d+/g) || []) if (!known.has(id)) f('id', `sheet_map references unknown ${id}`);
  // 3. exact text
  const quotes = [];
  for (const s of src.screens || []) if (!s.carried) for (const t of s.text || []) quotes.push([`screen ${s.key}`, t]);
  for (const t of src.tooltips || []) if (!t.carried && t.status !== 'not-seen') quotes.push([`tooltip ${t.id || t.key}`, t.text]);
  for (const e of src.expandables || []) if (!e.carried && e.status !== 'not-seen') quotes.push([`expandable ${e.id || e.key}`, e.control]);
  for (const fm of src.forms || []) if (!fm.carried && fm.status !== 'not-seen') { quotes.push([`form ${fm.id || fm.key}`, fm.title]); for (const fl of fm.fields || []) quotes.push([`form ${fm.id || fm.key} field`, fl.label]); }
  if (evidence) {
    for (const [where, q] of quotes) if (q && !evidence.includes(ws(q))) f('quote', `${where}: exact text not found in the scan evidence: "${String(q).slice(0, 80)}"`);
  } else if (requireEvidence) f('quote', 'no evidence supplied (use --evidence <scan raw dir>) but --require-evidence was set');
  else skipped.push(`exact-text check skipped (no --evidence): ${quotes.length} quotes unchecked`);
  // 5. personal data
  const blob = JSON.stringify(src);
  const PII = [['email', /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/], ['phone', /(?:\+?\d{1,3}[\s.\-]?)?(?:\(\d{3}\)|\b\d{3})[\s.\-]\d{3}[\s.\-]\d{4}\b/], ['dob', /(?:DOB|Date of Birth|Birth ?date)\s*[:\-]?\s*[0-9/\-.]{6,10}/i], ['long digits', /\b\d{9,}\b/]];
  for (const [k, rx] of PII) { const m = blob.match(rx); if (m) f('pii', `personal data (${k}) found: ${m[0].slice(0, 30)}`); }
  for (const n of names) { if (n.length < 4) continue; const rx = new RegExp('\\b' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i'); if (rx.test(blob)) f('pii', `a name from the scan appears in the document: "${n.slice(0, 1)}***"`); }
  return { ok: fail.length === 0, failures: fail, skipped, counts: { ids: known.size, quotes: quotes.length, numbers: nums.length } };
}

function cli() {
  const a = process.argv.slice(2); const get = k => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
  if (!a[0]) { console.error('usage: node qa.js <source.json> [--evidence dir] [--names file] [--require-evidence]'); process.exit(2); }
  const src = JSON.parse(fs.readFileSync(a[0], 'utf8'));
  const names = get('--names') && fs.existsSync(get('--names')) ? fs.readFileSync(get('--names'), 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean) : [];
  const r = check(src, { evidence: loadEvidence(get('--evidence')), names, requireEvidence: a.includes('--require-evidence') });
  r.skipped.forEach(s => console.log('SKIP  ' + s)); r.failures.forEach(x => console.log(`FAIL  [${x.code}] ${x.msg}`));
  console.log(r.ok ? `QA PASSED (${r.counts.ids} IDs, ${r.counts.quotes} quotes, ${r.counts.numbers} number checks)` : `QA FAILED: ${r.failures.length} problem(s)`);
  process.exit(r.ok ? 0 : 1);
}
if (require.main === module) cli();
module.exports = { check, needsSeen, loadEvidence, stripNonNumbers, SEEN_ON };
