// Tests for ledger_sms_logger.js. Run: node test_parsers.js
// Runs the real script in a sandbox with fake Scriptable APIs (files, clipboard, notifications).
// Every sample below is INVENTED (card numbers, amounts, merchants): this repo is public.
// To add a case: copy a real SMS, change the numbers/names, add it to CASES with the row you expect.
const fs = require("fs");
const path = require("path");
const SRC = fs.readFileSync(path.join(__dirname, "ledger_sms_logger.js"), "utf8");

function runScript(sms, store) {
  const out = [];
  const ctx = {
    args: { shortcutParameter: sms },
    Pasteboard: { pasteString: () => "" },
    config: { runsInApp: false },
    DateFormatter: class { string() { return "2026-01-01 00:00"; } },
    Notification: class { async schedule() {} },
    Alert: class {},
    Script: { setShortcutOutput: o => out.push(o), complete() {} },
    FileManager: { iCloud: () => ({
      documentsDirectory: () => "/d", joinPath: (a, b) => a + "/" + b,
      fileExists: p => p in store, downloadFileFromiCloud: async () => {},
      readString: p => store[p], writeString: (p, c) => { store[p] = c; },
    }) },
  };
  const fn = new Function(...Object.keys(ctx), `return (async () => {${SRC}\n})()`);
  return fn(...Object.values(ctx)).then(() => out[0]);
}

const COLS = ["date", "time", "source", "acct", "type", "desc", "amount", "side", "remaining"];
const lastRow = store => {
  const lines = (store["/d/Ledger Inbox.tsv"] || "").trim().split("\n");
  const cells = lines[lines.length - 1].split("\t");
  return Object.fromEntries(COLS.map((c, i) => [c, cells[i]]));
};

// expect: fields to check in the logged row, or skip:true when the SMS must be ignored
const CASES = [
  { name: "SNB CC online purchase (Apple Pay)",
    sms: "شراء إنترنت (Apple Pay)\nمبلغ SAR 47.66\nبطاقة ائتمانية ***1234\nمن TEST MERCHANT\nالتاريخ 11/11/26 04:45\nالصرف المتبقي SAR 9000.50",
    expect: { date: "2026-11-11", time: "04:45", source: "SNB CC", acct: "1234", type: "Online purchase (Apple Pay)",
              desc: "TEST MERCHANT", amount: "47.66", side: "Cr", remaining: "9000.50" } },
  { name: "SNB CC cashback, number stored before SAR, Arabic digits",
    sms: "بطاقة ائتمانية استرجاع نقدي\nفي بطاقة **1234\nمبلغ ٠٫٣٣ SAR\nفي 10/11/26 22:16\nالصرف المتبقي 9000.83 SAR",
    expect: { date: "2026-11-10", acct: "1234", type: "Cashback/Refund", amount: "0.33", side: "Dr", remaining: "9000.83" } },
  { name: "SNB CC thousands separator + hidden direction mark",
    sms: "شراء إنترنت\nمبلغ ‏1,341.82 SAR\nبطاقة ائتمانية 1234***\nمن SHOP ONE\nالتاريخ 01/02/26 09:05\nالصرف المتبقي SAR 5,000.00",
    expect: { date: "2026-02-01", desc: "SHOP ONE", amount: "1341.82", remaining: "5000.00" } },
  { name: "SNB card cancellation notice is ignored",
    sms: "بطاقة ائتمانية رقم **1234\nحالة إلغاء نهائي\nفي 11/11/26 10:53", skip: true },
];

(async () => {
  let pass = 0, fail = 0;
  for (const c of CASES) {
    const store = {};
    const res = await runScript(c.sms, store);
    const problems = [];
    if (c.skip) {
      if (!/^Skipped/.test(res || "")) problems.push(`expected skip, got "${res}"`);
    } else {
      if (!/^Logged/.test(res || "")) problems.push(`not logged: "${res}"`);
      else {
        const row = lastRow(store);
        for (const [k, v] of Object.entries(c.expect))
          if (row[k] !== v) problems.push(`${k}: expected "${v}", got "${row[k]}"`);
        const again = await runScript(c.sms, store); // same SMS twice must not log twice
        if (!/^Duplicate/.test(again || "")) problems.push(`second copy not caught as duplicate: "${again}"`);
      }
    }
    if (problems.length) { fail++; console.log(`FAIL ${c.name}\n   ${problems.join("\n   ")}`); }
    else pass++;
  }
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
