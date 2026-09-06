// ---------------------------------------------------------------------------
// telegram/admin-bot.js — the whole conversation.
//
//   paste client details -> echo what was understood -> "go" to confirm
//   -> job starts; a live status message is edited as stages pass
//   -> mid-job questions (the OTP, the pre-check override) arrive as normal
//      messages and are routed to the waiting job
//   -> success/failure summary
//
// Two mechanisms worth knowing:
//
//   pendingAsks   The Puppeteer flow sometimes has to stop and ask a human —
//                 the 2FA code, or "continue anyway?". The job registers a
//                 resolver keyed by chatId; the NEXT message from that chat is
//                 fed to it instead of being parsed as a brief. /cancel rejects
//                 it and the job dies cleanly.
//
//   detached job  The runtime serialises updates per chat, so the job must NOT
//                 run inside the message handler — it would block the very OTP
//                 reply it is waiting for. The handler starts the job and
//                 returns; the job reports back through the api it captured.
//
// One job runs at a time globally (one browser, one CRM login). Briefs sent
// while a job is running are refused with a status line, not queued — a queued
// CRM write the operator forgot about is worse than asking them to resend.
// ---------------------------------------------------------------------------
import { parseBrief, describeBrief } from "../brief.js";
import { runAdminJob } from "../autoconvert.js";
import { forgetSession } from "../browser.js";

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const OTP_TIMEOUT_MS = () => parseInt(process.env.OTP_TIMEOUT_MS, 10) || 300000;
const ANSWER_TIMEOUT_MS = () => parseInt(process.env.ANSWER_TIMEOUT_MS, 10) || 300000;

const HELP = [
  "<b>AutoConvert admin agent</b>",
  "",
  "Paste the client details and I will find the application, add the vehicle, and fill the finance. Example:",
  "",
  "<code>Email - client@example.com",
  "Mobile - 07508 671223",
  "DOB - 01/07/2001",
  "Reg - LD23JUU",
  "Mileage - 45000",
  "Retail price - 9990",
  "Cash price - 9990",
  "Finance type - PCP",
  "Term - 60",
  "Deposit - 0",
  "Annual mileage - 6000",
  "Application type - Private",
  "Distance sale - yes</code>",
  "",
  "Only Email, Reg, Mileage, Cash price and (Mobile or DOB) are required — the rest have sensible defaults.",
  "",
  "If AutoConvert asks for a 2-factor code, I will ask you for it here.",
  "",
  "<b>Commands</b>",
  "/status — what is held / what is running",
  "/go — confirm and start",
  "/cancel — cancel the pending question or the held brief",
  "/logout — forget the saved AutoConvert session (forces a fresh login + OTP)",
  "/help — this message",
].join("\n");

// chatId -> { resolve, reject, validate, invalid, timer }
const pendingAsks = new Map();
// chatId -> { startedAt, stage } while a job is running
const runningJobs = new Map();
// One browser, one CRM login: jobs chain globally.
let jobChain = Promise.resolve();

function askFactory(ctx) {
  return (prompt, { validate = (t) => t, invalid = "That did not look right — try again.", timeoutMs } = {}) =>
    new Promise((resolve, reject) => {
      const ms = timeoutMs || ANSWER_TIMEOUT_MS();
      const timer = setTimeout(() => {
        pendingAsks.delete(ctx.chatId);
        reject(new Error("Timed out waiting for your reply."));
      }, ms);
      pendingAsks.set(ctx.chatId, { resolve, reject, validate, invalid, timer });
      ctx.send(prompt).catch(() => {});
    });
}

function confirmFactory(ask) {
  return (prompt) =>
    ask(prompt, {
      validate: (t) => {
        const s = t.trim().toLowerCase();
        if (/^(y|yes|go|continue|proceed)$/.test(s)) return true;
        if (/^(n|no|stop|cancel|abort)$/.test(s)) return false;
        return null;
      },
      invalid: "Reply <b>yes</b> or <b>no</b>.",
    });
}

