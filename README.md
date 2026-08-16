# Office Studio Inventory — Admin Panel

Node.js + Express + EJS + MongoDB admin panel for tracking studio instruments and the staff who use them. The single admin account lives in `.env`; every protected route checks a JWT.

## Run it

```bash
npm install
cp .env.example .env      # then edit the values
npm run dev               # or: npm start
```

Open http://localhost:3000 and sign in with the `ADMIN_EMAIL` / `ADMIN_PASSWORD` from your `.env`.

Make sure MongoDB is running locally, or point `MONGO_URI` at an Atlas cluster.

## How auth works

- `POST /login` compares the submitted email and password against `ADMIN_EMAIL` and `ADMIN_PASSWORD` in `.env`. No admin record is stored in the database.
- On success a JWT signed with `JWT_SECRET` is set as an httpOnly cookie named `token`.
- `middleware/auth.js` verifies that token on every `/admin/*` and `/api/*` route. It also accepts `Authorization: Bearer <token>` so the JSON API works from Postman.
- Staff passwords are separate: those are stored in MongoDB, hashed with bcrypt, and are not used to sign in anywhere yet.

## Pages

| Route | What it does |
| --- | --- |
| `/login` | Admin sign in |
| `/admin/dashboard` | Counts, register value, recently added items |
| `/admin/products` | All instruments, with search and category/status filters |
| `/admin/products/new` | Add an instrument |
| `/admin/products/:id/edit` | Edit or reassign an instrument |
| `/admin/users` | All staff, with search and filters, inline password reset and activate/deactivate |
| `/admin/users/new` | Add a person |
| `/admin/users/:id/edit` | Edit details, optionally set a new password |
| `/admin/logs` | Daily usage log — who took what, when, and for how long |
| `/logout` | Clears the cookie |

## JSON API

```
POST   /api/auth/login       { email, password } -> { token }
GET    /api/me
GET    /api/products
POST   /api/products
GET    /api/products/:id
PUT    /api/products/:id
DELETE /api/products/:id
GET    /api/users
POST   /api/users
PUT    /api/users/:id
DELETE /api/users/:id
```

All except the login route need `Authorization: Bearer <token>`.

## Telegram bot (for staff)

Staff never touch the admin panel. They use a Telegram bot instead.

**Setup:** message `@BotFather` on Telegram, send `/newbot`, and paste the token into `TELEGRAM_BOT_TOKEN` in `.env`. Restart the app. Leave the token blank and the panel runs on its own — no bot.

The bot runs inside the same Node process using long polling, so it needs no public URL, no HTTPS and no webhook. It works from a laptop or an office machine behind NAT.

**How a staff member uses it:**

1. Opens the bot and sends `/start`.
2. Sends their **work email**, then their **password** — the same ones you set for them on the People page. The bot deletes the password message straight away so it does not sit in the chat history.
3. Their Telegram chat is now linked to their account. They stay signed in until they send `/logout` (or you unlink them from the People page).
4. **Browse categories** shows every category with a free-count, e.g. `Camera (2/3 free)`.
5. Opening a category lists its instruments with a status against each one: 🟢 available, 🔴 with a named person since a given time, 🛠 in maintenance, ⛔ retired.
6. Tapping an available item shows its details — with a photo, if the item has an image URL — and an **Occupy now** button.
7. **Occupy now** asks what the item is for before handing it over. There are five one-tap reasons (Client shoot, Studio recording, Editing work, Office event, Repair / check-up) and a **Type my own** option for anything else. Nothing is occupied until a reason is given, and the reason is capped at 120 characters.
8. **Submit item** returns it: the item goes back to available, and the log entry is closed with the total time held.

Commands: `/start`, `/items`, `/mine`, `/logout`, `/help`.

## Account types: power vs normal

Every staff member is either a **power** or a **normal** account. You set this on the People page (Add / Edit person → **Account type**). New and existing people default to **normal**.

- **Power user** — taps **📌 Occupy now** in the bot and the item is theirs immediately, exactly as before. No permission needed.
- **Normal user** — sees **🙋 Request this item** instead. Tapping it asks for a reason as usual, but nothing is handed over: a request is filed and sits at *pending* until you decide. The bot tells them their request has gone to the admin and that they should not take the item yet.

**Approving and declining** happens on the new **Requests** page (`/admin/requests`). The sidebar link carries a red badge with the pending count. The queue is oldest-first; each row shows the item (with its picture), who is asking, their reason, and how long ago they asked. **Approve** assigns the item through the same code path as every other assignment, so the usage log records it like any admin assignment (`source: admin`) with the requester's reason. **Decline** lets you type an optional note.

**The user is notified on Telegram either way** — "✅ Approved! The admin has assigned … to you" or "❌ your request was declined", including your note if you wrote one. Returning an approved item works exactly like any other: **Submit item** from `/mine`.

