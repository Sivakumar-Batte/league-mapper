# Runs multi-sport-fixtures-manager-tests.html in headless Microsoft Edge and prints the results.
[CmdletBinding()]
param([switch]$RegenerateArtifacts)

$ErrorActionPreference = 'Stop'
$here  = Split-Path -Parent $MyInvocation.MyCommand.Path
$test  = Join-Path $here 'multi-sport-fixtures-manager-tests.html'
$edgeCandidates = @(
  (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
  (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
  (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\Application\msedge.exe')
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
$edge = $edgeCandidates | Select-Object -First 1
if (-not $edge) {
  [Console]::Error.WriteLine('Microsoft Edge executable not found in Program Files (x86), Program Files, or LOCALAPPDATA.')
  exit 2
}
$url   = ([System.Uri]$test).AbsoluteUri
$prof  = Join-Path $env:TEMP ('msfm-edge-' + [guid]::NewGuid())
$args  = @('--headless=new','--disable-gpu','--no-first-run','--allow-file-access-from-files',
           "--user-data-dir=$prof",'--virtual-time-budget=120000','--dump-dom',$url)
$ErrorActionPreference = 'Continue'
$dom = (& $edge @args 2>&1 | Where-Object { $_ -is [string] }) -join "`n"
Remove-Item -Recurse -Force $prof -ErrorAction SilentlyContinue
$m = [regex]::Match($dom, 'RESULTS_JSON:(\{.*?\})</pre>', 'Singleline')
if (-not $m.Success) { $sm=[regex]::Match($dom, '<div id="summary"[^>]*>(.*?)</div>', 'Singleline'); $pr=[regex]::Match($dom, '<pre id="results"[^>]*>(.*?)</pre>', 'Singleline'); $fails=[regex]::Matches($dom, '<div class="r fail">(.*?)</div>', 'Singleline'); Write-Output ('NO RESULTS FOUND. SUMMARY=' + $sm.Groups[1].Value + ' PRE=' + $pr.Groups[1].Value); foreach($f in $fails){Write-Output ('FAILDOM=' + ([regex]::Replace($f.Groups[1].Value,'<[^>]+>',' ')))}; Write-Output 'DOM tail:'; Write-Output ($dom.Substring([Math]::Max(0,$dom.Length-3000))); exit 2 }
$json = [System.Net.WebUtility]::HtmlDecode($m.Groups[1].Value) | ConvertFrom-Json
Write-Output ("PASS={0} FAIL={1}" -f $json.pass, $json.fail)
foreach ($r in $json.results) {
  $tag = if ($r.pass) { 'PASS' } else { 'FAIL' }
  $line = "[$tag] $($r.group) :: $($r.name)"
  if (-not $r.pass -and $r.detail) { $line += "`n       -> " + $r.detail }
  Write-Output $line
}
if ($json.performance) { Write-Output ("`nPERFORMANCE parse_ms={0} compare_ms={1} parsed={2} compared={3}" -f $json.performance.parseMs,$json.performance.compareMs,$json.performance.parsed,$json.performance.compared) }
if ($json.report) {
  Write-Output "`n===== MAPPING REPORT ====="
  foreach ($s in $json.report.perSport) { Write-Output ("{0}: {1} mappings, {2} with Flashscore name, {3} blank" -f $s.sport,$s.total,$s.matchable,$s.blank) }
  Write-Output "`n-- Exact duplicates (same sport + country + priority league) --"
  if ($json.report.exactDuplicates.Count) { $json.report.exactDuplicates | ForEach-Object { Write-Output "  $_" } } else { Write-Output "  none" }
  Write-Output "`n-- Same Flashscore name used twice in the same sport + country --"
  if ($json.report.sharedFlashscoreSameCountry.Count) { $json.report.sharedFlashscoreSameCountry | ForEach-Object { Write-Output "  $_" } } else { Write-Output "  none" }
  Write-Output "`n-- Same Flashscore name in different countries (informational) --"
  $json.report.sameFlashscoreDifferentCountries | ForEach-Object { Write-Output "  $_" }
}
if ($RegenerateArtifacts) {
  if ($json.authCsv) {
    $csvPath = Join-Path $here 'msfm-authoritative-mappings.csv'
    [System.IO.File]::WriteAllText($csvPath, ([char]0xFEFF + $json.authCsv), (New-Object System.Text.UTF8Encoding($false)))
    Write-Output "`nWrote $csvPath"
  }
  if ($json.seedSql) {
    $sqlPath = Join-Path $here 'msfm_priority_mappings_seed.sql'
    [System.IO.File]::WriteAllText($sqlPath, $json.seedSql, (New-Object System.Text.UTF8Encoding($false)))
    Write-Output "Wrote $sqlPath"
  }
}
if ($json.fail -gt 0) { exit 1 }
