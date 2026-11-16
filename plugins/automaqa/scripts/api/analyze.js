#!/usr/bin/env node
'use strict';
/**
 * analyze.js — read a Postman v2.x collection and work out what is needed to run it.
 *
 *   node analyze.js <collection.json> [--out .automaqa/api] [--env env.json] [--inputs inputs.json] [--json]
 *
 * Writes (in --out):
 *   plan.json    normalised requests, execution order, input table, lint findings
 *   inputs.json  created if absent, otherwise gains empty slots for newly-required inputs
 *
 * Read-only with respect to the collection. Makes no network calls.
 */

const fs = require('fs');
const path = require('path');
const L = require('./lib');
const { loadValues } = require('./inputs');

const IDENTITY = /^(patient|client|provider|user|member|practice|org|organization|account|customer)[_-]?id$/i;

function categorize(name) {
  if (/^(host|base_?url|server|api_?url|url)$/i.test(name)) return 'base';
  if (/token|api_?key|secret|password|bearer/i.test(name)) return 'auth';
  if (IDENTITY.test(name)) return 'identity';
  if (/(^|[_-])id$|[a-z]Id$/.test(name)) return 'id';
  return 'value';
}

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      const k = t.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) a[k] = true;
      else (a[k] = next, i++);
    } else a._.push(t);
  }
  return a;
}

function uniq(a) {
  return [...new Set(a)];
}

