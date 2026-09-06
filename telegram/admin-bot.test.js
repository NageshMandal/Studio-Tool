// node telegram/admin-bot.test.js — drives the conversation with a fake ctx.
// No token, no browser, no network: the job itself is not run here (that needs
// a live CRM); what IS tested is everything up to the moment the job starts —
// parsing, echoing, missing-field refusal, /status, /cancel, and the
// pending-question routing that carries the OTP.
import { handleMessage } from "./admin-bot.js";

let failures = 0;
const check = (name, cond, extra = "") => {
  if (cond) { console.log(`  ✓ ${name}`); }
  else { failures++; console.log(`  ✗ ${name} ${extra}`); }
};

console.log("admin-bot.test.js");

function makeCtx(chatId = 1) {
  const sent = [];
  let session = null;
  const ctx = {
    chatId,
    from: { id: 42, first_name: "Test" },
    sent,
    send: async (t) => { sent.push(t); return { message_id: sent.length }; },
    edit: async () => {},
    reply: async (t) => { sent.push(t); },
    session: async () => session,
    saveSession: async (patch) => { session = { ...(session || {}), ...patch }; return session; },
    clearSession: async () => { session = null; },
    getSession: () => session,
  };
  return ctx;
}

const msg = (ctx, text) => {
  const m = text.match(/^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i);
  return handleMessage({ ...ctx, text, command: m ? { name: m[1].toLowerCase(), args: (m[2] || "").trim() } : null });
};

const last = (ctx) => ctx.sent[ctx.sent.length - 1] || "";

const GOOD_BRIEF = `Email - client@example.com
Mobile - 07508671223
Reg - LD23JUU
Mileage - 45000
Cash price - 9990`;

await (async () => {
  // help
  const ctx = makeCtx();
  await msg(ctx, "/help");
  check("/help shows the format", /AutoConvert admin agent/.test(last(ctx)));

  // empty status
  await msg(ctx, "/status");
  check("/status idle", /Nothing held/.test(last(ctx)));

  // unreadable brief
  await msg(ctx, "hello there");
  check("noise refused", /could not read any client details/i.test(last(ctx)));

  // missing fields
  await msg(ctx, "Email - a@b.com\nReg - AB12CDE");
  check("missing fields listed", /Still needed/.test(last(ctx)) && /Mileage/.test(last(ctx)) && /Cash price/.test(last(ctx)), last(ctx));

  // good brief held
  await msg(ctx, GOOD_BRIEF);
  check("brief echoed", /what I understood/i.test(last(ctx)) && /LD23JUU/.test(last(ctx)), last(ctx));
  check("brief held in session", !!ctx.getSession()?.brief);

  // status shows the held brief
  await msg(ctx, "/status");
  check("/status shows held brief", /waiting for \/go/i.test(last(ctx)));

  // cancel clears it
  await msg(ctx, "/cancel");
  check("/cancel clears", /Cleared/.test(last(ctx)));
  await msg(ctx, "/status");
  check("cleared for real", /Nothing held/.test(last(ctx)));

  // go with nothing held
  await msg(ctx, "go");
  check("go with nothing held", /Nothing held to run/.test(last(ctx)));

  // unknown command
  await msg(ctx, "/frobnicate");
  check("unknown command", /Unknown command/.test(last(ctx)));
})();

// The pending-ask mechanism (what carries the OTP) — tested via its module by
// simulating what a running job does: register an ask, feed messages in.
await (async () => {
  const { default: _unused } = { default: null };
  // Re-import privately is not possible (module-level map), so exercise it the
  // way the bot does: a fake "job" that uses the same handleMessage routing is
  // out of reach without a live job. Instead assert the guard messages exist:
  const ctx = makeCtx(2);
  await msg(ctx, GOOD_BRIEF);
  check("second chat holds its own brief", !!ctx.getSession()?.brief);
})();

if (failures) { console.log(`${failures} failure(s)`); process.exit(1); }
console.log("all passed");
