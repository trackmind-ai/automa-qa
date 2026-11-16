// Control classifier for automaqa:scan — DENY BY DEFAULT.
//   const cands = await listCandidates(page);            // marks each control with data-aq-c
//   verdict: 'safe'      click it
//            'open-form' click it ONLY to open a form/dialog: read its fields (forms.js readForm), then close with Cancel.
//                        The write guard stops any save. If no dialog appears, reload the page (it may have been inline edit).
//            'review'    show to the user first (one batch per screen)
//            'unsafe'    never click; list in the safe-to-test register as N
//
// Matching is on WHOLE WORDS: "Invited Clients" is not "Invite"; "Postpartum" is not "Post".

// Hard-forbidden: acts on data or on a person. Never clicked, even to "just look".
const HARD_WORDS = [
  'save', 'submit', 'send', 're-?send', 'publish', 'delete', 'remove', 'upload', 'download', 'export', 'import',
  'buy', 'purchase', 'pay', 'checkout', 'book', 'post', 'reply', 'start', 'join', 'remind', 'notify', 'nudge',
  'approve', 'reject', 'decline', 'resolve', 'complete', 'done', 'archive', 'deactivate', 'activate', 'reset', 'revoke',
  'assign', 'unassign', 'discard', 'confirm', 'update', 'mark', 'clear', 'log ?out', 'sign ?out', 'sign ?in', 'log ?in',
  'subscribe', 'unsubscribe', 'accept', 'agree', 'grant', 'allow', 'record', 'stop', 'cancel appointment', 'check circle',
  'task alt', 'person add', 'share', 'copy link', 'merge', 'transfer', 'generate',
];
// Openers: normally just open a form/dialog. Allowed to OPEN read-only (verdict 'open-form'), never to submit.
const OPENER_WORDS = ['add', 'new', 'invite', 'create', 'edit'];
const word = list => new RegExp(`\\b(?:${list.join('|')})\\b`, 'i');
const HARD = word(HARD_WORDS);
const OPENER = word(OPENER_WORDS);
const FORBIDDEN = HARD; // kept for older callers

// Ambiguous: never auto-clicked, shown to the user. ("apply filter" is usually a view filter; "Apply changes" is not.)
const REVIEW_WORDS = /\b(?:apply|applies|applied|applying)\b/i;
const SAFE_LABEL = /^(?:(?:next|previous|prev|back|first|last)\b.*|page \d+|\d+\s*(?:days?|weeks?|months?)|day|week|month|year|today|all|filter\b.*|sort\b.*|search\b.*|expand\b.*|collapse\b.*|show (?:more|less)|read (?:more|less)|view (?:all|more|details?)|details?|about\b.*|help|info|more info|(?:open|close) (?:menu|filter|panel|sidebar|filters)|tab\b.*|(?:my|all|active|invited|archived|inactive|pending) (?:clients|users|alerts|tasks|appointments|notes))$/i;
const IN_PANEL_SAFE = /^(?:expand\b.*|collapse\b.*|show (?:more|less)|read (?:more|less)|view (?:all|more|details?)|(?:\+|-)\s*\d*\s*(?:more)?.*)$/i;
const CLOSERS = /^(cancel|close|dismiss|x|✕|close dialog|close panel)$/i;
const norm = s => String(s || '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();

function classifyControl(c) {
  const label = norm(c.label);
  if (!label) return { verdict: 'review', reason: 'no-label' };
  if (/^(checkbox|radio|switch)$/i.test(c.role) || /^(checkbox|radio)$/i.test(c.type || '')) return { verdict: 'unsafe', reason: 'state-control' };
  if (HARD.test(label)) return { verdict: 'unsafe', reason: 'forbidden-word:' + (label.match(HARD) || [''])[0].toLowerCase() };
  if (c.href && /(^|\/)(log-?out|sign-?out)(\/|$)/i.test(c.href)) return { verdict: 'unsafe', reason: 'logout-link' };
  if (REVIEW_WORDS.test(label)) return { verdict: 'review', reason: 'review-word:apply' };
  // Tabs, expanders and menus are read-only everywhere — including inside a side panel or dialog.
  if (c.role === 'tab') return { verdict: 'safe', reason: 'role=tab' };
  if (c.inTablist) return { verdict: 'safe', reason: 'tab-group' };
  if (c.expanded !== null && c.expanded !== undefined && c.expanded !== '') return { verdict: 'safe', reason: 'aria-expanded' };
  if (c.popup) return { verdict: 'safe', reason: 'aria-haspopup' };
  if (c.inOverlay) {
    if (CLOSERS.test(label)) return { verdict: 'review', reason: 'closer-inside-dialog' };
    if (OPENER.test(label)) return { verdict: 'unsafe', reason: 'form-inside-dialog' };
    if (IN_PANEL_SAFE.test(label)) return { verdict: 'safe', reason: 'panel-expander' };
    return { verdict: 'review', reason: 'inside-dialog' };
  }
  if (OPENER.test(label)) return { verdict: 'open-form', reason: 'opener:' + (label.match(OPENER) || [''])[0].toLowerCase() };
  if (SAFE_LABEL.test(label)) return { verdict: 'safe', reason: 'label-allow' };
  if (c.tag === 'a' && c.href && c.sameOrigin) return { verdict: 'safe', reason: 'internal-nav-link' };
  return { verdict: 'review', reason: 'not-on-allowlist' };
}

async function listCandidates(page) {
  const raw = await page.evaluate(() => {
    document.querySelectorAll('[data-aq-c]').forEach(e => e.removeAttribute('data-aq-c'));
    const out = []; let n = 0;
    const sel = 'button,a[href],a[tabindex],a[routerlink],[role=link],[role=tab],[role=button],[role=menuitem],[role=switch],[role=checkbox],[role=radio],[role=combobox],summary,input[type=checkbox],input[type=radio]';
    for (const e of document.querySelectorAll(sel)) {
      const r = e.getBoundingClientRect(); if (r.width < 4 || r.height < 4) continue;
      if (e.disabled || e.getAttribute('aria-disabled') === 'true') continue;
      const label = (e.getAttribute('aria-label') || e.innerText || e.title || '').trim().replace(/\s+/g, ' ').slice(0, 80);
      const href = e.getAttribute('href') || '';
      let sameOrigin = false; try { sameOrigin = !!href && new URL(href, location.href).origin === location.origin; } catch (_) { /* ignore */ }
      const testid = e.getAttribute('data-testid') || '';
      e.setAttribute('data-aq-c', String(n));
      out.push({
        i: n++, label, tag: e.tagName.toLowerCase(), role: e.getAttribute('role') || e.tagName.toLowerCase(), type: e.getAttribute('type') || '',
        expanded: e.getAttribute('aria-expanded'), popup: e.getAttribute('aria-haspopup') || '', href, sameOrigin, testid,
        inTablist: !!e.closest('[role=tablist],mat-tab-header,.mat-mdc-tab-list,.mat-mdc-tab-group,[class*=tablist],[class*=tab-list],[class*=tab-group]') || /-tab$/i.test(testid),
        inOverlay: !!e.closest('.cdk-overlay-pane,mat-dialog-container,[role=dialog],[role=alertdialog],dialog'),
      });
    }
    return out;
  });
  return raw.map(c => ({ ...c, ...classifyControl(c) }));
}

module.exports = { classifyControl, listCandidates, FORBIDDEN, HARD_WORDS, OPENER_WORDS, HARD, OPENER };
