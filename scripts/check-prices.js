require('dotenv').config();

/**
 * Why is the asset value zero?
 *
 * The total is a plain sum of every item's `price`, so a zero means one of a
 * small number of things, and they need completely different fixes. This
 * tells you which, by looking at the actual data rather than guessing:
 *
 *   1. no items at all              — nothing to add up
 *   2. items exist, no prices set   — the total is correct, the register is
 *                                     just incomplete. Fill prices in.
 *   3. prices stored as text        — "45000" instead of 45000. A sum skips
 *                                     non-numeric values silently, which is
 *                                     the one case that looks like a bug in
 *                                     the code and is not.
 *   4. prices are set and add up    — then the total is not really zero and
 *                                     something else is wrong. Say so.
 *
 * Run: npm run check:prices
 */

const mongoose = require('mongoose');
const connectDB = require('../config/db');
const Product = require('../models/Product');
const Location = require('../models/Location');

const money = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;
const ok = (m) => console.log(`  \x1b[32mOK\x1b[0m    ${m}`);
const warn = (m) => console.log(`  \x1b[33mNOTE\x1b[0m  ${m}`);
const bad = (m) => console.log(`  \x1b[31mFAIL\x1b[0m  ${m}`);
const info = (m) => console.log(`        ${m}`);

(async () => {
  await connectDB();

  const total = await Product.countDocuments({});
  console.log(`\nItems on the register: ${total}`);

  if (total === 0) {
    bad('There are no items at all, so the value can only be zero.');
    return mongoose.connection.close();
  }

  /**
   * Counted with the raw driver, not through mongoose, so the numbers are
   * what MongoDB actually holds. Mongoose would cast a string price to a
   * number on the way out and hide the very problem being looked for.
   */
  const raw = mongoose.connection.db.collection('products');

  const [priced, zero, missing, textPriced] = await Promise.all([
    raw.countDocuments({ price: { $type: 'number', $gt: 0 } }),
    raw.countDocuments({ price: { $type: 'number', $lte: 0 } }),
    raw.countDocuments({ $or: [{ price: { $exists: false } }, { price: null }] }),
    raw.countDocuments({ price: { $type: 'string' } }),
  ]);

  console.log('\nHow the prices are stored');
  info(`with a real price   : ${priced}`);
  info(`priced at zero      : ${zero}`);
  info(`no price field      : ${missing}`);
  info(`price stored as TEXT: ${textPriced}`);

  const agg = await Product.aggregate([{ $group: { _id: null, value: { $sum: '$price' } } }]);
  const sum = agg[0] ? agg[0].value : 0;
  console.log(`\nWhat the dashboard adds up to: ${money(sum)}`);

  console.log('\nWhat this means');

  if (textPriced > 0) {
    bad(`${textPriced} item(s) have their price stored as text, not a number.`);
    info('A sum skips those silently, which is why the total looks wrong.');
    info('Fix them with:  npm run fix:prices');
  }

  if (priced === 0 && textPriced === 0) {
    warn('No item has a price recorded, so zero is the correct total.');
    info('The register is complete on everything except price.');
    info('Add prices on each item, or import them, and the total will fill in.');
  }

  if (priced > 0 && sum > 0) {
    ok(`${priced} item(s) are priced and they add up to ${money(sum)}.`);
    info('If the dashboard still shows zero, the data is fine and the');
    info('problem is elsewhere — say so and it can be looked at.');
  }

  // Where the gaps are, so they can be filled in studio by studio
  const studios = await Location.find().sort({ name: 1 }).lean();
  if (studios.length) {
    console.log('\nBy studio');
    for (const s of studios) {
      const [count, withPrice, value] = await Promise.all([
        Product.countDocuments({ location: s._id }),
        raw.countDocuments({ location: s._id, price: { $type: 'number', $gt: 0 } }),
        Product.aggregate([
          { $match: { location: s._id } },
          { $group: { _id: null, value: { $sum: '$price' } } },
        ]),
      ]);
      const studioSum = value[0] ? value[0].value : 0;
      info(
        `${s.name.padEnd(14)} ${String(count).padStart(4)} items · ` +
          `${String(withPrice).padStart(4)} priced · ${money(studioSum)}`
      );
    }
  }

  // A handful of the unpriced ones, so it is obvious which they are
  const unpriced = await Product.find({ $or: [{ price: 0 }, { price: null }, { price: { $exists: false } }] })
    .select('name assetTag category')
    .limit(10)
    .lean();

  if (unpriced.length) {
    console.log('\nSome of the items with no price');
    unpriced.forEach((p) => info(`${(p.assetTag || '—').padEnd(12)} ${p.name}`));
    const more = missing + zero - unpriced.length;
    if (more > 0) info(`…and ${more} more`);
  }

  console.log('');
  await mongoose.connection.close();
})().catch((err) => {
  console.error('\nCould not check prices:', err.message);
  process.exit(1);
});
