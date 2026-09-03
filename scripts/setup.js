require('dotenv').config();

const mongoose = require('mongoose');
const connectDB = require('../config/db');

const Location = require('../models/Location');
const Admin = require('../models/Admin');
const User = require('../models/User');
const Product = require('../models/Product');
const UsageLog = require('../models/UsageLog');
const AssignmentRequest = require('../models/AssignmentRequest');
const Booking = require('../models/Booking');
const NextClaim = require('../models/NextClaim');
const Counter = require('../models/Counter');

/**
 * Setup and migration.
 *
 * Safe to run on an empty database (it seeds the three studios from the
 * design) and safe to run on an existing one (it adopts orphaned records
 * into a default studio rather than deleting anything).
 *
 * It is also idempotent: running it twice changes nothing the second time,
 * which matters because the natural instinct after a half-finished migration
 * is to run it again.
 *
 *   node scripts/setup.js              seed studios, adopt orphans
 *   node scripts/setup.js --demo       also create demo staff and items
 */

const DEMO = process.argv.includes('--demo');

const STUDIOS = [
  { name: 'Patna', code: 'PAT', city: 'Patna', theme: 'green' },
  { name: 'Ranchi', code: 'RAN', city: 'Ranchi', theme: 'blue' },
  { name: 'Kolkata', code: 'KOL', city: 'Kolkata', theme: 'purple' },
];

const log = (msg) => console.log(`  ${msg}`);

async function ensureStudios() {
  console.log('\nStudios');
  const created = [];
  for (const s of STUDIOS) {
    let studio = await Location.findOne({ code: s.code });
    if (studio) {
      log(`${s.name} already exists`);
    } else {
      studio = await Location.create({ ...s, createdBy: process.env.ADMIN_EMAIL });
      log(`created ${s.name} (${s.code})`);
    }
    created.push(studio);
  }
  return created;
}

/**
 * Anything from before the multi-studio change has no `location`. Those
 * records are adopted into the first studio rather than dropped — the whole
 * point of a migration is that the previous owner's history survives it.
 */
async function adoptOrphans(defaultStudio) {
  console.log('\nAdopting records that predate studios');

  const collections = [
    ['items', Product],
    ['staff', User],
    ['usage logs', UsageLog],
    ['equipment requests', AssignmentRequest],
    ['bookings', Booking],
    ['next-in-line claims', NextClaim],
  ];

  for (const [label, Model] of collections) {
    const result = await Model.updateMany(
      { $or: [{ location: null }, { location: { $exists: false } }] },
      { $set: { location: defaultStudio._id } }
    );
    if (result.modifiedCount) {
      log(`moved ${result.modifiedCount} ${label} into ${defaultStudio.name}`);
    } else {
      log(`no orphaned ${label}`);
    }
  }

  // Log rows also carry the studio name for reporting
  await UsageLog.updateMany(
    { location: defaultStudio._id, locationName: { $in: [null, ''] } },
    { $set: { locationName: defaultStudio.name } }
  );

  /**
   * Old asset tags were global (STU-0001). They are left exactly as they
   * are: those labels are already stuck on real equipment, and silently
   * renumbering them would make every printed tag wrong. New items at each
   * studio simply start from that studio's own prefix.
   */
  const legacy = await Product.countDocuments({ assetTag: /^STU-/ });
  if (legacy) {
    log(`${legacy} items keep their original STU- tags (already printed — not renumbered)`);
  }
}

/**
 * Existing admins predate roles. Rather than guess, they become location
 * admins at the default studio if that studio has no primary admin yet, and
 * managers otherwise — so exactly one person ends up accountable per studio.
 */
async function migrateAdmins(defaultStudio) {
  console.log('\nAdmin accounts');

  const legacy = await Admin.find({
    $or: [{ role: { $exists: false } }, { location: null }, { location: { $exists: false } }],
  });

  if (!legacy.length) {
    log('nothing to migrate');
  }

  for (const admin of legacy) {
    const hasPrimary = await Admin.findOne({
      location: defaultStudio._id,
      role: 'location_admin',
      _id: { $ne: admin._id },
    });
    admin.role = hasPrimary ? 'location_manager' : 'location_admin';
    admin.location = defaultStudio._id;
    await admin.save({ validateBeforeSave: false });
    log(`${admin.email} → ${admin.role} at ${defaultStudio.name}`);
  }

  console.log('\nSuper admin');
  log(`${process.env.ADMIN_EMAIL} (from .env) — always a super admin, no database row needed`);
}

async function seedDemo(studios) {
  console.log('\nDemo data');

  const existing = await Product.countDocuments();
  if (existing > 0) {
    log('the register already has items — skipping demo data');
    return;
  }

  const people = [
    { name: 'Rahul Kumar', dept: 'Studio', role: 'staff', type: 'power' },
    { name: 'Priya Singh', dept: 'Production', role: 'staff', type: 'normal' },
    { name: 'Aman Raj', dept: 'Sales', role: 'sales', type: 'normal' },
  ];

  const kit = [
    { name: 'Sony FX3 body', category: 'Camera', brand: 'Sony', price: 320000 },
    { name: 'Canon RF 24-70 f/2.8', category: 'Lens', brand: 'Canon', price: 185000 },
    { name: 'Rode NTG5 shotgun mic', category: 'Audio', brand: 'Rode', price: 42000 },
    { name: 'Manfrotto 504X tripod', category: 'Tripod', brand: 'Manfrotto', price: 38000 },
    { name: 'Aputure 300d light', category: 'Lighting', brand: 'Aputure', price: 78000 },
  ];

  for (const studio of studios) {
    for (const p of people) {
      const email = `${p.name.split(' ')[0].toLowerCase()}.${studio.code.toLowerCase()}@office.com`;
      if (await User.findOne({ email })) continue;
      await User.create({
        name: p.name,
        email,
        password: 'Staff@12345',
        location: studio._id,
        department: p.dept,
        staffRole: p.role,
        accountType: p.type,
        designation: p.dept + ' team',
      });
    }

    for (const k of kit) {
      await Product.create({ ...k, location: studio._id, condition: 'good', status: 'available' });
    }

    log(`${studio.name}: ${people.length} staff, ${kit.length} items`);
  }

  log('demo staff password: Staff@12345');
}

async function summary() {
  console.log('\nCurrent state');
  const studios = await Location.find({ status: 'active' }).sort({ name: 1 }).lean();
  for (const s of studios) {
    const [items, staff, admins] = await Promise.all([
      Product.countDocuments({ location: s._id }),
      User.countDocuments({ location: s._id }),
      Admin.countDocuments({ location: s._id }),
    ]);
    const primary = await Admin.findOne({ location: s._id, role: 'location_admin' }).lean();
    log(
      `${s.name.padEnd(10)} ${String(items).padStart(3)} items  ` +
        `${String(staff).padStart(3)} staff  ${String(admins).padStart(2)} admins  ` +
        `${primary ? 'admin: ' + primary.email : 'NO LOCATION ADMIN YET'}`
    );
  }
}

(async () => {
  try {
    await connectDB();

    const studios = await ensureStudios();
    const defaultStudio = studios[0];

    await adoptOrphans(defaultStudio);
    await migrateAdmins(defaultStudio);
    if (DEMO) await seedDemo(studios);
    await summary();

    console.log('\nDone.');
    console.log(`\nSign in as the super admin with ${process.env.ADMIN_EMAIL}`);
    console.log('Then: Studios → add a location admin for each studio from Admin accounts.\n');

    await mongoose.connection.close();
    process.exit(0);
  } catch (err) {
    console.error('\nSetup failed:', err.message);
    process.exit(1);
  }
})();
