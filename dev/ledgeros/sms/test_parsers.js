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
    __NOW__: "2026-11-11T12:00:00",          // pinned "today" (SAIB dates have no year)
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

const COLS = ["date", "time", "source", "acct", "counter", "type", "desc", "amount", "side", "fee",
  "currency", "fxAmount", "remaining"];
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

  // ---------- SAIB (invented: main account 1111, second account 2222, mada card 4444) ----------
  { name: "SAIB travel card online purchase, CAD (no fixed rate: SAR left blank)",
    sms: "شراء انترنت\n\nبطاقة:XXX3333 سفر(Apple Pay) \n\nمن: CAD\n\nمبلغ: CAD 90.06\n\nلدى: TEST EATS \n\nرصيد: CAD 9.94\n\nفي: 08-29 01:09",
    expect: { date: "2026-08-29", time: "01:09", source: "SAIB", acct: "Travel", type: "Online purchase (Apple Pay)",
              desc: "TEST EATS (CAD 90.06)", amount: "", side: "Cr", currency: "CAD", fxAmount: "90.06", remaining: "CAD 9.94" } },
  { name: "SAIB travel card purchase in USD converts at 3.75",
    sms: "شراء انترنت\nبطاقة:XXX3333 سفر \nمن: USD\nمبلغ: USD 23\nلدى: TEST SUBSCRIPTION \nرصيد: USD 2\nفي: 11-08 18:40",
    expect: { acct: "Travel", amount: "86.25", currency: "USD", fxAmount: "23", desc: "TEST SUBSCRIPTION (USD 23)" } },
  { name: "SAIB travel card international POS (amount written after the currency)",
    sms: "شراء عبر نقاط البيع دولي\nبطاقة: سفر(Apple Pay) XXX3333 \nلدى: TEST CAFE \nدولة: ماليزيا \nمن: MYR\nمبلغ: 40 MYR \nرصيد: 52.35 MYR \nفي: 07-17 15:34",
    expect: { acct: "Travel", type: "International POS purchase (Apple Pay)", currency: "MYR", fxAmount: "40", remaining: "MYR 52.35" } },
  { name: "SAIB travel card top-up in SAR (own transfer: account -> Travel)",
    sms: "اضافة مبلغ لبطاقة السفر\n\nمن:XXX1111 \n\nمبلغ:SAR 133.37\n\nفي:07-21 13:00",
    expect: { acct: "1111", counter: "Travel", type: "Travel card top-up", amount: "133.37", side: "Cr", currency: "SAR" } },
  { name: "SAIB travel card refund to second account (foreign)",
    sms: "اعادة مبلغ من بطاقة السفر\nمبلغ:CAD 50\nالى:XXX2222 \nفي:07-26 11:44",
    expect: { acct: "Travel", counter: "2222", amount: "", currency: "CAD", fxAmount: "50" } },
  { name: "SAIB transfer between own accounts",
    sms: "حوالة صادرة: بين حساباتك\nمن: XXX2222 \nمبلغ: SAR 185.15\nالى: XXX1111 \nفي: 07-20 10:30",
    expect: { acct: "2222", counter: "1111", type: "Transfer between own accounts", amount: "185.15", side: "Cr" } },
  { name: "SAIB incoming transfer (money in = Dr, thousands comma)",
    sms: "حوالة واردة: داخلية\nمبلغ: SAR 1,475\nالى: XXX1111 \nمن: TEST SENDER XXX9001 \nفي: 07-27 07:58",
    expect: { acct: "1111", type: "Incoming transfer", desc: "TEST SENDER", amount: "1475", side: "Dr", counter: "9001" } },
  { name: "SAIB outgoing internal transfer, Arabic name after the account",
    sms: "حوالة صادرة: داخلية\nمن: XXX1111 \nالى: XXX9002 شخص تجريبي \nمبلغ: SAR 53\nفي: 08-12 18:16",
    expect: { acct: "1111", type: "Outgoing transfer", desc: "شخص تجريبي", amount: "53", side: "Cr" } },
  { name: "SAIB local transfer to another bank keeps the fee",
    sms: "حوالة محلية\nالمصرفRIBL \nالمبلغSAR 35\nمنX1111 \nالى:TEST PAYEE \nالىX9940 \nالرسوم SAR 0.58\nفي10-18 18:14",
    expect: { acct: "1111", type: "Local transfer (other bank)", desc: "TEST PAYEE (RIBL)", amount: "35", fee: "0.58", date: "2026-10-18" } },
  { name: "SAIB mada online purchase (account named in the SMS)",
    sms: "شراء انترنت\nبSAR 1,700\nلدىTESTSHOP \nمدى ابل X4444 \nمن1111 \nب08-03 11:00",
    expect: { acct: "1111", type: "Online purchase (Apple Pay)", desc: "TESTSHOP", amount: "1700", time: "11:00" } },
  { name: "SAIB mada POS purchase (only the card is named)",
    sms: "شراء POS\nبSAR 40.25\nمنTEST STORE \nمدى ابل X4444 \nب08-08 15:10",
    expect: { acct: "4444", type: "POS purchase (Apple Pay)", desc: "TEST STORE", amount: "40.25" } },
  { name: "SAIB SADAD bill, biller translated",
    sms: "سداد فاتورة لمرة واحدة\nمن: XXX1111 \nمفوتر: 002 السعودية للطاقة \nخدمة:خدمات اخرى \nالمبلغ: SAR 299.92\nرقم الفاتورة: 12345678901 \nفي: 08-29 14:22",
    expect: { acct: "1111", type: "Bill payment (SADAD)", desc: "Saudi Electricity", amount: "299.92" } },
  { name: "SAIB MOI payment, agency and service translated",
    sms: "مدفوعات وزارة الداخلية\nمن: XXX1111 \nمبلغ: SAR 300\nالجهة: الجوازات السعودية \nالخدمة: تجديد جواز سفر \nرقم الفاتورة: 1234567890 \nفي: 09-25 17:26",
    expect: { type: "MOI payment", desc: "MOI · Passports (Jawazat) · Passport renewal", amount: "300" } },
  { name: "SAIB date with no year: a December SMS read on 11 Nov belongs to last year",
    sms: "حوالة واردة: داخلية\nمبلغ: SAR 10\nالى: XXX1111 \nمن: TEST SENDER XXX9001 \nفي: 12-30 09:00",
    expect: { date: "2025-12-30" } },
  { name: "SAIB OTP for a transfer is ignored (it mentions an amount and a transfer)",
    sms: "كلمة مرور لمرة واحدة\nرمز: 1234\nل: حوالة صادرة - داخلية\nمبلغ: SAR 600.00\nفي: 15:59:50 07-08-2026\nلا تشارك الرمز", skip: true },
  { name: "SAIB declined payment (insufficient balance) is ignored",
    sms: "اشعار: رصيد غير كافي\nالعملية: انترنت \nمبلغ: USD 23\nبطاقة: سفر ;XXX3333 \nلدى: TEST SUBSCRIPTION \nفي: 09-08 18:38", skip: true },
  // ---------- Al Rajhi (invented: account 5555, mada card 6666, Visa card 7777) ----------
  { name: "Al Rajhi incoming internal transfer (date yy/m/d)",
    sms: "Credit Transfer Internal\n\nAmount:SR 165\n\nTo:5555\n\nFrom:TEST SENDER\n\nFrom:9101\n\n26/10/1 11:36",
    expect: { date: "2026-10-01", time: "11:36", source: "Al Rajhi", acct: "5555", counter: "9101", type: "Incoming transfer",
              desc: "TEST SENDER", amount: "165", side: "Dr" } },
  { name: "Al Rajhi incoming transfer from another bank keeps the bank name",
    sms: "Credit Transfer Local\nVia:TESTBANK\nAmount:SR 4000\nTo:5555\nFrom:TEST PERSON\nFrom:9102\n26/10/31 18:59",
    expect: { acct: "5555", counter: "9102", type: "Incoming transfer (other bank)", desc: "TEST PERSON (via TESTBANK)", amount: "4000" } },
  { name: "Al Rajhi outgoing internal transfer",
    sms: "Debit Internal Transfer\nFrom:5555\nAmount:SR 221\nTo:TEST PAYEE\nTo:9103\n26/10/1 17:22",
    expect: { acct: "5555", counter: "9103", type: "Outgoing transfer", desc: "TEST PAYEE", amount: "221", side: "Cr" } },
  { name: "Al Rajhi Visa card top-up in CAD (date d/m/yy)",
    sms: "Credit Card:Payment\nCard:Visa 7777\nAmount:CAD 2318\nBalance:2318 CAD\n3/10/26 22:12",
    expect: { date: "2026-10-03", acct: "7777", type: "Card top-up", side: "Dr", amount: "", currency: "CAD", fxAmount: "2318", remaining: "CAD 2318" } },
  { name: "Al Rajhi Visa card purchase abroad",
    sms: "Online Purchase\nCard:7777 ;Visa-Apple Pay\nAmount:54.7 AED\nAt: TEST TAXI\nCountry:UAE\nBalance:433.8 AED\n12/10/26 13:03",
    expect: { acct: "7777", type: "Online purchase (Apple Pay)", desc: "TEST TAXI (AED 54.7)", side: "Cr", currency: "AED", remaining: "AED 433.8" } },
  { name: "Al Rajhi international POS purchase",
    sms: "PoS International purchase\nCard:7777 ;Visa\nAmount:1744.1 CAD\nAt: TEST AIRLINE\nCountry:Canada\nBalance:4.08 CAD\n3/10/26 22:33",
    expect: { type: "International POS purchase", desc: "TEST AIRLINE (CAD 1744.1)", fxAmount: "1744.1" } },
  { name: "Al Rajhi reversal is money back (Dr)",
    sms: "Reverse Transaction\nBy:7777;Visa-Apple Pay\nAt:TEST TAXI\nAmount:AED 52\nBalance:AED 488.5\n12/10/26 13:03",
    expect: { acct: "7777", type: "Reversal/refund (Apple Pay)", desc: "TEST TAXI (reversal) (AED 52)", side: "Dr" } },
  { name: "Al Rajhi ATM withdrawal on the mada card",
    sms: "Withdrawal:ATM\nBy:6666;mada\nAmount:SR 2053.30\nPlace:\n12/10/26 14:36",
    expect: { acct: "6666", type: "ATM withdrawal", desc: "ATM withdrawal", amount: "2053.30", side: "Cr" } },
  { name: "Al Rajhi card balance back to the account (own transfer)",
    sms: "Credit Card:transfer\nFrom card:7777;Visa\nTo Account:5555\nAmount:SR 124.76\n26/10/19 21:12",
    expect: { date: "2026-10-19", acct: "7777", counter: "5555", type: "Card balance to account", amount: "124.76", side: "Cr" } },
  { name: "Al Rajhi mada purchase at a wallet you own becomes a transfer to it",
    sms: "Online Purchase\nBy:6666;mada-Apple Pay\nFrom:5555\nAmount:SR 14300\nAt:URPAY\n21/10/26 10:55",
    expect: { date: "2026-10-21", acct: "5555", counter: "urpay", desc: "URPAY", amount: "14300" } },
  { name: "Al Rajhi card purchase in riyals ('91.16 SR')",
    sms: "Online Purchase\nBy:7777 ;Visa\nAmount:91.16 SR\nAt:TEST SHOP\nBalance:0 SR\n26/10/26 20:28",
    expect: { date: "2026-10-26", acct: "7777", amount: "91.16", currency: "SAR", remaining: "0" } },
  { name: "Al Rajhi Drahim portfolio top-up",
    sms: "Drahim portfolio top up\nFrom:5555\nAmount:SR 1000.50\nTo:Saving Portfolio1\n26/10/27 20:37",
    expect: { acct: "5555", counter: "Drahim", desc: "Drahim portfolio top-up (Saving Portfolio1)", amount: "1000.50" } },
  { name: "Al Rajhi OTP is ignored",
    sms: "OTP Code:1234\nReason:Rajhi Transfer - Mobile App\nAmount:4,000.00 SAR", skip: true },
  { name: "Al Rajhi declined transaction is ignored",
    sms: "Transaction Declined: Insufficient funds.\nTransaction: Online Purchase\nCard: 7777\nAmount: AED 105.1\nAt: TEST TAXI\nDate: 12/10/26 17:08", skip: true },
  { name: "Al Rajhi personal message notice is ignored",
    sms: "You received a message from TEST PERSON : hello", skip: true },
  { name: "Another bank's English 'Online Purchase' (meem style) is NOT read as Al Rajhi",
    sms: "Online Purchase\nAmount: SAR 7,000.00\nAt: TEST MERCHANT,\nmada Card: ***1234\nTransactions Type :Apple Pay\nAccount Number: ***5678\nDate: 10/11/26 09:50", skip: true },
  { name: "SAIB beneficiary-added notice (contains an IBAN) is ignored",
    sms: "اسم المستفيد: TEST PAYEE\nحالة: اضافة\nحساب: SA0000000000000000000000\nمصرف: بنك تجريبي \nفي: 18:13:00 18-10-2026", skip: true },
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
