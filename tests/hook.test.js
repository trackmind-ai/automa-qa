#!/usr/bin/env node
/**
 * Tests for scripts/hooks/hook.js — the pipeline notifier printed after Write/Bash
 * tool uses.
 *
 * Run: node tests/hook.test.js
 *
 * This exists because of a real regression: after the plugin was renamed from
 * "Testing" to AutomaQA, every user-facing string was rebranded except this file —
 * it kept printing "[Testing]" on every hook fire. A second, related bug survived
 * in the same file: a comment referencing extract_excel.js, a script removed when
 * intake was generalised to extract_cases.js. Both slipped through because nothing
 * ran this script and inspected its output. This file is that check, permanently.
 */

'use strict';

const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'plugins', 'automaqa', 'scripts', 'hooks', 'hook.js');

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
    process.stdout.write(`  ok    ${name}\n`);
  } catch (err) {
    failures.push({ name, message: err.message });
    process.stdout.write(`  FAIL  ${name}\n        ${err.message}\n`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/** Run hook.js for one event and return its stdout. */
function run(event) {
  return execFileSync(process.execPath, [SCRIPT, event], { encoding: 'utf8' });
}

const SOURCE = require('fs').readFileSync(SCRIPT, 'utf8');

// Every event hooks/hooks.json is known to fire, per hook.js's own header comment.
const KNOWN_EVENTS = [
  'post_write',
  'post_playwright_run',
  'post_maestro_run',
  'post_npm_install',
  'post_extract',
  'post_spec_build',
  'pre_playwright_run',
  'pre_maestro_run',
];

console.log('\nhook.js\n');

check('the file itself carries no retired branding or stale filenames', () => {
  assert(!/\bTesting\b/.test(SOURCE), 'source file still contains the retired "Testing" brand name');
  assert(!/extract_excel/.test(SOURCE), 'source file still references removed extract_excel.js/.py');
});

for (const event of KNOWN_EVENTS) {
  check(`${event}: prints a message with no retired branding or stale filenames`, () => {
    const out = run(event);
    assert(out.trim().length > 0, 'produced no output');
    assert(!/\bTesting\b/.test(out), `output still says "Testing": ${out.slice(0, 80)}`);
    assert(!/extract_excel/.test(out), `output still references extract_excel: ${out.slice(0, 80)}`);
    assert(/AutomaQA/.test(out), 'output does not carry the current AutomaQA brand');
  });
}

check('an unknown event produces no output and exits 0', () => {
  const out = execFileSync(process.execPath, [SCRIPT, 'not_a_real_event'], { encoding: 'utf8' });
  assert(out === '', `expected silence for an unknown event, got: ${JSON.stringify(out.slice(0, 80))}`);
});

check('no event argument produces no output and exits 0', () => {
  const out = execFileSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert(out === '', `expected silence with no event argument, got: ${JSON.stringify(out.slice(0, 80))}`);
});

// ── pre/post routing: the hook must stay silent on unrelated tool uses ─────
function runPayload(phase, payload) {
  return execFileSync(process.execPath, [SCRIPT, phase], { encoding: 'utf8', input: JSON.stringify(payload) });
}
const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });
const write = (file_path) => ({ tool_name: 'Write', tool_input: { file_path } });

check('unrelated Bash commands print nothing (pre and post)', () => {
  for (const cmd of ['ls -la', 'git status', 'npm run build']) {
    assert(runPayload('pre', bash(cmd)) === '', `pre printed for: ${cmd}`);
    assert(runPayload('post', bash(cmd)) === '', `post printed for: ${cmd}`);
  }
});

check('unrelated file writes print nothing', () => {
  assert(runPayload('post', write('src/app.ts')) === '', 'printed for src/app.ts');
  assert(runPayload('post', write('README.md')) === '', 'printed for README.md');
});

