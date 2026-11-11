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
   - **Message Contains:** the bank's trigger phrase (table in section 3).
   - **Remove the Sender row.** Bank sender names such as "SNB-AlAhli" can't be saved as contacts, and one condition is enough.
   - Choose **Run Immediately**, then **New Blank Automation**.
   - Add **Get Text from Input** and set it to **Shortcut Input**. Don't leave it on the faded "Input" placeholder.
   - Add **Run Script** (Scriptable): Script = Ledger SMS Logger, Parameter = Text, **Run In App off**.
4. **One automation per trigger phrase.** Every automation runs the same script.

## 3. Banks and trigger phrases

| Source (column 3) | Bank / account | Trigger phrase (Message Contains) | Status |
|---|---|---|---|
| `SNB CC` | SNB credit card | `الصرف المتبقي` | done |
| | SNB debit account | | waiting for samples |
| | SAIB | | waiting for samples |
| | Al Rajhi | | waiting for samples |
| | D360 | | waiting for samples |
| | meem | | waiting for samples |
| | urpay | | waiting for samples |
| | STC Pay | | waiting for samples |

A good trigger phrase appears in **every** transaction SMS from that bank and in **no** OTP, promo or other bank's SMS. The script ignores anything it doesn't recognise anyway, so a phrase that's slightly too broad is harmless.

## 4. The output row (tab-separated)

| Column | Meaning |
|---|---|
| Date | `yyyy-mm-dd`, taken from the SMS |
| Time | `hh:mm` from the SMS |
| Source | Which parser matched, such as `SNB CC`. LedgerOS groups by Source + Card/Acct. |
| Card/Acct | Last 4 digits of the card or account |
| Type | Online purchase, POS purchase, Cashback/Refund, … (Apple Pay is added in brackets) |
| Description | Merchant, or the type when there's no merchant |
| Amount | SAR, positive, no thousands commas |
| Card Dr/Cr | Which side of **this card or account** the amount goes on. Credit card: purchase = Cr (you owe more), refund = Dr. Bank account: money out = Cr, money in = Dr. |
| Remaining | Remaining limit or balance if the SMS shows one, otherwise empty |
| Logged At | When the phone logged it |

## 5. How the script reads a message

1. **`normalise(text)`** removes invisible right-to-left marks, turns odd spaces into normal ones, and converts Arabic digits (`٣٤١٫٨٢`) and the Arabic decimal mark to `341.82`.
2. **`PARSERS`** is a list with one entry per bank and account. The **first** entry whose `test(text)` returns true is used. If none matches, the SMS is skipped (OTPs, notices, promos).
3. That entry's **`parse(text)`** returns `{date, time, acct, type, desc, amount, side, remaining}`.
4. **Helpers** you'll reuse:
   - `amountOn(text, word)`: first number on the first line containing `word`. It works whether "SAR" comes before or after the number.
   - `last4(text)`: 4 digits next to `*` (`***1234` or `1234**`).
   - `dmy(text)`: `dd/mm/yy` → `yyyy-mm-dd`.
   - `hhmm(text)`: first `hh:mm`.
   - `num(s)`: strips thousands commas.

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
      date: /* convert to yyyy-mm-dd */, time: hhmm(t), acct: last4(t),
      type: out ? "Purchase" : "Incoming transfer",
      desc: /* merchant or counterparty */,
      amount: amountOn(t, "Amount"),
      side: out ? "Cr" : "Dr",
      remaining: "",
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
4. **Some banks leave out the year** (e.g. `10-11 16:31`). Work out the year, and day/month order, from the date the SMS arrived, never by guessing.
5. **This repo is public.** Tests use invented card numbers, amounts and names only.
