const User = require('../models/User');
const Admin = require('../models/Admin');
const Product = require('../models/Product');
const AssignmentRequest = require('../models/AssignmentRequest');
const Booking = require('../models/Booking');
const { occupyProduct, releaseProduct } = require('../services/occupancy');
const { createBooking } = require('../services/booking');
const approvals = require('../services/approvals');
const NextClaim = require('../models/NextClaim');
const { createClaim, releaseForClaim, keepDespiteClaim } = require('../services/claims');
const { notifyUser, notifyAdmins } = require('./notify');
const { setSession, getSession, clearSession } = require('./sessions');
const views = require('./views');
const { escapeHtml, formatWhen, formatDuration, todayKey, parseDateKey, formatDay } = require('../utils/format');

const HTML = { parse_mode: 'HTML' };

/* ------------------------------------------------------------------ *
 * small helpers
 * ------------------------------------------------------------------ */

/**
 * Images are attached as a link preview rather than a full photo message.
 * `prefer_small_media` asks Telegram for the compact thumbnail instead of the
 * full-width picture, and because the message stays a text message it can
 * still be edited in place as the person taps around.
 *
 * The zero-width anchor is a fallback: older Telegram clients ignore
 * link_preview_options but will still preview a link found in the text.
 */
function withThumb(view) {
  const opts = { ...HTML, reply_markup: view.keyboard };

  if (!view.photo) {
    opts.link_preview_options = { is_disabled: true };
    return { text: view.text, opts };
  }

  opts.link_preview_options = {
    url: view.photo,
    prefer_small_media: true,
    show_above_text: true,
  };
  return { text: `<a href="${escapeHtml(view.photo)}">\u200B</a>${view.text}`, opts };
}

function send(bot, chatId, view) {
  const { text, opts } = withThumb(view);
  return bot.sendMessage(chatId, text, opts);
}

// Callback taps edit the message in place so the chat does not fill up
async function replace(bot, query, view) {
  const { text, opts } = withThumb(view);
  try {
    await bot.editMessageText(text, {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      ...opts,
    });
  } catch (err) {
    // Telegram rejects an edit when the text is unchanged, or when the original
    // message was a photo. Sending a fresh message covers both.
    await bot.sendMessage(query.message.chat.id, text, opts);
  }
}

/**
 * A grid of item pictures for a category. Telegram takes 2–10 photos in one
 * album and lays them out small. One bad URL rejects the whole album, so a
 * failure just means the category list arrives without pictures.
 */
async function sendPhotoGrid(bot, chatId, media) {
  if (media.length < 2) return null;
  try {
    return await bot.sendMediaGroup(chatId, media.slice(0, 10));
  } catch (err) {
    return null;
  }
}

const signedInUser = (chatId) =>
  User.findOne({ telegramChatId: String(chatId), status: 'active' });

const signedInAdmin = (chatId) =>
  Admin.findOne({ telegramChatId: String(chatId), status: 'active' });

const pendingCounts = async () => ({
  requests: await AssignmentRequest.countDocuments({ status: 'pending' }),
  bookings: await Booking.countDocuments({ status: 'pending' }),
});

const showAdminMenu = async (bot, chatId, admin) =>
  send(bot, chatId, views.adminMenu(admin, await pendingCounts()));

// Look up the display names for whoever is holding things
async function holderNames(items) {
  const ids = [...new Set(items.filter((i) => i.assignedTo).map((i) => String(i.assignedTo)))];
  if (ids.length === 0) return {};
  const people = await User.find({ _id: { $in: ids } }, 'name').lean();
  return people.reduce((acc, p) => ({ ...acc, [String(p._id)]: p.name }), {});
}

const loadProducts = (filter = {}) => Product.find(filter).sort({ name: 1 }).lean();

// The viewer's own open request for an item, if they have one
const pendingRequestFor = (userId, productId) =>
  AssignmentRequest.findOne({ user: userId, product: productId, status: 'pending' }).lean();

const pendingRequestsOf = (userId) =>
  AssignmentRequest.find({ user: userId, status: 'pending' }).sort({ createdAt: -1 }).lean();

// Live bookings from today onwards, soonest first
const upcomingBookingsOf = (userId) =>
  Booking.find({
    user: userId,
    status: { $in: ['pending', 'confirmed'] },
    bookedFor: { $gte: todayKey() },
  })
    .sort({ bookedFor: 1 })
    .lean();

/**
 * Last step of the booking flow: day and reason are both in hand.
 * Power users get an instant confirmation; normal users' bookings go to
 * the admin, exactly like a request to take an item out right now.
 */
