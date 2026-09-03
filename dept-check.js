/**
 * Checks the free-text department behaviour without a database: the model's
 * normalisation, and the controller's option-building and canonicalisation.
 */
const mongoose = require('mongoose');
const User = require('./models/User');

let fails = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};

console.log('\n--- Model accepts any department and tidies it ---');
const mk = (d) => new User({ name: 'X', email: 'x@o.com', password: 'secret1', location: new mongoose.Types.ObjectId(), department: d });
check('accepts a brand-new team name', mk('Client Servicing').department, 'Client Servicing');
check('collapses double spaces', mk('Post   Production').department, 'Post Production');
check('trims surrounding space', mk('  Sales  ').department, 'Sales');
check('blank falls back to Studio', mk('').department, 'Studio');
check('whitespace-only falls back too', mk('   ').department, 'Studio');

const tooLong = mk('D'.repeat(70));
const err = tooLong.validateSync();
check('rejects over 60 characters', Boolean(err && err.errors.department), true);
check('no enum restriction remains', User.schema.path('department').enumValues, []);

console.log('\n--- Controller: suggestions and canonicalisation ---');
// Stub the studio-scoped distinct() with what a studio already uses
const inUse = ['Post Production', 'Sales'];
User.distinct = async () => inUse;

const ctrl = require('./controllers/userController');
const req = { scope: { filter: () => ({ location: 'PAT' }) } };

(async () => {
  const opts = await ctrl.departmentOptions(req);
  check('suggestions merge in-use with built-ins', opts,
    ['Admin', 'Design', 'Editing', 'Other', 'Post Production', 'Production', 'Sales', 'Studio']);
  check('no duplicate for a name in both lists', opts.filter((d) => d === 'Sales').length, 1);

  check('reuses existing spelling for a case variant',
    await ctrl.canonicalDepartment(req, 'sales'), 'Sales');
  check('reuses existing spelling regardless of case',
    await ctrl.canonicalDepartment(req, 'POST PRODUCTION'), 'Post Production');
  check('keeps a genuinely new name as typed',
    await ctrl.canonicalDepartment(req, 'Client Servicing'), 'Client Servicing');
  check('tidies whitespace on a new name',
    await ctrl.canonicalDepartment(req, '  Motion   Graphics '), 'Motion Graphics');
  check('blank becomes the default',
    await ctrl.canonicalDepartment(req, '   '), 'Studio');

  console.log(fails ? `\n${fails} check(s) FAILED` : '\nDEPARTMENT FIELD BEHAVES CORRECTLY');
  process.exit(fails ? 1 : 0);
})();
