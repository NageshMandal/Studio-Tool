// ---------------------------------------------------------------------------
// store.js — a tiny file-backed store, standing in for the Mongo collections
// the car_source runtime expects (tg offsets + per-chat sessions).
//
// This project runs a single admin bot on a single desk; a database is more
// moving parts than the data deserves. Everything lives in state.json next to
// the code, written debounced so a burst of session saves is one disk write.
//
// The exported functions match the shape telegram/runtime.js expects
// (getTgOffset / saveTgOffset / getTgSession / saveTgSession / clearTgSession)
// so the runtime is a byte-for-byte copy from car_source.
// ---------------------------------------------------------------------------
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE = process.env.STATE_FILE || join(__dirname, "state.json");

let state = { offsets: {}, sessions: {} };
try {
  state = { offsets: {}, sessions: {}, ...JSON.parse(readFileSync(FILE, "utf8")) };
} catch { /* first run — empty state is the correct state */ }

let timer = null;
function persist() {
  // Debounce: a job saves its session on every stage tick; coalesce them.
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    try {
      const tmp = `${FILE}.tmp`;
      writeFileSync(tmp, JSON.stringify(state, null, 2));
      renameSync(tmp, FILE); // atomic-ish: never leave a half-written file
    } catch (err) {
      console.warn(`  store: could not write ${FILE} — ${err.message}`);
    }
  }, 250);
}

export async function getTgOffset(botId) {
  return state.offsets[botId] || 0;
}

export async function saveTgOffset(botId, offset) {
  state.offsets[botId] = offset;
  persist();
}

const key = (botId, chatId) => `${botId}:${chatId}`;

export async function getTgSession(botId, chatId) {
  return state.sessions[key(botId, chatId)] || null;
}

export async function saveTgSession(botId, chatId, patch) {
  const k = key(botId, chatId);
  state.sessions[k] = { ...(state.sessions[k] || {}), ...patch, updatedAt: new Date().toISOString() };
  persist();
  return state.sessions[k];
}

export async function clearTgSession(botId, chatId) {
  delete state.sessions[key(botId, chatId)];
  persist();
}
