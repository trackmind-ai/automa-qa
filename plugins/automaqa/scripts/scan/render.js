#!/usr/bin/env node
// One source -> three outputs.  node render.js <source.json> --out <dir> [--screenshots on|off] [--shots <dir>] [--no-pdf]
// Writes  <base>_v<version>.pdf  .docx  .toon  (+ <base>_v<version>.source.json, the sidecar that `update` mode loads).
// All three are generated from the same block list / source, and verified to carry the same IDs.
const fs = require('fs');
const path = require('path');
const ids = require('./ids');
const toon = require('./toon');
const { buildDocx, docxText } = require('./docx');

const E = t => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const colKey = c => String(c).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'col';
const STATUS = { proposed: 'Proposed - needs Business sign-off', approved: 'Approved', 'not-seen': 'Not seen in the latest scan', retired: 'Retired (ID reserved)', open: 'open', closed: 'closed' };
const statusLabel = s => STATUS[s || 'proposed'] || s;
function fmtIds(list) { // AC-P3, AC-P4, AC-P5 -> "AC-P3 to AC-P5"
  const sorted = [...list].filter(Boolean).sort(ids.idCmp); const out = []; let run = [];
  const flush = () => { if (run.length > 2) out.push(`${run[0]} to ${run[run.length - 1]}`); else out.push(...run); run = []; };
  for (const id of sorted) { if (run.length) { const a = run[run.length - 1].match(/^(.*?)(\d+)$/), b = id.match(/^(.*?)(\d+)$/); if (a[1] === b[1] && Number(b[2]) === Number(a[2]) + 1) { run.push(id); continue; } flush(); } run.push(id); }
  flush(); return out.join(', ');
}

// ---------- fixed text owned by the renderer ----------
const GUIDANCE = [
  'Purpose: use this file as the business reference to generate test cases. Every case must trace to an ID in this file (AC-P, D-, T-, E-, F-, TR-, ER-, or a section number).',
  'Generate one test-case sheet per row of sheet_map (the sheet name becomes the AutomaQA spec name). When a section changes, regenerate only its sheet. Columns: TC ID, Test Type, Test Scenario, Pre-Condition, Test Data, Test Steps, Expected Result. One step per line.',
  'Read-only by default. Never write steps that click a control marked safe=N in safe_to_test (saves, sends, resolves, publishes, starts a call, deletes, invites, edits). Rows marked Y / N are safe to open but not to save. If a case truly needs a write action, put "Needs owner approval" in Pre-Condition and keep it out of the default run.',
  'Quote exact UI text from this file in Expected Result (it becomes an assertion). For info icons use tooltips[].bubble_text word for word. For expandable fields open the field first (expandable_fields), assert the detail, then close it.',
  'Numbers marked "seen" are examples from the QA data on the observed date and change. Assert the rule behind the number (counts add up, thresholds, colours), not the example value.',
  'Each "Must be true" sentence and each acceptance_criteria item needs at least one positive case. Add a negative or boundary case where a rule has a threshold or a required field.',
  'Items in open_questions with status=open are undecided. Write them as "to confirm" cases for a person to judge, not as pass/fail assertions. Items with status=closed may be asserted.',
  'Use QA data only. Never copy real client names, emails, phone numbers or dates of birth into test cases or reports.',
  'If the live screen and this file disagree, report it as a defect or as a change request for this document. Do not silently change the assertion.',
  'Name each case with the ID it covers, for example "AC-P<number> Orders paging" or "T-<number> tooltip text", so results map back to this file.',
];
const TOOLTIP_RULES = [
  'Hovering over an info icon shows a small pop-up bubble. No click is needed and nothing is saved or changed.',
  'The bubble is about the category next to the icon and explains it: what is counted, how the figure is calculated, who is included, and what the colours or ranges mean.',
  'The numbers and ranges in the bubble match what the screen does.',
  'The bubble opens next to the icon, stays inside the window, is not cut off, never has empty text, spelling mistakes or placeholder text, and disappears when the mouse moves away.',
  'The same icon always shows the same wording. The wording changes only when this document changes.',
  'The icon can be reached with the keyboard and has an accessible name, so a screen reader gives the same information (to confirm where not observed).',
  'Icon-only buttons without an "i" show a short name bubble instead.',
  'Every category that has a calculated figure, a colour code or a range is expected to have a bubble. Where one is missing it is listed under items to confirm.',
];
const EXPANDABLE_RULES = [
  'Collapsed, the field shows its headline. The control shows which state it is in (for example "Tap to Expand" / "Tap to Collapse", "+" / "-", "Read More" / "Read Less", or a chevron).',
  'Opening or closing a field only changes what is visible. Nothing is saved, sent or resolved, and no data changes.',
  'The detail agrees with the headline and with the other screens (a badge "5 Overdue" lists 5 tasks when opened; "+N more" reveals N more items).',
  'A second click returns to exactly the earlier view. Opening a field twice never repeats its content.',
  'When the detail opens in a side panel it has a title and a close (X) button, and closing returns to the same place on the page.',
  'Long text is cut with "..." in the collapsed view; the full text is available when the field is opened.',
  'Fields inside an opened panel keep their own rules. Controls that write stay data-changing even though the panel only opened by a click.',
  'The control can be reached and opened with the keyboard (to confirm where not observed).',
];

