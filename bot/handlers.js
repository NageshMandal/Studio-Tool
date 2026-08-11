const User = require('../models/User');
const Product = require('../models/Product');
const { occupyProduct, releaseProduct } = require('../services/occupancy');
const { setSession, getSession, clearSession } = require('./sessions');
const views = require('./views');
const { escapeHtml, formatWhen, formatDuration } = require('../utils/format');

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

// Look up the display names for whoever is holding things
async function holderNames(items) {
  const ids = [...new Set(items.filter((i) => i.assignedTo).map((i) => String(i.assignedTo)))];
  if (ids.length === 0) return {};
  const people = await User.find({ _id: { $in: ids } }, 'name').lean();
  return people.reduce((acc, p) => ({ ...acc, [String(p._id)]: p.name }), {});
}

const loadProducts = (filter = {}) => Product.find(filter).sort({ name: 1 }).lean();

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
 * The last step of taking an item out: the reason is in hand, so occupy it.
 * Shared by the quick-pick buttons and the typed-in reason.
 */
async function finishOccupy(bot, chatId, user, productId, reason, ack, query) {
  const product = await Product.findById(productId);
  clearSession(chatId);

  if (!product) {
    if (ack) await ack('That instrument is gone');
    return send(bot, chatId, views.mainMenu(user));
  }

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

  const fresh = await Product.findById(productId).lean();
  const holders = await holderNames([fresh]);
  const view = views.itemDetail(fresh, holders[String(fresh.assignedTo)], user._id);
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
          'Tap <b>Occupy now</b> to take an instrument, and <b>Submit item</b> when you bring it back.',
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
      return send(bot, chatId, views.myItems(mine));
    }

    return send(bot, chatId, views.mainMenu(user));
  }

  const session = getSession(chatId);

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
    return replace(bot, query, views.myItems(mine));
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
    const holders = await holderNames([item]);
    return replace(bot, query, views.itemDetail(item, holders[String(item.assignedTo)], user._id));
  }

  // Tapping "Occupy now" asks what it is for before handing the item over
  if (data.startsWith('occ:')) {
    const product = await Product.findById(data.slice(4)).lean();
    if (!product) {
      await ack('That instrument is gone');
      return replace(bot, query, views.mainMenu(user));
    }
    if (product.assignedTo) {
      await ack('Someone just took it');
      const holders = await holderNames([product]);
      return replace(bot, query, views.itemDetail(product, holders[String(product.assignedTo)], user._id));
    }

    await ack();
    setSession(chatId, { stage: 'awaitReason', productId: String(product._id) });
    return send(bot, chatId, views.reasonPrompt(product));
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
      await ack('That instrument is gone');
      return replace(bot, query, views.mainMenu(user));
    }

    if (!product.assignedTo || String(product.assignedTo) !== String(user._id)) {
      await ack('That one is not with you');
      const fresh = await Product.findById(product._id).lean();
      const holders = await holderNames([fresh]);
      return replace(bot, query, views.itemDetail(fresh, holders[String(fresh.assignedTo)], user._id));
    }

    const log = await releaseProduct({ product, source: 'telegram' });
    await ack('Returned — thank you');
    await bot.sendMessage(
      chatId,
      `✅ <b>${escapeHtml(product.name)}</b> <code>${escapeHtml(product.assetTag)}</code> is back on the shelf.\nYou had it for ${formatDuration(log ? log.durationMinutes : null)}.`,
      HTML
    );

    const fresh = await Product.findById(product._id).lean();
    return replace(bot, query, views.itemDetail(fresh, null, user._id));
  }

  return ack();
}

module.exports = { handleMessage, handleCallback, groupByCategory, holderNames };
