# Fenêtre « adlane serveur » (icône du bureau) : état du serveur, dernières lignes du journal, sauvegardes locales.
$Host.UI.RawUI.WindowTitle = 'adlane serveur'
$Repo = Split-Path -Parent $PSScriptRoot
$ServerDir = Join-Path $env:USERPROFILE 'adlane-server'
$Backups = Join-Path $ServerDir 'sauvegardes'
$Logs = Join-Path $ServerDir 'logs'
$Server = Join-Path $Repo 'server\dist\server.js'

function Show-State {
  Clear-Host
  Write-Host '=== adlane · serveur PC ===' -ForegroundColor Cyan
  $task = Get-ScheduledTask -TaskName 'adlane-serveur' -ErrorAction SilentlyContinue
  if (-not $task) { Write-Host 'Tâche « adlane-serveur » absente : relance l''installation (server\bootstrap.ps1).' -ForegroundColor Red }
  elseif ($task.State -eq 'Running') { Write-Host 'Serveur : EN MARCHE' -ForegroundColor Green }
  else { Write-Host "Serveur : ARRÊTÉ ($($task.State))" -ForegroundColor Yellow }
  $log = Get-ChildItem $Logs -Filter 'serveur-*.log' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime | Select-Object -Last 1
  if ($log) {
    $age = [int]((Get-Date) - $log.LastWriteTime).TotalMinutes
    Write-Host "Dernière activité : il y a $age min"
    Write-Host "`n--- Journal (dernières lignes) ---" -ForegroundColor DarkGray
    Get-Content $log.FullName -Tail 12 -Encoding UTF8 | ForEach-Object { Write-Host $_ }
  }
  $last = Get-ChildItem $Backups -Filter 'adlane-*' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime | Select-Object -Last 1
  $count = @(Get-ChildItem $Backups -Filter 'adlane-*' -ErrorAction SilentlyContinue).Count
  Write-Host "`n--- Sauvegardes sur ce PC ($count, 30 jours gardés) ---" -ForegroundColor DarkGray
  if ($last) { Write-Host "Dernière : $($last.Name) ($([math]::Round($last.Length / 1MB, 1)) Mo)" } else { Write-Host 'Aucune pour l''instant.' }
}

while ($true) {
  Show-State
  Write-Host "`n[1] Relancer le serveur   [2] Sauvegarder maintenant   [3] Ouvrir les sauvegardes   [4] Ouvrir le journal   [Entrée] Actualiser   [Q] Quitter"
  $c = Read-Host 'Choix'
  switch ($c.ToUpper()) {
    '1' { Stop-ScheduledTask -TaskName 'adlane-serveur' -ErrorAction SilentlyContinue; Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*server.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; Start-ScheduledTask -TaskName 'adlane-serveur'; Start-Sleep 3 }
    '2' { Write-Host 'Sauvegarde en cours…'; node --no-warnings $Server --backup-now | Select-Object -Last 1; Start-Sleep 2 }
    '3' { New-Item -ItemType Directory -Force -Path $Backups | Out-Null; Start-Process explorer.exe $Backups }
    '4' { Start-Process explorer.exe $Logs }
    'Q' { exit }
  }
}
