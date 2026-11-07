# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
One person: the owner, who runs his personal and family finances with double-entry bookkeeping. He is accounting-literate (journal vouchers, accruals, provisions, reconciliation, P&L) and uses the app every day, mostly on a desktop or laptop with a keyboard. The phone is for glancing. Family members do not use the app.

## Product Purpose
A private ledger for a household run like a small company. A normal day covers four jobs, all of them frequent: posting journal vouchers, reconciling bank accounts against statements, checking the financial position (cash, budget, net cash flow, short- and long-term equity), and managing co-owned investments across platforms. Success is a set of books that is reconciled, current and trustworthy, with problems surfaced before they grow.

## Positioning
Real accounting for a family, not a spending tracker: a chart of accounts, JVs, accruals with caps, provisions, forecasts anchored to actuals, Jamiah rounds, real estate, and multi-owner investment platforms with per-owner cost and units.

## Operating Context
- Single-file web app served from GitHub Pages; data syncs to Supabase and is cached locally per device.
- Daily rituals: enter statement balances and work off variances through a New JV; review month-to-date income and expense against budget; close months (accruals, provisions, closing-balance watch, drift alerts).
- The chart of accounts names investment accounts from the platform's perspective ("X - In" is money into platform X).

## Capabilities and Constraints
- Thirteen pages: Dashboard, New JV, Ledger, Accounts, Budget, P&L, Allocations, Provisions, Jamiah, Forecast, Real Estate, Investments, Settings. Page order and visibility are user-configurable.
- Amounts are SAR, with USD for investment cash; numbers must line up (tabular figures).
- Light and dark themes both exist and must both be supported.
- No build step, no framework; everything inline in one HTML file.

## Evidence on Hand
No real figures may appear in the repo or in mockups. The repo is public, so all examples use invented accounts and amounts.

## Product Principles
1. The books must be trustworthy: show what is unreconciled, stale or drifting, never hide it.
2. Dense but calm: an expert works here daily, so information density beats decoration.
3. Every number leads somewhere: a figure on screen should open the entries behind it or the action that fixes it.
4. Keyboard-first on desktop.
