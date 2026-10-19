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

Set-Location $Repo
while ($true) {
  Note 'Mise a jour du code'
  git fetch --depth 1 origin main *>> $Console
  git reset --hard origin/main *>> $Console
  Push-Location (Join-Path $Repo 'server')
  & npm.cmd install --no-audit --no-fund --silent *>> $Console
  & node build.mjs *>> $Console
  Pop-Location
  Note 'Demarrage du serveur'
  & node --no-warnings (Join-Path $Repo 'server\dist\server.js') *>> $Console
  Note "Serveur arrete (code $LASTEXITCODE), relance dans 15 s"
  Start-Sleep -Seconds 15
}
