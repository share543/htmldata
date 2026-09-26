# AGENTS.md

## What this repo is

Tools for the CRM customer data, plus their docs.

- `data.html` — single-file, offline, cross-platform **data entry / merge tool**. Vanilla HTML+CSS+JS, all inline, **no build step, no dependencies**. Business staff fill it in; HQ merges their JSON exports and exports a CSV for `report.html`.
- `README.md` — user guide.
- `TECHNICAL.md` — technical spec (data model, storage, merge engine, report CSV contract, tests).
- `customer.xlsx` — source of the 25-column template (see below). **Not committed** — it is gitignored because it holds real customer data.
- `tests/data-html.test.js` + `package.json` / `.npmrc` — dev-only regression tests. The tool itself stays zero-dependency.

Tests: two layers, both run in CI (`.github/workflows/ci.yml`):

- `npm test` — Node + jsdom, offline, ~1s. 78 checks in `tests/data-html.test.js`. This is the main regression net.
- `npm run test:e2e` — Playwright + real Chromium, `tests/e2e/data-html.spec.js` (10 specs). Covers only what jsdom cannot: real file chooser, real downloads, opening the self-copy from disk via `file://`, real reload (`beforeunload`), keyboard focus, print/mobile CSS, real layout. **Playwright cannot run on Android/Termux** (`Unsupported platform: android`), so this only runs in CI or on a desktop.

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
- Both test layers run in CI. When changing `data.html`, `npm test` is the fast loop; the Playwright layer only runs in CI (it cannot run on Termux), so if you touch real-browser behaviour (downloads, `file://`, CSS, focus) expect to verify it there. Never depend on `node_modules/.bin` in scripts — `.npmrc` sets `bin-links=false`.
- jsdom gotcha: its `localStorage` is a Proxy — assigning to the *instance* is silently treated as writing an entry, so simulating a quota failure requires overriding `Storage.prototype.setItem`.
- This mount does not support symlinks, so `npm install` needs `bin-links=false`; that is set in `.npmrc`. `node_modules/` is gitignored.
- The report consumer is `../crm/report.html` (reads `.xlsx`/`.csv`, exact header names, naive comma split). Older notes give the absolute path `/mnt/sdcard/Documents/opencode/crm/report.html` — inside Termux use `~/storage/documents/opencode/crm/report.html` (`/mnt/sdcard` exists but is not readable from Termux).

### Invariants / past bugs (guard these)

- `input.list` is read-only → use `inp.setAttribute("list", id)`.
- Owner-filter `<option>`s must use the owner string (`owns[i]`), never the option element.
- "存檔（含資料）" self-copy: serialize a `cloneNode(true)` with `[data-runtime]` nodes removed, and store data in `#datahtml-data` (a `<div>`). Never re-serialize the live DOM; never go back to `//%%DATA%%` marker replacement.
- `doMerge` must not overwrite `_id` / `_createdAt`.
- report.html CSV: its parser is naive comma-split → `sanitizeReport` must replace `,` `"` and newlines.
- `serial` field auto-increments on create; `backfillSerial()` fills missing ones on load/template-apply.
- Table header: never put HTML into `textContent` — the 必填 `*` must be a real `<span>` element.
- Merge-dialog 判重 chips are built with **DOM APIs**, never `innerHTML` concatenation: keys come from other people's exported JSON and may contain quotes.
- Merge preview (`refreshDupCells`) must accumulate the same basis in the same order as `doMerge`, otherwise the preview count is lower than the actual merge result.
- `saveToStorage()` must never delete the current copy before the new one is fully written (generation pointer = commit point). See TECHNICAL.md 3.1.
- Save success calls `clearErrorBanner()`, never `hideBanner()` — info banners must survive autosave.
- `ruleDup === "newer"` with an older incoming record is a **skip**, not a merge.
- `number` fields with a non-numeric stored value must fall back to `type=text`, otherwise the value is silently wiped on save.
- The owner-filter `<select>` must be inserted **outside** `.menuWrap`, or the click-outside handler will think it is still inside a menu and never close the import/export dropdowns.
- Pager controls are `<button>` (keyboard reachable), not `<span>`. Individual row selection must call `syncHeaderCheckbox()`.
- `beforeunload` / `pagehide` must flush the pending debounced save.
- Merge dialog: `#schemaDiff` warns about field-structure differences (written with `textContent`); `#mergeRenumber` **defaults to ON** — 統編／客代 are the identity fields and 序號 is only a display label, so renumbering to 1…N is intended (it must not touch `_updatedAt`).
- Test harness: `openMergeViaUI` / `openCsvViaUI` must first close any open modal and then wait for the **content** to match the batch (file count + names). Waiting only for `open` reads a leftover dialog from a previous test and yields confidently wrong results. Tests that merely inspect a dialog (T4, T9) must close it themselves.
- Never conclude from reading code alone: the 2026-09-26 review wrongly claimed the dup branch did not update `_owner`/`_updatedAt`. Write a test.

## Gotchas

- **Real customer PII** (names, phones, emails, addresses, 統編) is in `customer.xlsx` and in any data exports. Do not echo it into logs or published output beyond what the task requires.
- Git on this mount needs a safe.directory entry (or pass `-c safe.directory=…` per command):
  `git config --global --add safe.directory /storage/emulated/0/Documents/opencode/htmldata`
- `git` has `credential.helper=store` configured but no `~/.git-credentials`, so pushes fail with "could not read Username". Either run `gh auth setup-git` once, or push with
  `git -c credential.helper= -c credential.helper='!gh auth git-credential' push`.
