// ---------------------------------------------------------------------------
// brief.js — turn the client details pasted into Telegram into a job.
//
//     Email - client@example.com
//     Mobile - 07508 671223
//     DOB - 01/07/2001
//     Reg - LD23JUU
//     Mileage - 45000
//     Retail price - 9990
//     Cash price - 9990
//     Finance type - PCP
//     Term - 60
//     Deposit - 0
//     Annual mileage - 6000
//     Application type - Private
//     Distance sale - yes
//
// Any of "-", ":", "=" or "—" separates label from value; labels are matched
// loosely (case, spaces and punctuation stripped). Everything here is pure and
// synchronous. A brief this cannot read is reported field by field rather than
// guessed at — a silently mis-parsed cash price fills a live CRM with the
// wrong deal.
// ---------------------------------------------------------------------------
import { normaliseMobile, parseDob, formatDob } from "./match.js";

const FIELD_ALIASES = {
  email: ["email", "emailaddress", "mail", "clientemail", "customeremail"],
  mobile: ["mobile", "mobileno", "mobilenumber", "phone", "phoneno", "phonenumber", "number", "mob", "cell", "contact", "contactnumber"],
  dob: ["dob", "dateofbirth", "birthdate", "birthday", "born"],
  reg: ["reg", "registration", "vehiclereg", "vehicleregistration", "vrm", "plate", "numberplate", "regno"],
  mileage: ["mileage", "miles", "currentmileage", "vehiclemileage", "odometer"],
  retail: ["retail", "retailprice", "retailvalue", "screenprice"],
  cashPrice: ["cashprice", "price", "vehicleprice", "cash", "saleprice", "totalprice"],
  financeType: ["financetype", "finance", "product", "producttype", "agreementtype"],
  term: ["term", "loanterm", "months", "termmonths", "length"],
  deposit: ["deposit", "downpayment", "upfront", "totaldeposit"],
  annualMileage: ["annualmileage", "milesperyear", "mileageperyear", "estimatedannualmileage", "annualmiles"],
  appType: ["applicationtype", "apptype", "customertype", "privateorbusiness", "type"],
  distanceSale: ["distancesale", "distance", "distanceselling"],
  notes: ["notes", "note", "comments", "other"],
};

const CANON = new Map();
for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
  for (const a of aliases) CANON.set(a, field);
}

const keyify = (s) => String(s || "").toLowerCase().replace(/[^a-z]/g, "");

// "£9,990" | "9990" | "£9,990.00" -> 9990
export function parseMoney(str) {
  const m = String(str ?? "").replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = parseFloat(m[0]);
  return Number.isFinite(n) ? n : null;
}

// "45k" -> 45000 ; "45,000" -> 45000 ; "45000 miles" -> 45000
export function parseMiles(str) {
  const s = String(str ?? "").replace(/,/g, "").toLowerCase();
  const k = s.match(/(\d+(?:\.\d+)?)\s*k\b/);
  if (k) return Math.round(parseFloat(k[1]) * 1000);
  const m = s.match(/\d+/);
  return m ? parseInt(m[0], 10) : null;
}

// ---------------------------------------------------------------------------
// Finance types, exactly as the AutoConvert modal's <select> has them.
// The value is what page.select() needs; the label is what we echo back.
// ---------------------------------------------------------------------------
export const FINANCE_TYPES = [
  { value: "1", label: "HP", aliases: ["hp", "hirepurchase"] },
  { value: "2", label: "PCP", aliases: ["pcp", "personalcontractpurchase"] },
  { value: "3", label: "Motor loan", aliases: ["motorloan", "loan"] },
  { value: "4", label: "Motor loan balloon", aliases: ["motorloanballoon", "loanballoon"] },
  { value: "5", label: "Contract hire", aliases: ["contracthire", "ch"] },
  { value: "6", label: "Cash purchase", aliases: ["cashpurchase"] },
  { value: "7", label: "Conditional sale", aliases: ["conditionalsale", "cs"] },
  { value: "8", label: "Personal contract hire", aliases: ["personalcontracthire", "pch"] },
  { value: "9", label: "Leasing", aliases: ["leasing", "lease"] },
  { value: "10", label: "HP balloon", aliases: ["hpballoon"] },
  { value: "11", label: "Conditional sale balloon", aliases: ["conditionalsaleballoon", "csballoon"] },
  { value: "12", label: "Lease purchase", aliases: ["leasepurchase", "lp"] },
];

