require('dotenv').config();

/**
 * Converts item prices stored as text into real numbers.
 *
 * A price saved as "45000" instead of 45000 is skipped by the sum behind the
 * asset value, silently — the item looks priced on its own page while
 * contributing nothing to the total. That is the one version of this problem
 * that looks like a bug in the code and is not, so it gets a repair rather
 * than an explanation.
 *
 * Values like "₹45,000" and "45,000.50" are read; anything that is not a
 * number at all is listed and left alone rather than being guessed at.
 *
 * Run `npm run check:prices` first to see whether this applies to you.
 * Run: npm run fix:prices
 */

const mongoose = require('mongoose');
const connectDB = require('../config/db');

const money = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;

/** "₹45,000.50" -> 45000.5, and null for anything that is not a number. */
function readPrice(text) {
  const cleaned = String(text).replace(/[^0-9.]/g, '');
  if (!cleaned) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

(async () => {
  await connectDB();

  // The raw driver, because mongoose would cast the strings on the way out
  // and there would be nothing left to find
  const products = mongoose.connection.db.collection('products');
  const rows = await products.find({ price: { $type: 'string' } }).toArray();

  if (rows.length === 0) {
    console.log('\nNo prices are stored as text. Nothing to repair.\n');
    return mongoose.connection.close();
  }

  console.log(`\n${rows.length} item(s) have a price stored as text.\n`);

  let fixed = 0;
  const skipped = [];

  for (const row of rows) {
    const value = readPrice(row.price);
    if (value === null) {
      skipped.push(row);
      continue;
    }
    await products.updateOne({ _id: row._id }, { $set: { price: value } });
    console.log(`  fixed  ${(row.assetTag || '—').padEnd(12)} ${row.name}  "${row.price}" -> ${money(value)}`);
    fixed++;
  }

  if (skipped.length) {
    console.log(`\n${skipped.length} could not be read and were left exactly as they are:`);
    skipped.forEach((r) => console.log(`  ${(r.assetTag || '—').padEnd(12)} ${r.name}  "${r.price}"`));
    console.log('Set these by hand on the item page.');
  }

  console.log(`\nDone: ${fixed} repaired, ${skipped.length} left alone.\n`);
  await mongoose.connection.close();
})().catch((err) => {
  console.error('\nCould not repair prices:', err.message);
  process.exit(1);
});
