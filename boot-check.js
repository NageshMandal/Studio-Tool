/**
 * Boots the whole app with the database stubbed out, so route wiring,
 * middleware order and view resolution are all exercised for real without
 * needing a live MongoDB.
 */
process.env.MONGO_URI = 'mongodb://127.0.0.1:27017/x';
process.env.JWT_SECRET = 'test-secret-value-for-boot-check';
process.env.ADMIN_EMAIL = 'admin@office.com';
process.env.ADMIN_PASSWORD = 'Admin@12345';
process.env.ADMIN_NAME = 'Studio Admin';
process.env.PORT = '4999';

const mongoose = require('mongoose');
mongoose.connect = async () => ({ connection: { host: 'stub', name: 'stub' } });

require('./server.js');

setTimeout(async () => {
  const base = 'http://127.0.0.1:4999';
  const checks = [
    ['GET', '/login', [200]],
    ['GET', '/admin/dashboard', [302]],       // no session -> redirect to login
    ['GET', '/admin/purchase-requests', [302]],
    ['GET', '/staff', [302]],
    ['GET', '/api/me', [401]],
    ['GET', '/nope', [404]],
  ];
  let fails = 0;
  for (const [method, path, want] of checks) {
    try {
      const r = await fetch(base + path, { method, redirect: 'manual' });
      const ok = want.includes(r.status);
      if (!ok) fails++;
      console.log((ok ? 'PASS ' : 'FAIL ') + path + '  -> ' + r.status + ' (want ' + want.join('/') + ')');
    } catch (e) {
      fails++;
      console.log('ERROR ' + path + '  ' + e.message);
    }
  }
  console.log(fails ? '\n' + fails + ' check(s) failed' : '\nALL ROUTE CHECKS PASSED');
  process.exit(fails ? 1 : 0);
}, 1500);
