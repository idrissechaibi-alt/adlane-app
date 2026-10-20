// Lecteur HTTP du serveur : le programme `curl` (présent sur Windows 10/11 sous le nom curl.exe), avec son identification
// honnête. SofaScore refuse le client réseau de Node mais accepte curl, tel quel : rien n'est imité ni masqué.
import { execFile } from 'node:child_process';

const UA = 'adlane-collector/1.0 (usage personnel)';

export function curlGet(url: string, headers: Record<string, string> = {}): Promise<{ status: number; text: string }> {
  const args = ['-s', '--max-time', '20', '-A', UA, '-w', '\n__CODE__%{http_code}'];
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  args.push(url);
  return new Promise((resolve, reject) => {
    execFile(process.platform === 'win32' ? 'curl.exe' : 'curl', args, { maxBuffer: 40 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      const m = /\n__CODE__(\d{3})\s*$/.exec(stdout ?? '');
      if (!m) return reject(err ?? new Error('curl : réponse illisible'));
      resolve({ status: Number(m[1]), text: stdout.slice(0, m.index) });
    });
  });
}
