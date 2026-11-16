'use strict';
/**
 * capture.js - language-check: screenshot a text mistake with the mistake highlighted (web).
 *
 *   const { captureFinding } = require('<plugin>/scripts/language/capture.js');
 *   const r = await captureFinding(page, {
 *     id: 3,                       // finding number (shown in the red badge)
 *     mistake: 'Recieve',          // the wrong word/phrase, exactly as on screen (this gets the red box)
 *     context: 'Recieve updates',  // optional: longer exact text that contains it, to pick the right occurrence
 *     outDir: 'specs/_language/web-20261110-1030/evidence',
 *   });
 *   // r = { ok, screenshot, refSize, matches, where }   ok:false -> no screenshot, say so in the report
 *
 * What it does to the page: scrolls the text into view and draws a temporary red box with a number badge
 * (a fixed-position div, pointer-events:none), takes a viewport screenshot, then removes the box. It sends no
 * request and changes no app data. Call it while the text is on screen: for a tooltip, hover first and do not
 * move the mouse; for a dialog, keep it open. Not handled: text inside iframes or closed shadow DOM (ok:false).
 */
const fs = require('fs');
const path = require('path');

async function captureFinding(page, { id, mistake, context, outDir, nth = 0 } = {}) {
  if (!mistake) throw new Error('captureFinding: mistake (the exact wrong text) is required');
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `F${String(id).padStart(3, '0')}.png`);

  const found = await page.evaluate(({ mistake, context, nth, id }) => {
    const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
        const cs = getComputedStyle(e);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
      }
      return true;
    };
    const hits = []; // { rect-getter, where }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const el = node.parentElement;
      if (!el || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(el.tagName) || !visible(el)) continue;
      const t = node.nodeValue;
      const at = t.indexOf(mistake);
      if (at < 0) continue;
      if (context && !norm(el.innerText || t).includes(norm(context))) continue;
      const textNode = node; // the loop variable moves on; keep this node for the range
      hits.push({ el, where: 'text', range: () => { const r = document.createRange(); r.setStart(textNode, at); r.setEnd(textNode, at + mistake.length); return r; } });
    }
    if (!hits.length) { // attributes: placeholder is visible on the input; others are not visible text
      for (const el of document.querySelectorAll('[placeholder],[title],[aria-label],[alt]')) {
        if (!visible(el)) continue;
        for (const a of ['placeholder', 'title', 'aria-label', 'alt']) {
          const v = el.getAttribute(a);
          if (v && v.includes(mistake)) hits.push({ el, where: a, range: null });
        }
      }
    }
    if (!hits.length) return { ok: false, reason: 'text not found on the current screen', matches: 0 };
    const hit = hits[Math.min(nth, hits.length - 1)];
    hit.el.scrollIntoView({ block: 'center', inline: 'nearest' });
    const r = (hit.range ? hit.range() : hit.el).getBoundingClientRect();
    if (!r.width || !r.height) return { ok: false, reason: 'text found but has no size on screen', matches: hits.length };
    const pad = 3;
    const box = document.createElement('div');
    box.id = '__lc_hl';
    box.style.cssText = `position:fixed;z-index:2147483647;pointer-events:none;box-sizing:border-box;` +
      `left:${r.left - pad}px;top:${r.top - pad}px;width:${r.width + pad * 2}px;height:${r.height + pad * 2}px;` +
      `border:3px solid #e11d2e;background:rgba(225,29,46,.14);border-radius:4px;`;
    const badge = document.createElement('div');
    badge.textContent = String(id);
    badge.style.cssText = 'position:absolute;top:-14px;left:-14px;min-width:22px;height:22px;padding:0 5px;' +
      'box-sizing:border-box;border-radius:11px;background:#e11d2e;color:#fff;font:700 13px/22px Arial,sans-serif;text-align:center;';
    box.appendChild(badge);
    document.body.appendChild(box);
    return { ok: true, matches: hits.length, where: hit.where, viewport: { w: window.innerWidth, h: window.innerHeight } };
  }, { mistake, context, nth, id });

  if (!found.ok) return { ok: false, reason: found.reason, matches: found.matches, screenshot: null };
  try {
    await page.screenshot({ path: file });
  } finally {
    await page.evaluate(() => { const b = document.getElementById('__lc_hl'); if (b) b.remove(); }).catch(() => {});
  }
  return { ok: true, screenshot: path.relative(path.dirname(outDir), file).replace(/\\/g, '/'), refSize: found.viewport, matches: found.matches, where: found.where };
}

module.exports = { captureFinding };
