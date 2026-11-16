'use strict';
/**
 * Resolve the values a run starts with, layered lowest → highest priority:
 *
 *   1. collection-level `variable` entries (non-empty only)
 *   2. a Postman environment export (--env)
 *   3. inputs.json  → variables
 *   4. inputs.json  → secrets
 *   5. environment variables AUTOMAQA_API_<NAME> (NAME upper-cased, non-alphanumerics → _)
 *
 * Secrets belong in (5) or in a git-ignored inputs.json — never in chat or the report.
 */

const fs = require('fs');
const { readJson } = require('./lib');

const envName = (n) => 'AUTOMAQA_API_' + n.toUpperCase().replace(/[^A-Z0-9]/g, '_');

function loadInputsFile(file) {
  if (!file || !fs.existsSync(file)) return {};
  return readJson(file);
}

function loadValues({ collection, envFile, inputsFile, names = [], env = process.env }) {
  const values = {};
  const origin = {};
  const put = (k, v, src) => {
    if (v === undefined || v === null || v === '') return;
    values[k] = v;
    origin[k] = src;
  };

  for (const v of (collection && collection.variable) || []) put(v.key, v.value, 'collection');

  if (envFile) {
    const e = readJson(envFile);
    for (const v of e.values || []) if (v.enabled !== false) put(v.key, v.value, 'postman-environment');
  }

  const inputs = loadInputsFile(inputsFile);
  for (const [k, v] of Object.entries(inputs.variables || {})) put(k, v, 'inputs.json');
  for (const [k, v] of Object.entries(inputs.secrets || {})) put(k, v, 'inputs.json (secret)');
  for (const n of names) put(n, env[envName(n)], `env ${envName(n)}`);

  return {
    values,
    origin,
    aliases: inputs.aliases || {},
    tokenRequests: inputs.tokenRequests || {},
    overrides: inputs.requestOverrides || {},
    raw: inputs,
  };
}

module.exports = { loadValues, loadInputsFile, envName };
