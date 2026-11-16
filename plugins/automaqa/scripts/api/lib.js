'use strict';
/**
 * Shared helpers for the api-collection-test skill.
 *
 * Zero dependencies — Node 18+ only (global fetch). Everything here is pure
 * (no network, no filesystem writes) so analyze.js, run.js and report.js can share it
 * and the unit tests can exercise it directly.
 */

const fs = require('fs');

// ── Variables ───────────────────────────────────────────────────────────────

const VAR_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

/** `{{response.status}}`, `{{JSON.stringify(x)}}` are template leftovers, not inputs. */
function isJunkVar(name) {
  return /[.()[\]\s]/.test(name);
}

function isDynamicVar(name) {
  return name.startsWith('$');
}

function varsIn(str) {
  const out = new Set();
  if (typeof str !== 'string') return out;
  for (const m of str.matchAll(VAR_RE)) {
    if (!isJunkVar(m[1])) out.add(m[1]);
  }
  return out;
}

/** Postman dynamic variables we can honour. Anything else stays unresolved. */
function dynamicValue(name) {
  const rnd = (n) => Math.floor(Math.random() * n);
  switch (name) {
    case '$guid':
    case '$randomUUID':
      return require('crypto').randomUUID();
    case '$timestamp':
      return String(Math.floor(Date.now() / 1000));
    case '$isoTimestamp':
      return new Date().toISOString();
    case '$randomInt':
      return String(rnd(1000));
    case '$randomEmail':
      return `automaqa.${Date.now()}.${rnd(1e6)}@example.com`;
    case '$randomFirstName':
      return 'Automaqa';
    case '$randomLastName':
      return 'Tester';
    case '$randomAlphaNumeric':
      return Math.random().toString(36).slice(2, 3);
    default:
      return undefined;
  }
}

/**
 * Replace {{vars}} using `lookup(name) -> value|undefined`. Unresolved names are added
 * to `missing` and left in place. Values are stringified.
 */
function substitute(str, lookup, missing) {
  if (typeof str !== 'string') return str;
  return str.replace(VAR_RE, (whole, name) => {
    if (isJunkVar(name)) return whole;
    const v = isDynamicVar(name) ? dynamicValue(name) : lookup(name);
    if (v === undefined || v === null || v === '') {
      missing.add(name);
      return whole;
    }
    return String(v);
  });
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[m][n];
}

/**
 * Suggest a typo fix: a *much more frequently used* variable that is within 2 edits, or
 * the same name with `-` / `_` swapped. `counts` is a Map(name -> usage count).
 */
function suggestAlias(name, counts) {
  const mine = counts.get(name) || 0;
  const norm = (s) => s.replace(/-/g, '_').toLowerCase();
  let best = null;
  for (const [other, c] of counts) {
    if (other === name || isDynamicVar(other)) continue;
    if (norm(other) === norm(name)) {
      if (!best || c > best.count) best = { to: other, count: c, why: 'separator' };
      continue;
    }
    if (name.length < 5 || c < Math.max(2, mine * 2)) continue;
    const d = levenshtein(name.toLowerCase(), other.toLowerCase());
    if (d <= 2 && (!best || d < best.dist || (d === best.dist && c > best.count))) {
      best = { to: other, count: c, dist: d, why: 'typo' };
    }
  }
  return best;
}

// ── Collection flattening ──────────────────────────────────────────────────

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

function execText(ev) {
  const e = ev && ev.script && ev.script.exec;
  return Array.isArray(e) ? e.join('\n') : typeof e === 'string' ? e : '';
}

function normalizeAuth(a) {
  if (!a || a.type === 'noauth') return { type: 'none' };
  const kv = (arr) => Object.fromEntries((arr || []).map((x) => [x.key, x.value]));
  if (a.type === 'bearer') return { type: 'bearer', token: kv(a.bearer).token || '' };
  if (a.type === 'basic') {
    const b = kv(a.basic);
    return { type: 'basic', username: b.username || '', password: b.password || '' };
  }
  if (a.type === 'apikey') {
    const k = kv(a.apikey);
    return { type: 'apikey', key: k.key || '', value: k.value || '', in: k.in || 'header' };
  }
  return { type: 'unsupported', original: a.type };
}

