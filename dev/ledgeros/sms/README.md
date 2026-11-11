# Bank SMS logger: how it works and how to update it

An iPhone automation that reads incoming bank SMS and logs each transaction, so it can be posted in LedgerOS without retyping.
Planned next step: each row also goes to LedgerOS's SMS inbox (feedback item #18 in `../FEEDBACK.md`).

**Files in this folder**

| File | What it is |
|---|---|
| `ledger_sms_logger.js` | The script. It runs in the **Scriptable** app on the iPhone. |
| `test_parsers.js` | Tests. Run `node test_parsers.js`; it should end with `N passed, 0 failed`. |
| `README.md` | This guide. |

**Updating with Claude later:** open a LedgerOS session, say "update the SMS logger", and paste the new SMS as text. Claude reads this README, adds the parser and a test, and gives you the new script.

---

## 1. How a message flows

```
Bank SMS arrives
  → Shortcuts automation fires (trigger: a phrase only that bank's messages contain)
  → "Get Text from Input" (Shortcut Input) → "Run Script" (Scriptable: Ledger SMS Logger, Run In App off)
  → script cleans the text, finds the matching parser, pulls out the fields
  → appends one row to  iCloud Drive / Scriptable / Ledger Inbox.tsv   (skips exact duplicates)
  → notification "Logged to Ledger Inbox"
```

Running the script by hand inside Scriptable uses whatever SMS is on the clipboard. That's how to test it, or to log an old message.

## 2. iPhone setup (one time)

1. Install **Scriptable** (free) and open it once.
2. Save `ledger_sms_logger.js` as **Ledger SMS Logger.js** in **iCloud Drive → Scriptable**. Replace the old file whenever the script changes.
3. In Shortcuts, go to Automation → **+** → **Message**:
   - **Message Contains:** the trigger (section 3). Usually the **last 4 digits of the account or card**.
   - **Remove the Sender row.** Bank sender names such as "SNB-AlAhli" can't be saved as contacts, and one condition is enough.
   - Choose **Run Immediately**, then **New Blank Automation**.
   - Add **Get Text from Input** and set it to **Shortcut Input**. Don't leave it on the faded "Input" placeholder.
   - Add **Run Script** (Scriptable): Script = Ledger SMS Logger, Parameter = Text, **Run In App off**.
4. **One automation per trigger.** Every automation runs the same script. Shortcuts allows only one phrase per automation.

## 3. Banks and triggers

**Trigger rule (agreed 2026-11-11):** one automation per account or card, and its *Message Contains* is that account's or card's **last 4 digits**, as printed in the SMS. This works for every bank, because bank SMS name the account. A phrase is used only where a bank doesn't print the account (SNB credit card). The real last-4 numbers live only in the phone's automations, never in this public repo.

| Source (column 3) | Bank / account | Trigger(s) | Status |
|---|---|---|---|
| `SNB CC` | SNB credit card | phrase `الصرف المتبقي` | done |
| `SAIB` | SAIB main account, SAIB-2 account, mada card, travel card | last 4 of each (4 automations) | done |
| `Al Rajhi` | Al Rajhi account, mada card, Visa card | last 4 of each (3 automations) | done |
| `meem` | meem account, mada card | last 4 of each (2 automations) | done |
| | SNB debit account | | waiting for samples |
| | D360 | | waiting for samples |
| | urpay | | waiting for samples |
| | STC Pay | | waiting for samples |

The script ignores anything it doesn't recognise, so a trigger that's slightly too broad is harmless. For example, an OTP that happens to contain the digits is just skipped.

**SAIB notes**
- **Message types logged:**
  - mada purchases (online, and in store via POS)
  - incoming, outgoing and local (other bank, with fee) transfers
  - transfers between your own accounts
  - SADAD bills and MOI payments
  - travel card purchases (online and international POS), top-ups and refunds
- **Message types ignored:** OTPs and verification codes, declined "insufficient balance" notices, login and Face ID alerts, beneficiary-added notices (these contain a full IBAN), and promos or maintenance notices.
- **SAIB dates have no year** (`07-17 15:03`, month first). The script uses the latest such date that isn't after today, so a December SMS read in January lands in the right year.
- **Travel card:** every travel card row has Acct = `Travel`, which LedgerOS maps to the **Travel Holding** account:
  - top-ups: account → Travel
  - refunds: Travel → SAIB-2
  - purchases come out of Travel
- **Foreign currencies:** the SMS gives only the foreign amount. USD is converted at 3.75 (`FX_TO_SAR`). Any other currency gets a blank SAR amount for you to type in New JV, with the original amount kept in Currency / FX Amount and in the description.
- **Arabic names** (billers, MOI agencies) are translated through the `TRANSLATE` list in the script. Add new ones there; anything not listed stays as written.

