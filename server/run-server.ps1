# Boucle du serveur adlane (lancee par run-server.cmd, tache planifiee "adlane-serveur") : met le code a jour,
# reconstruit, lance le serveur ; s'il s'arrete (mise a jour du code, plantage), on recommence.
# PowerShell lit tout ce fichier avant de l'executer : la mise a jour du code peut le remplacer sans le casser
# (cmd.exe, lui, relit un .cmd au fil de l'eau et deraillait quand git le reecrivait pendant qu'il tournait).
$ErrorActionPreference = 'Continue'
$Repo = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $env:USERPROFILE 'adlane-server\logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$Console = Join-Path $LogDir 'console.log'
function Note($t) { Add-Content -Path $Console -Value ("{0} {1}" -f (Get-Date -Format s), $t) -Encoding UTF8 }

# Une seule boucle a la fois (demarrage de session + relance manuelle) : la seconde s'arrete aussitot.
$created = $false
$mutex = New-Object System.Threading.Mutex($true, 'Global\adlane-serveur', [ref]$created)
if (-not $created) { Note 'Deja en marche : cette copie s arrete.'; exit }

Set-Location $Repo
while ($true) {
  Note 'Mise a jour du code'
  git fetch --depth 1 origin main 2>&1 | Out-File -Append -Encoding utf8 $Console
  git reset --hard origin/main 2>&1 | Out-File -Append -Encoding utf8 $Console
  Push-Location (Join-Path $Repo 'server')
  & npm.cmd install --no-audit --no-fund --silent 2>&1 | Out-File -Append -Encoding utf8 $Console
  & node build.mjs 2>&1 | Out-File -Append -Encoding utf8 $Console
  Pop-Location
  Note 'Demarrage du serveur'
  # Sorties brutes du serveur dans leurs propres fichiers (UTF-8 intact) ; son journal lisible reste serveur-AAAA-MM-JJ.log.
  $p = Start-Process -FilePath 'node' -ArgumentList '--no-warnings', "`"$(Join-Path $Repo 'server\dist\server.js')`"" -NoNewWindow -Wait -PassThru `
    -RedirectStandardOutput (Join-Path $LogDir 'node-sortie.log') -RedirectStandardError (Join-Path $LogDir 'node-erreurs.log')
  Note "Serveur arrete (code $($p.ExitCode)), relance dans 15 s"
  Start-Sleep -Seconds 15
}