/** Flatten a Postman v2.x collection into request records (auth inheritance resolved). */
function flatten(col) {
  const out = [];
  const walk = (items, trail, inheritedAuth) => {
    for (const it of items || []) {
      if (it.item) {
        walk(it.item, trail.concat(it.name), it.auth !== undefined ? it.auth : inheritedAuth);
        continue;
      }
      let rq = it.request;
      if (typeof rq === 'string') rq = { method: 'GET', url: rq };
      if (!rq) continue;
      const url = rq.url;
      const urlObj = typeof url === 'string' || !url ? { raw: url || '' } : url;
      let raw = urlObj.raw;
      if (!raw && urlObj.host) {
        raw = [urlObj.protocol ? urlObj.protocol + '://' : '', [].concat(urlObj.host).join('.'), '/', [].concat(urlObj.path || []).join('/')].join('');
      }
      raw = raw || '';
      const query = Array.isArray(urlObj.query)
        ? urlObj.query.filter((q) => q && q.key && !q.disabled).map((q) => ({ key: q.key, value: q.value == null ? '' : String(q.value) }))
        : parseQuery(raw);
      const body = rq.body && rq.body.mode ? rq.body : null;
      out.push({
        id: 'r' + String(out.length + 1).padStart(3, '0'),
        index: out.length,
        folder: trail.join(' / '),
        name: it.name,
        path: trail.concat(it.name).join(' / '),
        method: String(rq.method || 'GET').toUpperCase(),
        urlRaw: raw,
        query,
        pathVars: (urlObj.variable || []).filter((v) => v && v.key).map((v) => ({ key: v.key, value: v.value == null ? '' : String(v.value) })),
        headers: (rq.header || []).filter((h) => h && h.key && !h.disabled).map((h) => ({ key: h.key, value: String(h.value == null ? '' : h.value) })),
        body,
        auth: normalizeAuth(rq.auth !== undefined ? rq.auth : inheritedAuth),
        scripts: (it.event || []).filter((e) => e.listen === 'test').map(execText),
        examples: (it.response || []).map((r) => ({ name: r.name, code: r.code, body: r.body })),
      });
    }
  };
  walk(col.item, [], col.auth);
  return out;
}

function parseQuery(raw) {
  const i = raw.indexOf('?');
  if (i < 0) return [];
  return raw
    .slice(i + 1)
    .split('#')[0]
    .split('&')
    .filter(Boolean)
    .map((p) => {
      const j = p.indexOf('=');
      return j < 0 ? { key: p, value: '' } : { key: p.slice(0, j), value: p.slice(j + 1) };
    });
}

/** All {{vars}} a request needs (url, query, path vars, headers, body, auth). */
function requestVars(r) {
  const s = new Set();
  const add = (x) => varsIn(x).forEach((v) => s.add(v));
  add(r.urlRaw.split('?')[0]);
  r.query.forEach((q) => (add(q.key), add(q.value)));
  r.pathVars.forEach((p) => add(p.value));
  r.headers.forEach((h) => add(h.value));
  if (r.body) {
    if (r.body.mode === 'raw') add(r.body.raw);
    for (const k of ['urlencoded', 'formdata']) {
      (r.body[k] || []).filter((f) => !f.disabled).forEach((f) => (add(f.key), add(f.value)));
    }
  }
  if (r.auth.type === 'bearer') add(r.auth.token);
  if (r.auth.type === 'basic') (add(r.auth.username), add(r.auth.password));
  if (r.auth.type === 'apikey') (add(r.auth.key), add(r.auth.value));
  return s;
}

// ── Classification ──────────────────────────────────────────────────────────

const SENSITIVE_GET = /otp|invit|send|remind|notif|trigger/i;
const SENSITIVE_ANY = /otp|invit|notif|remind|e-?mail|sms|phone|password|send|zoom|webhook|payment|charge|billing|publish|signature|sign-?up/i;
const DESTRUCTIVE_NAME = /\b(delete|remove|purge|destroy|deactivate|cancel)\b/i;
const TOKEN_ENDPOINT = /oauth\/token|\/token\/?$|\/login\/?$|\/authenticate\/?$/i;

