/** Checks that each failure mode produces the right guidance. */
const { maskUri, explain } = require('./config/db');
let fails = 0;
const check = (label, got, want) => {
  const ok = want instanceof RegExp ? want.test(String(got)) : got === want;
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`      got: ${String(got).slice(0, 120)}`);
};

const SRV = 'mongodb+srv://user:secret123@cluster0.mjpymj4.mongodb.net/studio_tracker';

console.log('\n--- Password masking ---');
check('password hidden', maskUri(SRV), 'mongodb+srv://user:****@cluster0.mjpymj4.mongodb.net/studio_tracker');
check('handles no-auth URI', maskUri('mongodb://127.0.0.1:27017/x'), 'mongodb://127.0.0.1:27017/x');
check('handles missing URI', maskUri(undefined), '(not set)');
check('special chars in password still masked',
  maskUri('mongodb+srv://u:p%40ss@c.mongodb.net/db'), /:\*\*\*\*@/);

console.log('\n--- The user\'s actual error ---');
const real = explain({ message: 'querySrv ECONNREFUSED _mongodb._tcp.cluster0.mjpymj4.mongodb.net' }, SRV);
check('identified as DNS, not Atlas', real, /DNS problem on this machine/);
check('says Atlas was never reached', real, /never reached Atlas/);
check('offers the DNS_SERVERS fix', real, /DNS_SERVERS=8\.8\.8\.8,1\.1\.1\.1/);
check('offers the non-SRV fallback', real, /2\.2\.12 or/);
check('warns nslookup is not proof', real, /nslookup/);

console.log('\n--- Other failure modes ---');
check('auth failure -> credentials advice',
  explain({ message: 'bad auth : Authentication failed.' }, SRV), /Database Access/);
check('auth failure -> mentions encoding',
  explain({ message: 'Authentication failed' }, SRV), /percent-encoded/);
check('IP block -> network access advice',
  explain({ message: "IP that isn't whitelisted" }, SRV), /Network Access/);
check('timeout -> paused cluster advice',
  explain({ message: 'Server selection timed out after 15000 ms' }, SRV), /paused/);
check('bad host on direct URI',
  explain({ message: 'getaddrinfo ENOTFOUND typo.host' }, 'mongodb://typo.host:27017/x'), /typos/);
check('unknown error returns nothing',
  explain({ message: 'something unexpected' }, SRV), null);

console.log(fails ? `\n${fails} FAILED` : '\nDIAGNOSTICS CORRECT');
process.exit(fails ? 1 : 0);