Rules the request flow enforces:

- A normal user can never occupy anything directly — the request is the only way.
- One pending request per person per item; asking again just reminds them it is pending.
- A pending request can be cancelled by the user from the item screen or `/mine`.
- If the item is taken, retired, or in maintenance by the time you press Approve, the approval safely fails: the request is auto-declined with the reason and the user is told.
- Deleting a person or an instrument cancels its pending requests.
- Requests already decided stay visible under **Recent decisions** on the same page.

Optional: set `ADMIN_TELEGRAM_CHAT_ID` in `.env` to your own Telegram chat id and the bot messages you the moment a new request comes in. Leave it unset and the Requests page badge is your inbox.

## Admins in the Telegram bot

The **same bot** now serves admins too. An admin opens the bot, sends `/start`, and signs in with their **admin email and password** — the bot recognises the email as an admin account and switches that chat into admin mode.

What an admin chat gets:

- **Every notification, instantly.** Each new occupy request and each new booking from a normal user is pushed to **every signed-in admin** the moment it is made — whether it came from the bot or the website — with **✅ Approve / ❌ Decline buttons right on the message**. One tap decides it; the person is notified; the card is stamped with who decided so another admin cannot decide it twice.
- **An admin menu** (`/start`): pending requests and pending bookings as tappable cards with the same buttons, plus everything occupied right now.
- The web panel's Requests page and the bot buttons share one decision engine, so a request approved on the website shows "already dealt with" if someone taps it in Telegram, and vice versa.
- `/logout` unlinks the chat.

`ADMIN_TELEGRAM_CHAT_ID` in `.env` still works and is simply included in the broadcast — handy for the root admin, whose account lives in `.env` and cannot sign in to the bot by email.

## Multiple admins

Admins can create more admins on the new **Admins** page (`/admin/admins`):

- Add an admin with a name, email and password. They can immediately sign in to the **web panel** at `/login` and to the **Telegram bot** with those credentials — same powers as you.
- Inline password reset, activate/deactivate, and delete. You cannot deactivate or delete **yourself**, and deactivating an admin also unlinks their Telegram chat so they stop receiving notifications.
- The **root admin** from `.env` is listed as a fixed row for reference but is managed only through `.env` — it can never be edited or removed from the panel.
- Every decision records **which admin made it** (shown under Recent decisions on the Requests page).

## Next in line: claiming an occupied instrument

A power user no longer has to sit and wait for an occupied item. On any instrument that is out with someone else, a power account sees **⚡ Book next in line** (in the bot) or **⚡ Book next** (on the staff site). After giving a reason:

- **The current holder is told immediately** — a Telegram message with **✅ Release now / 🙅 Keep it for now** buttons, and the same choice on their staff page, where the held item shows "*X is waiting for this*" with **Release** and **Keep** buttons. The holder decides.
- **Release now** → the item is returned and handed **straight to the claimant** in one step. The claimant gets a Telegram message that it is theirs; both movements are in the usage log (`source: auto` for the hand-over).
- **Keep it** → the claimant is told the holder still needs it. But the claim is not wasted: it stays attached to the item, and…
- **…whenever the holder returns the item normally** — bot, website, either way — it does **not** go back on the shelf: it is handed to the claimant automatically, with a notification. First tap on a busy camera means it is yours the moment it is free.

Rules: power accounts only; one waiting claimant per instrument (first come); the claimant can cancel any time (the holder is told to ignore the earlier ask); a claim expires safely if the item goes to maintenance on return, if today is booked for someone else, or if the claimant is deactivated — with a message explaining why. The admin panel's Requests page shows a read-only **Next in line** panel of every live claim. Swapping holders from the admin product form ignores claims on purpose — the admin's explicit choice wins.

## Advance bookings (book an item for a date)

Anyone can reserve an instrument for a future day — from the Telegram bot (**📅 Book for a date** on any item) or from the staff website. The same account-type rule applies:

- **Power user** — the booking is confirmed instantly.
- **Normal user** — the booking goes to the admin as *pending*, and the person is told the decision on Telegram.

How it works:

- A booking is for a **whole day**, stored as a date like `2026-08-25`. In the bot you tap Today/Tomorrow/this-week buttons or type a date (`YYYY-MM-DD` or `DD-MM-YYYY`); on the website you use a date picker.
- Bookings must be for **today or later** — the past cannot be booked.
- One day, one holder: a day already confirmed for someone else cannot be double-booked, and approving a pending booking for a taken day fails safely.
- A booking **reserves priority**, it does not occupy the item by itself. On the day, the person occupies it as usual — and while a confirmed booking is live for today, **nobody else can occupy that item** (the admin panel can still override).
- An occupied item can still be booked for a future day.
- Everyone sees and cancels their own bookings under `/mine` in the bot or on the staff site. Admin decides pending bookings and can cancel confirmed ones on the **Requests** page, which also lists everything booked ahead. The sidebar badge counts pending bookings too.

