// Ledger SMS Logger — Scriptable (iPhone)
// Reads a bank SMS, pulls out the transaction, appends one tab-separated row to
// iCloud Drive/Scriptable/Ledger Inbox.tsv.
// HOW IT WORKS, HOW TO ADD A BANK OR A MESSAGE TYPE: see README.md next to this file.
// Tests: node test_parsers.js

const FILE = "Ledger Inbox.tsv";
const NOTIFY = true;
const HEADER = ["Date", "Time", "Source", "Card/Acct", "Type", "Description",
  "Amount", "Card Dr/Cr", "Remaining", "Logged At"].join("\t");

// ---------- helpers ----------
const clean = s => s.replace(/[‎‏‪-‮⁦-⁩]/g, "");
const num = s => (s || "").replace(/,/g, "");
const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const normalise = s => clean(s)
  .replace(/[؜﻿]/g, "")                                   // more direction marks
  .replace(/[  -​ ]/g, " ")                     // odd spaces
  .replace(/[٠-٩]/g, d => ARABIC_DIGITS.indexOf(d))       // Arabic-Indic digits
  .replace(/٫/g, ".").replace(/٬/g, ",");                 // Arabic decimal/thousands
// first number on the first line containing `word` — works whether SAR comes before or after it
const amountOn = (t, word) => {
  const line = t.split("\n").find(l => l.includes(word));
  const m = line && line.match(/\d[\d,]*(?:\.\d+)?/);
  return m ? num(m[0]) : "";
};
const last4 = t => { const m = t.match(/\*+\s*(\d{4})|(\d{4})\s*\*+/); return m ? (m[1] || m[2]) : ""; };
const dmy = t => { // dd/mm/yy -> yyyy-mm-dd
  const m = t.match(/(\d{1,2})\/(\d{1,2})\/(\d{2})(?!\d)/);
  return m ? `20${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : "";
};
const hhmm = t => { const m = t.match(/(\d{1,2}:\d{2})/); return m ? m[1] : ""; };

// ---------- one parser per bank / message family ----------
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
        remaining: amountOn(t, "المتبقي"),
      };
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

  const p = PARSERS.find(x => x.test(text));
  if (!p) return "Skipped: not a recognised transaction SMS";
  const r = p.parse(text);

  const fm = FileManager.iCloud();
  if (!r.amount) {   // save the raw text so the parser can be fixed
    const dbg = fm.joinPath(fm.documentsDirectory(), "Ledger Debug.txt");
    fm.writeString(dbg, JSON.stringify(input) + "\n" +
      [...input].map(c => c.charCodeAt(0).toString(16)).join(" "));
  }

  const df = new DateFormatter();
  df.dateFormat = "yyyy-MM-dd HH:mm";
  const core = [r.date, r.time, p.source, r.acct, r.type, r.desc, r.amount, r.side, r.remaining].join("\t");
  const line = core + "\t" + df.string(new Date());

  const path = fm.joinPath(fm.documentsDirectory(), FILE);
  let existing = "";
  if (fm.fileExists(path)) {
    await fm.downloadFileFromiCloud(path);
    existing = fm.readString(path) || "";
  }
  if (existing.includes(core)) return `Duplicate, not logged: ${r.desc} SAR ${r.amount}`;

  const base = existing ? existing.replace(/\n*$/, "\n") : HEADER + "\n";
  const content = base + line + "\n";
  fm.writeString(path, content);

  const msg = `${p.source} · SAR ${r.amount} · ${r.desc}`;
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
