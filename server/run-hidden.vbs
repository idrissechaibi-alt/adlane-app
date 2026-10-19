' Lance la boucle du serveur adlane sans aucune fenetre (rien a fermer par erreur), puis rend la main tout de suite :
' la tache planifiee se termine, le serveur continue de tourner seul.
Set sh = CreateObject("WScript.Shell")
dir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & dir & "\run-server.ps1""", 0, False
