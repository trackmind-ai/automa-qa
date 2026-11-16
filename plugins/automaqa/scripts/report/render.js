'use strict';
/**
 * render.js — manifest -> one self-contained, human-readable HTML test report.
 *
 * Dependency-free (Node built-ins only). Screenshots are embedded as base64 so the report is a
 * single file that can be emailed or attached to a ticket. Highlights are NOT burned into the
 * PNGs: they are CSS overlays positioned in percent over the untouched screenshot, so the
 * original evidence is preserved and the same code serves Playwright (CSS px) and Maestro
 * (device px). See skills/test-report/SKILL.md for the manifest schema.
 *
 * Also copied into the user's project as tests/support/report-render.js by /automaqa:setup so the
 * Playwright reporter can call it without reaching back into the plugin folder.
 */
const fs = require('fs');
const path = require('path');

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const STATUS = {
  passed:  { label: 'PASS',    cls: 'pass' },
  failed:  { label: 'FAIL',    cls: 'fail' },
  flaky:   { label: 'FLAKY',   cls: 'flake' },
  skipped: { label: 'SKIPPED', cls: 'skip' },
};
const norm = (s) => {
  const k = String(s || '').toLowerCase();
  if (k === 'pass' || k === 'passed' || k === 'ok') return 'passed';
  if (k === 'fail' || k === 'failed' || k === 'bug' || k === 'timedout' || k === 'interrupted') return 'failed';
  if (k === 'flaky') return 'flaky';
  return 'skipped';
};
const KIND = { target: 'Element acted on', expected: 'Expected / correct', problem: 'Problem', note: 'Note' };

/* ---------- image helpers ---------- */
function imageSize(buf) {
  try {
    if (buf.length > 24 && buf.toString('latin1', 1, 4) === 'PNG') return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    if (buf[0] === 0xff && buf[1] === 0xd8) { // JPEG: walk to a SOFn marker
      let i = 2;
      while (i < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const m = buf[i + 1];
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
        i += 2 + buf.readUInt16BE(i + 2);
      }
    }
  } catch (_) { /* fall through */ }
  return null;
}
const mime = (p) => (/\.jpe?g$/i.test(p) ? 'image/jpeg' : /\.webp$/i.test(p) ? 'image/webp' : 'image/png');

/** Maestro-style "[x1,y1][x2,y2]" -> {x,y,w,h} */
function parseBounds(b) {
  const m = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(String(b || ''));
  return m ? { x: +m[1], y: +m[2], w: +m[3] - +m[1], h: +m[4] - +m[2] } : null;
}

function loadShot(file, baseDir, embed) {
  if (!file) return null;
  const abs = path.isAbsolute(file) ? file : path.resolve(baseDir || '.', file);
  if (!fs.existsSync(abs)) return { missing: file };
  const buf = fs.readFileSync(abs);
  const size = imageSize(buf);
  const src = embed === false
    ? path.relative(baseDir || '.', abs).replace(/\\/g, '/')
    : `data:${mime(abs)};base64,${buf.toString('base64')}`;
  return { src, size };
}

/* ---------- screenshot + highlight overlay ---------- */
function renderShot(item, baseDir, embed) {
  const shot = loadShot(item.screenshot, baseDir, embed);
  if (!shot) return '';
  if (shot.missing) return `<div class="shot-missing">Screenshot not found: ${esc(shot.missing)}</div>`;
  const ref = item.refSize || shot.size || null;
  const hls = (item.highlights || []).map((h) => {
    const r = h.bounds ? parseBounds(h.bounds) : { x: h.x, y: h.y, w: h.w, h: h.h };
    return r && [r.x, r.y, r.w, r.h].every(Number.isFinite) ? { ...h, ...r } : null;
  }).filter(Boolean);
  const boxes = ref ? hls.map((h, i) => {
    const kind = KIND[h.kind] ? h.kind : 'target';
    const pct = (v, t) => Math.max(0, Math.min(100, (v / t) * 100)).toFixed(3) + '%';
    return `<div class="hl hl-${kind}" style="left:${pct(h.x, ref.w)};top:${pct(h.y, ref.h)};width:${pct(h.w, ref.w)};height:${pct(h.h, ref.h)}"><b>${i + 1}</b></div>`;
  }).join('') : '';
  const legend = hls.length ? `<ol class="legend">${hls.map((h, i) => {
    const kind = KIND[h.kind] ? h.kind : 'target';
    return `<li><span class="dot dot-${kind}">${i + 1}</span> <strong>${esc(h.label || KIND[kind])}</strong> <span class="kind">${esc(KIND[kind])}</span></li>`;
  }).join('')}</ol>` : '';
  return `<figure class="shot"><div class="frame zoom" title="Click to enlarge"><img src="${shot.src}" alt="${esc(item.action || 'screenshot')}" loading="lazy">${boxes}</div>${legend}</figure>`;
}