async function finishBooking(bot, chatId, user, productId, dateKey, reason, ack, query) {
  const product = await Product.findById(productId).lean();
  clearSession(chatId);

  if (!product) {
    if (ack) await ack('That item is gone');
    return send(bot, chatId, views.mainMenu(user));
  }

  try {
    const booking = await createBooking({ product, user, dateKey, reason, source: 'telegram' });

    if (booking.awaitingReturn) {
      // The item is out — its holder has been asked to submit it first
      if (ack) await ack('Booking filed — the holder has been asked to submit it');
      await send(bot, chatId, {
        text:
          `⏳ Your booking for <b>${escapeHtml(product.name)}</b> <code>${escapeHtml(product.assetTag)}</code> on <b>${escapeHtml(formatDay(dateKey))}</b> has been filed.\n` +
          `📝 For: ${escapeHtml(booking.reason || '—')}\n\n` +
          `The item is currently with <b>${escapeHtml(booking.holderNameAtCreation || 'someone')}</b> — ` +
          `they have been asked to submit it once their work is done. ` +
          `The admin will then confirm or cancel your booking, and you will get a message here either way.`,
        photo: product.imageUrl || null,
      });
    } else {
      if (ack) await ack('Booking sent to the admin');
      await send(bot, chatId, {
        text:
          `⏳ Your booking for <b>${escapeHtml(product.name)}</b> <code>${escapeHtml(product.assetTag)}</code> on <b>${escapeHtml(formatDay(dateKey))}</b> has been sent to the admin to confirm.\n` +
          `📝 For: ${escapeHtml(booking.reason || '—')}\n\n` +
          `You will get a message here as soon as it is confirmed or cancelled.`,
        photo: product.imageUrl || null,
      });
    }
  } catch (err) {
    const note =
      err.code === 'DAY_TAKEN' || err.code === 'DUPLICATE' || err.code === 'PAST_DATE' || err.code === 'RETIRED'
        ? err.message
        : 'Could not make that booking';
    if (ack) await ack(note.slice(0, 190));
    else await bot.sendMessage(chatId, note);
  }

  const view = await itemDetailView(product, user);
  return query ? replace(bot, query, view) : send(bot, chatId, view);
}


const waitingClaimsOf = (userId) =>
  NextClaim.find({ user: userId, status: 'waiting' }).sort({ createdAt: -1 }).lean();

// One place that assembles the item screen, pending state included
async function itemDetailView(item, user) {
  const holders = await holderNames([item]);
  const pending = await pendingRequestFor(user._id, item._id);
  const claim = await NextClaim.findOne({ product: item._id, status: 'waiting' }).lean();
  return views.itemDetail(item, holders[String(item.assignedTo)], user, pending, claim);
}

/**
 * Last step of a next-in-line claim: reason is in hand, so file it and tell
 * the holder. Power users only — the service enforces that too.
 */
async function finishClaim(bot, chatId, user, productId, reason, ack, query) {
  const product = await Product.findById(productId).lean();
  clearSession(chatId);

  if (!product) {
    if (ack) await ack('That item is gone');
    return send(bot, chatId, views.mainMenu(user));
  }

  try {
    const claim = await createClaim({ product, user, reason, source: 'telegram' });
    if (ack) await ack('You are next in line');
    await send(bot, chatId, {
      text:
        `⚡ You are <b>next in line</b> for <b>${escapeHtml(product.name)}</b> <code>${escapeHtml(product.assetTag)}</code>.\n` +
        (claim.reason ? `📝 For: ${escapeHtml(claim.reason)}\n` : '') +
        `\n${escapeHtml(claim.holderName || 'The holder')} has been asked to release it. ` +
        `Even if they keep it for now, it comes straight to you the moment they return it.`,
      photo: product.imageUrl || null,
    });
  } catch (err) {
    const note = ['NOT_POWER', 'NOT_OCCUPIED', 'ALREADY_YOURS', 'ALREADY_CLAIMED', 'QUEUE_TAKEN'].includes(err.code)
      ? err.message
      : 'Could not claim that one';
    if (ack) await ack(note.slice(0, 190));
    else await bot.sendMessage(chatId, note);
  }

  const view = await itemDetailView(product, user);
  return query ? replace(bot, query, view) : send(bot, chatId, view);
}

// Every signed-in admin hears about a new request, with decision buttons
function pingAdminAboutRequest(request) {
  notifyAdmins(
    `🙋 <b>${escapeHtml(request.userName)}</b> is asking for ` +
      `<b>${escapeHtml(request.productName)}</b> <code>${escapeHtml(request.assetTag || '')}</code>.\n` +
      (request.reason ? `📝 ${escapeHtml(request.reason)}\n` : '') +
      `Tap to decide, or use the panel → Requests.`,
    {
      inline_keyboard: [
        [
          { text: '✅ Approve', callback_data: `aprq:${request._id}` },
          { text: '❌ Decline', callback_data: `rjrq:${request._id}` },
        ],
      ],
    }
  );
}

