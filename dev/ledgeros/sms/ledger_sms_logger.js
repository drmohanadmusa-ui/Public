// Ledger SMS Logger — Scriptable (iPhone)
// Reads a bank SMS, pulls out the transaction, appends one tab-separated row to
// iCloud Drive/Scriptable/Ledger Inbox.tsv.
// HOW IT WORKS, HOW TO ADD A BANK OR A MESSAGE TYPE: see README.md next to this file.
// Tests: node test_parsers.js

const FILE = "Ledger Inbox.tsv";
const QUEUE_FILE = "Ledger Upload Queue.json";      // rows waiting to reach LedgerOS (no signal, etc.)
// LedgerOS's Supabase URL and key live in this phone's Keychain, never in this file:
// run the script inside Scriptable with no SMS on the clipboard to set them.
const KC_URL = "ledgeros_sb_url", KC_KEY = "ledgeros_sb_key";
const NOTIFY = true;            // "Logged to Ledger Inbox" after each logged transaction
const NOTIFY_FAILURES = true;   // a notice when something fails (upload refused, error), even if NOTIFY is off
const RUN_LOG = "Ledger Run Log.txt", RUN_LOG_KEEP = 100;   // last 100 runs, to see whether an SMS started the script
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
  .replace(/\u0640/g, "")                                          // tatweel: "بـSAR" -> "بSAR"
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
  const m = (s || "").match(/\d[\d,]*(?:\.\d+)?|\.\d+/);
  return { cur, amt: m ? num(m[0]).replace(/^\./, "0.") : "" };
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
// "26/10/1 11:36" (yy/m/d) or "3/10/26 22:12" (d/m/yy): Al Rajhi uses both. Try both readings and
// keep the valid one closest to today that isn't in the future (+1 day slack).
const ymdOrDmy = t => {
  const m = t.match(/(\d{1,2})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})/);
  if (!m) return { date: "", time: "" };
  const now = TODAY(), pad = n => String(n).padStart(2, "0");
  const time = `${pad(m[4])}:${m[5]}`;
  const cands = [[m[1], m[2], m[3]], [m[3], m[2], m[1]]].map(([yy, mo, dd]) => {
    const y = 2000 + parseInt(yy, 10), mm = parseInt(mo, 10), d = parseInt(dd, 10);
    const dt = new Date(y, mm - 1, d);
    const ok = mm >= 1 && mm <= 12 && dt.getDate() === d && dt - now <= 86400000;
    return ok ? { date: `${y}-${pad(mm)}-${pad(d)}`, gap: Math.abs(now - dt) } : null;
  }).filter(Boolean).sort((a, b) => a.gap - b.gap);
  return { date: cands.length ? cands[0].date : "", time };
};
// "23/02/2026 10:09" or "12/08/26 09:10" (day first), or "2026-02-23" with a separate "Time: 10:58:08"
const dmyAny = t => {
  const m = t.match(/(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})\s+(\d{1,2}):(\d{2})/);
  const pad = n => String(n).padStart(2, "0");
  if (m) return { date: `${m[3].length === 2 ? "20" + m[3] : m[3]}-${pad(m[2])}-${pad(m[1])}`, time: `${pad(m[4])}:${m[5]}` };
  const iso = t.match(/(\d{4})-(\d{2})-(\d{2})/), tm = t.match(/Time:\s*(\d{1,2}):(\d{2})/i);
  return { date: iso ? `${iso[1]}-${iso[2]}-${iso[3]}` : "", time: tm ? `${pad(tm[1])}:${tm[2]}` : "" };
};
// any d/m/y-looking date (2- or 4-digit year), either order, closest valid day not in the future;
// "3/10/2026 10:11 PM" (12-hour clock) is US month-first. Time is read separately.
// order "dmy" = the bank always writes the day first (no guessing between readings)
const anyDate = (t, order) => {
  const pad = n => String(n).padStart(2, "0");
  const iso = t.match(/(\d{4})-(\d{2})-(\d{2})/);
  let date = "";
  if (iso) date = `${iso[1]}-${iso[2]}-${iso[3]}`;
  else {
    const m = t.match(/(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})(?!\d)/) || t.match(/(?<!\d)(\d{1,2})-(\d{1,2})-(\d{4})(?!\d)/);
    if (m) {
      const now = TODAY(), ampm = /\d:\d{2}\W*[AP]M/i.test(t);
      const read = (dd, mo, yy) => {
        const y = yy.length === 4 ? parseInt(yy, 10) : 2000 + parseInt(yy, 10), mm = parseInt(mo, 10), d = parseInt(dd, 10);
        const dt = new Date(y, mm - 1, d);
        return (mm >= 1 && mm <= 12 && dt.getDate() === d && dt - now <= 86400000) ? { date: `${y}-${pad(mm)}-${pad(d)}`, gap: Math.abs(now - dt) } : null;
      };
      const cands = (ampm ? [read(m[2], m[1], m[3])]
        : (m[3].length === 4 || order === "dmy") ? [read(m[1], m[2], m[3])]
        : [read(m[1], m[2], m[3]), read(m[3], m[2], m[1])]).filter(Boolean).sort((a, b) => a.gap - b.gap);
      date = cands.length ? cands[0].date : "";
    }
  }
  const tm = t.match(/(\d{1,2}):(\d{2})(?::\d{2})?\W*([AP]M)?/i);
  let time = "";
  if (tm) {
    let h = parseInt(tm[1], 10);
    if (tm[3] && /PM/i.test(tm[3]) && h < 12) h += 12;
    if (tm[3] && /AM/i.test(tm[3]) && h === 12) h = 0;
    time = `${pad(h)}:${tm[2]}`;
  }
  return { date, time };
};
// first line that contains one of `inc`, none of `exc`, and a number
const lineWithNum = (L, inc, exc = []) => L.find(l => inc.some(w => l.includes(w)) && !exc.some(w => l.includes(w)) && /\d/.test(l)) || "";
// first line that contains one of `inc` and none of `exc`
const lineWith = (L, inc, exc = []) => L.find(l => inc.some(w => l.includes(w)) && !exc.some(w => l.includes(w))) || "";
// a line's text with an Arabic label word removed, whichever side it is on
// Only at the START or END of the line: names like "عبدالمنعم" contain "من" and "ل" inside them.
const without = (line, ...words) => words.reduce((s, w) => {
  const e = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return s.replace(new RegExp(`^\\s*${e}\\s*:?\\s*`), "").replace(new RegExp(`\\s*:?\\s*${e}\\s*$`), "");
}, (line || "").trim()).replace(/\s+/g, " ").trim();
// a line that is only an amount, maybe with a leading "ب" ("بSAR 274.00" / "SAR 274.00ب")
const isAmountLine = l => /^\s*ب?\s*(?:[A-Z]{3}\s*[\d.,]+|[\d.,]+\s*[A-Z]{3})\s*ب?\s*$/.test(l);
const masked4 = s => { const m = (s || "").match(/\*+\s*(\d{4})(?!\d)|(?<!\d)(\d{4})\s*\*+/); return m ? (m[1] || m[2]) : ""; };
// merchants that are really your own wallets: a purchase there is a transfer to that wallet.
// LedgerOS maps these names to accounts like any other Acct/Counter value.
const OWN_WALLETS = [[/URPAY/i, "urpay"], [/MYSR|D360|D36\)/i, "D360"], [/STC ?PAY|STC ?BANK/i, "STC"]];
const ownWallet = merchant => { const w = OWN_WALLETS.find(([re]) => re.test(merchant || "")); return w ? w[1] : ""; };

