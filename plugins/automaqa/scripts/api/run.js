#!/usr/bin/env node
'use strict';
/**
 * run.js — execute a plan.json produced by analyze.js, validate every response, and write
 * results.json plus an HTML/Markdown report.
 *
 *   node run.js [--out .automaqa/api] [--plan plan.json] [--inputs inputs.json] [--env env.json]
 *               [--mode read-only|full] [--confirm-host <hostname>] [--allow-production-writes]
 *               [--allow-destructive] [--allow-sensitive] [--only "Folder A,Folder B"]
 *               [--schema balanced|strict|lenient|off] [--bodies failures|all|none]
 *               [--timeout 30000] [--slow 5000] [--delay 0] [--dry-run] [--no-fail-exit]
 *
 * Safety defaults: read-only; sensitive (email/SMS/OTP) calls blocked; DELETEs blocked;
 * writes need --mode full AND --confirm-host matching the host, and refuse hosts that look
 * like production unless --allow-production-writes is also passed.
 *
 * Credentials are pinned to confirmed hosts: a saved token, an Authorization header or any
 * secret value is only sent to a host the user supplied (a base-URL input given outside the
 * collection, or --confirm-host). A request to any other host is skipped, not sent.
 */

const fs = require('fs');
const path = require('path');
const L = require('./lib');
const { loadValues } = require('./inputs');
const { parseArgs } = require('./analyze');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hostnameOf = (u) => {
  try {
    return new URL(u).hostname;
  } catch {
    return '';
  }
};

const BASE_NAME = /^(host|base_?url|server|api_?url|url)$/i;