// ---------------------------------------------------------------------------
// Live status message: one message, edited as stages pass, so the chat is a
// progress bar rather than a wall of one-line updates.
// ---------------------------------------------------------------------------
function makeStatusReporter(ctx) {
  const stages = [];
  let messageId = null;
  let writing = Promise.resolve();

  const render = () =>
    ["<b>Working…</b>", ...stages.map((s, i) => `${i === stages.length - 1 ? "▶️" : "✅"} ${esc(s)}`)].join("\n");

  return {
    onStage(stage) {
      stages.push(stage);
      const job = runningJobs.get(ctx.chatId);
      if (job) job.stage = stage;
      writing = writing.then(async () => {
        if (!messageId) {
          const m = await ctx.send(render()).catch(() => null);
          messageId = m?.message_id || null;
        } else {
          await ctx.edit(messageId, render()).catch(() => {});
        }
      }).catch(() => {});
    },
    async finish(finalLinePrefix = "✅") {
      await writing;
      if (messageId) {
        const done = [`<b>${finalLinePrefix === "✅" ? "Done" : "Stopped"}</b>`, ...stages.map((s) => `${finalLinePrefix} ${esc(s)}`)].join("\n");
        await ctx.edit(messageId, done).catch(() => {});
      }
    },
  };
}

function successCard(result) {
  const gbp = (n) => `£${Number(n).toLocaleString("en-GB", { maximumFractionDigits: 2 })}`;
  const v = result.vehicle;
  const f = result.finance;
  return [
    `✅ <b>${esc(result.applicant.name)}</b> — vehicle and finance filled.`,
    "",
    `🚗 <b>${esc([v.make, v.model].filter(Boolean).join(" ") || v.reg)}</b>`,
    v.derivative ? `   ${esc(v.derivative)}` : null,
    `   Reg <code>${esc(v.reg)}</code> · ${Number(v.mileage).toLocaleString("en-GB")} miles · retail ${gbp(v.retail)}`,
    "",
    `💷 ${esc(f.type)} (${esc(f.appType)}) · cash price ${gbp(f.cashPrice)}`,
    `   ${f.term} months · deposit ${gbp(f.deposit)} · ${Number(f.annualMileage).toLocaleString("en-GB")} mi/yr · distance sale ${f.distanceSale ? "Yes" : "No"}`,
    f.balanceToFinance ? `   Balance to finance: ${gbp(f.balanceToFinance)}` : null,
    "",
    `🔗 <a href="${result.applicant.url}">Open the application</a>`,
  ].filter((l) => l !== null).join("\n");
}

// ---------------------------------------------------------------------------
// Access control. This bot holds a CRM login; TELEGRAM_ALLOWED_USERS (comma-
// separated Telegram user ids) restricts who can drive it. Empty = open.
// ---------------------------------------------------------------------------
function allowed(ctx) {
  const raw = (process.env.TELEGRAM_ALLOWED_USERS || "").trim();
  if (!raw) return true;
  const ids = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return ids.includes(String(ctx.from?.id || ""));
}

async function startJob(ctx, brief) {
  runningJobs.set(ctx.chatId, { startedAt: Date.now(), stage: "queued" });
  const reporter = makeStatusReporter(ctx);
  const ask = askFactory(ctx);
  const confirm = confirmFactory(ask);

  // Chain on the global job slot: one browser at a time, but a queued chat is
  // told it is queued rather than left staring at silence.
  const myTurn = jobChain;
  jobChain = jobChain
    .catch(() => {})
    .then(async () => {
      try {
        const result = await runAdminJob(brief, {
          onStage: (s) => reporter.onStage(s),
          ask: (prompt, opts) => ask(prompt, { ...opts, timeoutMs: OTP_TIMEOUT_MS() }),
          confirm,
        });
        await reporter.finish("✅");
        await ctx.send(successCard(result));
      } catch (err) {
        await reporter.finish("▪️");
        await ctx.send(`❌ ${esc(err.message)}${err.screenshot ? `\n\n(A screenshot of where it stopped was saved on the desk: <code>${esc(err.screenshot)}</code>)` : ""}`);
      } finally {
        runningJobs.delete(ctx.chatId);
        const pending = pendingAsks.get(ctx.chatId);
        if (pending) { clearTimeout(pending.timer); pendingAsks.delete(ctx.chatId); }
        await ctx.clearSession().catch(() => {});
      }
    });

  void myTurn; // (the chain above already waits on it)
  if (runningJobs.size > 1) {
    await ctx.send("⏳ Another job is running — yours is queued and will start as soon as it finishes.");
  }
}

