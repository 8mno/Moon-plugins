#!/usr/bin/env node
// Quest relay: a tiny forwarder you run on YOUR OWN server in the country a quest needs.
// The Quest Inspector plugin sends it an accept (or a "does this quest exist" check) and the relay
// repeats that one request to Discord from its own IP, so Discord sees that country.
//
//   RELAY_KEY=<16+ random characters> node quest-relay.js
//
// Env: RELAY_KEY (required), PORT (8787), HOST (127.0.0.1), COUNTRY (what you say this server is, e.g. DE)
// Put it behind HTTPS (Caddy, nginx or a Cloudflare Tunnel). Your Discord token travels in each request,
// so the plugin refuses relay URLs that are not https://.
//
// It can do exactly two things: POST /quests/{id}/enroll and GET /quests/{id}. Nothing else, and it
// never stores or logs the token. No dependencies, Node 18+.
'use strict';
const http = require('http');
const crypto = require('crypto');

const KEY = process.env.RELAY_KEY || '';
const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '127.0.0.1';
const COUNTRY = (process.env.COUNTRY || '').toUpperCase();
const UPSTREAM = 'https://discord.com/api/v9';
const UA = process.env.RELAY_UA || 'Discord-Android/291013;RNA';
if (KEY.length < 16) { console.error('Set RELAY_KEY to at least 16 random characters.'); process.exit(1); }

const keyBuf = crypto.createHash('sha256').update(KEY).digest();
function keyOk(h) {
  const got = crypto.createHash('sha256').update(String(h || '')).digest();
  return crypto.timingSafeEqual(got, keyBuf);
}
const hits = new Map(); // ip -> [timestamps]; 40 requests a minute
function limited(ip) {
  const now = Date.now(), list = (hits.get(ip) || []).filter(t => now - t < 60000);
  list.push(now); hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > 40;
}
function send(res, status, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
  res.end(s);
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if (n > 4096) { reject(new Error('too big')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
let geo = { at: 0, v: null };
async function whereAmI() {
  if (geo.v && Date.now() - geo.at < 3600e3) return geo.v;
  try {
    const r = await fetch('https://api.country.is/');
    const j = await r.json();
    geo = { at: Date.now(), v: { ip: j.ip, country: String(j.country || '').toUpperCase() } };
  } catch (e) { geo = { at: Date.now() - 3000e3, v: { country: '' } }; }
  return geo.v;
}
async function forward(path, method, token, body) {
  const r = await fetch(UPSTREAM + path, {
    method,
    headers: Object.assign({ authorization: token, 'user-agent': UA, accept: 'application/json' }, body ? { 'content-type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined
  });
  let parsed = null; const text = await r.text();
  try { parsed = JSON.parse(text); } catch (e) { parsed = text.slice(0, 300); }
  return { status: r.status, body: parsed };
}

http.createServer(async (req, res) => {
  try {
    const ip = req.socket.remoteAddress || '';
    if (!keyOk(req.headers['x-relay-key'])) return send(res, 401, { error: 'bad key' });
    if (limited(ip)) return send(res, 429, { error: 'slow down' });
    if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
    const b = await readJson(req);
    if (req.url === '/v1/health') {
      const g = await whereAmI();
      return send(res, 200, { ok: true, country: g.country || '', declared: COUNTRY, ip: g.ip || '' });
    }
    const token = typeof b.token === 'string' ? b.token : '';
    if (token.length < 20 || token.length > 200 || /[\s\r\n]/.test(token)) return send(res, 400, { error: 'bad token' });
    const id = String(b.id || '');
    if (!/^\d{5,25}$/.test(id)) return send(res, 400, { error: 'bad quest id' });
    if (req.url === '/v1/enroll') {
      const loc = Number.isInteger(b.location) && b.location >= 0 && b.location < 100 ? b.location : 12;
      return send(res, 200, await forward('/quests/' + id + '/enroll', 'POST', token, { location: loc }));
    }
    if (req.url === '/v1/quest') return send(res, 200, await forward('/quests/' + id, 'GET', token, null));
    send(res, 404, { error: 'unknown route' });
  } catch (e) { send(res, 400, { error: 'bad request' }); }
}).listen(PORT, HOST, () => console.log('quest relay on ' + HOST + ':' + PORT + (COUNTRY ? ' (' + COUNTRY + ')' : '')));
