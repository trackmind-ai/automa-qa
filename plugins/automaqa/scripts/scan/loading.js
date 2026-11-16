// Loading Protocol for automaqa:scan.
//   const r = await waitLoaded(page);   // { ok, waitedMs, changed, reason }
// ok=true only when: no busy indicator, network quiet, and the content signature is identical
// on two looks >= stableMs apart. After maxMs without that -> ok=false ("did not finish loading").
// changed=true if the content changed while no busy indicator was visible (numbers moving).

async function signature(page) {
  return page.evaluate(() => {
    const vis = e => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    const busySel = '[role=progressbar],[aria-busy=true],mat-spinner,mat-progress-spinner,mat-progress-bar,.mat-mdc-progress-spinner,.mat-mdc-progress-bar,[class*=spinner],[class*=skeleton],[class*=loading],[class*=shimmer]';
    let busy = 0;
    document.querySelectorAll(busySel).forEach(e => { if (vis(e)) busy++; });
    document.querySelectorAll('body *').forEach(e => {
      if (e.children.length === 0 && vis(e) && /^\s*loading\b(?:\s+[\w-]+){0,3}[^\w]{0,6}\s*$/i.test(e.textContent || '')) busy++;
    });
    const t = document.body ? document.body.innerText : '';
    return { busy, sig: [t.length, (t.match(/\d/g) || []).length, document.images.length, document.querySelectorAll('canvas,svg').length].join('|') };
  });
}

async function waitLoaded(page, { maxMs = 30000, stableMs = 2000, pollMs = 500 } = {}) {
  const t0 = Date.now();
  await page.waitForLoadState('domcontentloaded', { timeout: maxMs }).catch(() => {});
  let prev = null, stableSince = null, changes = 0;
  while (Date.now() - t0 < maxMs) {
    let cur;
    try { cur = await signature(page); } catch (_) { await page.waitForTimeout(pollMs); continue; } // navigating
    if (cur.busy > 0) { stableSince = null; prev = cur.sig; }
    else {
      if (prev !== null && cur.sig !== prev) { changes++; stableSince = Date.now(); }
      else if (stableSince === null) stableSince = Date.now();
      prev = cur.sig;
      if (Date.now() - stableSince >= stableMs) {
        await page.waitForLoadState('networkidle', { timeout: 1500 }).catch(() => {});
        return { ok: true, waitedMs: Date.now() - t0, changed: changes > 0, reason: '' };
      }
    }
    await page.waitForTimeout(pollMs);
  }
  return { ok: false, waitedMs: Date.now() - t0, changed: changes > 0, reason: 'did not finish loading' };
}

module.exports = { waitLoaded, signature };
