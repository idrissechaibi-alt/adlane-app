# Installation du serveur adlane sur un PC Windows, en une commande (PowerShell) :
#   irm https://raw.githubusercontent.com/idrissechaibi-alt/adlane-app/main/server/bootstrap.ps1 | iex
# 1. installe Git et Node.js si besoin ; 2. récupère le code ; 3. importe la configuration envoyée par le téléphone ;
# 4. crée la tâche planifiée « adlane-serveur » (démarre avec ta session Windows, relance automatique) ; 5. la lance ;
# 6. pose l'icône « adlane serveur » sur le bureau. Relançable sans risque (mise à jour de l'installation).
$ErrorActionPreference = 'Stop'
# Scripts PowerShell autorisés pour CETTE fenêtre seulement (npm.ps1 est sinon bloqué par la stratégie par défaut).
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
$Repo = Join-Path $env:USERPROFILE 'adlane-app'
$ServerDir = Join-Path $env:USERPROFILE 'adlane-server'

function Say($t) { Write-Host "`n== $t" -ForegroundColor Cyan }
function Have($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function RefreshPath { $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') }

Say 'Outils (Git, Node.js)'
if (-not (Have git)) { winget install --id Git.Git -e --accept-source-agreements --accept-package-agreements; RefreshPath }
if (-not (Have node)) { winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements; RefreshPath }
$major = [int]((node -v).TrimStart('v').Split('.')[0])
if ($major -lt 22) { throw "Node.js $((node -v)) trop ancien : il faut la version 22 ou plus (winget upgrade OpenJS.NodeJS.LTS)." }
Write-Host "Git : $((git --version))  ·  Node.js : $((node -v))"

Say 'Code de l''app'
if (Test-Path (Join-Path $Repo '.git')) {
  git -C $Repo fetch --depth 1 origin main; git -C $Repo reset --hard origin/main
} else {
  git clone --depth 1 https://github.com/idrissechaibi-alt/adlane-app.git $Repo
}
Push-Location (Join-Path $Repo 'server')
npm.cmd install --no-audit --no-fund --silent
node build.mjs
Pop-Location

Say 'Configuration (clés) envoyée par le téléphone'
New-Item -ItemType Directory -Force -Path $ServerDir | Out-Null
if (-not (Test-Path (Join-Path $ServerDir 'secrets.json'))) {
  Write-Host "Dans l'app : Paramètres > Sauvegarde & IA > « CONFIGURER LE SERVEUR PC » > Envoyer la configuration."
  Write-Host "Envoie-la toi (mail, Telegram…), copie le texte puis colle-le ici et appuie sur Entrée :"
  $cfg = Read-Host
  $tmp = Join-Path $ServerDir 'config-import.json'
  Set-Content -Path $tmp -Value $cfg -Encoding UTF8
  node --no-warnings (Join-Path $Repo 'server\dist\server.js') --import-config $tmp
  Remove-Item $tmp -Force
} else {
  Write-Host 'Configuration déjà présente (secrets.json) : rien à importer.'
}

Say 'Démarrage automatique'
$cmd = Join-Path $Repo 'server\run-server.cmd'
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$cmd`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -Hidden
Register-ScheduledTask -TaskName 'adlane-serveur' -Action $action -Trigger $trigger -Settings $settings -Description 'Serveur de l''app adlane (scans, bilans, rapports)' -Force | Out-Null
# PC branché : jamais de mise en veille, sinon le serveur s'arrête.
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
try { Start-ScheduledTask -TaskName 'adlane-serveur' } catch { }

Say 'Icône sur le bureau'
# Icône de l'app (assets/icon.png) convertie en .ico, raccourci « adlane serveur » vers la fenêtre d'état.
$ico = Join-Path $ServerDir 'adlane.ico'
try {
  Add-Type -AssemblyName System.Drawing
  $bmp = New-Object System.Drawing.Bitmap (Join-Path $Repo 'assets\icon.png')
  $small = New-Object System.Drawing.Bitmap $bmp, 256, 256
  $icon = [System.Drawing.Icon]::FromHandle($small.GetHicon())
  $fs = [System.IO.File]::Create($ico); $icon.Save($fs); $fs.Close()
} catch { $ico = $null }
$desktop = [Environment]::GetFolderPath('Desktop')
$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut((Join-Path $desktop 'adlane serveur.lnk'))
$lnk.TargetPath = 'powershell.exe'
$lnk.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $Repo 'server\etat.ps1')`""
$lnk.WorkingDirectory = $Repo
if ($ico) { $lnk.IconLocation = $ico }
$lnk.Description = 'État du serveur adlane, journal et sauvegardes'
$lnk.Save()
Write-Host "Raccourci créé : $desktop\adlane serveur.lnk"

Say 'Vérification'
$log = Join-Path $ServerDir ("logs\serveur-{0}.log" -f (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd'))
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Seconds 15
  if ((Test-Path $log) -and (Select-String -Path $log -Pattern 'Serveur d.marr' -Encoding UTF8 -Quiet)) { break }
}
if (Test-Path $log) { Get-Content $log -Tail 15 -Encoding UTF8 }
if ((Test-Path $log) -and (Select-String -Path $log -Pattern 'Serveur d.marr' -Encoding UTF8 -Quiet)) {
  Write-Host "`nLe serveur tourne. Journal : $ServerDir\logs" -ForegroundColor Green
} else {
  Write-Host "`nLe serveur n'a pas encore confirmé son démarrage. Journal complet : $ServerDir\logs\console.log" -ForegroundColor Yellow
}