function groupByCategory(items) {
  const map = new Map();
  items.forEach((item) => {
    const g = map.get(item.category) || { category: item.category, total: 0, available: 0 };
    g.total += 1;
    if (views.isTakeable(item)) g.available += 1;
    map.set(item.category, g);
  });
  return [...map.values()].sort((a, b) => a.category.localeCompare(b.category));
}

const askForEmail = (bot, chatId) =>
  bot.sendMessage(
    chatId,
    'Welcome to the studio inventory bot. 🎬\n\nSend me your <b>work email</b> to sign in.',
    HTML
  );

/**
 * The last step of the take-out flow, once the reason is in hand.
 *
 * A power user occupies the item on the spot. A normal user only files a
 * request: the item stays on the shelf until an admin approves it from the
 * panel, at which point the bot messages them.
 */
async function finishOccupy(bot, chatId, user, productId, reason, ack, query) {
  const product = await Product.findById(productId);
  clearSession(chatId);

  if (!product) {
    if (ack) await ack('That item is gone');
    return send(bot, chatId, views.mainMenu(user));
  }

  if (user.accountType === 'power') {
    try {
      await occupyProduct({ product, user, reason, source: 'telegram' });
      if (ack) await ack('Occupied — it is yours now');

      const confirmation =
        `📌 <b>${escapeHtml(product.name)}</b> <code>${escapeHtml(product.assetTag)}</code> is now with you.\n` +
        `Taken at ${formatWhen(product.occupiedAt)}\n` +
        `📝 For: ${escapeHtml(product.occupyReason || '—')}\n\n` +
        `Tap <b>Submit item</b> when you bring it back.`;

      await send(bot, chatId, { text: confirmation, photo: product.imageUrl || null });
    } catch (err) {
      // Someone else got there between the tap and the reason
      const note = err.code === 'ALREADY_OCCUPIED' ? 'Someone just took it' : err.message;
      if (ack) await ack(note);
      else await bot.sendMessage(chatId, note);
    }
  } else {
    // Normal account: file a request instead of taking the item
    const problem = product.assignedTo
      ? 'Someone just took it'
      : views.blockedReason(product)
        ? 'This item is not available right now'
        : null;

    if (problem) {
      if (ack) await ack(problem);
      else await bot.sendMessage(chatId, problem);
    } else {
      const duplicate = await pendingRequestFor(user._id, product._id);
      if (duplicate) {
        const note = 'You have already asked for this one — waiting for the admin';
        if (ack) await ack(note);
        else await bot.sendMessage(chatId, note);
      } else {
        const request = await AssignmentRequest.create({
          product: product._id,
          productName: product.name,
          assetTag: product.assetTag,
          imageUrl: product.imageUrl || null,
          user: user._id,
          userName: user.name,
          reason: (reason || '').trim().slice(0, 120) || null,
        });
        pingAdminAboutRequest(request);

        if (ack) await ack('Request sent to the admin');
        const confirmation =
          `🙋 Your request for <b>${escapeHtml(product.name)}</b> <code>${escapeHtml(product.assetTag)}</code> has been sent to the admin.\n` +
          `📝 For: ${escapeHtml(request.reason || '—')}\n\n` +
          `You will get a message here the moment it is approved or declined. ` +
          `Please do not take the item until then.`;
        await send(bot, chatId, { text: confirmation, photo: product.imageUrl || null });
      }
    }
  }

  const fresh = await Product.findById(productId).lean();
  const view = await itemDetailView(fresh, user);
  return query ? replace(bot, query, view) : send(bot, chatId, view);
}

/* ------------------------------------------------------------------ *
 * incoming text
 * ------------------------------------------------------------------ */

