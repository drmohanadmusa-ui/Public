---
name: data-question
description: Answer Muhannad's questions about his real LedgerOS data (balances, spending, budgets, investments, Jamiah, accruals) using the read-only Supabase connector. Use when he asks about his actual numbers rather than about the app's code.
argument-hint: "[question about your data]"
---

# Answer a question from the real data (read-only)

Question: $ARGUMENTS

## Rules

- **Read-only, always.** Run `SELECT` queries only. Never insert, update, delete or alter anything, even if asked. Fixes to data are made by Muhannad in the app.
- **Real figures stay in chat.** Never write them into the repo, tests, commits or `CLAUDE.md`. The repo is public.
- If no Supabase tools are available in this session, tell him to switch on his **Supabase read-only** connector for the session, then stop.

## Steps

1. **Confirm the connection is read-only.** Run `show transaction_read_only;`, which should return `on`. If it returns `off`, tell him, and carry on with SELECTs only.
2. **Understand the meaning before querying.** Check how the app computes the figure in `LedgerOS.html` (grep the relevant function), and answer the way the app would.
   - Ledger balances and the P&L read `pd_ledger` together with `pd_accounts`, and actuals keep the ledger's raw sign. Check the app's convention for the account type.
   - Investments use `pd_inv_platforms`, `pd_inv_positions`, `pd_inv_transactions` (per-owner units, and `sar`/`usd` in the owners array when stored), `pd_inv_cash_movements` (rows with `kind = 'costadj'` are cost corrections and are not cash), `pd_inv_valuations` and `pd_inv_owners`.
   - Budgets and forecasts use `pd_budget`, `pd_provisions`, `pd_forecast_account_rules`, `pd_forecast_plans` and `pd_accrual_mappings`. The Jamiah module uses `pd_jamiahs`.
   - Other tables: `pd_categories`, `pd_subcategories`, `pd_templates`, `pd_drafts`, `pd_ui_prefs`, `pd_inv_settings`, `pd_inv_robo_value_log`, `pd_real_estate_buildings`, the translation tables, and `pd_sync_meta`.
   - Check actual column names with the connector's table listing before writing SQL.
3. **Query, then cross-check.** Run small, specific queries. Re-derive any total a second way (for example, the sum of lines vs a running balance). Say if the two disagree.
4. **Answer plainly.** Lead with the number or finding. Use SAR, or USD for platform cash, with thousands separators. Then give a short note on how you got it (the tables and the filter), so he can check it in the app.
5. If the data looks wrong (a missing buy, an unbalanced JV, a stale price), point it out and say where in the app he can fix it. **Don't fix it yourself.**
