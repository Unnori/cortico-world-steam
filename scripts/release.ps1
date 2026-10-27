# 发布 cortico-world-steam
#
# 用法(在扩展包目录下):
#   .\scripts\release.ps1                 # 检查 + 打包,不发布
#   .\scripts\release.ps1 -Publish        # 全流程:检查 → 打包 → 发布到 npmjs
#   .\scripts\release.ps1 -Publish -Push  # 再加 git 提交与推送
#   .\scripts\release.ps1 -Version 1.0.2  # 顺带改版本号
#   .\scripts\release.ps1 -SkipChecks     # 跳过测试与检查(不推荐)
#
# 为什么发布必须显式指定 registry:本机默认 registry 是 npmmirror,
# 那是只读镜像,发不上去。脚本里固定用 npmjs。

[CmdletBinding()]
param(
  [switch]$Publish,
  [switch]$Push,
  [switch]$SkipChecks,
  [string]$Version,
  [string]$RepoRoot
)

$ErrorActionPreference = 'Stop'
$NPMJS = 'https://registry.npmjs.org'

function Step($n, $msg) { Write-Host "`n=== [$n] $msg ===" -ForegroundColor Cyan }
function Ok($msg) { Write-Host "  OK  $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "  --  $msg" -ForegroundColor Yellow }
function Die($msg) { Write-Host "  FAIL  $msg" -ForegroundColor Red; exit 1 }

# 跑原生命令:临时松开 ErrorActionPreference。
# npm/tsc/git 都会往 stderr 写正常进度,合并输出在 Stop 下会被当成错误而终止脚本。
function Invoke-Native {
  param([string]$Exe, [string[]]$Arguments)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = & $Exe @Arguments 2>&1
    return [pscustomobject]@{ Code = $LASTEXITCODE; Output = @($output) }
  } finally { $ErrorActionPreference = $prev }
}

$PkgDir = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $PkgDir 'package.json'))) { $PkgDir = $PSScriptRoot }

function Read-Pkg {
  return (Get-Content (Join-Path $PkgDir 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json)
}

Step 1 'Read package info'
$pkg = Read-Pkg
$name = $pkg.name
$current = $pkg.version
Ok "$name@$current"

if ($Version -and $Version -ne $current) {
  Write-Host "  bump version $current -> $Version"
  $file = Join-Path $PkgDir 'package.json'
  $raw = [System.IO.File]::ReadAllText($file)
  $re = [regex]'("version"\s*:\s*")[^"]*(")'
  $raw = $re.Replace($raw, '${1}' + $Version + '${2}', 1)
  [System.IO.File]::WriteAllText($file, $raw, (New-Object System.Text.UTF8Encoding($false)))
  $pkg = Read-Pkg
  Ok "version is now $($pkg.version)"
}
$version = $pkg.version

if (-not $SkipChecks) {
  Step 2 'Local checks (typecheck + tests)'
  $tsc = Join-Path $PkgDir 'node_modules\.bin\tsc.cmd'
  $vitest = Join-Path $PkgDir 'node_modules\.bin\vitest.cmd'
  if (Test-Path $tsc) {
    Push-Location $PkgDir
    $r = Invoke-Native $tsc @('--noEmit')
    Pop-Location
    if ($r.Code -ne 0) { $r.Output | Select-Object -Last 10; Die 'typecheck failed' }
    Ok 'typecheck'
  } else { Warn 'no typescript installed, skipped' }
  if (Test-Path $vitest) {
    Push-Location $PkgDir
    $r = Invoke-Native $vitest @('run', '--reporter=dot')
    Pop-Location
    $r.Output | Select-Object -Last 3
    if ($r.Code -ne 0) { Die 'tests failed' }
    Ok 'tests'
  } else { Warn 'no vitest installed, skipped' }

  Step 3 'Sync describe.json and run the official extension check'
  if (-not $RepoRoot) {
    $probe = $PkgDir
    $found = $null
    while ($probe) {
      foreach ($cand in @((Join-Path $probe 'Coopanion\vendor\cortico'), (Join-Path $probe 'vendor\cortico'))) {
        if (Test-Path (Join-Path $cand 'scripts\extension-check.ts')) { $found = $cand; break }
      }
      if ($found) { break }
      $parent = Split-Path -Parent $probe
      if ($parent -eq $probe) { break }
      $probe = $parent
    }
    $RepoRoot = $found
  }
  if ($RepoRoot) {
    Push-Location $RepoRoot
    $tsx = Join-Path $RepoRoot 'node_modules\.bin\tsx.cmd'
    $r1 = Invoke-Native $tsx @('scripts\extension-describe.ts', $PkgDir)
    $r1.Output | Select-Object -Last 2
    $r2 = Invoke-Native $tsx @('scripts\extension-check.ts', $PkgDir)
    $r2.Output | Select-String 'Extension check'
    Pop-Location
    if ($r2.Code -ne 0) { Die 'extension-check failed' }
    Ok 'describe.json + extension-check'
  } else { Warn 'vendor\cortico not found; pass -RepoRoot to include the official check' }
}

Step 4 "Pack $name@$version"
Push-Location $PkgDir
Get-ChildItem *.tgz -ErrorAction SilentlyContinue | Remove-Item -Force
$r = Invoke-Native 'npm' @('pack')
$tgz = Get-ChildItem *.tgz -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $tgz) { Pop-Location; $r.Output | Select-Object -Last 15; Die 'npm pack produced no tgz' }
$listing = @(& tar -tzf $tgz.Name)
$count = $listing.Count
Ok "$($tgz.Name) - $count files - $([math]::Round($tgz.Length / 1KB, 1)) kB"
# 包里必须有的东西,缺了装到用户机器上就是缺文件
foreach ($need in @('package/package.json', 'package/src/index.ts', 'package/describe.json', 'package/CHANGELOG.md', 'package/src/webui/client.js')) {
  if (-not ($listing | Select-String -SimpleMatch $need)) { Pop-Location; Die "tarball is missing $need" }
}
Ok 'tarball listing verified'
Pop-Location