## Staff website (`/staff`)

Staff can use a browser instead of (or as well as) the bot. They sign in at `/staff/login` with the **same email and password** as the Telegram bot. The portal shows:

- What they are holding, with a **Submit item** button to return things.
- Their pending requests and upcoming bookings, each with a cancel button.
- The full catalog by category with live status — and per item, **Occupy now** (power) or **Request item** (normal, goes to the admin dashboard), plus **Book a date**.

The web portal enforces exactly the same rules as the bot — same account types, same approval flow, same booking checks — because both go through the same code. Web actions appear in the usage log with `source: web`. The staff session is a separate cookie from the admin one, so both can be signed in side by side.

## Public shelf view (`/`)

The home page is now a **public, no-login catalog**: every instrument grouped by category with its live status — available, occupied (with holder and since when), in maintenance, or retired — plus totals at the top. Handy for a wall-mounted screen in the studio. Buttons in the header lead to the staff and admin sign-ins. Viewing is all it allows; taking or booking anything requires signing in.

**Rules the bot enforces**

- Only active staff can sign in; deactivated people are refused.
- Three wrong passwords ends the attempt.
- An unknown email gets the same password prompt as a real one, so the bot cannot be used to find out who has an account.
- Two people cannot occupy the same item — whoever taps first gets it, and the second person is told it was just taken.
- You can only submit an item that is actually with you.
- Retired and needs-repair items cannot be taken out at all.
- An item flagged as needs-repair goes back to **maintenance** on return, not into the available pool.
- Every reason is visible to the whole team: browsing a category shows `🔴 With Ravi Kumar · since 10 Aug, 2:15 pm` followed by `📝 Client shoot`.

## Images

Give an instrument an **Image URL** on the product form and the picture shows up in four places: the instrument list, the dashboard, the usage log, and the Telegram bot.

In Telegram the picture is attached as a **small link preview**, not a full-width photo, using `prefer_small_media`. That keeps the thumbnail compact and, because the message stays a text message, the bot can edit it in place as you tap around instead of stacking new messages in the chat. Older Telegram clients that ignore `prefer_small_media` still show a preview, because the image link is also embedded in the message as a zero-width anchor.

Selecting a category sends the pictures for that category as a photo grid (an album) followed by the tappable list. Telegram allows 2–10 photos per album, so a category with a single picture uses the compact preview instead, and one with more than ten shows the first ten and says so.

Images are referenced by URL — the app does not host files. Point it at whatever you already use: Google Drive direct links, S3, Cloudinary, or your own web server. The product form previews the URL as you type, so you can tell straight away if a link is wrong.

Nothing breaks without an image. Admin rows fall back to a monogram tile with the first letter of the instrument name. In the bot, an unreachable URL simply means no preview appears — and because Telegram rejects an entire album if any one photo cannot be fetched, a bad link in a category means the list still arrives, just without the photo grid.

## Where the usage log comes from

`/admin/logs` reads the `UsageLog` collection. One document is written per session: it opens when someone occupies an item and closes when they submit it, storing `occupiedAt`, `returnedAt` and `durationMinutes`.

Admin actions write to the same log. Assigning an instrument to someone from the product edit form is recorded exactly like a bot occupy, just with `source: 'admin'`, so the log is never missing a movement. Item and person names are copied into each entry, so old log rows still read correctly after an instrument or a staff member is deleted.

Each entry also stores the **reason** the item was taken and a copy of its image URL, so the log row still shows the right picture and purpose even after the instrument itself is edited or deleted.

The page defaults to today, with arrows for previous days and a search box for an item, tag or person. The summary strip shows how many went out, how many came back, how many are still out, total hours in use, and who moved the most gear.

When you assign an instrument to someone from the admin product form, the **Taken for** field on that form is recorded as the reason, exactly as a bot reason would be.

## Notes

- Each instrument gets a sequential asset tag (`STU-0001`, `STU-0002`) generated on first save via the `Counter` collection.
- The product list has an **Availability** column: available, occupied (with the holder's name), or in maintenance, plus how long it has been out.
- Occupancy is per instrument, not per unit. An item with `quantity: 5` is taken as a whole, not five times over.
- `TIMEZONE` in `.env` (default `Asia/Kolkata`) controls what counts as "today" on the log page and how times are shown.
- Deleting a person releases every instrument assigned to them back to store.
- Forms use `method-override`, so `PUT`, `PATCH` and `DELETE` work from plain HTML forms.

## Next steps you might want

- File uploads for instrument photos (multer) instead of an image URL field.
- File uploads for images (multer) instead of pasting a URL.
- Per-unit occupancy, so five of the same cable can go to five people.
- A nightly reminder from the bot to anyone still holding something.
- CSV export of the usage log for a chosen date range.