async function handleMessage(bot, msg) {
  if (!msg || !msg.text) return;
  const chatId = msg.chat.id;
  const text = msg.text.trim();

  // Commands
  if (text.startsWith('/')) {
    const command = text.split(/[\s@]/)[0].toLowerCase();
    const admin = await signedInAdmin(chatId);

    // An admin chat gets the admin menu, not the staff one
    if (admin) {
      if (command === '/logout') {
        clearSession(chatId);
        admin.telegramChatId = null;
        admin.telegramLinkedAt = null;
        await admin.save();
        return bot.sendMessage(chatId, 'Signed out. Send /start to sign in again.');
      }
      if (command === '/help') {
        return bot.sendMessage(
          chatId,
          [
            '<b>Admin chat</b>',
            '/start — open the admin menu',
            '/logout — sign out of this chat',
            '',
            'Every new request and booking arrives here with ✅ Approve and ❌ Decline buttons. The full panel is on the website.',
          ].join('\n'),
          HTML
        );
      }
      return showAdminMenu(bot, chatId, admin);
    }

    const user = await signedInUser(chatId);

    if (command === '/start' || command === '/login') {
      if (user) return send(bot, chatId, views.mainMenu(user));
      clearSession(chatId);
      setSession(chatId, { stage: 'awaitEmail' });
      return askForEmail(bot, chatId);
    }

    if (command === '/logout') {
      clearSession(chatId);
      if (user) {
        user.telegramChatId = null;
        user.telegramLinkedAt = null;
        await user.save();
      }
      return bot.sendMessage(chatId, 'Signed out. Send /start to sign in again.');
    }

    if (command === '/help') {
      return bot.sendMessage(
        chatId,
        [
          '<b>What I can do</b>',
          '/start — sign in or open the menu',
          '/items — browse categories',
          '/mine — what you are holding',
          '/logout — sign out of this chat',
          '',
          'Tap <b>Occupy now</b> to take an item, and <b>Submit item</b> when you bring it back.',
        ].join('\n'),
        HTML
      );
    }

    if (!user) {
      setSession(chatId, { stage: 'awaitEmail' });
      return askForEmail(bot, chatId);
    }

    if (command === '/items' || command === '/categories') {
      const items = await loadProducts();
      return send(bot, chatId, views.categoryList(groupByCategory(items)));
    }

    if (command === '/mine') {
      const mine = await loadProducts({ assignedTo: user._id });
      const pending = await pendingRequestsOf(user._id);
      const bookings = await upcomingBookingsOf(user._id);
      const claims = await waitingClaimsOf(user._id);
      return send(bot, chatId, views.myItems(mine, pending, bookings, claims));
    }

    return send(bot, chatId, views.mainMenu(user));
  }

  const session = getSession(chatId);

  // Someone typing a booking date
  if (session && session.stage === 'awaitBookDate') {
    const user = await signedInUser(chatId);
    if (!user) {
      clearSession(chatId);
      setSession(chatId, { stage: 'awaitEmail' });
      return askForEmail(bot, chatId);
    }

    const dateKey = parseDateKey(text);
    if (!dateKey) {
      return bot.sendMessage(chatId, 'I could not read that date. Send it as YYYY-MM-DD or DD-MM-YYYY, e.g. 25-08-2026.');
    }
    if (dateKey < todayKey()) {
      return bot.sendMessage(chatId, 'That day has already passed — send today\'s date or a future one.');
    }

    const item = await Product.findById(session.productId).lean();
    if (!item) {
      clearSession(chatId);
      return send(bot, chatId, views.mainMenu(user));
    }
    setSession(chatId, { stage: 'awaitBookReason', productId: session.productId, dateKey });
    return send(bot, chatId, views.bookReasonPrompt(item, dateKey));
  }

  // Someone typing the reason for a booking
  if (session && session.stage === 'awaitBookReason') {
    const user = await signedInUser(chatId);
    if (!user) {
      clearSession(chatId);
      setSession(chatId, { stage: 'awaitEmail' });
      return askForEmail(bot, chatId);
    }

    const reason = text.slice(0, 120);
    if (reason.length < 2) {
      return bot.sendMessage(chatId, 'Please give a slightly longer reason, or tap one of the buttons.');
    }
    return finishBooking(bot, chatId, user, session.productId, session.dateKey, reason, null, null);
  }

  // Someone typing the reason for a next-in-line claim
  if (session && session.stage === 'awaitClaimReason') {
    const user = await signedInUser(chatId);
    if (!user) {
      clearSession(chatId);
      setSession(chatId, { stage: 'awaitEmail' });
      return askForEmail(bot, chatId);
    }

    const reason = text.slice(0, 120);
    if (reason.length < 2) {
      return bot.sendMessage(chatId, 'Please give a slightly longer reason, or tap one of the buttons.');
    }
    return finishClaim(bot, chatId, user, session.productId, reason, null, null);
  }

  // Someone typing the reason they need an item for
  if (session && session.stage === 'awaitReason') {
    const user = await signedInUser(chatId);
    if (!user) {
      clearSession(chatId);
      setSession(chatId, { stage: 'awaitEmail' });
      return askForEmail(bot, chatId);
    }

    const reason = text.slice(0, 120);
    if (reason.length < 2) {
      return bot.sendMessage(chatId, 'Please give a slightly longer reason, or tap one of the buttons.');
    }
    return finishOccupy(bot, chatId, user, session.productId, reason, null, null);
  }

  // Sign-in conversation
  if (session && session.stage === 'awaitEmail') {
    const email = text.toLowerCase();
    const candidate = await User.findOne({ email }).select('+password');

    // Same reply either way, so the bot cannot be used to discover who has an account
    setSession(chatId, { stage: 'awaitPassword', email, userExists: !!candidate });
    return bot.sendMessage(chatId, 'Now send your <b>password</b>.', HTML);
  }

  if (session && session.stage === 'awaitPassword') {
    // The password should not sit in the chat history
    bot.deleteMessage(chatId, msg.message_id).catch(() => {});

    // An admin email signs the chat in as an admin; otherwise it is staff.
    const admin = await Admin.findOne({ email: session.email, status: 'active' }).select('+password');
    if (admin && (await admin.matchPassword(text))) {
      admin.telegramChatId = String(chatId);
      admin.telegramUsername = msg.from && msg.from.username ? msg.from.username : null;
      admin.telegramLinkedAt = new Date();
      await admin.save();
      clearSession(chatId);
      await bot.sendMessage(
        chatId,
        '🛡 You are signed in as an <b>admin</b>. New requests and bookings will arrive in this chat with approve and decline buttons.',
        HTML
      );
      return showAdminMenu(bot, chatId, admin);
    }

    const user = await User.findOne({ email: session.email }).select('+password');
    const ok = user && user.status === 'active' && (await user.matchPassword(text));

    if (!ok) {
      const attempts = (session.attempts || 0) + 1;
      if (attempts >= 3) {
        clearSession(chatId);
        return bot.sendMessage(
          chatId,
          'Too many failed attempts. Send /start to try again, or ask the admin to reset your password.'
        );
      }
      setSession(chatId, { ...session, attempts });
      return bot.sendMessage(
        chatId,
        `That did not match. ${3 - attempts} attempt${3 - attempts === 1 ? '' : 's'} left — send your password again.`
      );
    }

    user.telegramChatId = String(chatId);
    user.telegramUsername = msg.from && msg.from.username ? msg.from.username : null;
    user.telegramLinkedAt = new Date();
    await user.save();
    clearSession(chatId);

    return send(bot, chatId, views.mainMenu(user));
  }

  // Anything else
  const admin = await signedInAdmin(chatId);
  if (admin) return showAdminMenu(bot, chatId, admin);
  const user = await signedInUser(chatId);
  if (user) return send(bot, chatId, views.mainMenu(user));
  setSession(chatId, { stage: 'awaitEmail' });
  return askForEmail(bot, chatId);
}

