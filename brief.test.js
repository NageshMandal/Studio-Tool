// node brief.test.js — no network, no browser.
import { parseBrief, resolveFinanceType, parseMoney, parseMiles } from "./brief.js";

let failures = 0;
const check = (name, cond, extra = "") => {
  if (cond) { console.log(`  ✓ ${name}`); }
  else { failures++; console.log(`  ✗ ${name} ${extra}`); }
};

console.log("brief.test.js");

// --- full brief -------------------------------------------------------------
{
  const { ok, brief, missing, warnings } = parseBrief(`
Email - Client@Example.com
Mobile - +44 7508 671223
DOB - 01/07/2001
Reg - ld23 juu
Mileage - 45,000
Retail price - £9,990
Cash price - 9990
Finance type - pcp
Term - 60 months
Deposit - £0
Annual mileage - 6k
Application type - private
Distance sale - yes
  `);
  check("full brief ok", ok, JSON.stringify({ missing, warnings }));
  check("email lowercased", brief.email === "client@example.com", brief.email);
  check("mobile normalised", brief.mobile === "7508671223", brief.mobile);
  check("dob normalised", brief.dob === "01/07/2001", brief.dob);
  check("reg upper no spaces", brief.reg === "LD23JUU", brief.reg);
  check("mileage 45000", brief.mileage === 45000);
  check("retail 9990", brief.retail === 9990);
  check("cash 9990", brief.cashPrice === 9990);
  check("finance PCP value 2", brief.financeType.value === "2", JSON.stringify(brief.financeType));
  check("term 60", brief.term === 60);
  check("deposit 0", brief.deposit === 0);
  check("annual mileage 6000", brief.annualMileage === 6000);
  check("app type Private", brief.appType === "Private");
  check("distance sale true", brief.distanceSale === true);
}

// --- minimal brief with defaults -------------------------------------------
{
  const { ok, brief, warnings } = parseBrief(`
email: x@y.co
dob: 13-11-1996
reg: FP73MZL
mileage: 12000
price: £23,500
  `);
  check("minimal ok", ok);
  check("defaults: HP", brief.financeType.label === "HP");
  check("defaults: term 60", brief.term === 60);
  check("defaults: deposit 0", brief.deposit === 0);
  check("defaults: distance sale yes", brief.distanceSale === true);
  check("retail defaults to cash", brief.retail === 23500);
  check("retail default warned", warnings.some((w) => /retail/i.test(w)));
}

// --- missing required fields -----------------------------------------------
{
  const { ok, missing } = parseBrief(`Email - a@b.com\nReg - AB12CDE\nMileage - 100`);
  check("missing cash price flagged", !ok && missing.some((m) => /cash/i.test(m)), JSON.stringify(missing));
  check("missing mobile/dob flagged", missing.some((m) => /mobile or dob/i.test(m)), JSON.stringify(missing));
}

// --- identity: email alone is never enough ---------------------------------
{
  const { ok, missing } = parseBrief(`Email - a@b.com\nReg - AB12CDE\nMileage - 100\nCash price - 5000`);
  check("email-only brief refused", !ok && missing.length === 1 && /mobile or dob/i.test(missing[0]), JSON.stringify(missing));
}

// --- odd separators and aliases --------------------------------------------
{
  const { brief } = parseBrief(`e-mail = a@b.com\nVRM — AB12CDE\nphone: 07000000000\ncurrent mileage: 5k\ntotal price: 1000`);
  check("aliases + separators", brief.email === "a@b.com" && brief.reg === "AB12CDE" && brief.mileage === 5000 && brief.cashPrice === 1000, JSON.stringify(brief));
}

// --- helpers ----------------------------------------------------------------
check("parseMoney £1,250.50", parseMoney("£1,250.50") === 1250.5);
check("parseMiles 45k", parseMiles("45k") === 45000);
check("finance type: hire purchase", resolveFinanceType("Hire Purchase").value === "1");
check("finance type: unknown null", resolveFinanceType("boat loan") === null);
check("finance type: lease purchase 12", resolveFinanceType("lease purchase").value === "12");

if (failures) { console.log(`${failures} failure(s)`); process.exit(1); }
console.log("all passed");
