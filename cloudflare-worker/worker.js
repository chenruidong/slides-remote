/**
 * Cloudflare Worker + Durable Object backup relay for slides-remote.
 *
 * Uses SQLite-backed Durable Objects + WebSocket Hibernation API (supported on
 * the Cloudflare Workers Free plan). Protocol-identical to ../server.mjs, so
 * any deck using /remote.js OR the standalone HTML file can fail over here
 * whenever your Tailscale machine is offline.
 *
 * Deploy (one-time, ~1 min):
 *   cd cloudflare-worker
 *   npx wrangler login
 *   npx wrangler deploy
 */

import audiencePage from './join.html';

const ROOM_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': '*'
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (url.pathname === '/decks/join.html') {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response(null, { status: 405, headers: { ...corsHeaders, Allow: 'GET, HEAD, OPTIONS' } });
      }
      return new Response(request.method === 'HEAD' ? null : audiencePage, {
        headers: { ...corsHeaders, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
      });
    }

    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true, relay: 'cloudflare-worker' }), {
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders }
      });
    }

    if (url.pathname === '/ws') {
      const roomId = (url.searchParams.get('room') || '').trim();
      const token = (url.searchParams.get('token') || '').trim();
      if (!roomId || token.length < 6 || roomId.length > 32) {
        return new Response('Missing or invalid room/token', { status: 400 });
      }
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 426 });
      }
      const id = env.ROOMS.idFromName(roomId);
      const stub = env.ROOMS.get(id);
      return stub.fetch(request);
    }

    // Serve self-contained mobile controller for both /remote?r=...&t=... and /?r=...&t=...
    if (url.pathname === '/remote' || (url.pathname === '/' && url.searchParams.has('r') && url.searchParams.has('t'))) {
      return new Response(renderMobileControllerHTML(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
      });
    }

    if (url.pathname === '/') {
      return new Response(renderStatusPage(url.origin), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    return new Response('Not found', { status: 404 });
  }
};

/* ============================================================================
   DURABLE OBJECT: SlideRoom (WebSocket Hibernation API)
   ============================================================================ */
export class SlideRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const token = (url.searchParams.get('token') || '').trim();
    const role = url.searchParams.get('role') === 'remote' ? 'remote' : 'deck';

    const storedToken = await this.ctx.storage.get('token');
    if (storedToken && storedToken !== token) {
      return new Response('Invalid room token', { status: 403 });
    }
    if (!storedToken) {
      await this.ctx.storage.put('token', token);
    }
    await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Tag the server socket with its role so hibernation preserves membership
    this.ctx.acceptWebSocket(server, [role]);

    this.broadcastPresence();

    if (role === 'remote') {
      const lastState = await this.ctx.storage.get('lastState');
      if (lastState) {
        try { server.send(lastState); } catch {}
      } else {
        for (const d of this.ctx.getWebSockets('deck')) {
          try { d.send(JSON.stringify({ type: 'request_state' })); } catch {}
        }
      }
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== 'string') return;
    let msg;
    try { msg = JSON.parse(message); } catch { return; }

    const tags = this.ctx.getTags(ws);
    const role = tags.includes('remote') ? 'remote' : 'deck';

    if (role === 'deck') {
      if (msg.type === 'state') {
        await this.ctx.storage.put('lastState', message);
      }
      for (const r of this.ctx.getWebSockets('remote')) {
        try { r.send(message); } catch {}
      }
    } else {
      if (msg.type === 'request_state') {
        const lastState = await this.ctx.storage.get('lastState');
        if (lastState) {
          try { ws.send(lastState); } catch {}
          return;
        }
      }
      for (const d of this.ctx.getWebSockets('deck')) {
        try { d.send(message); } catch {}
      }
    }
  }

  async webSocketClose(ws, code, reason) {
    try { ws.close(code || 1000, reason || ''); } catch { try { ws.close(); } catch {} }
    this.broadcastPresence(ws);
  }

  async webSocketError(ws) {
    try { ws.close(); } catch {}
    this.broadcastPresence(ws);
  }

  async alarm() {
    if (this.ctx.getWebSockets().length === 0) {
      await this.ctx.storage.deleteAll();
    } else {
      await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
    }
  }

  broadcastPresence(excludeWs = null) {
    const decks = this.ctx.getWebSockets('deck').filter(s => s !== excludeWs).length;
    const remotes = this.ctx.getWebSockets('remote').filter(s => s !== excludeWs).length;
    const payload = JSON.stringify({ type: 'presence', decks, remotes });
    for (const sock of this.ctx.getWebSockets()) {
      if (sock === excludeWs) continue;
      try { sock.send(payload); } catch {}
    }
  }
}

