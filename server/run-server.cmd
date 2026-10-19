@echo off
rem Boucle du serveur adlane (lancée par la tâche planifiée « adlane-serveur ») :
rem met le code à jour, reconstruit, lance le serveur ; s'il s'arrête (mise à jour du code, plantage), on recommence.
setlocal
cd /d "%~dp0\.."
set "LOGDIR=%USERPROFILE%\adlane-server\logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
:loop
echo %date% %time% Mise a jour du code >> "%LOGDIR%\console.log"
git fetch --depth 1 origin main >> "%LOGDIR%\console.log" 2>&1 && git reset --hard origin/main >> "%LOGDIR%\console.log" 2>&1
pushd server
call npm install --no-audit --no-fund --silent >> "%LOGDIR%\console.log" 2>&1
node build.mjs >> "%LOGDIR%\console.log" 2>&1
popd
node --no-warnings server\dist\server.js --restore-from "%CD%" >> "%LOGDIR%\console.log" 2>&1
echo %date% %time% Serveur arrete (code %errorlevel%), relance dans 15 s >> "%LOGDIR%\console.log"
ping -n 16 127.0.0.1 > nul
goto loop
