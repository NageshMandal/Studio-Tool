/**
 * The role migration, checked against a fake collection: it must find every
 * account on the retired key, move it, and change nothing else.
 */
const Admin = require('./models/Admin');

let rows = [
  { email: 'a@x.com', role: 'location_manager' },
  { email: 'b@x.com', role: 'location_admin' },
  { email: 'c@x.com', role: 'location_manager' },
  { email: 'd@x.com', role: 'super' },
];

let seen = null;
Admin.updateMany = async (filter, update, opts) => {
  seen = { filter, update, opts };
  let n = 0;
  rows.forEach((r) => {
    if (r.role === filter.role) { r.role = update.$set.role; n++; }
  });
  return { modifiedCount: n };
};

let fails = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};

(async () => {
  const moved = await Admin.migrateRoles();

  check('it reports what it moved', moved, 2);
  check('it looked for the retired key', seen.filter.role, 'location_manager');
  check('it wrote the new key', seen.update.$set.role, 'location_sub_admin');
  check('strict is off, since the old key is no longer in the enum', seen.opts.strict, false);
  check('both managers were moved', rows.filter((r) => r.role === 'location_sub_admin').map((r) => r.email), ['a@x.com', 'c@x.com']);
  check('the location admin was left alone', rows[1].role, 'location_admin');
  check('the super admin was left alone', rows[3].role, 'super');

  const again = await Admin.migrateRoles();
  check('running it a second time is a no-op', again, 0);

  console.log(fails ? `\n${fails} failed` : '\nMIGRATION CORRECT');
  process.exit(fails ? 1 : 0);
})();
