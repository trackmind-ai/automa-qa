'use strict';
/**
 * build_report.js - language-check: findings.json -> one self-contained HTML report (+ Markdown copy).
 *
 *   node build_report.js <run-folder>            # reads <run-folder>/findings.json
 *
 * Writes <run-folder>/language_check.html (screenshots embedded as base64) and language_check.md.
 * Dependency-free. Screenshot paths in findings.json are relative to <run-folder>.
 *
 * findings.json:
 * {
 *   "app": "Example App", "platform": "web", "date": "2026-11-10", "url": "https://...",
 *   "screensChecked": ["Home", "Orders"],
 *   "notChecked": ["Validation messages (not triggered: read-only)", "Settings (budget used)"],
 *   "findings": [{
 *     "id": 1, "screen": "Orders", "area": "Page header", "element": "Heading",
 *     "text": "Recieve updates",              // full exact on-screen text
 *     "mistake": "Recieve",                   // the wrong part (what is highlighted)
 *     "correction": "Receive updates",        // full corrected text   <- required for every finding
 *     "category": "spelling|grammar|wording|coherence|leftover text|unverified|needs product decision",
 *     "severity": "High|Medium|Low",
 *     "why": "Misspelling of 'Receive'.",
 *     "screenshot": "evidence/F001.png",      // omit if it could not be captured
 *     "refSize": {"w":1280,"h":720},          // only for overlay mode (mobile)
 *     "bounds": "[90,215][600,235]"           // mobile: Maestro bounds -> drawn as a CSS box. Web shots are already highlighted.
 *   }],
 *   "terminology": [{ "concept": "Sign in", "variants": [{"term":"Sign in","where":"Header","count":3}], "recommended": "Sign in" }],
 *   "consistency": ["Dates appear as 10/11/2026 on Orders and 10 Nov 2026 on Home."]
 * }
 */
const fs = require('fs');
const path = require('path');

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const SEV = { high: 0, medium: 1, low: 2 };
const sevKey = (s) => String(s || '').toLowerCase();
const mime = (p) => (/\.jpe?g$/i.test(p) ? 'image/jpeg' : /\.webp$/i.test(p) ? 'image/webp' : 'image/png');

function pngSize(buf) {
  if (buf.length > 24 && buf.toString('latin1', 1, 4) === 'PNG') return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  return null;
}
function parseBounds(b) {
  const m = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(String(b || ''));
  return m ? { x: +m[1], y: +m[2], w: +m[3] - +m[1], h: +m[4] - +m[2] } : null;
}

/** "wrong" text with the mistake marked, "correct" text as given. */
function markMistake(text, mistake) {
  const t = String(text || '');
  if (!mistake || !t.includes(mistake)) return esc(t);
  const i = t.indexOf(mistake);
  return `${esc(t.slice(0, i))}<mark>${esc(mistake)}</mark>${esc(t.slice(i + mistake.length))}`;
}

function shotHtml(f, dir) {
  if (!f.screenshot) return `<div class="noshot">No screenshot: the text could not be captured${f.shotNote ? ' (' + esc(f.shotNote) + ')' : ''}. Location above is from the page text.</div>`;
  const abs = path.resolve(dir, f.screenshot);
  if (!fs.existsSync(abs)) return `<div class="noshot">Screenshot not found: ${esc(f.screenshot)}</div>`;
  const buf = fs.readFileSync(abs);
  const ref = f.refSize || pngSize(buf);
  const r = f.bounds ? parseBounds(f.bounds) : null;
  let box = '';
  if (r && ref) {
    const pct = (v, t) => Math.max(0, Math.min(100, (v / t) * 100)).toFixed(3) + '%';
    box = `<div class="hl" style="left:${pct(r.x, ref.w)};top:${pct(r.y, ref.h)};width:${pct(r.w, ref.w)};height:${pct(r.h, ref.h)}"><b>${esc(f.id)}</b></div>`;
  }
  return `<figure class="shot"><div class="frame"><img src="data:${mime(abs)};base64,${buf.toString('base64')}" alt="Finding ${esc(f.id)}: ${esc(f.mistake || f.text)}">${box}</div></figure>`;
}