/* ---------- sections ---------- */
function ms(n) { return n == null ? '' : n >= 1000 ? (n / 1000).toFixed(1) + 's' : Math.round(n) + 'ms'; }

function renderSteps(c, baseDir, embed) {
  if (!c.steps || !c.steps.length) return '';
  return `<h4>What the test did, step by step</h4><ol class="steps">${c.steps.map((s) => {
    const st = STATUS[norm(s.status || 'passed')];
    return `<li class="step step-${st.cls}">
      <div class="step-head"><span class="badge ${st.cls}">${st.label}</span> <strong>${esc(s.action)}</strong></div>
      ${s.expected ? `<div class="kv"><span>Expected</span><p>${esc(s.expected)}</p></div>` : ''}
      ${s.actual ? `<div class="kv"><span>Actual</span><p>${esc(s.actual)}</p></div>` : ''}
      ${s.note ? `<div class="note">${esc(s.note)}</div>` : ''}
      ${renderShot(s, baseDir, embed)}
    </li>`;
  }).join('')}</ol>`;
}

function renderCase(c, baseDir, embed) {
  const status = norm(c.status);
  const st = STATUS[status];
  const open = status === 'failed' || status === 'flaky' ? ' open' : '';
  const plat = c.platform ? `<span class="chip">${esc(c.platform)}</span>` : '';
  const src = c.source === 'live' ? '<span class="chip">live verification</span>' : '';
  return `<details class="case case-${st.cls}" data-status="${status}" id="case-${esc(c.id)}"${open}>
  <summary><span class="badge ${st.cls}">${st.label}</span>
    <span class="cid">${esc(c.id)}</span> <span class="ctitle">${esc(c.title)}</span>
    ${plat}${src}<span class="dur">${ms(c.durationMs)}${c.retries ? ` · ${c.retries} retry` : ''}</span></summary>
  <div class="case-body">
    ${c.purpose ? `<div class="kv"><span>What this checks</span><p>${esc(c.purpose)}</p></div>` : ''}
    ${c.specRef ? `<div class="kv"><span>Spec reference</span><p>${esc(c.specRef)}</p></div>` : ''}
    ${c.expected ? `<div class="kv"><span>Expected result</span><p>${esc(c.expected)}</p></div>` : ''}
    ${renderSteps(c, baseDir, embed)}
    ${!c.steps || !c.steps.length ? renderShot({ screenshot: c.finalScreenshot, action: 'Final state', refSize: c.refSize, highlights: c.highlights }, baseDir, embed) : ''}
    ${c.verdict || c.actual ? `<div class="verdict verdict-${st.cls}"><span>${status === 'passed' ? 'Why it passed' : status === 'skipped' ? 'Why it was skipped' : 'What went wrong'}</span><p>${esc(c.verdict || c.actual)}</p></div>` : ''}
    ${c.error ? `<details class="err"><summary>Raw error</summary><pre>${esc(String(c.error).slice(0, 4000))}</pre></details>` : ''}
    ${c.trace ? `<div class="kv"><span>Trace</span><p><code>${esc(c.trace)}</code> — open with <code>npx playwright show-trace</code></p></div>` : ''}
  </div>
</details>`;
}

function renderBugs(bugs, baseDir, embed) {
  if (!bugs || !bugs.length) return '';
  const order = { critical: 0, major: 1, minor: 2 };
  const sorted = [...bugs].sort((a, b) => (order[String(a.severity).toLowerCase()] ?? 3) - (order[String(b.severity).toLowerCase()] ?? 3));
  return `<section class="bugs"><h2>Bugs found (${bugs.length})</h2>${sorted.map((b, i) => `
  <article class="bug sev-${esc(String(b.severity || 'minor').toLowerCase())}">
    <header><span class="sev">${esc(b.severity || 'Minor')}</span> <strong>${esc(b.id || 'BUG-' + (i + 1))} — ${esc(b.title)}</strong>
      ${b.caseId ? `<a class="chip" href="#case-${esc(b.caseId)}">${esc(b.caseId)}</a>` : ''}</header>
    ${b.expected ? `<div class="kv"><span>Expected</span><p>${esc(b.expected)}</p></div>` : ''}
    ${b.actual ? `<div class="kv"><span>Actual</span><p>${esc(b.actual)}</p></div>` : ''}
    ${b.impact ? `<div class="kv"><span>Why it matters</span><p>${esc(b.impact)}</p></div>` : ''}
    ${b.repro && b.repro.length ? `<div class="kv"><span>Steps to reproduce</span><ol>${b.repro.map((r) => `<li>${esc(r)}</li>`).join('')}</ol></div>` : ''}
    ${renderShot(b, baseDir, embed)}
  </article>`).join('')}</section>`;
}

