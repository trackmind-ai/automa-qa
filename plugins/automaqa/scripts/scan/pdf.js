#!/usr/bin/env node
// Render a self-contained HTML file to an A4 PDF with Playwright.
//   node pdf.js <in.html> <out.pdf>
// Verifies the result: file exists, starts with %PDF, page count > 0. Prints JSON.
const fs = require('fs');
const path = require('path');
const { pw } = require('./pw');

async function htmlToPdf(inHtml, outPdf) {
  const { chromium } = pw();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto('file:///' + path.resolve(inHtml).replace(/\\/g, '/'), { waitUntil: 'load' });
    await page.emulateMedia({ media: 'print' });
    await page.pdf({
      path: outPdf, format: 'A4', printBackground: true, margin: { top: '16mm', bottom: '18mm', left: '14mm', right: '14mm' },
      displayHeaderFooter: true, headerTemplate: '<span></span>',
      footerTemplate: '<div style="font-size:8px;width:100%;text-align:center;color:#666"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
    });
  } finally { await browser.close(); }
  const buf = fs.readFileSync(outPdf);
  const pages = (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
  return { ok: buf.slice(0, 4).toString() === '%PDF' && pages > 0, bytes: buf.length, pages };
}

if (require.main === module) {
  const [i, o] = process.argv.slice(2);
  if (!i || !o) { console.error('usage: node pdf.js <in.html> <out.pdf>'); process.exit(1); }
  htmlToPdf(i, o).then(r => { console.log(JSON.stringify(r)); process.exit(r.ok ? 0 : 3); }).catch(e => { console.error(e.message); process.exit(1); });
}
module.exports = { htmlToPdf };
