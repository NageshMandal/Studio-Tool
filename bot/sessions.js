/**
 * Short-lived state for people part-way through signing in.
 * Deliberately in memory: it only ever holds an email between two messages,
 * and a restart just means the person types /start again.
 */
const SESSION_TTL_MS = 5 * 60 * 1000;
const sessions = new Map();

function setSession(chatId, data) {
  sessions.set(String(chatId), { ...data, expiresAt: Date.now() + SESSION_TTL_MS });
}

function getSession(chatId) {
  const key = String(chatId);
  const session = sessions.get(key);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    sessions.delete(key);
    return null;
  }
  return session;
}

function clearSession(chatId) {
  sessions.delete(String(chatId));
}

function sessionCount() {
  return sessions.size;
}

module.exports = { setSession, getSession, clearSession, sessionCount, SESSION_TTL_MS };
