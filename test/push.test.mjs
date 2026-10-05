import crypto from 'node:crypto';
import ece from 'http_ece';
import { encryptPayload, vapidAuthHeader, bytesToB64url, b64urlToBytes } from '../src/push.js';

// user agent keys
const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
const auth = crypto.randomBytes(16);
const payload = JSON.stringify({ title: 'hi', body: 'x'.repeat(300) });
const body = await encryptPayload(payload, bytesToB64url(ua.getPublicKey()), bytesToB64url(auth));
const out = ece.decrypt(Buffer.from(body), { version: 'aes128gcm', privateKey: ua, dh: undefined, authSecret: auth });
console.log('decrypt ok:', out.toString() === payload);

// VAPID
const kp = await crypto.webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const jwk = await crypto.webcrypto.subtle.exportKey('jwk', kp.privateKey);
const pub = bytesToB64url(new Uint8Array(await crypto.webcrypto.subtle.exportKey('raw', kp.publicKey)));
const h = await vapidAuthHeader('https://web.push.apple.com/abc', pub, JSON.stringify(jwk), 'mailto:a@b.c');
const t = h.match(/t=([^,]+)/)[1];
const [a, b, s] = t.split('.');
const ok = await crypto.webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, kp.publicKey, b64urlToBytes(s), new TextEncoder().encode(a + '.' + b));
console.log('vapid sig ok:', ok, JSON.parse(Buffer.from(b, 'base64url')));
