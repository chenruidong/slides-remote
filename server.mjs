#!/usr/bin/env node
/**
 * slides-remote — Zero-dependency HTTP + RFC-6455 WebSocket relay server.
 *
 * Serves any HTML deck in ./decks/, the drop-in /remote.js client, and a tiny
 * /remote mobile controller page, while relaying slide navigation, touchpad
 * laser pointer coordinates, speaker notes, and custom live-demo controls
 * between any projector browser and your smartphone.
 *
 * Designed to pair with Tailscale Funnel (`tailscale funnel --https=10000 8787`)
 * so the projector computer does NOT need Tailscale or any software installed.
 *
 * Usage:
 *   node server.mjs                          # serves deck index at / and all ./decks/*.html
 *   DECK=decks/starter.html node server.mjs  # serves a specific deck directly at /
 *   PORT=8787 HOST=127.0.0.1 node server.mjs
 */

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return;
  for (const rawLine of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadEnvFile(path.join(__dirname, '.env'));

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const DECKS_DIR = path.join(__dirname, 'decks');
const REMOTE_JS = path.join(__dirname, 'remote.js');
const DEFAULT_DECK = process.env.DECK ? path.resolve(__dirname, process.env.DECK) : null;
const BACKUP_RELAY = (process.env.BACKUP_RELAY || '').trim().replace(/\/+$/, '');
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const ROOM_TTL_MS = 6 * 60 * 60 * 1000;

/** @type {Map<string, { token: string, decks: Set<any>, remotes: Set<any>, lastState: string | null, updatedAt: number }>} */
const rooms = new Map();

function getOrCreateRoom(roomId, token) {
  const existing = rooms.get(roomId);
  if (existing) {
    if (existing.token !== token) return null;
    existing.updatedAt = Date.now();
    return existing;
  }
  const room = { token, decks: new Set(), remotes: new Set(), lastState: null, updatedAt: Date.now() };
  rooms.set(roomId, room);
  return room;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms.entries()) {
    if (room.decks.size === 0 && room.remotes.size === 0 && now - room.updatedAt > ROOM_TTL_MS) {
      rooms.delete(id);
    }
  }
}, 15 * 60 * 1000).unref();

/* ============================================================================
   MINIMAL RFC-6455 WEBSOCKET FRAMING
   ============================================================================ */
function encodeFrame(opcode, payloadBuf) {
  const len = payloadBuf.length;
  let header;
  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[0] = 0x80 | opcode;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payloadBuf]);
}

function sendText(client, text) {
  if (client.closed || client.socket.destroyed) return;
  try { client.socket.write(encodeFrame(0x1, Buffer.from(text, 'utf8'))); }
  catch { cleanupClient(client); }
}

function sendControl(client, opcode, payload = Buffer.alloc(0)) {
  if (client.closed || client.socket.destroyed) return;
  try { client.socket.write(encodeFrame(opcode, payload)); }
  catch { cleanupClient(client); }
}

function notifyPresence(room) {
  const payload = JSON.stringify({ type: 'presence', decks: room.decks.size, remotes: room.remotes.size });
  for (const d of room.decks) sendText(d, payload);
  for (const r of room.remotes) sendText(r, payload);
}

function cleanupClient(client) {
  if (client.closed) return;
  client.closed = true;
  clearInterval(client.pingTimer);
  const { room, role } = client;
  if (room) {
    if (role === 'deck') room.decks.delete(client);
    else room.remotes.delete(client);
    room.updatedAt = Date.now();
    notifyPresence(room);
  }
  try { client.socket.destroy(); } catch {}
}

function handleMessage(client, text) {
  const { room, role } = client;
  if (!room) return;
  room.updatedAt = Date.now();
  let msg;
  try { msg = JSON.parse(text); } catch { return; }

  if (role === 'deck') {
    if (msg.type === 'state') room.lastState = text;
    for (const remote of room.remotes) sendText(remote, text);
  } else {
    if (msg.type === 'request_state' && room.lastState) {
      sendText(client, room.lastState);
      return;
    }
    for (const deck of room.decks) sendText(deck, text);
  }
}

