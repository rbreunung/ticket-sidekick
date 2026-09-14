# Known-Limitation Register

A register of known limitations this codebase's maintainer has consciously
decided not to fix right now — not every deferred item, only the ones
knowingly chosen to defer. A scheduled Routine checks in roughly monthly and
walks through the Active Register with the maintainer; see
[`docs/plans/2026-09-14-0736-feat-known-limitation-register-plan.md`](plans/2026-09-14-0736-feat-known-limitation-register-plan.md)
for the full design.

## Convention

**What qualifies.** A consciously-deferred known limitation — one the
maintainer looked at and chose not to fix immediately, not every limitation
this codebase has. Most limitations should still be resolved or permanently
declined at the moment they're found; only the few genuinely kept open get
an entry here.

**Fields.** Each Active Register row carries:

- **ID** — a stable `KL<N>` identifier (next unused number; never reused;
  gaps after removal are fine), mirroring this repo's `R<N>`/`U<N>`
  convention.
- **Description / Pointer** — what the limitation is, with a repo-relative
  pointer (file:line, or a doc section) to where it's fully described.
- **Found** — the date the entry was registered.
- **Severity** — `High`, `Medium`, or `Low`.
- **Reason** — why it wasn't resolved immediately.

**How the Routine uses this file.** On each accepted monthly check-in, the
Routine reads this Convention section for the current fields and severity
scale, then reads the Active Register below. It presents every row sorted
by severity (High → Medium → Low) and lets the maintainer choose, per row:
fix it now (removed from the Active Register), leave it unchanged (stays
as-is), or declare it a permanent won't-fix (moved to the Won't-Fix Log
below, with its reason and the date declined, before removal). All of a
firing's decisions are written back together, once, after the walkthrough
ends, and the Routine commits and pushes that change to this repo's tracked
branch before the firing ends.

**Adding a new entry.** When you consciously decide to defer a limitation
rather than fix or permanently decline it, add a row to the Active Register
below with the next unused `KL<N>` ID and a severity.

## Active Register

| ID | Description / Pointer | Found | Severity | Reason |
| --- | --- | --- | --- | --- |

## Won't-Fix Log

Append-only. A row here is never edited or removed once written.

| ID | Description / Pointer | Found | Severity | Reason | Declined |
| --- | --- | --- | --- | --- | --- |
