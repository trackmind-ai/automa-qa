#!/usr/bin/env node
/**
 * store-secret.js — move a captured access token from a temp file into inputs.json -> secrets,
 * without ever printing it.
 *
 *   node store-secret.js <tmpfile> <inputs.json> <secretName> [--var key=value ...]
 *
 * <tmpfile> is the JSON saved by the browser capture snippet (SKILL.md step 2b):
 *   { "access_token": "...", "audience": "..." }
 *
 * Prints only: audience, expiry, claim key names and role names. Deletes <tmpfile> afterwards.
 * Exits 1 when no token is found or the token is already expired (the temp file is still deleted).
 */
'use strict';
const fs = require('fs');
const L = require('./lib');

const argv = process.argv.slice(2);
const pos = [];
const vars = {};
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--var' && argv[i + 1]) {
    const [k, ...v] = argv[++i].split('=');
    vars[k] = v.join('=');
  } else pos.push(argv[i]);
}
const [tmpFile, inputsFile, name] = pos;
if (!tmpFile || !inputsFile || !name) {
  console.error('usage: node store-secret.js <tmpfile> <inputs.json> <secretName> [--var key=value]');
  process.exit(2);
}

let code = 0;
try {
  const raw = fs.readFileSync(tmpFile, 'utf8');
  // the capture tool may wrap the JSON in a markdown fence or text; take the outermost object
  const parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
  const token = parsed.access_token;
  if (!token) throw new Error(parsed.error || 'no access_token in the captured file');
  const p = L.jwtPayload(token);
  const exp = p && p.exp ? new Date(p.exp * 1000) : null;
  if (exp && exp.getTime() < Date.now()) throw new Error(`token is already expired (${exp.toISOString()}) — capture a fresh one`);

  const inputs = fs.existsSync(inputsFile) ? JSON.parse(fs.readFileSync(inputsFile, 'utf8')) : {};
  inputs.secrets = inputs.secrets || {};
  inputs.variables = inputs.variables || {};
  inputs.secrets[name] = token;
  Object.assign(inputs.variables, vars);
  fs.writeFileSync(inputsFile, JSON.stringify(inputs, null, 2));

  const roles = p && Object.entries(p).find(([k, v]) => /roles?$/i.test(k) && Array.isArray(v));
  console.log(
    JSON.stringify({
      stored: name,
      audience: parsed.audience || (p && p.aud) || null,
      expiresAt: exp ? exp.toISOString() : null,
      claimKeys: p ? Object.keys(p) : [],
      roles: roles ? roles[1] : undefined,
    })
  );
} catch (e) {
  console.error(`store-secret: ${e.message}`);
  code = 1;
} finally {
  try {
    fs.unlinkSync(tmpFile);
  } catch {
    /* already gone */
  }
}
process.exit(code);
