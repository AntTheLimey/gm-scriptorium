# The scriptable steps of runbook criteria C1, C209, C210, C211 and C215, run against the packaged exe
# with Node removed from PATH. Each criterion runs only when this checkout's runbook has it. Steps that
# need a person (opening a page in Edge, watching the Console) are listed as not automated.
param([Parameter(Mandatory)] [string] $Exe, [Parameter(Mandatory)] [string] $Repo)
$ErrorActionPreference = 'Stop'

# The exe must stand on its own: no Node anywhere on PATH.
$env:Path = ($env:Path -split ';' | Where-Object { $_ -and -not (Test-Path (Join-Path $_ 'node.exe')) }) -join ';'
if (Get-Command node -ErrorAction SilentlyContinue) { throw 'node is still on PATH' }

$Scratch = Join-Path $env:RUNNER_TEMP 'wincheck'
New-Item -ItemType Directory -Force -Path $Scratch | Out-Null
$Config = Join-Path $Scratch 'config.toml'
$env:SCRIPTORIUM_CONFIG = $Config
$env:APPDATA = Join-Path $Scratch 'appdata'
Remove-Item Env:SCRIPTORIUM_PROFILE -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $env:APPDATA | Out-Null

$Runbook = Get-Content -Raw (Join-Path $Repo '.agents\windows-verification.md')
$Version = (Get-Content -Raw (Join-Path $Repo 'package.json') | ConvertFrom-Json).version
$Results = [ordered]@{}
$Failed = 0

function Has([string] $c) { return $Runbook -match "(?m)^### ${c}:" }
function Run([string[]] $a) {
  # The exe's exit code is the result; its stderr lines are output to read, not script errors.
  $ErrorActionPreference = 'Continue'
  $out = & $Exe @a 2>&1 | Out-String
  return [pscustomobject]@{ Code = $LASTEXITCODE; Out = $out }
}
function Check([string] $c, [string] $step, [bool] $ok, [string] $detail = '') {
  if (-not $Results.Contains($c)) { $Results[$c] = @() }
  $Results[$c] += [pscustomobject]@{ step = $step; ok = $ok; detail = $detail }
  $mark = if ($ok) { 'PASS' } else { 'FAIL' }
  Write-Host "$mark $c $step $detail"
  if (-not $ok) { $script:Failed++ }
}
function CopyVault([string] $rel, [string] $name) {
  $dst = Join-Path $Scratch $name
  Copy-Item -Recurse -Path (Join-Path $Repo $rel) -Destination $dst
  return $dst
}
function Html([string] $dir) { return Get-ChildItem -Recurse -File -Path $dir -Filter *.html }
function Grep([string] $dir, [string] $text, [string] $filter = '*') {
  # A plain substring test: -like reads [ and ] as a wildcard class, so "[[800, 10]" matched nearly anything.
  # An empty file reads as $null, which is "not found".
  return @(Get-ChildItem -Recurse -File -Path $dir -Filter $filter | Where-Object { $c = Get-Content -Raw -LiteralPath $_.FullName; ($null -ne $c) -and $c.Contains($text) })
}
function AddCampaign([string] $name, [string] $vault, [string] $siteConfig = '') {
  $a = @('config', 'add', $name, '--vault', $vault, '--out', (Join-Path $Scratch "$name-out"), '--config', $Config)
  if ($siteConfig) { $a += @('--site-config', $siteConfig) }
  $r = Run $a
  if ($r.Code -ne 0) { throw "config add $name exited $($r.Code): $($r.Out)" }
  return Join-Path $Scratch "$name-out"
}