export function resolveFinanceType(str) {
  const k = keyify(str);
  if (!k) return null;
  for (const t of FINANCE_TYPES) {
    if (t.aliases.includes(k) || keyify(t.label) === k) return t;
  }
  return null;
}

const YES = /^(y|yes|true|1|on)$/i;
const NO = /^(n|no|false|0|off)$/i;
function parseBool(str) {
  const s = String(str ?? "").trim();
  if (YES.test(s)) return true;
  if (NO.test(s)) return false;
  return null;
}

const env = (name, fallback) => {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
};

// ---------------------------------------------------------------------------
// parseBrief(text) -> { ok, brief, missing, warnings, ignored }
//
// Required to run at all: email, reg, mileage, cashPrice, and at least one of
// mobile / dob (that is the identity check against the search results — a job
// with neither would pick an applicant on email alone, and shared family email
// addresses are common enough that it is not safe to).
// ---------------------------------------------------------------------------
export function parseBrief(text) {
  const warnings = [];
  const ignored = [];
  const raw = {};

  for (const line of String(text || "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    // label [-:=—] value. A separator with space around it wins first, so a
    // hyphen inside the label ("e-mail") or the value ("R-Line") never splits
    // the line; only then fall back to a bare ":"/"="/"-".
    const m = t.match(/^(.+?)\s+[-:=—]\s+(.+)$/) || t.match(/^([^-:=—]+?)\s*[-:=—]\s*(.+)$/);
    if (!m) { if (t.length > 1) ignored.push(t); continue; }
    const field = CANON.get(keyify(m[1]));
    if (!field) { ignored.push(t); continue; }
    raw[field] = m[2].trim();
  }

  const brief = {};

  // Identity
  if (raw.email) {
    const em = raw.email.match(/[^\s<>]+@[^\s<>]+\.[^\s<>]+/);
    if (em) brief.email = em[0].toLowerCase();
    else warnings.push(`Email "${raw.email}" does not look like an email address.`);
  }
  if (raw.mobile) {
    const norm = normaliseMobile(raw.mobile);
    if (norm) brief.mobile = norm;
    else warnings.push(`Mobile "${raw.mobile}" could not be read as a phone number.`);
  }
  if (raw.dob) {
    const dob = parseDob(raw.dob);
    if (dob) brief.dob = formatDob(dob);
    else warnings.push(`DOB "${raw.dob}" could not be read — use DD/MM/YYYY.`);
  }

  // Vehicle
  if (raw.reg) {
    const reg = raw.reg.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (reg.length >= 4 && reg.length <= 8) brief.reg = reg;
    else warnings.push(`Registration "${raw.reg}" does not look like a UK plate.`);
  }
  if (raw.mileage != null) {
    const n = parseMiles(raw.mileage);
    if (n != null && n >= 0) brief.mileage = n;
    else warnings.push(`Mileage "${raw.mileage}" could not be read.`);
  }
  if (raw.retail != null) {
    const n = parseMoney(raw.retail);
    if (n != null) brief.retail = n;
    else warnings.push(`Retail price "${raw.retail}" could not be read.`);
  }

  // Finance
  if (raw.cashPrice != null) {
    const n = parseMoney(raw.cashPrice);
    if (n != null) brief.cashPrice = n;
    else warnings.push(`Cash price "${raw.cashPrice}" could not be read.`);
  }

  const ftRaw = raw.financeType ?? env("DEFAULT_FINANCE_TYPE", "HP");
  const ft = resolveFinanceType(ftRaw);
  if (ft) brief.financeType = ft;
  else warnings.push(`Finance type "${ftRaw}" is not one AutoConvert offers (HP, PCP, Motor loan, ...).`);

  const termRaw = raw.term ?? env("DEFAULT_TERM", "60");
  const term = parseInt(String(termRaw).match(/\d+/)?.[0] ?? "", 10);
  if (Number.isFinite(term) && term >= 1 && term <= 180) brief.term = term;
  else warnings.push(`Term "${termRaw}" must be 1–180 months.`);

  const depRaw = raw.deposit ?? env("DEFAULT_DEPOSIT", "0");
  const dep = parseMoney(depRaw);
  if (dep != null && dep >= 0) brief.deposit = dep;
  else warnings.push(`Deposit "${depRaw}" could not be read.`);

  const amRaw = raw.annualMileage ?? env("DEFAULT_ANNUAL_MILEAGE", "6000");
  const am = parseMiles(amRaw);
  if (am != null && am >= 0) brief.annualMileage = am;
  else warnings.push(`Annual mileage "${amRaw}" could not be read.`);

  const atRaw = raw.appType ?? env("DEFAULT_APP_TYPE", "Private");
  const atKey = keyify(atRaw);
  if (["private", "personal", "individual", "0"].includes(atKey)) brief.appType = "Private";
  else if (["business", "company", "commercial", "1"].includes(atKey)) brief.appType = "Business";
  else warnings.push(`Application type "${atRaw}" must be Private or Business.`);

  const dsRaw = raw.distanceSale ?? env("DEFAULT_DISTANCE_SALE", "yes");
  const ds = parseBool(dsRaw);
  if (ds != null) brief.distanceSale = ds;
  else warnings.push(`Distance sale "${dsRaw}" must be yes or no.`);

  if (raw.notes) brief.notes = raw.notes;

  // Retail defaults to the cash price — the modal wants a value and the two
  // are the same number in almost every deal this desk writes.
  if (brief.retail == null && brief.cashPrice != null) {
    brief.retail = brief.cashPrice;
    warnings.push(`No retail price given — using the cash price (£${brief.cashPrice}).`);
  }

  const missing = [];
  if (!brief.email) missing.push("Email");
  if (!brief.reg) missing.push("Reg");
  if (brief.mileage == null) missing.push("Mileage");
  if (brief.cashPrice == null) missing.push("Cash price");
  if (!brief.mobile && !brief.dob) missing.push("Mobile or DOB (needed to verify the right applicant)");

  // How many recognised labels were actually read. Defaults fill several
  // fields even for an empty paste, so "did this look like a brief at all?"
  // has to be answered from the input, not from the output.
  const fieldsRead = Object.keys(raw).length;

  return { ok: missing.length === 0, brief, missing, warnings, ignored, fieldsRead };
}

// What the bot echoes back before asking for confirmation.
export function describeBrief(b) {
  const gbp = (n) => `£${Number(n).toLocaleString("en-GB")}`;
  const lines = [
    `Email: ${b.email || "—"}`,
    b.mobile ? `Mobile: ${b.mobile}` : null,
    b.dob ? `DOB: ${b.dob}` : null,
    `Reg: ${b.reg || "—"}`,
    `Mileage: ${b.mileage != null ? b.mileage.toLocaleString("en-GB") : "—"}`,
    `Retail value: ${b.retail != null ? gbp(b.retail) : "—"}`,
    `Cash price: ${b.cashPrice != null ? gbp(b.cashPrice) : "—"}`,
    `Finance: ${b.financeType?.label || "—"} · ${b.term} months · deposit ${gbp(b.deposit ?? 0)}`,
    `Annual mileage: ${b.annualMileage?.toLocaleString("en-GB")}`,
    `Type: ${b.appType} · Distance sale: ${b.distanceSale ? "Yes" : "No"}`,
    b.notes ? `Notes: ${b.notes}` : null,
  ];
  return lines.filter(Boolean).join("\n");
}
