// Multi-role pass. Sign in once per role (the USER signs in each time), run the scan areas, then compare.
//   const r = roleSnapshot('admin', { menu:[...], screens:{ '/provider/myday':{ visible:true, controls:[...] }, ... }, denied:['/provider/x'] })
//   const rows = comparePermissions([r1, r2, r3])   -> source.permissions rows (what each role sees, can do, cannot do, evidence)
// "Cannot" is only recorded when it was OBSERVED (a hidden menu item, an access-denied page). Otherwise it is "not observed".
const clean = a => [...new Set((a || []).map(String))];   // keeps the order the menu was seen in

function roleSnapshot(role, d = {}) { return { role, menu: clean(d.menu), screens: d.screens || {}, denied: clean(d.denied), date: d.date || '' }; }

function comparePermissions(snaps) {
  const allMenu = clean(snaps.flatMap(s => s.menu)); const allScreens = clean(snaps.flatMap(s => Object.keys(s.screens)));
  const rows = [];
  for (const s of snaps) {
    const sees = s.menu; const hiddenMenu = allMenu.filter(m => !s.menu.includes(m));
    const openedScreens = Object.entries(s.screens).filter(([, v]) => v && v.visible).map(([k]) => k);
    const notOpened = allScreens.filter(k => !(s.screens[k] && s.screens[k].visible));
    const writes = clean(Object.values(s.screens).flatMap(v => (v && v.controls) || []));
    rows.push({
      role: s.role,
      sees: `Menu: ${sees.join(', ') || '(none seen)'}. Screens opened: ${openedScreens.length}.`,
      can: openedScreens.length ? `Open ${openedScreens.length} screens (read-only scan). Controls seen: ${writes.slice(0, 12).join(', ') || 'none recorded'}.` : 'Not observed',
      cannot: [hiddenMenu.length ? `Menu items other roles see but this role did not: ${hiddenMenu.join(', ')}` : '', s.denied.length ? `Access denied or hidden: ${s.denied.join(', ')}` : '', notOpened.length && !hiddenMenu.length && !s.denied.length ? 'Nothing observed that this role cannot open (screens not reached are not evidence)' : ''].filter(Boolean).join('. ') || 'Not observed',
      evidence: `Scanned signed in as this role${s.date ? ' on ' + s.date : ''}; read-only.`,
    });
  }
  return rows;
}
// Roles that were never signed in appear as "not observed" rows so the permissions table is never silent about them.
function notObserved(roles) { return roles.map(r => ({ role: r, sees: 'Not observed', can: 'Not observed', cannot: 'Not observed', evidence: 'No sign-in as this role during the scan; needs a business definition.' })); }

module.exports = { roleSnapshot, comparePermissions, notObserved };
