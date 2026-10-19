@echo off
rem Lance la boucle du serveur (run-server.ps1). Une seule ligne : ce fichier peut etre mis a jour pendant qu il tourne.
powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0run-server.ps1"
