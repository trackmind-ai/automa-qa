#!/usr/bin/env node
'use strict';
/**
 * report.js — render results.json as a self-contained HTML report plus a Markdown summary.
 *
 *   node report.js <results.json> [--out dir]
 *
 * Files are written to <out>/reports/: api-report-<timestamp>.html/.md and latest.html/.md.
 * Everything in results.json is already redacted by run.js; this only formats it.
 */

const fs = require('fs');
const path = require('path');

const esc = (s) => String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ORDER = ['FAIL', 'ERROR', 'WARN', 'SKIPPED', 'PASS'];
const CAT_LABEL = {
  auth: 'Authentication / permission (401, 403)',
  'auth-not-sent': 'Auth failed, but no token was sent (request is set to No Auth in the collection)',
  'route-not-found': 'Route not found (HTML 404) — collection path is probably outdated',
  'data-not-found': 'Data not found (JSON 404) — check IDs / test data',
  'not-found': 'Not found (404) — check IDs',
  validation: 'Validation (400, 409, 415, 422) — check payload / mandatory params',
  'server-error': 'Server error (5xx)',
  'rate-limit': 'Rate limited (429)',
  redirect: 'Unexpected redirect (3xx)',
  'unexpected-status': 'Unexpected status',
  network: 'Network / timeout',
  'schema-mismatch': 'Response payload differs from saved example',
  'error-in-2xx': 'HTTP 2xx but body signals an error',
  'status-differs': 'Status differs from documented example',
  slow: 'Slow response',
};

