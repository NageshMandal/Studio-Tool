// node match.test.js — the applicant-picking logic, tested against rows shaped
// exactly like the live results table (including the "29 (13/11/1996)" age cell).
import {
  normaliseMobile, mobilesEqual, parseDob, formatDob, dobsEqual,
  dobFromAgeText, pickApplicant,
} from "./match.js";

let failures = 0;
const check = (name, cond, extra = "") => {
  if (cond) { console.log(`  ✓ ${name}`); }
  else { failures++; console.log(`  ✗ ${name} ${extra}`); }
};

console.log("match.test.js");

// --- mobiles ----------------------------------------------------------------
check("07... == +447...", mobilesEqual("07508 671223", "+44 7508671223"));
check("07... == 447...", mobilesEqual("07719095925", "447719095925"));
check("different numbers differ", !mobilesEqual("07719095925", "07719095926"));
check("garbage is null", normaliseMobile("call me") === null);

// --- dobs -------------------------------------------------------------------
check("13/11/1996", formatDob(parseDob("13/11/1996")) === "13/11/1996");
check("1996-11-13 ISO", formatDob(parseDob("1996-11-13")) === "13/11/1996");
check("01-Jul-2001", formatDob(parseDob("01-Jul-2001")) === "01/07/2001");
check("1 July 2001", formatDob(parseDob("1 July 2001")) === "01/07/2001");
check("dob equality across formats", dobsEqual("13-11-1996", "1996-11-13"));
check("age cell extract", formatDob(dobFromAgeText("29 (13/11/1996)")) === "13/11/1996");
check("age cell without dob", dobFromAgeText("29") === null);

// --- pickApplicant ----------------------------------------------------------
// Rows lifted from the real search-results markup (the Orenuga search).
const rows = [
  { name: "Keith Orenuga", href: "/application/view/18a67fb0", email: "Orenuga12@icloud.com", mobile: "07719095925", ageText: "29 (13/11/1996)", status: "In progress", created: "16/12/2025" },
  { name: "Kenneth Orenuga", href: "/application/view/957d2a9b", email: "mrorenuga11@gmail.com", mobile: "07875391180", ageText: "35 (23/05/1991)", status: "New", created: "03/09/2025" },
];

{
  const r = pickApplicant(rows, { email: "orenuga12@icloud.com", mobile: "07719095925" });
  check("mobile verifies the right row", r.row?.name === "Keith Orenuga" && r.matches.includes("mobile"), JSON.stringify(r));
}
{
  const r = pickApplicant(rows, { email: "mrorenuga11@gmail.com", dob: "23/05/1991" });
  check("dob verifies the right row", r.row?.name === "Kenneth Orenuga" && r.matches.includes("DOB"), JSON.stringify(r));
}
{
  // Search matched on email but the mobile the dealer gave belongs to nobody
  // here — must refuse rather than guess.
  const r = pickApplicant(rows, { email: "orenuga12@icloud.com", mobile: "07000000000" });
  check("wrong mobile refused", r.error === "no-verified-match", JSON.stringify(r));
}
{
  // Same person twice (duplicate applications with identical details): both
  // verify, so a human has to choose.
  const dupes = [rows[0], { ...rows[0], href: "/application/view/copy" }];
  const r = pickApplicant(dupes, { email: "orenuga12@icloud.com", mobile: "07719095925" });
  check("duplicates are ambiguous", r.error === "ambiguous" && r.candidates.length === 2, JSON.stringify(r));
}
{
  const r = pickApplicant([], { email: "a@b.com", mobile: "07000000000" });
  check("empty results", r.error === "no-results");
}
{
  // Email in a different case on the site: still matches; mobile with +44: still matches.
  const r = pickApplicant(rows, { email: "orenuga12@icloud.com", mobile: "+447719095925", dob: "01/01/1990" });
  check("mobile hit is enough even when dob misses", r.row?.name === "Keith Orenuga" && r.matches.join() === "mobile", JSON.stringify(r));
}

if (failures) { console.log(`${failures} failure(s)`); process.exit(1); }
console.log("all passed");
