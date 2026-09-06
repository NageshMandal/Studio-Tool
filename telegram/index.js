// ---------------------------------------------------------------------------
// telegram/index.js — bot registry + startup, mirroring car_source's shape so
// a second agent later is one entry in BOTS.
// ---------------------------------------------------------------------------
import { startBots } from "./runtime.js";
import { adminBot } from "./admin-bot.js";
import * as store from "../store.js";

const BOTS = [adminBot];

export const telegramEnabled = () => BOTS.some((b) => b.token);

export async function startTelegram() {
  if (!telegramEnabled()) {
    console.log("  Telegram: no bot tokens set (TELEGRAM_ADMIN_TOKEN) — nothing to start.");
    return [];
  }
  return startBots(BOTS, store);
}