function groupBy(arr, f) {
  const m = new Map();
  for (const x of arr) {
    const k = f(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

function summarise(doc) {
  const rs = doc.results;
  const folders = [...groupBy(rs, (r) => r.folder.split(' / ')[0] || '(root)')].map(([name, items]) => {
    const c = Object.fromEntries(ORDER.map((s) => [s, items.filter((i) => i.status === s).length]));
    return { name, total: items.length, ...c };
  });
  const issues = [...groupBy(rs.flatMap((r) => r.issues.map((i) => ({ ...i, req: r }))), (i) => i.category)]
    .map(([cat, items]) => ({ cat, count: items.length, fails: items.filter((i) => i.level === 'fail').length, items }))
    .sort((a, b) => b.fails - a.fails || b.count - a.count);
  const skipped = [...groupBy(rs.filter((r) => r.status === 'SKIPPED'), (r) => r.skipKind || 'other')].map(([kind, items]) => ({ kind, items }));
  return { folders, issues, skipped };
}

const SKIP_LABEL = {
  'missing-input': 'Missing input — provide the value and re-run',
  dependency: 'Dependency not met — an upstream request that produces the needed value did not succeed',
  blocked: 'Blocked by safety gate',
  'token-endpoint': 'Token endpoint without credentials',
  'dry-run': 'Dry run — would send now',
  'dry-run-dependent': 'Dry run — would send only if an upstream request produces the needed value',
  'invalid-request': 'Invalid request in the collection (no URL)',
  other: 'Other',
};

function renderHtml(doc) {
  const c = doc.meta.counts;
  const s = summarise(doc);
  const ran = c.PASS + c.WARN + c.FAIL + c.ERROR;
  const rate = ran ? Math.round(((c.PASS + c.WARN) / ran) * 100) : 0;
  const pct = (n) => (c.total ? (n / c.total) * 100 : 0).toFixed(2);

  const card = (label, n, cls) => `<div class="card ${cls}"><div class="n">${n}</div><div class="l">${label}</div></div>`;
  const rows = doc.results
    .slice()
    .sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || a.id.localeCompare(b.id))
    .map((r) => {
      const detail = [
        r.skipReason ? `<p><b>Why skipped:</b> ${esc(r.skipReason)}</p>` : '',
        r.url ? `<p class="mono">${esc(r.method)} ${esc(r.url)}</p>` : '',
        r.checks.length ? `<ul class="checks">${r.checks.map((k) => `<li class="${esc(k.level)}"><b>${esc(k.name)}</b> — ${esc(k.message)}</li>`).join('')}</ul>` : '',
        r.issues.filter((i) => i.hint).map((i) => `<p class="hint">💡 ${esc(i.hint)}</p>`).join(''),
        r.captured && r.captured.length ? `<p class="muted">Captured for later requests: ${r.captured.map((x) => `${esc(x.var)} (${esc(x.how)})`).join(', ')}</p>` : '',
        (r.warnings || []).map((w) => `<p class="hint">⚠ ${esc(w)}</p>`).join(''),
        r.request ? `<details><summary>Request body (masked)</summary><pre>${esc(r.request)}</pre></details>` : '',
        r.response ? `<details><summary>Response body (masked)</summary><pre>${esc(r.response)}</pre></details>` : '',
      ].join('');
      const exp = r.expected && r.expected.length ? r.expected.join('/') : '2xx';
      return `<tr class="row" data-status="${esc(r.status)}" data-text="${esc((r.path + ' ' + r.method + ' ' + (r.skipReason || '')).toLowerCase())}">
<td><span class="pill ${esc(r.status)}">${esc(r.status)}</span></td><td class="mono">${esc(r.id)}</td><td class="mono">${esc(r.method)}</td>
<td>${esc(r.path)}</td><td class="mono">${esc(exp)}</td><td class="mono">${esc(r.httpStatus || '—')}</td><td class="mono">${r.ms ? esc(r.ms) + 'ms' : '—'}</td>
<td>${detail ? `<details><summary>details</summary>${detail}</details>` : ''}</td></tr>`;
    })
    .join('');

  const folderRows = s.folders.map((f) => `<tr><td>${esc(f.name)}</td><td>${f.total}</td><td class="PASS-t">${f.PASS}</td><td class="WARN-t">${f.WARN}</td><td class="FAIL-t">${f.FAIL + f.ERROR}</td><td>${f.SKIPPED}</td></tr>`).join('');

  const issueBlocks = s.issues.length
    ? s.issues.map((g) => `<details class="issue"><summary><b>${esc(CAT_LABEL[g.cat] || g.cat)}</b> <span class="muted">— ${g.count} finding${g.count > 1 ? 's' : ''}</span></summary><ul>${g.items.slice(0, 60).map((i) => `<li><span class="mono">${esc(i.req.id)}</span> ${esc(i.req.method)} ${esc(i.req.path)} — ${esc(i.message)}</li>`).join('')}${g.items.length > 60 ? `<li class="muted">…and ${g.items.length - 60} more (see results.json)</li>` : ''}</ul></details>`).join('')
    : '<p class="muted">No issues found.</p>';

  const skipBlocks = s.skipped.length
    ? s.skipped.map((g) => {
        const byReason = [...groupBy(g.items, (r) => r.skipReason)].sort((a, b) => b[1].length - a[1].length);
        return `<details class="issue"><summary><b>${esc(SKIP_LABEL[g.kind] || g.kind)}</b> <span class="muted">— ${g.items.length} request${g.items.length > 1 ? 's' : ''}</span></summary><ul>${byReason.slice(0, 25).map(([reason, items]) => `<li>${esc(reason)} <span class="muted">(${items.length})</span></li>`).join('')}</ul></details>`;
      }).join('')
    : '<p class="muted">Nothing was skipped.</p>';

  const inputs = doc.inputs.missing.length ? `<p>Inputs still missing: ${doc.inputs.missing.map((m) => `<code>${esc(m)}</code>`).join(' ')}</p>` : '<p class="muted">All required inputs were available.</p>';
  const lint = doc.lint.filter((l) => l.level === 'warn').map((l) => `<li>${esc(l.message)} ${l.requests.length ? `<span class="muted">(${l.requests.length})</span>` : ''}</li>`).join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>API Test Report — ${esc(doc.meta.collection)}</title>
<style>
:root{--bg:#fff;--fg:#1a1d23;--mut:#5f6b7a;--line:#e1e5ea;--card:#f6f8fa;--pass:#1a7f37;--warn:#9a6700;--fail:#cf222e;--skip:#6e7781;--acc:#0969da}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#0d1117;--fg:#e6edf3;--mut:#8b949e;--line:#30363d;--card:#161b22;--pass:#3fb950;--warn:#d29922;--fail:#f85149;--skip:#8b949e;--acc:#58a6ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:1200px;margin:0 auto;padding:24px 16px 64px}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:32px 0 10px}
.muted{color:var(--mut)}.mono,code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:10px;margin:16px 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px}.card .n{font-size:26px;font-weight:600}.card .l{color:var(--mut);font-size:12px}
.card.PASS .n{color:var(--pass)}.card.WARN .n{color:var(--warn)}.card.FAIL .n,.card.ERROR .n{color:var(--fail)}
.bar{display:flex;height:10px;border-radius:5px;overflow:hidden;background:var(--line)}.bar i{display:block}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:12px;color:var(--mut);font-weight:600}
.pill{display:inline-block;padding:1px 8px;border-radius:10px;font-size:11px;font-weight:600;color:#fff}.pill.PASS{background:var(--pass)}.pill.WARN{background:var(--warn)}.pill.FAIL,.pill.ERROR{background:var(--fail)}.pill.SKIPPED{background:var(--skip)}
.PASS-t{color:var(--pass)}.WARN-t{color:var(--warn)}.FAIL-t{color:var(--fail)}
details{margin:2px 0}summary{cursor:pointer;color:var(--acc)}details.issue{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 12px;margin:6px 0}details.issue summary{color:var(--fg)}
pre{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:8px;overflow:auto;max-height:320px;white-space:pre-wrap;word-break:break-word}
.checks{margin:6px 0;padding-left:18px}.checks .fail{color:var(--fail)}.checks .warn{color:var(--warn)}.checks .pass{color:var(--pass)}.hint{color:var(--warn);margin:4px 0}
.tools{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0}.tools input,.tools select{padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--fg)}.tools input{flex:1;min-width:200px}
.scroll{overflow-x:auto}.banner{border:1px solid var(--line);border-left:4px solid var(--warn);background:var(--card);padding:8px 12px;border-radius:6px;margin:12px 0}
</style></head><body><main>
<h1>API test report</h1>
<div class="muted">${esc(doc.meta.collection)} · ${esc(doc.meta.hosts.join(', ') || 'no host reached')} · mode <b>${esc(doc.meta.mode)}</b>${doc.meta.dryRun ? ' (dry run)' : ''} · ${esc(doc.meta.startedAt)} · ${(doc.meta.durationMs / 1000).toFixed(1)}s</div>
${doc.meta.mode === 'read-only' ? '<div class="banner">Read-only run: create / update / delete requests were <b>not</b> sent. They appear as skipped.</div>' : ''}
<div class="cards">${card('Requests', c.total, '')}${card('Passed', c.PASS, 'PASS')}${card('Warnings', c.WARN, 'WARN')}${card('Failed', c.FAIL, 'FAIL')}${card('Errors', c.ERROR, 'ERROR')}${card('Skipped', c.SKIPPED, '')}${card('Pass rate*', rate + '%', '')}</div>
<div class="bar" role="img" aria-label="result distribution"><i style="width:${pct(c.PASS)}%;background:var(--pass)"></i><i style="width:${pct(c.WARN)}%;background:var(--warn)"></i><i style="width:${pct(c.FAIL + c.ERROR)}%;background:var(--fail)"></i><i style="width:${pct(c.SKIPPED)}%;background:var(--skip)"></i></div>
<p class="muted">*Pass rate counts only requests that were actually sent (${ran}); warnings count as passing.</p>
<h2>Issues by category</h2>${issueBlocks}
<h2>Skipped requests</h2>${skipBlocks}
<h2>Inputs</h2>${inputs}${doc.authFetch.length ? `<p class="muted">Token requests: ${doc.authFetch.map((a) => `${esc(a.var)} — ${a.ok ? 'ok' : 'failed'} (${esc(a.message)})`).join('; ')}</p>` : ''}
${lint ? `<h2>Collection findings</h2><ul>${lint}</ul>` : ''}
<h2>Results by folder</h2><div class="scroll"><table><thead><tr><th>Folder</th><th>Total</th><th>Pass</th><th>Warn</th><th>Fail/Error</th><th>Skipped</th></tr></thead><tbody>${folderRows}</tbody></table></div>
<h2>All requests</h2>
<div class="tools"><input id="q" type="search" placeholder="Filter by name, method or reason…" aria-label="Filter requests"><select id="st" aria-label="Filter by status"><option value="">All statuses</option>${ORDER.map((o) => `<option>${o}</option>`).join('')}</select></div>
<div class="scroll"><table><thead><tr><th>Result</th><th>ID</th><th>Method</th><th>Request</th><th>Expected</th><th>Got</th><th>Time</th><th></th></tr></thead><tbody id="rows">${rows}</tbody></table></div>
<p class="muted">Bodies shown here are masked: tokens, emails, phone numbers, names, dates of birth and addresses are replaced with ***. Passing requests carry no body.</p>
</main><script>
(function(){var q=document.getElementById('q'),st=document.getElementById('st'),rows=[].slice.call(document.querySelectorAll('#rows tr'));
function f(){var t=q.value.toLowerCase(),s=st.value;rows.forEach(function(r){r.style.display=(!s||r.dataset.status===s)&&(!t||r.dataset.text.indexOf(t)>-1)?'':'none'})}
q.addEventListener('input',f);st.addEventListener('change',f)})();
</script></body></html>`;
}

function renderMarkdown(doc) {
  const c = doc.meta.counts;
  const s = summarise(doc);
  const L = [];
  L.push(`# API test report — ${doc.meta.collection}`, '');
  L.push(`- Host(s): ${doc.meta.hosts.join(', ') || '—'} · mode: **${doc.meta.mode}**${doc.meta.dryRun ? ' (dry run)' : ''}`);
  L.push(`- Run: ${doc.meta.startedAt} (${(doc.meta.durationMs / 1000).toFixed(1)}s)`);
  L.push(`- **${c.total}** requests: ${c.PASS} passed, ${c.WARN} warnings, ${c.FAIL} failed, ${c.ERROR} errors, ${c.SKIPPED} skipped`, '');
  L.push('## Results by folder', '', '| Folder | Total | Pass | Warn | Fail/Error | Skipped |', '|---|---|---|---|---|---|');
  for (const f of s.folders) L.push(`| ${f.name} | ${f.total} | ${f.PASS} | ${f.WARN} | ${f.FAIL + f.ERROR} | ${f.SKIPPED} |`);
  L.push('', '## Issues', '');
  if (!s.issues.length) L.push('None.');
  for (const g of s.issues) {
    L.push(`### ${CAT_LABEL[g.cat] || g.cat} (${g.count})`);
    for (const i of g.items.slice(0, 40)) L.push(`- \`${i.req.id}\` ${i.req.method} ${i.req.path} — ${i.message}${i.hint ? ` _(${i.hint})_` : ''}`);
    L.push('');
  }
  L.push('## Skipped', '');
  for (const g of s.skipped) {
    L.push(`- **${SKIP_LABEL[g.kind] || g.kind}** — ${g.items.length}`);
    for (const [reason, items] of [...groupBy(g.items, (r) => r.skipReason)].sort((a, b) => b[1].length - a[1].length).slice(0, 10)) L.push(`  - ${reason} (${items.length})`);
  }
  if (doc.inputs.missing.length) L.push('', `Inputs still missing: ${doc.inputs.missing.join(', ')}`);
  return L.join('\n') + '\n';
}

function generate(doc, outDir) {
  const dir = path.join(outDir, 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = doc.meta.startedAt.replace(/[:.]/g, '-');
  const html = renderHtml(doc);
  const md = renderMarkdown(doc);
  const files = { html: path.join(dir, `api-report-${stamp}.html`), md: path.join(dir, `api-report-${stamp}.md`) };
  fs.writeFileSync(files.html, html);
  fs.writeFileSync(files.md, md);
  fs.writeFileSync(path.join(dir, 'latest.html'), html);
  fs.writeFileSync(path.join(dir, 'latest.md'), md);
  return files;
}

if (require.main === module) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node report.js <results.json> [--out dir]');
    process.exit(2);
  }
  const i = process.argv.indexOf('--out');
  const out = i > 0 ? process.argv[i + 1] : path.dirname(path.resolve(file));
  const f = generate(JSON.parse(fs.readFileSync(file, 'utf8')), path.resolve(out));
  console.log(f.html);
}

module.exports = { generate, renderHtml, renderMarkdown, summarise };
