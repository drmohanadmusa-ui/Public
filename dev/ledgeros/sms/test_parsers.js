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
    expect: { date: "2026-11-10", acct: "1234", type: "Cashback", amount: "0.33", side: "Dr", remaining: "9000.83" } },
  { name: "SNB CC thousands separator + hidden direction mark",
    sms: "شراء إنترنت\nمبلغ ‏1,341.82 SAR\nبطاقة ائتمانية 1234***\nمن SHOP ONE\nالتاريخ 01/02/26 09:05\nالصرف المتبقي SAR 5,000.00",
    expect: { date: "2026-02-01", desc: "SHOP ONE", amount: "1341.82", remaining: "5000.00" } },
  { name: "SNB card cancellation notice is ignored",
    sms: "بطاقة ائتمانية رقم **1234\nحالة إلغاء نهائي\nفي 11/11/26 10:53", skip: true },

  // ---------- SNB credit card (invented card 2345) ----------
  { name: "SNB CC purchase in AED uses the bank's own rate and keeps the international fee",
    sms: "شراء إنترنت (Apple Pay)\nبمبلغ AED 52.00\nرسوم العمليات الدولية SAR 1.22\nسعر الصرف 1.02\nبطاقة ائتمانية ***2345\nمن TEST TAXI\nالتاريخ 12/10/26 13:50\nالصرف المتبقي SAR 9000.00",
    expect: { source: "SNB CC", acct: "2345", type: "Online purchase (Apple Pay)", desc: "TEST TAXI (AED 52.00)", amount: "53.04",
              fee: "1.22", currency: "AED", fxAmount: "52.00", side: "Cr", remaining: "9000.00", date: "2026-10-12", time: "13:50" } },
  { name: "SNB CC purchase in USD at 3.76",
    sms: "شراء إنترنت\nبمبلغ USD 0.50\nرسوم العمليات الدولية SAR 0.04\nسعر الصرف 3.76\nبطاقة ائتمانية ***2345\nمن TEST LOUNGE\nالتاريخ 14/10/26 14:24\nالصرف المتبقي SAR 9000.00",
    expect: { amount: "1.88", currency: "USD", fxAmount: "0.50", fee: "0.04" } },
  { name: "SNB CC POS purchase ('بSAR' amount line, tatweel)",
    sms: "شراء-POS\nبـSAR 274.00\nمن TEST FOOD\nإئتمانية **2345 (Apple Pay)\nفي 09/10/26 17:17\nالصرف المتبقي SAR 9000.00",
    expect: { source: "SNB CC", acct: "2345", type: "POS purchase (Apple Pay)", desc: "TEST FOOD", amount: "274.00", side: "Cr" } },
  { name: "SNB CC reversal ('حوالة عكسية') is money back, with 'الرصيد المتبقي'",
    sms: "حوالة عكسية\nبطاقة ائتمانية **2345\nمبلغ AED 52.00\nلدى TEST TAXI\nفي 12/10/26 13:50\nالرصيد المتبقي SAR 9053.04",
    expect: { type: "Reversal/refund", desc: "TEST TAXI (AED 52.00)", side: "Dr", currency: "AED", remaining: "9053.04" } },
  { name: "SNB CC refund ('إسترداد مبلغ'), in-line order reversed",
    sms: "إسترداد مبلغ\nSAR 211.35 مبلغ\nمن بطاقة إئتمانية **2345\nتاريخ 13/10/26 03:48\nحد الصرف المتبقي SAR 9264.39",
    expect: { type: "Refund", amount: "211.35", side: "Dr", acct: "2345", remaining: "9264.39" } },
  { name: "SNB CC annual fee",
    sms: "تم خصم الرسوم السنوية لبطاقتك الإئتمانية **2345 بمبلغ 230.00. للمزيد من المعلومات الرجاء زيارة الأهلي موبايل",
    expect: { source: "SNB CC", acct: "2345", type: "Annual card fee", amount: "230.00", side: "Cr" } },
  // ---------- SNB debit (invented account 4321, mada card 3456) ----------
  { name: "SNB credit card payment from the account (own transfer to the card)",
    sms: "سداد بطاقة ائتمانية\nمن حساب *4321\nالى بطاقة **2345\nمبلغ SAR 2424.38\nفي 07/11/26 17:13\nالصرف المتبقي SAR 15000.00",
    expect: { source: "SNB", acct: "SNB debit", counter: "2345", type: "Credit card payment", amount: "2424.38", side: "Cr" } },
  { name: "SNB salary deposit",
    sms: "ايداع رواتب\nمبلغ SAR 3000.71\nحساب4321*\nفي 25/10/26 09:37",
    expect: { source: "SNB", acct: "SNB debit", type: "Salary", desc: "Salary deposit", amount: "3000.71", side: "Dr", date: "2026-10-25" } },
  { name: "SNB incoming transfer from another bank (bank name translated)",
    sms: "حوالة واردة محلية\nمبلغ SAR 5700\nمرسل من TEST EMPLOYER CO\nمن *9301\nإلى 4321*\nعبر البنك السعودي البريطاني ساب\nفي 21/10/26 09:22",
    expect: { type: "Incoming transfer (other bank)", desc: "TEST EMPLOYER CO (via SAB)", counter: "9301", amount: "5700", side: "Dr" } },
  { name: "SNB incoming internal transfer: amount on the heading, Arabic name kept whole",
    sms: "حوالة واردة داخلية بـSAR 104.20\nمن9302* عبدالمنعم تجريبي\n23/10/26 19:04",
    expect: { type: "Incoming transfer", desc: "عبدالمنعم تجريبي", counter: "9302", amount: "104.20", side: "Dr", date: "2026-10-23", time: "19:04" } },
  { name: "SNB outgoing internal transfer",
    sms: "حوالة صادرة داخلية بـSAR 54.20\nلـ9302* عبدالمنعم تجريبي\n23/10/26 23:05",
    expect: { type: "Outgoing transfer", desc: "عبدالمنعم تجريبي", counter: "9302", amount: "54.20", side: "Cr" } },
  { name: "SNB outgoing transfer to another bank (your own account there)",
    sms: "حوالة صادرة محلية بـSAR 19000.50\nلـ*TEST PERSON K. 5555*\n01/11/26 22:48",
    expect: { type: "Outgoing transfer (other bank)", desc: "TEST PERSON K.", counter: "5555", amount: "19000.50" } },
  { name: "SNB international transfer: fee kept, yy/mm/dd date read correctly",
    sms: "حوالة صادرة دولية\nدولة الولايات المتحدة الامريكية\nمرسل TEST SENDER\nمن 326*100\nمستفيد TEST BROKER Inc\nإلى *9303\nمبلغ SAR 779.76\nرسوم 25.00\nبنك TEST BANK N.A.\nفي 26/10/23 14:03\nاستحقاق 26/10/23",
    expect: { type: "International transfer", desc: "TEST BROKER Inc (TEST BANK N.A., USA)", counter: "9303", amount: "779.76",
              fee: "25.00", side: "Cr", date: "2026-10-23", time: "14:03" } },
  { name: "SNB finance instalment, loan type translated, remaining kept",
    sms: "خصم قسط تمويل\nمن 326*100\nالقسط SAR 4135\nالمبلغ المتبقي SAR 50000.92\nلـ تمويل شخصي\nفي 25/10/26 11:22",
    expect: { type: "Finance instalment", desc: "Personal finance instalment", amount: "4135", remaining: "50000.92", side: "Cr" } },
  { name: "SNB mada purchase at your D360 wallet becomes a transfer to it",
    sms: "شراء انترنت\nبـSAR 4000\nمن 4321*\nمن MYSR D360\nمدى-ابل *3456\nفي 31/10/26 18:57",
    expect: { source: "SNB", acct: "SNB debit", counter: "D360", type: "Online purchase (Apple Pay)", desc: "MYSR D360", amount: "4000", side: "Cr" } },
  { name: "SNB international online mada purchase",
    sms: "شراء عبر الانترنت - دولي\nبطاقة مدى *3456\nحساب 4321*\nبمبلغ SAR 14.32\nمن TEST GAMES\nفي الولايات المتحدة الامريكية\nفي 04/11/26 23:32",
    expect: { type: "International online purchase", desc: "TEST GAMES", amount: "14.32", counter: "" } },
  { name: "SNB failed transfer ('غير ناجحة') is ignored",
    sms: "حوالة فورية محلية صادرة غير ناجحة\nمن حساب: 4321*\nالقيمة: SAR 20000.49\nإلى TEST PERSON\nفي 01/11/26 22:24", skip: true },
  { name: "SNB failed transfer worded like a normal one ('حوالة صادرة محلية غير ناجحة') is ignored",
    sms: "حوالة صادرة محلية غير ناجحة بـSAR 100\nلـ*TEST PERSON 5555*\n01/11/26 22:24", skip: true },
  { name: "SNB one-time password for a card purchase is ignored (it has an amount and merchant)",
    sms: "الرقم السري لمره واحده لعملية الشراء عبر الإنترنت 1234\nمبلغ SAR 1500.0\nلدى TEST PAY\nلبطاقة *2345\nتاريخ 29/10/2026 09:42", skip: true },
  { name: "SNB activation code with an amount is ignored",
    sms: "لا تشارك رمز التفعيل 1234\nتحويل لبنك محلي\nمبلغ SAR 19000", skip: true },
  { name: "SNB card status notice is ignored",
    sms: "بطاقة ائتمانية رقم **2345\nحالة إيقاف مؤقت\nفي 03/11/26 13:08", skip: true },

  // ---------- STC Bank (invented) ----------
  { name: "STC top-up with a 12-hour US-style date (month first)",
    sms: "Adding money to account\nAmount: 602.59 SAR\nVia: *XXXX\nAt: 3/10/2026 10:11\u202fPM",
    expect: { source: "STC", acct: "STC", type: "Top-up", amount: "602.59", side: "Dr", date: "2026-03-10", time: "22:11" } },
  { name: "STC outgoing transfer ('660.00SAR' with no space)",
    sms: "Internal outward transfer\nAmount:660.00SAR\nTo:TEST PAYEE\nAcc:9401*\nAt:10/03/26 22:12",
    expect: { type: "Outgoing transfer", desc: "TEST PAYEE", counter: "9401", amount: "660.00", side: "Cr", date: "2026-03-10" } },
  { name: "STC Western Union transfer keeps the fee",
    sms: "Transfer via WU\nAmount:3,971.25 SAR\nFees:28.75 SAR\nMTCN:0000000000\nReceiver:TEST RECEIVER\nAccount:*136\nCountry:Canada\nAt:27/07/26 15:53",
    expect: { type: "International transfer (Western Union)", desc: "TEST RECEIVER (WU, Canada)", amount: "3971.25", fee: "28.75", side: "Cr" } },
  { name: "STC card purchase (merchant translated, no time in the SMS)",
    sms: "Online Purchase Transaction Amount 111.34\nFrom: شركة منصة سلة للاتصالات وتقنية المعلومات\n Card: *******0000\nDate 30/07/2026",
    expect: { type: "Online purchase", desc: "Salla", amount: "111.34", side: "Cr", date: "2026-07-30", time: "" } },
  { name: "STC incoming transfer written '50SR'",
    sms: "Internal incoming transfer\nAmount:50SR\nFrom:TEST SENDER\nAcc:292\nAt:07/09/26 17:12",
    expect: { type: "Incoming transfer", desc: "TEST SENDER", amount: "50", side: "Dr" } },
  { name: "Old STC Pay format: 'Internal transfer' From = money in",
    sms: "Internal transfer\nAmount:67.00SAR\nFrom:TEST SENDER\nAt:30/01/25 22:24",
    expect: { type: "Incoming transfer", amount: "67.00", side: "Dr", date: "2025-01-30" } },
  { name: "Old STC Pay wallet top-up ('With:')",
    sms: "STC pay wallet top up\nWith: 2,435.00 SAR\nCard: XXXX*, Apple Pay\nAt: 26/02/25 - 22:05",
    expect: { type: "Top-up", amount: "2435.00", side: "Dr", date: "2025-02-26", time: "22:05" } },
  { name: "STC online-payment OTP is ignored (it has an amount)",
    sms: "Please use one time password 1234 for online payment\nTransaction Amount 111.34 SAR\nFor TEST SHOP\nDate 30/07/2026 and Time 13:19", skip: true },

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
    expect: { acct: "5555", counter: "", desc: "Drahim portfolio top-up (Saving Portfolio1)", amount: "1000.50" } },
  { name: "Al Rajhi OTP is ignored",
    sms: "OTP Code:1234\nReason:Rajhi Transfer - Mobile App\nAmount:4,000.00 SAR", skip: true },
  { name: "Al Rajhi declined transaction is ignored",
    sms: "Transaction Declined: Insufficient funds.\nTransaction: Online Purchase\nCard: 7777\nAmount: AED 105.1\nAt: TEST TAXI\nDate: 12/10/26 17:08", skip: true },
  { name: "Al Rajhi personal message notice is ignored",
    sms: "You received a message from TEST PERSON : hello", skip: true },
  // ---------- meem (invented: account 8888, mada card 9999) ----------
  { name: "meem 'Online Purchase' is read as meem, not Al Rajhi (same heading)",
    sms: "Online Purchase\nAmount: SAR 7,000.00\nAt: TEST MERCHANT,\nmada Card: ***9999\nTransactions Type :Apple Pay\nAccount Number: ***8888\nDate: 10/11/26 09:50",
    expect: { source: "meem", date: "2026-11-10", time: "09:50", acct: "8888", type: "Online purchase (Apple Pay)",
              desc: "TEST MERCHANT", amount: "7000.00", side: "Cr", counter: "" } },
  { name: "meem purchase at your D360 wallet becomes a transfer to it",
    sms: "Online Purchase\nAmount: SAR 4,250.00\nAt: MYSR D360,\nmada Card: ***9999\nTransactions Type :Apple Pay\nAccount Number: ***8888\nDate: 11/11/26 00:28",
    expect: { source: "meem", acct: "8888", counter: "D360", amount: "4250.00" } },
  { name: "meem incoming local transfer: Ejar translated, zero fee left blank, 4-digit year",
    sms: "Local Credit transfer \nAmount: SAR 11,250.00 \nFees: SAR 0.00 \nSender Name: منصة ايجار \nFrom: ***9201 \nVia: TEST BANK \nTo: ***8888 \nDate: 23/02/2026 10:09",
    expect: { source: "meem", date: "2026-02-23", acct: "8888", counter: "9201", type: "Incoming transfer (other bank)",
              desc: "Ejar platform (via TEST BANK)", amount: "11250.00", side: "Dr", fee: "" } },
  { name: "meem outgoing transfer: ISO date + separate time, fee kept",
    sms: "Fund Transfer Approved\nAmount: SAR 11248.85\nFee: 1.15\nBeneficiary Name: TEST PAYEE****\nBeneficiary account number: *****9202\nName of beneficiary participant: TEST BANK\nDate: 2026-05-10\nSender account number: *****8888\nTime: 09:53:00\nTransaction ID: 0000",
    expect: { source: "meem", date: "2026-05-10", time: "09:53", acct: "8888", counter: "9202", type: "Outgoing transfer (other bank)",
              desc: "TEST PAYEE (TEST BANK)", amount: "11248.85", fee: "1.15", side: "Cr" } },
  { name: "meem savings profit written as 'SAR .16'",
    sms: "Credit Transaction: Savings Account Profit    \nTo: ***8888  \nAmount: SAR .16  \nDate: 02/06/2026 23:39",
    expect: { source: "meem", acct: "8888", type: "Savings Account Profit", amount: "0.16", side: "Dr" } },
  { name: "An 'Online Purchase' without meem's labels (another bank) is not logged as meem",
    sms: "Online Purchase\nAmount: SAR 50.00\nCard: *1234 - mada\nAt: TEST SHOP\nOn: 2026-11-06 14:22", skip: true },
  { name: "meem OTP is ignored", sms: "One Time Password: 1234 \nReason: Sarie Transfer \nAmount: 100.00 SAR \nDate: 23/02/2026 10:57", skip: true },
  { name: "meem card activation (shows a full account number) is ignored",
    sms: "Card: mada\nNumber: ******9999\nFor Account: 00000000000\nStatus: Activated\nDate: 01/03/2026 22:28", skip: true },
  { name: "meem Apple Pay notice is ignored",
    sms: "Notification: Apple Pay addition / activation\nCard Number: 9999\nDate: 12/08/2026 09:27\nStatus: Successful", skip: true },
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