function attachWebSocket(socket, room, role) {
  const client = {
    socket, room, role, closed: false, buffer: Buffer.alloc(0),
    fragOpcode: null, fragChunks: [], alive: true, pingTimer: null
  };

  if (role === 'deck') room.decks.add(client);
  else room.remotes.add(client);

  notifyPresence(room);
  if (role === 'remote' && room.lastState) {
    sendText(client, room.lastState);
  } else if (role === 'remote' && room.decks.size > 0) {
    for (const d of room.decks) sendText(d, JSON.stringify({ type: 'request_state' }));
  }

  client.pingTimer = setInterval(() => {
    if (!client.alive) { cleanupClient(client); return; }
    client.alive = false;
    sendControl(client, 0x9);
  }, 25000);

  socket.on('data', (chunk) => {
    client.alive = true;
    client.buffer = Buffer.concat([client.buffer, chunk]);

    while (client.buffer.length >= 2) {
      const b0 = client.buffer[0], b1 = client.buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let payloadLen = b1 & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (client.buffer.length < 4) return;
        payloadLen = client.buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (client.buffer.length < 10) return;
        payloadLen = Number(client.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (payloadLen > 1024 * 1024) { cleanupClient(client); return; }

      const maskLen = masked ? 4 : 0;
      if (client.buffer.length < offset + maskLen + payloadLen) return;

      const maskKey = masked ? client.buffer.subarray(offset, offset + 4) : null;
      offset += maskLen;

      const payload = Buffer.from(client.buffer.subarray(offset, offset + payloadLen));
      client.buffer = client.buffer.subarray(offset + payloadLen);

      if (masked && maskKey) {
        for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];
      }

      if (opcode === 0x8) {
        sendControl(client, 0x8);
        cleanupClient(client);
        return;
      } else if (opcode === 0x9) {
        sendControl(client, 0xA, payload);
      } else if (opcode === 0xA) {
        client.alive = true;
      } else if (opcode === 0x1 || opcode === 0x0) {
        if (opcode === 0x1) { client.fragOpcode = 0x1; client.fragChunks = [payload]; }
        else if (client.fragOpcode === 0x1) client.fragChunks.push(payload);
        if (fin && client.fragOpcode === 0x1) {
          const full = Buffer.concat(client.fragChunks).toString('utf8');
          client.fragOpcode = null;
          client.fragChunks = [];
          handleMessage(client, full);
        }
      }
    }
  });

  socket.on('error', () => cleanupClient(client));
  socket.on('close', () => cleanupClient(client));
  socket.on('end', () => cleanupClient(client));
}

/* ============================================================================
   STATIC & GENERATED HTML PAGES
   ============================================================================ */
function renderRemoteShell() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
  <title>Slide Remote Controller</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: #0b1120;
      color: #f1f5f9;
      min-height: 100dvh;
    }
  </style>
</head>
<body>
  <div id="sr-mobile-root"></div>
  <script src="/remote.js"></script>
  <script>SlideRemote.mountMobileController(document.getElementById('sr-mobile-root'));</script>