/* ============================================================================
   SELF-CONTAINED MOBILE TOUCH CONTROLLER HTML (Zero external assets)
   Supports both declarative remote.js controls & standalone HTML deck messages
   ============================================================================ */
function renderStatusPage(origin) {
  const safeOrigin = String(origin ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>slides-remote Cloudflare Relay</title>
  <style>
    body { font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f8f7f4; color: #14213d; margin: 0; padding: 48px 20px; }
    .box { max-width: 620px; margin: 0 auto; background: #fff; border: 1.5px solid #d9d2c7; border-radius: 14px; padding: 28px; }
    h1 { margin: 0 0 8px; font-size: 24px; }
    p { color: #4a5568; line-height: 1.6; font-size: 14px; }
    code { font-family: ui-monospace, Menlo, Consolas, monospace; background: #ece8e1; padding: 3px 6px; border-radius: 5px; color: #14213d; font-size: 13px; }
    .ok { display: inline-block; padding: 3px 10px; border-radius: 999px; background: #edf7f2; color: #2d7a5e; font-size: 12px; font-weight: 700; margin-bottom: 12px; }
  </style>
</head>
<body>
  <div class="box">
    <div class="ok">● Relay Online</div>
    <h1>slides-remote Backup Relay</h1>
    <p>This Cloudflare Worker relays slide navigation, touchpad laser pointer coordinates, and speaker notes between any HTML presentation and your phone — even when your home/lab Tailnet machine is offline.</p>
    <p><strong>How to use:</strong> Open your presentation HTML in any browser, press <code>R</code>, paste <code>${safeOrigin}</code> into <strong>Relay URL</strong> (or <strong>Backup Relay</strong>), and scan the QR code with your phone.</p>
  </div>
</body>
</html>`;
}

function renderMobileControllerHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
  <title>Slide Remote Controller</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0b1120; color: #f1f5f9; min-height: 100dvh; }
    .wrap { display: flex; flex-direction: column; gap: 11px; max-width: 440px; margin: 0 auto; padding: 14px; min-height: 100dvh; }
    .pad { touch-action: none; user-select: none; -webkit-user-select: none; position: relative; width: 100%; aspect-ratio: 16 / 9; border-radius: 12px; background: #020617; border: 2px solid #334155; overflow: hidden; display: flex; align-items: center; justify-content: center; cursor: crosshair; }
    input[type="range"] { accent-color: #1d5ca8; }
  </style>
</head>
<body>
  <div class="wrap">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
      <div id="conn" style="display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:700;color:#fcd34d">
        <span style="width:8px;height:8px;border-radius:9999px;background:#f59e0b"></span><span>Connecting…</span>
      </div>
      <button id="timer" style="cursor:pointer;font-family:ui-monospace,monospace;font-size:11px;padding:4px 9px;border-radius:9999px;background:#1e293b;color:#cbd5e1;border:1px solid #334155">00:00 ▸</button>
    </div>

    <div style="border-radius:12px;background:#1e293b;border:1px solid #334155;padding:9px 12px">
      <div id="meta" style="font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:#93c5fd;font-weight:700">Waiting for deck…</div>
      <div id="title" style="font-size:13px;font-weight:700;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px">—</div>
    </div>

    <div>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:5px;font-size:11px;color:#94a3b8">
        <span style="font-weight:600">Touchpad Laser Pointer</span>
        <div style="display:flex;gap:4px">
          <button id="mDot" style="cursor:pointer;border:none;padding:2px 8px;border-radius:5px;font-size:10.5px;font-weight:700;background:#ef4444;color:#fff">Dot</button>
          <button id="mSpot" style="cursor:pointer;border:none;padding:2px 8px;border-radius:5px;font-size:10.5px;font-weight:700;background:#1e293b;color:#94a3b8">Spotlight</button>
        </div>
      </div>
      <div id="pad" class="pad">
        <div style="position:absolute;inset:0;opacity:.16;pointer-events:none;background-image:linear-gradient(to right,#64748b 1px,transparent 1px),linear-gradient(to bottom,#64748b 1px,transparent 1px);background-size:25% 25%"></div>
        <span style="font-size:11px;color:#64748b;pointer-events:none">Drag finger here to point on slide</span>
        <div id="thumb" style="display:none;position:absolute;width:16px;height:16px;margin:-8px 0 0 -8px;border-radius:9999px;background:#ef4444;box-shadow:0 0 0 4px rgba(239,68,68,.3);pointer-events:none"></div>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 2fr;gap:8px">
      <button id="btnPrev" style="cursor:pointer;padding:13px 0;border-radius:12px;background:#1e293b;border:1px solid #334155;color:#fff;font-weight:700;font-size:14px">← Prev</button>
      <button id="btnNext" style="cursor:pointer;padding:13px 0;border-radius:12px;background:#1d5ca8;border:none;color:#fff;font-weight:800;font-size:15px">Next Slide →</button>
    </div>

    <div id="controls" style="display:none;border-radius:12px;background:rgba(23,37,84,.65);border:1px solid #1d5ca8;padding:10px;flex-direction:column;gap:8px"></div>

    <div style="border-radius:12px;background:rgba(30,41,59,.85);border:1px solid #334155;padding:10px 12px;flex:1">
      <div style="font-size:10px;text-transform:uppercase;letter-spacing:.06em;font-weight:700;color:#94a3b8;margin-bottom:4px">Speaker Notes</div>
      <div id="notes" style="font-size:12.5px;line-height:1.5;color:#e2e8f0"></div>
    </div>
  </div>
  <script>
    const params = new URLSearchParams(location.search);
    const room = params.get('r') || '', token = params.get('t') || '';
    const wsProto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    const wsUrl = wsProto + location.host + '/ws?room=' + encodeURIComponent(room) + '&token=' + encodeURIComponent(token) + '&role=remote';

    let ws = null, reconnectTimer = null, peers = 0, mode = 'dot', timerSec = 0, timerRun = false, timerId = null;
    const $ = id => document.getElementById(id);
    const send = (obj) => { if (ws && ws.readyState === WebSocket.OPEN) try { ws.send(JSON.stringify(obj)); } catch {} };

    function setConn(st) {
      const el = $('conn');
      if (st === 'ok' && peers > 0) { el.style.color = '#86efac'; el.innerHTML = '<span style="width:8px;height:8px;border-radius:9999px;background:#22c55e"></span><span>Connected (Cloudflare Backup)</span>'; }
      else if (st === 'ok') { el.style.color = '#fcd34d'; el.innerHTML = '<span style="width:8px;height:8px;border-radius:9999px;background:#f59e0b"></span><span>Relay ready · waiting for projector</span>'; }
      else { el.style.color = '#fca5a5'; el.innerHTML = '<span style="width:8px;height:8px;border-radius:9999px;background:#ef4444"></span><span>Reconnecting…</span>'; }
    }

    function renderControls(st) {
      const box = $('controls');
      // 1. Declarative controls from /remote.js decks
      if (st.controls && Array.isArray(st.controls.items) && st.controls.items.length) {
        box.style.display = 'flex';
        box.innerHTML = '<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#93c5fd"></div>';
        box.firstChild.textContent = st.controls.title || 'Live Controls';
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px';
        let hasBtn = false;
        st.controls.items.forEach(item => {
          if (item.type === 'slider') {
            const r = document.createElement('div');
            r.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:11.5px;color:#cbd5e1';
            const l = document.createElement('span');
            l.style.cssText = 'min-width:74px;font-family:ui-monospace,monospace';
            l.textContent = item.label + ': ' + item.value + (item.suffix || '');
            const inp = document.createElement('input');
            inp.type = 'range'; inp.min = item.min; inp.max = item.max; inp.step = item.step || 1; inp.value = item.value; inp.style.flex = '1';
            inp.oninput = () => { const v = parseFloat(inp.value); l.textContent = item.label + ': ' + v + (item.suffix || ''); send({ type: 'action', action: item.action, payload: v }); };
            r.append(l, inp); box.appendChild(r);
          } else {
            hasBtn = true;
            const b = document.createElement('button');
            b.textContent = item.label;
            const bg = item.active ? (item.color || '#1d5ca8') : (item.primary ? '#1d5ca8' : '#0f172a');
            b.style.cssText = 'cursor:pointer;border:1px solid ' + (item.active || item.primary ? 'transparent' : '#334155') + ';background:' + bg + ';color:#fff;padding:6px 10px;border-radius:8px;font-size:11px;font-weight:700;' + (item.full ? 'width:100%' : '');
            b.onclick = () => { navigator.vibrate?.(10); send({ type: 'action', action: item.action, payload: item.payload }); };
            row.appendChild(b);
          }
        });
        if (hasBtn) box.appendChild(row);
        return;
      }

      // 2. Fallback support for standalone Google Drive HTML deck (Slides 23–26; omitted controls key)
      if (!('controls' in st)) {
        if (st.id === 23 && st.demo1) {
          const d = st.demo1;
          box.style.display = 'flex';
          box.innerHTML = '';
          const h = document.createElement('div'); h.style.cssText = 'font-size:10px;font-weight:700;text-transform:uppercase;color:#93c5fd'; h.textContent = 'Live Plot Controls (Slide 23)'; box.appendChild(h);
          const row = document.createElement('div'); row.style.cssText = 'display:flex;gap:6px';
          [['Subjects','showSubjects','#1d5ca8'],['Control','showControl','#2d7a5e'],['Trial-5 Gap','showGap','#b34712']].forEach(([lbl, key, col]) => {
            const b = document.createElement('button'); b.textContent = lbl;
            b.style.cssText = 'flex:1;cursor:pointer;border:none;padding:7px;border-radius:8px;font-size:11px;font-weight:700;color:#fff;background:' + (d[key] ? col : '#0f172a');
            b.onclick = () => send({ type: 'demo1', patch: { [key]: !d[key] } });
            row.appendChild(b);
          });
          box.appendChild(row);
          const sr = document.createElement('div'); sr.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:11px';
          const sl = document.createElement('span'); sl.textContent = 'Cue: ' + (d.cueBoost || 1).toFixed(1) + '×';
          const si = document.createElement('input'); si.type = 'range'; si.min = 0.4; si.max = 2.2; si.step = 0.2; si.value = d.cueBoost || 1; si.style.flex = '1';
          si.oninput = () => { sl.textContent = 'Cue: ' + parseFloat(si.value).toFixed(1) + '×'; send({ type: 'demo1', patch: { cueBoost: parseFloat(si.value) } }); };
          sr.append(sl, si); box.appendChild(sr);
          return;
        } else if (st.id === 24 && (st.qaPrompt !== undefined || st.demo1 !== undefined || st.auditLimit !== undefined || st.handoutOpen !== undefined)) {
          box.style.display = 'flex'; box.innerHTML = '<div style="font-size:10px;font-weight:700;text-transform:uppercase;color:#93c5fd">Live Q&amp;A Prompt (Slide 24)</div>';
          const row = document.createElement('div'); row.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px';
          ['Highlight trials 1–10','Make uncued teal','Zoom to 15 trials','Add threshold 0.8','Reset'].forEach(c => {
            const b = document.createElement('button'); b.textContent = c;
            b.style.cssText = 'cursor:pointer;border:1px solid #334155;background:#0f172a;color:#e2e8f0;padding:5px 8px;border-radius:7px;font-size:11px;font-weight:600';
            b.onclick = () => send({ type: 'qa_prompt', text: c });
            row.appendChild(b);
          });
          box.appendChild(row);
          return;
        } else if (st.id === 25 && st.auditLimit !== undefined) {
          box.style.display = 'flex'; box.innerHTML = '<div style="font-size:10px;font-weight:700;text-transform:uppercase;color:#93c5fd">Live Rule Audit (Slide 25)</div>';
          const sr = document.createElement('div'); sr.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:11px';
          const sl = document.createElement('span'); sl.textContent = 'Limit: ' + (st.auditLimit || 45) + 'w';
          const si = document.createElement('input'); si.type = 'range'; si.min = 15; si.max = 75; si.step = 5; si.value = st.auditLimit || 45; si.style.flex = '1';
          si.oninput = () => { sl.textContent = 'Limit: ' + si.value + 'w'; send({ type: 'audit_limit', limit: parseInt(si.value, 10) }); };
          sr.append(sl, si); box.appendChild(sr);
          return;
        } else if (st.id === 26 && st.handoutOpen !== undefined) {
          box.style.display = 'flex'; box.innerHTML = '<div style="font-size:10px;font-weight:700;text-transform:uppercase;color:#93c5fd">Closing Controls (Slide 26)</div>';
          const hb = document.createElement('button');
          hb.textContent = st.handoutOpen ? '← Back to Slides' : '📄 Reveal 1-Page Handout';
          hb.style.cssText = 'width:100%;cursor:pointer;border:none;padding:9px;border-radius:8px;font-size:12px;font-weight:700;color:#fff;background:' + (st.handoutOpen ? '#b34712' : '#1d5ca8');
          hb.onclick = () => send({ type: 'handout', open: !st.handoutOpen });
          box.appendChild(hb);
          return;
        }
      }

      box.style.display = 'none'; box.innerHTML = '';
    }

    function connect() {
      clearTimeout(reconnectTimer);
      if (ws) {
        ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
        try { ws.close(); } catch {}
        ws = null;
      }
      const sock = new WebSocket(wsUrl);
      ws = sock;
      sock.onopen = () => { if (sock !== ws) return; setConn('ok'); send({ type: 'request_state' }); };
      sock.onmessage = (e) => {
        if (sock !== ws) return;
        let m; try { m = JSON.parse(e.data); } catch { return; }
        if (m.type === 'presence') { peers = m.decks || 0; setConn('ok'); }
        else if (m.type === 'state') {
          $('meta').textContent = 'Slide ' + (m.id ?? (m.index + 1)) + ' / ' + (m.total ?? '?') + (m.section ? ' · ' + m.section : '');
          $('title').textContent = m.title || '—';
          $('notes').textContent = m.notes || 'No speaker notes on this slide.';
          renderControls(m);
        }
      };
      sock.onclose = () => {
        if (sock !== ws) return;
        ws = null;
        peers = 0;
        setConn('off');
        reconnectTimer = setTimeout(connect, 2200);
      };
      sock.onerror = () => {};
    }

    $('btnPrev').onclick = () => { navigator.vibrate?.(12); send({ type: 'nav', action: 'prev' }); };
    $('btnNext').onclick = () => { navigator.vibrate?.(12); send({ type: 'nav', action: 'next' }); };
    $('mDot').onclick = () => { mode = 'dot'; $('mDot').style.background = '#ef4444'; $('mDot').style.color = '#fff'; $('mSpot').style.background = '#1e293b'; $('mSpot').style.color = '#94a3b8'; };
    $('mSpot').onclick = () => { mode = 'spotlight'; $('mSpot').style.background = '#e07016'; $('mSpot').style.color = '#fff'; $('mDot').style.background = '#1e293b'; $('mDot').style.color = '#94a3b8'; };
    $('timer').onclick = () => {
      timerRun = !timerRun; clearInterval(timerId);
      const draw = () => { $('timer').textContent = String(Math.floor(timerSec/60)).padStart(2,'0') + ':' + String(timerSec%60).padStart(2,'0') + (timerRun ? ' ❚❚' : ' ▸'); };
      draw(); if (timerRun) timerId = setInterval(() => { timerSec++; draw(); }, 1000);
    };

    const pad = $('pad'), thumb = $('thumb');
    let drag = false, lastSent = 0;
    const emit = (cx, cy) => {
      const r = pad.getBoundingClientRect();
      const nx = Math.max(0, Math.min(1, (cx - r.left) / r.width));
      const ny = Math.max(0, Math.min(1, (cy - r.top) / r.height));
      thumb.style.display = 'block'; thumb.style.left = (nx*100).toFixed(1)+'%'; thumb.style.top = (ny*100).toFixed(1)+'%';
      const now = performance.now();
      if (now - lastSent >= 18) { lastSent = now; send({ type: 'pointer', x: nx, y: ny, mode }); }
    };
    pad.addEventListener('pointerdown', e => { drag = true; pad.setPointerCapture?.(e.pointerId); emit(e.clientX, e.clientY); });
    pad.addEventListener('pointermove', e => { if (drag) emit(e.clientX, e.clientY); });
    const end = () => { if (!drag) return; drag = false; thumb.style.display = 'none'; send({ type: 'pointer_hide' }); };
    pad.addEventListener('pointerup', end); pad.addEventListener('pointercancel', end);

    async function wake() { try { if ('wakeLock' in navigator) await navigator.wakeLock.request('screen'); } catch {} }
    wake();
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { wake(); if (!ws || ws.readyState !== WebSocket.OPEN) connect(); } });
    connect();
  </script>
</body>
</html>`;
}