// Arabic names that appear in bank SMS -> English (anything not listed stays as written)
const TRANSLATE = {
  "السعودية للطاقة": "Saudi Electricity",
  "مدفوعات بنك الامارات": "Emirates NBD payment",
  "المخالفات المرورية": "Traffic fines",
  "الجوازات السعودية": "Passports (Jawazat)",
  "تجديد جواز سفر": "Passport renewal",
  "منصة ايجار": "Ejar platform",
  "البنك السعودي البريطاني ساب": "SAB",
  "الولايات المتحدة الامريكية": "USA",
  "تمويل شخصي": "Personal finance",
  "تمويل عقاري": "Home finance",
  "شركة منصة سلة للاتصالات وتقنية المعلومات": "Salla",
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
    // SNB sends Arabic SMS for both the credit card(s) and the debit account. Lines are matched by
    // keyword wherever it sits in the line, because Arabic lines are stored in a different order
    // from how they are displayed. Rows: source "SNB CC" (acct = card last 4) or "SNB" (acct = "SNB debit";
    // many debit SMS don't name your own account at all).
    source: "SNB",
    test: t => {
      const h = linesOf(t)[0] || "";
      if (/غير ناجح|لا تشارك|الرقم السري|رمز التفعيل|تم تغيير|تم إصدار|تم تفعيل|مبروك|إيقاف|إلغاء|تجميد|ايقاف/.test(h)) return false;
      return (/الصرف المتبقي|الرصيد المتبقي|حوالة عكسية|إسترداد مبلغ|استرداد مبلغ|الرسوم السنوية|حوالة واردة|حوالة صادرة|ايداع رواتب|إيداع رواتب|سداد بطاقة|قسط تمويل|مدى/.test(t)
              // newer credit card wording (Nov 2026): "الرصيد 1,234SAR" instead of "الصرف المتبقي"
              || (/ائتمان|إئتمان|إتمان/.test(t) && /الرصيد/.test(t)))
             && !/X{1,3}\s*\d{4}|بطاقة السفر/.test(t);   // SAIB writes accounts as XXX1234
    },
    parse: t => {
      const L = linesOf(t), head = L[0];
      const { date, time } = anyDate(t);
      const base = { date, time, counter: "", fee: "", remaining: "" };
      const amtOf = line => money(line);
      const fxPack = (m, rate) => {
        if (m.cur === "SAR") return { amount: m.amt, currency: "SAR", fxAmount: "" };
        const r = parseFloat(rate || "");
        return { amount: r ? (Math.round(parseFloat(m.amt) * r * 100) / 100).toFixed(2) : toSar(m), currency: m.cur, fxAmount: m.amt };
      };
      const isCC = /ائتمان|إئتمان|إتمان/.test(t);
      const remainingOf = () => { const l = lineWith(L, ["المتبقي", "المتبقى"]) || lineWithNum(L, ["الرصيد"]); return l ? money(l).amt : ""; };

      // ---------- credit card ----------
      if (/الرسوم السنوية/.test(t)) {
        const m = money((t.match(/بمبلغ\s*([\d.,]+)/) || ["", ""])[1] + " SAR");
        return { ...base, source: "SNB CC", acct: masked4(t), type: "Annual card fee", desc: "Annual card fee", side: "Cr", ...fxPack(m) };
      }
      if (isCC && !/سداد بطاقة/.test(t)) {
        const card = L.filter(l => /بطاقة|ائتمان|إئتمان|إتمان/.test(l)).map(masked4).find(Boolean) || masked4(t);
        const refundish = /استرجاع|إسترداد|استرداد|حوالة عكسية/.test(t);
        const amtLine = L.find(isAmountLine) || lineWithNum(L, ["مبلغ"], ["المتبقي", "المتبقى", "رسوم", "سعر الصرف"]);
        const m = amtOf(amtLine);
        const rate = (lineWith(L, ["سعر الصرف"]).match(/\d+(?:\.\d+)?/) || [""])[0];
        const fee = money(lineWith(L, ["رسوم العمليات الدولية"])).amt;
        const merchLine = lineWith(L, ["من ", "لدى"], ["بطاقة", "ائتمان", "إئتمان"])
          || L.find(l => /^من(?=[A-Za-z0-9])/.test(l)) || "";   // "منTEST SHOP" (no space)
        const merchant = without(merchLine, "لدى", "من");
        let type = /استرجاع/.test(t) ? "Cashback" : /حوالة عكسية/.test(t) ? "Reversal/refund" : /إسترداد|استرداد/.test(t) ? "Refund"
          : /POS/i.test(head) ? "POS purchase" : "Online purchase";
        if (!refundish && /Apple Pay/i.test(t)) type += " (Apple Pay)";
        const pk = fxPack(m, rate);
        let feeOut = fee && parseFloat(fee) > 0 ? fee : "";
        if (feeOut && pk.amount) {            // his choice: the international (FX) fee is part of the purchase amount
          pk.amount = (Math.round((parseFloat(pk.amount) + parseFloat(feeOut)) * 100) / 100).toFixed(2);
          feeOut = "";
        }
        return { ...base, source: "SNB CC", acct: card, type,
          desc: merchant ? (pk.currency === "SAR" ? merchant : `${merchant} (${pk.currency} ${pk.fxAmount})`) : type,
          side: refundish ? "Dr" : "Cr", fee: feeOut, remaining: remainingOf(), ...pk };
      }

      // ---------- debit account ----------
      const deb = { ...base, source: "SNB", acct: "SNB debit" };
      if (/سداد بطاقة/.test(t)) {
        const m = amtOf(lineWithNum(L, ["مبلغ"], ["المتبقي"]));
        return { ...deb, counter: masked4(lineWith(L, ["بطاقة"], ["سداد"])), type: "Credit card payment",
          desc: "Credit card payment", side: "Cr", ...fxPack(m) };
      }
      if (/قسط تمويل/.test(t)) {
        const m = amtOf(lineWith(L, ["القسط"], ["خصم"]));
        const loan = tr(without(lineWith(L, ["تمويل"], ["قسط"]), "ل"));
        return { ...deb, type: "Finance instalment", desc: loan ? `${loan} instalment` : "Finance instalment",
          side: "Cr", remaining: money(lineWith(L, ["المتبقي"])).amt, ...fxPack(m) };
      }
      if (/ايداع رواتب|إيداع رواتب/.test(t)) {
        return { ...deb, type: "Salary", desc: "Salary deposit", side: "Dr", ...fxPack(amtOf(lineWithNum(L, ["مبلغ"]))) };
      }
      if (/حوالة واردة محلية/.test(head)) {
        const sender = without(lineWith(L, ["مرسل"]), "مرسل من", "مرسل");
        const bank = tr(without(lineWith(L, ["عبر"]), "عبر"));
        return { ...deb, counter: masked4(lineWith(L, ["من "], ["مرسل"])), type: "Incoming transfer (other bank)",
          desc: bank ? `${sender} (via ${bank})` : sender, side: "Dr", ...fxPack(amtOf(lineWithNum(L, ["مبلغ"]))) };
      }
      if (/حوالة واردة/.test(head)) {          // internal: amount on the heading, "من9302* name" below
        const who = L[1] || "";
        return { ...deb, counter: masked4(who), type: "Incoming transfer",
          desc: without(who.replace(/\*?\d{4}\*?/, ""), "من"), side: "Dr", ...fxPack(amtOf(head)) };
      }
      if (/حوالة صادرة دولية/.test(head)) {
        const ben = without(lineWith(L, ["مستفيد"]), "مستفيد");
        const country = tr(without(lineWith(L, ["دولة"]), "دولة"));
        const bank = without(lineWith(L, ["بنك "], ["مستفيد"]), "بنك");
        const extra = [bank, country].filter(Boolean).join(", ");
        return { ...deb, counter: masked4(lineWith(L, ["إلى", "الى"])), type: "International transfer",
          desc: extra ? `${ben} (${extra})` : ben, side: "Cr",
          fee: money(lineWith(L, ["رسوم"])).amt, ...fxPack(amtOf(lineWithNum(L, ["مبلغ"], ["رسوم"]))) };
      }
      if (/حوالة صادرة/.test(head)) {          // internal or local: amount on the heading, "ل9302* name" below
        const who = L[1] || "";
        return { ...deb, counter: masked4(who), type: /محلية/.test(head) ? "Outgoing transfer (other bank)" : "Outgoing transfer",
          desc: without(who.replace(/\*?\d{4}\*?/, "").replace(/\*/g, ""), "ل"), side: "Cr", ...fxPack(amtOf(head)) };
      }
      if (/^شراء/.test(head) && /مدى/.test(t)) {
        const merchLine = L.find(l => /من/.test(l) && !/\d{4}/.test(l) && !isAmountLine(l)) || "";
        const merchant = without(merchLine, "من");
        const intl = /دولي/.test(head);
        const m = amtOf(L.find(isAmountLine) || lineWithNum(L, ["مبلغ"]));
        return { ...deb, counter: ownWallet(merchant),
          type: (intl ? "International online purchase" : /POS/i.test(head) ? "POS purchase" : "Online purchase") + (/ابل|Apple/i.test(t) ? " (Apple Pay)" : ""),
          desc: merchant, side: "Cr", ...fxPack(m) };
      }
      return null;
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
          counter: ownWallet(merchant),
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
        return { ...base, acct: xAcct(field(L, "من")), counter: xAcct((field(L, "الى").match(/X+\s*\d{4}/) || [""])[0]),
          type: "Outgoing transfer", desc: stripAcct(field(L, "الى")), amount: toSar(amt), side: "Cr", ...fx(amt) };
      }
      if (head.startsWith("حوالة واردة")) {
        return { ...base, acct: xAcct(field(L, "الى")), counter: xAcct((field(L, "من").match(/X+\s*\d{4}/) || [""])[0]),
          type: "Incoming transfer", desc: stripAcct(field(L, "من")), amount: toSar(amt), side: "Dr", ...fx(amt) };
      }
      if (head.startsWith("حوالة محلية")) {
        const names = L.filter(l => l.startsWith("الى")).map(l => l.slice(3).replace(/^\s*:?\s*/, ""));
        const name = names.find(n => !/^X+\d{4}$/.test(n)) || "";
        const bank = field(L, "المصرف");
        const toAcct = L.find(l => /^الى\s*:?\s*X+\d{4}$/.test(l));
        return { ...base, acct: xAcct(field(L, "من")), counter: toAcct ? xAcct(toAcct.replace(/^الى\s*:?\s*/, "")) : "",
          type: "Local transfer (other bank)",
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
  {
    source: "Al Rajhi",
    // English "Key:Value" lines; told apart from other English banks by Al Rajhi's own markers:
    // "SR" for riyals, "Card:7777 ;Visa", "By:6666;mada", "To:5555"/"From:5555" (digits right after the colon)
    test: t => /^(Credit Transfer|Debit Internal Transfer|Credit Card\s*:\s*(Payment|transfer)|Online Purchase|PoS|POS|Reverse Transaction|Withdrawal\s*:\s*ATM|Drahim portfolio)/i.test(linesOf(t)[0] || "")
               && /\bSR\b|Card:\s?(Visa\s)?\d{4}|By:\d{4}|(To|From)( Account| card)?:\d{4}\b/.test(t),
    parse: t => {
      const L = linesOf(t), head = L[0];
      const all = key => L.filter(l => l.toLowerCase().startsWith(key.toLowerCase() + ":")).map(l => l.slice(key.length + 1).trim());
      const one = key => all(key)[0] || "";
      const acctOf = key => (all(key).find(v => /^\d{4}$/.test(v)) || "");
      const nameOf = key => (all(key).find(v => !/^\d{4}$/.test(v)) || "");
      const cardNo = s => ((s || "").match(/\d{4}/) || [""])[0];
      const amt = money(one("Amount").replace(/\bSR\b/, "SAR"));
      const fx = amt.cur === "SAR" ? { currency: "SAR", fxAmount: "" } : { currency: amt.cur, fxAmount: amt.amt };
      const withFx = d => amt.cur === "SAR" ? d : `${d} (${amt.cur} ${amt.amt})`;
      const bal = money(one("Balance").replace(/\bSR\b/, "SAR"));
      const remaining = bal.amt ? (bal.cur === "SAR" ? bal.amt : `${bal.cur} ${bal.amt}`) : "";
      const base = { ...ymdOrDmy(t), amount: toSar(amt), fee: "", ...fx };
      const applePay = /Apple Pay/i.test(t) ? " (Apple Pay)" : "";

      if (/^Credit Transfer/i.test(head)) {
        const via = one("Via");
        return { ...base, acct: acctOf("To"), counter: acctOf("From"),
          type: /Local/i.test(head) ? "Incoming transfer (other bank)" : "Incoming transfer",
          desc: via ? `${nameOf("From")} (via ${via})` : nameOf("From"), side: "Dr", remaining: "" };
      }
      if (/^Debit Internal Transfer/i.test(head)) {
        return { ...base, acct: acctOf("From"), counter: acctOf("To"), type: "Outgoing transfer",
          desc: nameOf("To"), side: "Cr", remaining: "" };
      }
      if (/^Credit Card\s*:\s*Payment/i.test(head)) {          // money loaded onto the Visa card
        return { ...base, acct: cardNo(one("Card")), counter: "Al Rajhi account", type: "Card top-up",
          desc: withFx("Card top-up"), side: "Dr", remaining };
      }
      if (/^Credit Card\s*:\s*transfer/i.test(head)) {         // card balance sent back to the account
        return { ...base, acct: cardNo(one("From card")), counter: cardNo(one("To Account")),
          type: "Card balance to account", desc: withFx("Card balance to account"), side: "Cr", remaining };
      }
      if (/^Drahim portfolio/i.test(head)) {
        const to = one("To");
        return { ...base, acct: acctOf("From"), counter: "", type: "Drahim portfolio top-up",
          desc: to ? `Drahim portfolio top-up (${to})` : "Drahim portfolio top-up", side: "Cr", remaining: "" };
      }
      if (/^Reverse Transaction/i.test(head)) {
        return { ...base, acct: cardNo(one("By")), counter: "", type: "Reversal/refund" + applePay,
          desc: withFx(`${one("At")} (reversal)`), side: "Dr", remaining };
      }
      if (/^Withdrawal\s*:\s*ATM/i.test(head)) {
        const place = one("Place");
        return { ...base, acct: cardNo(one("By")), counter: "", type: "ATM withdrawal",
          desc: withFx(place ? `ATM withdrawal (${place})` : "ATM withdrawal"), side: "Cr", remaining: "" };
      }
      // purchases: "Card:7777 ;Visa" (card only) or "By:6666;mada" + "From:5555" (card and account)
      const merchant = one("At");
      const acct = acctOf("From") || cardNo(one("Card") || one("By"));
      return { ...base, acct, counter: ownWallet(merchant),
        type: (/^PoS|^POS/i.test(head) ? (/International/i.test(head) ? "International POS purchase" : "POS purchase") : "Online purchase") + applePay,
        desc: withFx(merchant), side: "Cr", remaining };
    },
  },
  {
    source: "meem",
    // English "Key: Value" lines with masked numbers (***8888); told apart by meem's own labels
    test: t => /^(Local Credit transfer|Fund Transfer Approved|Online Purchase|Credit Transaction)/i.test(linesOf(t)[0] || "")
               && /Account Number:|Sender account number:|Sender Name:|^Credit Transaction:/im.test(t),
    parse: t => {
      const L = linesOf(t), head = L[0];
      const one = key => { const l = L.find(x => x.toLowerCase().startsWith(key.toLowerCase())); return l ? l.slice(key.length).replace(/^\s*:\s*/, "").trim() : ""; };
      const masked = s => ((s || "").match(/\*+\s*(\d{4})/) || [])[1] || "";
      const amt = money(one("Amount"));
      const fx = amt.cur === "SAR" ? { currency: "SAR", fxAmount: "" } : { currency: amt.cur, fxAmount: amt.amt };
      const feeOf = s => { const f = money(s).amt; return f && parseFloat(f) > 0 ? f : ""; };
      const base = { ...dmyAny(t), amount: toSar(amt), remaining: "", ...fx };

      if (/^Local Credit transfer/i.test(head)) {
        const name = tr(one("Sender Name")), via = one("Via");
        return { ...base, acct: masked(one("To")), counter: masked(one("From")), type: "Incoming transfer (other bank)",
          desc: via ? `${name} (via ${via})` : name, side: "Dr", fee: feeOf(one("Fees")) };
      }
      if (/^Fund Transfer Approved/i.test(head)) {
        const name = one("Beneficiary Name").replace(/\*+$/, "").trim(), bank = one("Name of beneficiary participant");
        return { ...base, acct: masked(one("Sender account number")), counter: masked(one("Beneficiary account number")),
          type: "Outgoing transfer (other bank)", desc: bank ? `${name} (${bank})` : name, side: "Cr", fee: feeOf(one("Fee")) };
      }
      if (/^Credit Transaction/i.test(head)) {
        const what = head.replace(/^Credit Transaction\s*:\s*/i, "").trim() || "Credit";
        return { ...base, acct: masked(one("To")), counter: "", type: what, desc: what, side: "Dr", fee: "" };
      }
      // Online Purchase: mada card + account
      const merchant = one("At").replace(/,\s*$/, "");
      return { ...base, acct: masked(one("Account Number")) || masked(one("mada Card")), counter: ownWallet(merchant),
        type: "Online purchase" + (/Apple Pay/i.test(t) ? " (Apple Pay)" : ""), desc: merchant, side: "Cr", fee: "" };
    },
  },
  {
    source: "STC",
    // STC Bank (formerly STC Pay): English headings, the wallet has one account so acct = "STC"
    test: t => /^(Adding money to account|Internal outward transfer|Internal incoming transfer|Internal transfer|Transfer via WU|Online Purchase Transaction Amount|STC pay wallet top up)/i.test(linesOf(t)[0] || ""),
    parse: t => {
      const L = linesOf(t), head = L[0];
      const one = key => { const l = L.find(x => x.toLowerCase().startsWith(key.toLowerCase())); return l ? l.slice(key.length).replace(/^\s*:?\s*/, "").trim() : ""; };
      const { date, time } = anyDate(t, "dmy");
      const base = { date, time, acct: "STC", counter: "", fee: "", remaining: "", currency: "SAR", fxAmount: "" };
      const sar = s => toSar(money((s || "").replace(/(\d)\s*SR\b/, "$1 SAR").replace(/\bSR\b/, "SAR")));
      if (/^Adding money|wallet top up/i.test(head)) {
        const via = one("Via") || one("Card");
        return { ...base, type: "Top-up", desc: via ? `Top-up (${via})` : "Top-up", amount: sar(one("Amount") || one("With")), side: "Dr" };
      }
      if (/^Online Purchase Transaction Amount/i.test(head)) {
        return { ...base, type: "Online purchase", desc: tr(one("From")), amount: sar(head.replace(/^Online Purchase Transaction Amount/i, "") + " SAR"),
          side: "Cr", counter: "" };
      }
      if (/^Transfer via WU/i.test(head)) {
        const who = one("Receiver"), country = one("Country");
        return { ...base, type: "International transfer (Western Union)", desc: country ? `${who} (WU, ${country})` : `${who} (WU)`,
          amount: sar(one("Amount")), fee: sar(one("Fees")), side: "Cr" };
      }
      const incoming = /incoming/i.test(head) || (/^Internal transfer/i.test(head) && one("From"));
      const who = incoming ? one("From") : one("To");
      const acc = (one("Acc").match(/\d{4}/) || [""])[0];
      return { ...base, type: incoming ? "Incoming transfer" : "Outgoing transfer", desc: who, counter: acc,
        amount: sar(one("Amount")), side: incoming ? "Dr" : "Cr" };
    },
  },
  {
    source: "urpay",
    // urpay wallet: one account, so acct = "urpay". Never copies the IBAN in "From:SA…" lines.
    test: t => /^(Top Up via Apple Pay|Outgoing international transfer|Debit Intl\.?\s*Transfer|Credit via wallet)/i.test(linesOf(t)[0] || ""),
    parse: t => {
      const L = linesOf(t), head = L[0];
      // exact label + colon: "To:" must not match "Total:"
      const all = key => L.filter(l => new RegExp(`^${key}\\s*:`, "i").test(l)).map(l => l.replace(new RegExp(`^${key}\\s*:\\s*`, "i"), "").trim());
      const one = key => all(key)[0] || "";
      const { date, time } = anyDate(t, "dmy");
      const base = { date, time, acct: "urpay", counter: "", fee: "", remaining: "", currency: "SAR", fxAmount: "" };
      const sar = s => toSar(money(s));
      if (/^Top Up/i.test(head)) {
        const card = (one("Card").match(/\d{4}/) || [""])[0];
        return { ...base, counter: card, type: "Top-up (Apple Pay)", desc: card ? `Top-up from card ${card}` : "Top-up",
          amount: sar(one("Amount")), side: "Dr" };
      }
      if (/^Credit via wallet/i.test(head)) {
        return { ...base, type: "Wallet credit", desc: `Credit from ${one("From") || "wallet"}`, amount: sar(one("Amount")), side: "Dr" };
      }
      // international transfers: new "Debit Intl.Transfer" (To:Name,1234) and old "Outgoing international transfer"
      const tos = all("To");
      const name = (tos.find(v => /[A-Za-z]/.test(v)) || "").replace(/,\s*\d+$/, "").trim();
      const digits = (tos.join(" ").match(/(\d{4})(?!\d)/g) || []).pop() || "";
      const provider = one("Service Provider") || one("Provider");
      const country = one("Country");
      const via = [/^MG$/i.test(provider) ? "MoneyGram" : provider, country].filter(Boolean).join(", ");
      return { ...base, counter: digits, type: "International transfer", desc: via ? `${name} (${via})` : name,
        amount: sar(one("Amount")), fee: sar(one("Fees") || one("Fee")), side: "Cr" };
    },
  },
  {
    source: "D360",
    // D360 Bank: English, "Key: Value" lines and an "On:" date line
    test: t => /^(Local POS Purchase|Account Funding via Apple Pay|Outgoing Local Transfer|International transfer|Reversal: International transfer)/i.test(linesOf(t)[0] || "")
               && /(^|\n)\s*On:\s*\d/i.test(t),
    parse: t => {
      const L = linesOf(t), head = L[0];
      const one = key => { const l = L.find(x => x.toLowerCase().startsWith(key.toLowerCase())); return l ? l.slice(key.length).replace(/^\s*:?\s*/, "").trim() : ""; };
      const { date, time } = anyDate(t);
      const base = { date, time, counter: "", fee: "", remaining: "", currency: "SAR", fxAmount: "" };
      const amtTxt = one("Amount");
      if (/^Account Funding/i.test(head)) {
        const card = masked4(one("Card"));
        return { ...base, acct: masked4(one("To")), counter: card, type: "Top-up (Apple Pay)",
          desc: card ? `Top-up from card ${card}` : "Top-up", amount: toSar(money(amtTxt)), side: "Dr" };
      }
      if (/^Outgoing Local Transfer/i.test(head)) {
        const iban = one("IBAN"), bank = iban.replace(/^[*\d\s]+-\s*/, "").trim();
        const name = one("To").replace(/\*+$/, "").trim();
        return { ...base, acct: masked4(one("From")), counter: masked4(iban), type: "Outgoing transfer (other bank)",
          desc: bank ? `${name} (${bank})` : name, amount: toSar(money(amtTxt)), side: "Cr" };
      }
      if (/International transfer/i.test(head)) {
        // "Amount: USD 100.00 (SAR 376.13)": the SAR in brackets is what left the account
        const inSar = amtTxt.match(/SAR\s*([\d,]+(?:\.\d+)?)/);
        const fx = money(amtTxt.replace(/\(.*\)/, ""));
        const toName = one("To"), country = one("Country"), through = one("Through");
        const acctLine = L.find(l => /^\d{8,}$/.test(l)) || "";
        const reversal = /^Reversal/i.test(head);
        const extra = [through, country].filter(Boolean).join(", ");
        return { ...base, acct: "D360", counter: acctLine.slice(-4),
          type: reversal ? "International transfer reversal" : "International transfer",
          desc: extra ? `${toName} (${extra})` : toName, amount: inSar ? num(inSar[1]) : toSar(fx),
          currency: fx.cur === "SAR" ? "SAR" : fx.cur, fxAmount: fx.cur === "SAR" ? "" : fx.amt, side: reversal ? "Dr" : "Cr" };
      }
      // card purchases
      const cardTxt = one("Card");          // "(Atheer)" etc. after the card is the payment network: ignored
      const merchant = one("At");
      return { ...base, acct: masked4(cardTxt), counter: ownWallet(merchant),
        type: /POS/i.test(head) ? "POS purchase" : "Online purchase",
        desc: merchant, amount: toSar(money(amtTxt)), side: "Cr" };
    },
  },
  // next banks get added here (see README.md, "Adding a bank")
];

// ---------- LedgerOS upload (pd_sms_inbox) ----------
// 53-bit hash of the row: the same transaction always gets the same id, so logging it twice
// (two automations firing, or a re-run) can never make two inbox rows.
function cyrb53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}
const numOrNull = v => (v === "" || v === null || v === undefined || isNaN(parseFloat(v))) ? null : parseFloat(v);
function inboxRow(core, source, r) {
  return {
    id: cyrb53(core), entry_date: r.date || null, entry_time: r.time || null, source, acct: r.acct || "",
    counter_acct: r.counter || null, kind: r.type || "", descr: r.desc || "", amt: numOrNull(r.amount), side: r.side === "Dr" ? "Dr" : "Cr",
    fee: numOrNull(r.fee), currency: r.currency || "SAR", fx_amount: numOrNull(r.fxAmount), remaining: r.remaining || null,
    logged_at: new Date().toISOString(),
  };
}
function haveKeys() { try { return Keychain.contains(KC_URL) && Keychain.contains(KC_KEY); } catch (e) { return false; } }
// Sends everything waiting in the queue. Returns "" when done or nothing to send, else a short reason.
// File trouble (e.g. iCloud unreadable while the phone is locked) never stops this row from being sent.
async function flushQueue(fm, extra) {
  const qPath = fm.joinPath(fm.documentsDirectory(), QUEUE_FILE);
  let queue = [], queueRead = true;
  try {
    if (fm.fileExists(qPath)) {
      await fm.downloadFileFromiCloud(qPath);
      try { queue = JSON.parse(fm.readString(qPath) || "[]"); } catch (e) { queue = []; }
    }
  } catch (e) { queue = []; queueRead = false; }
  if (extra && !queue.some(q => q.id === extra.id)) queue.push(extra);
  if (!queue.length) return "";
  const keep = why => {
    try { fm.writeString(qPath, JSON.stringify(queue)); return why; }
    catch (e) { return `${why}; could not save it on the phone for a retry (${errText(e)})`; }
  };
  if (!haveKeys()) return keep("not connected to LedgerOS yet");
  try {
    const url = Keychain.get(KC_URL).replace(/\/+$/, ""), key = Keychain.get(KC_KEY);
    const req = new Request(`${url}/rest/v1/pd_sms_inbox?on_conflict=id`);
    req.method = "POST";
    req.headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json",
      Prefer: "resolution=ignore-duplicates,return=minimal" };
    req.body = JSON.stringify(queue);
    await req.loadString();
    const code = (req.response || {}).statusCode;
    if (code >= 200 && code < 300) {
      if (queueRead) { try { if (fm.fileExists(qPath)) fm.remove(qPath); } catch (e) {} }
      return "";
    }
    return keep(`LedgerOS said ${code}, will retry`);
  } catch (e) {
    return keep("no connection, will retry");
  }
}
async function setupConnection() {
  const a = new Alert();
  a.title = "Connect to LedgerOS";
  a.message = "Paste the same Project URL and anon key you use on LedgerOS's Connect screen. They are kept in this phone's Keychain.";
  a.addTextField("https://xxxx.supabase.co", haveKeys() ? Keychain.get(KC_URL) : "");
  a.addTextField("anon key", "");
  a.addAction("Save");
  a.addCancelAction("Cancel");
  if (await a.present() === -1) return "Not changed";
  const url = a.textFieldValue(0).trim(), key = a.textFieldValue(1).trim();
  if (!/^https:\/\/.+/.test(url) || key.length < 20) return "Not saved: check the URL and key";
  Keychain.set(KC_URL, url); Keychain.set(KC_KEY, key);
  return "Connected to LedgerOS";
}

