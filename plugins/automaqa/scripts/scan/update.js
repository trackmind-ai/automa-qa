// Versioned update mode:   update <previous.toon | previous source.json>  + a fresh scan of NAMED AREAS only.
//   const prev = loadPrevious(file)                       // .toon -> source object, or .json
//   const { source, report } = mergeUpdate(prev, fresh, { version, date, areas, approvedBy })
// - existing IDs are kept (matched by the item's stable `key`); new keys get the next free number
// - items in the rescanned areas that were not seen again are marked status "not-seen" (ID kept, never reused)
// - items outside the rescanned areas are carried unchanged (carried:true)
// - numbers that moved since last time are listed ("alerts 860 -> 1,034") and written to the change log
const fs = require('fs');
const toon = require('./toon');
const ids = require('./ids');
const { diffFacts, fmtMoved } = require('./consistency');

const KEYED = ['criteria', 'data_rules', 'tooltips', 'expandables', 'open_questions', 'forms', 'safe_to_test', 'permissions', 'glossary', 'roles', 'menu', 'global_elements', 'workflows'];
const clone = o => JSON.parse(JSON.stringify(o));
const strip = it => { const c = { ...it }; delete c.id; delete c.status; delete c.carried; delete c.not_seen_in; return JSON.stringify(c); };
const itemKey = (col, it) => it.key || (col === 'glossary' ? it.term : col === 'roles' ? it.role : col === 'menu' ? it.item : col === 'safe_to_test' ? it.page + '|' + it.control : col === 'global_elements' ? it.element : col === 'permissions' ? it.role : col === 'workflows' ? it.title : undefined);

function nextVersion(v) { const m = String(v || '1.0').match(/^(\d+)\.(\d+)$/); return m ? `${m[1]}.${Number(m[2]) + 1}` : '1.1'; }

// A previous TOON file holds the rendered document; the full source rides along in `source_json` when the skill wrote it.
function loadPrevious(file) {
  const text = fs.readFileSync(file, 'utf8');
  if (/\.json$/i.test(file)) return JSON.parse(text);
  const t = toon.parse(text);
  if (t.source_json) { try { return JSON.parse(t.source_json); } catch (_) { /* fall through */ } }
  return fromToon(t);
}
// Best-effort rebuild of a source object from a TOON document (e.g. one produced by another tool).
function fromToon(t) {
  const d = t.document || {};
  const s = { meta: { title: d.title, subtitle: d.subtitle, application: d.application, environment: d.environment_described, observed_on: d.observed_on, status: d.document_status, used_by: d.used_by, version: String(d.version || '1.0'), version_note: d.version_note, how_to_read: d.how_to_read },
    criteria: (t.acceptance_criteria || []).map(r => ({ key: 'imported:' + r.id, id: r.id, text: r.criterion, status: 'proposed', number_kind: 'rule' })),
    data_rules: (t.data_rules || []).map(r => ({ key: 'imported:' + r.id, id: r.id, rule: r.rule, where: r.where_to_compare, status: 'proposed', number_kind: 'rule' })),
    tooltips: (t.tooltips || []).map(r => ({ key: 'imported:' + r.id, id: r.id, where: r.where, icon: r.icon_next_to, text: r.bubble_text })),
    expandables: (t.expandable_fields || []).map(r => ({ key: 'imported:' + r.id, id: r.id, where: r.where, control: r.control_exact_text, reveals: r.what_it_reveals })),
    open_questions: (t.open_questions || []).map(r => ({ key: 'imported:' + r.id, id: r.id, seen: r.what_was_seen, question: r.question_for_business, status: r.status })),
    safe_to_test: (t.safe_to_test || []).map(r => ({ page: r.page, control: r.control_exact_text, safe: r.safe, effect: r.effect, run_mode: r.run_mode })),
    change_log: (t.change_log || []).map(r => ({ version: String(r.version), date: r.date, sections: r.sections_changed, what: r.what_changed, approved_by: r.approved_by })),
    screens: [], imported_sections: t.sections || [] };
  ids.syncRegistry(s); return s;
}