**Al Rajhi notes**
- **Message types logged:**
  - incoming transfers: internal, and local from another bank (with the bank name)
  - outgoing internal transfers
  - mada purchases and ATM withdrawals
  - Visa card: top-ups ("Credit Card:Payment"), purchases (online and international POS), reversals, and card balance sent back to the account ("Credit Card:transfer")
  - Drahim portfolio top-ups (bank side only; Counter Acct is left empty on purpose, and Muhannad adds the Drahim side himself)
- **Message types ignored:** OTP codes, declined transactions, "You received a message from …" (personal messages are never logged).
- **Two date styles in the same bank:** transfers use `26/10/1 11:36` (yy/m/d) and card messages use `3/10/26 22:12` (d/m/yy). `ymdOrDmy` tries both readings and keeps the valid one closest to today that isn't in the future.
- **Riyals are written `SR`** (`SR 165`, `91.16 SR`). The script reads them as SAR.
- **Telling Al Rajhi apart from other English-language banks:** the first line must be an Al Rajhi heading **and** the SMS must have an Al Rajhi marker (`SR`, `Card:7777 ;Visa`, `By:6666;mada`, or `To:`/`From:` followed directly by 4 digits). A test checks that a meem-style "Online Purchase" isn't taken as Al Rajhi.

**meem notes**
- **Message types logged:**
  - incoming transfers from other banks ("Local Credit transfer", e.g. rent from the Ejar platform)
  - outgoing transfers to other banks ("Fund Transfer Approved", with its SAR 1.15 fee)
  - mada online purchases
  - credits such as "Savings Account Profit"
- **Message types ignored:** OTPs, beneficiary creation/activation, card activation (it shows a full account number), Apple Pay notices, e-statements, and maintenance or rate notices.
- **Dates:** `23/02/2026 10:09` or `12/08/26 09:10` (day first, 2- or 4-digit year), or `Date: 2026-05-10` with a separate `Time: 09:53:00` line (`dmyAny`).
- **Amounts like `SAR .16`** (no leading zero) are read as `0.16`.
- **Telling meem apart:** its headings are shared with other banks ("Online Purchase"), so it also needs one of meem's labels (`Account Number:`, `Sender account number:`, `Sender Name:`, or a `Credit Transaction:` heading). A test checks that another bank's "Online Purchase" isn't taken as meem.

**Own wallets bought as "merchants":** a mada purchase at URPAY or MYSR/D360 is really a top-up of your own wallet. `OWN_WALLETS` puts the wallet's name (`urpay`, `D360`) in Counter Acct, so LedgerOS can treat it as a transfer between your own accounts.

## 4. The output row (tab-separated)

| Column | Meaning |
|---|---|
| Date / Time | From the SMS (`yyyy-mm-dd`, `hh:mm`) |
| Source | Which parser matched, such as `SNB CC` or `SAIB` |
| Acct | Last 4 of the account or card this row belongs to, or `Travel`. LedgerOS groups by Source + Acct and maps each one to a LedgerOS account. |
| Counter Acct | The **other side's** account as shown in the SMS: last 4 digits (`9103`), or a name for wallets and cards without digits (`Travel`, `urpay`, `D360`, `Drahim`). Empty if the SMS doesn't say. When it matches one of **your** accounts mapped in LedgerOS, LedgerOS treats the row as a transfer between your own accounts and fills both sides of the JV. Otherwise it's just information. |
| Type | Online purchase, POS purchase, Incoming transfer, Bill payment (SADAD), … |
| Description | Merchant, person or biller. Foreign amounts are added in brackets. |
| Amount SAR | Positive, no thousands commas. Blank only for a foreign currency with no fixed rate. |
| Acct Dr/Cr | Side on **Acct**. Money out of a bank account or onto a credit card = Cr; money in or a refund = Dr. |
| Fee SAR | Bank fee in the same SMS (e.g. local transfer), otherwise empty. It becomes its own JV line. |
| Currency / FX Amount | The SMS currency, and the foreign amount when it isn't SAR |
| Remaining | Remaining limit or card balance if the SMS shows one |
| Logged At | When the phone logged it |

If the columns ever change, the script moves the old file aside as *Ledger Inbox (old columns).tsv* instead of mixing layouts.

## 5. How the script reads a message

