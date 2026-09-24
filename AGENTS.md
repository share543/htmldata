# AGENTS.md

## What this repo is

Tools for the CRM customer data, plus their docs.

- `data.html` — single-file, offline, cross-platform **data entry / merge tool**. Vanilla HTML+CSS+JS, all inline, **no build step, no dependencies**. Business staff fill it in; HQ merges their JSON exports and exports a CSV for `report.html`.
- `README.md` — user guide.
- `TECHNICAL.md` — technical spec (data model, storage, merge engine, report CSV contract, tests).
- `customer.xlsx` — source of the 25-column template (see below).

There is no committed build/lint/test runner. Behaviour is tested ad hoc with headless Chromium.

## The data

- `customer.xlsx` — Traditional-Chinese CRM/customer data.
- Byte-identical (md5 `92c82ca0b3abdbf89c30090f05be6103`) to `/mnt/sdcard/Documents/opencode/crm/customer.xlsx`. If one changes, the other probably should match.
- Read with `python3` + `openpyxl` (installed). Sheets:
  - `2026總表` — main data, header in row 1, ~25 cols, ~337 rows.
  - `課別` — code lookup (A1:B9).
  - `工作表1` — empty.
- Gotcha: `2026總表` dimension claims `A1:XES338` (~16729 unused columns of formatting cruft). Filter `None` cells; don't trust `max_column`.

## Working on data.html

- Single file, no deps. Keep CSS/JS inline. Edit directly.
- Verify JS syntax by extracting the main `<script>` and running `node --check`.
- Tests (not committed) live in `/tmp/opencode`: `gen_test.py` emits a harness that injects `window.__DT_TEST__ = true` before the main script and drives the exposed hook API; real UI flows are exercised by clicking the actual buttons. Run with headless Chromium `--dump-dom`.
- The report consumer is `/mnt/sdcard/Documents/opencode/crm/report.html` (reads `.xlsx`/`.csv`, exact header names, naive comma split).

### Invariants / past bugs (guard these)

- `input.list` is read-only → use `inp.setAttribute("list", id)`.
- Owner-filter `<option>`s must use the owner string (`owns[i]`), never the option element.
- "存檔（含資料）" self-copy: serialize a `cloneNode(true)` with `[data-runtime]` nodes removed, and store data in `#datahtml-data` (a `<div>`). Never re-serialize the live DOM; never go back to `//%%DATA%%` marker replacement.
- `doMerge` must not overwrite `_id` / `_createdAt`.
- report.html CSV: its parser is naive comma-split → `sanitizeReport` must replace `,` `"` and newlines.
- `serial` field auto-increments on create; `backfillSerial()` fills missing ones on load/template-apply.

## Gotchas

- **Real customer PII** (names, phones, emails, addresses, 統編) is in `customer.xlsx` and in any data exports. Do not echo it into logs or published output beyond what the task requires.
- Git on this mount needs:
  `git config --global --add safe.directory /mnt/sdcard/Documents/opencode/htmldata`