function renderHealth(h) {
  if (!h || !(h.sections || []).some((s) => (s.items || []).length)) return '';
  return `<section class="health"><h2>Test health</h2>${h.line ? `<p class="hint">${esc(h.line)}</p>` : ''}
  ${h.sections.filter((s) => (s.items || []).length).map((s) => `<h3 class="${esc(s.kind || '')}">${esc(s.title)}</h3><ul>${s.items.slice(0, 25).map((i) => `<li><code>${esc(i.id)}</code>${i.reason ? `<br><span class="why">${esc(i.reason)}</span>` : ''}</li>`).join('')}</ul>`).join('')}</section>`;
}

function autoSummary(m, t) {
  const bits = [`This run executed ${t.total} test case${t.total === 1 ? '' : 's'}: ${t.passed} passed, ${t.failed} failed${t.flaky ? `, ${t.flaky} flaky` : ''}${t.skipped ? `, ${t.skipped} skipped` : ''}.`];
  const failed = (m.cases || []).filter((c) => norm(c.status) === 'failed');
  if (failed.length) bits.push('Failing: ' + failed.slice(0, 8).map((c) => `${c.id} (${c.title})`).join('; ') + (failed.length > 8 ? `; and ${failed.length - 8} more` : '') + '.');
  return bits.join(' ');
}

