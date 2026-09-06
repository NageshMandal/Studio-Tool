// ---------------------------------------------------------------------------
// autoconvert.js — drive the AutoConvert CRM through one admin job:
//
//   login (env credentials, OTP asked over Telegram, session cookies kept)
//   -> /Tasks -> Advanced search by EMAIL
//   -> pick the applicant, verified against mobile and/or DOB
//   -> open the application, confirm Vehicle AND BankDetails show the red ✗
//   -> Vehicle Edit -> Add -> VRM lookup -> mileage + retail -> Submit
//   -> Next -> Finance: type, product, cash price, term, deposit,
//      annual mileage, distance sale -> Save and close
//
// OPERATIONAL NOTE: this writes into a LIVE CRM. Every guard here exists so a
// wrong click lands on nothing rather than on a customer's application:
//   • the applicant is never chosen on email alone — mobile or DOB must agree
//   • the red-✗ pre-check refuses to touch an application that already has a
//     vehicle, and asks a human before proceeding on any mismatch
//   • the VRM lookup result is read back (make/model) and reported, so the
//     human sees WHAT was added, not just that something was
//
// The selectors come from the live markup supplied (data-testids preferred
// where the site has them, since those survive restyles).
// ---------------------------------------------------------------------------
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openBrowser, closeBrowser, saveCookies } from "./browser.js";
import { pickApplicant } from "./match.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = () => (process.env.AUTOCONVERT_BASE || "https://www.autoconvert.co.uk").replace(/\/+$/, "");
const STEP_MS = () => parseInt(process.env.STEP_MS, 10) || 1500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = () => sleep(STEP_MS());

// ---------------------------------------------------------------------------
// Small page helpers. Dynamic modals mean a selector can exist several times
// in the DOM (stale modal bodies linger), so "the" element is always the
// VISIBLE one.
// ---------------------------------------------------------------------------
async function waitVisible(page, selector, { timeout = 30000 } = {}) {
  await page.waitForFunction(
    (sel) => [...document.querySelectorAll(sel)].some((el) => el.offsetParent !== null),
    { timeout },
    selector,
  );
}

async function clickVisible(page, selector, { timeout = 30000 } = {}) {
  await waitVisible(page, selector, { timeout });
  await page.evaluate((sel) => {
    const el = [...document.querySelectorAll(sel)].find((e) => e.offsetParent !== null);
    el.scrollIntoView({ block: "center" });
    el.click();
  }, selector);
}

