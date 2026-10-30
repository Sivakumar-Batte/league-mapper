# League &amp; Team Mapper (EU Sports)

A set of self-contained, browser-based tools for mapping Flashscore leagues and
teams to the operations team's names, checking data feeds, and preparing fixture
work. Every tool is a single HTML page with no build step and no backend of its
own; data is kept in the browser, with an optional **read-only** shared copy in
Supabase.

> Hosted with GitHub Pages: **https://sivakumar-batte.github.io/league-mapper/**
> (open any of the pages below by adding its file name to that URL).

## Tools

| Page | What it does |
|------|--------------|
| [`index.html`](index.html) | **League &amp; Team Mapping Console** — the main hub. |
| [`multi-sport-fixtures-manager.html`](multi-sport-fixtures-manager.html) | **Multi-Sport Fixtures Priority League Manager** — manage priority-league mappings for six sports, paste Flashscore fixtures, keep a 7-day collection, compare against worked matches, and manage **team mappings** (Flashscore team &rarr; BCM team) that show up as **BCM Home / BCM Away / Mapping Status** columns with one-click copy. |
| [`datafeed-check.html`](datafeed-check.html) | **DataFeed Check** — validates BR/BG feeds against the mapping and flags issues. |
| [`lbc-matcher.html`](lbc-matcher.html) | **LBC Event ID Matcher** — matches events across providers by Event ID. |
| [`architecture-diagram.html`](architecture-diagram.html) | **Architecture &amp; Data Flow** — a visual overview of how the tools fit together. |

## Supported sports

Basketball, Ice hockey, Floorball, Waterpolo, Bandy, Field hockey.

## How data is stored (important)

- **Local first.** Priority-league mappings, team mappings, the fixture
  collection, worked-history drafts and import history are saved in **your
  browser** (Local Storage, with an IndexedDB recovery mirror). They are
  **not** shared across computers until they are written to Supabase.
- **Supabase is read-only from the browser.** The pages can *load* a shared
  mapping list using the suite's public (publishable) key, but they **never
  write** to the database. To share a change, use the page's **"Export … as
  Supabase SQL"** button and run that SQL in the Supabase SQL Editor (project
  owner only). The UI labels unsynced data as *"Local only — not yet shared to
  Supabase."*
- No private keys or credentials are stored in this repo. The only key present
  is the public publishable (anon) key, which is safe to expose.

## Repository layout

```
index.html                         Main console
multi-sport-fixtures-manager.html  Fixtures + priority-league + team mappings
datafeed-check.html                Feed validation
lbc-matcher.html                   Event ID matcher
architecture-diagram.html          Architecture overview
vendor/
  xlsx-0.20.3.full.min.js          SheetJS (Excel import), loaded via relative path
  README.txt                       Vendor notes + SHA-256 checksum

# Tests (open in a browser or run with the PowerShell runners)
multi-sport-fixtures-manager-tests.html   run-msfm-tests.ps1
mapper-integration-tests.html             run-mapper-integration-tests.ps1
prepare-mapping-tests.html
ui-enhancements-tests.html

# Supabase setup (review before running; nothing here is auto-executed)
msfm_mappings_setup.sql            Shared priority-league table
msfm_priority_mappings_seed.sql    Seed rows for the priority-league table
msfm_team_mappings_setup.sql       Shared team-mapping table
SUPABASE_SETUP_MSFM.md             Setup guide, RLS posture, verification queries
```

## Running locally

These are plain HTML files, so you can open them directly from disk. A few
features behave best when the folder is served over a local web server
(file:// can block some browser APIs):

```powershell
# from the project folder, any one of these works:
python -m http.server 8000
# then open http://localhost:8000/multi-sport-fixtures-manager.html
```

**Excel import** on the Team Mappings tab uses the local SheetJS file in
`vendor/`. If that file is missing or blocked, Excel import is disabled and the
tool tells you so — **CSV / TSV / TXT import keeps working** either way.

## Tests

The automated test harnesses load the real pages in a hidden frame with an
in-memory store (your real browser data is never touched). On Windows with
Microsoft Edge installed:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File run-msfm-tests.ps1
```

The runner prints `PASS=… FAIL=…`. It is read-only by default and does not
change the mapping CSV or seed SQL.

## Supabase (optional, shared mappings)

Shared mapping lists are **optional**. To enable them, the Supabase project
owner runs the SQL files above in the Supabase SQL Editor and chooses a read
option as described in `SUPABASE_SETUP_MSFM.md`. Until then, the tools work
fully on local browser data.