function analyze(collection, opts = {}) {
  const raw = L.flatten(collection);
  const names = L.makeRedactor([]);
  // Never carry literal tokens into plan.json.
  const strip = (x) => JSON.parse(JSON.stringify(x).replace(L.JWT_RE, '<jwt-redacted>'));
  const hardcoded = raw.filter((r) => L.JWT_RE.test(JSON.stringify([r.headers, r.body, r.auth, r.query]))).map((r) => r.id);
  L.JWT_RE.lastIndex = 0;
  void names;

  // 1. variable usage counts (for typo detection)
  const counts = new Map();
  const needsRaw = new Map();
  for (const r of raw) {
    const s = L.requestVars(r);
    needsRaw.set(r.id, s);
    for (const v of s) counts.set(v, (counts.get(v) || 0) + 1);
  }
  const explicitByReq = new Map(raw.map((r) => [r.id, L.explicitProducers(r)]));
  const explicitVars = new Set([...explicitByReq.values()].flat().map((p) => p.var));

  // 2. aliases: rarely-used names that are almost certainly typos of common ones
  const aliases = {};
  for (const [name, c] of counts) {
    if (L.isDynamicVar(name) || explicitVars.has(name)) continue;
    const s = L.suggestAlias(name, counts);
    // Hyphen/underscore twins used equally often: prefer the underscore spelling.
    if (s && (s.count > c || (s.why === 'separator' && s.count === c && name.includes('-')))) aliases[name] = s.to;
  }
  const eff = (n) => aliases[n] || n;

  // 3. values already known
  const loaded = loadValues({ collection, envFile: opts.envFile, inputsFile: opts.inputsFile, names: [...counts.keys()] });
  const userAliases = { ...aliases, ...loaded.aliases };
  const effU = (n) => userAliases[n] || n;
  const known = (n) => loaded.values[effU(n)] !== undefined || loaded.values[n] !== undefined;

  // 4. per-request records
  const requests = raw.map((r) => {
    const cls = L.classify(r);
    const needs = uniq([...needsRaw.get(r.id)].filter((v) => !L.isDynamicVar(v)).map(effU));
    const explicit = explicitByReq.get(r.id);

    // expected status + response shape from saved examples (shapes only — never values; examples may hold PHI)
    const codes = r.examples.map((e) => Number(e.code)).filter(Boolean);
    const ok2 = codes.filter((c) => c >= 200 && c < 300);
    let shape = null;
    const shapeEx = r.examples.find((e) => e.code >= 200 && e.code < 300 && e.body) || r.examples.find((e) => e.body);
    if (shapeEx) {
      try {
        const parsed = JSON.parse(shapeEx.body);
        if (parsed && typeof parsed === 'object') shape = L.inferShape(parsed);
      } catch {
        /* non-JSON example */
      }
    }

    // mandatory-parameter hints: blank / placeholder fields we will send as-is
    const placeholders = [];
    r.query.filter((q) => q.value === '').forEach((q) => placeholders.push({ where: `query.${q.key}`, value: '' }));
    if (r.body && r.body.mode === 'raw' && r.body.raw) {
      let parsed;
      for (const filler of ['"__v__"', '0']) {
        try {
          parsed = JSON.parse(r.body.raw.replace(/"\{\{[^}]+\}\}"/g, '"__v__"').replace(/\{\{[^}]+\}\}/g, filler.replace(/"/g, '')));
          break;
        } catch {
          /* try next filler */
        }
      }
      const walk = (v, p) => {
        if (v === '' || v === null || (typeof v === 'string' && /^<[^>]+>$|^(string|integer|number|boolean)$/i.test(v))) {
          placeholders.push({ where: p, value: v === null ? null : v });
        } else if (Array.isArray(v)) v.slice(0, 3).forEach((x, i) => walk(x, `${p}[${i}]`));
        else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, p ? `${p}.${k}` : k);
      };
      if (parsed !== undefined) walk(parsed, 'body');
    }
    const files = r.body && r.body.mode === 'formdata' ? (r.body.formdata || []).filter((f) => f.type === 'file' && !f.disabled).map((f) => f.key) : [];

    return {
      id: r.id,
      index: r.index,
      folder: r.folder,
      name: r.name,
      path: r.path,
      method: r.method,
      urlRaw: strip(r.urlRaw),
      query: strip(r.query),
      pathVars: strip(r.pathVars),
      headers: strip(r.headers),
      body: strip(r.body),
      auth: strip(r.auth),
      kind: cls.kind,
      phase: cls.phase,
      sensitive: cls.sensitive,
      tokenEndpoint: cls.tokenEndpoint,
      classReasons: cls.reasons,
      needs,
      explicitProduces: explicit.map((p) => ({ var: p.var, path: p.path })),
      inferredProduces: [],
      expected: { codes: uniq(ok2.length ? ok2 : codes), source: codes.length ? 'example' : 'default', documented: uniq(codes) },
      shape,
      placeholders,
      files,
      hasTests: r.scripts.length > 0,
    };
  });
  const byId = new Map(requests.map((r) => [r.id, r]));

  // 5. inferred producers: `thing_id` ← a collection endpoint called ".../things" (GET list preferred, then POST create)
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const endpointOf = new Map(requests.map((r) => [r.id, L.endpointShape(r)]));
  const producerCache = new Map();
  const inferredFor = (v) => {
    if (producerCache.has(v)) return producerCache.get(v);
    let out = [];
    const cat = categorize(v);
    const noun = L.idNoun(v);
    if (noun && (cat === 'id')) {
      out = requests
        .filter((c) => {
          if (c.kind === 'destructive' || c.tokenEndpoint || c.sensitive) return false;
          if (!['GET', 'POST'].includes(c.method)) return false;
          const e = endpointOf.get(c.id);
          return e.last && L.singular(norm(e.last)) === norm(noun);
        })
        .sort((a, b) => (a.method === b.method ? a.index - b.index : a.method === 'GET' ? -1 : 1))
        .slice(0, 3)
        .map((c) => c.id);
    }
    producerCache.set(v, out);
    return out;
  };
  const explicitProducersOf = (v) => requests.filter((r) => r.explicitProduces.some((p) => p.var === v)).map((r) => r.id);

  const allVars = uniq(requests.flatMap((r) => r.needs));
  for (const v of allVars) {
    if (explicitProducersOf(v).length || known(v)) continue;
    for (const id of inferredFor(v)) byId.get(id).inferredProduces.push({ var: v });
  }

  // 6. input table
  const inputs = allVars
    .map((v) => {
      const cat = categorize(v);
      const users = requests.filter((r) => r.needs.includes(v));
      const explicit = explicitProducersOf(v);
      const inferred = known(v) || explicit.length ? [] : inferredFor(v);
      const provided = known(v);
      let status = 'missing';
      if (provided) status = 'provided';
      else if (explicit.length) status = 'derived';
      else if (inferred.length && cat === 'id') status = 'derived';
      return {
        name: v,
        category: cat,
        secret: cat === 'auth',
        status,
        source: provided ? loaded.origin[v] || loaded.origin[Object.keys(userAliases).find((k) => userAliases[k] === v)] : undefined,
        usedBy: users.length,
        usedIn: users.slice(0, 3).map((r) => r.path),
        explicitProducers: explicit,
        inferredProducers: inferred,
        aliasesFrom: Object.keys(userAliases).filter((k) => userAliases[k] === v),
      };
    })
    .sort((a, b) => b.usedBy - a.usedBy);

  // 7. execution order — safe phases, with producers pulled ahead of their consumers
  const have = new Set(inputs.filter((i) => i.status === 'provided').map((i) => i.name));
  const sortKey = (a, b) => a.phase - b.phase || a.index - b.index;
  const pickProducer = (v, self) => {
    const ex = requests.filter((r) => r.id !== self.id && r.explicitProduces.some((p) => p.var === v)).sort(sortKey)[0];
    if (ex) return ex;
    const inf = inferredFor(v).filter((id) => id !== self.id).map((id) => byId.get(id));
    return inf[0];
  };
  const state = new Set();
  const order = [];
  const visit = (r) => {
    if (state.has(r.id)) return;
    state.add(r.id);
    for (const v of r.needs) {
      if (have.has(v)) continue;
      const p = pickProducer(v, r);
      if (p && p.kind !== 'destructive') visit(p);
    }
    order.push(r.id);
  };
  [...requests].sort(sortKey).forEach(visit);

  // 8. lint
  const lint = [];
  for (const [from, to] of Object.entries(aliases)) {
    lint.push({ level: 'warn', code: 'variable-typo', message: `{{${from}}} looks like a typo of {{${to}}} — treated as an alias (edit "aliases" in inputs.json to change)`, requests: requests.filter((r) => r.needs.includes(to) && needsRaw.get(r.id).has(from)).map((r) => r.id) });
  }
  const leading = raw.filter((r) => /^\/+(?=\{\{|https?:)/.test(r.urlRaw));
  if (leading.length) lint.push({ level: 'warn', code: 'leading-slash-url', message: 'URL starts with "/" before the host — the slash is stripped at run time', requests: leading.map((r) => r.id) });
  const hardHost = requests.filter((r) => /^https?:\/\//i.test(r.urlRaw) && !r.tokenEndpoint);
  if (hardHost.length) {
    const hosts = uniq(hardHost.map((r) => r.urlRaw.replace(/\{\{[^}]*\}\}/g, 'x').replace(/^https?:\/\/([^/:?#]+).*$/i, '$1')));
    lint.push({ level: 'warn', code: 'hardcoded-host', message: `Request URL ignores {{host}} and targets ${hosts.join(', ')} directly — it runs against that host whatever you configure (writes also need --confirm-host for it)`, requests: hardHost.map((r) => r.id) });
  }
  const emptyUrl = requests.filter((r) => !String(r.urlRaw || '').trim());
  if (emptyUrl.length) lint.push({ level: 'warn', code: 'empty-url', message: 'Requests have no URL — they are skipped as invalid', requests: emptyUrl.map((r) => r.id) });
  const hasAuthHeader = (r) => (r.headers || []).some((h) => String(h.key).toLowerCase() === 'authorization');
  const noAuth = requests.filter((r) => r.auth && r.auth.type === 'none' && !hasAuthHeader(r) && !r.tokenEndpoint && String(r.urlRaw || '').trim());
  if (noAuth.length && noAuth.length < requests.length / 2) {
    lint.push({ level: 'warn', code: 'no-auth-request', message: 'Requests are set to No Auth while most of the collection uses auth — they are sent without a token and may return 401 (use --auth-fallback <variable> at run time to send one)', requests: noAuth.map((r) => r.id) });
  }
  const tokenPairs = new Set();
  for (const r of requests) {
    if (!r.needs.includes('token')) continue;
    const others = r.needs.filter((n) => n !== 'token' && /_token$/i.test(n));
    if (others.length === 1) tokenPairs.add(others[0]);
  }
  if (tokenPairs.size === 1) {
    const other = [...tokenPairs][0];
    lint.push({ level: 'info', code: 'token-alias-hint', message: `{{token}} is used together with {{${other}}} — they may be the same credential. If so, set "aliases": { "token": "${other}" } in inputs.json (not applied automatically)`, requests: requests.filter((r) => r.needs.includes('token')).map((r) => r.id) });
  }
  const junk = raw.filter((r) => /\{\{[^}]*[.()[\]][^}]*\}\}/.test(JSON.stringify([r.urlRaw, r.headers, r.body, r.query])));
  if (junk.length) lint.push({ level: 'warn', code: 'template-leftover', message: 'Request contains {{...}} template code that is not a variable (e.g. {{response.status}})', requests: junk.map((r) => r.id) });
  if (hardcoded.length) lint.push({ level: 'warn', code: 'hardcoded-secret', message: 'A literal JWT/token is embedded in the collection — removed from plan.json; rotate it and use variables', requests: hardcoded });
  const sig = new Map();
  for (const r of requests) {
    const k = r.method + ' ' + r.urlRaw + ' ' + JSON.stringify(r.body && r.body.raw);
    sig.set(k, (sig.get(k) || []).concat(r.id));
  }
  const dups = [...sig.values()].filter((v) => v.length > 1);
  if (dups.length) lint.push({ level: 'info', code: 'duplicate-request', message: `${dups.length} group(s) of identical requests (e.g. "… Copy") — each runs separately`, requests: dups.flat() });
  for (const r of requests.filter((x) => x.tokenEndpoint)) {
    const empty = !r.body || (r.body.mode === 'raw' && !String(r.body.raw || '').trim());
    lint.push({ level: 'info', code: 'token-endpoint', message: `"${r.path}" is a token endpoint${empty ? ' with an empty body (credentials are not in the collection) — it is skipped; use "tokenRequests" in inputs.json' : ''}`, requests: [r.id] });
  }
  const upl = requests.filter((r) => r.files.length);
  if (upl.length) lint.push({ level: 'info', code: 'file-upload', message: 'Requests upload files — provide paths via requestOverrides[...].files or they are skipped', requests: upl.map((r) => r.id) });
  const unsup = requests.filter((r) => r.auth.type === 'unsupported');
  if (unsup.length) lint.push({ level: 'warn', code: 'unsupported-auth', message: 'Auth type not supported (only bearer, basic, apikey, none) — sent without auth', requests: unsup.map((r) => r.id) });
  const noExp = requests.filter((r) => !r.hasTests && !r.shape);
  lint.push({ level: 'info', code: 'weak-expectations', message: `${noExp.length} of ${requests.length} requests have neither a test script nor a saved example — they are checked for a 2xx status only`, requests: [] });

  const countBy = (f) => requests.reduce((m, r) => ((m[f(r)] = (m[f(r)] || 0) + 1), m), {});
  const plan = {
    meta: {
      collection: collection.info && collection.info.name,
      schema: collection.info && collection.info.schema,
      generatedAt: new Date().toISOString(),
      requests: requests.length,
      byMethod: countBy((r) => r.method),
      byKind: countBy((r) => r.kind),
      sensitive: requests.filter((r) => r.sensitive).length,
      withExpectations: requests.length - noExp.length,
    },
    aliases: userAliases,
    order,
    inputs,
    lint,
    requests,
  };
  return plan;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function main() {
  const args = parseArgs(process.argv.slice(2));
  const file = args._[0];
  if (!file) {
    console.error('usage: node analyze.js <collection.json> [--out .automaqa/api] [--env env.json] [--inputs inputs.json] [--json]');
    process.exit(2);
  }
  const out = path.resolve(typeof args.out === 'string' ? args.out : '.automaqa/api');
  const inputsFile = typeof args.inputs === 'string' ? path.resolve(args.inputs) : path.join(out, 'inputs.json');
  fs.mkdirSync(out, { recursive: true });
  const collection = L.readJson(file);
  const plan = analyze(collection, { envFile: typeof args.env === 'string' ? path.resolve(args.env) : null, inputsFile });
  plan.meta.collectionFile = path.resolve(file);
  fs.writeFileSync(path.join(out, 'plan.json'), JSON.stringify(plan, null, 2));

  // inputs.json: create, or add empty slots for newly required inputs (never overwrite a value)
  const existing = fs.existsSync(inputsFile) ? L.readJson(inputsFile) : {};
  const next = {
    _help: 'Fill "variables" and "secrets". Keep this file out of git. Env vars AUTOMAQA_API_<NAME> also work and win over this file.',
    variables: {},
    secrets: {},
    tokenRequests: {},
    aliases: plan.aliases,
    requestOverrides: {},
    ...existing,
  };
  next.variables = next.variables || {};
  next.secrets = next.secrets || {};
  for (const i of plan.inputs.filter((x) => x.status === 'missing')) {
    const bucket = i.secret ? next.secrets : next.variables;
    if (!(i.name in next.variables) && !(i.name in next.secrets)) bucket[i.name] = '';
  }
  fs.writeFileSync(inputsFile, JSON.stringify(next, null, 2));

  if (args.json) {
    console.log(JSON.stringify({ meta: plan.meta, inputs: plan.inputs, lint: plan.lint, inputsFile, planFile: path.join(out, 'plan.json') }, null, 2));
    return;
  }
  const m = plan.meta;
  console.log(`Collection: ${m.collection}`);
  console.log(`Requests: ${m.requests}  (${Object.entries(m.byMethod).map(([k, v]) => `${k} ${v}`).join(', ')})`);
  console.log(`Kinds: ${Object.entries(m.byKind).map(([k, v]) => `${k} ${v}`).join(', ')}; sensitive (email/SMS/OTP-like): ${m.sensitive}`);
  console.log(`Expectations: ${m.withExpectations}/${m.requests} requests have a saved example or test script\n`);
  const grp = (s) => plan.inputs.filter((i) => i.status === s);
  console.log(`Inputs to provide (${grp('missing').length}):`);
  for (const i of grp('missing')) console.log(`  - ${i.name.padEnd(26)} [${i.category}${i.secret ? ', secret' : ''}] used by ${i.usedBy}  e.g. ${i.usedIn[0]}`);
  console.log(`\nDerived at run time (${grp('derived').length}): ${grp('derived').map((i) => i.name).join(', ') || '—'}`);
  console.log(`Already provided (${grp('provided').length}): ${grp('provided').map((i) => i.name).join(', ') || '—'}`);
  console.log('\nFindings:');
  for (const l of plan.lint) console.log(`  [${l.level}] ${l.code}: ${l.message}${l.requests.length ? ` (${l.requests.length} request${l.requests.length > 1 ? 's' : ''})` : ''}`);
  console.log(`\nWrote ${path.join(out, 'plan.json')}\nWrote ${inputsFile}`);
}

if (require.main === module) main();
module.exports = { analyze, categorize, parseArgs };