// ---------- numbering ----------
function assignNumbers(src) {
  src.numbering = src.numbering || {}; const n = src.numbering; const used = Object.values(n).map(Number).filter(Boolean);
  let next = Math.max(2, ...used) + 1;
  n.purpose = n.purpose || '1'; n.map = n.map || '2';
  for (const s of src.screens || []) { if (!n['screen:' + s.key]) { n['screen:' + s.key] = String(s.num || next); next = Math.max(next, Number(n['screen:' + s.key]) + 1); } s.num = n['screen:' + s.key]; }
  for (const k of ['workflows', 'data', 'permissions', 'criteria', 'safe', 'confirm', 'oos', 'judge', 'coverage']) if (!n[k]) n[k] = String(next++);
  return n;
}

// ---------- the block list (single document model) ----------
function buildBlocks(src, opts = {}) {
  ids.assignIds(src);
  const m = src.meta || {}; const n = assignNumbers(src); const B = []; const shots = opts.images || {};
  const crit = (src.criteria || []).filter(c => c.status !== 'retired');
  const critFor = key => crit.filter(c => c.screen === key);
  const fig = (name, cap) => (opts.screenshots && shots[name] ? B.push({ type: 'figure', src: shots[name], caption: cap }) : null);
  const firstScreen = (src.screens || [])[0] ? src.screens[0].num : '3'; const lastScreen = (src.screens || []).slice(-1)[0] ? src.screens.slice(-1)[0].num : '8';
  const rowId = x => x.id + (x.status === 'not-seen' ? ' (not seen in latest scan)' : '');

  B.push({ type: 'title', text: m.title || 'Business Workflow' });
  if (m.subtitle) B.push({ type: 'p', text: m.subtitle });
  B.push({ type: 'h2', text: 'Document control' });
  B.push({ type: 'table', columns: ['Item', 'Detail'], rows: [
    ['Application', m.application || ''], ['Environment described', m.environment || ''], ['Observed on', m.observed_on || ''],
    ['Version / date', `${m.version || '1.0'} / ${m.date || ''}`], ['Version note', m.version_note || ''], ['Document status', m.status || 'STANDING REFERENCE and READ-ONLY. Changes go through the document owner, who issues a new version.'],
    ['Business sign-off', 'Rules in this document are proposed from what was observed and need Business sign-off. Status per rule is shown in the acceptance criteria table.'],
    ['Used by', m.used_by || 'Business and QA, to write and refresh test scripts after every portal update. The QA agent and AutomaQA read this file; they never change it.'],
    ['Owner', m.owner || 'Business owner (to be named)'], ['Prepared by', m.prepared_by || 'Prepared with Claude from a read-only walk-through'],
    ['Files issued with each version', 'Word (.docx), PDF (.pdf) and TOON (.toon), generated from one source so the three always match. A .source.json sidecar is kept for the update mode.'] ] });
  B.push({ type: 'note', text: m.how_to_read || "How to read this document: every section starts with where the screen is and what it is for. Tables list the exact text seen on screen (quote it in tests). 'Must be true' sentences are the rules a test can check; they are proposed from what was observed and need Business sign-off. Numbers shown as 'seen' are from the data on the observed date and will change; the rule behind them is what matters. Personal data (names, emails, phone numbers, dates of birth) was left out on purpose." });
  B.push({ type: 'h2', text: 'Using this document when the portal changes' });
  B.push({ type: 'p', text: 'Keep this document as the reference every time the portal is updated and new test cases are needed. It describes how the portal is meant to work, so new or changed test cases are checked against it, not against memory.' });
  B.push({ type: 'table', columns: ['Step', 'Who', 'What to do'], rows: [
    ['1', 'Business', `Read the release notes or compare the screens with this document. List which sections (${firstScreen} to ${lastScreen}) are touched.`],
    ['2', 'Business or QA', 'Run the scan in update mode against the previous .toon, naming only the touched areas. It keeps existing IDs (AC-P, D-, T-, E-, F-, Q-), adds the next free number for new rules, and never reuses a retired ID.'],
    ['3', 'Business', `Update section ${n.safe} (safe-to-test register) for every new button. Mark it N when it saves, sends, resolves, publishes, starts a call or deletes.`],
    ['4', 'Business', 'Review the change-log row the update wrote (version, date, sections, what changed, numbers that moved) and record the approver. Issue the new version as Word, PDF and TOON.'],
    ['5', 'QA agent / AutomaQA', 'Give the new version (the .toon file for Claude, or the Word/PDF) and generate cases only for the changed sections. Each section maps to one test-case sheet (see the sheet map in Document control).'],
    ['6', 'QA', 'Re-run the regression cases for unchanged sections and check every acceptance criterion still holds. A failing criterion is either a defect or a rule that Business must change here first.'],
    ['7', 'Business and QA', `Answer the open items in section ${n.confirm}, then move the answer into the relevant rule and close the item.`] ] });
  B.push({ type: 'note', text: 'Rule of thumb: if a test case and this document disagree, the document wins until Business changes it. Test cases are never written from a guess about the screen; if something is not here, add it here first.' });

  // 1 purpose and users
  B.push({ type: 'h1', text: `${n.purpose}. Purpose and users`, pageBreak: true });
  B.push({ type: 'p', text: src.purpose || '' });
  B.push({ type: 'h2', text: `${n.purpose}.1 Executive summary` });
  for (const p of [].concat(src.exec_summary || [])) B.push({ type: 'p', text: p });
  B.push({ type: 'h2', text: `${n.purpose}.2 Roles` });
  B.push({ type: 'table', columns: ['Role', 'What they can see', 'What they can do'], rows: (src.roles || []).map(r => [r.role, r.sees, r.does]) });
  B.push({ type: 'note', text: 'The permissions in this table are what the signed-in test account(s) showed. Business should confirm what each role is allowed to do.' });
  if ((src.glossary || []).length) { B.push({ type: 'h2', text: `${n.purpose}.3 Glossary` }); B.push({ type: 'table', columns: ['Term', 'Meaning, as the application words it'], rows: src.glossary.map(g => [g.term, g.meaning]) }); }

  // 2 application map
  B.push({ type: 'h1', text: `${n.map}. Application map`, pageBreak: true });
  B.push({ type: 'h2', text: `${n.map}.1 Menu and addresses` });
  B.push({ type: 'table', columns: ['Menu item', 'Address', 'What it is for'], rows: (src.menu || []).map(r => [r.item, r.address, r.purpose]) });
  if ((src.global_elements || []).length) { B.push({ type: 'h2', text: `${n.map}.2 Top bar and elements on every page` }); B.push({ type: 'table', columns: ['Element (exact text / name)', 'What it shows or does', 'Must be true'], rows: src.global_elements.map(r => [r.element, r.shows, r.must]) }); }
  if ((src.forms || []).length) {
    B.push({ type: 'h2', text: `${n.map}.3 Forms (opened read-only)` });
    B.push({ type: 'note', text: 'Each form was opened from a safe button, its fields were read, and it was closed with Cancel. Nothing was typed or saved; the write guard blocks any save.' });
    for (const f of src.forms.filter(x => x.status !== 'retired')) {
      B.push({ type: 'h3', text: `${rowId(f)} ${f.title}${f.where ? ' - ' + f.where : ''}` });
      B.push({ type: 'table', columns: ['Field (exact label)', 'Type', 'Required', 'Hint / options'], rows: (f.fields || []).map(x => [x.label, x.type || '', x.required ? 'Yes' : 'No', x.hint || '']) });
      B.push({ type: 'p', text: `**Buttons:** ${(f.buttons || []).join(' | ') || '-'}. **Safe to test:** ${f.safe || 'Y / N'} (opening is Y; saving is N).` });
    }
  }
  B.push({ type: 'h2', text: `${n.map}.4 Info icons and tooltips (rules for every page)` });
  B.push({ type: 'table', columns: ['ID', 'How an info icon must always behave'], rows: (src.tooltip_rules || TOOLTIP_RULES).map((t, i) => ['TR-' + (i + 1), typeof t === 'string' ? t : t.text]) });
  B.push({ type: 'table', columns: ['ID', 'Where', 'Icon next to', 'Bubble text (exact)'], rows: (src.tooltips || []).map(t => [rowId(t), t.where, t.icon, t.text]) });
  B.push({ type: 'h2', text: `${n.map}.5 Expandable fields (rules for every page)` });
  B.push({ type: 'table', columns: ['ID', 'How an expandable field must always behave'], rows: (src.expandable_rules || EXPANDABLE_RULES).map((t, i) => ['ER-' + (i + 1), typeof t === 'string' ? t : t.text]) });
  B.push({ type: 'table', columns: ['ID', 'Where', 'Control (exact text)', 'What it reveals'], rows: (src.expandables || []).map(t => [rowId(t), t.where, t.control, t.reveals]) });

  // screens
  for (const s of src.screens || []) {
    B.push({ type: 'h1', text: `${s.num}. ${s.title}`, pageBreak: true });
    B.push({ type: 'p', text: `**Where:** ${s.where || ''}${s.address ? '  **Address:** ' + s.address : ''}` });
    B.push({ type: 'p', text: `**What it is for:** ${s.purpose || ''}` });
    if ((s.text || []).length) B.push({ type: 'p', text: '**Exact text on screen:** ' + s.text.join(' | ') });
    if ((s.elements || []).length) B.push({ type: 'table', columns: ['Element (exact text / name)', 'What it shows or does', 'Must be true'], rows: s.elements.map(e => [e.element, e.shows, e.must || '']) });
    const cs = critFor(s.key);
    if (cs.length) { B.push({ type: 'h3', text: 'Rules a test can check (acceptance criteria)' }); B.push({ type: 'ul', items: cs.map(c => `${c.id} - ${c.text}`) }); B.push({ type: 'note', text: 'These rules are proposed from what was observed and need Business sign-off.' }); }
    for (const nt of s.notes || []) B.push({ type: 'note', text: nt });
    for (const sh of [].concat(s.shots || [])) fig(sh, `${s.title}`);
  }

  // added sections kept from the scan
  B.push({ type: 'h1', text: `${n.workflows}. Business workflows`, pageBreak: true });
  B.push({ type: 'note', text: 'Steps tagged "not executed" are described from what the screens offer; they were not performed because they would change data or send something.' });
  for (const w of src.workflows || []) { B.push({ type: 'h3', text: w.title }); B.push({ type: 'p', text: `**Goal:** ${w.goal || ''}  **Who:** ${w.who || ''}` }); B.push({ type: 'ul', items: (w.steps || []).map(st => st.text + (st.not_executed ? ' (not executed - inferred from the UI)' : '')) }); for (const st of w.steps || []) if (st.shot) fig(st.shot, st.text); }

  B.push({ type: 'h1', text: `${n.data}. Data that must agree across the portal`, pageBreak: true });
  B.push({ type: 'p', text: 'The same number or fact shown on more than one screen must agree. Each row names where to compare.' });
  B.push({ type: 'table', columns: ['ID', 'Rule', 'Where to compare', 'Status'], rows: (src.data_rules || []).filter(d => d.status !== 'retired').map(d => [rowId(d), d.rule, d.where, statusLabel(d.status)]) });
  B.push({ type: 'h1', text: `${n.permissions}. Permissions and data isolation` });
  B.push({ type: 'table', columns: ['Role', 'What they see', 'What they can do', 'What they cannot do', 'Evidence'], rows: (src.permissions || []).map(p => [p.role, p.sees || p.screens || '', p.can || '', p.cannot || '', p.evidence || '']) });
  B.push({ type: 'note', text: 'Only roles that were signed in during a scan have evidence. Any role without evidence is "not observed" and needs a business definition.' });
  B.push({ type: 'h1', text: `${n.criteria}. Acceptance criteria`, pageBreak: true });
  B.push({ type: 'table', columns: ['ID', 'Criterion', 'Section', 'Status'], rows: crit.map(c => [rowId(c), c.text, c.screen === 'global' || !c.screen ? 'All' : ((src.screens || []).find(s => s.key === c.screen) || {}).num || c.screen, statusLabel(c.status)]) });
  B.push({ type: 'h1', text: `${n.safe}. Safe-to-test register (what only opens, and what changes data)`, pageBreak: true });
  B.push({ type: 'p', text: 'Y = the control only opens or views. N = it saves, sends, resolves, publishes, starts a call, deletes, invites, edits or leaves the site. "Y / N" = opening is safe, saving is not.' });
  B.push({ type: 'table', columns: ['Page', 'Control (exact text)', 'Safe', 'Effect', 'Run mode'], rows: (src.safe_to_test || []).map(r => [r.page, r.control, r.safe, r.effect, r.run_mode]) });
  B.push({ type: 'h1', text: `${n.confirm}. Items to confirm with the business`, pageBreak: true });
  B.push({ type: 'table', columns: ['ID', 'What was seen', 'Question for the business', 'Status'], rows: (src.open_questions || []).map(q => [rowId(q), q.seen, q.question, q.status || 'open']) });
  B.push({ type: 'h1', text: `${n.oos}. Out of scope / not covered` }); B.push({ type: 'ul', items: src.out_of_scope || [] });
  B.push({ type: 'h1', text: `${n.judge}. Things only a person can judge` }); B.push({ type: 'ul', items: src.person_judgement || [] });
  B.push({ type: 'h1', text: `${n.coverage}. Load times, coverage and limits`, pageBreak: true });
  B.push({ type: 'h3', text: 'Screens that loaded slowly or did not finish loading' });
  B.push({ type: 'table', columns: ['Screen / action', 'Wait', 'Result'], rows: (src.load_times || []).map(r => [`${r.screen} ${r.action || ''}`.trim(), `${r.secs} s`, r.result || (r.ok === false ? 'did not finish loading (30 s)' : 'slow')]) });
  const cv = src.coverage || {};
  B.push({ type: 'h3', text: 'Coverage and limits' }); B.push({ type: 'ul', items: [].concat(cv.summary || [], (cv.not_reached || []).map(x => 'Not reached: ' + x), cv.limits || []) });

  // document control (end): change log + sheet map
  B.push({ type: 'h1', text: 'Document control: change log and sheet map', pageBreak: true });
  B.push({ type: 'h3', text: 'Change log' });
  B.push({ type: 'table', columns: ['Version', 'Date', 'Sections changed', 'What changed', 'Approved by'], rows: (src.change_log || []).map(c => [c.version, c.date, c.sections, c.what, c.approved_by]) });
  B.push({ type: 'h3', text: 'Which test-case sheet each section feeds' });
  B.push({ type: 'table', columns: ['Document section', 'AutomaQA sheet name', 'Acceptance criteria and rules'], rows: sheetMap(src).map(r => [r.document_section, r.automaqa_sheet_name, r.acceptance_criteria]) });
  return B;
}

