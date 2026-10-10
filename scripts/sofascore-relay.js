// Relais SofaScore pour l'app (à lancer dans Termux : node sofascore-relay.js).
//
// SofaScore refuse les connexions de l'app (et de Node) selon leur empreinte
// technique, pas selon les en-têtes ; `curl` passe. Ce petit serveur local
// refait donc chaque requête avec curl et la renvoie telle quelle à l'app
// (http://localhost:8788/api/v1/...). Rien d'autre : lecture seule, uniquement
// l'API publique de SofaScore, uniquement depuis ce téléphone (127.0.0.1).

const http = require('http');
const { spawn } = require('child_process');

const PORT = Number(process.env.SOFA_RELAY_PORT || 8788);
const UPSTREAM = 'https://api.sofascore.com';
const CACHE_MS = 15_000;
const MAX_BYTES = 8 * 1024 * 1024;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

const cache = new Map();

function curlGet(url) {
  return new Promise((resolve, reject) => {
    // Arguments en tableau, jamais de shell : l'adresse ne peut rien exécuter.
    const child = spawn('curl', ['-sS', '--compressed', '-m', '20', '-w', '\n%{http_code}', '-H', `User-Agent: ${UA}`, url]);
    const chunks = [];
    let size = 0;
    let stderr = '';
    child.stdout.on('data', (c) => {
      size += c.length;
      if (size > MAX_BYTES) child.kill();
      else chunks.push(c);
    });
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', (e) => reject(new Error(`curl introuvable (pkg install curl) : ${e.message}`)));
    child.on('close', (code) => {
      if (code !== 0 && chunks.length === 0) return reject(new Error(stderr.trim() || `curl code ${code}`));
      const out = Buffer.concat(chunks);
      const cut = out.lastIndexOf(0x0a);
      const status = Number(out.slice(cut + 1).toString()) || 502;
      resolve({ status, body: out.slice(0, cut) });
    });
  });
}

const server = http.createServer(async (req, res) => {
  const send = (status, body, type = 'application/json') => {
    res.writeHead(status, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' });
    res.end(body);
  };

  if (req.method !== 'GET') return send(405, '{"error":"GET seulement"}');
  if (req.url === '/' || req.url === '/health') return send(200, '{"ok":true,"relay":"sofascore"}');
  if (!/^\/api\/v1\/[A-Za-z0-9/_\-.]+(\?[A-Za-z0-9=&_\-.%]*)?$/.test(req.url) || req.url.includes('..')) {
    return send(400, '{"error":"chemin refusé"}');
  }

  const hit = cache.get(req.url);
  if (hit && Date.now() - hit.at < CACHE_MS) return send(hit.status, hit.body);

  try {
    const { status, body } = await curlGet(UPSTREAM + req.url);
    if (status === 200) cache.set(req.url, { at: Date.now(), status, body });
    send(status, body);
  } catch (error) {
    send(502, JSON.stringify({ error: String(error.message || error) }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Relais SofaScore prêt : http://localhost:${PORT}/api/v1/sport/football/events/live`);
  console.log('Laisse cette fenêtre ouverte (Ctrl+C pour arrêter).');
});
