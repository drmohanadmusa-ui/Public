// Ledger SMS Logger — Scriptable (iPhone)
// Reads a bank SMS, pulls out the transaction, appends one tab-separated row to
// iCloud Drive/Scriptable/Ledger Inbox.tsv.
// HOW IT WORKS, HOW TO ADD A BANK OR A MESSAGE TYPE: see README.md next to this file.
// Tests: node test_parsers.js

const FILE = "Ledger Inbox.tsv";
const NOTIFY = true;
// SAR per 1 unit of a foreign currency. Only pegged currencies belong here; any other
// currency is logged with its foreign amount and a blank SAR amount for you to type.
const FX_TO_SAR = { USD: 3.75 };
const HEADER = ["Date", "Time", "Source", "Acct", "Counter Acct", "Type", "Description",
  "Amount SAR", "Acct Dr/Cr", "Fee SAR", "Currency", "FX Amount", "Remaining", "Logged At"].join("\t");

// ---------- helpers ----------
const clean = s => s.replace(/[‎‏‪-‮⁦-⁩]/g, "");
const num = s => (s || "").replace(/,/g, "");
const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const normalise = s => clean(s)
  .replace(/[؜﻿]/g, "")                                   // more direction marks
  .replace(/[  -​ ]/g, " ")                     // odd spaces
  .replace(/[٠-٩]/g, d => ARABIC_DIGITS.indexOf(d))       // Arabic-Indic digits
  .replace(/٫/g, ".").replace(/٬/g, ",")                  // Arabic decimal/thousands
  .replace(/\r/g, "");
