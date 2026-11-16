// Show the blocked-request list AT THE START, so read-only calls can be approved before the scan.
//   const { learn, formatForApproval } = require('./learn');
//   const r = await learn(page, url);          // installs the guard, loads the page, returns what was blocked / allowed
//   console.log(formatForApproval(r));         // numbered list for the user; nothing is allowed until the user says so
//   guard.allow({ method: 'POST', path: /.../ })  // only for entries the user approved
// The guard stays strict: anything not approved remains blocked for the whole scan.
const { installGuard } = require('./guard');
const { waitLoaded } = require('./loading');

// A hint only — the user decides. Never auto-approve.
function hint(e) {
  const p = e.key.replace(/^(GET|POST|PUT|PATCH|DELETE)\s+[^/]+/, '');
  if (/(create|update|delete|remove|save|send|resend|invite|approve|publish|resolve|assign|upload)/i.test(p)) return 'looks like a WRITE';
  if (/(insights?|overview|search|query|list|summary|session|status|me\b|profile|token)/i.test(p)) return 'may be a read-only call (check with the owner)';
  return 'unknown';
}
async function learn(page, url, opts = {}) {
  const guard = await installGuard(page.context(), opts.guard || {});
  if (url) await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  const load = await waitLoaded(page, opts.wait || {});
  const s = guard.summary();
  return { guard, load, blocked: s.blocked.map(b => ({ ...b, hint: hint(b) })), allowed: s.allowed, blockedGets: s.blockedGets };
}
function formatForApproval(r) {
  const rows = r.blocked.map((b, i) => `${String(i + 1).padStart(2)}. ${b.count}x ${b.key}${b.op ? ' [op ' + b.op + ']' : ''}  -> ${b.hint}`);
  return ['Requests the write guard BLOCKED while loading the first page (nothing was sent):', ...(rows.length ? rows : ['   (none)']),
    '', `Allowed automatically: ${r.allowed.map(a => a.count + 'x ' + a.key.split('/')[0]).join(', ') || '(none)'} (telemetry and GraphQL queries).`,
    'Approve only calls you know are read-only. Everything else stays blocked for the whole scan.'].join('\n');
}
module.exports = { learn, formatForApproval, hint };