function classify(r) {
  const urlPath = r.urlRaw.split('?')[0];
  const reasons = [];
  let kind = 'read';
  let phase = 0;
  if (r.method === 'DELETE') {
    kind = 'destructive';
    phase = 3;
    reasons.push('DELETE method');
  } else if (['POST', 'PUT', 'PATCH'].includes(r.method)) {
    kind = 'write';
    phase = r.method === 'POST' ? 1 : 2;
    if (DESTRUCTIVE_NAME.test(r.name) || DESTRUCTIVE_NAME.test(urlPath)) {
      kind = 'destructive';
      phase = 3;
      reasons.push('name/URL suggests deletion');
    }
  } else if (!['GET', 'HEAD', 'OPTIONS'].includes(r.method)) {
    kind = 'write';
    phase = 2;
  }
  const hay = r.name + ' ' + urlPath;
  const sensitive = r.method === 'GET' ? SENSITIVE_GET.test(hay) : SENSITIVE_ANY.test(hay);
  if (sensitive) reasons.push('may send email/SMS/OTP or trigger an external side effect');
  const tokenEndpoint = r.method === 'POST' && TOKEN_ENDPOINT.test(urlPath);
  return { kind, phase, sensitive, tokenEndpoint, reasons };
}

// ── Producers (what sets a variable) ───────────────────────────────────────

