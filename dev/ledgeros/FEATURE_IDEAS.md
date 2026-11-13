# LedgerOS feature long list (#65, 2026-11-13)

Built from the online research and Muhannad's answers in #65. Sorted by impact on his own workflow first, then his wife's, then friends. Nothing here is agreed yet: he picks numbers, then each one gets deeper questions and an implementation plan.

| # | Feature | Who | Why it ranks here | Size |
|---|---|---|---|---|
| A | **Goal planner ("can I meet this?")**: pick a goal (amount, month, which cash), see the month cash turns negative and by how much, and get suggestions that close the gap (cut categories using the historical averages, move the date, use accrual reserves, borrow X). Works on a copy of the plan, so the real budget only changes when he accepts. | him | His main monthly question; today it is done by hand through budget + provisions + forecast. | L |
| B | **Loans and schedules**: personal loan, car loan or lease, mortgage. Instalment schedule (flat-rate / reducing balance), payments flow into the Forecast, early-payoff calculator (pay X extra or settle in month M: what it saves, new end date), ready instalment JV (principal / profit split). | him | Directly serves his 3-year debt goals; today kept in Excel. | M |
| C | **Debt-free roadmap**: one timeline of the big steps (loans taken and paid off, savings goals, investing) with projected cash and net worth. Uses A and B. | him | Shows whether the whole plan holds together. | M (after A, B) |
| D | **Faster monthly plan update**: one guided screen: last month plan vs actual, suggested next-month figures per category (from averages), accept all / edit a few, provisions copied forward. | him | The lengthy once-a-month job. | M |
| E | **Merchant memory for SMS**: remember which expense account each merchant goes to and fill the other half in Create JV automatically. | him | Logging is his biggest time cost; the SMS other halves are still picked by hand. | S |
| F | **Phone layout (auto-detected)**: on a phone, bottom tab bar, big buttons, a quick "+ Add" button, short pages; desktop unchanged. Installable to the home screen (icon, opens full screen). | him, wife, friends | Needed for every non-desktop user. | M |
| G | **Sign-in per person**: email + password (Supabase Auth), each person's data separate, tighter database rules. | wife, friends | Must come before the wife's version or friends; also the planned security hardening. | L |
| H | **Simple mode for his wife**: "Spent / Received" big buttons, categories with icons, monthly budget envelopes with "left to spend" bars (EveryDollar / DollarWise style), no accounting words (a JV is still written behind the scenes). | wife | What she needs; depends on F and G. | L |
| I | **Easy logging without SMS setup**: favourites and repeat items, "coffee 18" one-line entry, and one optional iPhone automation on Apple Pay payments (the Wallet "Transaction" trigger) that sends merchant + amount. | wife, friends | Manual logging is why simple users stop. | M |
| J | **Household link**: shared savings goals and an optional summary of her spending in his view. | him + wife | After G and H. | M |
| K | **Feature switches per user**: choose which pages show (starter set: Dashboard, New JV, Budget & P&L, Accounts, Ledger, Investments), synced per login instead of per device. | friends | Cheap once G exists (page hiding already exists per device). | S |
| L | **Starter setup for a new user**: a ready household chart of accounts + a demo account with invented figures to try. | friends | Without it a new user faces an empty app. | M |
| M | **Bills and subscriptions calendar**: recurring payments found in the ledger, shown on a calendar with "due in 7 days". | wife, him (less: provisions cover it) | Popular in Monarch; partly covered by Provisions. | M |
| N | **Ask-your-money AI helper** (Claude through an Edge Function): plain-language questions and the explanation behind A's suggestions. | him | Nice on top of A; costs per use and sends figures to the AI provider. | M |
| O | **Weekly summary**: a short weekly notice (spent vs budget, what is coming). | him, wife | Keeps simple users engaged. | S |
| P | **Arabic interface** | friends | Only if friends need it. | L |

Skipped on his answer: zakat. Low priority on his answer: pricing / selling.
