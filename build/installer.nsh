; On a real uninstall (not the uninstall step of an update), tell SolarClient
; online this install is gone so the player stops showing as offline. Only the
; random install id the launcher wrote to its data folder is sent.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    nsExec::Exec `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -Command "foreach ($$d in @('nebulaclient','solarclient')) { $$f = Join-Path $$env:APPDATA (Join-Path $$d 'install-id'); if (Test-Path $$f) { try { Invoke-RestMethod -Method Post -Uri 'http://api.figgysmp.shop:8090/install/gone' -ContentType 'text/plain' -Body ((Get-Content -Raw $$f).Trim()) -TimeoutSec 5 | Out-Null } catch {} } }"`
    Pop $0
  ${endIf}
!macroend