function hostOfValue(v) {
  if (typeof v !== 'string' || !v.trim() || v.includes('{{')) return '';
  const s = v.trim();
  return hostnameOf(/^https?:\/\//i.test(s) ? s : 'https://' + s.replace(/^\/+/, '')).toLowerCase();
}

// Hosts that may receive credentials: --confirm-host values, plus the host of any base-URL input the
// user supplied themselves. A base URL that only comes from the collection file is NOT trusted, because
// a collection could point {{host}} anywhere.
function trustedHostsOf({ confirmHosts = [], values = {}, origin = {} }) {
  const set = new Set(confirmHosts.map((h) => h.toLowerCase()));
  for (const [k, v] of Object.entries(values)) {
    if (BASE_NAME.test(k) && origin[k] !== 'collection') {
      const h = hostOfValue(v);
      if (h) set.add(h);
    }
  }
  return set;
}

// Does this built request carry a credential? An Authorization header, or any saved secret value
// appearing in the URL, a header value or the body.
function carriesCredentials(built, secretValues) {
  const h = built.headers || {};
  if (h.authorization) return true;
  const secrets = [...secretValues].filter((s) => typeof s === 'string' && s.length >= 6);
  if (!secrets.length) return false;
  const parts = [built.url, ...Object.values(h).map(String)];
  if (typeof built.body === 'string') parts.push(built.body);
  else if (built.body && typeof built.body.values === 'function') for (const v of built.body.values()) if (typeof v === 'string') parts.push(v);
  return parts.some((p) => secrets.some((s) => String(p).includes(s)));
}

const untrustedMessage = (host) => `skipped: would send credentials to ${host || 'an unknown host'} — not a confirmed host (use --confirm-host ${host || '<hostname>'} only if that host is intended)`;

function maskUrl(url, red) {
  const i = url.indexOf('?');
  if (i < 0) return red.maskString(url);
  const q = Object.fromEntries(url.slice(i + 1).split('&').map((p) => p.split('=').map(decodeURIComponent).concat('').slice(0, 2)));
  const masked = red.maskDeep(q);
  return red.maskString(url.slice(0, i)) + '?' + Object.entries(masked).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

// res is optional: with it, a 404 is split into route-not-found (HTML page = the path does not exist)
// and data-not-found (JSON body = the route exists but the resource does not). 401/403 on a request
// that was sent with no auth becomes auth-not-sent (res.authSent === false).
function category(code, res) {
  if (code === 401 || code === 403) return res && res.authSent === false ? 'auth-not-sent' : 'auth';
  if (code === 404 || code === 410) {
    if (!res) return 'not-found';
    const ct = String(res.contentType || '');
    const body = String(res.text || '').trim();
    return /html/i.test(ct) || /^<!doctype html|^<html/i.test(body) ? 'route-not-found' : 'data-not-found';
  }
  if (code === 429) return 'rate-limit';
  if ([400, 409, 415, 422].includes(code)) return 'validation';
  if (code >= 500) return 'server-error';
  if (code >= 300 && code < 400) return 'redirect';
  return 'unexpected-status';
}

function hintFor(cat, r) {
  const idVars = r.needs.filter((v) => /id$/i.test(v));
  const tok = r.needs.find((v) => /token/i.test(v));
  switch (cat) {
    case 'auth':
      return `Check {{${tok || 'token'}}} is valid, unexpired and belongs to the right role (provider vs client).`;
    case 'auth-not-sent':
      return 'No token was sent: this request is set to No Auth in the collection. Fix the collection, or re-run with --auth-fallback <variable> (e.g. provider_token) to send that token on such requests.';
    case 'route-not-found':
      return 'The server has no such route (HTML 404). The path in the collection is probably outdated — compare it with the API\'s current paths.';
    case 'data-not-found':
    case 'not-found':
      return idVars.length ? `Check the IDs used: ${idVars.map((v) => `{{${v}}}`).join(', ')} — they must exist on this environment.` : 'Check the URL path and that the resource exists.';
    case 'validation':
      return r.placeholders.length ? `Body/query has blank or placeholder fields (${r.placeholders.slice(0, 4).map((p) => p.where).join(', ')}); supply real values via requestOverrides.` : 'Check mandatory params and body fields.';
    case 'server-error':
      return 'Server-side failure — check service logs; the request itself may be fine.';
    default:
      return undefined;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const out = path.resolve(typeof args.out === 'string' ? args.out : '.automaqa/api');
  const planFile = typeof args.plan === 'string' ? path.resolve(args.plan) : path.join(out, 'plan.json');
  const inputsFile = typeof args.inputs === 'string' ? path.resolve(args.inputs) : path.join(out, 'inputs.json');
  if (!fs.existsSync(planFile)) {
    console.error(`No plan at ${planFile} — run analyze.js first.`);
    process.exit(2);
  }
  const plan = L.readJson(planFile);
  const opts = {
    mode: args.mode === 'full' ? 'full' : 'read-only',
    confirmHosts: String(args['confirm-host'] || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    allowProd: !!args['allow-production-writes'],
    allowDestructive: !!args['allow-destructive'],
    allowSensitive: !!args['allow-sensitive'],
    schema: ['balanced', 'strict', 'lenient', 'off'].includes(args.schema) ? args.schema : 'balanced',
    bodies: ['failures', 'all', 'none'].includes(args.bodies) ? args.bodies : 'failures',
    timeout: Number(args.timeout) || 30000,
    slow: Number(args.slow) || 5000,
    delay: Number(args.delay) || 0,
    dryRun: !!args['dry-run'],
    authFallback: typeof args['auth-fallback'] === 'string' ? args['auth-fallback'] : '',
    ignoreExpired: !!args['ignore-expired'],
    only: String(args.only || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  };
  if (opts.mode === 'read-only' && opts.allowDestructive) {
    console.error('Note: --allow-destructive has no effect without --mode full.');
  }

  // ── values ────────────────────────────────────────────────────────────────
  const collection = plan.meta.collectionFile && fs.existsSync(plan.meta.collectionFile) ? L.readJson(plan.meta.collectionFile) : null;
  const names = [...new Set([...plan.inputs.map((i) => i.name), ...Object.keys(plan.aliases || {})])];
  const loaded = loadValues({ collection, envFile: typeof args.env === 'string' ? path.resolve(args.env) : null, inputsFile, names });
  const vars = { ...loaded.values };
  const origin = { ...loaded.origin };
  const aliases = { ...(plan.aliases || {}), ...loaded.aliases };
  const lookup = (n) => (vars[n] !== undefined ? vars[n] : vars[aliases[n]]);
  const secretVals = new Set();
  const refreshSecrets = () => {
    for (const [k, v] of Object.entries(vars)) if (/token|secret|password|key|pass/i.test(k) && typeof v === 'string') secretVals.add(v);
    const walk = (x) => (typeof x === 'string' ? secretVals.add(x) : x && typeof x === 'object' ? Object.values(x).forEach(walk) : 0);
    Object.values(loaded.tokenRequests).forEach((t) => walk(t.body));
  };
  refreshSecrets();
  const red = () => L.makeRedactor([...secretVals]);
  const trusted = trustedHostsOf({ confirmHosts: opts.confirmHosts, values: vars, origin });

  const producers = {};
  for (const r of plan.requests) {
    for (const p of r.explicitProduces) (producers[p.var] = producers[p.var] || []).push(r.id);
    for (const p of r.inferredProduces) (producers[p.var] = producers[p.var] || []).push(r.id);
  }
  const byId = new Map(plan.requests.map((r) => [r.id, r]));
  const done = new Map(); // id -> result

  // ── token requests ────────────────────────────────────────────────────────
  const authFetch = [];
  async function fetchToken(name) {
    const def = loaded.tokenRequests[name];
    if (!def) return false;
    const missing = new Set();
    const sub = (s) => L.substitute(s, lookup, missing);
    const url = sub(def.url);
    const headers = Object.fromEntries(Object.entries(def.headers || {}).map(([k, v]) => [k, sub(v)]));
    let body;
    if (def.body !== undefined) {
      const b = typeof def.body === 'string' ? sub(def.body) : JSON.parse(sub(JSON.stringify(def.body)));
      if (def.contentType === 'form') {
        body = new URLSearchParams(b).toString();
        headers['content-type'] = 'application/x-www-form-urlencoded';
      } else {
        body = typeof b === 'string' ? b : JSON.stringify(b);
        headers['content-type'] = headers['content-type'] || 'application/json';
      }
    }
    if (missing.size) {
      authFetch.push({ var: name, ok: false, message: `missing: ${[...missing].join(', ')}` });
      return false;
    }
    const tokenHost = hostnameOf(url).toLowerCase();
    if (!trusted.has(tokenHost)) {
      authFetch.push({ var: name, ok: false, message: untrustedMessage(tokenHost) });
      return false;
    }
    try {
      const res = await fetch(url, { method: def.method || 'POST', headers, body, signal: AbortSignal.timeout(opts.timeout) });
      const text = await res.text();
      let j = null;
      try {
        j = JSON.parse(text);
      } catch {
        /* not json */
      }
      const tok = j && L.getPath(j, String(def.tokenPath || 'access_token').split('.'));
      if (res.ok && tok) {
        vars[name] = String(tok);
        origin[name] = 'token request';
        refreshSecrets();
        authFetch.push({ var: name, ok: true, message: `HTTP ${res.status}, token obtained` });
        return true;
      }
      authFetch.push({ var: name, ok: false, message: `HTTP ${res.status}${tok ? '' : ', no token at ' + (def.tokenPath || 'access_token')}` });
    } catch (e) {
      authFetch.push({ var: name, ok: false, message: String((e.cause && e.cause.code) || e.message) });
    }
    return false;
  }
  if (!opts.dryRun) for (const name of Object.keys(loaded.tokenRequests)) if (!vars[name]) await fetchToken(name);

  // ── token expiry pre-flight (prints names and times only, never values) ─────
  {
    const expired = [];
    const soon = [];
    for (const [k, v] of Object.entries(vars)) {
      const p = typeof v === 'string' && /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(v) ? L.jwtPayload(v) : null;
      if (!p || !p.exp) continue;
      const ms = p.exp * 1000 - Date.now();
      if (ms < 0) expired.push(`${k} (expired ${new Date(p.exp * 1000).toISOString()})`);
      else if (ms < 10 * 60e3) soon.push(`${k} (expires ${new Date(p.exp * 1000).toISOString()})`);
    }
    if (soon.length) console.error(`Note: token(s) expire within 10 minutes: ${soon.join(', ')}`);
    if (expired.length) {
      console.error(`Expired token(s): ${expired.join(', ')}. Refresh them (SKILL.md step 2b) before running, or pass --ignore-expired.`);
      if (!opts.dryRun && !opts.ignoreExpired) process.exit(2);
    }
  }

  // ── request building ──────────────────────────────────────────────────────
  function build(r) {
    const missing = new Set();
    const derived = new Set(); // dry-run only: values assumed to come from upstream requests
    const look = (n) => {
      const v = lookup(n);
      if (v === undefined && opts.dryRun && producers[n]) {
        derived.add(n);
        return `<derived:${n}>`;
      }
      return v;
    };
    const valueOf = (n) => (L.isDynamicVar(n) ? L.dynamicValue(n) : look(n));
    const sub = (s) => L.substitute(s, look, missing);
    const ov = loaded.overrides[r.id] || loaded.overrides[r.path] || {};
    const warnings = [];

    let base = r.urlRaw.split('#')[0].split('?')[0].replace(/^\/+(?=\{\{|https?:)/, '');
    base = sub(base);
    base = base.replace(/\/:([A-Za-z_]\w*)/g, (m, k) => {
      const pv = r.pathVars.find((p) => p.key === k);
      const val = pv ? sub(pv.value) : '';
      if (!val || /\{\{/.test(val)) {
        missing.add(':' + k);
        return m;
      }
      return '/' + encodeURIComponent(val);
    });
    if (!/^https?:\/\//i.test(base) && !/\{\{/.test(base)) base = 'https://' + base.replace(/^\/+/, '');

    const q = r.query.map((x) => ({ key: sub(x.key), value: sub(x.value) }));
    for (const [k, v] of Object.entries(ov.query || {})) {
      const e = q.find((x) => x.key === k);
      if (e) e.value = String(v);
      else q.push({ key: k, value: String(v) });
    }
    const qs = q.map(({ key, value }) => `${encodeURIComponent(key)}=${value.includes('%') ? value : encodeURIComponent(value)}`).join('&');
    const url = base + (qs ? '?' + qs : '');

    const headers = {};
    for (const h of r.headers) {
      const k = h.key.toLowerCase();
      if (['host', 'content-length'].includes(k)) continue;
      headers[k] = sub(h.value);
    }
    Object.assign(headers, Object.fromEntries(Object.entries(ov.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)])));
    if (!headers.accept) headers.accept = 'application/json';

    const a = r.auth;
    if (a.type === 'bearer' && !headers.authorization) {
      const t = sub(a.token);
      if (t && !/\{\{/.test(t)) headers.authorization = 'Bearer ' + t;
    } else if (a.type === 'basic' && !headers.authorization) {
      const u = sub(a.username);
      const p = sub(a.password);
      if (!/\{\{/.test(u + p)) headers.authorization = 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');
    } else if (a.type === 'apikey') {
      const k = sub(a.key);
      const v = sub(a.value);
      if (a.in === 'query') {
        /* appended below */
      } else if (!/\{\{/.test(k + v)) headers[k.toLowerCase()] = v;
    } else if (a.type === 'none' && opts.authFallback && !r.tokenEndpoint && !headers.authorization) {
      const t = lookup(opts.authFallback);
      if (t) {
        headers.authorization = 'Bearer ' + t;
        warnings.push(`auth added by --auth-fallback ${opts.authFallback} (the collection sends this request with No Auth)`);
      }
    }

    let body;
    let bodyDisplay;
    const b = r.body;
    const canHaveBody = !['GET', 'HEAD'].includes(r.method);
    if (b && canHaveBody) {
      if (b.mode === 'raw') {
        const lang = (b.options && b.options.raw && b.options.raw.language) || '';
        let t = b.raw || '';
        const jsonish = lang === 'json' || /^\s*[{[]/.test(t);
        if (jsonish) {
          t = t.replace(/"\{\{\s*([^{}]+?)\s*\}\}"/g, (w, n) => {
            if (L.isJunkVar(n)) return w;
            const v = valueOf(n);
            if (v === undefined || v === null || v === '') return (missing.add(n), w);
            return JSON.stringify(v);
          });
          t = t.replace(L.VAR_RE, (w, n) => {
            if (L.isJunkVar(n)) return w;
            const v = valueOf(n);
            if (v === undefined || v === null || v === '') return (missing.add(n), w);
            return typeof v === 'string' ? JSON.stringify(v).slice(1, -1) : String(v);
          });
          let parsed;
          try {
            parsed = JSON.parse(t);
          } catch {
            if (t.trim()) warnings.push('request body is not valid JSON after variable substitution');
          }
          if (parsed !== undefined) {
            for (const [k, v] of Object.entries(ov.body || {})) L.setPath(parsed, k, v);
            t = JSON.stringify(parsed);
          }
        } else {
          t = sub(t);
        }
        if (t.trim()) {
          body = t;
          bodyDisplay = t;
          if (!headers['content-type'] && jsonish) headers['content-type'] = 'application/json';
        }
      } else if (b.mode === 'urlencoded') {
        const p = new URLSearchParams();
        for (const f of (b.urlencoded || []).filter((x) => !x.disabled)) p.append(f.key, sub(f.value));
        body = p.toString();
        bodyDisplay = body;
        headers['content-type'] = headers['content-type'] || 'application/x-www-form-urlencoded';
      } else if (b.mode === 'formdata') {
        const fd = new FormData();
        for (const f of (b.formdata || []).filter((x) => !x.disabled)) {
          if (f.type === 'file') {
            const fp = (ov.files || {})[f.key];
            if (!fp || !fs.existsSync(fp)) {
              missing.add(`file:${f.key}`);
              continue;
            }
            fd.append(f.key, new Blob([fs.readFileSync(fp)]), path.basename(fp));
          } else fd.append(f.key, sub(f.value));
        }
        body = fd;
        bodyDisplay = '[multipart form-data]';
        delete headers['content-type'];
      }
    }
    if (a.type === 'apikey' && a.in === 'query') {
      const k = sub(a.key);
      const v = sub(a.value);
      if (!/\{\{/.test(k + v)) return { missing, warnings, derived, url: url + (url.includes('?') ? '&' : '?') + `${encodeURIComponent(k)}=${encodeURIComponent(v)}`, headers, body, bodyDisplay };
    }
    return { missing, warnings, derived, url, headers, body, bodyDisplay };
  }

  function gate(r, hostname) {
    if (r.tokenEndpoint && r.body && String(r.body.raw || '').trim()) return null; // fetching a token is not a data write
    if (r.kind !== 'read') {
      if (opts.mode !== 'full') return 'blocked: write request in read-only mode (use --mode full on a test environment)';
      if (!opts.confirmHosts.includes(hostname.toLowerCase())) return `blocked: writes require --confirm-host ${hostname}`;
      if (L.looksLikeProduction(hostname) && !opts.allowProd) return `blocked: ${hostname} looks like a production host (add --allow-production-writes only if that is intended)`;
      if (r.kind === 'destructive' && !opts.allowDestructive) return 'blocked: destructive request needs --allow-destructive';
    }
    if (r.sensitive && !opts.allowSensitive) return 'blocked: may send email/SMS/OTP — needs --allow-sensitive';
    return null;
  }

  async function send(b, method) {
    const t0 = performance.now();
    try {
      const res = await fetch(b.url, { method, headers: b.headers, body: ['GET', 'HEAD'].includes(method) ? undefined : b.body, signal: AbortSignal.timeout(opts.timeout) });
      const text = await res.text();
      return { status: res.status, ms: Math.round(performance.now() - t0), text, contentType: res.headers.get('content-type') || '' };
    } catch (e) {
      const timedOut = e.name === 'TimeoutError' || e.name === 'AbortError';
      return { error: timedOut ? `timeout after ${opts.timeout}ms` : String((e.cause && (e.cause.code || e.cause.message)) || e.message), ms: Math.round(performance.now() - t0) };
    }
  }

  function validate(r, res) {
    const checks = [];
    const issues = [];
    const code = res.status;
    const exp = r.expected;
    const errOnly = exp.codes.length && exp.codes.every((c) => c < 200 || c >= 300);
    const ok = errOnly ? exp.codes.includes(code) : code >= 200 && code < 300;
    checks.push({ name: 'status', level: ok ? 'pass' : 'fail', message: `HTTP ${code}${exp.codes.length ? ` (expected ${exp.codes.join('/')}${exp.source === 'example' ? ', from saved example' : ''})` : ' (expected 2xx)'}` });
    let json;
    try {
      json = res.text.trim() ? JSON.parse(res.text) : undefined;
    } catch {
      json = undefined;
    }
    if (!ok) {
      const cat = category(code, res);
      issues.push({ category: cat, level: 'fail', message: `Unexpected HTTP ${code}`, hint: hintFor(cat, r) });
      return { checks, issues, json };
    }
    if (exp.source === 'example' && exp.codes.length && !exp.codes.includes(code)) {
      checks.push({ name: 'status-differs', level: 'warn', message: `HTTP ${code} differs from documented ${exp.codes.join('/')}` });
      issues.push({ category: 'status-differs', level: 'warn', message: `Got ${code}, saved examples document ${exp.codes.join('/')}` });
    }
    if (r.shape && opts.schema !== 'off' && code !== 204) {
      if (json === undefined) {
        const m = res.text.trim() ? 'Response is not valid JSON' : 'Response body is empty but a saved example has a payload';
        const level = res.text.trim() ? 'fail' : 'warn';
        checks.push({ name: 'payload', level, message: m });
        issues.push({ category: 'schema-mismatch', level, message: m });
      } else {
        const diffs = L.compareShape(r.shape, json, opts.schema);
        if (!diffs.length) checks.push({ name: 'payload', level: 'pass', message: 'Matches saved example shape' });
        for (const d of diffs.slice(0, 12)) {
          const msg = d.kind === 'missing' ? `Field "${d.path}" missing (example has ${d.expected})` : `Field "${d.path}" is ${d.actual}, example has ${d.expected}`;
          checks.push({ name: 'payload', level: d.level, message: msg });
          issues.push({ category: 'schema-mismatch', level: d.level, message: msg });
        }
        if (diffs.length > 12) checks.push({ name: 'payload', level: 'info', message: `…and ${diffs.length - 12} more differences` });
      }
    }
    if (json && typeof json === 'object' && !Array.isArray(json)) {
      const failing = json.success === false || (typeof json.status === 'string' && /^(error|fail|failed)$/i.test(json.status)) || (json.error && json.success !== true);
      if (failing) {
        checks.push({ name: 'envelope', level: 'warn', message: 'HTTP 2xx but body signals an error (success:false / status:error / error field)' });
        issues.push({ category: 'error-in-2xx', level: 'warn', message: 'HTTP 2xx but the body signals an error' });
      }
    }
    if (res.ms > opts.slow) {
      checks.push({ name: 'time', level: 'warn', message: `Slow response: ${res.ms}ms (threshold ${opts.slow}ms)` });
      issues.push({ category: 'slow', level: 'warn', message: `${res.ms}ms exceeds ${opts.slow}ms` });
    }
    return { checks, issues, json };
  }

  function capture(r, json) {
    const got = [];
    if (json === undefined || json === null) return got;
    for (const p of r.explicitProduces) {
      const v = L.getPath(json, p.path);
      if (v !== undefined && v !== null && typeof v !== 'object') {
        vars[p.var] = String(v);
        origin[p.var] = `captured from ${r.path}`;
        got.push({ var: p.var, how: 'script' });
      }
    }
    for (const p of r.inferredProduces) {
      if (lookup(p.var) !== undefined) continue;
      const v = L.pickId(json, L.idNoun(p.var));
      if (v !== undefined) {
        vars[p.var] = String(v);
        origin[p.var] = `inferred from ${r.path}`;
        got.push({ var: p.var, how: 'inferred' });
      }
    }
    return got;
  }

  // ── main loop ────────────────────────────────────────────────────────────
  const started = new Date();
  const results = [];
  const selected = (r) => !opts.only.length || opts.only.some((o) => r.path.toLowerCase().includes(o));
  const icon = { PASS: 'ok  ', WARN: 'warn', FAIL: 'FAIL', ERROR: 'ERR ', SKIPPED: 'skip' };

  for (const id of plan.order) {
    const r = byId.get(id);
    if (!r || !selected(r)) continue;
    const rec = { id: r.id, path: r.path, folder: r.folder, name: r.name, method: r.method, kind: r.kind, sensitive: r.sensitive, expected: r.expected.codes, needs: r.needs, status: 'SKIPPED', checks: [], issues: [], captured: [] };
    const finish = (status, extra = {}) => {
      Object.assign(rec, { status }, extra);
      done.set(r.id, rec);
      results.push(rec);
      const tail = rec.skipReason ? `— ${rec.skipReason}` : rec.httpStatus ? `${rec.httpStatus} ${rec.ms}ms` : rec.error || '';
      process.stdout.write(`  ${icon[status]}  ${r.id} ${r.method.padEnd(6)} ${r.path.slice(0, 70)} ${tail}\n`);
    };

    if (r.tokenEndpoint && !(r.body && String(r.body.raw || '').trim())) {
      finish('SKIPPED', { skipReason: 'token endpoint with no credentials in the collection — configure "tokenRequests" in inputs.json', skipKind: 'token-endpoint' });
      continue;
    }

    if (!String(r.urlRaw || '').trim()) {
      finish('SKIPPED', { skipReason: 'request has no URL in the collection', skipKind: 'invalid-request' });
      continue;
    }

    const b = build(r);
    rec.warnings = b.warnings;
    const hostname = hostnameOf(b.url);
    rec.host = hostname || undefined;

    // missing inputs vs unmet dependencies
    if (b.missing.size) {
      const unmet = [];
      const trulyMissing = [];
      for (const v of b.missing) {
        const nm = aliases[v] || v;
        const ps = producers[nm];
        if (ps && ps.length) {
          const states = ps.map((p) => done.get(p)).filter(Boolean);
          const why = states.length ? states.map((s) => `"${s.path}" ${s.status}${s.skipReason ? ` (${s.skipReason.split(' — ')[0].replace(/^blocked: /, '')})` : ''}`).join('; ') : 'producer did not run';
          unmet.push(`{{${nm}}} ← ${why}`);
        } else trulyMissing.push(v.startsWith(':') || v.startsWith('file:') ? v : `{{${nm}}}`);
      }
      if (unmet.length) {
        finish('SKIPPED', { skipReason: `dependency not met: ${unmet.join(' | ')}`, skipKind: 'dependency', missing: [...b.missing] });
      } else {
        finish('SKIPPED', { skipReason: `missing input: ${trulyMissing.join(', ')}`, skipKind: 'missing-input', missing: [...b.missing] });
      }
      continue;
    }

    if (!trusted.has((hostname || '').toLowerCase()) && carriesCredentials(b, secretVals)) {
      finish('SKIPPED', { skipReason: untrustedMessage(hostname), skipKind: 'untrusted-host' });
      continue;
    }

    const blocked = gate(r, hostname);
    if (blocked) {
      finish('SKIPPED', { skipReason: blocked, skipKind: 'blocked' });
      continue;
    }
    if (opts.dryRun) {
      if (b.derived.size) {
        finish('SKIPPED', { skipReason: `dry-run: would send only if ${[...b.derived].map((d) => `{{${d}}}`).join(', ')} is produced by an upstream request`, skipKind: 'dry-run-dependent' });
      } else {
        finish('SKIPPED', { skipReason: 'dry-run: would send', skipKind: 'dry-run' });
      }
      continue;
    }

    let res = await send(b, r.method);
    if (res.status === 401) {
      const tokVar = r.needs.find((v) => loaded.tokenRequests[v]);
      if (tokVar && (await fetchToken(tokVar))) {
        const b2 = build(r);
        if (!b2.missing.size) {
          Object.assign(b, b2);
          res = await send(b, r.method);
        }
      }
    }
    res.authSent = !!b.headers.authorization || r.auth.type === 'apikey';
    const rd = red();
    rec.url = maskUrl(b.url, rd);
    rec.requestHeaders = Object.fromEntries(Object.entries(b.headers).map(([k, v]) => [k, /authorization|key|token|cookie/i.test(k) ? '***' : rd.maskString(String(v))]));

    if (res.error) {
      finish('ERROR', { ms: res.ms, error: res.error, issues: [{ category: 'network', level: 'fail', message: res.error, hint: res.error.startsWith('timeout') ? 'Raise --timeout or check the service is up.' : 'Check {{host}} is reachable from this machine (VPN / DNS / TLS).' }], checks: [{ name: 'request', level: 'fail', message: res.error }] });
      if (opts.delay) await sleep(opts.delay);
      continue;
    }

    const v = validate(r, res);
    const hasFail = v.checks.some((c) => c.level === 'fail');
    const hasWarn = v.checks.some((c) => c.level === 'warn');
    const status = hasFail ? 'FAIL' : hasWarn ? 'WARN' : 'PASS';
    const captured = !hasFail ? capture(r, v.json) : [];
    const showBodies = opts.bodies === 'all' || (opts.bodies === 'failures' && status !== 'PASS');
    const extra = { httpStatus: res.status, ms: res.ms, checks: v.checks, issues: v.issues, captured, contentType: res.contentType, bytes: res.text.length };
    if (showBodies && opts.bodies !== 'none') {
      extra.response = snippetOf(res.text, v.json, rd);
      if (b.bodyDisplay) extra.request = snippetOf(b.bodyDisplay, tryJson(b.bodyDisplay), rd);
    }
    finish(status, extra);
    if (opts.delay) await sleep(opts.delay);
  }

  // ── output ───────────────────────────────────────────────────────────────
  const counts = results.reduce((m, r) => ((m[r.status] = (m[r.status] || 0) + 1), m), {});
  const hostnames = [...new Set(results.map((r) => r.host).filter(Boolean))];
  const finished = new Date();
  const doc = {
    meta: {
      collection: plan.meta.collection,
      startedAt: started.toISOString(),
      finishedAt: finished.toISOString(),
      durationMs: finished - started,
      mode: opts.mode,
      dryRun: opts.dryRun,
      hosts: hostnames,
      schema: opts.schema,
      allowDestructive: opts.allowDestructive,
      allowSensitive: opts.allowSensitive,
      counts: { total: results.length, PASS: 0, WARN: 0, FAIL: 0, ERROR: 0, SKIPPED: 0, ...counts },
      node: process.version,
    },
    authFetch,
    inputs: {
      provided: plan.inputs.filter((i) => lookup(i.name) !== undefined).map((i) => ({ name: i.name, source: origin[i.name] || origin[aliases[i.name]] || 'unknown' })),
      missing: plan.inputs.filter((i) => lookup(i.name) === undefined && !producers[i.name]).map((i) => i.name),
    },
    lint: plan.lint,
    results,
  };
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(doc, null, 2));
  const { generate } = require('./report');
  const files = generate(doc, out);
  const c = doc.meta.counts;
  console.log(`\n${c.total} requests: ${c.PASS} passed, ${c.WARN} warnings, ${c.FAIL} failed, ${c.ERROR} errors, ${c.SKIPPED} skipped (${(doc.meta.durationMs / 1000).toFixed(1)}s)`);
  if (opts.dryRun) {
    const n = (k) => results.filter((x) => x.skipKind === k).length;
    console.log(`Dry run: would send now: ${n('dry-run')} | would send only if upstream calls succeed: ${n('dry-run-dependent')} | blocked: ${n('blocked')} | missing input: ${n('missing-input')} | invalid: ${n('invalid-request')}`);
  }
  console.log(`Report: ${files.html}\nData:   ${path.join(out, 'results.json')}`);
  if (!args['no-fail-exit'] && (c.FAIL || c.ERROR)) process.exitCode = 1;
}

function tryJson(t) {
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

function snippetOf(text, json, red) {
  if (json !== undefined && json !== null && typeof json === 'object') return L.snippet(JSON.stringify(red.maskDeep(json), null, 1));
  return L.snippet(red.maskString(String(text)));
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(2);
  });
}
module.exports = { category, hintFor, maskUrl, trustedHostsOf, carriesCredentials, untrustedMessage };
