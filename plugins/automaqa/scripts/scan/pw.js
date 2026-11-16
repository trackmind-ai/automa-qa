// Resolve Playwright from the USER's project (cwd), not from the plugin folder.
function pw() {
  for (const base of [process.cwd(), __dirname]) {
    for (const name of ['playwright', '@playwright/test']) {
      try { return require(require.resolve(name, { paths: [base] })); } catch (_) { /* next */ }
    }
  }
  throw new Error('Playwright not found in this project. Run /automaqa:setup web first.');
}
module.exports = { pw };
