// Où tourne le moteur : sur le téléphone (par défaut) ou sur le serveur du PC (server/main.ts l'indique au démarrage).
let onServer = false;

export function setRunningOnServer(): void {
  onServer = true;
}

export function isRunningOnServer(): boolean {
  return onServer;
}

/**
 * Lecteur HTTP propre au serveur PC (server/curl.ts : le programme `curl`, qui s'annonce honnêtement). SofaScore refuse le
 * client réseau de Node (403 sur son empreinte technique) mais accepte curl avec la même identification.
 */
export type ServerHttp = (url: string, headers?: Record<string, string>) => Promise<{ status: number; text: string }>;
let serverHttp: ServerHttp | null = null;

export function setServerHttp(fn: ServerHttp): void {
  serverHttp = fn;
}

export function getServerHttp(): ServerHttp | null {
  return serverHttp;
}
