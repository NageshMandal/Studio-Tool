// ---------------------------------------------------------------------------
// telegram/runtime.js — the polling loop, shared by every bot.
//
// Long polling rather than webhooks, deliberately: this app already runs behind
// whatever the dealer's network is, and webhooks need a public HTTPS endpoint
// with a valid certificate. Polling works from a laptop, a VPS or a container
// with no inbound access at all, and the traffic is a handful of held requests.
//
// Three properties this loop has to have:
//
//   1. One bad update never stops the bot. A handler that throws is logged and
//      the offset still advances — otherwise the same poisoned message is
//      replayed forever and the bot is dead until someone reads the logs.
//   2. The offset survives a restart. It lives in Mongo, so a redeploy does
//      not re-run every brief still sitting in Telegram's queue.
//   3. Updates for DIFFERENT chats run concurrently; updates for the SAME chat
//      run in order. A dealer typing "more" twice must not interleave two
//      pagination steps over one session document.
// ---------------------------------------------------------------------------
import { TelegramApi, SendQueue } from "./api.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class BotRunner {
  constructor(bot, deps) {
    this.bot = bot;                       // { id, label, token, handleMessage, handleCallback, commands }
    this.deps = deps;
    this.api = new TelegramApi(bot.token, { label: bot.id });
    this.queue = new SendQueue({ gapMs: 400 });
    this.running = false;
    this.offset = 0;
    this.me = null;
    // One in-flight promise per Telegram chat, so a chat's updates serialise.
    this.chatChains = new Map();
  }

  async start() {
    this.me = await this.api.getMe().catch((err) => {
      throw new Error(`${this.bot.label}: token rejected by Telegram — ${err.message}`);
    });

    this.offset = await this.deps.getTgOffset(this.bot.id).catch(() => 0);
    if (!this.offset) {
      // First boot for this bot: skip whatever is already queued.
      this.offset = await this.api.dropPendingUpdates().catch(() => 0);
      if (this.offset) await this.deps.saveTgOffset(this.bot.id, this.offset).catch(() => {});
    }

    if (this.bot.commands?.length) await this.api.setMyCommands(this.bot.commands);

    this.running = true;
    this.loop();
    console.log(`  Telegram: @${this.me.username} live as "${this.bot.label}" [${this.bot.id}]`);
    return this.me;
  }

  stop() { this.running = false; }

  async loop() {
    let backoff = 1000;
    while (this.running) {
      try {
        const updates = await this.api.getUpdates({ offset: this.offset, timeout: 25 });
        backoff = 1000;
        if (!updates?.length) continue;

        for (const u of updates) {
          this.offset = Math.max(this.offset, u.update_id + 1);
          this.dispatch(u);
        }
        // Saved after dispatch is STARTED, not after it finishes: a handler
        // that runs a three-minute scrape must not hold the poll loop, and a
        // crash mid-scrape should not replay the whole search on restart.
        await this.deps.saveTgOffset(this.bot.id, this.offset).catch(() => {});
      } catch (err) {
        if (!this.running) break;
        console.log(`  Telegram[${this.bot.id}]: poll failed — ${err.message}. Retrying in ${Math.round(backoff / 1000)}s.`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 60000);
      }
    }
  }

  // Serialise per chat, isolate failures.
  dispatch(update) {
    const chatId =
      update.message?.chat?.id ??
      update.callback_query?.message?.chat?.id ??
      `u${update.update_id}`;
    const key = String(chatId);
    const prev = this.chatChains.get(key) || Promise.resolve();

    const next = prev.then(() => this.handle(update)).catch((err) => {
      console.log(`  Telegram[${this.bot.id}]: handler error — ${err.stack || err.message}`);
      // Tell the human something went wrong; a silent bot looks broken.
      const cid = update.message?.chat?.id || update.callback_query?.message?.chat?.id;
      if (cid) {
        this.api.sendMessage(cid, `⚠️ Something went wrong handling that: ${err.message}`).catch(() => {});
      }
    });

    this.chatChains.set(key, next);
    next.then(() => { if (this.chatChains.get(key) === next) this.chatChains.delete(key); });
  }

  async handle(update) {
    const ctx = this.makeContext(update);
    if (update.callback_query) return this.bot.handleCallback?.(ctx);
    if (update.message) return this.bot.handleMessage?.(ctx);
  }

  // The context handed to a bot handler. Everything a handler needs to reply
  // is here, so handlers never touch the API object or the queue directly.
  makeContext(update) {
    const msg = update.message || update.callback_query?.message || {};
    const chatId = msg.chat?.id;
    const from = update.message?.from || update.callback_query?.from || {};
    const text = (update.message?.text || update.message?.caption || "").trim();
    const data = update.callback_query?.data || "";

    const send = (t, opts) => this.queue.run(chatId, () => this.api.sendMessage(chatId, t, opts));

    return {
      bot: this.bot,
      api: this.api,
      deps: this.deps,
      update,
      chatId,
      messageId: msg.message_id,
      from,
      userName: [from.first_name, from.last_name].filter(Boolean).join(" ") || from.username || String(from.id || ""),
      text,
      data,
      // A "/cmd arg arg" split that also copes with @botname suffixes in groups.
      command: (() => {
        const m = text.match(/^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i);
        return m ? { name: m[1].toLowerCase(), args: (m[2] || "").trim() } : null;
      })(),

      send,
      reply: (t, opts) => send(t, { reply_to_message_id: msg.message_id, ...opts }),
      sendPhoto: (photo, caption, opts) =>
        this.queue.run(chatId, () => this.api.sendPhotoOrText(chatId, photo, caption, opts)),
      sendAlbum: (urls, opts) => this.queue.run(chatId, () => this.api.sendPhotoAlbum(chatId, urls, opts)),
      edit: (messageId, t, opts) => this.api.editMessageText(chatId, messageId, t, opts),
      remove: (messageId) => this.api.deleteMessage(chatId, messageId),
      typing: () => this.api.sendChatAction(chatId, "typing"),
      answer: (opts) => update.callback_query ? this.api.answerCallbackQuery(update.callback_query.id, opts) : null,

      // Session helpers, scoped to this bot and this Telegram chat.
      session: () => this.deps.getTgSession(this.bot.id, chatId),
      saveSession: (patch) => this.deps.saveTgSession(this.bot.id, chatId, patch),
      clearSession: () => this.deps.clearTgSession(this.bot.id, chatId),
    };
  }
}

// ---------------------------------------------------------------------------
// Start every configured bot. A bot with no token is skipped with a line in
// the log rather than being an error — running only the dealer bot while the
// auction bots are still being set up is a normal state.
// ---------------------------------------------------------------------------
export async function startBots(bots, deps) {
  const runners = [];
  for (const bot of bots) {
    if (!bot.token) {
      console.log(`  Telegram: ${bot.label} skipped — ${bot.tokenEnv} not set.`);
      continue;
    }
    const runner = new BotRunner(bot, deps);
    try {
      await runner.start();
      runners.push(runner);
    } catch (err) {
      console.log(`  Telegram: ${bot.label} failed to start — ${err.message}`);
    }
  }
  return runners;
}