// ---------------------------------------------------------------------------
// The message handler.
// ---------------------------------------------------------------------------
export async function handleMessage(ctx) {
  if (!ctx.text) return;

  if (!allowed(ctx)) {
    return ctx.send("This bot is restricted. Ask the desk owner to add your Telegram id to TELEGRAM_ALLOWED_USERS.");
  }

  const cmd = ctx.command;

  // /cancel wins over everything — it is the way out of a stuck question.
  if (cmd?.name === "cancel" || cmd?.name === "stop") {
    const pending = pendingAsks.get(ctx.chatId);
    if (pending) {
      clearTimeout(pending.timer);
      pendingAsks.delete(ctx.chatId);
      pending.reject(new Error("Cancelled from the chat."));
      return; // the job's own error path reports back
    }
    await ctx.saveSession({ brief: null });
    return ctx.send("Cleared. Paste new client details when ready.");
  }

  // A job is waiting on an answer: this message IS the answer.
  const pending = pendingAsks.get(ctx.chatId);
  if (pending) {
    if (cmd) return ctx.send("A question is waiting — answer it first, or /cancel to stop the job.");
    const value = pending.validate(ctx.text);
    if (value === null || value === undefined) return ctx.send(pending.invalid);
    clearTimeout(pending.timer);
    pendingAsks.delete(ctx.chatId);
    pending.resolve(value);
    return;
  }

  if (cmd?.name === "start" || cmd?.name === "help") return ctx.send(HELP);

  if (cmd?.name === "logout") {
    const had = forgetSession();
    return ctx.send(had
      ? "Saved AutoConvert session forgotten — the next job will sign in fresh and ask for an OTP."
      : "There was no saved session to forget.");
  }

  if (cmd?.name === "status") {
    const job = runningJobs.get(ctx.chatId);
    if (job) return ctx.send(`▶️ Job running (started ${Math.round((Date.now() - job.startedAt) / 1000)}s ago) — current stage: ${esc(job.stage)}`);
    const session = await ctx.session();
    if (session?.brief) return ctx.send(`Held and waiting for /go:\n\n<code>${esc(describeBrief(session.brief))}</code>`);
    return ctx.send("Nothing held, nothing running. Paste client details to begin.");
  }

  if (cmd?.name === "go" || /^(go|yes|confirm|run)$/i.test(ctx.text)) {
    if (runningJobs.has(ctx.chatId)) return ctx.send("A job is already running for this chat — /status shows where it is.");
    const session = await ctx.session();
    if (!session?.brief) return ctx.send("Nothing held to run — paste the client details first.");
    // Re-hydrate: financeType survives JSON as {value,label,aliases} — fine as-is.
    const brief = session.brief;
    await ctx.saveSession({ brief: null });
    await ctx.send("🚀 Starting.");
    startJob(ctx, brief); // deliberately not awaited — see file header
    return;
  }

  if (cmd) return ctx.send(`Unknown command /${esc(cmd.name)} — /help lists what I understand.`);

  // Anything else is treated as a pasted brief.
  if (runningJobs.has(ctx.chatId)) {
    return ctx.send("A job is running — wait for it to finish (or /cancel it) before sending new details.");
  }

  const parsed = parseBrief(ctx.text);
  const parts = [];

  if (parsed.fieldsRead === 0) {
    return ctx.send("I could not read any client details in that. /help shows the format.");
  }

  parts.push("<b>Here is what I understood:</b>", "", `<code>${esc(describeBrief(parsed.brief))}</code>`);
  if (parsed.warnings.length) parts.push("", ...parsed.warnings.map((w) => `⚠️ ${esc(w)}`));
  if (parsed.ignored.length) parts.push("", `Ignored: ${parsed.ignored.map((l) => esc(l)).join(" · ")}`);

  if (!parsed.ok) {
    parts.push("", `❌ Still needed: <b>${parsed.missing.map(esc).join(", ")}</b>`, "Send the missing line(s) together with the rest, as one message.");
    return ctx.send(parts.join("\n"));
  }

  await ctx.saveSession({ brief: parsed.brief });
  parts.push("", "Reply <b>go</b> to start, or paste corrected details to replace this.");
  return ctx.send(parts.join("\n"));
}

export const adminBot = {
  id: "admin",
  label: "AutoConvert Admin",
  tokenEnv: "TELEGRAM_ADMIN_TOKEN",
  get token() { return process.env.TELEGRAM_ADMIN_TOKEN || ""; },
  handleMessage,
  commands: [
    { command: "help", description: "How to use this bot" },
    { command: "status", description: "What is held / running" },
    { command: "go", description: "Confirm and start the held job" },
    { command: "cancel", description: "Cancel the pending question or held brief" },
    { command: "logout", description: "Forget the saved AutoConvert session" },
  ],
};