// ---------- run log, test mode, menu ----------
const errText = e => String((e && e.message) || e || "unknown error").slice(0, 160);
// One line per run (also skipped SMS), newest last, so you can see whether an SMS started the script.
// iCloud Drive / Scriptable / Ledger Run Log.txt
async function logRun(line) {
  try {
    const fm = FileManager.iCloud(), p = fm.joinPath(fm.documentsDirectory(), RUN_LOG);
    let old = "";
    if (fm.fileExists(p)) { await fm.downloadFileFromiCloud(p); old = fm.readString(p) || ""; }
    const lines = old.split("\n").filter(Boolean).slice(-(RUN_LOG_KEEP - 1));
    lines.push(line);
    fm.writeString(p, lines.join("\n") + "\n");
  } catch (e) { /* the log is a help, never a reason to fail */ }
}
async function readRunLog(n) {
  try {
    const fm = FileManager.iCloud(), p = fm.joinPath(fm.documentsDirectory(), RUN_LOG);
    if (!fm.fileExists(p)) return "";
    await fm.downloadFileFromiCloud(p);
    return (fm.readString(p) || "").split("\n").filter(Boolean).slice(-n).reverse().join("\n");
  } catch (e) { return `Could not read the log: ${errText(e)}`; }
}
// The row as it would be logged, for the test window
function describeRow(source, r) {
  const amt = r.amount ? `SAR ${r.amount}` : (r.fxAmount ? `${r.currency} ${r.fxAmount} (SAR blank)` : "(no amount)");
  return [
    `Bank: ${source}   Acct: ${r.acct || "—"}${r.counter ? `   Other acct: ${r.counter}` : ""}`,
    `Type: ${r.type || "—"}`,
    `Description: ${r.desc || "—"}`,
    `Amount: ${amt}   ${r.side === "Dr" ? "money in (Dr)" : "money out (Cr)"}`,
    r.fee ? `Fee: SAR ${r.fee}` : "",
    r.currency && r.currency !== "SAR" ? `Currency: ${r.currency} ${r.fxAmount}` : "",
    `Date: ${r.date || "—"} ${r.time || ""}`,
    r.remaining ? `Remaining: ${r.remaining}` : "",
  ].filter(Boolean).join("\n");
}
async function ask(title, message, actions) {
  const a = new Alert();
  a.title = title; a.message = message;
  actions.forEach(x => a.addAction(x));
  a.addCancelAction("Cancel");
  return await a.present();   // index of the action, -1 = Cancel
}
// Run inside Scriptable with nothing copied: the menu
async function appMenu() {
  const pick = await ask("Ledger SMS Logger",
    "To test a message: copy the bank SMS (long-press it → Copy), then run this script again.",
    ["Connect to LedgerOS", "Show run log"]);
  if (pick === 0) return await setupConnection();
  if (pick === 1) {
    const log = await readRunLog(25);
    await ask("Last runs (newest first)", log || "No runs logged yet.", []);
    return "Run log shown";
  }
  return "Closed";
}

