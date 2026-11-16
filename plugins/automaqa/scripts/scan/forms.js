// Open forms READ-ONLY. For a control classified 'open-form' (Add / New / Invite / Create / Edit):
//   1. click it (the write guard is on, so a save could never leave the browser anyway)
//   2. const form = await readForm(page)      -> { open, title, fields:[{label,type,required,hint}], buttons:[...] }
//   3. await closeForm(page)                  -> closes with Cancel / close only; never presses Save / Send / Create
// If readForm().open is false nothing opened a dialog (inline edit, or navigation): reload the page to drop any edit state.
// Nothing is ever typed into a field.

const PANE = '.cdk-overlay-pane, mat-dialog-container, [role=dialog], [role=alertdialog], dialog';

async function readForm(page) {
  return page.evaluate(sel => {
    const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const panes = [...document.querySelectorAll(sel)].filter(vis);
    // the topmost pane that is not a persistent assistant/chat widget
    const pane = panes.reverse().find(p => !/how can i help you/i.test(p.innerText || '')) || null;
    if (!pane) return { open: false, title: '', fields: [], buttons: [] };
    const clean = t => String(t || '').replace(/\s+/g, ' ').replace(/\s*\*\s*$/, '').trim();
    const title = clean((pane.querySelector('h1,h2,h3,[mat-dialog-title],.mat-mdc-dialog-title,[class*=title]') || {}).innerText || (pane.innerText || '').split('\n')[0]);
    const fields = []; const seen = new Set();
    pane.querySelectorAll('input,textarea,select,mat-select,[role=combobox],[role=listbox],[role=radiogroup]').forEach(e => {
      if (!vis(e) && e.tagName !== 'INPUT') return;
      const type = e.getAttribute('type') || e.tagName.toLowerCase().replace('mat-', '');
      if (/^(hidden|submit|button)$/.test(type)) return;
      const id = e.id; const lab = id && pane.querySelector(`label[for="${id}"]`);
      const wrap = e.closest('mat-form-field,.mat-mdc-form-field,.form-group,[class*=field]');
      const wl = wrap && wrap.querySelector('label,mat-label,.mat-mdc-floating-label');
      const label = clean(e.getAttribute('aria-label') || (lab && lab.innerText) || (wl && wl.innerText) || e.getAttribute('placeholder') || e.getAttribute('name') || '');
      if (!label || seen.has(label + type)) return; seen.add(label + type);
      const required = e.required || e.getAttribute('aria-required') === 'true' || /\*|required/i.test((wl && wl.innerText) || '') || /required/i.test(e.className || '');
      const hintEl = wrap && wrap.querySelector('mat-hint,.mat-mdc-form-field-hint,mat-error,[class*=hint]');
      const hint = clean([e.getAttribute('placeholder'), hintEl && hintEl.innerText].filter(Boolean).join(' | '));
      fields.push({ label, type, required: !!required, hint });
    });
    const buttons = [...pane.querySelectorAll('button')].filter(vis).map(b => clean(b.getAttribute('aria-label') || b.innerText)).filter(Boolean);
    return { open: true, title, fields, buttons: [...new Set(buttons)] };
  }, PANE);
}

// Close with Cancel / close / Escape ONLY. Returns true when no dialog is left open.
async function closeForm(page) {
  const open = () => page.evaluate(sel => [...document.querySelectorAll(sel)].some(p => { const r = p.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !/how can i help you/i.test(p.innerText || ''); }), PANE);
  for (let i = 0; i < 3; i++) {
    if (!(await open())) return true;
    const pane = page.locator(PANE).last();
    const btn = pane.getByRole('button', { name: /^(cancel|close|dismiss|close dialog)$/i }).first();   // only Cancel / close; a form we never typed in is never dirty
    if (await btn.isVisible().catch(() => false)) await btn.click({ timeout: 2000 }).catch(() => {});
    else await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(400);
  }
  return !(await open());
}

module.exports = { readForm, closeForm, PANE };
