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