const CSS = `
:root{--bg:#f6f7f9;--fg:#14171f;--mut:#5b6472;--card:#fff;--line:#e2e6ec;--pass:#15803d;--passbg:#dcfce7;--fail:#b91c1c;--failbg:#fee2e2;--flake:#92400e;--flakebg:#fef3c7;--skip:#475569;--skipbg:#e2e8f0;--acc:#2563eb}
@media (prefers-color-scheme:dark){:root{--bg:#0f1218;--fg:#e8ebf0;--mut:#98a2b3;--card:#171b23;--line:#2a303b;--passbg:#0f3320;--failbg:#3b1416;--flakebg:#3a2a0b;--skipbg:#262c36;--pass:#4ade80;--fail:#f87171;--flake:#fbbf24;--skip:#aab4c2;--acc:#60a5fa}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1040px;margin:0 auto;padding:28px 16px 64px}
h1{font-size:1.55rem;margin:0 0 4px}h2{font-size:1.15rem;margin:34px 0 12px}h3{font-size:.8rem;text-transform:uppercase;letter-spacing:.04em;color:var(--mut);margin:18px 0 6px}h4{font-size:.85rem;text-transform:uppercase;letter-spacing:.04em;color:var(--mut);margin:18px 0 8px}
.meta{color:var(--mut);font-size:.85rem}.meta span+span::before{content:" · ";}
.banner{margin:18px 0;padding:12px 16px;border-radius:10px;font-weight:600}.banner.pass{background:var(--passbg);color:var(--pass)}.banner.fail{background:var(--failbg);color:var(--fail)}.banner.flake{background:var(--flakebg);color:var(--flake)}
.cards{display:flex;gap:10px;flex-wrap:wrap}.card{flex:1 1 110px;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px;text-align:center}.card b{display:block;font-size:1.7rem}.card i{font-style:normal;font-size:.72rem;color:var(--mut);text-transform:uppercase}
.card.pass b{color:var(--pass)}.card.fail b{color:var(--fail)}.card.flake b{color:var(--flake)}.card.skip b{color:var(--skip)}
.summary{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 18px;white-space:pre-line}
.badge{display:inline-block;min-width:58px;text-align:center;padding:1px 8px;border-radius:5px;font-size:.7rem;font-weight:700;letter-spacing:.03em}
.badge.pass{background:var(--passbg);color:var(--pass)}.badge.fail{background:var(--failbg);color:var(--fail)}.badge.flake{background:var(--flakebg);color:var(--flake)}.badge.skip{background:var(--skipbg);color:var(--skip)}
.chip{display:inline-block;margin-left:6px;padding:0 7px;border:1px solid var(--line);border-radius:99px;font-size:.7rem;color:var(--mut);text-decoration:none}
.filters{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0 12px}.filters button{border:1px solid var(--line);background:var(--card);color:var(--fg);padding:4px 12px;border-radius:99px;font:inherit;font-size:.8rem;cursor:pointer}.filters button[aria-pressed=true]{background:var(--acc);border-color:var(--acc);color:#fff}
details.case{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--line);border-radius:10px;margin:8px 0}
details.case-fail{border-left-color:var(--fail)}details.case-pass{border-left-color:var(--pass)}details.case-flake{border-left-color:var(--flake)}
details.case>summary{cursor:pointer;padding:10px 14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;list-style-position:inside}
.cid{font-family:ui-monospace,Consolas,monospace;font-size:.8rem;color:var(--mut)}.ctitle{font-weight:600;flex:1 1 240px}.dur{margin-left:auto;color:var(--mut);font-size:.78rem}
.case-body{padding:2px 18px 18px;border-top:1px solid var(--line)}
.kv{margin:10px 0}.kv>span{display:block;font-size:.72rem;text-transform:uppercase;letter-spacing:.04em;color:var(--mut)}.kv p{margin:2px 0}.kv ol{margin:2px 0;padding-left:20px}
.steps{list-style:none;counter-reset:s;margin:0;padding:0}.step{counter-increment:s;position:relative;margin:10px 0;padding:10px 12px 12px 44px;border:1px solid var(--line);border-radius:8px}
.step::before{content:counter(s);position:absolute;left:12px;top:10px;width:22px;height:22px;border-radius:50%;background:var(--line);color:var(--fg);font-size:.75rem;font-weight:700;display:grid;place-items:center}
.step-fail{border-color:var(--fail)}.step-fail::before{background:var(--fail);color:#fff}.step-pass::before{background:var(--pass);color:#fff}
.note{font-size:.85rem;color:var(--mut);margin-top:4px}
.verdict{margin-top:14px;padding:10px 14px;border-radius:8px}.verdict>span{font-size:.72rem;text-transform:uppercase;letter-spacing:.04em;font-weight:700}.verdict p{margin:2px 0}
.verdict-fail{background:var(--failbg)}.verdict-pass{background:var(--passbg)}.verdict-flake{background:var(--flakebg)}.verdict-skip{background:var(--skipbg)}
details.err{margin-top:10px}details.err pre{background:var(--bg);border:1px solid var(--line);padding:10px;border-radius:6px;overflow:auto;font-size:.78rem;white-space:pre-wrap;word-break:break-word}
figure.shot{margin:10px 0 0}.frame{position:relative;display:inline-block;max-width:100%;border:1px solid var(--line);border-radius:6px;overflow:hidden;line-height:0;cursor:zoom-in}.frame img{max-width:100%;max-height:520px;width:auto;height:auto}
.hl{position:absolute;border:3px solid;border-radius:4px;box-shadow:0 0 0 2px rgba(255,255,255,.75);pointer-events:none}
.hl b{position:absolute;left:-3px;top:-22px;min-width:20px;height:20px;padding:0 4px;border-radius:4px 4px 4px 0;color:#fff;font:700 12px/20px system-ui;text-align:center}
.hl-target{border-color:#2563eb}.hl-target b{background:#2563eb}.hl-expected{border-color:#16a34a}.hl-expected b{background:#16a34a}.hl-problem{border-color:#dc2626;background:rgba(220,38,38,.12)}.hl-problem b{background:#dc2626}.hl-note{border-color:#d97706}.hl-note b{background:#d97706}
.legend{list-style:none;margin:8px 0 0;padding:0;font-size:.82rem}.legend li{margin:2px 0}.dot{display:inline-grid;place-items:center;width:18px;height:18px;border-radius:4px;color:#fff;font-size:.7rem;font-weight:700}
.dot-target{background:#2563eb}.dot-expected{background:#16a34a}.dot-problem{background:#dc2626}.dot-note{background:#d97706}.kind{color:var(--mut);font-size:.72rem;margin-left:6px}
.shot-missing{margin-top:8px;padding:8px 12px;border:1px dashed var(--line);border-radius:6px;color:var(--mut);font-size:.82rem}
.bug{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--fail);border-radius:10px;padding:12px 16px;margin:10px 0}.bug header{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.sev{padding:1px 8px;border-radius:5px;background:var(--failbg);color:var(--fail);font-size:.7rem;font-weight:700;text-transform:uppercase}
.sev-critical{border-left-color:#7f1d1d}.sev-minor{border-left-color:var(--flake)}
.health ul{margin:0;padding-left:20px;font-size:.88rem}.health .why,.hint{color:var(--mut)}
.legendbox{font-size:.84rem;color:var(--mut)}.legendbox .dot{margin-right:4px}.legendbox span{margin-right:14px;white-space:nowrap}
table.env{border-collapse:collapse;font-size:.85rem}table.env td{padding:3px 14px 3px 0;vertical-align:top}table.env td:first-child{color:var(--mut)}
#lb{position:fixed;inset:0;background:rgba(0,0,0,.82);display:none;place-items:center;z-index:9;cursor:zoom-out;padding:16px}#lb.on{display:grid}#lb .frame{max-height:96vh;cursor:zoom-out}#lb img{max-height:94vh;max-width:96vw}
@media print{body{background:#fff}.filters,#lb{display:none}details.case{break-inside:avoid}details.case:not([open])>.case-body{display:block}.frame img{max-height:360px}}
`;

