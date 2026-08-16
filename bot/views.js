const { formatWhen, formatSince, escapeHtml, todayKey, formatDay, shiftDay } = require('../utils/format');

const AVAILABLE = '🟢';
const OCCUPIED = '🔴';
const MAINTENANCE = '🛠';
const RETIRED = '⛔';

/**
 * Why an instrument cannot be taken out right now, ignoring who holds it.
 * One place, so the list counts, the icons and the buttons never disagree.
 */
function blockedReason(product) {
  if (product.condition === 'retired') return 'retired';
  if (product.status === 'maintenance' || product.condition === 'needs-repair') return 'maintenance';
  return null;
}

// Free to pick up right now
function isTakeable(product) {
  return !product.assignedTo && !blockedReason(product);
}

// What a row in a list looks like
function statusIcon(product) {
  const blocked = blockedReason(product);
  if (blocked === 'retired') return RETIRED;
  if (blocked) return MAINTENANCE;
  return product.assignedTo ? OCCUPIED : AVAILABLE;
}

function availabilityLine(product, holderName) {
  const blocked = blockedReason(product);
  if (blocked === 'retired') return `${RETIRED} Retired — no longer in use`;
  if (blocked) return `${MAINTENANCE} In maintenance`;
  if (!product.assignedTo) return `${AVAILABLE} Available`;

  const line = `${OCCUPIED} With ${escapeHtml(holderName || 'someone')} · since ${formatWhen(product.occupiedAt)} (${formatSince(product.occupiedAt)})`;
  return product.occupyReason ? `${line}\n   📝 ${escapeHtml(product.occupyReason)}` : line;
}

// Tap-friendly reasons, so most people never have to type
const QUICK_REASONS = [
  'Client shoot',
  'Studio recording',
  'Editing work',
  'Office event',
  'Repair / check-up',
];

function reasonPrompt(item, isRequest = false) {
  const rows = QUICK_REASONS.map((reason, i) => [
    { text: reason, callback_data: `rsn:${item._id}:${i}` },
  ]);
  rows.push([{ text: '✍️ Type my own reason', callback_data: `rsnown:${item._id}` }]);
  rows.push([{ text: '✖️ Cancel', callback_data: `item:${item._id}` }]);

  const tail = isRequest
    ? `Your request will be sent to the admin — you will get a message here as soon as it is approved.`
    : `Tap a reason below, or just type one in a few words.`;

  return {
    text:
      `What do you need <b>${escapeHtml(item.name)}</b> for?\n\n` +
      tail,
    keyboard: { inline_keyboard: rows },
  };
}

/**
 * Day picker for a booking: today plus the next seven days as buttons, with
 * a type-your-own fallback for anything further out.
 */
function bookDayPrompt(item, isPower) {
  const rows = [];
  for (let i = 0; i <= 7; i += 2) {
    const row = [];
    for (let j = i; j < i + 2 && j <= 7; j += 1) {
      const key = shiftDay(todayKey(), j);
      const label = j === 0 ? 'Today' : j === 1 ? 'Tomorrow' : formatDay(key);
      row.push({ text: label, callback_data: `bkd:${item._id}:${key}` });
    }
    rows.push(row);
  }
  rows.push([{ text: '✍️ Type another date', callback_data: `bkdown:${item._id}` }]);
  rows.push([{ text: '✖️ Cancel', callback_data: `item:${item._id}` }]);

  const tail = isPower
    ? 'Your booking is confirmed instantly — the item is reserved for you that whole day.'
    : 'Your booking goes to the admin for approval. You will get a message here with the decision.';

  return {
    text:
      `📅 Book <b>${escapeHtml(item.name)}</b> for which day?\n\n${tail}`,
    keyboard: { inline_keyboard: rows },
  };
}

// Same quick reasons as taking an item out, but for a chosen day
function bookReasonPrompt(item, dateKey) {
  const rows = QUICK_REASONS.map((reason, i) => [
    { text: reason, callback_data: `bkr:${item._id}:${dateKey}:${i}` },
  ]);
  rows.push([{ text: '✍️ Type my own reason', callback_data: `bkrown:${item._id}:${dateKey}` }]);
  rows.push([{ text: '✖️ Cancel', callback_data: `item:${item._id}` }]);

  return {
    text:
      `Booking <b>${escapeHtml(item.name)}</b> for <b>${escapeHtml(formatDay(dateKey))}</b>.\n\n` +
      `What is it for?`,
    keyboard: { inline_keyboard: rows },
  };
}

