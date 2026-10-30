# Runs mapper-integration-tests.html in headless Microsoft Edge and writes
# mapper-integration-test-output.txt. Writes no CSV or SQL.
# Exit codes: 0 = no FAIL, 1 = at least one FAIL, 2 = Edge missing or no RESULTS_JSON found.
# Windows PowerShell 5.1, no Node.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$test = Join-Path $here 'mapper-integration-tests.html'
$out  = Join-Path $here 'mapper-integration-test-output.txt'
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Write-NoResults([string]$reason, [string]$dom) {
  $tail = if ($dom) { $dom.Substring([Math]::Max(0, $dom.Length - 3000)) } else { '' }
  $text = "NO RESULTS FOUND. $reason`nDOM tail:`n$tail"
  Write-Output $text
  [System.IO.File]::WriteAllText($out, $text, $utf8)
  exit 2
}

$edgeCandidates = @(
  'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
  'C:\Program Files\Microsoft\Edge\Application\msedge.exe'
)
$edge = $edgeCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $edge) { Write-NoResults 'Microsoft Edge not found.' '' }
if (-not (Test-Path -LiteralPath $test)) { Write-NoResults "Test page not found: $test" '' }

$url  = ([System.Uri]$test).AbsoluteUri
$prof = Join-Path $env:TEMP ('mapper-int-edge-' + [guid]::NewGuid())
$edgeArgs = @('--headless=new','--disable-gpu','--no-first-run','--allow-file-access-from-files',
              "--user-data-dir=$prof",'--virtual-time-budget=1200000','--dump-dom',$url)
$ErrorActionPreference = 'Continue'
# Edge writes UTF-8; decode its stdout as UTF-8 so characters such as the arrow in test names survive.
$prevEnc = $null
try { $prevEnc = [Console]::OutputEncoding; [Console]::OutputEncoding = $utf8 } catch { $prevEnc = $null }
try {
  $dom = (& $edge @edgeArgs 2>&1 | Where-Object { $_ -is [string] }) -join "`n"
} finally {
  if ($null -ne $prevEnc) { try { [Console]::OutputEncoding = $prevEnc } catch { } }
}
Remove-Item -Recurse -Force $prof -ErrorAction SilentlyContinue
if ($null -eq $dom) { $dom = '' }

$m = [regex]::Match($dom, 'RESULTS_JSON:(\{.*?\})\s*</', 'Singleline')
if (-not $m.Success) { Write-NoResults 'No RESULTS_JSON in the page output.' $dom }
try {
  $json = [System.Net.WebUtility]::HtmlDecode($m.Groups[1].Value) | ConvertFrom-Json
} catch {
  Write-NoResults ("RESULTS_JSON could not be parsed: " + $_.Exception.Message) $dom
}

# Records may be under "results" or "records"; totals under "totals" or at the top level.
$records = @()
if ($json.results) { $records = @($json.results) } elseif ($json.records) { $records = @($json.records) }
$tot = if ($json.totals) { $json.totals } else { $json }

# Count from the records so a NOT RUN entry can never be counted as passed.
$pass = 0; $fail = 0; $notRun = 0
$lines = New-Object System.Collections.Generic.List[string]
foreach ($r in $records) {
  $status = [string]$r.status
  switch ($status) {
    'PASS'    { $pass++ }
    'FAIL'    { $fail++ }
    'NOT RUN' { $notRun++ }
    default   { $fail++; $status = "FAIL (unknown status '$status')" }
  }
  $line = "[$status] $($r.group) :: $($r.name)"
  if ($status -ne 'PASS' -and $r.detail) { $line += "`n       -> " + $r.detail }
  $lines.Add($line)
}

# If the page reports totals that disagree with its records, treat that as a failure.
$reported = @{ PASS = $tot.PASS; FAIL = $tot.FAIL; NOT_RUN = $tot.NOT_RUN }
$mismatch = @()
if ($null -ne $reported.PASS    -and [int]$reported.PASS    -ne $pass)   { $mismatch += "PASS page=$($reported.PASS) counted=$pass" }
if ($null -ne $reported.FAIL    -and [int]$reported.FAIL    -ne $fail)   { $mismatch += "FAIL page=$($reported.FAIL) counted=$fail" }
if ($null -ne $reported.NOT_RUN -and [int]$reported.NOT_RUN -ne $notRun) { $mismatch += "NOT_RUN page=$($reported.NOT_RUN) counted=$notRun" }
if ($records.Count -eq 0) { $mismatch += 'RESULTS_JSON contained no result records' }
if ($mismatch.Count) {
  $fail++
  $lines.Add("[FAIL] runner :: totals check`n       -> " + ($mismatch -join '; '))
}

$header = "PASS={0} FAIL={1} NOT_RUN={2}" -f $pass, $fail, $notRun
$text = $header + "`n" + ($lines -join "`n") + "`n" + $header
Write-Output $text
[System.IO.File]::WriteAllText($out, $text, $utf8)
Write-Output "`nWrote $out"
if ($fail -gt 0) { exit 1 }
exit 0