const JS = `
(function(){
  var cases=[].slice.call(document.querySelectorAll('details.case'));
  document.querySelectorAll('.filters button').forEach(function(b){b.addEventListener('click',function(){
    document.querySelectorAll('.filters button').forEach(function(x){x.setAttribute('aria-pressed','false')});b.setAttribute('aria-pressed','true');
    var f=b.getAttribute('data-f');cases.forEach(function(c){c.style.display=(f==='all'||c.getAttribute('data-status')===f)?'':'none'});});});
  var lb=document.getElementById('lb');
  document.addEventListener('click',function(e){var z=e.target.closest&&e.target.closest('.zoom');
    if(z&&!lb.contains(z)){lb.innerHTML='';var c=z.cloneNode(true);c.classList.remove('zoom');lb.appendChild(c);lb.classList.add('on');}
    else if(lb.classList.contains('on')){lb.classList.remove('on');}});
  document.addEventListener('keydown',function(e){if(e.key==='Escape')lb.classList.remove('on');});
  window.addEventListener('beforeprint',function(){cases.forEach(function(c){c.open=true})});
})();`;

/**
 * @param {object} m manifest
 * @param {{baseDir?:string, embed?:boolean}} [opts] baseDir resolves relative screenshot paths
 * @returns {string} HTML
 */
