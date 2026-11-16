// Cross-screen consistency pass. After the scan, find the SAME number on several screens and record a D- rule for it.
//   harvestFacts({ S01: textOfScreen, ... }) -> candidate facts [{ key, screen, label, value }]
//   findCrossScreen(facts)                   -> groups seen on >= 2 screens, with agree / differ
//   proposeRules(src, groups, date)          -> adds data_rules (agree) or open_questions (differ), keyed, ID assigned later
//   diffFacts(prevFacts, newFacts)           -> numbers that moved since the previous version (alerts 860 -> 1,034)
// Claude reviews the harvested candidates: only real "same quantity" pairs become rules (a human-judgement step).

const num = s => Number(String(s).replace(/,/g, ''));
const SING = s => s.toLowerCase().replace(/[^a-z ]/g, '').trim().replace(/\s+/g, ' ').replace(/ies$/, 'y').replace(/s$/, '');

const PATTERNS = [
  [/Showing\s+\d[\d,]*\s+of\s+(\d[\d,]*)\s+([A-Za-z][A-Za-z ]{1,30}?)(?=[\s.,;:]|$)/g, m => ({ label: m[2], value: m[1] })],  // Showing 25 of 194 clients
  [/([A-Za-z][A-Za-z &\/-]{1,30}?)\s*\((\d[\d,]*)\)/g, m => ({ label: m[1], value: m[2] })],                                      // All (1034)
  [/\b(Tasks|Alerts|Clients|Users|Notes|Documents|Appointments)\s+(\d[\d,]*)\b/g, m => ({ label: m[1], value: m[2] })],           // Tasks 7
  [/\b(\d[\d,]*)\s+(Overdue|appointments?|alerts?|clients?|users?|tasks?)\b/gi, m => ({ label: m[2], value: m[1] })],             // 5 Overdue
];

function harvestFacts(textByScreen) {
  const out = []; const seen = new Set();
  for (const [screen, text] of Object.entries(textByScreen)) {
    const t = String(text).replace(/\s+/g, ' ');
    for (const [rx, f] of PATTERNS) { rx.lastIndex = 0; let m; while ((m = rx.exec(t))) { const { label, value } = f(m); const key = SING(label); if (!key || key.length < 3) continue; const id = key + '|' + screen + '|' + value; if (seen.has(id)) continue; seen.add(id); out.push({ key, screen, label: label.trim(), value: num(value) }); } }
  }
  return out;
}

function findCrossScreen(facts) {
  const by = {};
  for (const f of facts) (by[f.key] = by[f.key] || []).push(f);
  const groups = [];
  for (const [key, list] of Object.entries(by)) {
    const screens = [...new Set(list.map(f => f.screen))]; if (screens.length < 2) continue;
    const values = [...new Set(list.map(f => f.value))];
    groups.push({ key, label: list[0].label, screens, values, agree: values.length === 1, facts: list });
  }
  return groups.sort((a, b) => a.key.localeCompare(b.key));
}

function proposeRules(src, groups, date) {
  src.data_rules = src.data_rules || []; src.open_questions = src.open_questions || []; const added = [];
  for (const g of groups) {
    const dk = 'd:' + g.key, qk = 'q:' + g.key;
    if (g.agree && !src.data_rules.find(r => r.key === dk)) {
      src.data_rules.push({ key: dk, fact_key: g.key, rule: `"${g.label}" is the same number on ${g.screens.join(', ')} (seen on ${date}: ${g.values[0]})`, where: g.screens.join('; '), status: 'proposed', seen: date });
      added.push(dk);
    } else if (!g.agree && !src.open_questions.find(q => q.key === qk)) {
      src.open_questions.push({ key: qk, fact_key: g.key, seen: `"${g.label}" differs between screens: ${g.facts.map(f => f.screen + ' = ' + f.value).join('; ')} (seen on ${date})`, question: `Should "${g.label}" be the same on ${g.screens.join(' and ')}? If not, what does each count?`, status: 'open' });
      added.push(qk);
    }
  }
  return added;
}

function diffFacts(prev = [], next = []) {
  const k = f => f.key + '|' + f.screen; const old = new Map(prev.map(f => [k(f), f.value])); const moved = [];
  for (const f of next) if (old.has(k(f)) && old.get(k(f)) !== f.value) moved.push({ key: f.key, screen: f.screen, from: old.get(k(f)), to: f.value });
  return moved;
}
const fmtMoved = m => `${m.key} ${m.from.toLocaleString('en-US')} -> ${m.to.toLocaleString('en-US')} (${m.screen})`;

module.exports = { harvestFacts, findCrossScreen, proposeRules, diffFacts, fmtMoved };