/** Parse `pm.environment.set('x', response.id)` style captures out of test scripts. */
function explicitProducers(r) {
  const out = [];
  const re = /pm\.(?:environment|collectionVariables|globals|variables)\.set\(\s*['"]([^'"]+)['"]\s*,\s*([^;\n]+?)\)\s*;?\s*(?:\n|$|\})/g;
  for (const script of r.scripts) {
    for (const m of script.matchAll(re)) {
      const expr = m[2];
      const p = expr.match(/(?:response|jsonData|json|data|body|res|pm\.response\.json\(\))((?:\.[A-Za-z_$][\w$]*|\[\d+\]|\['[^']+'\])+)/);
      if (!p) continue;
      const parts = [...p[1].matchAll(/\.([A-Za-z_$][\w$]*)|\[(\d+)\]|\['([^']+)'\]/g)].map((x) => (x[2] !== undefined ? Number(x[2]) : x[1] || x[3]));
      out.push({ var: m[1], path: parts });
    }
  }
  return out;
}

function singular(s) {
  return s.replace(/ies$/, 'y').replace(/(ss|us)es$/, '$1').replace(/s$/, '');
}

/** Last literal path segment and whether the URL *ends* there (i.e. a collection endpoint). */
function endpointShape(r) {
  const segs = r.urlRaw.split('?')[0].split('/').filter(Boolean);
  const last = segs[segs.length - 1] || '';
  const endsWithVar = /^\{\{|^:/.test(last);
  const literal = segs.filter((s) => !/^\{\{|^:|^https?:/.test(s));
  return { last: endsWithVar ? null : last, literal };
}

/** Which variable names look like ids ("appointment_id" -> noun "appointment")? */
function idNoun(varName) {
  const m = varName.match(/^(.*?)(?:[_-]?id|Id)$/);
  if (!m || !m[1]) return null;
  const parts = m[1].split(/[_-]|(?=[A-Z])/).filter(Boolean);
  return parts.length ? parts[parts.length - 1].toLowerCase() : null;
}

function getPath(obj, parts) {
  let cur = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[p];
  }
  return cur;
}

/** Best-effort id extraction from a create/list response, used for *inferred* captures. */
function pickId(body, noun) {
  if (!body || typeof body !== 'object') return undefined;
  const keys = ['id', `${noun}_id`, `${noun}Id`, 'uuid'];
  const roots = [body, body.data, body.result, body.payload];
  const tryObj = (o) => {
    if (Array.isArray(o)) o = o[0];
    if (!o || typeof o !== 'object') return undefined;
    for (const k of keys) if (typeof o[k] === 'string' || typeof o[k] === 'number') return o[k];
    return undefined;
  };
  for (const r of roots) {
    const direct = tryObj(r);
    if (direct !== undefined) return direct;
    if (r && typeof r === 'object') {
      for (const sub of ['items', 'results', 'records', 'rows', 'data']) {
        if (Array.isArray(r[sub])) {
          const v = tryObj(r[sub]);
          if (v !== undefined) return v;
        }
      }
    }
  }
  return undefined;
}

// ── Response shapes ─────────────────────────────────────────────────────────

function inferShape(v, depth = 0) {
  if (v === null) return { t: 'null' };
  if (Array.isArray(v)) return { t: 'array', item: v.length && depth < 6 ? inferShape(v[0], depth + 1) : null };
  if (typeof v === 'object') {
    const props = {};
    if (depth < 6) for (const [k, x] of Object.entries(v)) props[k] = inferShape(x, depth + 1);
    return { t: 'object', props };
  }
  return { t: typeof v };
}

/**
 * Compare actual JSON against an example shape. Returns issues
 * [{path, kind: 'missing'|'type', expected, actual, level: 'fail'|'warn'}].
 * mode: balanced (default: depth<=2 fails, deeper warns) | strict | lenient.
 */
function compareShape(exp, actual, mode = 'balanced') {
  const issues = [];
  const level = (depth) => (mode === 'strict' ? 'fail' : mode === 'lenient' ? 'warn' : depth <= 2 ? 'fail' : 'warn');
  const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
  const walk = (e, a, path, depth) => {
    if (!e || e.t === 'null' || a === null || a === undefined) return;
    const at = typeOf(a);
    if (e.t !== at) {
      issues.push({ path: path || '$', kind: 'type', expected: e.t, actual: at, level: level(depth) });
      return;
    }
    if (e.t === 'object') {
      for (const [k, sub] of Object.entries(e.props)) {
        if (!(k in a)) issues.push({ path: `${path}.${k}`.replace(/^\./, ''), kind: 'missing', expected: sub.t, actual: 'absent', level: level(depth + 1) });
        else walk(sub, a[k], `${path}.${k}`.replace(/^\./, ''), depth + 1);
      }
    } else if (e.t === 'array' && e.item && a.length) {
      walk(e.item, a[0], `${path}[0]`, depth + 1);
    }
  };
  walk(exp, actual, '', 0);
  return issues;
}

// ── Redaction ───────────────────────────────────────────────────────────────

const JWT_RE = /eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{3,}/g;

// Decode a JWT payload (no signature check). Returns null when it is not a decodable JWT.
function jwtPayload(token) {
  try {
    return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}
// Normalised (lower-case, alphanumerics only) key fragments that hold secrets or PHI/PII.
const SENSITIVE_KEY = /(email|phone|mobile|firstname|lastname|fullname|patientname|dob|dateofbirth|birth|address|street|zip|postal|ssn|mrn|insurance|password|passcode|secret|token|authorization|apikey|otp)|^pin$/;

function makeRedactor(secretValues) {
  const secrets = [...new Set((secretValues || []).filter((s) => typeof s === 'string' && s.length >= 6))].sort((a, b) => b.length - a.length);
  const maskString = (s) => {
    let out = s.replace(JWT_RE, '***jwt***').replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1***');
    for (const sec of secrets) if (out.includes(sec)) out = out.split(sec).join('***');
    return out;
  };
  const maskDeep = (v, key = '') => {
    const nk = String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (nk && SENSITIVE_KEY.test(nk) && v !== null && typeof v !== 'object') return '***';
    if (typeof v === 'string') return maskString(v);
    if (Array.isArray(v)) return v.map((x) => maskDeep(x, key));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskDeep(x, k)]));
    return v;
  };
  return { maskString, maskDeep };
}

/** Truncate a (redacted) body for display. */
function snippet(text, max = 1200) {
  if (typeof text !== 'string') return text;
  return text.length > max ? text.slice(0, max) + `… [+${text.length - max} chars]` : text;
}

// ── Safety ──────────────────────────────────────────────────────────────────

const NON_PROD_LABEL = /(^|[.-])(staging|stage|stg|dev|develop|test|testing|qa|uat|sandbox|preview|demo|local|localhost|internal)([.-]|$)/i;

function looksLikeProduction(hostname) {
  if (!hostname) return true;
  if (/^(127\.|10\.|192\.168\.|::1$|\[::1\]$)/.test(hostname) || hostname === 'localhost') return false;
  return !NON_PROD_LABEL.test(hostname);
}

function setPath(obj, dotted, value) {
  const parts = dotted.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] === undefined || cur[parts[i]] === null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

module.exports = {
  VAR_RE, isJunkVar, isDynamicVar, varsIn, dynamicValue, substitute, levenshtein, suggestAlias,
  readJson, flatten, requestVars, parseQuery, classify, explicitProducers, endpointShape, idNoun, singular,
  getPath, pickId, inferShape, compareShape, makeRedactor, snippet, JWT_RE, looksLikeProduction, setPath, jwtPayload,
};
