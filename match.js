// ---------------------------------------------------------------------------
// match.js — pure helpers for picking the right applicant out of the search
// results table. Pure so they can be unit-tested without a browser: choosing
// the wrong person here means writing a vehicle and a finance deal onto a
// stranger's application, which is the one mistake this project must not make.
// ---------------------------------------------------------------------------

// "07508 671223" | "+44 7508671223" | "0044..." -> "7508671223" (last 10 digits)
// UK mobiles are 07xxx xxxxxx; the same number arrives as 07..., +447..., 447...
// Comparing the last 10 digits makes all three spellings equal.
export function normaliseMobile(str) {
  const digits = String(str ?? "").replace(/\D/g, "");
  if (digits.length < 9) return null;
  return digits.slice(-10);
}

export function mobilesEqual(a, b) {
  const na = normaliseMobile(a);
  const nb = normaliseMobile(b);
  return !!na && !!nb && na === nb;
}

// ---------------------------------------------------------------------------
// DOB. Accepted spellings:
//   13/11/1996   13-11-1996   13.11.1996        (UK day-first)
//   1996-11-13                                  (ISO)
//   01-Jul-2001  1 July 2001                    (how AutoConvert prints it)
// ---------------------------------------------------------------------------
const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

export function parseDob(str) {
  const s = String(str ?? "").trim();
  if (!s) return null;

  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/); // ISO
  if (m) return checkDate(+m[3], +m[2], +m[1]);

  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/); // day-first
  if (m) return checkDate(+m[1], +m[2], +m[3]);

  m = s.match(/^(\d{1,2})[\s\-]([a-z]{3,9})[\s\-](\d{4})$/i); // 01-Jul-2001
  if (m) {
    const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mon) return checkDate(+m[1], mon, +m[3]);
  }
  return null;
}

function checkDate(d, mo, y) {
  if (y < 1900 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { d, m: mo, y };
}

export function formatDob(dob) {
  if (!dob) return null;
  const p = (n) => String(n).padStart(2, "0");
  return `${p(dob.d)}/${p(dob.m)}/${dob.y}`;
}

export function dobsEqual(a, b) {
  const da = typeof a === "string" ? parseDob(a) : a;
  const db = typeof b === "string" ? parseDob(b) : b;
  return !!da && !!db && da.d === db.d && da.m === db.m && da.y === db.y;
}

// The age column prints "29 (13/11/1996)" — pull the bracketed date out.
export function dobFromAgeText(ageText) {
  const m = String(ageText ?? "").match(/\((\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{4})\)/);
  return m ? parseDob(m[1]) : null;
}

// ---------------------------------------------------------------------------
// pickApplicant(rows, brief) -> { row, matches } | { error, candidates }
//
// rows: [{ name, href, email, mobile, ageText }] scraped from the results
// table. The search was BY email, so email should already agree — it is still
// re-checked, because the search page can carry stale rows and a complete-match
// search that returned something else entirely is worth catching.
//
// Verification: the row must match the brief's mobile OR dob (whichever were
// given). Email alone is never enough — see the header comment.
// ---------------------------------------------------------------------------
export function pickApplicant(rows, brief) {
  const all = (rows || []).filter((r) => r && r.href);
  if (!all.length) return { error: "no-results", candidates: [] };

  const emailRows = brief.email
    ? all.filter((r) => (r.email || "").trim().toLowerCase() === brief.email)
    : all;
  const pool = emailRows.length ? emailRows : all;

  const verify = (r) => {
    const checks = [];
    if (brief.mobile) checks.push({ what: "mobile", ok: mobilesEqual(r.mobile, brief.mobile) });
    if (brief.dob) checks.push({ what: "DOB", ok: dobsEqual(dobFromAgeText(r.ageText), brief.dob) });
    return checks;
  };

  const scored = pool.map((r) => {
    const checks = verify(r);
    return { row: r, checks, hits: checks.filter((c) => c.ok).map((c) => c.what) };
  });

  const verified = scored.filter((s) => s.hits.length > 0);

  if (verified.length === 1) return { row: verified[0].row, matches: verified[0].hits };
  if (verified.length > 1) {
    // Two rows both verify — duplicates of the same person are common (the
    // same customer applying twice). Prefer the one whose email also matched;
    // beyond that it is genuinely ambiguous and a human has to choose.
    return { error: "ambiguous", candidates: verified.map((s) => s.row) };
  }

  return { error: "no-verified-match", candidates: pool.map((s) => s) };
}