check('playwright / maestro runs are routed to their pre and post messages', () => {
  assert(/Playwright test starting/.test(runPayload('pre', bash('npx playwright test --headed'))), 'pre playwright');
  assert(/Playwright run complete/.test(runPayload('post', bash('npx playwright test'))), 'post playwright');
  assert(/Maestro flow starting/.test(runPayload('pre', bash('maestro test flows/a.yaml'))), 'pre maestro');
  assert(/Maestro run complete/.test(runPayload('post', bash('maestro test flows/a.yaml'))), 'post maestro');
});

check('npm install and extract_cases are routed after the command only', () => {
  assert(/Node dependencies installed/.test(runPayload('post', bash('npm install'))), 'post npm install');
  assert(runPayload('pre', bash('npm install')) === '', 'pre npm install should be silent');
  assert(/Excel extraction complete/.test(runPayload('post', bash('node plugins/automaqa/scripts/pipeline/extract_cases.js x.xlsx'))), 'post extract');
});

check('spec, test and report writes are routed to the write message', () => {
  for (const f of ['specs/login/spec.md', 'tests/login.spec.ts', 'maestro/flows/login.yaml', 'specs/login/report-v2.html', String.raw`C:\p\specs\spec.md`]) {
    assert(/File written/.test(runPayload('post', write(f))), `no write message for ${f}`);
  }
});

check('malformed or empty stdin is silent and exits 0', () => {
  const out = execFileSync(process.execPath, [SCRIPT, 'post'], { encoding: 'utf8', input: 'not json' });
  assert(out === '', 'expected silence on bad stdin');
});

// ── hooks.json launches the shell wrapper, exactly as Claude Code would ────
const PLUGIN_ROOT = path.join(__dirname, '..', 'plugins', 'automaqa').split(path.sep).join('/');
const HOOKS = JSON.parse(require('fs').readFileSync(path.join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8')).hooks;
const hookCommands = Object.values(HOOKS).flat().flatMap((entry) => entry.hooks.map((h) => h.command));

/** Run a command string from hooks.json through bash with CLAUDE_PLUGIN_ROOT set. */
function runHookCommand(command, payload) {
  return execFileSync('bash', ['-c', command], {
    encoding: 'utf8',
    input: JSON.stringify(payload),
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
  });
}

check('hooks.json calls hook.sh by its CLAUDE_PLUGIN_ROOT path, not a bare node command', () => {
  assert(hookCommands.length === 2, `expected one pre and one post hook, got ${hookCommands.length}`);
  for (const c of hookCommands) {
    assert(c.includes('${CLAUDE_PLUGIN_ROOT}/scripts/hooks/hook.sh'), `not the shell launcher: ${c}`);
    assert(!/^\s*node\b/.test(c), `still a bare node command: ${c}`);
  }
});

check('the launcher script is executable-safe: LF line endings and a bash shebang', () => {
  const sh = require('fs').readFileSync(path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'hook.sh'), 'utf8');
  assert(sh.startsWith('#!/usr/bin/env bash\n'), 'missing bash shebang with LF');
  assert(!sh.includes('\r'), 'hook.sh contains CRLF, which breaks it on Linux and macOS');
});

check('the pre and post hook commands, run through bash, route real tool calls', () => {
  const [pre, post] = hookCommands;
  assert(/Playwright test starting/.test(runHookCommand(pre, bash('npx playwright test'))), 'pre via hook.sh');
  assert(/Maestro run complete/.test(runHookCommand(post, bash('maestro test flows/a.yaml'))), 'post via hook.sh');
  assert(/File written/.test(runHookCommand(post, write('specs/login/spec.md'))), 'post write via hook.sh');
});

check('the hook commands stay silent for unrelated tool calls', () => {
  const [pre, post] = hookCommands;
  assert(runHookCommand(pre, bash('ls -la')) === '', 'pre printed for ls');
  assert(runHookCommand(post, bash('git status')) === '', 'post printed for git status');
  assert(runHookCommand(post, write('src/app.ts')) === '', 'post printed for src/app.ts');
});

// ── Summary ────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.log(`  FAIL ${f.name}\n       ${f.message}`);
  process.exit(1);
}