// ---------- main ----------
let problem = "";   // set when something needs your attention (sent as a notification even if NOTIFY is off)
async function main() {
  let input = args.shortcutParameter;
  if (input && typeof input !== "string") input = input.content || input.text || String(input);
  const manual = !input;
  if (manual) input = Pasteboard.pasteString() || "";
  const testing = manual && config.runsInApp;   // run by hand in Scriptable: show the result before logging
  const text = normalise(input);

  if (testing && !text.trim()) return await appMenu();

  let p = null, r = null;
  for (const x of PARSERS) {
    if (!x.test(text)) continue;
    r = x.parse(text);
    if (r) { p = x; break; }
  }
  if (!r) {
    if (testing) {
      await ask("Test: not recognised",
        `This message would be SKIPPED (no transaction found).\n\nFirst line:\n${(linesOf(text)[0] || "").slice(0, 80)}\n\nIf it is a real transaction, send it to Claude so the parser can be fixed.`, []);
      return "Test: skipped";
    }
    const waiting = await flushQueue(FileManager.iCloud(), null);   // a quiet chance to retry
    return "Skipped: not a recognised transaction SMS" + (waiting ? ` (queue: ${waiting})` : "");
  }
  r = Object.assign({ counter: "", fee: "", currency: "SAR", fxAmount: "", remaining: "" }, r);
  const source = r.source || p.source;

  if (testing) {
    const pick = await ask("Test result", describeRow(source, r), ["Test only (don't log)", "Log it to LedgerOS"]);
    if (pick !== 1) return "Test only: " + (r.desc || r.type) + " " + (r.amount || r.fxAmount);
  }

  const fm = FileManager.iCloud();
  if (!r.amount && !r.fxAmount) {   // nothing usable: save the raw text so the parser can be fixed
    try {
      fm.writeString(fm.joinPath(fm.documentsDirectory(), "Ledger Debug.txt"), JSON.stringify(input) + "\n" +
        [...input].map(c => c.charCodeAt(0).toString(16)).join(" "));
    } catch (e) {}
  }

  const df = new DateFormatter();
  df.dateFormat = "yyyy-MM-dd HH:mm";
  const core = [r.date, r.time, source, r.acct, r.counter, r.type, r.desc, r.amount, r.side,
    r.fee, r.currency, r.fxAmount, r.remaining].join("\t");
  const line = core + "\t" + df.string(new Date());
  const shown = r.amount ? `SAR ${r.amount}` : `${r.currency} ${r.fxAmount}`;

  // the phone's own copy (Ledger Inbox.tsv); if iCloud can't be read (e.g. phone locked), skip it and still upload
  const path = fm.joinPath(fm.documentsDirectory(), FILE);
  let existing = "", fileOk = true;
  try {
    if (fm.fileExists(path)) { await fm.downloadFileFromiCloud(path); existing = fm.readString(path) || ""; }
  } catch (e) { fileOk = false; }
  if (fileOk && existing.includes(core)) {
    const waiting = await flushQueue(fm, null);
    return `Duplicate, not logged: ${r.desc} ${shown}` + (waiting ? ` (queue: ${waiting})` : "");
  }
  if (fileOk) {
    try {
      // a file from an older version (different columns) is kept aside, not mixed in
      if (existing && !existing.startsWith(HEADER)) {
        fm.writeString(fm.joinPath(fm.documentsDirectory(), "Ledger Inbox (old columns).tsv"), existing);
        existing = "";
      }
      const base = existing ? existing.replace(/\n*$/, "\n") : HEADER + "\n";
      fm.writeString(path, base + line + "\n");
    } catch (e) { fileOk = false; }
  }
  const upload = await flushQueue(fm, inboxRow(core, source, r));
  if (upload) problem = `LedgerOS: ${upload}`;

  const msg = `${source} · ${shown} · ${r.desc}` + (upload ? ` (LedgerOS: ${upload})` : "") + (fileOk ? "" : " (phone file not updated)");
  if (NOTIFY && !problem) {
    const n = new Notification();
    n.title = "Logged to Ledger Inbox";
    n.body = msg;
    await n.schedule();
  }
  return "Logged: " + msg;
}

let result;
try { result = await main(); }
catch (e) { problem = errText(e); result = "Failed: " + problem; }
if (problem && NOTIFY_FAILURES) {
  try { const n = new Notification(); n.title = "Ledger SMS Logger needs a look"; n.body = result; await n.schedule(); } catch (e) {}
}
{
  let stamp = "";
  try { const d = new DateFormatter(); d.dateFormat = "yyyy-MM-dd HH:mm:ss"; stamp = d.string(new Date()); } catch (e) {}
  let first = "";
  try { const s = args.shortcutParameter; first = linesOf(normalise(typeof s === "string" ? s : ((s && (s.content || s.text)) || ""))) [0] || ""; } catch (e) {}
  await logRun(`${stamp} | ${args.shortcutParameter ? "SMS" : "by hand"} | ${first.slice(0, 40)} | ${result}`);
}
if (config.runsInApp && !/^(Test|Run log|Closed|Not changed|Connected|Not saved)/.test(result)) {
  const a = new Alert(); a.message = result; a.addAction("OK"); await a.present();
}
Script.setShortcutOutput(result);
Script.complete();
