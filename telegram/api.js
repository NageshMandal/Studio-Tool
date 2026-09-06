// ---------------------------------------------------------------------------
// telegram/api.js — a thin client for the Bot API.
//
// No new dependency: the Bot API is JSON over HTTPS and Node has fetch. A
// framework would bring a plugin system, a session store and a router this
// codebase already has better versions of.
//
// What this file DOES own, because getting them wrong is what actually breaks
// a bot in production:
//
//   429 handling   Telegram allows roughly one message per second per chat.
//                  Sending five cards in a burst gets throttled, and the reply
//                  carries `retry_after` — which is honoured here rather than
//                  dropping the card.
//   photo fallback sendPhoto takes a URL and Telegram fetches it ITSELF. When
//                  the host blocks Telegram's fetcher, or the file is over
//                  5 MB, or the content-type is wrong, the call fails and the
//                  card would vanish. It degrades to a text message with the
//                  photo as a link instead.
//   long polling   A 25-second held request needs a client timeout well above
//                  25 seconds, or every poll looks like a network failure.
// ---------------------------------------------------------------------------

const API = "https://api.telegram.org";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class TelegramError extends Error {
  constructor(message, { code = 0, retryAfter = 0, method = "" } = {}) {
    super(message);
    this.name = "TelegramError";
    this.code = code;
    this.retryAfter = retryAfter;
    this.method = method;
  }
}

export class TelegramApi {
  constructor(token, { label = "bot" } = {}) {
    this.token = token;
    this.label = label;
  }

