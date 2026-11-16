// Stable IDs for the reference document. IDs are never reused and never renumbered.
//   AC-P  acceptance criteria        D-   cross-screen data rules      T-  tooltips (info-icon bubbles)
//   E-    expandable fields          Q-   open questions               F-  forms
// (TR- tooltip rules, ER- expandable rules and G- guidance are fixed text owned by render.js)
//
// A source item gets an ID once, keyed by its stable `key`. Updating the document keeps the ID
// for the same key and allocates the next free number for a new key. Retired IDs stay reserved.

const KINDS = {
  criteria: { prefix: 'AC-P', re: /^AC-P\d+$/ },
  data_rules: { prefix: 'D-', re: /^D-\d+$/ },
  tooltips: { prefix: 'T-', re: /^T-\d+$/ },
  expandables: { prefix: 'E-', re: /^E-\d+$/ },
  open_questions: { prefix: 'Q-', re: /^Q-\d+$/ },
  forms: { prefix: 'F-', re: /^F-\d+$/ },
};
const num = (id, prefix) => Number(String(id).slice(prefix.length));

function registry(src) { src.id_registry = src.id_registry || {}; for (const k of Object.values(KINDS)) src.id_registry[k.prefix] = src.id_registry[k.prefix] || { max: 0, retired: [] }; return src.id_registry; }

// Recompute `max` from items that exist, so the next free number is always above every ID ever used.
function syncRegistry(src) {
  const reg = registry(src);
  for (const [col, k] of Object.entries(KINDS)) {
    let max = reg[k.prefix].max;
    for (const it of src[col] || []) if (it.id && k.re.test(it.id)) max = Math.max(max, num(it.id, k.prefix));
    for (const id of reg[k.prefix].retired) max = Math.max(max, num(id, k.prefix));
    reg[k.prefix].max = max;
  }
  return reg;
}
function allocate(src, col) { const k = KINDS[col]; const reg = syncRegistry(src); reg[k.prefix].max += 1; return k.prefix + reg[k.prefix].max; }

// Give every keyed item without an ID the next free one. Returns the list of new IDs.
function assignIds(src) {
  const added = [];
  for (const col of Object.keys(KINDS)) for (const it of src[col] || []) if (!it.id) { it.id = allocate(src, col); added.push(it.id); }
  return added;
}
function retire(src, id) {
  const reg = syncRegistry(src);
  for (const [col, k] of Object.entries(KINDS)) if (k.re.test(id)) {
    const it = (src[col] || []).find(x => x.id === id); if (it) it.status = 'retired';
    if (!reg[k.prefix].retired.includes(id)) reg[k.prefix].retired.push(id);
  }
}
const collect = src => Object.keys(KINDS).flatMap(col => (src[col] || []).map(it => ({ col, ...it })));
function validateIds(src) {
  const errs = []; const seen = new Set();
  for (const col of Object.keys(KINDS)) for (const it of src[col] || []) {
    const k = KINDS[col];
    if (!it.key) errs.push(`${col}: item without a stable key (${JSON.stringify(it).slice(0, 60)})`);
    if (!it.id) errs.push(`${col}: item "${it.key || '?'}" has no ID`);
    else if (!k.re.test(it.id)) errs.push(`${col}: bad ID "${it.id}" (expected ${k.prefix}<number>)`);
    else if (seen.has(it.id)) errs.push(`${col}: duplicate ID ${it.id}`);
    if (it.id) seen.add(it.id);
  }
  return errs;
}
const idCmp = (a, b) => { const m = s => s.match(/^([A-Z-]+?)(\d+)$/); const x = m(a), y = m(b); return x[1] === y[1] ? Number(x[2]) - Number(y[2]) : x[1].localeCompare(y[1]); };

module.exports = { KINDS, registry, syncRegistry, allocate, assignIds, retire, collect, validateIds, idCmp };
