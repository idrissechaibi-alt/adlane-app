// Dossier de données du serveur : ADLANE_DATA_DIR, sinon <dossier personnel>/adlane-server/data.
import * as os from 'node:os';
import * as path from 'node:path';

export function serverRoot(): string {
  return process.env.ADLANE_SERVER_DIR || path.join(os.homedir(), 'adlane-server');
}

export function dataRoot(): string {
  return process.env.ADLANE_DATA_DIR || path.join(serverRoot(), 'data');
}
