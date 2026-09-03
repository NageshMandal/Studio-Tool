require('dotenv').config();

const dns = require('dns');
const net = require('net');
const { promisify } = require('util');

/**
 * Database connection diagnosis, one layer at a time.
 *
 * The point is to separate four things that all surface as "cannot connect"
 * but need completely different fixes:
 *
 *   1. the .env value            — is MONGO_URI even loaded, and well-formed?
 *   2. DNS                       — can Node resolve the cluster at all?
 *   3. the network path          — can we open a TCP socket to a shard?
 *   4. Atlas itself              — credentials, IP allow-list, paused cluster
 *
 * Run: npm run check:db
 */

const { maskUri } = require('../config/db');

const ok = (m) => console.log(`  \x1b[32mOK\x1b[0m    ${m}`);
const bad = (m) => console.log(`  \x1b[31mFAIL\x1b[0m  ${m}`);
const info = (m) => console.log(`        ${m}`);
const step = (n, m) => console.log(`\n${n}. ${m}`);

const resolveSrv = promisify(dns.resolveSrv);
const resolve4 = promisify(dns.resolve4);

// Can we actually open a socket to host:port?
function tcpProbe(host, port, timeout = 6000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => done({ ok: true }));
    socket.once('timeout', () => done({ ok: false, reason: 'timed out' }));
    socket.once('error', (e) => done({ ok: false, reason: e.code || e.message }));
    socket.connect(port, host);
  });
}

(async () => {
  console.log('\nStudio Tracker — database connection check');
  console.log('══════════════════════════════════════════');

  /* 1. the .env value */
  step(1, 'Reading MONGO_URI from .env');
  const uri = process.env.MONGO_URI;

  if (!uri) {
    bad('MONGO_URI is not set');
    info('Your .env must use the name MONGO_URI exactly — not MONGODB_URI.');
    info('Also check the file is named .env (not .env.txt) and sits next to package.json.');
    process.exit(1);
  }
  if (/^["']|["']$/.test(uri)) {
    bad('MONGO_URI is wrapped in quotes — remove them, .env values are literal');
    process.exit(1);
  }
  ok(`loaded: ${maskUri(uri)}`);

  const isSrv = uri.startsWith('mongodb+srv://');
  info(isSrv ? 'Using an SRV connection string (needs a DNS SRV lookup).' : 'Using a direct connection string (no SRV lookup needed).');

  // Warn about a password that needs percent-encoding
  const auth = uri.match(/\/\/([^:/?#]+):([^@]+)@/);
  if (auth) {
    const pw = auth[2];
    const risky = [...'@:/?#[]'].filter((c) => pw.includes(c));
    if (risky.length) {
      bad(`the password contains ${risky.join(' ')} which must be percent-encoded`);
      info('@ becomes %40, # becomes %23, / becomes %2F, : becomes %3A');
    } else {
      ok('password needs no percent-encoding');
    }
  }

  const host = uri.replace(/^mongodb(\+srv)?:\/\//, '').replace(/^[^@]*@/, '').split(/[/?,]/)[0].split(':')[0];

  /* 2. DNS */
  step(2, `Resolving ${host}`);

  const override = (process.env.DNS_SERVERS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (override.length) {
    dns.setServers(override);
    info(`DNS_SERVERS override in use: ${override.join(', ')}`);
  }
  info(`Node is using these DNS servers: ${dns.getServers().join(', ')}`);

  let hosts = [];

  if (isSrv) {
    try {
      const records = await resolveSrv(`_mongodb._tcp.${host}`);
      ok(`SRV lookup returned ${records.length} shard(s)`);
      records.forEach((r) => info(`${r.name}:${r.port}`));
      hosts = records.map((r) => ({ host: r.name, port: r.port }));
    } catch (err) {
      bad(`SRV lookup failed: ${err.code || err.message}`);
      console.log('');
      info('This is the DNS problem, and it is why the app cannot start.');
      info('Atlas is never contacted, so it is NOT a password or IP-allow-list issue.');
      info('nslookup working does not rule this out — Node uses a different resolver.');
      console.log('');
      info('Fix, easiest first:');
      info('  1. Put this in .env and re-run:   DNS_SERVERS=8.8.8.8,1.1.1.1');
      info('  2. Or use the non-SRV URI: Atlas -> Connect -> Drivers ->');
      info('     "Node.js 2.2.12 or earlier". That URI skips SRV entirely.');
      info('  3. Or disconnect from any VPN / company network and retry.');
      console.log('');
      process.exit(1);
    }
  } else {
    try {
      const addrs = await resolve4(host);
      ok(`${host} resolves to ${addrs.join(', ')}`);
      hosts = [{ host, port: 27017 }];
    } catch (err) {
      bad(`could not resolve ${host}: ${err.code || err.message}`);
      process.exit(1);
    }
  }

  /* 3. the network path */
  step(3, 'Opening a TCP connection to the cluster');
  let reachable = 0;
  for (const h of hosts.slice(0, 3)) {
    const result = await tcpProbe(h.host, h.port);
    if (result.ok) {
      ok(`${h.host}:${h.port} reachable`);
      reachable += 1;
    } else {
      bad(`${h.host}:${h.port} — ${result.reason}`);
    }
  }
  if (!reachable) {
    console.log('');
    info('DNS works but nothing accepts a connection.');
    info('  - Is the cluster paused? Atlas pauses free clusters after inactivity.');
    info('  - Is outbound port 27017 blocked by a firewall or your network?');
    console.log('');
    process.exit(1);
  }

  /* 4. Atlas itself */
  step(4, 'Authenticating and running a test query');
  const mongoose = require('mongoose');
  try {
    const conn = await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000, family: 4 });
    ok(`connected to ${conn.connection.host}`);
    ok(`database: ${conn.connection.name}`);

    const names = (await conn.connection.db.listCollections().toArray()).map((c) => c.name);
    ok(names.length ? `${names.length} collection(s): ${names.join(', ')}` : 'connected — database is empty (run `npm run setup`)');

    await mongoose.connection.close();
    console.log('\n\x1b[32mEverything works.\x1b[0m You can run `npm run dev`.\n');
    process.exit(0);
  } catch (err) {
    bad(err.message);
    console.log('');
    if (/Authentication failed|bad auth/i.test(err.message)) {
      info('The cluster was reached but rejected your credentials.');
      info('Check Atlas -> Database Access. Remember the database user password');
      info('is not the same as your Atlas account login.');
    } else if (/whitelist|not allowed to connect/i.test(err.message)) {
      info('Your IP is not on the allow-list.');
      info('Atlas -> Network Access -> Add IP Address (0.0.0.0/0 to test).');
    } else {
      info('Re-run with DEBUG_DB=1 in .env for the full stack trace.');
    }
    console.log('');
    process.exit(1);
  }
})();