// non-empty, trimmed lines
const linesOf = t => t.split("\n").map(l => l.trim()).filter(Boolean);
// first number on the first line containing `word` — works whether SAR comes before or after it
const amountOn = (t, word) => {
  const line = t.split("\n").find(l => l.includes(word));
  const m = line && line.match(/\d[\d,]*(?:\.\d+)?/);
  return m ? num(m[0]) : "";
};
// text after a label at the start of a line: "مبلغ: SAR 5", "مبلغ:SAR 5", "المبلغSAR 5"
const field = (lines, ...labels) => {
  for (const l of lines) for (const lab of labels) {
    if (l.startsWith(lab)) return l.slice(lab.length).replace(/^\s*:?\s*/, "").trim();
  }
  return "";
};
// "SAR 1,475" / "40 MYR" / "MYR 52.35" -> {cur, amt}
const money = s => {
  const cur = ((s || "").match(/\b([A-Z]{3})\b/) || [])[1] || "SAR";
  const m = (s || "").match(/\d[\d,]*(?:\.\d+)?/);
  return { cur, amt: m ? num(m[0]) : "" };
};
// a foreign amount converted to SAR when the rate is fixed, otherwise blank (you type it)
const toSar = ({ cur, amt }) => {
  if (!amt) return "";
  if (cur === "SAR") return amt;
  const r = FX_TO_SAR[cur];
  return r ? (Math.round(parseFloat(amt) * r * 100) / 100).toFixed(2) : "";
};
const last4 = t => { const m = t.match(/\*+\s*(\d{4})|(\d{4})\s*\*+/); return m ? (m[1] || m[2]) : ""; };
const xAcct = s => { const m = (s || "").match(/X+\s*(\d{4})|^(\d{4})$/); return m ? (m[1] || m[2]) : ""; };
const stripAcct = s => (s || "").replace(/X+\s*\d{4}/g, "").replace(/\s+/g, " ").trim();
const dmy = t => { // dd/mm/yy -> yyyy-mm-dd
  const m = t.match(/(\d{1,2})\/(\d{1,2})\/(\d{2})(?!\d)/);
  return m ? `20${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : "";
};
const hhmm = t => { const m = t.match(/(\d{1,2}:\d{2})/); return m ? m[1] : ""; };
// "mm-dd hh:mm" with no year: the latest such date that is not after today (+1 day slack)
const TODAY = () => (typeof __NOW__ !== "undefined" ? new Date(__NOW__) : new Date());
const mdNoYear = t => {
  const m = t.match(/(\d{2})-(\d{2})\s*(\d{1,2}:\d{2})/);
  if (!m) return { date: "", time: "" };
  const now = TODAY();
  let y = now.getFullYear();
  const asDate = yy => new Date(yy, parseInt(m[1], 10) - 1, parseInt(m[2], 10));
  if (asDate(y) - now > 86400000) y -= 1;  // a December SMS read in January belongs to last year
  return { date: `${y}-${m[1]}-${m[2]}`, time: m[3] };
};
// Arabic names that appear in bank SMS -> English (anything not listed stays as written)
const TRANSLATE = {
  "السعودية للطاقة": "Saudi Electricity",
  "مدفوعات بنك الامارات": "Emirates NBD payment",
  "المخالفات المرورية": "Traffic fines",
  "الجوازات السعودية": "Passports (Jawazat)",
  "تجديد جواز سفر": "Passport renewal",
};
const tr = s => { const k = (s || "").trim(); return TRANSLATE[k] || k; };

// ---------- one parser per bank / message family ----------
// parse() returns: {date, time, acct, counter, type, desc, amount, side, fee, currency, fxAmount, remaining}
//   acct     = the account/card this row belongs to (last 4, or "Travel" for the SAIB travel card)
//   counter  = your OTHER account when money moves between your own accounts, else ""
//   side     = Dr/Cr on `acct` (money out of a bank account or onto a credit card = Cr)
//   amount   = SAR; blank when the SMS only gives a foreign currency that has no fixed rate
// Return null from parse() to skip a message the test() let through.
const PARSERS = [
  {
    source: "SNB CC",
    test: t => t.includes("الصرف المتبقي"),          // remaining limit — CC transactions only
    parse: t => {
      const refund = /استرجاع/.test(t);
      let type = refund ? "Cashback/Refund"
        : /إنترنت/.test(t) ? "Online purchase"
        : "POS purchase";
      if (!refund && /Apple Pay/i.test(t)) type += " (Apple Pay)";
      const merch = t.match(/(?:^|\n)\s*من\s+([^\n]+)/);
      return {
        date: dmy(t), time: hhmm(t), acct: last4(t), type,
        desc: merch ? merch[1].trim() : type,
        amount: amountOn(t, "مبلغ"),
        side: refund ? "Dr" : "Cr",
        currency: "SAR",
        remaining: amountOn(t, "المتبقي"),
      };
    },
  },
  {
    source: "SAIB",
    // every SAIB transaction names an account as XXX1234 / X1234 / من1234, or the travel card
    test: t => /^(شراء|اعادة مبلغ|اضافة مبلغ|حوالة|مدفوعات|سداد فاتورة)/.test(linesOf(t)[0] || "")
               && /X{1,3}\s*\d{4}|من\d{4}|بطاقة السفر|سفر/.test(t),
    parse: t => {
      const L = linesOf(t), head = L[0];
      const { date, time } = mdNoYear(t);
      const base = { date, time, counter: "", fee: "", remaining: "" };
      // amount line: "مبلغ: SAR 5" / "المبلغ: SAR 5" / mada style "بSAR 5" (ب + currency code only,
      // so the card line "بطاقة:XXX1234" is never read as an amount)
      const madaAmt = L.find(l => /^ب\s*[A-Z]{3}\s*\d/.test(l));
      const amt = money(field(L, "المبلغ", "مبلغ") || (madaAmt ? madaAmt.slice(1) : ""));
      const fx = m => m.cur === "SAR" ? { currency: "SAR", fxAmount: "" } : { currency: m.cur, fxAmount: m.amt };
      const withFx = (m, desc) => m.cur === "SAR" ? desc : `${desc} (${m.cur} ${m.amt})`;

      // ---- travel card (multi-currency) ----
      if (head.startsWith("شراء") && /سفر/.test(t)) {
        const merchant = field(L, "لدى");
        const rem = money(field(L, "رصيد"));
        return { ...base, acct: "Travel",
          type: (/دولي|نقاط البيع/.test(head) ? "International POS purchase" : "Online purchase")
                + (/Apple Pay/i.test(t) ? " (Apple Pay)" : ""),
          desc: withFx(amt, merchant), amount: toSar(amt), side: "Cr", ...fx(amt),
          remaining: rem.amt ? `${rem.cur} ${rem.amt}` : "" };
      }
      if (head.startsWith("اعادة مبلغ من بطاقة السفر")) {
        return { ...base, acct: "Travel", counter: xAcct(field(L, "الى")),
          type: "Travel card refund to account", desc: withFx(amt, "Travel card refund"),
          amount: toSar(amt), side: "Cr", ...fx(amt) };
      }
      if (head.startsWith("اضافة مبلغ لبطاقة السفر")) {
        return { ...base, acct: xAcct(field(L, "من")), counter: "Travel",
          type: "Travel card top-up", desc: withFx(amt, "Travel card top-up"),
          amount: toSar(amt), side: "Cr", ...fx(amt) };
      }

      // ---- mada card purchases ----
      if (head.startsWith("شراء") && /مدى/.test(t)) {
        const online = /انترنت/.test(head);
        const merchant = online ? field(L, "لدى") : field(L.filter(l => !/^من\s*[:]?\s*(X|\d|[A-Z]{3}$)/.test(l)), "من");
        const acctLine = L.find(l => /^من\d{4}$/.test(l));
        return { ...base, acct: acctLine ? acctLine.slice(2) : xAcct((t.match(/X\d{4}/) || [""])[0]),
          type: (online ? "Online purchase" : "POS purchase") + (/ابل/.test(t) ? " (Apple Pay)" : ""),
          desc: merchant, amount: toSar(amt), side: "Cr", ...fx(amt) };
      }

      // ---- transfers ----
      if (head.startsWith("حوالة صادرة") && /بين حساباتك/.test(head)) {
        return { ...base, acct: xAcct(field(L, "من")), counter: xAcct(field(L, "الى")),
          type: "Transfer between own accounts", desc: "Transfer between own accounts",
          amount: toSar(amt), side: "Cr", ...fx(amt) };
      }
      if (head.startsWith("حوالة صادرة")) {
        return { ...base, acct: xAcct(field(L, "من")), type: "Outgoing transfer",
          desc: stripAcct(field(L, "الى")), amount: toSar(amt), side: "Cr", ...fx(amt) };
      }
      if (head.startsWith("حوالة واردة")) {
        return { ...base, acct: xAcct(field(L, "الى")), type: "Incoming transfer",
          desc: stripAcct(field(L, "من")), amount: toSar(amt), side: "Dr", ...fx(amt) };
      }
      if (head.startsWith("حوالة محلية")) {
        const names = L.filter(l => l.startsWith("الى")).map(l => l.slice(3).replace(/^\s*:?\s*/, ""));
        const name = names.find(n => !/^X+\d{4}$/.test(n)) || "";
        const bank = field(L, "المصرف");
        return { ...base, acct: xAcct(field(L, "من")), type: "Local transfer (other bank)",
          desc: bank ? `${name} (${bank})` : name, amount: toSar(amt), side: "Cr",
          fee: money(field(L, "الرسوم")).amt, ...fx(amt) };
      }

      // ---- payments ----
      if (head.startsWith("مدفوعات وزارة الداخلية")) {
        const agency = tr(field(L, "الجهة")), service = field(L, "الخدمة");
        const parts = ["MOI", agency];
        if (TRANSLATE[service]) parts.push(TRANSLATE[service]);
        return { ...base, acct: xAcct(field(L, "من")), type: "MOI payment",
          desc: parts.join(" · "), amount: toSar(amt), side: "Cr", ...fx(amt) };
      }
      if (head.startsWith("سداد فاتورة")) {
        const biller = tr(field(L, "مفوتر").replace(/^\d+\s*/, ""));
        return { ...base, acct: xAcct(field(L, "من")), type: "Bill payment (SADAD)",
          desc: biller, amount: toSar(amt), side: "Cr", ...fx(amt) };
      }
      return null;   // a SAIB message type we don't log
    },
  },
  // next banks get added here (see README.md, "Adding a bank")
];

// ---------- main ----------
async function main() {
  let input = args.shortcutParameter;
  if (input && typeof input !== "string") input = input.content || input.text || String(input);
  const manual = !input;
  if (manual) input = Pasteboard.pasteString() || "";
  const text = normalise(input);

  let p = null, r = null;
  for (const x of PARSERS) {
    if (!x.test(text)) continue;
    r = x.parse(text);
    if (r) { p = x; break; }
  }
  if (!r) return "Skipped: not a recognised transaction SMS";
  r = Object.assign({ counter: "", fee: "", currency: "SAR", fxAmount: "", remaining: "" }, r);

  const fm = FileManager.iCloud();
  if (!r.amount && !r.fxAmount) {   // nothing usable: save the raw text so the parser can be fixed
    const dbg = fm.joinPath(fm.documentsDirectory(), "Ledger Debug.txt");
    fm.writeString(dbg, JSON.stringify(input) + "\n" +
      [...input].map(c => c.charCodeAt(0).toString(16)).join(" "));
  }

  const df = new DateFormatter();
  df.dateFormat = "yyyy-MM-dd HH:mm";
  const core = [r.date, r.time, p.source, r.acct, r.counter, r.type, r.desc, r.amount, r.side,
    r.fee, r.currency, r.fxAmount, r.remaining].join("\t");
  const line = core + "\t" + df.string(new Date());

  const path = fm.joinPath(fm.documentsDirectory(), FILE);
  let existing = "";
  if (fm.fileExists(path)) {
    await fm.downloadFileFromiCloud(path);
    existing = fm.readString(path) || "";
  }
  const shown = r.amount ? `SAR ${r.amount}` : `${r.currency} ${r.fxAmount}`;
  if (existing.includes(core)) return `Duplicate, not logged: ${r.desc} ${shown}`;

  // a file from an older version (different columns) is kept aside, not mixed in
  if (existing && !existing.startsWith(HEADER)) {
    fm.writeString(fm.joinPath(fm.documentsDirectory(), "Ledger Inbox (old columns).tsv"), existing);
    existing = "";
  }
  const base = existing ? existing.replace(/\n*$/, "\n") : HEADER + "\n";
  fm.writeString(path, base + line + "\n");

  const msg = `${p.source} · ${shown} · ${r.desc}`;
  if (NOTIFY) {
    const n = new Notification();
    n.title = "Logged to Ledger Inbox";
    n.body = msg;
    await n.schedule();
  }
  return "Logged: " + msg;
}

const result = await main();
if (config.runsInApp) { const a = new Alert(); a.message = result; a.addAction("OK"); await a.present(); }
Script.setShortcutOutput(result);
Script.complete();
