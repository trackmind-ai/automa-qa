// Write-blocking guard for automaqa:scan.
// PREVENTS writes instead of detecting them: every non-GET request that is not explicitly
// allowed is aborted BEFORE it leaves the browser. Also blocks GET navigation to logout URLs.
//
//   const guard = await installGuard(context, { origin, allowRequests: [...], allowHosts: [...] });
//   ... scan ...
//   guard.summary()      -> { allowed:[{key,count}], blocked:[{key,count,op}], blockedGets:[...] }
//   guard.allow({method:'POST', path:/^\/telemetry$/})   // after the USER approves it
//   guard.writeAudit('audit.json')
//
// Default: ALLOW telemetry hosts and GraphQL *queries*; BLOCK everything else non-GET.

const fs = require('fs');

const TELEMETRY_HOSTS = [
  /(^|\.)sentry\.io$/i, /(^|\.)google-analytics\.com$/i, /(^|\.)googletagmanager\.com$/i,
  /(^|\.)doubleclick\.net$/i, /(^|\.)segment\.(io|com)$/i, /(^|\.)mixpanel\.com$/i,
  /(^|\.)datadoghq\.(com|eu)$/i, /(^|\.)hotjar\.(com|io)$/i, /(^|\.)fullstory\.com$/i,
  /(^|\.)nr-data\.net$/i, /(^|\.)newrelic\.com$/i, /(^|\.)amplitude\.com$/i,
  /(^|\.)clarity\.ms$/i, /(^|\.)posthog\.com$/i,
];
const LOGOUT_GET = /(^|\/)(log-?out|sign-?out|log-?off|sign-?off)(\/|$)/i;

// Returns { read:boolean, op:string } for a GraphQL body; read=true only for pure queries.
function graphqlInfo(body) {
  if (!body) return { read: false, op: '' };
  let parsed;
  try { parsed = JSON.parse(body); } catch (_) { return { read: false, op: '' }; }
  const ops = Array.isArray(parsed) ? parsed : [parsed];
  let read = true; const names = [];
  for (const o of ops) {
    const q = typeof o.query === 'string' ? o.query.trim() : '';
    if (o.operationName) names.push(o.operationName);
    if (!q) { read = false; continue; }                       // persisted query: cannot prove read
    if (/^\s*(mutation|subscription)\b/i.test(q) || /\bmutation\b/i.test(q)) read = false;
    else if (!/^(query\b|\{)/i.test(q)) read = false;
  }
  return { read, op: names.join(',') };
}

async function installGuard(context, opts = {}) {
  const allowHosts = [...TELEMETRY_HOSTS, ...(opts.allowHosts || [])];
  const allowRequests = [...(opts.allowRequests || [])];     // {method?, host?, path?: RegExp|string}
  const state = { allowed: new Map(), blocked: new Map(), blockedGets: new Map(), last: null };

  const bump = (map, key, extra) => { const e = map.get(key) || { key, count: 0, ...extra }; e.count++; map.set(key, e); };
  const matchesAllow = (m, u) => allowRequests.some(r =>
    (!r.method || r.method.toUpperCase() === m) &&
    (!r.host || (r.host instanceof RegExp ? r.host.test(u.host) : r.host === u.host)) &&
    (!r.path || (r.path instanceof RegExp ? r.path.test(u.pathname) : r.path === u.pathname)));

  await context.route('**/*', async route => {
    const req = route.request();
    const m = req.method().toUpperCase();
    let u; try { u = new URL(req.url()); } catch (_) { return route.continue(); }
    if (!/^https?:$/.test(u.protocol)) return route.continue();

    if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') {
      if (req.isNavigationRequest() && LOGOUT_GET.test(u.pathname)) {
        bump(state.blockedGets, `GET ${u.host}${u.pathname}`);
        return route.abort('blockedbyclient');
      }
      return route.continue();
    }

    const key = `${m} ${u.host}${u.pathname}`;
    if (allowHosts.some(rx => rx.test(u.host)) || matchesAllow(m, u)) {
      bump(state.allowed, key);
      return route.continue();
    }
    let op = '';
    if (/graphql/i.test(u.pathname)) {
      const g = graphqlInfo(req.postData() || '');
      op = g.op;
      if (g.read) { bump(state.allowed, key + ' [graphql query]'); return route.continue(); }
    }
    bump(state.blocked, key, { op });
    state.last = { method: m, host: u.host, path: u.pathname, op, at: Date.now() };
    if (typeof opts.onBlock === 'function') { try { opts.onBlock(state.last); } catch (_) { /* ignore */ } }
    return route.abort('blockedbyclient');
  });

  const list = map => [...map.values()].sort((a, b) => b.count - a.count);
  return {
    state,
    get lastBlocked() { return state.last; },
    allow(rule) { allowRequests.push(rule); },
    summary() { return { allowed: list(state.allowed), blocked: list(state.blocked), blockedGets: list(state.blockedGets) }; },
    writeAudit(file) { fs.writeFileSync(file, JSON.stringify(this.summary(), null, 1)); },
  };
}

module.exports = { installGuard, graphqlInfo, TELEMETRY_HOSTS };
