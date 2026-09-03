# Studio Tracker

Multi-studio equipment tracking with a four-tier role system, per-location
monthly reporting, and a staff purchase-request workflow that stays private to
each studio.

Express · EJS · MongoDB · JWT · optional Telegram bot.

---

## Troubleshooting the database connection

```bash
npm run check:db
```

This tests four layers separately and stops at the first that fails: the
`.env` value, DNS, the TCP path to the cluster, then Atlas credentials. Most
"cannot connect" errors are one specific layer, and the messages say which.

### `querySrv ECONNREFUSED _mongodb._tcp.<cluster>.mongodb.net`

The most common Atlas error, and the most misread. A `mongodb+srv://` URI
makes the driver do a **DNS SRV lookup** before it talks to Atlas at all.
This error means the resolver Node is using refused that lookup — so Atlas is
never contacted, and it is **not** a password or IP-allow-list problem.

`nslookup` succeeding does not rule this out. Node uses its own bundled
resolver, not the one nslookup uses. A stale VPN entry, a router that refuses
SRV queries, or a dead IPv6 DNS entry will break Node while nslookup keeps
working.

Fix it one of these ways, easiest first:

1. **Point this app at public DNS.** Add to `.env` and restart:
   ```
   DNS_SERVERS=8.8.8.8,1.1.1.1
   ```
   Affects this process only; nothing else on the machine changes.

2. **Skip SRV entirely.** In Atlas: *Connect → Drivers →* choose
   **"Node.js 2.2.12 or earlier"**. That gives a plain `mongodb://` URI
   listing all three hosts, needing no SRV record. Works on networks and VPNs
   that block SRV queries.

3. **Disconnect from any VPN or company network** and retry.

### Other notes

- The variable must be named `MONGO_URI` exactly — not `MONGODB_URI`.
- Do not wrap the value in quotes.
- If the password contains `@ : / ? # [ ] %`, percent-encode it
  (`@` → `%40`, `#` → `%23`).
- `DEBUG_DB=1` in `.env` prints full stack traces on connection failure.

---

## The role model

Everything in the system belongs to exactly one **studio**. Who can see which
studio is decided by role, and enforced in the route layer rather than left to
individual queries.

| Role | Scope | Can do | Cannot do |
|---|---|---|---|
| **Super admin** | All studios | Create studios, appoint one location admin each, open any studio dashboard, master dashboard, cross-studio reports | **See purchase requests** |
| **Location admin** | One studio | Everything at their studio: items, staff, approvals, reports. Decides purchase requests. Creates managers | Touch another studio |
| **Location manager** | One studio | Same as above, minus admin accounts, deleting, and approving purchases | Manage admins, delete, approve purchases |
| **Staff** | One studio | Take out / request / book equipment, raise purchase requests | See other studios |

The super admin lives only in `.env`. It has no database row, so it cannot be
edited, deactivated or deleted from the panel.

**One location admin per studio.** Adding a second is refused, with a message
pointing you at the manager role instead — so exactly one person is accountable
for each studio's approvals and budget.

---

## Purchase requests are studio-private

Staff (typically sales, who hit missing kit first) ask their own studio to buy
something it does not own: item name, why it is needed, an optional buy link,
quantity, price, urgency, needed-by date, plus free-form label/value rows for
anything else.

Two rules are deliberate:

1. **Only that studio sees it.** Not a company-wide purchase queue.
2. **The super admin cannot see it.** `blockSuper` sits in front of every
   purchase-request route, so a super admin who types the URL gets an
   explanatory 403 rather than an empty list. Telegram alerts go to that
   studio's admins only.

Lifecycle: `pending → approved → ordered → received → on the register`. The last
step creates a real item with its own asset tag, linked back to the request.

---

## Setup

```bash
npm install
cp .env.example .env        # fill in MONGO_URI and JWT_SECRET
npm run setup               # seeds Patna / Ranchi / Kolkata, adopts existing data
npm run dev
```

Then sign in at `/login` with the `ADMIN_EMAIL` / `ADMIN_PASSWORD` from `.env`.

Add `npm run setup:demo` instead for sample staff and equipment at each studio
(demo staff password: `Staff@12345`).

### Migrating an existing database

`npm run setup` is **idempotent and non-destructive**. Run it as many times as
you like:

- Records with no studio are adopted into the first studio, not deleted.
- Existing admins become the location admin at that studio (or managers, if one
  already exists) rather than being guessed at.
- **Old `STU-` asset tags are left alone.** Those labels are already stuck on
  real equipment; renumbering them would make every printed tag wrong. New items
  number per studio (`PAT-0001`, `RAN-0001`).

---

## First run

1. Sign in as the super admin → you land on **Select your studio**.
2. **Studios → Add studio** for each location. The 2–5 letter code becomes the
   asset-tag prefix and is permanent.
3. **Admin accounts → Add admin** → create one *location admin* per studio.
4. That admin signs in and lands straight on their own dashboard — no studio
   switcher, because there is nothing for them to switch to.
5. They add their studio's items and staff, and create *location managers* if
   they want help.

---

## Layout

```
models/
  Location.js            studios — the spine of the permission model
  Admin.js               three admin tiers, tied to a studio
  User.js                staff, one studio each, with a sales flag
  Product.js             items, per-studio asset tags
  ProcurementRequest.js  staff purchase requests (studio-private)
  UsageLog.js            every movement — the monthly report is built from these
  Booking.js  NextClaim.js  AssignmentRequest.js  Notification.js  Counter.js

middleware/
  auth.js                sessions, capability map, role guards, blockSuper
  scope.js               req.scope.filter() and req.scope.owns() — the choke point
  staffAuth.js           staff sessions, studio re-read on every request

controllers/             one per area; none builds a location filter by hand
services/                occupancy, bookings, claims, approvals, notifications
routes/                  guards applied here: protect → withScope → role guard
views/                   EJS, light canvas + navy sidebar
scripts/setup.js         seed and migrate
```

### Why scoping lives in middleware

Controllers never write `{ location: ... }` themselves. They call
`req.scope.filter()` and get the right clause for whoever is signed in, and
`req.scope.owns(doc)` after any lookup by id. That second check is the one that
matters: without it a Ranchi admin could edit a Patna camera by pasting its id
into the URL, and the filtered list page would never reveal that they had.

---

## Verification

Four self-checks ship with the project:

```bash
node diag-check.js      # database error diagnostics give the right advice
node perm-check.js      # 30 assertions on the permission rules
node render-check.js    # every page rendered for every role
node lay-check.js       # every layout and sidebar, per role
node boot-check.js      # boots the app, checks route wiring (stubbed DB)
node dept-check.js      # free-text department normalisation and suggestions
```

`perm-check.js` is the important one — it asserts, as facts, that the super
admin cannot reach procurement, that a location admin cannot manage another
studio's people, and that scope filters pin the right studio.

These were used during development and are safe to delete.

---

## Staff departments

The department field on a staff account is **free text**, so each studio can
name its own teams — "Post Production", "Client Servicing", whatever they
actually use — without waiting for a code change.

The form is a normal text input with a `<datalist>` behind it, so the browser
suggests departments already in use at that studio (with the built-in list
behind them) while still accepting anything typed. Leaving it blank stores
`Studio`.

Two things keep the list from fragmenting, which is the usual cost of moving a
field from a dropdown to free text:

- Whitespace is collapsed and trimmed in the model's setter, so
  `"Post  Production "` and `"Post Production"` are the same value.
- On save, a typed name is matched case-insensitively against departments
  already in use and the existing spelling is reused — so `sales`, `Sales` and
  `SALES` do not become three entries that split the staff list three ways.

The filter dropdown on the staff page is built from departments actually in
use at the current studio, so it stays relevant instead of listing options
nobody uses.

---

## Reports

Monthly, per studio, built from the usage log rather than live item state — so a
report for a past month keeps reading the same however equipment moves
afterwards. A loan that spans a month boundary counts for both months.

Includes movements, hours, utilisation (share of the register that actually
moved), busiest people and items, category breakdown, approvals, and CSV export.
Super admins also get a side-by-side comparison across all studios.

---

## Telegram bot

Optional — leave `TELEGRAM_BOT_TOKEN` blank and the panel runs without it.

Every equipment lookup in the bot is scoped to the signed-in person's own
studio, and request notifications go to that studio's admins only, so nobody's
phone buzzes for another branch's camera.