if (-not $Publish) {
  Write-Host "`nPacked only, nothing published. Add -Publish to publish." -ForegroundColor Yellow
  exit 0
}

Step 5 'Publish to npmjs'
$r = Invoke-Native 'npm' @('whoami', "--registry=$NPMJS")
if ($r.Code -ne 0) {
  Write-Host '  npm auth is not valid. Fix with:' -ForegroundColor Red
  Write-Host "    npm login --registry=$NPMJS" -ForegroundColor Yellow
  exit 1
}
Ok "logged in as $($r.Output | Select-Object -First 1)"

Push-Location $PkgDir
$r = Invoke-Native 'npm' @('publish', "--registry=$NPMJS", '--access', 'public')
Pop-Location
if ($r.Code -ne 0) { $r.Output | Select-Object -Last 12; Die 'npm publish failed (see the npm error above)' }
Ok "published $name@$version"

if ($Push) {
  Step 6 'Commit and push git'
  Push-Location $PkgDir
  $gitAdd = @('package.json', 'CHANGELOG.md', 'describe.json', 'src', 'tests', 'docs', 'README.md', 'scripts') |
    Where-Object { Test-Path (Join-Path $PkgDir $_) }
  $r = Invoke-Native 'git' (@('add', '--') + $gitAdd)
  if ($r.Code -ne 0) { Pop-Location; $r.Output; Die 'git add failed' }
  $r = Invoke-Native 'git' @('commit', '-m', "release: $version")
  if ($r.Code -ne 0) { Pop-Location; $r.Output; Die 'git commit failed' }
  $r = Invoke-Native 'git' @('push', 'origin', 'HEAD')
  Pop-Location
  if ($r.Code -ne 0) { $r.Output; Die 'git push failed' }
  Ok 'pushed'
}

Write-Host "`nDone: $name@$version" -ForegroundColor Green
if (-not $Push) { Write-Host 'Note: not committed to git yet. Add -Push to do that too.' -ForegroundColor Yellow }