const dns = require('dns');
const mongoose = require('mongoose');

/**
 * The MongoDB connection.
 *
 * Most of this file exists because of one specific failure that is very easy
 * to misread:
 *
 *   querySrv ECONNREFUSED _mongodb._tcp.<cluster>.mongodb.net
 *
 * That is NOT Atlas rejecting you, and it is not a bad password. A
 * `mongodb+srv://` URI makes the driver do a DNS SRV lookup to discover the
 * cluster's servers, and this error means the DNS resolver Node is using
 * actively refused that lookup. Atlas is never even contacted.
 *
 * The confusing part: `nslookup` can succeed while Node still fails. They do
 * not share a resolver. nslookup talks to whatever Windows hands it; Node
 * uses its own bundled resolver reading the OS server list, and a stale VPN
 * entry, a router that refuses SRV queries, or an IPv6 entry pointing
 * nowhere will break Node while leaving nslookup working perfectly.
 *
 * So instead of guessing, we let DNS be configured explicitly, and turn the
 * common failures into messages that say what to actually do.
 */

// Show the URI without leaking the password into logs or screenshots
function maskUri(uri) {
  if (!uri) return '(not set)';
  return String(uri).replace(/\/\/([^:/?#]+):([^@]+)@/, '//$1:****@');
}

/**
 * Point Node's resolver at a DNS server that answers SRV queries.
 *
 * This is the fix for querySrv ECONNREFUSED that does not require touching
 * Windows network settings, and it only affects this process — nothing else
 * on the machine changes.
 */
function applyDnsOverride() {
  const raw = (process.env.DNS_SERVERS || '').trim();
  if (!raw) return null;

  const servers = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (!servers.length) return null;

  try {
    dns.setServers(servers);
    return servers;
  } catch (err) {
    console.warn(`Ignoring DNS_SERVERS (${raw}): ${err.message}`);
    return null;
  }
}

/** Turn driver errors into something that names the actual next step. */
function explain(error, uri) {
  const msg = String(error.message || '');
  const isSrv = String(uri).startsWith('mongodb+srv://');

  if (/querySrv|ECONNREFUSED.*_mongodb\._tcp|ESERVFAIL|ENOTFOUND.*_mongodb/.test(msg)) {
    return [
      'The DNS lookup for your cluster failed, so the driver never reached Atlas.',
      '',
      'This is a DNS problem on this machine, not an Atlas or password problem.',
      'Note that `nslookup` succeeding does not rule it out — Node uses its own',
      'resolver, not the one nslookup uses.',
      '',
      'Fix it one of these ways, easiest first:',
      '',
      '  1. Add this to .env and restart (affects this app only):',
      '       DNS_SERVERS=8.8.8.8,1.1.1.1',
      '',
      '  2. Or skip SRV lookups entirely by using the non-SRV connection',
      '     string. In Atlas: Connect -> Drivers -> pick "Node.js 2.2.12 or',
      '     earlier". You get a plain mongodb:// URI listing all three hosts.',
      '     It needs no SRV record and works on networks that block them.',
      '',
      '  3. Or, if you are on a VPN or company network, disconnect and retry —',
      '     both commonly block SRV queries.',
      '',
      'Run `npm run check:db` for a step-by-step diagnosis.',
    ].join('\n');
  }

  if (/Authentication failed|bad auth/i.test(msg)) {
    return [
      'Atlas was reached, but rejected the username or password.',
      '',
      '  - Check the user under Atlas -> Database Access.',
      '  - If the password contains @ : / ? # [ ] or %, it must be',
      '    percent-encoded in the URI (@ becomes %40, # becomes %23).',
      '  - The database user password is not your Atlas login password.',
    ].join('\n');
  }

  if (/IP that isn't whitelisted|not allowed to connect|whitelist/i.test(msg)) {
    return [
      'Atlas was reached, but this machine\'s IP is not allowed.',
      '',
      'Atlas -> Network Access -> Add IP Address. Use 0.0.0.0/0 to test,',
      'then narrow it down afterwards.',
    ].join('\n');
  }

  if (/timed out|ETIMEDOUT|ServerSelectionError/i.test(msg)) {
    return [
      'Found the cluster but could not open a connection before timing out.',
      '',
      '  - Is the cluster paused? Atlas pauses free clusters after inactivity.',
      '  - Is your IP allowed under Atlas -> Network Access?',
      '  - A firewall may be blocking outbound port 27017.',
    ].join('\n');
  }

  if (!isSrv && /ENOTFOUND/.test(msg)) {
    return 'That hostname does not resolve. Check the cluster address in MONGO_URI for typos.';
  }

  return null;
}

const connectDB = async () => {
  const uri = process.env.MONGO_URI;

  if (!uri) {
    console.error('MONGO_URI is not set. Copy .env.example to .env and fill it in.');
    console.error('The variable must be named MONGO_URI exactly — not MONGODB_URI.');
    process.exit(1);
  }

  // A quoted value is a common .env mistake and produces baffling errors
  if (/^["']|["']$/.test(uri)) {
    console.error('MONGO_URI is wrapped in quotes. Remove them — .env values are literal.');
    process.exit(1);
  }

  if (!/^mongodb(\+srv)?:\/\//.test(uri)) {
    console.error(`MONGO_URI does not look like a connection string: ${maskUri(uri)}`);
    console.error('It should start with mongodb+srv:// (Atlas) or mongodb:// (local).');
    process.exit(1);
  }

  const dnsServers = applyDnsOverride();
  if (dnsServers) console.log(`DNS override active: ${dnsServers.join(', ')}`);

  try {
    const conn = await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 15000,
      /**
       * Force IPv4. On Windows the resolver often returns an IPv6 address
       * first, and if the network has no working IPv6 route the connection
       * stalls until it times out rather than failing fast.
       */
      family: 4,
    });
    console.log(`MongoDB connected: ${conn.connection.host}/${conn.connection.name}`);
    return conn;
  } catch (error) {
    console.error('\n─────────────────────────────────────────────');
    console.error('MongoDB connection failed');
    console.error('─────────────────────────────────────────────');
    console.error(`URI:   ${maskUri(uri)}`);
    console.error(`Error: ${error.message}\n`);

    const advice = explain(error, uri);
    if (advice) console.error(advice + '\n');

    // The full object, for anything the cases above do not cover
    if (process.env.DEBUG_DB) console.error(error);
    else console.error('Set DEBUG_DB=1 in .env for the full stack trace.\n');

    process.exit(1);
  }
};

module.exports = connectDB;
module.exports.maskUri = maskUri;
module.exports.explain = explain;
