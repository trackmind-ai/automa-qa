// Resume mode: read model/coverage.txt and continue with what was not reached.
//   node resume.js <model dir>            -> prints the plan as JSON
//   const { parseCoverage, resumePlan, writeCoverage } = require('./resume')
//
// coverage.txt format (written by writeCoverage):
//   # covered
//   <id>|<route>|done|<note>
//   # not reached
//   <kind>|<name>|<reason>|<route>
// Resumable = reason says it was only queued / ran out of budget / not visited. Anything skipped for safety
// (ask-first, unsafe, external, may record) is NOT resumed without the user's approval.
const fs = require('fs');
const path = require('path');

const RESUMABLE = /(queued|budget|not visited|not reached yet|time limit)/i;
const BLOCKED = /(ask-?first|unsafe|external|may (?:mark|record|start)|not followed|blocked|leaves)/i;

function parseCoverage(text) {
  const covered = []; const unreached = []; let mode = '';
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim(); if (!line) continue;
    if (/^#\s*covered/i.test(line)) { mode = 'c'; continue; } if (/^#\s*not reached/i.test(line)) { mode = 'u'; continue; } if (line.startsWith('#')) { mode = ''; continue; }
    const p = line.split('|').map(s => s.trim());
    if (mode === 'c') covered.push({ id: p[0], route: p[1] || '', note: p[3] || p[2] || '' });
    else if (mode === 'u') unreached.push({ kind: p[0], name: p[1], reason: p[2] || '', route: p[3] || '', resumable: RESUMABLE.test(p[2] || '') && !BLOCKED.test(p[2] || '') });
  }
  return { covered, unreached };
}
function resumePlan(modelDir) {
  const f = path.join(modelDir, 'coverage.txt'); if (!fs.existsSync(f)) throw new Error('no coverage.txt in ' + modelDir);
  const c = parseCoverage(fs.readFileSync(f, 'utf8'));
  return { covered: c.covered.length, next: c.unreached.filter(u => u.resumable), needsApproval: c.unreached.filter(u => !u.resumable) };
}
function writeCoverage(modelDir, covered, unreached) {
  const lines = ['# covered', ...covered.map(c => `${c.id}|${c.route || ''}|done|${c.note || ''}`), '# not reached', ...unreached.map(u => `${u.kind}|${u.name}|${u.reason}|${u.route || ''}`)];
  fs.writeFileSync(path.join(modelDir, 'coverage.txt'), lines.join('\n') + '\n');
}
if (require.main === module) { try { console.log(JSON.stringify(resumePlan(process.argv[2] || '.'), null, 1)); } catch (e) { console.error(e.message); process.exit(1); } }
module.exports = { parseCoverage, resumePlan, writeCoverage, RESUMABLE, BLOCKED };
