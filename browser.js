// ---------------------------------------------------------------------------
// browser.js — one place that launches Chrome for AutoConvert.
//
// puppeteer-real-browser is used for the same reason car_source uses it: the
// login page runs reCAPTCHA v3 (score-based, invisible), and a stock headless
// Chrome scores badly enough to fail logins that a real-looking browser sails
// through.
//
// Unlike the Autotrader scraper, this flow WANTS state to survive between
// runs: the "Remember this device" checkbox on the 2FA page sets a cookie that
// spares the OTP for the rest of the day. puppeteer-real-browser owns its own
// throwaway profile (pointing it at a custom userDataDir breaks its
// anti-detection preparation — hard-learned in car_source), so persistence is
// done at the COOKIE level instead: cookies are dumped to a gitignored JSON
// file after a successful login and restored into the fresh profile on the
// next launch. A dump of cookies is exactly the session, and nothing else.
// ---------------------------------------------------------------------------
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "puppeteer-real-browser";

const __dirname = dirname(fileURLToPath(import.meta.url));
const COOKIE_FILE = process.env.COOKIE_FILE || join(__dirname, ".autoconvert-cookies.json");

export const headless = () => process.env.HEADLESS === "true";

export async function openBrowser({ onStage = () => {} } = {}) {
  onStage("Opening the browser");
  const { browser, page } = await connect({
    headless: headless(),
    turnstile: true,
    connectOption: { defaultViewport: null },
    args: ["--window-size=1440,960"],
    disableXvfb: false,
  });

  page.setDefaultTimeout(parseInt(process.env.NAV_TIMEOUT_MS, 10) || 60000);
  page.setDefaultNavigationTimeout(parseInt(process.env.NAV_TIMEOUT_MS, 10) || 60000);

  await restoreCookies(page);
  return { browser, page };
}

export async function closeBrowser(browser) {
  try { await browser?.close(); } catch { /* already gone */ }
}

// ---------------------------------------------------------------------------
// Cookie persistence. Restore silently tolerates a missing/corrupt file (first
// run), and save overwrites wholesale — the current session is the only one
// worth keeping.
// ---------------------------------------------------------------------------
export async function restoreCookies(page) {
  try {
    const cookies = JSON.parse(readFileSync(COOKIE_FILE, "utf8"));
    if (Array.isArray(cookies) && cookies.length) {
      await page.setCookie(...cookies);
      return cookies.length;
    }
  } catch { /* no saved session — normal on first run */ }
  return 0;
}

export async function saveCookies(page) {
  try {
    const cookies = await page.cookies();
    writeFileSync(COOKIE_FILE, JSON.stringify(cookies, null, 2));
    return cookies.length;
  } catch (err) {
    console.warn(`  cookies: could not save — ${err.message}`);
    return 0;
  }
}

export function forgetSession() {
  try { unlinkSync(COOKIE_FILE); return true; } catch { return false; }
}
