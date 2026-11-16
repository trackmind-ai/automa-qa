#!/usr/bin/env node
'use strict';
/**
 * build_report.js — merge evidence manifests for a feature and render the final report.
 *
 *   node build_report.js <specDir> [--run vN|latest|<name>] [--out file] [--no-live]
 *                        [--no-embed] [--pdf]
 *   node build_report.js <specDir> --init-run
 *
 *   <specDir>   specs/<feature-slug>
 *   --run       evidence run to render. latest (default) | vN | any folder name under
 *               <specDir>/evidence (e.g. "live")
 *   --init-run  create the next evidence/vN folder, print {run, dir} and exit (use before writing
 *               a Maestro or live manifest when no automated Playwright run exists yet)
 *   --out       output file. Default: <specDir>/report-<run>.html
 *   --no-live   do not fold evidence/live/*.manifest.json into the report
 *   --no-embed  link screenshots by relative path instead of embedding base64 (smaller HTML)
 *   --pdf       also write a PDF next to the HTML (needs Playwright in the cwd project)
 *
 * Prints one JSON line: { report, pdf, run, totals }. Exit 2 when there is nothing to render.
 */
const fs = require('fs');
const path = require('path');
const { render, norm, nextRun, latestRun, mergeManifests } = require('./render');

function parse(argv) {
  const a = { init: false, dir: null, run: 'latest', out: null, live: true, embed: true, pdf: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--run') a.run = argv[++i];
    else if (v === '--out') a.out = argv[++i];
    else if (v === '--no-live') a.live = false;
    else if (v === '--no-embed') a.embed = false;
    else if (v === '--pdf') a.pdf = true;
    else if (v === '--init-run') a.init = true;
    else if (!a.dir) a.dir = v;
  }
  return a;
}

async function toPdf(htmlFile, pdfFile) {
  let chromium;
  for (const base of [process.cwd(), __dirname]) {
    for (const name of ['playwright', '@playwright/test']) {
      try { chromium = require(require.resolve(name, { paths: [base] })).chromium; } catch (_) { /* next */ }
      if (chromium) break;
    }
    if (chromium) break;
  }
  if (!chromium) throw new Error('Playwright not found in this project (needed for --pdf). Run /automaqa:setup web first.');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto('file:///' + path.resolve(htmlFile).replace(/\\/g, '/'), { waitUntil: 'load' });
    await page.emulateMedia({ media: 'print' });
    await page.pdf({ path: pdfFile, format: 'A4', printBackground: true, margin: { top: '14mm', bottom: '16mm', left: '12mm', right: '12mm' } });
  } finally { await browser.close(); }
}

(async () => {
  const a = parse(process.argv.slice(2));
  if (!a.dir) { console.error('usage: node build_report.js <specDir> [--run vN|latest] [--init-run] [--out f] [--no-live] [--no-embed] [--pdf]'); process.exit(1); }
  const specDir = path.resolve(a.dir);
  if (a.init) {
    const r = nextRun(specDir);
    const d = path.join(specDir, 'evidence', r);
    fs.mkdirSync(d, { recursive: true });
    console.log(JSON.stringify({ run: r, dir: d }));
    return;
  }
  const run = a.run === 'latest' ? latestRun(specDir) : a.run;
  if (!run) { console.error(`No evidence found under ${path.join(specDir, 'evidence')}.`); process.exit(2); }

  const dirs = [path.join(specDir, 'evidence', run)];
  if (a.live && run !== 'live') dirs.unshift(path.join(specDir, 'evidence', 'live'));
  const manifest = mergeManifests(dirs);
  if (!manifest.cases.length && !manifest.bugs.length) { console.error(`No test cases in ${dirs.join(' or ')}.`); process.exit(2); }
  if (!manifest.run && /^v\d+$/.test(run)) manifest.run = run;

  const out = path.resolve(a.out || path.join(specDir, `report-${run}.html`));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, render(manifest, { baseDir: path.dirname(out), embed: a.embed }), 'utf8');

  let pdf = null;
  if (a.pdf) { pdf = out.replace(/\.html$/, '.pdf'); await toPdf(out, pdf); }
  const count = (k) => manifest.cases.filter((c) => norm(c.status) === k).length;
  console.log(JSON.stringify({
    report: out, pdf, run,
    totals: { total: manifest.cases.length, passed: count('passed'), failed: count('failed'), flaky: count('flaky'), skipped: count('skipped'), bugs: manifest.bugs.length },
  }));
})().catch((e) => { console.error(e.message); process.exit(1); });
