#!/usr/bin/env node
// Self-test for the scan helpers. Local server only; nothing external is contacted.
//   node selftest.js        (run from a project that has Playwright installed)
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pw } = require('./pw');
const { installGuard, graphqlInfo } = require('./guard');
const { waitLoaded } = require('./loading');
const { classifyControl, listCandidates } = require('./safety');
const { injectRedaction, removeRedaction } = require('./redact');
const { piiCheck, deleteRaw } = require('./cleanup');
const { htmlToPdf } = require('./pdf');

const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`); };

const PAGE = `<!doctype html><html><body>
<div id="status">Loading…</div>
<div id="content" style="display:none">Total: <span id="total">0</span></div>
<button id="resend">Resend invitation to Test User</button>
<button id="sync">Sync</button>
<button id="next">Next day</button><button id="pp">Postpartum</button>
<button id="exp" aria-expanded="false">Details</button>
<a id="out" href="/logout">Sign out</a><a id="nohref" tabindex="0">Jane Roe</a><a id="nav" href="/orders">Orders</a>
<p id="pii">Contact: test.user@example.com, +1 (213) 212-1425, DOB: 10/07/2000, 221 Baker Street</p>
<script>
setTimeout(function(){document.getElementById('status').remove();document.getElementById('content').style.display='block';document.getElementById('total').textContent='42';},3000);
fetch('/telemetry',{method:'POST',body:'x'});
fetch('/graphql',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query:'query Q { items { id } }',operationName:'Q'})});
document.getElementById('resend').onclick=function(){fetch('/api/resend',{method:'POST',body:'{}'}).catch(function(){window.__aborted=(window.__aborted||0)+1;});};
document.getElementById('sync').onclick=function(){fetch('/graphql',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query:'mutation M { touch }',operationName:'M'})}).catch(function(){window.__aborted=(window.__aborted||0)+1;});};
</script></body></html>`;
const FORM = `<!doctype html><meta charset="utf-8"><body><button id="nf">New Order</button><div id="dlg" role="dialog" style="display:none"><h2>New Order</h2><label for="cn">Customer Name *</label><input id="cn" type="text" required placeholder="Start typing"><label for="q">Quantity</label><input id="q" type="number"><button id="cx">Cancel</button><button id="sv">Save Order</button></div><script>document.getElementById('nf').onclick=function(){document.getElementById('dlg').style.display='block'};document.getElementById('cx').onclick=function(){document.getElementById('dlg').style.display='none'};document.getElementById('sv').onclick=function(){fetch('/api/orders',{method:'POST',body:'{}'}).catch(function(){window.__saveBlocked=true})};</script></body>`;
const LEARN = `<!doctype html><meta charset="utf-8"><body><p>Learn page</p><script>fetch('/api/v1/messaging/session/',{method:'POST',body:'{}'}).catch(function(){});fetch('/api/v1/client/9/tracking-overview/insights/',{method:'POST',body:'{}'}).catch(function(){});</script></body>`;
const SPIN = '<!doctype html><body><div class="spinner">x</div><p>Loading…</p></body>';

(async () => {
  const hits = {};
  const server = http.createServer((req, res) => {
    const k = req.method + ' ' + req.url.split('?')[0];
    hits[k] = (hits[k] || 0) + 1;
    req.on('data', () => {}); req.on('end', () => {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      if (req.url === '/spinner') return res.end(SPIN);
      if (req.url === '/form') return res.end(FORM);
      if (req.url === '/learn') return res.end(LEARN);
      res.end(req.method === 'GET' && (req.url === '/' || req.url === '/orders' || req.url === '/logout') ? PAGE : '{}');
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  // ---- classifier (pure) ----
  const cls = (label, extra = {}) => classifyControl({ label, role: 'button', tag: 'button', ...extra }).verdict;
  check('classify: "Resend invitation to Ana" is unsafe', cls('Resend invitation to Ana') === 'unsafe');
  check('classify: icon text "edit_note" is an opener (open-form), not unsafe', cls('edit_note') === 'open-form');
  check('classify: "Add Task" / "New Appointment" / "Invite" / "Add Notes" open read-only (open-form)', ['Add Task', 'New Appointment', 'Invite', 'Add Notes', 'add New Appointment'].every(l => cls(l) === 'open-form'));
  check('classify: whole words - "Invited Clients" is NOT "Invite"; "Newsletter" is not "New"', cls('Invited Clients') === 'safe' && cls('Newsletter') === 'review');
  check('classify: Save / Save Appointment / Send Invite / Generate Plan stay unsafe', ['Save', 'Save Appointment', 'Send Invite', 'Generate Plan', 'Resend'].every(l => cls(l) === 'unsafe'));
  check('classify: "Postpartum" is NOT flagged by "post"', cls('Postpartum') === 'review');
  check('classify: "Next day" / "30 Days" / "Week" safe', ['Next day', '30 Days', 'Week'].every(l => cls(l) === 'safe'));
  check('classify: role=tab safe, aria-expanded safe', cls('Needs Attention', { role: 'tab' }) === 'safe' && cls('Details', { expanded: 'false' }) === 'safe');
  check('classify: ordinary control inside a dialog is REVIEW (shown to the user), a form opener inside a dialog is unsafe', cls('Open', { inOverlay: true }) === 'review' && cls('Add Task', { inOverlay: true }) === 'unsafe');
  check('classify: TABS inside a side panel are safe (role=tab, tab group, expander); Save inside a tab group is still unsafe', cls('Trigger', { inOverlay: true, inTablist: true }) === 'safe' && cls('Recipe', { inOverlay: true, role: 'tab' }) === 'safe' && cls('Show more', { inOverlay: true }) === 'safe' && cls('Save', { inOverlay: true, inTablist: true }) === 'unsafe');
  check('classify: plain-button tabs (data-testid ending -tab) are a tab group', cls('Needs Attention', { inTablist: true }) === 'safe');
  check('classify: checkbox/switch never clicked', cls('Notify me', { role: 'switch' }) === 'unsafe' && cls('Remember', { role: 'checkbox' }) === 'unsafe');
  check('classify: "apply" is REVIEW, not unsafe, and never safe (even with aria-expanded)', cls('7 overdue, apply filter') === 'review' && cls('Apply') === 'review' && cls('Apply', { expanded: 'false' }) === 'review');
  check('classify: "Apply and send" is still unsafe (forbidden word wins)', cls('Apply and send') === 'unsafe');
  check('classify: unknown label needs review', cls('Wibble') === 'review');
  check('classify: "Schedule" nav link is not forbidden', cls('Schedule', { tag: 'a', href: '/schedule', sameOrigin: true }) === 'safe');
  check('graphql: query=read, mutation=write, persisted=unknown',
    graphqlInfo('{"query":"query A{x}"}').read && !graphqlInfo('{"query":"mutation M{x}"}').read && !graphqlInfo('{"operationName":"A"}').read);

  // ---- browser, attached over CDP like a real scan ----
  const { chromium } = pw();
  const launched = await chromium.launch({ headless: true, args: ['--remote-debugging-port=9444'] });
  const lctx = await launched.newContext();
  const lpage = await lctx.newPage();
  await lpage.goto(base + '/', { waitUntil: 'domcontentloaded' });
  const browser = await chromium.connectOverCDP('http://localhost:9444');
  let page = null;
  for (const c of browser.contexts()) for (const p of c.pages()) if (p.url().startsWith(base)) page = p;
  check('cdp: attached to the existing tab', !!page);
  const ctx = page.context();
  for (const k of Object.keys(hits)) delete hits[k];

  const guard = await installGuard(ctx, { allowRequests: [{ method: 'POST', path: /^\/telemetry$/ }] });
  await page.reload({ waitUntil: 'domcontentloaded' });

  // ---- loading protocol ----
  const t0 = Date.now();
  const lr = await waitLoaded(page);
  const txt = await page.locator('#content').innerText().catch(() => '');
  check('loading: waits through the 3s spinner then reads real content', lr.ok && txt.includes('42') && lr.waitedMs >= 2500, `waited ${lr.waitedMs}ms`);
  const sp = await ctx.newPage(); await sp.goto(base + '/spinner');
  const sr = await waitLoaded(sp, { maxMs: 4000 });
  check('loading: never-ending spinner reported as "did not finish loading"', !sr.ok && sr.reason === 'did not finish loading');
  await sp.close();

  // ---- candidates + guard ----
  const cands = await listCandidates(page);
  const by = l => cands.find(c => c.label === l);
  check('candidates: Resend=unsafe, Sync=review (neutral label), Next day=safe, Details=safe',
    by('Resend invitation to Test User')?.verdict === 'unsafe' && by('Sync')?.verdict === 'review' && by('Next day')?.verdict === 'safe' && by('Details')?.verdict === 'safe',
    cands.map(c => c.label + ':' + c.verdict).join(' | '));
  check('candidates: anchor with NO href (router link) is found, and needs review', by('Jane Roe')?.verdict === 'review');
  check('candidates: logout link unsafe, internal link safe', by('Sign out')?.verdict === 'unsafe' && by('Orders')?.verdict === 'safe');

  // The guard must hold even if a bad click happens (simulate the mistake on purpose).
  await page.getByRole('button', { name: 'Resend invitation to Test User' }).click();
  await page.getByRole('button', { name: 'Sync' }).click();   // neutral label that performs a GraphQL mutation
  await page.waitForTimeout(800);
  check('GUARD: POST /api/resend never reached the server', !hits['POST /api/resend']);
  check('GUARD: GraphQL mutation never reached the server (neutral label "Sync")', !hits['POST /graphql'] || hits['POST /graphql'] === 1);
  const s = guard.summary();
  check('GUARD: both attempts recorded as blocked', s.blocked.some(b => /\/api\/resend/.test(b.key)) && s.blocked.some(b => /graphql/.test(b.key)), s.blocked.map(b => b.key + 'x' + b.count).join(', '));
  check('GUARD: telemetry + GraphQL query were allowed through', s.allowed.some(a => /telemetry/.test(a.key)) && s.allowed.some(a => /graphql query/.test(a.key)));
  const lastAborts = await page.evaluate(() => window.__aborted || 0);
  check('GUARD: the page saw the requests fail (aborted)', lastAborts >= 2, 'aborted=' + lastAborts);
  const g0 = hits['GET /logout'] || 0;
  await page.goto(base + '/logout').catch(() => {});
  check('GUARD: GET navigation to /logout blocked', (hits['GET /logout'] || 0) === g0 && guard.summary().blockedGets.length === 1);
  const auditFile = path.join(os.tmpdir(), 'aq-audit-' + Date.now() + '.json'); guard.writeAudit(auditFile);
  check('GUARD: audit file written', JSON.parse(fs.readFileSync(auditFile)).blocked.length >= 2); fs.unlinkSync(auditFile);

  // ---- redaction ----
  // A blocked navigation leaves the tab on an error page and can interrupt the next goto,
  // so recover by opening the last good URL in a fresh tab (the skill documents this).
  const rp = await ctx.newPage(); await rp.goto(base + '/', { waitUntil: 'domcontentloaded' }); await waitLoaded(rp);
  const before = await rp.locator('#pii').innerText();
  const n = await injectRedaction(rp);
  const blurred = await rp.locator('#pii .aq-blur').allInnerTexts();
  check('redact: email, phone, DOB, address all blurred', n >= 4 && blurred.some(t => /@/.test(t)) && blurred.some(t => /212/.test(t)) && blurred.some(t => /DOB/i.test(t)) && blurred.some(t => /Baker/.test(t)), blurred.length + ' spans');
  await removeRedaction(rp);
  const after = await rp.locator('#pii').innerText();
  check('redact: DOM restored exactly after screenshot', before === after && (await rp.locator('.aq-blur').count()) === 0);

  await browser.close().catch(() => {}); await launched.close().catch(() => {});

  // ---- cleanup ----
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-clean-'));
  const raw = path.join(tmp, 'raw'), model = path.join(tmp, 'model');
  fs.mkdirSync(raw); fs.mkdirSync(model);
  fs.writeFileSync(path.join(raw, 'S01.aria.txt'), 'name: Jane Roe jane@x.com');
  fs.writeFileSync(path.join(model, 'clean.txt'), 'S01|/orders|Orders|list');
  check('cleanup: clean model has no PII hits', piiCheck(model).length === 0);
  fs.writeFileSync(path.join(model, 'dirty.txt'), 'contact jane@x.com +1 (213) 212-1425 DOB: 10/07/2000');
  const hitKinds = piiCheck(model).map(h => h.kind).sort().join(',');
  check('cleanup: model with PII is flagged (email, phone, dob)', /dob/.test(hitKinds) && /email/.test(hitKinds) && /phone/.test(hitKinds), hitKinds);
  const del = deleteRaw(raw);
  check('cleanup: raw folder deleted', del.deleted && !fs.existsSync(raw));
  fs.rmSync(tmp, { recursive: true, force: true });

  // ---- pdf ----
  const htmlF = path.join(os.tmpdir(), 'aq-pdf-' + Date.now() + '.html'), pdfF = htmlF.replace('.html', '.pdf');
  fs.writeFileSync(htmlF, '<h1>Scan test</h1>' + '<p>row</p>'.repeat(400));
  const pr = await htmlToPdf(htmlF, pdfF);
  check('pdf: valid PDF with at least one page', pr.ok && pr.pages >= 1, `${pr.pages} pages, ${pr.bytes} bytes`);
  fs.unlinkSync(htmlF); fs.unlinkSync(pdfF);

  // ============ NEW MODULES ============
  const dir = path.join(os.tmpdir(), 'aq-new-' + Date.now()); fs.mkdirSync(dir, { recursive: true });
  const toon = require('./toon'); const ids = require('./ids'); const cons = require('./consistency'); const upd = require('./update'); const qa = require('./qa');
  const rnd = require('./render'); const { docxText } = require('./docx'); const rsm = require('./resume'); const roles = require('./roles'); const ev = require('./evidence');
  const example = () => JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'templates', 'scan', 'source.example.json'), 'utf8'));

  // TOON
  const sample = { document: { title: 'T', version: '1.0', note: 'has, comma and: colon' }, rules: [{ id: 'AC-P1', criterion: 'a "quoted" rule, with comma' }, { id: 'AC-P2', criterion: 'plain' }], list: ['a', 'b,c'], sections: [{ id: '1', title: 'One', text: ['x'], tables: [{ columns: ['A', 'B'], rows: [{ a: '1', b: 'x,y' }] }] }] };
  check('toon: round trip (objects, tabular rows, quoting, nested lists)', JSON.stringify(toon.parse(toon.stringify(sample))) === JSON.stringify(sample));

  // IDs
  const s0 = example(); const added = ids.assignIds(s0);
  check('ids: every keyed item gets an ID (AC-P, D-, T-, E-, Q-, F-)', ['AC-P1', 'D-1', 'T-1', 'E-1', 'Q-1', 'F-1'].every(i => added.includes(i)) && ids.validateIds(s0).length === 0);
  ids.retire(s0, 'AC-P2'); s0.criteria.push({ key: 'ac:new', screen: 'orders', text: 'New rule.' }); ids.assignIds(s0);
  check('ids: next free number is above every ID ever used; a retired ID is never reused', s0.criteria.find(c => c.key === 'ac:new').id === 'AC-P5' && s0.id_registry['AC-P'].retired.includes('AC-P2'));
  const dup = example(); dup.criteria[0].id = 'AC-P1'; dup.criteria[1].id = 'AC-P1';
  check('ids: duplicate or malformed IDs are reported', ids.validateIds(dup).some(e => /duplicate/.test(e)) && ids.validateIds({ criteria: [{ key: 'k', id: 'XX-1', text: 't' }] }).some(e => /bad ID/.test(e)));

  // consistency pass
  const facts = cons.harvestFacts({ S03: 'Alerts Severity: All (1034) Critical (199) Showing 25 of 97 alerts', S07: 'Client Alerts 12 Tasks 7', S01: '7 Overdue  Needs Attention', S12: 'All alerts (1030)' });
  const groups = cons.findCrossScreen(facts);
  check('consistency: the same quantity on several screens is found, with agree / differ', groups.some(g => g.key === 'alert' && g.screens.length >= 2) && facts.some(f => f.key === 'task' && f.value === 7));
  const cs = example(); const gp = [{ key: 'client total', label: 'Clients total', screens: ['S02', 'S03'], values: [194], agree: true, facts: [] }, { key: 'alert total', label: 'Alerts', screens: ['S03', 'S07'], values: [97, 1034], agree: false, facts: [{ screen: 'S03', value: 97 }, { screen: 'S07', value: 1034 }] }];
  const prop = cons.proposeRules(cs, gp, '2026-11-04'); ids.assignIds(cs);
  check('consistency: agreeing numbers become D- rules, differing ones become Q- questions (both with "seen on")', prop.length === 2 && cs.data_rules.some(r => /seen on 2026-11-04/.test(r.rule) && r.id) && cs.open_questions.some(q => /differs/.test(q.seen) && /seen on/.test(q.seen) && q.id));
  const mv = cons.diffFacts([{ key: 'alert', screen: 'S03', value: 860 }], [{ key: 'alert', screen: 'S03', value: 1034 }]);
  check('consistency: numbers that moved since last time are reported (860 -> 1,034)', mv.length === 1 && /860 -> 1,034/.test(cons.fmtMoved(mv[0])));

  // quality check
  const good = example(); ids.assignIds(good);
  check('qa: the example source passes; exact text checked against evidence', qa.check(good, { evidence: 'Orders Showing 25 of 60 orders Status New Order Customers Showing 10 of 12 customers Customer Name Quantity Show details Total number of orders in the selected period across all customers.' }).ok);
  const bad = example(); ids.assignIds(bad);
  bad.criteria.push({ key: 'ac:noid', screen: 'orders', text: 'A rule' }); delete bad.criteria[bad.criteria.length - 1].id;
  bad.criteria.push({ key: 'ac:num', id: 'AC-P90', screen: 'orders', text: 'There are 861 alerts today.' });
  bad.screens.push({ key: 'empty', title: 'Empty', text: [], elements: [] });
  bad.screens[0].text.push('Text that is not on screen');
  bad.open_questions.push({ key: 'q:pii', id: 'Q-90', seen: 'Contact jane.roe@example.com on 4 November 2026 (seen on 4 November 2026)', question: 'q', status: 'open' });
  const br = qa.check(bad, { evidence: 'Orders Showing 25 of 60 orders', names: ['Jane Roe'] });
  const codes = br.failures.map(x => x.code);
  check('qa FAILS on: missing ID', codes.includes('id') && br.failures.some(x => /no ID/.test(x.msg)));
  check('qa FAILS on: a number without "seen on <date>"', br.failures.some(x => x.code === 'number' && /861/.test(x.msg)));
  check('qa FAILS on: an exact-text quote not found in the scan evidence', br.failures.some(x => x.code === 'quote' && /not on screen/.test(x.msg)));
  check('qa FAILS on: a section with no rule', br.failures.some(x => x.code === 'rule' && /"empty"/.test(x.msg)));
  check('qa FAILS on: personal data (email pattern and a deny-listed name)', br.failures.filter(x => x.code === 'pii').length >= 1 && qa.check({ ...example(), glossary: [{ term: 'x', meaning: 'Jane Roe called' }] }, { names: ['Jane Roe'] }).failures.some(x => x.code === 'pii'));
  check('qa: a number tagged number_kind="rule", or with "seen on <date>", is accepted', qa.needsSeen('Showing 25 of N') === true && qa.check(Object.assign(example(), {}), {}).failures.filter(x => x.code === 'number').length === 0);

  // update mode
  const prev = example(); ids.assignIds(prev); prev.facts = [{ key: 'alert', screen: 'orders', value: 860, seen: '2026-10-01' }];
  const fresh = { screens: [{ key: 'orders', title: 'Orders', text: ['Orders'], elements: [] }], criteria: [{ key: 'ac:orders-paging', screen: 'orders', text: 'The Orders list shows 25 per page and the total equals the sum over all pages. (changed wording)', number_kind: 'rule' }, { key: 'ac:orders-export', screen: 'orders', text: 'A brand new rule.' }], facts: [{ key: 'alert', screen: 'orders', value: 1034, seen: '2026-11-04' }] };
  const um = upd.mergeUpdate(prev, fresh, { areas: ['orders'], date: '2026-11-10', approvedBy: 'Pending Business sign-off' });
  const ac = k => um.source.criteria.find(c => c.key === k);
  check('update: existing IDs kept, new key gets the next free number', ac('ac:orders-paging').id === 'AC-P1' && ac('ac:orders-export').id === 'AC-P5');
  check('update: items of the rescanned area not seen again are marked not-seen (ID kept); other areas are carried', ac('ac:orders-filter').status === 'not-seen' && ac('ac:orders-filter').id === 'AC-P2' && ac('ac:customers-paging').carried === true);
  check('update: version bumped and a change-log row written, including numbers that moved', um.source.meta.version === '1.1' && um.source.change_log.length === 2 && /860 -> 1,034/.test(um.source.change_log[1].what) && um.source.change_log[1].sections === 'orders');
  check('update: nextVersion', upd.nextVersion('1.6') === '1.7');
  const sidecar = path.join(dir, 'prev.source.json'); fs.writeFileSync(sidecar, JSON.stringify(prev));
  check('update: loads a previous source (.json) and a previous .toon (IDs and registers)', upd.loadPrevious(sidecar).criteria.length === 4);
  const ren0 = await rnd.render(example(), { out: dir, pdf: false });
  const loaded = upd.loadPrevious(ren0.files.find(x => /\.toon$/.test(x)));
  check('update: a .toon on its own can be loaded (criteria, tooltips, questions keep their IDs)', loaded.criteria.length === 4 && loaded.tooltips[0].id === 'T-1' && loaded.open_questions[0].id === 'Q-1');

  // one source -> three outputs
  const ren = await rnd.render(example(), { out: path.join(dir, 'r'), pdf: true });
  check('render: PDF + Word + TOON written from one source, PDF valid', ren.files.every(x => fs.existsSync(x)) && ren.pdf && ren.pdf.ok);
  check('render: the three outputs carry exactly the same IDs', ren.verify.ok && ren.verify.count === 9, ren.verify.problems.join('; '));
  const toonOut = toon.parse(fs.readFileSync(ren.files.find(x => /\.toon$/.test(x)), 'utf8'));
  check('render: TOON has guidance G-1..G-10, sheet_map and change_log', toonOut.llm_guidance.length === 10 && toonOut.llm_guidance[9].id === 'G-10' && toonOut.sheet_map.length >= 5 && toonOut.change_log.length === 1);
  check('render: sheet_map maps each screen to its AC- IDs', toonOut.sheet_map.some(r => /Orders/.test(r.automaqa_sheet_name) && /AC-P1/.test(r.acceptance_criteria)));
  const blocksText = JSON.stringify(rnd.buildBlocks(example(), {}));
  check('render: fixed structure (document control, using this document, purpose and users, screens, data that must agree, permissions, acceptance criteria, safe-to-test, items to confirm, out of scope, person-only, change log)', ['Document control', 'Using this document when the portal changes', 'Purpose and users', 'Application map', 'Data that must agree across the portal', 'Permissions and data isolation', 'Acceptance criteria', 'Safe-to-test register', 'Items to confirm with the business', 'Out of scope', 'Things only a person can judge', 'Change log'].every(h => blocksText.includes(h)));
  check('render: kept from the scan - workflows, executive summary, glossary, load times, coverage', ['Business workflows', 'Executive summary', 'Glossary', 'Screens that loaded slowly', 'Coverage and limits'].every(h => blocksText.includes(h)));
  check('render: screenshots are off by default (no figure blocks)', !/"type":"figure"/.test(blocksText));
  check('render: "proposed - needs Business sign-off" is visible on rules, and a person-only list exists', /Proposed - needs Business sign-off/.test(blocksText) && /Things only a person can judge/.test(blocksText));
  const wordXml = docxText(fs.readFileSync(ren.files.find(x => /\.docx$/.test(x))));
  check('render: Word file carries the headings and tables', /Acceptance criteria/.test(wordXml) && /Safe-to-test register/.test(wordXml) && /AC-P1/.test(wordXml));

  // resume mode
  rsm.writeCoverage(dir, [{ id: 'S01', route: '/a' }], [{ kind: 'client tab', name: 'Notes', reason: 'queued, budget used', route: '/c/:id/notes' }, { kind: 'panel', name: 'Notifications', reason: 'ask-first: may mark read' }, { kind: 'link', name: 'Open Dashboards', reason: 'external, not followed' }]);
  const plan = rsm.resumePlan(dir);
  check('resume: continues with queued/budget items only; ask-first and external items need approval', plan.next.length === 1 && plan.next[0].name === 'Notes' && plan.needsApproval.length === 2 && plan.covered === 1);

  // roles
  const r1 = roles.roleSnapshot('provider', { menu: ['My Day', 'Clients'], screens: { '/myday': { visible: true, controls: ['Add Task'] } }, date: '2026-11-04' });
  const r2 = roles.roleSnapshot('admin', { menu: ['My Day', 'Clients', 'Admin'], screens: { '/myday': { visible: true }, '/admin': { visible: true } } });
  const perm = roles.comparePermissions([r1, r2]);
  check('roles: per-role menus compared; "cannot" only from what was observed; missing roles are "not observed"', /Admin/.test(perm[0].cannot) && /My Day, Clients, Admin/.test(perm[1].sees) && roles.notObserved(['research analyst'])[0].sees === 'Not observed');

  // ---- browser tests for the new helpers ----
  const { readForm, closeForm } = require('./forms'); const { learn, formatForApproval } = require('./learn');
  const b2 = await chromium.launch({ headless: true }); const ctx2 = await b2.newContext(); const pg2 = await ctx2.newPage();
  const g2 = await installGuard(ctx2, {});
  await pg2.goto(base + '/form', { waitUntil: 'domcontentloaded' });
  const cand2 = await listCandidates(pg2); const nb = cand2.find(c => c.label === 'New Order');
  check('forms: "New Order" is classified open-form', nb && nb.verdict === 'open-form');
  await pg2.locator('[data-aq-c="' + nb.i + '"]').click(); await pg2.waitForTimeout(300);
  const form = await readForm(pg2);
  check('forms: dialog opened read-only; title, fields (label, type, required, hint) and buttons recorded', form.open && form.title === 'New Order' && form.fields.length === 2 && form.fields[0].label === 'Customer Name' && form.fields[0].required === true && form.fields[0].hint === 'Start typing' && form.fields[1].type === 'number' && form.buttons.includes('Cancel') && form.buttons.includes('Save Order'), JSON.stringify(form).slice(0, 200));
  const closed = await closeForm(pg2);
  const saveHits = await pg2.evaluate(() => window.__saveBlocked || false);
  check('forms: closed with Cancel only; nothing was saved', closed === true && saveHits === false && g2.summary().blocked.length === 0);
  // prove the guard backs this up: a (deliberately wrong) Save click is aborted before leaving the browser
  await pg2.locator('#nf').click(); await pg2.locator('#sv').click(); await pg2.waitForTimeout(400);
  check('forms: even a mistaken Save click cannot write (guard aborts the request)', g2.summary().blocked.some(b => /\/api\/orders/.test(b.key)) && !hits['POST /api/orders']);
  await ev.dumpEvidence(pg2, dir, 'F01');
  const evText = fs.readFileSync(path.join(dir, 'F01.text.txt'), 'utf8'); const evAttrs = fs.readFileSync(path.join(dir, 'F01.attrs.txt'), 'utf8');
  check('evidence: page text, attribute text (labels, placeholders, tooltips) and dialogs are dumped for the exact-text check', /Customer Name/.test(evText) && /Start typing/.test(evAttrs));
  check('qa: exact text checked against dumped evidence (found = pass, absent = fail)', qa.check({ screens: [{ key: 'f', title: 'F', text: ['Customer Name'], elements: [] }], criteria: [{ key: 'c', id: 'AC-P1', screen: 'f', text: 'ok' }] }, { evidence: qa.loadEvidence(dir) }).ok && !qa.check({ screens: [{ key: 'f', title: 'F', text: ['Not here'], elements: [] }], criteria: [{ key: 'c', id: 'AC-P1', screen: 'f', text: 'ok' }] }, { evidence: qa.loadEvidence(dir) }).ok);
  const pg3 = await ctx2.newPage();
  const lr2 = await learn(pg3, base + '/learn');
  const txt2 = formatForApproval(lr2);
  check('learn: the blocked-request list is shown at the start, with hints, and nothing is auto-approved', lr2.blocked.length === 2 && /messaging\/session/.test(txt2) && /insights/.test(txt2) && /may be a read-only call/.test(txt2) && /stays blocked|stay blocked/.test(txt2));
  const html2 = await pg3.evaluate(x => { const d = new DOMParser().parseFromString(x, 'application/xml'); return !d.querySelector('parsererror'); }, require('./docx').unzipEntry(fs.readFileSync(ren.files.find(x => /\.docx$/.test(x))), 'word/document.xml'));
  check('docx: document.xml is well-formed XML', html2 === true);
  await b2.close();
  fs.rmSync(dir, { recursive: true, force: true });

  server.close();
  const failed = results.filter(r => !r).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('SELFTEST ERROR', e); process.exit(1); });