function mainMenu(user) {
  return {
    text:
      `Hi ${escapeHtml(user.name)} 👋\n\n` +
      `You are signed in as <code>${escapeHtml(user.email)}</code>.\n` +
      `Pick a category to see what is on the shelf, or check what you are holding.`,
    keyboard: {
      inline_keyboard: [
        [{ text: '📂 Browse categories', callback_data: 'cats' }],
        [{ text: '🎒 What I am holding', callback_data: 'mine' }],
        [{ text: '🔴 Occupied right now', callback_data: 'busy' }],
        [{ text: '🚪 Sign out', callback_data: 'logout' }],
      ],
    },
  };
}

function categoryList(groups) {
  if (groups.length === 0) {
    return {
      text: 'Nothing is on the register yet. Ask the admin to add the studio instruments.',
      keyboard: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'menu' }]] },
    };
  }

  const lines = groups.map(
    (g) => `<b>${escapeHtml(g.category)}</b> — ${g.available} of ${g.total} free`
  );

  const rows = groups.map((g) => [
    {
      text: `${g.category} (${g.available}/${g.total})`,
      callback_data: `cat:${g.category}`,
    },
  ]);
  rows.push([{ text: '⬅️ Back', callback_data: 'menu' }]);

  return {
    text: `<b>Categories</b>\n\n${lines.join('\n')}`,
    keyboard: { inline_keyboard: rows },
  };
}

/**
 * Photo grid for a category: one entry per item that has an image, captioned
 * with its name and current availability. Telegram caps an album at 10.
 */
function categoryPhotos(items, holders = {}) {
  return items
    .filter((item) => item.imageUrl)
    .slice(0, 10)
    .map((item) => ({
      type: 'photo',
      media: item.imageUrl,
      caption: `${statusIcon(item)} <b>${escapeHtml(item.name)}</b> · <code>${escapeHtml(item.assetTag)}</code>`,
      parse_mode: 'HTML',
    }));
}

function itemList(category, items, holders) {
  if (items.length === 0) {
    return {
      text: `No instruments in <b>${escapeHtml(category)}</b> yet.`,
      keyboard: { inline_keyboard: [[{ text: '⬅️ Categories', callback_data: 'cats' }]] },
    };
  }

  const lines = items.map((item) => {
    const holder = item.assignedTo ? holders[String(item.assignedTo)] : null;
    return `${statusIcon(item)} <b>${escapeHtml(item.name)}</b>\n   <code>${escapeHtml(item.assetTag)}</code> · ${availabilityLine(item, holder)}`;
  });

  const rows = items.map((item) => [
    {
      text: `${statusIcon(item)} ${item.name}`.slice(0, 60),
      callback_data: `item:${item._id}`,
    },
  ]);
  rows.push([{ text: '⬅️ Categories', callback_data: 'cats' }]);

  const withPhotos = items.filter((i) => i.imageUrl).length;
  const photoNote =
    withPhotos > 10 ? `\n\n<i>Showing the first 10 pictures.</i>` : '';

  return {
    text: `<b>${escapeHtml(category)}</b>\n\n${lines.join('\n\n')}${photoNote}`,
    keyboard: { inline_keyboard: rows },
  };
}

/**
 * `viewer` is the signed-in user document (or just its _id for callers that
 * never show a take-out button). `pendingRequest` is the viewer's own open
 * request for this item, if any.
 */
