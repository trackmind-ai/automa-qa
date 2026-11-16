'use strict';
// Proves that saved tokens and auth headers are only sent to confirmed hosts.
//   node tests/api-host-pinning.test.js
// Starts two local HTTP servers on different hostnames (127.0.0.1 and localhost), runs the real
// analyze.js + run.js against a small collection, and checks what each server actually received.

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const api = path.join(__dirname, '..', 'plugins', 'automaqa', 'scripts', 'api');
const { trustedHostsOf, carriesCredentials } = require(path.join(api, 'run.js'));

const TOKEN = 'tok_SECRET_0123456789';

function server() {
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization || '' });
    res.setHeader('content-type', 'application/json');
    res.end('{"ok":true}');
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, seen, port: srv.address().port })));
}

const run = (script, args) =>
  new Promise((resolve) => execFile(process.execPath, [path.join(api, script), ...args], { timeout: 60000 }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr })));

const bearer = { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}', type: 'string' }] };
const get = (name, raw) => ({ name, request: { method: 'GET', auth: bearer, header: [], url: { raw } } });

async function scenario({ dir, hostPort, otherPort, collectionVars, inputs, extraArgs = [] }) {
  fs.mkdirSync(dir, { recursive: true });
  const collection = {
    info: { name: 'pinning', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    variable: collectionVars,
    item: [get('own host', '{{host}}/own'), get('other host', `http://localhost:${otherPort}/other`)],
  };
  const cfile = path.join(dir, 'c.postman_collection.json');
  const ifile = path.join(dir, 'inputs.json');
  fs.writeFileSync(cfile, JSON.stringify(collection));
  fs.writeFileSync(ifile, JSON.stringify(inputs));
  const a = await run('analyze.js', [cfile, '--out', dir, '--inputs', ifile]);
  assert.strictEqual(a.code, 0, 'analyze failed: ' + a.stderr);
  const r = await run('run.js', ['--out', dir, '--inputs', ifile, '--no-fail-exit', ...extraArgs]);
  assert.strictEqual(r.code, 0, 'run failed: ' + r.stderr);
  return JSON.parse(fs.readFileSync(path.join(dir, 'results.json'), 'utf8')).results;
}

(async () => {
  // ── unit checks ──────────────────────────────────────────────────────────
  const t1 = trustedHostsOf({ confirmHosts: ['Staging.Example.com'], values: { host: 'https://api.example.com/v1', token: 'x' }, origin: { host: 'inputs.json', token: 'inputs.json (secret)' } });
  assert.deepStrictEqual([...t1].sort(), ['api.example.com', 'staging.example.com']);
  const t2 = trustedHostsOf({ values: { host: 'https://evil.example' }, origin: { host: 'collection' } });
  assert.strictEqual(t2.size, 0, 'a base URL that only comes from the collection must not be trusted');
  assert.ok(carriesCredentials({ url: 'http://x/', headers: { authorization: 'Bearer a' } }, new Set()));
  assert.ok(carriesCredentials({ url: 'http://x/?k=' + TOKEN, headers: {} }, new Set([TOKEN])));
  assert.ok(!carriesCredentials({ url: 'http://x/', headers: { accept: 'application/json' } }, new Set([TOKEN])));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'automaqa-pin-'));
  const A = await server(); // the host the user confirmed
  const B = await server(); // an unrelated host named only inside the collection
  try {
    const inputs = { variables: { host: `http://127.0.0.1:${A.port}` }, secrets: { token: TOKEN } };

    // 1. The user gave {{host}}; a request to another host must not receive the token.
    let results = await scenario({ dir: path.join(tmp, 'one'), hostPort: A.port, otherPort: B.port, collectionVars: [], inputs });
    const own = results.find((x) => x.name === 'own host' || /own/.test(x.path));
    const other = results.find((x) => /other/.test(x.path));
    assert.strictEqual(own.status, 'PASS');
    assert.strictEqual(A.seen[0].authorization, 'Bearer ' + TOKEN, 'the confirmed host should receive the token');
    assert.strictEqual(other.status, 'SKIPPED');
    assert.strictEqual(other.skipKind, 'untrusted-host');
    assert.match(other.skipReason, /^skipped: would send credentials to localhost/);
    assert.strictEqual(B.seen.length, 0, 'the unconfirmed host must receive nothing');

    // 2. A base URL that exists only in the collection is not trusted, so nothing is sent anywhere.
    A.seen.length = 0;
    results = await scenario({
      dir: path.join(tmp, 'two'), hostPort: A.port, otherPort: B.port,
      collectionVars: [{ key: 'host', value: `http://127.0.0.1:${A.port}` }],
      inputs: { secrets: { token: TOKEN } },
    });
    assert.ok(results.every((x) => x.status === 'SKIPPED' && x.skipKind === 'untrusted-host'), 'collection-only host must not receive credentials');
    assert.strictEqual(A.seen.length + B.seen.length, 0);

    // 3. --confirm-host is the explicit way to allow the other host.
    results = await scenario({ dir: path.join(tmp, 'three'), hostPort: A.port, otherPort: B.port, collectionVars: [], inputs, extraArgs: ['--confirm-host', 'localhost'] });
    assert.ok(results.every((x) => x.status === 'PASS'), 'both hosts confirmed: both requests should run');
    assert.strictEqual(B.seen[0].authorization, 'Bearer ' + TOKEN);

    console.log('api host pinning: all checks passed');
  } finally {
    A.srv.close();
    B.srv.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