function mergeUpdate(prevIn, fresh, opts = {}) {
  const prev = clone(prevIn); const date = opts.date || new Date().toISOString().slice(0, 10);
  const version = opts.version || nextVersion(prev.meta && prev.meta.version);
  const areas = opts.areas || []; const inArea = it => !areas.length || areas.includes(it.screen) || areas.includes(it.area);
  const report = { version, added: [], changed: [], notSeen: [], carried: 0, moved: [] };
  ids.syncRegistry(prev);

  for (const col of KEYED) {
    const base = prev[col] = prev[col] || []; const fr = (fresh[col] || []);
    const seenKeys = new Set();
    for (const it of fr) {
      const k = itemKey(col, it); if (!k) continue; seenKeys.add(k);
      const old = base.find(b => itemKey(col, b) === k);
      if (old) { const keepId = old.id; if (strip(old) !== strip({ ...it, id: keepId })) report.changed.push(keepId || k); Object.assign(old, it, keepId ? { id: keepId } : {}); delete old.carried; delete old.not_seen_in; if (old.status === 'not-seen') delete old.status; }
      else { const n = { ...it, key: k }; delete n.id; base.push(n); if (ids.KINDS[col]) { n.id = ids.allocate(prev, col); report.added.push(n.id); } else report.added.push(col + ':' + k); }
    }
    for (const b of base) {
      const k = itemKey(col, b);
      if (seenKeys.has(k)) continue;
      if (inArea(b) && areas.length && (b.screen || b.area)) { if (b.status !== 'not-seen') { b.status = 'not-seen'; b.not_seen_in = version; } report.notSeen.push(b.id || k); }
      else { b.carried = true; report.carried++; }
    }
  }
  // screens: replace the rescanned ones (keep their number), add new ones
  prev.screens = prev.screens || [];
  for (const sc of fresh.screens || []) {
    const i = prev.screens.findIndex(x => x.key === sc.key);
    if (i >= 0) { prev.screens[i] = { ...sc, num: prev.screens[i].num }; report.changed.push('screen:' + sc.key); } else { prev.screens.push(sc); report.added.push('screen:' + sc.key); }
  }
  for (const sc of prev.screens) if (!(fresh.screens || []).find(x => x.key === sc.key)) sc.carried = true;
  // numbers that moved
  report.moved = diffFacts(prev.facts, fresh.facts || []);
  const fm = new Map((prev.facts || []).map(f => [f.key + '|' + f.screen, f]));
  for (const f of fresh.facts || []) fm.set(f.key + '|' + f.screen, f);
  prev.facts = [...fm.values()];
  // load times: replace rows of rescanned screens
  if (fresh.load_times) { const keep = (prev.load_times || []).filter(r => !areas.length ? false : !areas.includes(r.screen)); prev.load_times = [...keep, ...fresh.load_times]; }
  if (fresh.coverage) prev.coverage = fresh.coverage;
  // version, change log
  prev.meta = prev.meta || {}; prev.meta.version = version; prev.meta.date = date;
  prev.meta.observed_on = `${prev.meta.observed_on || ''} Version ${version} (${date}, same read-only method) rescanned: ${areas.length ? areas.join(', ') : 'all areas'}.`.trim();
  prev.meta.version_note = `${version} - ${opts.note || 'update from a rescan'}. Replaces ${prevIn.meta && prevIn.meta.version || 'the previous version'}. Still pending sign-off by the business.`;
  const what = [`${report.added.length} added`, `${report.changed.length} changed`, `${report.notSeen.length} not seen again`, report.moved.length ? 'moved: ' + report.moved.map(fmtMoved).join('; ') : 'no numbers moved'].join('; ');
  prev.change_log = prev.change_log || [];
  prev.change_log.push({ version, date, sections: areas.length ? areas.join(', ') : 'All', what: opts.what || what, approved_by: opts.approvedBy || 'Pending Business sign-off' });
  ids.syncRegistry(prev); report.next_ids = Object.fromEntries(Object.entries(prev.id_registry).map(([k, v]) => [k, k + (v.max + 1)]));
  return { source: prev, report };
}

module.exports = { mergeUpdate, loadPrevious, fromToon, nextVersion };
