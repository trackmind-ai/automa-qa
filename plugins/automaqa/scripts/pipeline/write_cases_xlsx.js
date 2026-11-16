#!/usr/bin/env node
/**
 * write_cases_xlsx.js
 *
 * Writes the review workbook for scan-to-cases. One sheet per area, same layout as the
 * reference workbook layout, and readable as-is by extract_cases.js (import-cases):
 *
 *   row 1  sheet title (bold, 13pt)
 *   row 2  blank
 *   row 3  header: TC ID | Test Type | Test Scenario | Pre-Condition | Test Data | Test Steps | Expected Result
 *   row 4+ one case per row, frozen below the header
 *
 * Cases with "approval": true go to a sheet named "Approval Required" (orange ID cell),
 * never mixed into the run sheets.
 *
 * Usage:
 *   node write_cases_xlsx.js <input.json> <output.xlsx>
 *
 * Input JSON:
 * {
 *   "approval_title": "<App> - write and download cases (APPROVAL REQUIRED, never in the run file)",
 *   "sheets": [
 *     { "name": "<App> Analytics", "title": "<App> - Analytics tab: ... (QA only, read only)",
 *       "cases": [ { "id": "SUP_ANA_TC_001", "type": "Navigation", "scenario": "...",
 *                    "precondition": "...", "test_data": "-", "steps": "1. ...\n2. ...",
 *                    "expected": "...", "approval": false } ] }
 *   ]
 * }
 *
 * Needs the `exceljs` package: npm install exceljs   (in the user's project).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

function loadExcelJS() {
  // Look in the user's project first, then next to this script.
  for (const base of [path.join(process.cwd(), 'noop.js'), __filename]) {
    try { return createRequire(base)('exceljs'); } catch (_) { /* try next */ }
  }
  console.error('ERROR: the exceljs package is missing. Run: npm install exceljs   (in your project folder)');
  process.exit(3);
}

const HEADERS = ['TC ID', 'Test Type', 'Test Scenario', 'Pre-Condition', 'Test Data', 'Test Steps', 'Expected Result'];
const WIDTHS = [22, 16, 40, 40, 40, 62, 62];
const BORDER = { style: 'thin', color: { argb: 'FFBFBFBF' } };
const BOX = { top: BORDER, left: BORDER, bottom: BORDER, right: BORDER };
const APPROVAL_NAME = 'Approval Required';

function safeSheetName(name, used) {
  let n = String(name).replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 31) || 'Sheet';
  let i = 2;
  while (used.has(n.toLowerCase())) n = n.slice(0, 31 - String(i).length - 1) + ' ' + i++;
  used.add(n.toLowerCase());
  return n;
}

function addSheet(wb, used, name, title, cases, approval) {
  const ws = wb.addWorksheet(safeSheetName(name, used));
  ws.getCell('A1').value = title;
  ws.getCell('A1').font = { bold: true, size: 13 };
  const header = ws.getRow(3);
  HEADERS.forEach((h, i) => {
    const c = header.getCell(i + 1);
    c.value = h;
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } };
    c.alignment = { vertical: 'center', wrapText: true };
    c.border = BOX;
  });
  WIDTHS.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  cases.forEach((tc, idx) => {
    const row = ws.getRow(4 + idx);
    [tc.id, tc.type, tc.scenario, tc.precondition, tc.test_data || '-', tc.steps, tc.expected].forEach((v, i) => {
      const c = row.getCell(i + 1);
      c.value = v == null ? '' : String(v);
      c.font = { name: 'Calibri', size: 11 };
      c.alignment = { vertical: 'top', wrapText: true };
      c.border = BOX;
    });
    if (approval) row.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4B183' } };
  });
  ws.views = [{ state: 'frozen', ySplit: 3, topLeftCell: 'A4' }];
}

async function main() {
  const [inPath, outPath] = process.argv.slice(2);
  if (!inPath || !outPath) {
    console.error('Usage: node write_cases_xlsx.js <input.json> <output.xlsx>');
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(inPath, 'utf8'));
  if (!Array.isArray(data.sheets)) { console.error('ERROR: input needs a "sheets" array'); process.exit(1); }

  const ExcelJS = loadExcelJS();
  const wb = new ExcelJS.Workbook();
  const used = new Set();
  const approvalCases = [];
  const ids = new Set();
  let written = 0;

  for (const s of data.sheets) {
    const run = [];
    for (const tc of s.cases || []) {
      if (!tc.id) { console.error(`ERROR: a case in "${s.name}" has no id`); process.exit(1); }
      if (ids.has(tc.id)) { console.error(`ERROR: duplicate id ${tc.id}`); process.exit(1); }
      ids.add(tc.id);
      (tc.approval ? approvalCases : run).push(tc);
    }
    if (run.length) { addSheet(wb, used, s.name, s.title || s.name, run, false); written += run.length; }
  }
  if (approvalCases.length) {
    addSheet(wb, used, APPROVAL_NAME, data.approval_title || `${APPROVAL_NAME} - write and download cases (APPROVAL REQUIRED, never in the run file)`, approvalCases, true);
    written += approvalCases.length;
  }
  if (!wb.worksheets.length) { console.error('ERROR: no cases to write'); process.exit(1); }

  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  await wb.xlsx.writeFile(outPath);
  console.log(`Wrote ${written} cases on ${wb.worksheets.length} sheet(s) -> ${outPath}`);
  console.log(`  run cases: ${written - approvalCases.length}, approval-required: ${approvalCases.length}`);
}
main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