function sheetMap(src) {
  const n = assignNumbers(src); const pre = (src.meta && src.meta.sheet_prefix) || 'Portal'; const crit = (src.criteria || []).filter(c => c.status !== 'retired'); const rows = [];
  const global = crit.filter(c => !c.screen || c.screen === 'global').map(c => c.id);
  rows.push({ document_section: `${n.map} Application map, top bar, forms`, automaqa_sheet_name: `${pre} - Navigation`, acceptance_criteria: fmtIds(global) || 'none' });
  if ((src.tooltips || []).length) rows.push({ document_section: `${n.map}.4 Info icons and tooltips`, automaqa_sheet_name: `${pre} - Tooltips`, acceptance_criteria: fmtIds(src.tooltips.map(t => t.id)) });
  if ((src.expandables || []).length) rows.push({ document_section: `${n.map}.5 Expandable fields`, automaqa_sheet_name: `${pre} - Expandable Fields`, acceptance_criteria: fmtIds(src.expandables.map(t => t.id)) });
  if ((src.forms || []).length) rows.push({ document_section: `${n.map}.3 Forms`, automaqa_sheet_name: `${pre} - Forms`, acceptance_criteria: fmtIds(src.forms.map(t => t.id)) });
  for (const s of src.screens || []) rows.push({ document_section: `${s.num} ${s.title}`, automaqa_sheet_name: `${pre} - ${s.title}`, acceptance_criteria: fmtIds(crit.filter(c => c.screen === s.key).map(c => c.id)) || 'none yet' });
  rows.push({ document_section: `${n.data} Data that must agree`, automaqa_sheet_name: `${pre} - Data Consistency`, acceptance_criteria: fmtIds((src.data_rules || []).map(d => d.id)) || 'none yet' });
  rows.push({ document_section: `${n.permissions} Permissions`, automaqa_sheet_name: `${pre} - Access`, acceptance_criteria: fmtIds(crit.filter(c => c.screen === 'permissions').map(c => c.id)) || 'none yet' });
  return rows;
}