1. **`normalise(text)`** removes invisible right-to-left marks, turns odd spaces into normal ones, and converts Arabic digits (`٣٤١٫٨٢`) and the Arabic decimal mark to `341.82`.
2. **`PARSERS`** is a list with one entry per bank and account. The **first** entry whose `test(text)` returns true is used. If none matches, the SMS is skipped (OTPs, notices, promos).
3. That entry's **`parse(text)`** returns `{date, time, acct, counter, type, desc, amount, side, fee, currency, fxAmount, remaining}`. It returns `null` for a message type it doesn't log, and the next parser gets a try.
4. **Helpers** you'll reuse:
   - `amountOn(text, word)`: first number on the first line containing `word`. It works whether "SAR" comes before or after the number.
   - `last4(text)`: 4 digits next to `*` (`***1234` or `1234**`).
   - `dmy(text)`: `dd/mm/yy` → `yyyy-mm-dd`.
   - `hhmm(text)`: first `hh:mm`.
   - `num(s)`: strips thousands commas.
   - `linesOf(text)` + `field(lines, "label", …)`: text after a label at the start of a line. It works with and without a colon or space (`مبلغ: SAR 5`, `مبلغ:SAR 5`, `المبلغSAR 5`).
   - `money(s)`: `{cur, amt}` from `SAR 1,475`, `40 MYR`, … `toSar(m)` converts using `FX_TO_SAR`, or leaves it blank.
   - `mdNoYear(text)`: `mm-dd hh:mm` with no year (SAIB).
   - `ymdOrDmy(text)`: `yy/m/d` or `d/m/yy`, whichever reading is valid and closest to today (Al Rajhi).
   - `dmyAny(text)`: `dd/mm/yyyy`, `dd/mm/yy`, or ISO date plus a `Time:` line (meem).
   - `ownWallet(merchant)`: `urpay` / `D360` when a "merchant" is really your own wallet (`OWN_WALLETS`).
   - `xAcct(s)` / `stripAcct(s)`: pull out or remove `XXX1234`.
   - `tr(s)`: Arabic → English using `TRANSLATE`.

## 6. Adding a new message type to a bank that's already supported

1. Copy the SMS as **text** (long-press → Copy). Don't use a screenshot (see lesson 1).
2. In that bank's `parse`, add a rule for the new type, usually one more line in the `type` chain and the right `side`.
3. Add a case to `CASES` in `test_parsers.js` with **invented** numbers and names, then run `node test_parsers.js`.
4. If the new type uses words the bank's `test()` doesn't catch, widen `test()`. If it needs a different trigger phrase, add another automation.

## 7. Adding a new bank

Add an entry to `PARSERS` **above** any entry with a broader `test()`:

```js
{
  source: "BANKNAME ACCT",                     // shown in column 3, used for grouping in LedgerOS
  test: t => t.includes("a phrase only this bank's transaction SMS has"),
  parse: t => {
    const out = /Debit|شراء|Outgoing/i.test(t);  // money leaving the account?
    return {
      date: /* convert to yyyy-mm-dd */, time: hhmm(t), acct: last4(t), counter: "",
      type: out ? "Purchase" : "Incoming transfer",
      desc: /* merchant or counterparty */,
      amount: amountOn(t, "Amount"),
      side: out ? "Cr" : "Dr",
      currency: "SAR", fxAmount: "", fee: "", remaining: "",
    };
  },
},
```

Then add tests (section 6, step 3), add the trigger phrase to the table in section 3, and create its automation on the phone.

## 8. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Pop-up says "Logged" but the amount is blank | The SMS's internal text differs from what's on screen. A **Ledger Debug.txt** file appears in iCloud Drive → Scriptable with the raw characters. Give it to Claude. |
| "Skipped: not a recognised transaction SMS" | No parser's `test()` matched. A new message type: see section 6. |
| "Duplicate, not logged" | That exact transaction is already in the file. This is expected if the same SMS is run twice. |
| Nothing happens when a real SMS arrives | Automation is off, not set to Run Immediately, or the trigger phrase isn't in the message. |
| Row logged with every field blank, but manual runs work | "Get Text from Input" is still on the faded placeholder. Set it to **Shortcut Input**. |
| Grey "Configure Sender" banner | Remove the Sender row (section 2, step 3). |

## 9. Lessons learned (don't repeat these)

1. **Arabic SMS store text in a different order from how it's displayed.** "SAR 341.82" on screen can be stored as `341.82 SAR`. Always build parsers from **pasted text**, never from screenshots, and take numbers from the line by keyword (`amountOn`) rather than assuming "SAR" comes first.
2. **The Shortcuts Sender field only accepts contacts,** and alphanumeric bank senders can't be saved as contacts. Trigger on message text instead.
3. **Shortcuts and Scriptable can't write into OneDrive folders on iPhone** (the folder picker has no Open button). Windows access will come through LedgerOS, not a synced file.
4. **Some banks leave out the year** (SAIB: `10-11 16:31`, month first). The month-first order was confirmed from days above 12 (`07-17`, `07-27`). The year is the latest one that isn't in the future.
5. **This repo is public.** Tests use invented card numbers, amounts and names only.
6. **An OTP can look like a transaction:** SAIB's OTP mentions "حوالة صادرة" and an amount. Parsers decide by the message's **first line**, not by words anywhere in it.
7. **Check a parser against a real batch, privately.** When Muhannad pastes a bank's history, run every message through the script outside the repo, read every logged row, and only commit invented copies as tests. SAIB's first run caught the card line "بطاقة:XXX…" being read as the amount.
8. **One bank can use two date orders** (Al Rajhi). Never pick a date order per bank by assumption: let `ymdOrDmy` choose the reading closest to today.
9. **Banks share headings.** "Online Purchase" is used by Al Rajhi, meem and probably others. Every parser's `test()` needs a heading **and** a marker only that bank uses, and every new bank gets a test proving it doesn't steal another bank's message.