function build(dir) {
  const data = JSON.parse(fs.readFileSync(path.join(dir, 'findings.json'), 'utf8'));
  const findings = (data.findings || []).slice().sort((a, b) =>
    String(a.screen || '').localeCompare(String(b.screen || '')) || (SEV[sevKey(a.severity)] ?? 9) - (SEV[sevKey(b.severity)] ?? 9) || a.id - b.id);

  const missing = findings.filter((f) => !f.correction).map((f) => f.id);
  if (missing.length) console.warn(`WARNING: findings without a correction: ${missing.join(', ')}. Every finding needs one (or "needs product decision" with a proposal).`);

  const count = (key, val) => findings.filter((f) => sevKey(f[key]) === val).length;
  const cats = {};
  findings.forEach((f) => { const c = f.category || 'other'; cats[c] = (cats[c] || 0) + 1; });
  const screens = new Set(findings.map((f) => f.screen));

  /* ---------- HTML ---------- */
  const corrRows = findings.map((f) => `<tr><td><a href="#f${esc(f.id)}">${esc(f.id)}</a></td><td>${esc(f.screen)}${f.area ? ' &rsaquo; ' + esc(f.area) : ''}</td>` +
    `<td class="wrong">${markMistake(f.text, f.mistake)}</td><td class="right">${esc(f.correction || '')}</td><td><span class="sev ${sevKey(f.severity)}">${esc(f.severity)}</span></td></tr>`).join('');

  const cards = findings.map((f) => `
  <section class="card" id="f${esc(f.id)}">
    <div class="head"><span class="num">${esc(f.id)}</span><strong>${esc(f.screen)}${f.area ? ' &rsaquo; ' + esc(f.area) : ''}</strong>
      <span class="sev ${sevKey(f.severity)}">${esc(f.severity)}</span><span class="cat">${esc(f.category)}</span></div>
    ${f.element ? `<div class="el">Element: ${esc(f.element)}</div>` : ''}
    ${shotHtml(f, dir)}
    <div class="pair"><div class="wrongbox"><span>On screen now</span><p>${markMistake(f.text, f.mistake)}</p></div>
      <div class="rightbox"><span>Correct text</span><p>${esc(f.correction || '(none given)')}</p></div></div>
    ${f.why ? `<p class="why"><b>Why:</b> ${esc(f.why)}</p>` : ''}
  </section>`).join('');

  const term = (data.terminology || []).map((t) => `<tr><td>${esc(t.concept)}</td><td>${(t.variants || []).map((v) => `${esc(v.term)} (${esc(v.count)}${v.where ? ', ' + esc(v.where) : ''})`).join('<br>')}</td><td class="right">${esc(t.recommended)}</td></tr>`).join('');
  const cons = (data.consistency || []).map((c) => `<li>${esc(c)}</li>`).join('');
  const nc = (data.notChecked || []).map((c) => `<li>${esc(c)}</li>`).join('');

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Language check - ${esc(data.app || 'app')}</title>
<style>
:root{--bg:#fff;--fg:#1a1a1f;--mut:#5b5b66;--line:#dcdce3;--card:#f7f7fa;--red:#e11d2e;--green:#0f7b3f;--amber:#b86e00}
@media(prefers-color-scheme:dark){:root{--bg:#111114;--fg:#ececf1;--mut:#a0a0ad;--line:#2d2d36;--card:#1a1a20;--green:#4cc38a;--amber:#f0b24a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,Segoe UI,Arial,sans-serif}
main{max-width:1000px;margin:0 auto;padding:24px 16px 64px}h1{margin:0 0 4px}h2{margin:32px 0 10px;border-bottom:1px solid var(--line);padding-bottom:6px}
.meta{color:var(--mut)}table{width:100%;border-collapse:collapse;font-size:14px}th,td{border:1px solid var(--line);padding:7px 9px;text-align:left;vertical-align:top}th{background:var(--card)}
.wrong mark,.wrongbox mark{background:rgba(225,29,46,.2);color:inherit;border-bottom:2px solid var(--red);padding:0 1px}.right{color:var(--green);font-weight:600}
.stats{display:flex;gap:10px;flex-wrap:wrap;margin:14px 0}.stat{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 16px}.stat b{font-size:22px;display:block}
.card{border:1px solid var(--line);border-radius:10px;background:var(--card);padding:14px;margin:16px 0;break-inside:avoid}
.head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.num{background:var(--red);color:#fff;border-radius:12px;min-width:26px;height:26px;line-height:26px;text-align:center;font-weight:700;padding:0 6px}
.sev{border-radius:4px;padding:1px 8px;font-size:12px;font-weight:700;border:1px solid currentColor}.sev.high{color:var(--red)}.sev.medium{color:var(--amber)}.sev.low{color:var(--mut)}
.cat{color:var(--mut);font-size:13px}.el{color:var(--mut);font-size:13px;margin-top:4px}
.shot{margin:12px 0 0}.frame{position:relative;border:1px solid var(--line);border-radius:6px;overflow:hidden;line-height:0}.frame img{width:100%;height:auto;display:block}
.hl{position:absolute;border:3px solid var(--red);background:rgba(225,29,46,.14);border-radius:4px}.hl b{position:absolute;top:-13px;left:-13px;background:var(--red);color:#fff;border-radius:11px;min-width:22px;height:22px;line-height:22px;text-align:center;font:700 13px Arial}
.noshot{margin-top:10px;padding:10px;border:1px dashed var(--line);color:var(--mut);border-radius:6px;font-size:13px}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:12px}@media(max-width:640px){.pair{grid-template-columns:1fr}}
.pair span{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--mut)}.pair p{margin:4px 0 0;font-size:15px}
.wrongbox,.rightbox{border-radius:6px;padding:10px;border:1px solid var(--line)}.wrongbox{border-left:4px solid var(--red)}.rightbox{border-left:4px solid var(--green)}.rightbox p{color:var(--green);font-weight:600}
.why{margin:10px 0 0;color:var(--mut)}a{color:inherit}ul{margin:6px 0 0}
</style></head><body><main>
<h1>Language check: ${esc(data.app || 'application')}</h1>
<div class="meta">${esc(data.platform || '')} &middot; ${esc(data.date || '')}${data.url ? ' &middot; ' + esc(data.url) : ''} &middot; read-only, nothing in the app was changed</div>

<h2>Summary</h2>
<div class="stats">
 <div class="stat"><b>${findings.length}</b>findings</div>
 <div class="stat"><b>${count('severity', 'high')}</b>high</div>
 <div class="stat"><b>${count('severity', 'medium')}</b>medium</div>
 <div class="stat"><b>${count('severity', 'low')}</b>low</div>
 <div class="stat"><b>${(data.screensChecked || []).length || screens.size}</b>screens checked</div>
</div>
<p class="meta">By type: ${Object.entries(cats).map(([k, v]) => `${esc(k)} ${v}`).join(' &middot; ') || 'none'}</p>
${findings.length ? '' : '<p><b>No language issues were found on the screens checked.</b></p>'}

${findings.length ? `<h2>All corrections</h2>
<table><thead><tr><th>#</th><th>Where</th><th>On screen now</th><th>Correct text</th><th>Severity</th></tr></thead><tbody>${corrRows}</tbody></table>
<h2>Findings with screenshots</h2>${cards}` : ''}

${term ? `<h2>Terminology</h2><table><thead><tr><th>Concept</th><th>Variants found</th><th>Use</th></tr></thead><tbody>${term}</tbody></table>` : ''}
${cons ? `<h2>Consistency notes</h2><ul>${cons}</ul>` : ''}
<h2>Screens checked</h2><p>${esc((data.screensChecked || []).join(', ') || '(not recorded)')}</p>
<h2>Not checked</h2>${nc ? `<ul>${nc}</ul>` : '<p>Nothing recorded.</p>'}
</main></body></html>`;

  fs.writeFileSync(path.join(dir, 'language_check.html'), html);

  /* ---------- Markdown copy ---------- */
  const cell = (s) => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const md = [
    `# Language check: ${data.app || 'application'}`,
    `${data.platform || ''} | ${data.date || ''}${data.url ? ' | ' + data.url : ''} | read-only`,
    '',
    `**${findings.length} findings** - high ${count('severity', 'high')}, medium ${count('severity', 'medium')}, low ${count('severity', 'low')}. Screens checked: ${(data.screensChecked || []).length || screens.size}.`,
    '',
    '## All corrections',
    '| # | Where | On screen now | Correct text | Severity | Screenshot |', '|---|---|---|---|---|---|',
    ...findings.map((f) => `| ${f.id} | ${cell(f.screen)}${f.area ? ' > ' + cell(f.area) : ''} | ${cell(f.text)} | ${cell(f.correction)} | ${cell(f.severity)} | ${f.screenshot ? '[' + cell(f.screenshot) + '](' + f.screenshot + ')' : 'none'} |`),
    '',
    ...(data.terminology || []).length ? ['## Terminology', '| Concept | Variants | Use |', '|---|---|---|',
      ...data.terminology.map((t) => `| ${cell(t.concept)} | ${cell((t.variants || []).map((v) => `${v.term} (${v.count})`).join(', '))} | ${cell(t.recommended)} |`), ''] : [],
    ...(data.consistency || []).length ? ['## Consistency notes', ...data.consistency.map((c) => `- ${c}`), ''] : [],
    '## Not checked', ...((data.notChecked || []).length ? data.notChecked.map((c) => `- ${c}`) : ['Nothing recorded.']), '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'language_check.md'), md);
  return { html: path.join(dir, 'language_check.html'), md: path.join(dir, 'language_check.md'), findings: findings.length, withoutCorrection: missing.length };
}

if (require.main === module) {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: node build_report.js <run-folder containing findings.json>'); process.exit(2); }
  console.log(JSON.stringify(build(path.resolve(dir)), null, 2));
}
module.exports = { build };
