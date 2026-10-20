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
  # La tâche ne fait que lancer la boucle puis rend la main : l'état se lit sur les processus eux-mêmes.
  $running = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*server.js*' }).Count -gt 0
  if (-not $task) { Write-Host 'Tâche « adlane-serveur » absente : relance l''installation (server\bootstrap.ps1).' -ForegroundColor Red }
  if ($running) { Write-Host 'Serveur : EN MARCHE' -ForegroundColor Green }
  else {
    Write-Host 'Serveur : ARRÊTÉ' -ForegroundColor Yellow
    $console = Join-Path $Logs 'console.log'
    if (Test-Path $console) {
      Write-Host "`n--- Lanceur (console.log, dernières lignes) ---" -ForegroundColor DarkGray
      Get-Content $console -Tail 10 -Encoding UTF8 | ForEach-Object { Write-Host $_ }
    }
    $err = Join-Path $Logs 'node-erreurs.log'
    if ((Test-Path $err) -and (Get-Item $err).Length -gt 0) {
      Write-Host "`n--- Erreurs du serveur ---" -ForegroundColor DarkGray
      Get-Content $err -Tail 10 -Encoding UTF8 | ForEach-Object { Write-Host $_ }
    }
  }
  # Etat de la collecte (statut.json, réécrit à chaque relevé) : le journal, lui, reste silencieux quand rien ne change.
  $statutFile = Join-Path $ServerDir 'statut.json'
  if (Test-Path $statutFile) {
    try {
      $st = Get-Content $statutFile -Raw -Encoding UTF8 | ConvertFrom-Json
      # ConvertFrom-Json rend déjà des dates (Windows PowerShell) ; sinon le texte ISO est lu tel quel.
      $ago = { param($t) if ($t) { $d = if ($t -is [datetime]) { $t } else { [datetime]::Parse([string]$t, [cultureinfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind) }; [int]((Get-Date).ToUniversalTime() - $d.ToUniversalTime()).TotalSeconds } else { $null } }
      $c = & $ago $st.lastCollectAt
      $p = & $ago $st.lastPublishAt
      Write-Host ("Dernière collecte : " + $(if ($null -ne $c) { "il y a $c s" } else { 'aucune' }) + "  ·  $($st.liveMatches) match(s) en direct  ·  $($st.samplesSinceStart) relevé(s) depuis le démarrage")
      Write-Host ("Dernier envoi à l'app : " + $(if ($null -ne $p) { "il y a $p s" } else { 'aucun encore' }))
    } catch { Write-Host 'État de la collecte illisible.' }
  }
  $log = Get-ChildItem $Logs -Filter 'serveur-*.log' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime | Select-Object -Last 1
  if ($log) {
    Write-Host "`n--- Journal (dernières lignes ; il ne s'écrit que quand quelque chose change) ---" -ForegroundColor DarkGray
    Get-Content $log.FullName -Tail 8 -Encoding UTF8 | ForEach-Object { Write-Host $_ }
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
    '1' { Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*run-server*' -or ($_.Name -eq 'node.exe' -and $_.CommandLine -like '*server.js*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; Start-ScheduledTask -TaskName 'adlane-serveur'; Start-Sleep 5 }
    '2' { Write-Host 'Sauvegarde en cours…'; node --no-warnings $Server --backup-now | Select-Object -Last 1; Start-Sleep 2 }
    '3' { New-Item -ItemType Directory -Force -Path $Backups | Out-Null; Start-Process explorer.exe $Backups }
    '4' { Start-Process explorer.exe $Logs }
    'Q' { exit }
  }
}
