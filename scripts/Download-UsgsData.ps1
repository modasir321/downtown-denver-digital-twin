<#
.SYNOPSIS
  Download USGS elevation URLs from a text file (one URL per line).
  Supports resume (skips existing non-empty files), logging, and parallel downloads.

.EXAMPLE
  .\Download-UsgsData.ps1 -UrlFile "..\data\raw\data (1).txt" -OutDir "..\data\downloads\dem"
  .\Download-UsgsData.ps1 -UrlFile "..\data\raw\data (2).txt" -OutDir "..\data\downloads\laz" -Throttle 4
  .\Download-UsgsData.ps1 -UrlFile "..\data\raw\data (2).txt" -OutDir "..\data\downloads\laz" -Filter "DRCOG_2020"
#>
param(
  [Parameter(Mandatory = $true)]
  [string]$UrlFile,

  [Parameter(Mandatory = $true)]
  [string]$OutDir,

  [int]$Throttle = 4,

  [string]$Filter = "",

  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
if (-not (Test-Path $UrlFile)) { throw "URL file not found: $UrlFile" }

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$logDir = Join-Path $OutDir "_logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$okLog = Join-Path $logDir "ok.txt"
$failLog = Join-Path $logDir "fail.txt"
$skipLog = Join-Path $logDir "skip.txt"
$progressLog = Join-Path $logDir "progress.txt"

$urls = Get-Content -Path $UrlFile |
  ForEach-Object { $_.Trim() } |
  Where-Object { $_ -and ($_ -match '^https?://') }

if ($Filter) {
  $urls = $urls | Where-Object { $_ -match [regex]::Escape($Filter) -or $_ -match $Filter }
}

$total = $urls.Count
Write-Host "URLs to process: $total  |  Out: $OutDir  |  Throttle: $Throttle"
if ($DryRun) {
  $urls | Select-Object -First 10
  Write-Host "... (dry run, showing up to 10)"
  exit 0
}

function Get-RelativeSavePath([string]$url) {
  $u = [uri]$url
  # Keep project folder + filename: .../Projects/<project>/.../<file>
  $parts = $u.AbsolutePath.Trim('/').Split('/')
  $projIdx = [array]::IndexOf($parts, 'Projects')
  if ($projIdx -ge 0 -and $projIdx -lt $parts.Length - 1) {
    $rel = ($parts[($projIdx + 1)..($parts.Length - 1)] -join '\')
  } else {
    $rel = $parts[-1]
  }
  return $rel
}

$scriptBlock = {
  param($url, $OutDir, $okLog, $failLog, $skipLog)

  try {
    $rel = & {
      $u = [uri]$url
      $parts = $u.AbsolutePath.Trim('/').Split('/')
      $projIdx = [array]::IndexOf($parts, 'Projects')
      if ($projIdx -ge 0 -and $projIdx -lt $parts.Length - 1) {
        ($parts[($projIdx + 1)..($parts.Length - 1)] -join '\')
      } else {
        $parts[-1]
      }
    }
    $dest = Join-Path $OutDir $rel
    $destDir = Split-Path $dest -Parent
    if (-not (Test-Path $destDir)) {
      New-Item -ItemType Directory -Force -Path $destDir | Out-Null
    }

    if ((Test-Path $dest) -and ((Get-Item $dest).Length -gt 0)) {
      Add-Content -Path $skipLog -Value $url
      return "SKIP|$rel"
    }

    # temp then rename for safer resume
    $tmp = "$dest.partial"
    if (Test-Path $tmp) { Remove-Item $tmp -Force }

    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $wc = New-Object System.Net.WebClient
    $wc.Headers.Add("User-Agent", "Mozilla/5.0 USGS-download-script")
    try {
      $wc.DownloadFile($url, $tmp)
    } finally {
      $wc.Dispose()
    }

    if (-not (Test-Path $tmp) -or ((Get-Item $tmp).Length -le 0)) {
      throw "Empty download"
    }
    Move-Item -Path $tmp -Destination $dest -Force
    Add-Content -Path $okLog -Value $url
    return "OK|$rel|$((Get-Item $dest).Length)"
  }
  catch {
    Add-Content -Path $failLog -Value "$url`t$($_.Exception.Message)"
    return "FAIL|$url|$($_.Exception.Message)"
  }
}

$jobs = @()
$i = 0
$ok = 0; $fail = 0; $skip = 0
$started = Get-Date

foreach ($url in $urls) {
  while ((@($jobs | Where-Object { $_.State -eq 'Running' })).Count -ge $Throttle) {
    Start-Sleep -Milliseconds 400
    foreach ($j in @($jobs | Where-Object { $_.State -ne 'Running' })) {
      $r = Receive-Job $j -ErrorAction SilentlyContinue
      if ($r -like 'OK|*') { $ok++ }
      elseif ($r -like 'SKIP|*') { $skip++ }
      else { $fail++ }
      Remove-Job $j -Force -ErrorAction SilentlyContinue
      $jobs = @($jobs | Where-Object { $_.Id -ne $j.Id })
    }
  }

  $i++
  $jobs += Start-Job -ScriptBlock $scriptBlock -ArgumentList $url, $OutDir, $okLog, $failLog, $skipLog

  if ($i % 25 -eq 0 -or $i -eq $total) {
    $msg = "[{0}/{1}] ok={2} skip={3} fail={4} running={5} elapsed={6:n1}m" -f `
      $i, $total, $ok, $skip, $fail, (@($jobs | Where-Object State -eq 'Running').Count), `
      ((Get-Date) - $started).TotalMinutes
    Write-Host $msg
    Add-Content -Path $progressLog -Value "$(Get-Date -Format o) $msg"
  }
}

# drain remaining
while (@($jobs | Where-Object { $_.State -eq 'Running' }).Count -gt 0) {
  Start-Sleep -Seconds 1
}
foreach ($j in $jobs) {
  $r = Receive-Job $j -ErrorAction SilentlyContinue
  if ($r -like 'OK|*') { $ok++ }
  elseif ($r -like 'SKIP|*') { $skip++ }
  else { $fail++ }
  Remove-Job $j -Force -ErrorAction SilentlyContinue
}

$summary = "DONE total=$total ok=$ok skip=$skip fail=$fail out=$OutDir"
Write-Host $summary
Add-Content -Path $progressLog -Value "$(Get-Date -Format o) $summary"