/* ------------------------------------------------------------------ *
 * button taps
 * ------------------------------------------------------------------ */

async function handleCallback(bot, query) {
  const chatId = query.message.chat.id;
  const data = query.data || '';
  const ack = (text) => bot.answerCallbackQuery(query.id, text ? { text } : {}).catch(() => {});

  /* ---------- admin taps ---------- */
  const admin = await signedInAdmin(chatId);
  if (admin) {
    if (data === 'adm:menu' || data === 'menu') {
      await ack();
      return replace(bot, query, views.adminMenu(admin, await pendingCounts()));
    }

    if (data === 'adm:logout') {
      await ack('Signed out');
      admin.telegramChatId = null;
      admin.telegramLinkedAt = null;
      await admin.save();
      clearSession(chatId);
      return bot.sendMessage(chatId, 'Signed out. Send /start to sign in again.');
    }

    if (data === 'adm:reqs') {
      await ack();
      const pending = await AssignmentRequest.find({ status: 'pending' }).sort({ createdAt: 1 }).lean();
      if (pending.length === 0) return replace(bot, query, views.adminEmptyList('requests'));
      await replace(bot, query, {
        text: `📥 <b>${pending.length} pending request${pending.length === 1 ? '' : 's'}</b> — oldest first.`,
        keyboard: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'adm:menu' }]] },
      });
      for (const r of pending.slice(0, 10)) {
        await send(bot, chatId, views.adminRequestCard(r));
      }
      if (pending.length > 10) {
        await bot.sendMessage(chatId, `…and ${pending.length - 10} more on the website → Requests.`);
      }
      return null;
    }

    if (data === 'adm:bks') {
      await ack();
      const pending = await Booking.find({ status: 'pending' }).sort({ bookedFor: 1, createdAt: 1 }).lean();
      if (pending.length === 0) return replace(bot, query, views.adminEmptyList('bookings'));
      await replace(bot, query, {
        text: `📅 <b>${pending.length} pending booking${pending.length === 1 ? '' : 's'}</b> — soonest day first.`,
        keyboard: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'adm:menu' }]] },
      });
      for (const b of pending.slice(0, 10)) {
        await send(bot, chatId, views.adminBookingCard(b));
      }
      if (pending.length > 10) {
        await bot.sendMessage(chatId, `…and ${pending.length - 10} more on the website → Requests.`);
      }
      return null;
    }

    if (data === 'adm:busy') {
      await ack();
      const busy = await loadProducts({ assignedTo: { $ne: null } });
      const view = views.occupiedList(busy, await holderNames(busy));
      view.keyboard = { inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'adm:menu' }]] };
      return replace(bot, query, view);
    }

    // ✅ / ❌ on a request or booking card — one decision engine for bot and web
    const decide =
      data.startsWith('aprq:') ? () => approvals.approveRequest(data.slice(5), admin.email) :
      data.startsWith('rjrq:') ? () => approvals.rejectRequest(data.slice(5), admin.email, 'Declined from Telegram') :
      data.startsWith('apbk:') ? () => approvals.approveBooking(data.slice(5), admin.email) :
      data.startsWith('rjbk:') ? () => approvals.rejectBooking(data.slice(5), admin.email, 'Declined from Telegram') :
      null;

    if (decide) {
      const result = await decide();
      await ack(result.message.slice(0, 190));
      // Freeze the card so the buttons cannot be tapped twice
      const outcome = result.ok
        ? (data.startsWith('rj') ? '❌ Declined' : '✅ Approved')
        : `⚠️ ${result.message}`;
      const frozen = `${escapeHtml(query.message.text)}\n\n<b>${escapeHtml(outcome)} by ${escapeHtml(admin.name)}</b>`;
      await bot
        .editMessageText(frozen, {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: 'HTML',
        })
        .catch(() => {});
      return null;
    }

    // Any other tap in an admin chat goes back to the admin menu
    await ack();
    return replace(bot, query, views.adminMenu(admin, await pendingCounts()));
  }

  /* ---------- staff taps ---------- */
  const user = await signedInUser(chatId);
  if (!user) {
    await ack('Please sign in again');
    setSession(chatId, { stage: 'awaitEmail' });
    return askForEmail(bot, chatId);
  }

  if (data === 'menu') {
    await ack();
    return replace(bot, query, views.mainMenu(user));
  }

  if (data === 'cats') {
    await ack();
    const items = await loadProducts();
    return replace(bot, query, views.categoryList(groupByCategory(items)));
  }

  if (data.startsWith('cat:')) {
    await ack();
    const category = data.slice(4);
    const items = await loadProducts({ category });
    const holders = await holderNames(items);
    const view = views.itemList(category, items, holders);

    // Pictures for the whole category, then the list you can tap through
    const photos = views.categoryPhotos(items, holders);
    if (photos.length >= 2) {
      await sendPhotoGrid(bot, chatId, photos);
      return send(bot, chatId, view);
    }
    if (photos.length === 1) {
      return replace(bot, query, { ...view, photo: photos[0].media });
    }
    return replace(bot, query, view);
  }

  if (data === 'mine') {
    await ack();
    const mine = await loadProducts({ assignedTo: user._id });
    const pending = await pendingRequestsOf(user._id);
    const bookings = await upcomingBookingsOf(user._id);
    const claims = await waitingClaimsOf(user._id);
    return replace(bot, query, views.myItems(mine, pending, bookings, claims));
  }

  if (data === 'busy') {
    await ack();
    const busy = await loadProducts({ assignedTo: { $ne: null } });
    return replace(bot, query, views.occupiedList(busy, await holderNames(busy)));
  }

  if (data === 'logout') {
    await ack('Signed out');
    user.telegramChatId = null;
    user.telegramLinkedAt = null;
    await user.save();
    clearSession(chatId);
    return bot.sendMessage(chatId, 'Signed out. Send /start to sign in again.');
  }

  if (data.startsWith('item:')) {
    await ack();
    const item = await Product.findById(data.slice(5)).lean();
    if (!item) return replace(bot, query, views.mainMenu(user));
    return replace(bot, query, await itemDetailView(item, user));
  }

  // ⚡ "Book next in line" on an occupied item (power users)
  if (data.startsWith('nxt:')) {
    const product = await Product.findById(data.slice(4)).lean();
    if (!product) {
      await ack('That item is gone');
      return replace(bot, query, views.mainMenu(user));
    }
    if (!product.assignedTo) {
      await ack('It is free — just occupy it');
      return replace(bot, query, await itemDetailView(product, user));
    }
    if (user.accountType !== 'power') {
      await ack('Only power accounts can claim the next turn');
      return replace(bot, query, await itemDetailView(product, user));
    }
    const existing = await NextClaim.findOne({ product: product._id, status: 'waiting' }).lean();
    if (existing) {
      await ack(String(existing.user) === String(user._id) ? 'You are already next in line' : `${existing.userName} is already next in line`);
      return replace(bot, query, await itemDetailView(product, user));
    }

    await ack();
    const holders = await holderNames([product]);
    setSession(chatId, { stage: 'awaitClaimReason', productId: String(product._id) });
    return send(bot, chatId, views.claimReasonPrompt(product, holders[String(product.assignedTo)]));
  }

  // A tapped quick reason for a claim
  if (data.startsWith('nrsn:')) {
    const [, productId, index] = data.split(':');
    const reason = views.QUICK_REASONS[Number(index)];
    return finishClaim(bot, chatId, user, productId, reason, ack, query);
  }

  // "Type my own" for a claim
  if (data.startsWith('nrsnown:')) {
    await ack();
    setSession(chatId, { stage: 'awaitClaimReason', productId: data.slice(8) });
    return bot.sendMessage(chatId, 'Send the reason in a few words (up to 120 characters).');
  }

  // Claimant cancelling their own claim
  if (data.startsWith('nxtcxl:')) {
    const claim = await NextClaim.findOne({
      _id: data.slice(7),
      user: user._id,
      status: 'waiting',
    });
    if (!claim) {
      await ack('That claim has already been dealt with');
    } else {
      claim.status = 'cancelled';
      claim.decidedAt = new Date();
      await claim.save();
      await ack('Claim cancelled');
      // The holder no longer needs to decide anything
      const holder = claim.holder ? await User.findById(claim.holder).lean() : null;
      if (holder && holder.telegramChatId) {
        notifyUser(
          holder.telegramChatId,
          `✖️ ${escapeHtml(claim.userName)} no longer needs <b>${escapeHtml(claim.productName)}</b> — you can ignore the earlier request.`
        );
      }
    }
    const item = claim ? await Product.findById(claim.product).lean() : null;
    if (item) return replace(bot, query, await itemDetailView(item, user));
    const mine = await loadProducts({ assignedTo: user._id });
    return replace(bot, query, views.myItems(mine, await pendingRequestsOf(user._id), await upcomingBookingsOf(user._id), await waitingClaimsOf(user._id)));
  }

  // Holder tapping ✅ Release now on a claim notification
  if (data.startsWith('hrel:')) {
    const result = await releaseForClaim(data.slice(5), user);
    await ack(result.message.slice(0, 190));
    const frozen = `${escapeHtml(query.message.text)}\n\n<b>${escapeHtml(result.ok ? `✅ ${result.message}` : `⚠️ ${result.message}`)}</b>`;
    await bot
      .editMessageText(frozen, { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'HTML' })
      .catch(() => {});
    return null;
  }

  // Holder tapping 🙅 Keep it for now
  if (data.startsWith('hkeep:')) {
    const result = await keepDespiteClaim(data.slice(6), user);
    await ack(result.message.slice(0, 190));
    const frozen = `${escapeHtml(query.message.text)}\n\n<b>${escapeHtml(result.ok ? `🙅 ${result.message}` : `⚠️ ${result.message}`)}</b>`;
    await bot
      .editMessageText(frozen, { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'HTML' })
      .catch(() => {});
    return null;
  }

  // Tapping "Occupy now" / "Request this item" asks what it is for first
  if (data.startsWith('occ:')) {
    const product = await Product.findById(data.slice(4)).lean();
    if (!product) {
      await ack('That item is gone');
      return replace(bot, query, views.mainMenu(user));
    }
    if (product.assignedTo) {
      await ack('Someone just took it');
      return replace(bot, query, await itemDetailView(product, user));
    }
    if (user.accountType !== 'power') {
      const duplicate = await pendingRequestFor(user._id, product._id);
      if (duplicate) {
        await ack('You have already asked for this one');
        return replace(bot, query, await itemDetailView(product, user));
      }
    }

    await ack();
    setSession(chatId, { stage: 'awaitReason', productId: String(product._id) });
    return send(bot, chatId, views.reasonPrompt(product, user.accountType !== 'power'));
  }

  // "Book for a date" — show the day picker
  if (data.startsWith('bk:')) {
    const product = await Product.findById(data.slice(3)).lean();
    if (!product) {
      await ack('That item is gone');
      return replace(bot, query, views.mainMenu(user));
    }
    if (product.condition === 'retired') {
      await ack('This item is retired');
      return replace(bot, query, await itemDetailView(product, user));
    }
    await ack();
    clearSession(chatId);
    return replace(bot, query, views.bookDayPrompt(product, user.accountType === 'power'));
  }

  // A tapped day
  if (data.startsWith('bkd:')) {
    const [, productId, dateKey] = data.split(':');
    const product = await Product.findById(productId).lean();
    if (!product) {
      await ack('That item is gone');
      return replace(bot, query, views.mainMenu(user));
    }
    await ack();
    setSession(chatId, { stage: 'awaitBookReason', productId, dateKey });
    return replace(bot, query, views.bookReasonPrompt(product, dateKey));
  }

  // "Type another date"
  if (data.startsWith('bkdown:')) {
    await ack();
    setSession(chatId, { stage: 'awaitBookDate', productId: data.slice(7) });
    return bot.sendMessage(chatId, 'Send the date as YYYY-MM-DD or DD-MM-YYYY, e.g. 25-08-2026.');
  }

  // A tapped quick reason for a booking
  if (data.startsWith('bkr:')) {
    const [, productId, dateKey, index] = data.split(':');
    const reason = views.QUICK_REASONS[Number(index)];
    return finishBooking(bot, chatId, user, productId, dateKey, reason, ack, query);
  }

  // "Type my own reason" for a booking
  if (data.startsWith('bkrown:')) {
    const [, productId, dateKey] = data.split(':');
    await ack();
    setSession(chatId, { stage: 'awaitBookReason', productId, dateKey });
    return bot.sendMessage(chatId, 'Send the reason in a few words (up to 120 characters).');
  }

  // Cancelling one of your own bookings
  if (data.startsWith('bkcxl:')) {
    const booking = await Booking.findOne({
      _id: data.slice(6),
      user: user._id,
      status: { $in: ['pending', 'confirmed'] },
    });
    if (!booking) {
      await ack('That booking has already been dealt with');
    } else {
      booking.status = 'cancelled';
      booking.decidedAt = new Date();
      await booking.save();
      await ack('Booking cancelled');
    }
    const mine = await loadProducts({ assignedTo: user._id });
    const pending = await pendingRequestsOf(user._id);
    const bookings = await upcomingBookingsOf(user._id);
    const claims = await waitingClaimsOf(user._id);
    return replace(bot, query, views.myItems(mine, pending, bookings, claims));
  }

  // A normal user cancelling their own pending request
  if (data.startsWith('cxl:')) {
    const request = await AssignmentRequest.findOne({
      _id: data.slice(4),
      user: user._id,
      status: 'pending',
    });
    if (!request) {
      await ack('That request has already been dealt with');
    } else {
      request.status = 'cancelled';
      request.decidedAt = new Date();
      await request.save();
      await ack('Request cancelled');
    }

    const item = request ? await Product.findById(request.product).lean() : null;
    if (item) return replace(bot, query, await itemDetailView(item, user));
    const mine = await loadProducts({ assignedTo: user._id });
    const pending = await pendingRequestsOf(user._id);
    const bookings = await upcomingBookingsOf(user._id);
    return replace(bot, query, views.myItems(mine, pending, bookings));
  }

  // A tapped quick reason
  if (data.startsWith('rsn:')) {
    const [, productId, index] = data.split(':');
    const reason = views.QUICK_REASONS[Number(index)];
    return finishOccupy(bot, chatId, user, productId, reason, ack, query);
  }

  // "Type my own"
  if (data.startsWith('rsnown:')) {
    await ack();
    setSession(chatId, { stage: 'awaitReason', productId: data.slice(7) });
    return bot.sendMessage(chatId, 'Send the reason in a few words (up to 120 characters).');
  }

  if (data.startsWith('ret:')) {
    const product = await Product.findById(data.slice(4));
    if (!product) {
      await ack('That item is gone');
      return replace(bot, query, views.mainMenu(user));
    }

    if (!product.assignedTo || String(product.assignedTo) !== String(user._id)) {
      await ack('That one is not with you');
      const fresh = await Product.findById(product._id).lean();
      return replace(bot, query, await itemDetailView(fresh, user));
    }

    const log = await releaseProduct({ product, source: 'telegram' });
    await ack('Returned — thank you');
    await bot.sendMessage(
      chatId,
      `✅ <b>${escapeHtml(product.name)}</b> <code>${escapeHtml(product.assetTag)}</code> is back on the shelf.\nYou had it for ${formatDuration(log ? log.durationMinutes : null)}.`,
      HTML
    );

    const fresh = await Product.findById(product._id).lean();
    return replace(bot, query, await itemDetailView(fresh, user));
  }

  return ack();
}

module.exports = { handleMessage, handleCallback, groupByCategory, holderNames };
