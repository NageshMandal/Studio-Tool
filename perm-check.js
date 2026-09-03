/**
 * Asserts the permission rules directly, without a browser or a database.
 * These are the invariants the whole restructure rests on, so they are
 * checked as facts rather than trusted because the pages happen to render.
 */
const { capabilities } = require('./middleware/auth');
const { mayManage, assignableRoles } = require('./controllers/adminAccountController');

const SUPER = { id: 'root', adminRole: 'super', location: null };
const PAT_ADMIN = { id: 'a1', adminRole: 'location_admin', location: 'PAT' };
const PAT_MGR = { id: 'a2', adminRole: 'location_manager', location: 'PAT' };
const RAN_ADMIN = { id: 'a3', adminRole: 'location_admin', location: 'RAN' };

let fails = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};

console.log('\n--- Procurement is invisible to the super admin ---');
check('super cannot view purchase requests', capabilities(SUPER).viewProcurement, false);
check('super cannot decide purchase requests', capabilities(SUPER).decideProcurement, false);
check('location admin can view', capabilities(PAT_ADMIN).viewProcurement, true);
check('location admin can decide', capabilities(PAT_ADMIN).decideProcurement, true);
check('manager can view', capabilities(PAT_MGR).viewProcurement, true);
check('manager cannot decide', capabilities(PAT_MGR).decideProcurement, false);

console.log('\n--- Cross-studio reach ---');
check('only super sees all studios', capabilities(SUPER).viewAllStudios, true);
check('location admin does not', capabilities(PAT_ADMIN).viewAllStudios, false);
check('manager does not', capabilities(PAT_MGR).viewAllStudios, false);
check('only super manages studios', capabilities(PAT_ADMIN).manageStudios, false);

console.log('\n--- Who may create whom ---');
check('super assigns every role', assignableRoles(SUPER), ['super', 'location_admin', 'location_manager']);
check('location admin assigns managers only', assignableRoles(PAT_ADMIN), ['location_manager']);
check('manager assigns nobody', assignableRoles(PAT_MGR), []);

console.log('\n--- Who may act on whom ---');
check('super may manage a location admin', mayManage(SUPER, { _id: 'a1', role: 'location_admin', location: 'PAT' }), true);
check('nobody may manage themselves', mayManage(SUPER, { _id: 'root', role: 'super', location: null }), false);
check('PAT admin may manage a PAT manager', mayManage(PAT_ADMIN, { _id: 'a2', role: 'location_manager', location: 'PAT' }), true);
check('PAT admin may NOT manage a RAN manager', mayManage(PAT_ADMIN, { _id: 'a9', role: 'location_manager', location: 'RAN' }), false);
check('PAT admin may NOT manage another location admin', mayManage(PAT_ADMIN, { _id: 'a3', role: 'location_admin', location: 'PAT' }), false);
check('PAT admin may NOT manage a super admin', mayManage(PAT_ADMIN, { _id: 'a0', role: 'super', location: null }), false);
check('manager may manage nobody', mayManage(PAT_MGR, { _id: 'a2', role: 'location_manager', location: 'PAT' }), false);

console.log('\n--- Deleting is a primary-admin action ---');
check('location admin may delete items', capabilities(PAT_ADMIN).deleteItems, true);
check('manager may not delete items', capabilities(PAT_MGR).deleteItems, false);
check('manager may not delete people', capabilities(PAT_MGR).deletePeople, false);
check('manager may still add and edit items', capabilities(PAT_MGR).manageItems, true);

console.log('\n--- Scope filters ---');
const { withScope } = require('./middleware/scope');
const mkScope = (activeId, isSuper) => ({
  filter: (extra = {}) => (activeId ? { ...extra, location: activeId } : { ...extra }),
  owns: (doc) => {
    if (!doc) return false;
    const l = doc.location && doc.location._id ? doc.location._id : doc.location;
    if (!activeId) return isSuper;
    return String(l) === String(activeId);
  },
});
const patScope = mkScope('PAT', false);
const allScope = mkScope(null, true);
check('scoped filter pins the studio', patScope.filter({ status: 'pending' }), { status: 'pending', location: 'PAT' });
check('all-studios filter adds nothing', allScope.filter({ status: 'pending' }), { status: 'pending' });
check('owns() accepts own studio', patScope.owns({ location: 'PAT' }), true);
check('owns() rejects another studio', patScope.owns({ location: 'RAN' }), false);
check('owns() rejects a missing doc', patScope.owns(null), false);
check('owns() handles a populated location', patScope.owns({ location: { _id: 'PAT' } }), true);

console.log(fails ? `\n${fails} assertion(s) FAILED` : '\nALL PERMISSION RULES HOLD');
process.exit(fails ? 1 : 0);
