// TOON (Token-Oriented Object Notation) reader + writer — the subset the AutomaQA reference documents use.
//   stringify(obj) -> text      parse(text) -> obj
// Shapes: key: scalar | key: (nested object) | key[N]: a,b,c (primitive array) |
//         key[N]{c1,c2}: + N comma rows (uniform array of flat objects) | key[N]: + "- " items (any other array).
// Verified by selftest against a real TOON file (round trip) — see selftest.js.

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const isPrim = v => v === null || ['string', 'number', 'boolean'].includes(typeof v);

function quote(s) { return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"'; }
function fmt(v, delim = ',') {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v);
  const needs = s === '' || /^\s|\s$/.test(s) || s.includes(delim) || /[:"\\\n\[\]{}]/.test(s) || /^(true|false|null)$/i.test(s) || /^-?\d/.test(s) || /^- /.test(s) || s.startsWith('#');
  return needs ? quote(s) : s;
}
const key = k => (IDENT.test(k) ? k : quote(k));

function uniformFlat(arr) {
  if (!arr.length || !arr.every(o => o && typeof o === 'object' && !Array.isArray(o))) return null;
  const keys = Object.keys(arr[0]);
  if (!keys.length) return null;
  for (const o of arr) { const k = Object.keys(o); if (k.length !== keys.length || k.some((x, i) => x !== keys[i]) || !k.every(x => isPrim(o[x]))) return null; }
  return keys;
}

function emit(k, v, lvl, out) {
  const pad = '  '.repeat(lvl);
  if (Array.isArray(v)) {
    if (!v.length) { out.push(`${pad}${key(k)}[0]:`); return; }
    if (v.every(isPrim)) { out.push(`${pad}${key(k)}[${v.length}]: ${v.map(x => fmt(x)).join(',')}`); return; }
    const cols = uniformFlat(v);
    if (cols) { out.push(`${pad}${key(k)}[${v.length}]{${cols.join(',')}}:`); for (const o of v) out.push(`${pad}  ${cols.map(c => fmt(o[c])).join(',')}`); return; }
    out.push(`${pad}${key(k)}[${v.length}]:`);
    for (const item of v) {
      if (isPrim(item)) { out.push(`${pad}  - ${fmt(item)}`); continue; }
      const tmp = []; const ks = Object.keys(item);
      ks.forEach(kk => emit(kk, item[kk], lvl + 2, tmp));
      if (!tmp.length) { out.push(`${pad}  -`); continue; }
      tmp[0] = `${pad}  - ` + tmp[0].slice((lvl + 2) * 2); out.push(...tmp);
    }
    return;
  }
  if (v && typeof v === 'object') { out.push(`${pad}${key(k)}:`); for (const kk of Object.keys(v)) emit(kk, v[kk], lvl + 1, out); return; }
  out.push(`${pad}${key(k)}: ${fmt(v)}`);
}
function stringify(obj) { const out = []; for (const k of Object.keys(obj)) emit(k, obj[k], 0, out); return out.join('\n') + '\n'; }

// ---------- parser ----------
function splitRow(s) {
  const cells = []; let cur = '', q = false, wasQ = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '\\' && i + 1 < s.length) { const n = s[++i]; cur += n === 'n' ? '\n' : n; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"' && cur === '') { q = true; wasQ = true; }
    else if (c === ',') { cells.push({ v: cur, q: wasQ }); cur = ''; wasQ = false; }
    else cur += c;
  }
  cells.push({ v: cur, q: wasQ }); return cells;
}
function scalar(cell) {
  if (cell.q) return cell.v;
  const t = cell.v.trim();
  if (t === 'null') return null; if (t === 'true') return true; if (t === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return t;
}
const parseScalar = s => scalar(splitRow(s.trim())[0] || { v: '', q: false });
const indentOf = l => { let n = 0; while (l[n] === ' ') n++; return n / 2; };
const HEAD = /^("(?:[^"\\]|\\.)*"|[^:\[\]{}"]+?)(?:\[(\d+)\](?:\{([^}]*)\})?)?:(?:\s+(.*))?$/;

function parse(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim() !== '');
  const [obj] = block(lines, 0, 0); return obj;
}
function block(lines, i, lvl) {
  const obj = {};
  while (i < lines.length && indentOf(lines[i]) === lvl && !lines[i].trim().startsWith('- ')) {
    const m = lines[i].trim().match(HEAD); if (!m) throw new Error('TOON parse error at line: ' + lines[i].slice(0, 80));
    const k = m[1].startsWith('"') ? parseScalar(m[1]) : m[1].trim(); const n = m[2], cols = m[3], rest = m[4];
    i++;
    if (n !== undefined) {
      const count = Number(n);
      if (cols !== undefined) {
        const names = cols.split(',').map(s => s.trim()); const rows = [];
        for (let r = 0; r < count; r++, i++) { const cells = splitRow(lines[i].trim()); const o = {}; names.forEach((c, x) => { o[c] = cells[x] ? scalar(cells[x]) : null; }); rows.push(o); }
        obj[k] = rows;
      } else if (rest !== undefined && rest !== '') obj[k] = splitRow(rest).map(scalar);
      else if (count === 0) obj[k] = [];
      else {
        const items = [];
        while (i < lines.length && indentOf(lines[i]) === lvl + 1 && lines[i].trim().startsWith('-')) {
          const first = lines[i].trim().replace(/^-\s*/, ''); const body = [];
          if (first) body.push('  '.repeat(lvl + 2) + first);
          i++;
          while (i < lines.length && indentOf(lines[i]) >= lvl + 2) body.push(lines[i++]);
          if (body.length === 1 && !HEAD.test(first)) items.push(parseScalar(first));
          else items.push(block(body, 0, lvl + 2)[0]);
        }
        obj[k] = items;
      }
    } else if (rest !== undefined && rest !== '') obj[k] = parseScalar(rest);
    else if (i < lines.length && indentOf(lines[i]) > lvl) { const r = block(lines, i, lvl + 1); obj[k] = r[0]; i = r[1]; }
    else obj[k] = null;
  }
  return [obj, i];
}

module.exports = { stringify, parse };
