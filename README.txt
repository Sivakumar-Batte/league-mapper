vendor - application third-party code (loaded by application pages)
===================================================================

xlsx-0.20.3.full.min.js
  SheetJS Community Edition (xlsx) version 0.20.3, the official pre-built
  browser bundle. It is a classic (non-module) script that defines a global
  `XLSX` object. The Multi-Sport Fixtures Manager loads it from this folder
  with a RELATIVE path so the page works offline:

      <script src="vendor/xlsx-0.20.3.full.min.js"></script>

  It is used ONLY by the Team Mappings tab to read .xlsx / .xls files for
  import. If the file is missing or blocked, the Team Mappings importer
  degrades gracefully: CSV / TSV / TXT import keeps working and the UI tells
  the user that Excel import is unavailable. No other feature depends on it.

  Source (pinned, same version already used by index.html / lbc-matcher.html):
    https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js

  Integrity:
    bytes   951904
    sha256  cc015130aa8521e7f088f88898eba949ccdcbfb38df0bd129b44b7273c3a6f41

  To re-verify on Windows PowerShell:
    (Get-FileHash -Algorithm SHA256 vendor\xlsx-0.20.3.full.min.js).Hash.ToLower()

  Licence: Apache-2.0, Copyright (C) 2012-present SheetJS LLC
    https://github.com/SheetJS/sheetjs/blob/master/LICENSE

  SECURITY NOTE (matches the AppSec TODO in index.html): this is the same
  SheetJS 0.20.3 build that index.html and lbc-matcher.html load from the CDN.
  Vendoring it here removes the runtime CDN dependency for this page. If you
  later self-host on approved Entain infrastructure, update the <script> path
  and this checksum together.

  The automated test harness (multi-sport-fixtures-manager-tests.html) does NOT
  depend on this file: Excel parsing is tested by feeding an in-memory workbook
  built with XLSX when it is present, and the harness still passes with no
  network access. If XLSX is absent, the Excel-specific checks report that
  Excel import is unavailable rather than failing.
