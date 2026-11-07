---
version: 1
slug: "ledgeros-html"
primary_target: "LedgerOS.html"
related_targets: []
---

Scope: LedgerOS dashboard (and the shell every page shares). Mode: Operate. Status: concept mockup on the design canvas, not built into the app.
Audience/job: the owner, desktop, daily: post JVs, reconcile banks, check position, manage investments.

## Direction contract
FORM: cheque book with counterfoils (grounded candidate 7). seed:3105a93a891fa69a
THESIS: Reconciliation is clearing. Every bank account is a cheque with a counterfoil: the stub keeps the ledger figure, the cheque face takes the statement figure, and when they agree the stub is stamped Cleared. Refuses the KPI-card fintech dashboard.
OWN-WORLD: security-paper mint ground, deep banknote-green shell rail, white cheque-stock panels, perforated stub edges, printed labels in green, figures the user types in ink blue. Archivo for UI, Martian Mono for figures. State stamps: Cleared (green), Uncleared (red), Stale (amber), Void (struck through, never deleted).
STORY: open the app, see which cheques have not cleared, clear them, then read the position.
FIRST VIEWPORT: rail + top bar (search, sync, New JV); the clearing book (bank accounts as counterfoil rows with the statement input) leads; uncleared count in the title.
SIGNATURE: the Cleared stamp landing on a stub when the typed statement matches the ledger.
RISK: perforations and stamps could turn costume; kept to stub edges and state only.
Raises: hairline grid precision (plate section); explicit state vocabulary (transit); nothing disappears, it voids (ticket wallet); scale contrast for the one figure that matters (specimen).
