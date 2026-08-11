const { formatWhen, formatSince, escapeHtml } = require('../utils/format');

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

function reasonPrompt(item) {
  const rows = QUICK_REASONS.map((reason, i) => [
    { text: reason, callback_data: `rsn:${item._id}:${i}` },
  ]);
  rows.push([{ text: '✍️ Type my own reason', callback_data: `rsnown:${item._id}` }]);
  rows.push([{ text: '✖️ Cancel', callback_data: `item:${item._id}` }]);

  return {
    text:
      `What do you need <b>${escapeHtml(item.name)}</b> for?\n\n` +
      `Tap a reason below, or just type one in a few words.`,
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

function itemDetail(item, holderName, viewerId) {
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

  const rows = [];

  if (heldByViewer) {
    rows.push([{ text: '✅ Submit item (return it)', callback_data: `ret:${item._id}` }]);
  } else if (isTakeable(item)) {
    rows.push([{ text: '📌 Occupy now', callback_data: `occ:${item._id}` }]);
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

function myItems(items) {
  if (items.length === 0) {
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

  const lines = items.map((item) => {
    const head = `📌 <b>${escapeHtml(item.name)}</b>\n   <code>${escapeHtml(item.assetTag)}</code> · taken ${formatWhen(item.occupiedAt)} (${formatSince(item.occupiedAt)} ago)`;
    return item.occupyReason ? `${head}\n   📝 ${escapeHtml(item.occupyReason)}` : head;
  });

  const rows = items.map((item) => [
    { text: `✅ Submit ${item.name}`.slice(0, 60), callback_data: `ret:${item._id}` },
  ]);
  rows.push([{ text: '🏠 Menu', callback_data: 'menu' }]);

  return {
    text: `<b>You are holding ${items.length} item${items.length === 1 ? '' : 's'}</b>\n\n${lines.join('\n\n')}`,
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

module.exports = {
  categoryPhotos,
  QUICK_REASONS,
  reasonPrompt,
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