function render(m, opts = {}) {
  const baseDir = opts.baseDir || '.';
  const embed = opts.embed !== false;
  const cases = m.cases || [];
  const count = (k) => cases.filter((c) => norm(c.status) === k).length;
  const t = { total: cases.length, passed: count('passed'), failed: count('failed'), flaky: count('flaky'), skipped: count('skipped') };
  const dur = m.durationMs != null ? m.durationMs : cases.reduce((a, c) => a + (c.durationMs || 0), 0);
  const ran = t.total - t.skipped;
  const rate = ran ? Math.round(((t.passed + t.flaky) / ran) * 100) : 0;
  const bugs = m.bugs || [];
  const banner = t.failed ? `<div class="banner fail">⛔ ${t.failed} of ${t.total} test cases failed${bugs.length ? ` — ${bugs.length} bug${bugs.length === 1 ? '' : 's'} logged below` : ''}.</div>`
    : t.flaky ? `<div class="banner flake">⚠ All tests passed, but ${t.flaky} only after a retry — flaky, not green. See Test health.</div>`
    : `<div class="banner pass">✅ All ${t.total} test cases passed.</div>`;
  const env = Object.entries(m.environment || {}).filter(([, v]) => v);
  const platforms = [...new Set(cases.map((c) => c.platform).filter(Boolean))];
  const title = m.title || `${m.feature || 'Test'} — test report${m.run ? ' ' + m.run : ''}`;

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${CSS}</style></head><body><main>
<h1>${esc(title)}</h1>
<div class="meta"><span>Generated ${esc(new Date(m.generatedAt || Date.now()).toLocaleString())}</span><span>Duration ${ms(dur) || '—'}</span>${platforms.length ? `<span>Platforms: ${esc(platforms.join(' + '))}</span>` : ''}${m.spec ? `<span>Spec: <code>${esc(m.spec)}</code></span>` : ''}</div>
${banner}
<div class="cards">
  <div class="card"><b>${t.total}</b><i>Total</i></div><div class="card pass"><b>${t.passed}</b><i>Passed</i></div>
  <div class="card fail"><b>${t.failed}</b><i>Failed</i></div><div class="card flake"><b>${t.flaky}</b><i>Flaky</i></div>
  <div class="card skip"><b>${t.skipped}</b><i>Skipped</i></div><div class="card"><b>${rate}%</b><i>Pass rate</i></div>
</div>
<h2>Summary</h2><div class="summary">${esc(m.summary || autoSummary(m, t))}</div>
${renderBugs(bugs, baseDir, embed)}
<h2>Test cases</h2>
<div class="filters">${[['all', 'All'], ['failed', 'Failed'], ['flaky', 'Flaky'], ['passed', 'Passed'], ['skipped', 'Skipped']].map(([k, l], i) => `<button data-f="${k}" aria-pressed="${i === 0}">${l}</button>`).join('')}</div>
${cases.map((c) => renderCase(c, baseDir, embed)).join('\n')}
${renderHealth(m.health)}
<h2>How to read the screenshots</h2>
<div class="legendbox"><span><i class="dot dot-target">1</i>Element the test acted on</span><span><i class="dot dot-expected">2</i>Expected / correct result</span><span><i class="dot dot-problem">3</i>Where it went wrong</span><span><i class="dot dot-note">4</i>Note</span></div>
<p class="meta">Click any screenshot to enlarge. Highlights are drawn over the original, unmodified screenshot.</p>
${env.length ? `<h2>Environment</h2><table class="env">${env.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>` : ''}
</main><div id="lb"></div><script>${JS}</script></body></html>`;
}

/* ---------- run bookkeeping + manifest merge (shared by the Playwright reporter and build_report.js) ---------- */
function runNumbers(specDir) {
  const nums = [];
  const take = (name, re) => { const m = re.exec(name); if (m) nums.push(+m[1]); };
  try { fs.readdirSync(specDir).forEach((f) => take(f, /^report-v(\d+)\.html$/)); } catch (_) { /* no dir yet */ }
  try { fs.readdirSync(path.join(specDir, 'evidence')).forEach((f) => take(f, /^v(\d+)$/)); } catch (_) { /* none */ }
  return nums;
}
/** Next run label, e.g. "v3": one past the highest report-v*.html or evidence/v* that exists. */
const nextRun = (specDir) => 'v' + (Math.max(0, ...runNumbers(specDir)) + 1);
/** Highest existing run label, or null. */
const latestRun = (specDir) => { const n = runNumbers(specDir); return n.length ? 'v' + Math.max(...n) : null; };

function absolutise(m, dir) {
  const abs = (p) => (p && !path.isAbsolute(p) ? path.resolve(dir, p) : p);
  (m.cases || []).forEach((c) => {
    c.screenshot = abs(c.screenshot);
    c.finalScreenshot = abs(c.finalScreenshot);
    (c.steps || []).forEach((s) => { s.screenshot = abs(s.screenshot); });
  });
  (m.bugs || []).forEach((b) => { b.screenshot = abs(b.screenshot); });
  return m;
}

/** Load every *.manifest.json in dirs and merge into one manifest. Later files win for scalar fields. */
function mergeManifests(dirs) {
  const out = { schema: 1, cases: [], bugs: [], environment: {}, health: null };
  const sections = [];
  for (const dir of dirs) {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.manifest.json')).sort(); } catch (_) { continue; }
    for (const f of files) {
      const m = absolutise(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')), dir);
      for (const k of ['title', 'feature', 'run', 'spec', 'summary', 'generatedAt']) if (m[k]) out[k] = m[k];
      Object.assign(out.environment, m.environment || {});
      out.cases.push(...(m.cases || []));
      out.bugs.push(...(m.bugs || []));
      out.durationMs = (out.durationMs || 0) + (m.durationMs || 0);
      if (m.health) { out.health = out.health || { line: m.health.line, sections: [] }; sections.push(...(m.health.sections || [])); }
    }
  }
  if (out.health) out.health.sections = sections;
  return out;
}

module.exports = { render, norm, parseBounds, imageSize, nextRun, latestRun, mergeManifests };