function itemDetail(item, holderName, viewer, pendingRequest = null) {
  const viewerId = viewer && viewer._id ? viewer._id : viewer;
  const isPower = !!(viewer && viewer.accountType === 'power');
  const heldByViewer = item.assignedTo && String(item.assignedTo) === String(viewerId);

  const details = [
    `<b>${escapeHtml(item.name)}</b>`,
    `<code>${escapeHtml(item.assetTag)}</code> · ${escapeHtml(item.category)}`,
  ];
  if (item.brand || item.model) {
    details.push(`Model: ${escapeHtml([item.brand, item.model].filter(Boolean).join(' '))}`);
  }
  if (item.location) details.push(`Kept at: ${escapeHtml(item.location)}`);
  if (item.serialNumber) details.push(`Serial: ${escapeHtml(item.serialNumber)}`);
  if (item.notes) details.push(`Note: ${escapeHtml(item.notes)}`);
  details.push('');
  details.push(availabilityLine(item, holderName));

  if (pendingRequest) {
    details.push(`\n⏳ You have asked for this item — waiting for the admin to approve.`);
    if (pendingRequest.reason) details.push(`📝 ${escapeHtml(pendingRequest.reason)}`);
  }

  const rows = [];

  if (heldByViewer) {
    rows.push([{ text: '✅ Submit item (return it)', callback_data: `ret:${item._id}` }]);
  } else if (pendingRequest) {
    rows.push([{ text: '✖️ Cancel my request', callback_data: `cxl:${pendingRequest._id}` }]);
  } else if (isTakeable(item)) {
    rows.push([
      isPower
        ? { text: '📌 Occupy now', callback_data: `occ:${item._id}` }
        : { text: '🙋 Request this item', callback_data: `occ:${item._id}` },
    ]);
  }

  // Booking is about a future day, so an occupied item can still be booked
  if (blockedReason(item) !== 'retired') {
    rows.push([{ text: '📅 Book for a date', callback_data: `bk:${item._id}` }]);
  }

  rows.push([
    { text: '⬅️ Back', callback_data: `cat:${item.category}` },
    { text: '🏠 Menu', callback_data: 'menu' },
  ]);

  return {
    text: details.join('\n'),
    keyboard: { inline_keyboard: rows },
    photo: item.imageUrl || null,
  };
}

function myItems(items, pendingRequests = [], bookings = []) {
  if (items.length === 0 && pendingRequests.length === 0 && bookings.length === 0) {
    return {
      text: 'You are not holding anything right now. 🎒',
      keyboard: {
        inline_keyboard: [
          [{ text: '📂 Browse categories', callback_data: 'cats' }],
          [{ text: '🏠 Menu', callback_data: 'menu' }],
        ],
      },
    };
  }

  const sections = [];
  const rows = [];

  if (items.length > 0) {
    const lines = items.map((item) => {
      const head = `📌 <b>${escapeHtml(item.name)}</b>\n   <code>${escapeHtml(item.assetTag)}</code> · taken ${formatWhen(item.occupiedAt)} (${formatSince(item.occupiedAt)} ago)`;
      return item.occupyReason ? `${head}\n   📝 ${escapeHtml(item.occupyReason)}` : head;
    });
    sections.push(
      `<b>You are holding ${items.length} item${items.length === 1 ? '' : 's'}</b>\n\n${lines.join('\n\n')}`
    );
    items.forEach((item) =>
      rows.push([{ text: `✅ Submit ${item.name}`.slice(0, 60), callback_data: `ret:${item._id}` }])
    );
  }

  if (pendingRequests.length > 0) {
    const lines = pendingRequests.map((r) => {
      const head = `⏳ <b>${escapeHtml(r.productName)}</b>\n   <code>${escapeHtml(r.assetTag || '')}</code> · asked ${formatWhen(r.createdAt)}`;
      return r.reason ? `${head}\n   📝 ${escapeHtml(r.reason)}` : head;
    });
    sections.push(`<b>Waiting for admin approval</b>\n\n${lines.join('\n\n')}`);
    pendingRequests.forEach((r) =>
      rows.push([{ text: `✖️ Cancel request: ${r.productName}`.slice(0, 60), callback_data: `cxl:${r._id}` }])
    );
  }

  if (bookings.length > 0) {
    const lines = bookings.map((b) => {
      const icon = b.status === 'confirmed' ? '📅' : '⏳';
      const state = b.status === 'confirmed' ? 'confirmed' : 'waiting for admin';
      const head = `${icon} <b>${escapeHtml(b.productName)}</b> — ${escapeHtml(formatDay(b.bookedFor))} (${state})\n   <code>${escapeHtml(b.assetTag || '')}</code>`;
      return b.reason ? `${head}\n   📝 ${escapeHtml(b.reason)}` : head;
    });
    sections.push(`<b>Your bookings</b>\n\n${lines.join('\n\n')}`);
    bookings.forEach((b) =>
      rows.push([
        {
          text: `✖️ Cancel booking: ${b.productName} · ${formatDay(b.bookedFor)}`.slice(0, 60),
          callback_data: `bkcxl:${b._id}`,
        },
      ])
    );
  }

  rows.push([{ text: '🏠 Menu', callback_data: 'menu' }]);

  return {
    text: sections.join('\n\n———\n\n'),
    keyboard: { inline_keyboard: rows },
  };
}