// ---------- HTML ----------
const inline = t => E(t).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>');
const CSS = `@page{size:A4}*{box-sizing:border-box}body{font:10.5pt/1.45 "Segoe UI",Arial,sans-serif;color:#1b1f24;margin:0}h1{font-size:15pt;margin:20pt 0 6pt;border-bottom:2px solid #3a6b35;padding-bottom:3pt;page-break-after:avoid}h1.pb{page-break-before:always}h2{font-size:12.5pt;margin:14pt 0 4pt;page-break-after:avoid}h3{font-size:11pt;margin:10pt 0 3pt;page-break-after:avoid}.title{font-size:26pt;font-weight:700;margin:60pt 0 6pt}p,li{margin:3pt 0}ul{padding-left:16pt;margin:3pt 0}figure{margin:6pt 0;page-break-inside:avoid;text-align:center}figure img{max-width:100%;max-height:112mm;border:1px solid #ccd}figcaption{font-size:8.5pt;color:#555}table{border-collapse:collapse;width:100%;font-size:8.8pt;margin:5pt 0}th,td{border:1px solid #ccd;padding:3pt 5pt;text-align:left;vertical-align:top}th{background:#eef3ec}tr{page-break-inside:avoid}.note{background:#fff8e6;border:1px solid #ecd48a;padding:5pt 8pt;border-radius:3px;font-size:9pt;margin:5pt 0}`;
function toHtml(blocks, title) {
  const body = blocks.map(b => {
    if (b.type === 'title') return `<div class="title">${E(b.text)}</div>`;
    if (b.type === 'h1') return `<h1${b.pageBreak ? ' class="pb"' : ''}>${E(b.text)}</h1>`;
    if (b.type === 'h2') return `<h2>${E(b.text)}</h2>`; if (b.type === 'h3') return `<h3>${E(b.text)}</h3>`;
    if (b.type === 'p') return `<p>${inline(b.text)}</p>`; if (b.type === 'note') return `<div class="note">${inline(b.text)}</div>`;
    if (b.type === 'ul') return `<ul>${b.items.map(i => `<li>${inline(i)}</li>`).join('')}</ul>`;
    if (b.type === 'table') return `<table><tr>${b.columns.map(c => `<th>${E(c)}</th>`).join('')}</tr>${b.rows.map(r => `<tr>${b.columns.map((_, i) => `<td>${inline(Array.isArray(r) ? r[i] : '')}</td>`).join('')}</tr>`).join('')}</table>`;
    if (b.type === 'figure') return `<figure><img src="${b.src}"><figcaption>${E(b.caption)}</figcaption></figure>`;
    return '';
  }).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${E(title)}</title><style>${CSS}</style></head><body>${body}</body></html>`;
}

// ---------- TOON ----------
function sectionsFromBlocks(blocks) {
  const secs = []; let sec = null, sub = null;
  const target = () => sub || sec;
  for (const b of blocks) {
    if (b.type === 'title') continue;
    if (b.type === 'h1' || (b.type === 'h2' && !sec)) { sec = { id: (b.text.match(/^(\d+)\./) || [, colKey(b.text)])[1], title: b.text.replace(/^\d+\.\s*/, ''), text: [], tables: [], notes: [], subsections: [] }; sub = null; secs.push(sec); continue; }
    if (!sec) continue;
    if (b.type === 'h2' || b.type === 'h3') { sub = { id: (b.text.match(/^([\d.]+)\s/) || [, colKey(b.text)])[1], title: b.text, text: [], tables: [], notes: [] }; sec.subsections.push(sub); continue; }
    const t = target();
    if (b.type === 'p') t.text.push(b.text.replace(/\*\*/g, ''));
    else if (b.type === 'ul') t.text.push(...b.items); else if (b.type === 'note') t.notes.push(b.text);
    else if (b.type === 'table') { const keys = b.columns.map(colKey); t.tables.push({ columns: b.columns, rows: b.rows.map(r => Object.fromEntries(keys.map((k, i) => [k, String(Array.isArray(r) ? r[i] ?? '' : '')]))) }); }
  }
  for (const s of secs) { if (!s.subsections.length) delete s.subsections; for (const x of [s, ...(s.subsections || [])]) { if (!x.notes.length) delete x.notes; if (!x.tables.length) delete x.tables; if (!x.text.length) delete x.text; } }
  return secs;
}
function buildToon(src, blocks) {
  const m = src.meta || {}; const crit = (src.criteria || []).filter(c => c.status !== 'retired');
  const doc = { title: m.title, version: String(m.version || '1.0'), format: 'TOON (Token-Oriented Object Notation), generated from the same source as the PDF and Word files', subtitle: m.subtitle || '', application: m.application, environment_described: m.environment, observed_on: m.observed_on, document_status: m.status || 'STANDING REFERENCE and READ-ONLY. Changes go through the document owner, who issues a new version.', used_by: m.used_by || 'Business and QA; the QA agent and AutomaQA read this file and never change it.', version_note: m.version_note || '', business_signoff: 'Rules are proposed from what was observed and need Business sign-off (see status per rule).', how_to_read: m.how_to_read || 'Every section starts with where the screen is and what it is for. Quote exact text in tests. Numbers marked seen are examples from the observed date; assert the rule, not the value. Personal data was left out on purpose.', source_file: `${m.file_base || 'document'}_v${m.version || '1.0'}.source.json` };
  const obj = { document: doc,
    llm_guidance: GUIDANCE.map((r, i) => ({ id: 'G-' + (i + 1), rule: r })),
    acceptance_criteria: crit.map(c => ({ id: c.id, criterion: c.text, section: c.screen === 'global' || !c.screen ? 'All' : (((src.screens || []).find(s => s.key === c.screen) || {}).num || c.screen), status: c.status || 'proposed' })),
    data_rules: (src.data_rules || []).filter(d => d.status !== 'retired').map(d => ({ id: d.id, rule: d.rule, where_to_compare: d.where || '', status: d.status || 'proposed' })),
    tooltip_rules: (src.tooltip_rules || TOOLTIP_RULES).map((t, i) => ({ id: 'TR-' + (i + 1), how_an_info_icon_must_always_behave: typeof t === 'string' ? t : t.text })),
    tooltips: (src.tooltips || []).map(t => ({ id: t.id, where: t.where, icon_next_to: t.icon, bubble_text: t.text })),
    expandable_rules: (src.expandable_rules || EXPANDABLE_RULES).map((t, i) => ({ id: 'ER-' + (i + 1), how_an_expandable_field_must_always_behave: typeof t === 'string' ? t : t.text })),
    expandable_fields: (src.expandables || []).map(t => ({ id: t.id, where: t.where, control_exact_text: t.control, what_it_reveals: t.reveals })),
    forms: (src.forms || []).filter(f => f.status !== 'retired').map(f => ({ id: f.id, where: f.where || '', title: f.title, safe: f.safe || 'Y / N', buttons: (f.buttons || []).join(' | '), fields: (f.fields || []).map(x => `${x.label} [${x.type || 'text'}${x.required ? ', required' : ''}]${x.hint ? ' - ' + x.hint : ''}`) })),
    safe_to_test: (src.safe_to_test || []).map(r => ({ page: r.page, control_exact_text: r.control, safe: r.safe, effect: r.effect, run_mode: r.run_mode })),
    permissions: (src.permissions || []).map(p => ({ role: p.role, sees: p.sees || p.screens || '', can: p.can || '', cannot: p.cannot || '', evidence: p.evidence || '' })),
    open_questions: (src.open_questions || []).map(q => ({ id: q.id, what_was_seen: q.seen, question_for_business: q.question, status: q.status || 'open' })),
    out_of_scope: src.out_of_scope || [], only_a_person_can_judge: src.person_judgement || [],
    workflows: (src.workflows || []).map(w => ({ title: w.title, who: w.who || '', goal: w.goal || '', steps: (w.steps || []).map(s => s.text + (s.not_executed ? ' (not executed)' : '')) })),
    glossary: (src.glossary || []).map(g => ({ term: g.term, meaning: g.meaning })),
    load_times: (src.load_times || []).map(r => ({ screen: r.screen, action: r.action || '', secs: r.secs, result: r.result || (r.ok === false ? 'did not finish loading' : 'slow') })),
    sheet_map: sheetMap(src), change_log: (src.change_log || []).map(c => ({ version: String(c.version), date: c.date, sections_changed: c.sections, what_changed: c.what, approved_by: c.approved_by })),
    sections: sectionsFromBlocks(blocks) };
  return toon.stringify(obj);
}

// ---------- verification: all three outputs carry the same IDs ----------
const ID_RX = /\b(?:AC-P|D-|T-|E-|F-|Q-)\d+\b/g;
const idSet = t => new Set((String(t).match(ID_RX) || []));
function verifyOutputs({ html, docx, toonText }) {
  const sets = { pdf_html: idSet(html), docx: idSet(docx), toon: idSet(toonText) }; const all = new Set([...sets.pdf_html, ...sets.docx, ...sets.toon]); const problems = [];
  for (const [k, s] of Object.entries(sets)) for (const id of all) if (!s.has(id)) problems.push(`${id} missing from ${k}`);
  return { ok: !problems.length, problems, count: all.size };
}

async function loadImages(dir, names) {
  const { pw } = require('./pw'); const { chromium } = pw(); const br = await chromium.launch({ headless: true }); const pg = await br.newPage(); const out = {};
  for (const n of names) { const f = path.join(dir, n + '.png'); if (!fs.existsSync(f)) continue; const b64 = fs.readFileSync(f).toString('base64'); await pg.setContent(`<img id="i" src="data:image/png;base64,${b64}">`); await pg.waitForFunction(() => document.getElementById('i').complete); out[n] = await pg.evaluate(() => { const i = document.getElementById('i'); const w = Math.min(1100, i.naturalWidth); const c = document.createElement('canvas'); c.width = w; c.height = Math.round(i.naturalHeight * w / i.naturalWidth); c.getContext('2d').drawImage(i, 0, 0, c.width, c.height); return c.toDataURL('image/jpeg', 0.74); }); }
  await br.close(); return out;
}

async function render(src, { out, screenshots = false, shotsDir = null, pdf = true } = {}) {
  ids.assignIds(src); assignNumbers(src);
  const m = src.meta = src.meta || {}; m.file_base = m.file_base || (m.title || 'Business_Workflow').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const base = path.join(out, `${m.file_base}_v${m.version || '1.0'}`); fs.mkdirSync(out, { recursive: true });
  let images = {};
  if (screenshots && shotsDir) { const names = new Set(); for (const s of src.screens || []) [].concat(s.shots || []).forEach(x => names.add(x)); for (const w of src.workflows || []) for (const st of w.steps || []) if (st.shot) names.add(st.shot); images = await loadImages(shotsDir, [...names]); }
  const blocks = buildBlocks(src, { screenshots, images });
  const html = toHtml(blocks, m.title); const docx = buildDocx(blocks); const toonText = buildToon(src, blocks);
  const v = verifyOutputs({ html, docx: docxText(docx), toonText });
  fs.writeFileSync(base + '.toon', toonText); fs.writeFileSync(base + '.docx', docx); fs.writeFileSync(base + '.source.json', JSON.stringify(src, null, 1)); fs.writeFileSync(base + '.html', html);
  let pdfInfo = null;
  if (pdf) { const { htmlToPdf } = require('./pdf'); pdfInfo = await htmlToPdf(base + '.html', base + '.pdf'); }
  fs.unlinkSync(base + '.html');
  return { files: ['pdf', 'docx', 'toon', 'source.json'].map(x => base + '.' + x), verify: v, pdf: pdfInfo, blocks: blocks.length };
}

async function cli() {
  const a = process.argv.slice(2); const get = k => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
  if (!a[0]) { console.error('usage: node render.js <source.json> --out <dir> [--screenshots on|off] [--shots <dir>] [--no-pdf]'); process.exit(2); }
  const src = JSON.parse(fs.readFileSync(a[0], 'utf8'));
  const r = await render(src, { out: get('--out') || '.', screenshots: get('--screenshots') === 'on', shotsDir: get('--shots'), pdf: !a.includes('--no-pdf') });
  console.log(JSON.stringify({ files: r.files, ids_match_across_outputs: r.verify.ok, ids: r.verify.count, pdf: r.pdf }, null, 1));
  if (!r.verify.ok) { r.verify.problems.slice(0, 10).forEach(p => console.log('MISMATCH ' + p)); process.exit(1); }
}
if (require.main === module) cli().catch(e => { console.error(e.message); process.exit(1); });
module.exports = { render, buildBlocks, buildToon, toHtml, sheetMap, assignNumbers, verifyOutputs, fmtIds, GUIDANCE, TOOLTIP_RULES, EXPANDABLE_RULES };