  async call(method, payload = {}, { timeoutMs = 20000, retries = 3 } = {}) {
    let lastErr = null;

    for (let attempt = 1; attempt <= retries; attempt++) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const r = await fetch(`${API}/bot${this.token}/${method}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: ac.signal,
        });
        const body = await r.json().catch(() => ({}));

        if (body.ok) return body.result;

        const retryAfter = body.parameters?.retry_after || 0;
        const err = new TelegramError(body.description || `HTTP ${r.status}`, {
          code: body.error_code || r.status, retryAfter, method,
        });

        // Throttled: Telegram tells us exactly how long to wait.
        if (retryAfter && attempt < retries) {
          await sleep((retryAfter + 0.5) * 1000);
          lastErr = err;
          continue;
        }
        // 4xx other than 429 means the request itself is wrong — a bad
        // chat_id, unparseable HTML, a photo Telegram refused. Retrying sends
        // the identical thing, so surface it now.
        if (err.code >= 400 && err.code < 500) throw err;
        lastErr = err;
      } catch (err) {
        if (err instanceof TelegramError) throw err;
        lastErr = err;   // network blip or abort — worth another go
      } finally {
        clearTimeout(timer);
      }
      if (attempt < retries) await sleep(1000 * attempt);
    }
    throw lastErr || new TelegramError("Request failed", { method });
  }

  getMe() { return this.call("getMe"); }

  getUpdates({ offset = 0, timeout = 25, allowedUpdates = ["message", "callback_query"] } = {}) {
    // Client timeout must clear the server's hold time or every poll aborts.
    return this.call("getUpdates",
      { offset, timeout, allowed_updates: allowedUpdates },
      { timeoutMs: (timeout + 15) * 1000, retries: 1 });
  }

  sendMessage(chatId, text, opts = {}) {
    return this.call("sendMessage", {
      chat_id: chatId, text, parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...opts,
    });
  }

  editMessageText(chatId, messageId, text, opts = {}) {
    return this.call("editMessageText", {
      chat_id: chatId, message_id: messageId, text, parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...opts,
    }).catch((err) => {
      // "message is not modified" is the normal result of a status poll that
      // ticked without the stage changing. Not an error worth surfacing.
      if (/not modified/i.test(err.message)) return null;
      throw err;
    });
  }

  answerCallbackQuery(id, opts = {}) {
    return this.call("answerCallbackQuery", { callback_query_id: id, ...opts }).catch(() => null);
  }

  // Send a photo, and never lose the message because the photo would not send.
  //
  // Two independent failure modes, and they need different fallbacks:
  //   - Telegram could not FETCH the photo (host blocked it, >5MB, wrong
  //     content-type). The caption is fine; resend it as text.
  //   - Telegram could not PARSE the caption. Resending the same caption as
  //     text fails identically, so the markup has to be stripped first —
  //     otherwise the card is lost twice over and only a parse error survives.
  async sendPhotoOrText(chatId, photoUrl, caption, opts = {}) {
    let lastErr = null;
    if (photoUrl) {
      try {
        return await this.call("sendPhoto", {
          chat_id: chatId, photo: photoUrl, caption, parse_mode: "HTML", ...opts,
        });
      } catch (err) {
        lastErr = err;
        console.log(`  Telegram[${this.label}]: sendPhoto failed (${err.message}) — falling back.`);
      }
    }

    // A parse failure means the markup itself is the problem.
    if (lastErr && /can.t parse|unsupported start tag|unclosed|entities/i.test(lastErr.message)) {
      const plain = stripHtml(caption);
      console.log(`  Telegram[${this.label}]: caption would not parse — sending it without markup.`);
      return this.sendMessage(chatId, plain, { ...opts, parse_mode: undefined })
        .catch(() => this.call("sendMessage", { chat_id: chatId, text: plain.slice(0, 4000) }));
    }

    try {
      return await this.sendMessage(chatId, caption, opts);
    } catch (err) {
      // Last resort: no markup, no keyboard, guaranteed to land.
      const plain = stripHtml(caption).slice(0, 4000);
      return this.call("sendMessage", { chat_id: chatId, text: plain });
    }
  }

  // Up to 10 photos as one album. Silently degrades to links — an album is
  // never worth failing a reply over.
  async sendPhotoAlbum(chatId, urls, { caption = "" } = {}) {
    const media = urls.slice(0, 10).map((u, i) => ({
      type: "photo", media: u,
      ...(i === 0 && caption ? { caption, parse_mode: "HTML" } : {}),
    }));
    if (!media.length) return null;
    try {
      return await this.call("sendMediaGroup", { chat_id: chatId, media });
    } catch (err) {
      const links = urls.slice(0, 10).map((u, i) => `<a href="${u}">Photo ${i + 1}</a>`).join(" · ");
      return this.sendMessage(chatId, `${caption}\n${links}`.trim());
    }
  }

  // Remove a message the bot sent. Used to keep exactly one copy block in the
  // chat rather than a growing stack of them.
  //
  // Never throws: Telegram refuses to delete a message older than 48 hours,
  // and one already gone returns "message to delete not found". Both mean the
  // same thing to the caller — it is not there any more — and neither is worth
  // failing a reply over.
  deleteMessage(chatId, messageId) {
    if (!messageId) return Promise.resolve(null);
    return this.call("deleteMessage", { chat_id: chatId, message_id: messageId }, { retries: 1 })
      .catch(() => null);
  }

  sendChatAction(chatId, action = "typing") {
    return this.call("sendChatAction", { chat_id: chatId, action }, { retries: 1 }).catch(() => null);
  }

  setMyCommands(commands, opts = {}) {
    return this.call("setMyCommands", { commands, ...opts }).catch(() => null);
  }

  // Drop any updates queued while the process was down. Used on first boot
  // when there is no stored offset, so a restart does not replay old briefs.
  async dropPendingUpdates() {
    const updates = await this.getUpdates({ offset: -1, timeout: 0 }).catch(() => []);
    if (!updates?.length) return 0;
    const last = updates[updates.length - 1].update_id;
    await this.getUpdates({ offset: last + 1, timeout: 0 }).catch(() => {});
    return last + 1;
  }
}

// A per-chat send queue. Telegram throttles bursts to one message per second
// per chat; five cards sent in a tight loop reliably trips it. Serialising and
// spacing the sends is cheaper than absorbing the 429s.
export class SendQueue {
  constructor({ gapMs = 400 } = {}) {
    this.gapMs = gapMs;
    this.chains = new Map();
  }

  run(chatId, fn) {
    const key = String(chatId);
    const prev = this.chains.get(key) || Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(async () => { const out = await fn(); await sleep(this.gapMs); return out; });
    // The chain the NEXT caller waits on must never reject, or one failed send
    // poisons every later send to that chat. The caller still sees `next`.
    const tail = next.catch(() => {});
    this.chains.set(key, tail);
    // Forget the chain once the chat goes quiet, so the map does not grow.
    tail.then(() => {
      if (this.chains.get(key) === tail) setTimeout(() => { if (this.chains.get(key) === tail) this.chains.delete(key); }, 30000);
    });
    return next;
  }
}

// Markup out, readable text in. Used only on the fallback path, when Telegram
// has already refused to parse a caption and resending it unchanged would fail
// exactly the same way.
export function stripHtml(html) {
  return String(html ?? "")
    .replace(/<a\s+href="([^"]*)"[^>]*>(.*?)<\/a>/gi, "$2: $1")
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}