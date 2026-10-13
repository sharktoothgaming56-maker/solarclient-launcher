# SolarClient update helper (ASCII only - Windows PowerShell 5.x)
# Log: %TEMP%\solar-update-helper.log
#
# Smooth path:
#  1) Wait for launcher exit
#  2) Kill SolarClient tasks
#  3) Copy Setup to a private path (avoids AVG locking the download)
#  4) Run Setup OVER the same install folder (no wipe-first)
#  5) Retarget SolarClient.lnk in place (never delete it)
#  6) Relaunch once
param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [int]$ParentPid = 0,
  [string]$PreferredLaunch = '',
  [string]$LocalAppData = $env:LOCALAPPDATA,
  [string]$Version = '',
  [string]$WindowScript = '',
  [string]$IconPath = '',
  [int]$CenterX = 0,
  [int]$CenterY = 0
)

$ErrorActionPreference = 'Continue'
$log = Join-Path $env:TEMP 'solar-update-helper.log'
function Log([string]$m) {
  try {
    Add-Content -LiteralPath $log -Value ("[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) -ErrorAction SilentlyContinue
  } catch {}
}
try {
  Set-Content -LiteralPath $log -Value ("[{0}] START installer={1} parent={2} preferred={3}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Installer, $ParentPid, $PreferredLaunch) -ErrorAction SilentlyContinue
} catch {}

function Get-DesktopDirs {
  $dirs = New-Object System.Collections.Generic.List[string]
  $add = {
    param($p)
    if ($p -and (Test-Path -LiteralPath $p)) {
      $full = [System.IO.Path]::GetFullPath($p)
      if (-not ($dirs -contains $full)) { [void]$dirs.Add($full) }
    }
  }
  try { & $add ([Environment]::GetFolderPath('Desktop')) } catch {}
  try { & $add ([Environment]::GetFolderPath('CommonDesktopDirectory')) } catch {}
  & $add (Join-Path $env:USERPROFILE 'Desktop')
  & $add (Join-Path $env:USERPROFILE 'OneDrive\Desktop')
  & $add (Join-Path $env:USERPROFILE 'OneDrive - Personal\Desktop')
  Get-ChildItem -LiteralPath $env:USERPROFILE -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like 'OneDrive*' } |
    ForEach-Object { & $add (Join-Path $_.FullName 'Desktop') }
  return @($dirs)
}

function Get-PrimaryDesktop {
  try {
    $shell = [Environment]::GetFolderPath('Desktop')
    if ($shell -and (Test-Path -LiteralPath $shell)) {
      return [System.IO.Path]::GetFullPath($shell)
    }
  } catch {}
  foreach ($c in @(
    (Join-Path $env:USERPROFILE 'OneDrive\Desktop'),
    (Join-Path $env:USERPROFILE 'OneDrive - Personal\Desktop'),
    (Join-Path $env:USERPROFILE 'Desktop')
  )) {
    if ($c -and (Test-Path -LiteralPath $c)) { return [System.IO.Path]::GetFullPath($c) }
  }
  return [System.IO.Path]::GetFullPath((Join-Path $env:USERPROFILE 'Desktop'))
}

# Small progress window while the launcher is closed (installer runs silently).
$statusFile = Join-Path $env:TEMP 'solar-update-status.txt'
function Set-Status([string]$pct, [string]$text) {
  try { Set-Content -LiteralPath $statusFile -Value ($pct + '|' + $text) -ErrorAction SilentlyContinue } catch {}
}
function Start-ProgressWindow {
  $verText = if ($Version) { 'v' + $Version } else { 'the latest version' }
  # New launchers ship solar-update-window.ps1: a normal SolarClient window
  # (not topmost, draggable, minimizable). The inline form below is only a
  # fallback if that file is missing.
  if ($WindowScript -and (Test-Path -LiteralPath $WindowScript)) {
    try {
      Set-Status '5' 'Closing SolarClient...'
      $argStr = '-NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $WindowScript + '" -StatusFile "' + $statusFile + '" -VerText "' + $verText + '" -IconPath "' + $IconPath + '" -CenterX ' + $CenterX + ' -CenterY ' + $CenterY
      Start-Process -FilePath 'powershell.exe' -ArgumentList $argStr -WindowStyle Hidden | Out-Null
      Log 'app-style progress window started'
      return
    } catch {
      Log ("app-style window fail: " + $_.Exception.Message)
    }
  }
  $formPs = Join-Path $env:TEMP 'solar-update-window-basic.ps1'
  $body = @'
param([string]$StatusFile, [string]$VerText)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$f = New-Object System.Windows.Forms.Form
$f.Text = 'SolarClient Update'
$f.FormBorderStyle = 'FixedSingle'
$f.MaximizeBox = $false
$f.StartPosition = 'CenterScreen'
$f.Size = New-Object System.Drawing.Size(456, 186)
$f.BackColor = [System.Drawing.Color]::FromArgb(18, 20, 28)
$f.TopMost = $false
$f.ShowInTaskbar = $true
$t = New-Object System.Windows.Forms.Label
$t.Text = 'Updating SolarClient to ' + $VerText
$t.ForeColor = [System.Drawing.Color]::White
$t.Font = New-Object System.Drawing.Font('Segoe UI', 13, [System.Drawing.FontStyle]::Bold)
$t.AutoSize = $false
$t.Size = New-Object System.Drawing.Size(400, 30)
$t.Location = New-Object System.Drawing.Point(20, 18)
$f.Controls.Add($t)
$s = New-Object System.Windows.Forms.Label
$s.Text = 'Preparing...'
$s.ForeColor = [System.Drawing.Color]::FromArgb(180, 190, 210)
$s.Font = New-Object System.Drawing.Font('Segoe UI', 10)
$s.AutoSize = $false
$s.Size = New-Object System.Drawing.Size(400, 22)
$s.Location = New-Object System.Drawing.Point(20, 54)
$f.Controls.Add($s)
$b = New-Object System.Windows.Forms.ProgressBar
$b.Style = 'Continuous'
$b.Minimum = 0
$b.Maximum = 100
$b.Value = 5
$b.Size = New-Object System.Drawing.Size(400, 14)
$b.Location = New-Object System.Drawing.Point(20, 88)
$f.Controls.Add($b)
$e = New-Object System.Windows.Forms.Label
$e.ForeColor = [System.Drawing.Color]::FromArgb(130, 140, 160)
$e.Font = New-Object System.Drawing.Font('Segoe UI', 9)
$e.AutoSize = $false
$e.Size = New-Object System.Drawing.Size(400, 20)
$e.Location = New-Object System.Drawing.Point(20, 110)
$f.Controls.Add($e)
$start = Get-Date
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 300
$timer.Add_Tick({
  $el = [int]((Get-Date) - $start).TotalSeconds
  $e.Text = ('Elapsed ' + $el + 's - SolarClient will reopen automatically')
  try {
    if (Test-Path -LiteralPath $StatusFile) {
      $raw = (Get-Content -LiteralPath $StatusFile -Raw -ErrorAction Stop).Trim()
      $parts = $raw.Split('|', 2)
      if ($parts[0] -eq 'done') { $timer.Stop(); $f.Close(); return }
      $p = 0
      if ([int]::TryParse($parts[0], [ref]$p)) {
        if ($p -gt $b.Value) { $b.Value = [Math]::Min(100, $p) }
        elseif ($b.Value -lt $p + 8 -and $b.Value -lt 97) { $b.Value = $b.Value + 1 }
      }
      if ($parts.Length -gt 1) { $s.Text = $parts[1] }
    }
  } catch {}
  if ($el -gt 300) { $timer.Stop(); $f.Close() }
})
$f.Add_Shown({ $timer.Start() })
[void]$f.ShowDialog()
'@
  try {
    Set-Content -LiteralPath $formPs -Value $body -Encoding ASCII -ErrorAction Stop
    Set-Status '5' 'Closing SolarClient...'
    $argStr = '-NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $formPs + '" -StatusFile "' + $statusFile + '" -VerText "' + $verText + '"'
    Start-Process -FilePath 'powershell.exe' -ArgumentList $argStr -WindowStyle Hidden | Out-Null
    Log 'progress window started'
  } catch {
    Log ("progress window fail: " + $_.Exception.Message)
  }
}
Start-ProgressWindow

if ($ParentPid -gt 0) {
  $deadline = (Get-Date).AddSeconds(120)
  while ((Get-Date) -lt $deadline) {
    try { Get-Process -Id $ParentPid -ErrorAction Stop | Out-Null; Start-Sleep -Milliseconds 250 }
    catch { break }
  }
  Log 'parent gone (or timed out)'
}

function Kill-AllSolar {
  Log 'Kill-AllSolar'
  cmd.exe /c 'taskkill /F /IM SolarClient.exe >nul 2>&1'
  cmd.exe /c 'taskkill /F /IM "Solar Client.exe" >nul 2>&1'
  cmd.exe /c 'taskkill /F /IM NebulaClient.exe >nul 2>&1'
  Start-Sleep -Milliseconds 400
}

function Unlock-InstallFolder([string]$dir) {
  if (-not $dir) { return }
  Kill-AllSolar
  $parent = Split-Path $dir -Parent
  $leaf = Split-Path $dir -Leaf
  $away = Join-Path $parent ($leaf + '-old-locked')
  if (Test-Path -LiteralPath $dir) {
    if (Test-Path -LiteralPath $away) {
      cmd.exe /c ("rmdir /S /Q `"" + $away + "`" >nul 2>&1")
    }
    try {
      Rename-Item -LiteralPath $dir -NewName ($leaf + '-old-locked') -Force -ErrorAction Stop
      Log ("renamed locked " + $dir + " -> " + $away)
      New-Item -ItemType Directory -Force -Path $dir -ErrorAction SilentlyContinue | Out-Null
      return
    } catch {
      Log ("rename failed: " + $_.Exception.Message)
    }
  }
}

function Remove-Tree([string]$p) {
  if (-not $p -or -not (Test-Path -LiteralPath $p)) { return }
  Log ("WIPE " + $p)
  for ($i = 0; $i -lt 4; $i++) {
    Kill-AllSolar
    cmd.exe /c ("rmdir /S /Q `"" + $p + "`" >nul 2>&1")
    if (-not (Test-Path -LiteralPath $p)) { return }
    try { Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction Stop; return } catch {}
    Start-Sleep -Milliseconds 400
  }
}

function Resolve-CanonicalInstallDir {
  if ($PreferredLaunch -and (Test-Path -LiteralPath $PreferredLaunch)) {
    $dir = Split-Path $PreferredLaunch -Parent
    $leaf = Split-Path $dir -Leaf
    if ($leaf -match '(?i)^SolarClient(-fresh)?$|^solarclient$|^NebulaClient$') {
      if ($leaf -match '(?i)fresh|old-locked') {
        return [System.IO.Path]::GetFullPath((Join-Path $LocalAppData 'Programs\SolarClient'))
      }
      return [System.IO.Path]::GetFullPath($dir)
    }
  }
  # Prefer existing Programs\SolarClient or solarclient if present
  foreach ($name in @('SolarClient', 'solarclient')) {
    $c = Join-Path $LocalAppData (Join-Path 'Programs' $name)
    if (Test-Path -LiteralPath (Join-Path $c 'SolarClient.exe')) {
      return [System.IO.Path]::GetFullPath($c)
    }
  }
  return [System.IO.Path]::GetFullPath((Join-Path $LocalAppData 'Programs\SolarClient'))
}

function Update-ShortcutInPlace([string]$lnkPath, [string]$targetExe) {
  if (-not $targetExe -or -not (Test-Path -LiteralPath $targetExe)) { return $false }
  try {
    $w = New-Object -ComObject WScript.Shell
    $s = $w.CreateShortcut($lnkPath)
    $s.TargetPath = $targetExe
    $s.WorkingDirectory = (Split-Path $targetExe -Parent)
    $s.Description = 'SolarClient'
    # Force Windows to re-read icon index 0 from the new exe (same pin/slot kept).
    $s.IconLocation = ($targetExe + ',0')
    $s.Save()
    Log ("shortcut UPDATE in place " + $lnkPath + " -> " + $targetExe)
    return $true
  } catch {
    Log ("shortcut fail " + $lnkPath + " : " + $_.Exception.Message)
    return $false
  }
}

function Update-TaskbarPinsInPlace([string]$targetExe) {
  # Retarget pinned taskbar .lnk files in place - NEVER delete them (that unpins).
  if (-not $targetExe -or -not (Test-Path -LiteralPath $targetExe)) { return }
  $pinDir = Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar'
  if (-not (Test-Path -LiteralPath $pinDir)) { return }
  Get-ChildItem -LiteralPath $pinDir -Filter '*.lnk' -Force -ErrorAction SilentlyContinue | ForEach-Object {
    try {
      $w = New-Object -ComObject WScript.Shell
      $s = $w.CreateShortcut($_.FullName)
      $tp = [string]$s.TargetPath
      $name = $_.Name
      if ($tp -match '(?i)SolarClient\.exe$' -or $name -match '(?i)SolarClient') {
        [void](Update-ShortcutInPlace $_.FullName $targetExe)
      }
    } catch {
      Log ("taskbar pin skip " + $_.FullName + " : " + $_.Exception.Message)
    }
  }
}

function Refresh-ShellIcons {
  # Flush icon cache so taskbar/desktop pick up the new exe icon without unpinning.
  try {
    cmd.exe /c 'ie4uinit.exe -show >nul 2>&1'
    Log 'ie4uinit -show'
  } catch {}
  try {
    # SHCNE_ASSOCCHANGED = 0x08000000 - tell Explorer icons changed
    $sig = @'
using System;
using System.Runtime.InteropServices;
public static class Native {
  [DllImport("shell32.dll")] public static extern void SHChangeNotify(int wEventId, uint uFlags, IntPtr dwItem1, IntPtr dwItem2);
}
'@
    Add-Type -TypeDefinition $sig -ErrorAction SilentlyContinue
    [Native]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)
    Log 'SHChangeNotify ASSOCCHANGED'
  } catch {
    Log ("SHChangeNotify skip: " + $_.Exception.Message)
  }
}

function Write-DesktopShortcut([string]$targetExe) {
  if (-not $targetExe -or -not (Test-Path -LiteralPath $targetExe)) {
    Log 'no target for desktop shortcut'
    return
  }
  # NEVER delete SolarClient.lnk - only retarget. Deleting removes the icon from the desktop.
  $updated = $false
  foreach ($desk in (Get-DesktopDirs)) {
    $lnk = Join-Path $desk 'SolarClient.lnk'
    if (Test-Path -LiteralPath $lnk) {
      if (Update-ShortcutInPlace $lnk $targetExe) { $updated = $true }
    }
  }
  $startCandidates = @(
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\SolarClient.lnk'),
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\SolarClient\SolarClient.lnk')
  )
  foreach ($sm in $startCandidates) {
    if (Test-Path -LiteralPath $sm) { [void](Update-ShortcutInPlace $sm $targetExe) }
  }
  Update-TaskbarPinsInPlace $targetExe
  if (-not $updated) {
    $desk = Get-PrimaryDesktop
    $lnk = Join-Path $desk 'SolarClient.lnk'
    [void](Update-ShortcutInPlace $lnk $targetExe)
    Log ("desktop shortcut CREATE (first time) " + $lnk)
    $updated = $true
  }
  # Only after primary SolarClient.lnk is good: remove duplicate SolarClient (1).lnk etc.
  if ($updated) {
    foreach ($desk in (Get-DesktopDirs)) {
      Get-ChildItem -LiteralPath $desk -Force -ErrorAction SilentlyContinue |
        Where-Object { -not $_.PSIsContainer -and $_.Name -match '(?i)^SolarClient \(\d+\)\.lnk$' } |
        ForEach-Object {
          Log ("rm duplicate shortcut " + $_.FullName)
          Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue
        }
    }
  }
  Refresh-ShellIcons
}

function Test-DirWritable([string]$dir) {
  try {
    New-Item -ItemType Directory -Force -Path $dir -ErrorAction Stop | Out-Null
    $probe = Join-Path $dir ('.solar-write-' + [guid]::NewGuid().ToString('N'))
    Set-Content -LiteralPath $probe -Value 'ok' -ErrorAction Stop
    Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
    return $true
  } catch {
    Log ("not writable: " + $dir + " :: " + $_.Exception.Message)
    return $false
  }
}

# --- main ---
Kill-AllSolar
$installDir = Resolve-CanonicalInstallDir
Log ("canonical installDir=" + $installDir)

# Do NOT wipe the live install before Setup. Wipe-first + failed Setup = no app + missing shortcut.
# Only clear abandoned alternate folders.
foreach ($extra in @(
  (Join-Path $LocalAppData 'Programs\SolarClient-fresh'),
  (Join-Path $LocalAppData 'Programs\SolarClient-old-locked'),
  (Join-Path $LocalAppData 'solarclient-updater')
)) {
  if ($extra -and (Test-Path -LiteralPath $extra)) {
    $extraFull = [System.IO.Path]::GetFullPath($extra)
    $keepFull = [System.IO.Path]::GetFullPath($installDir)
    if ($extraFull -ne $keepFull) { Remove-Tree $extra }
  }
}

if (-not (Test-Path -LiteralPath $Installer)) {
  Log ("FAIL missing installer " + $Installer)
  Set-Status 'done' ''
  exit 1
}
Set-Status '15' 'Preparing installer...'

# Copy Setup to a private name so AVG CyberCapture cannot lock the download mid-extract.
$runSetup = Join-Path $env:TEMP ('SolarClient-Install-' + [guid]::NewGuid().ToString('N') + '.exe')
try {
  Copy-Item -LiteralPath $Installer -Destination $runSetup -Force -ErrorAction Stop
  Log ("setup copy " + $runSetup)
} catch {
  Log ("setup copy failed, using original: " + $_.Exception.Message)
  $runSetup = $Installer
}

New-Item -ItemType Directory -Force -Path $installDir -ErrorAction SilentlyContinue | Out-Null
if (-not (Test-DirWritable $installDir)) {
  Unlock-InstallFolder $installDir
  New-Item -ItemType Directory -Force -Path $installDir -ErrorAction SilentlyContinue | Out-Null
}

Kill-AllSolar
Set-Status '25' 'Installing update...'
Log ("INSTALL /S /D=" + $installDir)
$argLine = '/S /D=' + $installDir
$proc = Start-Process -FilePath $runSetup -ArgumentList $argLine -PassThru -WindowStyle Hidden
$timedOut = -not $proc.WaitForExit(180000)
if ($timedOut) {
  Log 'WARN installer timed out after 180s - killing Setup'
  try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {}
}
$code = 0
if (-not $timedOut -and $null -ne $proc) { $code = $proc.ExitCode }
Log ("installer exitCode=" + $code + " timedOut=" + $timedOut)
Set-Status '85' 'Finishing up...'

Start-Sleep -Seconds 2
Kill-AllSolar

# Cleanup private setup copy
if ($runSetup -ne $Installer) {
  try { Remove-Item -LiteralPath $runSetup -Force -ErrorAction SilentlyContinue } catch {}
}

$launch = Join-Path $installDir 'SolarClient.exe'
if (-not (Test-Path -LiteralPath $launch)) {
  foreach ($c in @(
    (Join-Path $LocalAppData 'Programs\SolarClient\SolarClient.exe'),
    (Join-Path $LocalAppData 'Programs\solarclient\SolarClient.exe')
  )) {
    if (Test-Path -LiteralPath $c) { $launch = $c; break }
  }
}

if (Test-Path -LiteralPath $launch) {
  try {
    $vi = (Get-Item -LiteralPath $launch).VersionInfo.FileVersion
    Log ("installed exe ver=" + $vi + " path=" + $launch)
  } catch {}
  Write-DesktopShortcut -targetExe $launch
  Set-Status '97' 'Reopening SolarClient...'
  Log ("RELAUNCH " + $launch)
  # Give the installer a moment to release file locks, then relaunch hard.
  Start-Sleep -Seconds 2
  cmd.exe /c 'taskkill /F /IM SolarClient.exe >nul 2>&1'
  Start-Sleep -Seconds 1
  cmd.exe /c ("start `"`" `"" + $launch + "`"")
  Start-Sleep -Seconds 3
  $alive = Get-Process -Name 'SolarClient' -ErrorAction SilentlyContinue
  if (-not $alive) {
    try {
      Start-Process -FilePath $launch -WorkingDirectory (Split-Path $launch -Parent) -WindowStyle Normal
      Start-Sleep -Seconds 2
    } catch {
      Log ("relaunch fail: " + $_.Exception.Message)
    }
  }
  $alive2 = Get-Process -Name 'SolarClient' -ErrorAction SilentlyContinue
  if (-not $alive2) {
    try {
      Start-Process -FilePath $launch -WorkingDirectory (Split-Path $launch -Parent)
      Log 'relaunch retry 2'
    } catch {
      Log ("relaunch fail2: " + $_.Exception.Message)
    }
  }
} else {
  Log 'FAIL no SolarClient.exe after install - shortcut left untouched'
}
Set-Status 'done' ''

try { Remove-Item -LiteralPath $Installer -Force -ErrorAction SilentlyContinue } catch {}
# Remove leftover Setup stubs from Desktop/Downloads only (not the live shortcut)
foreach ($desk in (Get-DesktopDirs)) {
  Get-ChildItem -LiteralPath $desk -Force -ErrorAction SilentlyContinue |
    Where-Object { -not $_.PSIsContainer -and $_.Name -match '(?i)^SolarClient-(Setup|Update|Install)-.*\.exe$' } |
    ForEach-Object {
      Log ("rm leftover setup " + $_.FullName)
      Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue
    }
}
Log 'DONE'
exit 0
