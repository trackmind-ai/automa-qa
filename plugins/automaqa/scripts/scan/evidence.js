// Scan evidence: the text the page really showed, kept in scratch so qa.js can verify every exact-text quote.
//   await dumpEvidence(page, rawDir, 'S03')      // call after each screen / dialog is loaded
//   harvestNames(rawDir) -> names.txt            // deny-list for the personal-data check (names seen in the scan)
// Evidence holds real data: it lives in the scratch raw folder and is deleted by cleanup.js after qa.js has run.
const fs = require('fs');
const path = require('path');

async function dumpEvidence(page, rawDir, id) {
  fs.mkdirSync(rawDir, { recursive: true });
  const d = await page.evaluate(() => {
    const attrs = [...document.querySelectorAll('[aria-label],[title],[placeholder],[alt],[data-tooltip],[mattooltip],[ng-reflect-message]')]
      .flatMap(e => ['aria-label', 'title', 'placeholder', 'alt', 'data-tooltip', 'mattooltip', 'ng-reflect-message'].map(a => e.getAttribute(a))).filter(Boolean);
    const panes = [...document.querySelectorAll('.cdk-overlay-pane,mat-dialog-container,[role=dialog],[role=menu],[role=listbox],.mat-mdc-tooltip')].map(p => p.innerText || '');
    return { text: document.body ? document.body.innerText : '', attrs, panes };
  });
  const aria = await page.locator('body').ariaSnapshot().catch(() => '');
  fs.writeFileSync(path.join(rawDir, `${id}.text.txt`), d.text);
  fs.writeFileSync(path.join(rawDir, `${id}.attrs.txt`), d.attrs.join('\n'));
  fs.writeFileSync(path.join(rawDir, `${id}.aria.txt`), aria);
  if (d.panes.length) fs.appendFileSync(path.join(rawDir, `${id}.panes.txt`), d.panes.join('\n---\n') + '\n');
  return { chars: d.text.length, attrs: d.attrs.length, panes: d.panes.length };
}
// Names that appear after a verb ("Message Jane Roe", "View details for Jane Roe") or as person-link labels.
function harvestNames(rawDir) {
  const names = new Set(); const rx = /(?:Message|View details for|Resend invitation to|Review alerts for|Chat with|Edit client|appointment with|Call)\s+([A-Z][\w.'-]+(?:\s[A-Z][\w.'-]+){0,3})/g;
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (/\.(txt|json|jsonl)$/i.test(e.name)) { const t = fs.readFileSync(f, 'utf8'); let m; while ((m = rx.exec(t))) { names.add(m[1].trim()); m[1].split(/\s+/).filter(x => x.length >= 4).forEach(x => names.add(x)); } } } })(rawDir);
  return [...names];
}
module.exports = { dumpEvidence, harvestNames };
