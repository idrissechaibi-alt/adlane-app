// Où tourne le moteur : sur le téléphone (par défaut) ou sur le serveur du PC (server/main.ts l'indique au démarrage).
let onServer = false;

export function setRunningOnServer(): void {
  onServer = true;
}

export function isRunningOnServer(): boolean {
  return onServer;
}
