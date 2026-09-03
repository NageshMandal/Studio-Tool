const Location = require('../models/Location');

/**
 * Studio names, cached.
 *
 * Usage logs, requests, bookings and claims all copy the studio name in
 * alongside its id, so a monthly report never needs a join and still reads
 * correctly after a studio is renamed or archived. That means a name lookup
 * on nearly every write, which would be a wasteful round trip for a value
 * that changes perhaps twice a year.
 *
 * The cache is deliberately simple: a plain map with a short time to live.
 * A stale name for a few minutes costs nothing (the id is always authoritative,
 * and the name is only ever display text), while a missed cache just falls
 * back to a normal query.
 */

const TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // id -> { name, at }

/** The studio's display name, or null if it has been deleted. */
async function studioName(locationId) {
  if (!locationId) return null;
  const key = String(locationId);

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.name;

  try {
    const studio = await Location.findById(key, 'name').lean();
    const name = studio ? studio.name : null;
    cache.set(key, { name, at: Date.now() });
    return name;
  } catch (err) {
    // A name is decoration; never fail a real action over it
    return hit ? hit.name : null;
  }
}

/** Drop a cached name, so a rename shows up immediately. */
function forget(locationId) {
  if (locationId) cache.delete(String(locationId));
  else cache.clear();
}

module.exports = { studioName, forget };
