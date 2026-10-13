@echo off
setlocal EnableExtensions EnableDelayedExpansion
rem SolarClient update helper — log: %TEMP%\solar-update-helper.log
rem Args: 1=installer 2=parentPid 3=LocalAppData 4=preferredLaunch

set "INSTALLER=%~1"
set "PARENT=%~2"
set "LAD=%~3"
if "%LAD%"=="" set "LAD=%LOCALAPPDATA%"
set "PREFERRED=%~4"
set "LOG=%TEMP%\solar-update-helper.log"
set "INSTDIR=%LAD%\Programs\SolarClient"
set "DESKTOP=%USERPROFILE%\Desktop"

echo [%DATE% %TIME%] START installer=%INSTALLER% parent=%PARENT% > "%LOG%"

rem --- wait for launcher to exit ---
if "%PARENT%"=="" goto :kill
if "%PARENT%"=="0" goto :kill
set /a _waits=0
:waitloop
tasklist /FI "PID eq %PARENT%" 2>nul | findstr /I "%PARENT%" >nul
if errorlevel 1 goto :kill
set /a _waits+=1
if !_waits! GEQ 90 goto :kill
timeout /t 1 /nobreak >nul
goto :waitloop

:kill
echo [%DATE% %TIME%] kill SolarClient >> "%LOG%"
taskkill /F /IM SolarClient.exe /T >nul 2>&1
taskkill /F /IM "Solar Client.exe" /T >nul 2>&1
taskkill /F /IM NebulaClient.exe /T >nul 2>&1
taskkill /F /IM "Uninstall SolarClient.exe" /T >nul 2>&1
timeout /t 2 /nobreak >nul

rem --- wipe every known install tree ---
call :wipe "%LAD%\Programs\SolarClient"
call :wipe "%LAD%\Programs\solarclient"
call :wipe "%LAD%\SolarClient"
call :wipe "%LAD%\solarclient"
call :wipe "%LAD%\Programs\NebulaClient"
call :wipe "%LAD%\NebulaClient"
call :wipe "%LAD%\solarclient-updater"
call :wipe "%ProgramFiles%\SolarClient"
call :wipe "%ProgramFiles(x86)%\SolarClient"

rem Scan Programs for any solar/nebula folder
for /d %%D in ("%LAD%\Programs\*solar*") do call :wipe "%%~fD"
for /d %%D in ("%LAD%\Programs\*Solar*") do call :wipe "%%~fD"
for /d %%D in ("%LAD%\Programs\*nebula*") do call :wipe "%%~fD"
for /d %%D in ("%LAD%\Programs\*Nebula*") do call :wipe "%%~fD"

rem --- delete old Setup exes on Desktop / Downloads / TEMP (keep current installer) ---
call :rmoldsetup "%TEMP%"
call :rmoldsetup "%DESKTOP%"
call :rmoldsetup "%USERPROFILE%\Downloads"
call :rmoldsetup "%USERPROFILE%\Desktop"

rem Remove stale desktop launchers (will recreate SolarClient.lnk)
del /f /q "%DESKTOP%\SolarClient.lnk" >nul 2>&1
del /f /q "%DESKTOP%\NebulaClient.lnk" >nul 2>&1
del /f /q "%DESKTOP%\Play SolarClient.bat" >nul 2>&1
del /f /q "%DESKTOP%\PlaySolar.vbs" >nul 2>&1
del /f /q "%DESKTOP%\SolarClient.exe" >nul 2>&1

taskkill /F /IM SolarClient.exe /T >nul 2>&1
timeout /t 1 /nobreak >nul

if not exist "%INSTALLER%" (
  echo [%DATE% %TIME%] FAIL missing installer >> "%LOG%"
  goto :eof
)

echo [%DATE% %TIME%] INSTALL /S /D=%INSTDIR% >> "%LOG%"
start /wait "" "%INSTALLER%" /S /D=%INSTDIR%
echo [%DATE% %TIME%] installer finished errorlevel=%ERRORLEVEL% >> "%LOG%"

timeout /t 3 /nobreak >nul
taskkill /F /IM SolarClient.exe /T >nul 2>&1
timeout /t 1 /nobreak >nul

rem post-clean squirrel leftovers (not the Programs install)
call :wipe "%LAD%\SolarClient"
call :wipe "%LAD%\solarclient"

rem find launch exe
set "LAUNCH="
if exist "%INSTDIR%\SolarClient.exe" set "LAUNCH=%INSTDIR%\SolarClient.exe"
if not defined LAUNCH if exist "%LAD%\Programs\solarclient\SolarClient.exe" set "LAUNCH=%LAD%\Programs\solarclient\SolarClient.exe"
if not defined LAUNCH if exist "%PREFERRED%" set "LAUNCH=%PREFERRED%"

if not defined LAUNCH (
  echo [%DATE% %TIME%] FAIL no SolarClient.exe >> "%LOG%"
  goto :cleanup
)

rem --- Desktop shortcut pointing at the new exe ---
set "VBS=%TEMP%\solar-desktop-shortcut.vbs"
> "%VBS%" echo Set oWS = CreateObject("WScript.Shell")
>> "%VBS%" echo sLink = oWS.SpecialFolders("Desktop") ^& "\SolarClient.lnk"
>> "%VBS%" echo Set oLink = oWS.CreateShortcut(sLink)
>> "%VBS%" echo oLink.TargetPath = "%LAUNCH%"
>> "%VBS%" echo oLink.WorkingDirectory = "%INSTDIR%"
>> "%VBS%" echo oLink.Description = "SolarClient"
>> "%VBS%" echo oLink.IconLocation = "%LAUNCH%,0"
>> "%VBS%" echo oLink.Save
cscript //nologo "%VBS%" >nul 2>&1
del /f /q "%VBS%" >nul 2>&1
echo [%DATE% %TIME%] desktop shortcut created >> "%LOG%"

rem Also drop a copy-style pointer: if user expects an .exe on Desktop, give them the shortcut name they click
echo [%DATE% %TIME%] RELAUNCH %LAUNCH% >> "%LOG%"
start "" "%LAUNCH%"

:cleanup
del /f /q "%INSTALLER%" >nul 2>&1
call :rmoldsetup "%TEMP%"
call :rmoldsetup "%DESKTOP%"
call :rmoldsetup "%USERPROFILE%\Downloads"
echo [%DATE% %TIME%] DONE >> "%LOG%"
exit /b 0

:wipe
if "%~1"=="" goto :eof
if not exist "%~1" goto :eof
echo [%DATE% %TIME%] WIPE %~1 >> "%LOG%"
taskkill /F /IM SolarClient.exe /T >nul 2>&1
rmdir /s /q "%~1" >nul 2>&1
if exist "%~1" (
  timeout /t 1 /nobreak >nul
  rmdir /s /q "%~1" >nul 2>&1
)
goto :eof

:rmoldsetup
if "%~1"=="" goto :eof
if not exist "%~1" goto :eof
for %%F in ("%~1\SolarClient-Setup-*.exe") do (
  if /I not "%%~fF"=="%INSTALLER%" (
    echo [%DATE% %TIME%] rm setup %%~fF >> "%LOG%"
    del /f /q "%%~fF" >nul 2>&1
  )
)
for %%F in ("%~1\SolarClient-Update-*.exe") do del /f /q "%%~fF" >nul 2>&1
goto :eof