function occupiedList(items, holders) {
  if (items.length === 0) {
    return {
      text: 'Everything is on the shelf right now. 🟢',
      keyboard: { inline_keyboard: [[{ text: '🏠 Menu', callback_data: 'menu' }]] },
    };
  }

  const lines = items.map((item) => {
    const head = `🔴 <b>${escapeHtml(item.name)}</b>\n   <code>${escapeHtml(item.assetTag)}</code> · ${escapeHtml(holders[String(item.assignedTo)] || 'someone')} · since ${formatWhen(item.occupiedAt)} (${formatSince(item.occupiedAt)})`;
    return item.occupyReason ? `${head}\n   📝 ${escapeHtml(item.occupyReason)}` : head;
  });

  return {
    text: `<b>Occupied right now (${items.length})</b>\n\n${lines.join('\n\n')}`,
    keyboard: { inline_keyboard: [[{ text: '🏠 Menu', callback_data: 'menu' }]] },
  };
}


/* ------------------------------------------------------------------ *
 * admin views — shown to signed-in admin accounts
 * ------------------------------------------------------------------ */

function adminMenu(admin, counts = { requests: 0, bookings: 0 }) {
  return {
    text:
      `Hi ${escapeHtml(admin.name)} \u{1F6E1} — you are signed in as an <b>admin</b>.\n\n` +
      `\u{1F4E5} Pending requests: <b>${counts.requests}</b>\n` +
      `\u{1F4C5} Pending bookings: <b>${counts.bookings}</b>\n\n` +
      `New requests and bookings will land in this chat with approve and decline buttons.`,
    keyboard: {
      inline_keyboard: [
        [{ text: `\u{1F4E5} Pending requests (${counts.requests})`, callback_data: 'adm:reqs' }],
        [{ text: `\u{1F4C5} Pending bookings (${counts.bookings})`, callback_data: 'adm:bks' }],
        [{ text: '\u{1F534} Occupied right now', callback_data: 'adm:busy' }],
        [{ text: '\u{1F6AA} Sign out', callback_data: 'adm:logout' }],
      ],
    },
  };
}

// One message per pending request, so each carries its own decision buttons
function adminRequestCard(r) {
  return {
    text:
      `\u{1F64B} <b>${escapeHtml(r.userName)}</b> is asking for\n` +
      `<b>${escapeHtml(r.productName)}</b> <code>${escapeHtml(r.assetTag || '')}</code>\n` +
      (r.reason ? `\u{1F4DD} ${escapeHtml(r.reason)}\n` : '') +
      `Asked ${formatWhen(r.createdAt)} (${formatSince(r.createdAt)} ago)`,
    keyboard: {
      inline_keyboard: [
        [
          { text: '\u2705 Approve', callback_data: `aprq:${r._id}` },
          { text: '\u274C Decline', callback_data: `rjrq:${r._id}` },
        ],
      ],
    },
  };
}

function adminBookingCard(b) {
  return {
    text:
      `\u{1F4C5} <b>${escapeHtml(b.userName)}</b> wants to book\n` +
      `<b>${escapeHtml(b.productName)}</b> <code>${escapeHtml(b.assetTag || '')}</code>\n` +
      `For <b>${escapeHtml(formatDay(b.bookedFor))}</b>\n` +
      (b.reason ? `\u{1F4DD} ${escapeHtml(b.reason)}\n` : '') +
      `Asked ${formatWhen(b.createdAt)}`,
    keyboard: {
      inline_keyboard: [
        [
          { text: '\u2705 Approve', callback_data: `apbk:${b._id}` },
          { text: '\u274C Decline', callback_data: `rjbk:${b._id}` },
        ],
      ],
    },
  };
}

function adminEmptyList(what) {
  return {
    text: `Nothing pending. \u2728 No ${what} are waiting for a decision.`,
    keyboard: { inline_keyboard: [[{ text: '\u2B05\uFE0F Back', callback_data: 'adm:menu' }]] },
  };
}

module.exports = {
  adminMenu,
  adminRequestCard,
  adminBookingCard,
  adminEmptyList,
  categoryPhotos,
  QUICK_REASONS,
  reasonPrompt,
  bookDayPrompt,
  bookReasonPrompt,
  blockedReason,
  isTakeable,
  statusIcon,
  availabilityLine,
  mainMenu,
  categoryList,
  itemList,
  itemDetail,
  myItems,
  occupiedList,
};