# ---- C1: the exe runs with no Node ----
$r = Run @('--version')
Check 'C1' '--version exits 0 and names the version' (($r.Code -eq 0) -and ($r.Out.Trim() -split "`n")[0].Contains($Version)) $r.Out.Trim()
$r = Run @('--help')
Check 'C1' '--help exits 0' ($r.Code -eq 0)
$tll = CopyVault 'examples\the-long-lease' 'c1-vault'
$out1 = AddCampaign 'c1' $tll
$r = Run @('check', 'c1', '--config', $Config)
Check 'C1' 'check exits 0' ($r.Code -eq 0) "exit $($r.Code)"
$r = Run @('build', 'c1', '--config', $Config)
Check 'C1' 'build exits 0' ($r.Code -eq 0) "exit $($r.Code)"
Check 'C1' 'build wrote index.html' (Test-Path (Join-Path $out1 'index.html'))
$r = Run @('status', '--config', $Config)
Check 'C1' 'status exits 0' ($r.Code -eq 0) "exit $($r.Code)"
$r = Run @('config', 'list', '--config', $Config)
Check 'C1' 'config list exits 0 and names c1' (($r.Code -eq 0) -and $r.Out.Contains('c1'))

# ---- Excluded folder written with Windows backslashes (the excluded-folder fix's Windows leg) ----
$sv = CopyVault 'test\fixtures\story-vault' 'ex-vault'
$sc = Get-Content -Raw (Join-Path $Repo 'test\fixtures\story-vault-site-config.json') | ConvertFrom-Json
$sc.excludeDirs = @($sc.excludeDirs) + @('Characters\NPCs')
$scPath = Join-Path $Scratch 'ex-site.json'
$sc | ConvertTo-Json -Depth 20 | Set-Content -Encoding utf8NoBOM -Path $scPath
$outEx = AddCampaign 'ex' $sv $scPath
$r = Run @('build', 'ex', '--force-check', '--config', $Config)
Check 'EXCL' 'build with excludeDirs "Characters\NPCs" exits 0' ($r.Code -eq 0) "exit $($r.Code)"
$npc = @(Get-ChildItem -Path (Join-Path $outEx 'characters\npcs') -Filter *.html -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne 'index.html' })
Check 'EXCL' 'no NPC page is built' ($npc.Count -eq 0) "$($npc.Count) NPC pages"

# ---- C209: stub pages withhold by the pin's own rule ----
if (Has 'C209') {
  $v = CopyVault 'test\fixtures\stub-heading-collision-vault' 'c209-vault'
  Copy-Item (Join-Path $Repo 'test\fixtures\stub-heading-collision-vault-site-config.json') (Join-Path $Scratch 'c209-site.json')
  $o = AddCampaign 'c209' $v (Join-Path $Scratch 'c209-site.json')
  $r = Run @('build', 'c209', '--force-check', '--config', $Config)
  Check 'C209' '1. build --force-check exits 0' ($r.Code -eq 0) "exit $($r.Code)"
  foreach ($s in 'stubleaksentinel', 'stubhushsentinel', 'storyordersentinel') {
    $hits = Grep $o $s
    Check 'C209' "2. '$s' is in no output file" ($hits.Count -eq 0) (($hits | ForEach-Object Name) -join ', ')
  }
  $cellar = Join-Path $o 'locations\cellar.html'
  Check 'C209' '2. cellar.html has no "Mentioned In"' ((Test-Path $cellar) -and -not ((Get-Content -Raw $cellar) -like '*Mentioned In*'))
  foreach ($s in 'publishedappearancesentinel', 'storyappearancesentinel') {
    Check 'C209' "3. '$s' is published" ((Grep $o $s).Count -gt 0)
  }
}

# ---- C210: the Connections lane reads the generator's section ----
if (Has 'C210') {
  $v = CopyVault 'examples\the-long-lease' 'c210-vault'
  $o = AddCampaign 'c210' $v
  $r = Run @('build', 'c210', '--config', $Config)
  Check 'C210' '1. build exits 0' ($r.Code -eq 0) "exit $($r.Code)"
  $cx = Grep $o 'class="cx"' '*.html'
  Check 'C210' '2. no page keeps the pin''s section' ($cx.Count -eq 0) (($cx | ForEach-Object Name) -join ', ')
  $lanes = (Grep $o 'data-scriptorium-connections' '*.html').Count
  Check 'C210' '2. 38 pages carry the lane' ($lanes -eq 38) "$lanes pages"
  Check 'C210' '3. Edge and the Console' $true 'not automated: needs a person'
}