// Set a form control's value the way the site's own jQuery listeners expect:
// value, then input + change events. Used for the finance figures, whose
// balance-to-finance recalculation listens on "input".
async function setValue(page, selector, value) {
  await waitVisible(page, selector);
  await page.evaluate((sel, val) => {
    const el = [...document.querySelectorAll(sel)].find((e) => e.offsetParent !== null);
    el.value = val;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, selector, String(value));
}

async function selectVisible(page, selector, value) {
  await waitVisible(page, selector);
  await page.evaluate((sel, val) => {
    const el = [...document.querySelectorAll(sel)].find((e) => e.offsetParent !== null);
    el.value = val;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, selector, String(value));
}

async function typeVisible(page, selector, text, { delay = 40 } = {}) {
  await waitVisible(page, selector);
  const handle = await page.evaluateHandle(
    (sel) => [...document.querySelectorAll(sel)].find((e) => e.offsetParent !== null),
    selector,
  );
  const el = handle.asElement();
  await el.click({ clickCount: 3 }); // select any existing text so typing replaces it
  await el.type(String(text), { delay });
  await handle.dispose();
}

async function screenshot(page, label) {
  try {
    const dir = join(__dirname, "debug");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${label}.png`);
    await page.screenshot({ path: file, fullPage: false });
    return file;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Login. Cookies restored by openBrowser may already carry a session and the
// day's "remembered device" 2FA cookie — in which case /Tasks just loads and
// none of this runs.
// ---------------------------------------------------------------------------
async function ensureLoggedIn(page, { onStage, ask }) {
  onStage("Opening AutoConvert");
  await page.goto(`${BASE()}/Tasks`, { waitUntil: "networkidle2" });

  if (!/\/user\/login/i.test(page.url())) {
    onStage("Already signed in from a saved session");
    return;
  }

  const user = process.env.AUTOCONVERT_USERNAME || "";
  const pass = process.env.AUTOCONVERT_PASSWORD || "";
  if (!user || !pass) {
    throw new Error("AUTOCONVERT_USERNAME / AUTOCONVERT_PASSWORD are not set in .env");
  }

  onStage("Signing in");
  await waitVisible(page, 'input[name="Username"]');
  // Give the page a moment to load its reCAPTCHA script before touching the
  // form — submitting before RecaptchaLoaded flips is a known way to fail.
  await step();

  const accountId = process.env.AUTOCONVERT_ACCOUNT_ID || "";
  if (accountId) {
    const hasAlias = await page.$('input[name="Alias"]');
    if (hasAlias) await typeVisible(page, 'input[name="Alias"]', accountId);
  }
  await typeVisible(page, 'input[name="Username"]', user);
  await typeVisible(page, 'input[name="Password"]', pass);
  await step();

  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle2", timeout: 90000 }).catch(() => null),
    clickVisible(page, "#login-button"),
  ]);
  await step();

  // Three places we can land: the OTP page, /Tasks, or back on the login page
  // with an error (bad password, recaptcha refusal).
  if (await page.$('input[name="Code"]')) {
    await handleOtp(page, { onStage, ask });
  }

  if (/\/user\/login/i.test(page.url())) {
    const errText = await page.evaluate(() =>
      [...document.querySelectorAll(".alert-danger, .validation-summary-errors, .help-block.with-errors")]
        .map((e) => e.textContent.trim()).filter(Boolean).join(" | "));
    throw new Error(`Login did not succeed${errText ? ` — the page says: ${errText}` : ""}. Check the credentials in .env.`);
  }

  onStage("Signed in");
  await saveCookies(page);
}

async function handleOtp(page, { onStage, ask }) {
  const ends = await page.evaluate(() => {
    const m = document.body.innerText.match(/number ending in\s*\**(\d+)/i);
    return m ? m[1] : "";
  });

  for (let attempt = 1; attempt <= 3; attempt++) {
    onStage("Waiting for the verification code");
    const code = await ask(
      `🔐 AutoConvert sent a 4-digit verification code to the number ending ${ends ? `in <b>${ends}</b>` : "on file"}.\n\nReply with the code.`,
      { validate: (t) => /^\d{4}$/.test(t.trim()) ? t.trim() : null, invalid: "That is not a 4-digit code — send just the four digits." },
    );

    onStage("Submitting the verification code");
    await typeVisible(page, 'input[name="Code"]', code);
    // Remember this device — spares the OTP for the rest of the day. The
    // input is visually hidden behind a "pretty" checkbox but click() on the
    // input itself still toggles it.
    await page.evaluate(() => {
      const cb = document.querySelector('input[name="RememberMe"]');
      if (cb && !cb.checked) cb.click();
    });
    await step();

    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 }).catch(() => null),
      page.evaluate(() => {
        const form = document.querySelector('input[name="Code"]')?.closest("form");
        const btn = form?.querySelector('button[type="submit"]');
        (btn || form)?.click ? btn.click() : form?.submit();
      }),
    ]);
    await step();

    if (!(await page.$('input[name="Code"]'))) return; // moved on — code accepted
    onStage("Code rejected");
  }
  throw new Error("The verification code was rejected 3 times — stopping. Start again with a fresh code.");
}

// ---------------------------------------------------------------------------
// Search by email. The modal's Search button is plain JS over a GET form, so
// if the click ever goes nowhere the same request is made directly by URL —
// the outcome is identical and a redesign of the modal cannot strand the job.
// ---------------------------------------------------------------------------
async function searchByEmail(page, email, { onStage }) {
  onStage(`Searching applications for ${email}`);

  const opened = await page.evaluate(() => {
    const link = document.querySelector('a[data-target="#advancedApplicationSearchModal"]');
    if (!link) return false;
    link.click();
    return true;
  });

  let navigated = false;
  if (opened) {
    try {
      await waitVisible(page, "#searchType", { timeout: 10000 });
      await selectVisible(page, "#searchType", "email");
      await typeVisible(page, "#searchString", email);
      await step();
      await Promise.all([
        page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }),
        clickVisible(page, "#advancedApplicationSearchModal_search"),
      ]);
      navigated = true;
    } catch { /* fall through to the direct URL */ }
  }

  if (!navigated) {
    const url = `${BASE()}/application/search?t=email&q=${encodeURIComponent(email)}&s=-created`;
    await page.goto(url, { waitUntil: "networkidle2" });
  }
  await step();
}

async function readResultRows(page) {
  return page.evaluate(() => {
    const rows = [];
    for (const tr of document.querySelectorAll("table tbody tr")) {
      const a = tr.querySelector("td.a-name a");
      if (!a) continue;
      const cell = (cls) => tr.querySelector(`td.${cls}`)?.textContent.trim() || "";
      rows.push({
        name: a.textContent.trim(),
        href: a.getAttribute("href"),
        status: cell("a-status"),
        subStatus: cell("a-sub-status"),
        email: cell("a-email"),
        mobile: cell("a-mobile"),
        ageText: cell("a-age"),
        created: cell("a-created"),
      });
    }
    return rows;
  });
}

// ---------------------------------------------------------------------------
// The red-✗ pre-check on the application's Overview panel. The whole point of
// this job is to ADD the vehicle and finance, so an application where Vehicle
// already shows the green ✓ is one somebody has already worked — writing over
// it needs a human's explicit yes.
// ---------------------------------------------------------------------------
async function readOverviewStatus(page) {
  return page.evaluate(() => {
    const out = {};
    for (const tr of document.querySelectorAll("#overviewPanel tr")) {
      const th = tr.querySelector("th");
      if (!th) continue;
      const label = th.textContent.replace(/\s+/g, " ").trim();
      const state = th.querySelector("i.fa-times") ? "missing"
        : th.querySelector("i.fa-check") ? "done" : "unknown";
      if (/^Vehicle\b/i.test(label)) out.vehicle = state;
      if (/^BankDetails\b/i.test(label)) out.bankDetails = state;
      if (/^Finance\b/i.test(label)) out.finance = state;
    }
    return out;
  });
}

// ---------------------------------------------------------------------------
// Vehicle: Edit -> (Vehicles modal) -> Add -> reg -> Look up -> mileage +
// retail -> Submit -> back on the Vehicles modal with the car listed.
// ---------------------------------------------------------------------------
async function addVehicle(page, brief, { onStage }) {
  onStage("Opening the Vehicle step");
  await clickVisible(page, '#overviewPanel a[data-remote-content*="/enquiryvehicle/manage/"]');
  await waitVisible(page, 'a[data-remote-content*="/enquiryvehicle/add/"]', { timeout: 30000 });
  await step();

  onStage("Adding the vehicle");
  await clickVisible(page, 'a[data-remote-content*="/enquiryvehicle/add/"]');
  await waitVisible(page, 'input[name="EnquiryVehicle.Registration"]', { timeout: 30000 });
  await step();

  await typeVisible(page, 'input[name="EnquiryVehicle.Registration"]', brief.reg);
  await step();

  onStage(`Looking up ${brief.reg}`);
  await clickVisible(page, "button.js-vehicle-basic-details-lookup");

  // The lookup populates the manual-entry fields. Poll for Make to fill; a
  // registration DVLA does not know leaves it empty, and that is a stop — the
  // vehicle written to a finance application must be the looked-up one.
  const found = await page.waitForFunction(() => {
    const make = [...document.querySelectorAll('input[name="EnquiryVehicle.Make"]')]
      .find((e) => e.offsetParent !== null);
    return make && make.value.trim().length > 0;
  }, { timeout: 45000 }).then(() => true).catch(() => false);

  if (!found) {
    throw new Error(`The VRM lookup returned nothing for ${brief.reg}. Check the registration and try again.`);
  }

  const vehicle = await page.evaluate(() => {
    const val = (name) => [...document.querySelectorAll(`[name="EnquiryVehicle.${name}"]`)]
      .find((e) => e.offsetParent !== null)?.value?.trim() || "";
    return {
      make: val("Make"), model: val("Model"), derivative: val("Derivative"),
      year: val("ModelYear"), colour: val("Colour"), fuel: val("FuelType"),
    };
  });
  onStage(`Found ${[vehicle.make, vehicle.model, vehicle.derivative].filter(Boolean).join(" ")}`.trim());
  await step();

  await setValue(page, 'input[name="EnquiryVehicle.Mileage"]', brief.mileage);
  await setValue(page, 'input[name="EnquiryVehicle.RetailValue"]', brief.retail);
  await step();

  onStage("Saving the vehicle");
  await clickVisible(page, '[data-testid="add-vehicle-modal-submit-button"]');

  // Back on the Vehicles list modal, which should now show the reg.
  await page.waitForFunction((reg) => {
    const modal = [...document.querySelectorAll(".js-modal-content, .modal-content")]
      .find((e) => e.offsetParent !== null);
    return modal && modal.innerText.toUpperCase().includes(reg);
  }, { timeout: 30000 }, brief.reg).catch(() => {
    throw new Error("The vehicle was submitted but did not appear in the Vehicles list — stopping before the finance step.");
  });
  await step();
  return vehicle;
}

// ---------------------------------------------------------------------------
// Finance modal, reached with "Next" from the Vehicles modal.
// ---------------------------------------------------------------------------
async function fillFinance(page, brief, { onStage }) {
  onStage("Moving to the Finance step");
  await clickVisible(page, "button.js-workflow-next");
  await waitVisible(page, "#enquiryTypeSelector", { timeout: 30000 });
  await step();

  onStage("Filling the finance details");
  await selectVisible(page, "#enquiryTypeSelector", brief.appType === "Business" ? "1" : "0");
  // Changing the finance type rebuilds the term <select>; set the type first,
  // give the rebuild a beat, then set the term.
  await selectVisible(page, "#financeTypeSelector", brief.financeType.value);
  await step();

  await setValue(page, "#FinanceProfile_CashPrice", brief.cashPrice.toFixed(2));
  await selectVisible(page, "#financeTermSelector", String(brief.term));
  await setValue(page, "#FinanceProfile_TotalDeposit", (brief.deposit ?? 0).toFixed(2));
  await setValue(page, "#FinanceProfile_EstimatedAnnualMileage", brief.annualMileage ?? 0);
  await selectVisible(page, "#FinanceProfile_DistanceSale", brief.distanceSale ? "True" : "False");
  await step();

  // Read back what the page itself calculated — the number the lender sees.
  const balance = await page.evaluate(() =>
    [...document.querySelectorAll("#FinanceProfile_BalanceToFinance")]
      .find((e) => e.offsetParent !== null)?.value || "");

  onStage("Saving the finance");
  await clickVisible(page, 'button.js-submit-with-data[data-value="SaveClose"]');

  // Done when the finance modal is gone.
  await page.waitForFunction(() => {
    const el = document.querySelector("#enquiryTypeSelector");
    return !el || el.offsetParent === null;
  }, { timeout: 30000 }).catch(() => {
    throw new Error("Save and close did not close the Finance modal — it may be showing a validation error.");
  });
  await step();
  return { balance };
}

// ---------------------------------------------------------------------------
// The whole job. `ask(prompt, {validate, invalid})` and `confirm(prompt)` are
// supplied by the Telegram bot — they resolve with the human's reply.
// ---------------------------------------------------------------------------
export async function runAdminJob(brief, { onStage = () => {}, ask, confirm }) {
  const { browser, page } = await openBrowser({ onStage });
  try {
    await ensureLoggedIn(page, { onStage, ask });

    await searchByEmail(page, brief.email, { onStage });
    const rows = await readResultRows(page);

    const picked = pickApplicant(rows, brief);
    if (picked.error === "no-results") {
      throw new Error(`No applications found for ${brief.email}.`);
    }
    if (picked.error === "ambiguous") {
      const list = picked.candidates.map((r, i) => `${i + 1}. ${r.name} — ${r.mobile || "no mobile"} — created ${r.created || "?"} (${r.status || "?"})`).join("\n");
      throw new Error(`More than one application matches the details:\n${list}\n\nNarrow it down (e.g. the exact mobile on the right application) and run again.`);
    }
    if (picked.error === "no-verified-match") {
      const list = (picked.candidates || []).slice(0, 5)
        .map((r) => `• ${r.name} — ${r.mobile || "no mobile"} — ${r.ageText || "no DOB"}`).join("\n");
      throw new Error(
        `Found application(s) for ${brief.email}, but none matched the mobile/DOB you gave:\n${list}\n\nCheck the mobile number / DOB and run again.`,
      );
    }

    const applicant = picked.row;
    onStage(`Matched ${applicant.name} (verified by ${picked.matches.join(" + ")})`);

    const applicationUrl = new URL(applicant.href, BASE()).toString();
    await page.goto(applicationUrl, { waitUntil: "networkidle2" });
    await waitVisible(page, "#overviewPanel", { timeout: 30000 });
    await step();

    const status = await readOverviewStatus(page);
    if (status.vehicle !== "missing" || status.bankDetails !== "missing") {
      const describe = (s) => s === "missing" ? "❌ red ✗ (empty)" : s === "done" ? "✅ green ✓ (already filled)" : "❔ could not read";
      const go = await confirm(
        `⚠️ Pre-check on <b>${applicant.name}</b> did not come back all-clear:\n` +
        `Vehicle: ${describe(status.vehicle)}\nBankDetails: ${describe(status.bankDetails)}\n\n` +
        `Both were expected to show the red ✗. Continue anyway? (yes / no)`,
      );
      if (!go) throw new Error("Stopped at the pre-check — nothing was changed.");
      if (status.vehicle === "done") {
        onStage("Vehicle already present — a second one will be added to the application");
      }
    } else {
      onStage("Pre-check OK — Vehicle and BankDetails both empty");
    }

    const vehicle = await addVehicle(page, brief, { onStage });
    const finance = await fillFinance(page, brief, { onStage });

    await saveCookies(page);
    return {
      ok: true,
      applicant: { name: applicant.name, url: applicationUrl },
      vehicle: { reg: brief.reg, ...vehicle, mileage: brief.mileage, retail: brief.retail },
      finance: {
        type: brief.financeType.label, appType: brief.appType,
        cashPrice: brief.cashPrice, term: brief.term, deposit: brief.deposit ?? 0,
        annualMileage: brief.annualMileage, distanceSale: brief.distanceSale,
        balanceToFinance: finance.balance,
      },
    };
  } catch (err) {
    err.screenshot = await screenshot(page, "failure");
    throw err;
  } finally {
    await closeBrowser(browser);
  }
}
