// Serves the ICS fixture and acts as a fake push service that decrypts what it receives.
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import ece from 'http_ece';
const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
const auth = crypto.randomBytes(16);
fs.writeFileSync('/tmp/hw-sub.json', JSON.stringify({ endpoint: 'http://127.0.0.1:8799/push', keys: { p256dh: ua.getPublicKey('base64url'), auth: auth.toString('base64url') } }));
http.createServer((req, res) => {
  if (req.url === '/fixture.ics' || req.url === '/empty.ics') { res.end(fs.readFileSync('test' + req.url)); return; }
  if (req.url === '/push') {
    const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => {
      const body = Buffer.concat(chunks);
      try {
        const msg = ece.decrypt(body, { version: 'aes128gcm', privateKey: ua, authSecret: auth }).toString();
        fs.appendFileSync('/tmp/hw-pushes.log', JSON.stringify({ auth: req.headers.authorization.slice(0, 20), enc: req.headers['content-encoding'], msg: JSON.parse(msg) }) + '\n');
        res.writeHead(201); res.end();
      } catch (e) { fs.appendFileSync('/tmp/hw-pushes.log', 'DECRYPT FAIL ' + e.message + '\n'); res.writeHead(400); res.end(); }
    }); return;
  }
  res.writeHead(404); res.end();
}).listen(8799, () => console.log('mock on 8799'));