# ---- C211: no GURPS to-hit calculator script ships ----
if (Has 'C211') {
  $v = CopyVault 'test\fixtures\redaction-gurps-vault' 'c211-vault'
  Copy-Item (Join-Path $Repo 'test\fixtures\redaction-gurps-vault-site-config.json') (Join-Path $Scratch 'c211-site.json')
  $o = AddCampaign 'c211' $v (Join-Path $Scratch 'c211-site.json')
  $r = Run @('build', 'c211', '--force-check', '--config', $Config)
  Check 'C211' '1. build --force-check exits 0' ($r.Code -eq 0) "exit $($r.Code)"
  Check 'C211' '1. the redaction note names gurps-tohit-script' ($r.Out.Contains('rules-content redaction(s) degraded this build') -and $r.Out.Contains('gurps-tohit-script'))
  $js = Join-Path $o 'js\gurps-tohit.js'
  Check 'C211' '2. js\gurps-tohit.js is the redacted stub' ((Test-Path $js) -and (Get-Content -Raw $js).StartsWith('// Redacted by Scriptorium'))
  $tables = Grep $o '[[800, 10]'
  Check 'C211' '2. no output file holds the to-hit table' ($tables.Count -eq 0) (($tables | ForEach-Object Name) -join ', ')
  $exeText = [System.Text.Encoding]::Latin1.GetString([System.IO.File]::ReadAllBytes($Exe))
  Check 'C211' '3. the exe holds no to-hit table' (-not $exeText.Contains('[[800, 10]'))
}

# ---- C215: YAML dates read "D Month YYYY" ----
if (Has 'C215') {
  $v = CopyVault 'examples\the-long-lease' 'c215-vault'
  $ev = Join-Path $v "Events\The Chorister's Verse.md"
  $text = [System.IO.File]::ReadAllText($ev)
  $i = $text.IndexOf("`n---", 3)
  $text = $text.Substring(0, $i) + "`nin_game_date: 2031-02-12" + $text.Substring($i)
  [System.IO.File]::WriteAllText($ev, $text)
  $o = AddCampaign 'c215' $v
  $r = Run @('build', 'c215', '--config', $Config)
  Check 'C215' '1. build exits 0' ($r.Code -eq 0) "exit $($r.Code)"
  $badges = @(Get-ChildItem -Path (Join-Path $o 'sessions') -Filter *.html | Sort-Object Name | ForEach-Object {
    $m = [regex]::Match((Get-Content -Raw $_.FullName), '<span class="metadata-badge" data-field="play_date">([^<]*)</span>')
    if ($m.Success) { $m.Groups[1].Value } })
  Check 'C215' '2. session badges read 11 July, 25 July, 8 August 2026' (($badges -join '|') -eq '11 July 2026|25 July 2026|8 August 2026') ($badges -join ' | ')
  Check 'C215' '2. the event''s Date line reads 12 February 2031' ((Get-Content -Raw (Join-Path $o 'events\the-choristers-verse.html')) -like '*<span class="label">Date</span> 12 February 2031*')
  Check 'C215' '2. the barrow''s timeline reads 12 February 2031' ((Get-Content -Raw (Join-Path $o 'locations\maudrys-barrow.html')) -like '*<span class="timeline-date">12 February 2031</span>*')
  $iso = Grep $o '2031-02-12' '*.html'
  Check 'C215' '3. no page prints 2031-02-12' ($iso.Count -eq 0) (($iso | ForEach-Object Name) -join ', ')
}

$Results | ConvertTo-Json -Depth 5 | Set-Content -Path (Join-Path $env:RUNNER_TEMP 'wincheck-results.json')
$md = "## Windows criteria (scripted steps)`n`n| Criterion | Step | Result | Detail |`n|---|---|---|---|`n"
foreach ($c in $Results.Keys) { foreach ($s in $Results[$c]) { $md += "| $c | $($s.step) | $(if ($s.ok) { 'pass' } else { '**FAIL**' }) | $($s.detail -replace '\|', '/') |`n" } }
$md | Out-File -Append -FilePath $env:GITHUB_STEP_SUMMARY
if ($Failed -gt 0) { throw "$Failed step(s) failed" }