</body>
</html>`;
}

function listDecks() {
  if (!fs.existsSync(DECKS_DIR)) return [];
  return fs.readdirSync(DECKS_DIR)
    .filter(f => f.endsWith('.html'))
    .sort();
}

function renderIndexPage() {
  const decks = listDecks();
  const items = decks.map(file => {
    const label = file.replace(/\.html$/i, '').replace(/[-_]+/g, ' ');
    return `<a class="card" href="/decks/${encodeURIComponent(file)}">
      <div class="name">${label}</div>
      <div class="path">/decks/${file}</div>
    </a>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>slides-remote — Decks</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f8f7f4; color: #14213d; margin: 0; padding: 48px 20px; }
    .wrap { max-width: 720px; margin: 0 auto; }
    h1 { font-size: 30px; letter-spacing: -0.025em; margin: 0 0 8px; }
    p { color: #4a5568; margin: 0 0 28px; line-height: 1.5; }
    .grid { display: grid; gap: 14px; }
    .card { display: block; text-decoration: none; color: inherit; background: #fff; border: 1.5px solid #d9d2c7; border-radius: 12px; padding: 18px 20px; transition: border-color .15s, transform .15s; }
    .card:hover { border-color: #1d5ca8; transform: translateY(-1px); }
    .name { font-weight: 700; font-size: 18px; text-transform: capitalize; margin-bottom: 4px; }
    .path { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; color: #5b6472; }
    .tip { margin-top: 28px; padding: 14px 16px; background: #fdfbf6; border: 1px solid #d9d2c7; border-radius: 10px; font-size: 13px; color: #4a5568; }
    code { font-family: ui-monospace, Menlo, Consolas, monospace; background: #ece8e1; padding: 2px 5px; border-radius: 4px; color: #14213d; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>slides-remote</h1>
    <p>Pick a deck below, then press <code>R</code> to pair your phone as a touch controller &amp; laser pointer.</p>
    <div class="grid">${items || '<p>No HTML decks found in <code>./decks/</code> yet.</p>'}</div>
    <div class="tip">Drop any new <code>.html</code> presentation into <code>decks/</code> and refresh — no server restart needed.</div>
  </div>
</body>
</html>`;
}

function sendFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
    res.end(content);
  });
}

/* ============================================================================
   HTTP SERVER
   ============================================================================ */
const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, activeRooms: rooms.size, decks: listDecks() }));
    return;
  }

  if (url.pathname === '/remote.js') {
    if (!BACKUP_RELAY) {
      sendFile(res, REMOTE_JS, 'application/javascript; charset=utf-8');
      return;
    }
    fs.readFile(REMOTE_JS, 'utf8', (err, content) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }
      const safeJson = JSON.stringify(BACKUP_RELAY).replace(/</g, '\\u003c');
      const prefix = `window.SLIDE_REMOTE_DEFAULTS=Object.assign({backupRelay:${safeJson}},window.SLIDE_REMOTE_DEFAULTS);\n`;
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(prefix + content);
    });
    return;
  }

  if (url.pathname === '/remote') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(renderRemoteShell());
    return;
  }

  if (url.pathname === '/') {
    if (url.searchParams.has('r') && url.searchParams.has('t')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(renderRemoteShell());
      return;
    }
    if (DEFAULT_DECK && fs.existsSync(DEFAULT_DECK)) {
      sendFile(res, DEFAULT_DECK, 'text/html; charset=utf-8');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(renderIndexPage());
    return;
  }

  if (url.pathname.startsWith('/decks/')) {
    const rawName = decodeURIComponent(url.pathname.slice('/decks/'.length));
    const safeName = path.basename(rawName);
    if (!safeName.endsWith('.html') || safeName !== rawName) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Invalid deck filename');
      return;
    }
    const target = path.resolve(DECKS_DIR, safeName);
    if (!target.startsWith(DECKS_DIR + path.sep)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }
    sendFile(res, target, 'text/html; charset=utf-8');
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.on('upgrade', (req, socket) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (url.pathname !== '/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  const roomId = (url.searchParams.get('room') || '').trim();
  const token = (url.searchParams.get('token') || '').trim();
  const role = url.searchParams.get('role') === 'remote' ? 'remote' : 'deck';
  const wsKey = req.headers['sec-websocket-key'];

  if (!wsKey || !roomId || token.length < 6 || roomId.length > 32) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  const room = getOrCreateRoom(roomId, token);
  if (!room) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }

  const accept = crypto.createHash('sha1').update(wsKey + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  socket.setNoDelay(true);
  attachWebSocket(socket, room, role);
});

server.listen(PORT, HOST, () => {
  console.log(`\n  slides-remote relay listening at http://${HOST}:${PORT}`);
  console.log(`  Decks directory: ${DECKS_DIR}`);
  console.log(`  Expose publicly with Tailscale Funnel (no Tailscale needed on projector PC):`);
  console.log(`    tailscale funnel --https=10000 ${PORT}\n`);
});
