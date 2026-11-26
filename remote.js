/**
 * remote.js — Drop-in smartphone touch controller + laser pointer + QR pairing
 * for any HTML presentation. Zero external dependencies, zero CDN calls.
 *
 * Projector usage:
 *   <script src="/remote.js"></script>
 *   <script>
 *     const remote = SlideRemote.init({
 *       stageSelector: '#slideStage',
 *       getState: () => ({ id: 1, total: 10, section: 'Intro', title: 'Hello', notes: '...', controls: null }),
 *       onNav: (action, index) => { ... },
 *       onAction: (action, payload) => { ... }
 *     });
 *     // Call remote.sync() whenever slide or interactive state changes.
 *   </script>
 */
(function (global) {
  'use strict';

  /* ==========================================================================
     1. PURE-JS ISO/IEC 18004 QR CODE GENERATOR (Versions 1–6, EC L, <=134 B)
     ========================================================================== */
  const QR_VER = [
    null,
    { size: 21, dataCw: 19,  ecPerBlk: 7,  blocks: 1, align: [] },
    { size: 25, dataCw: 34,  ecPerBlk: 10, blocks: 1, align: [6, 18] },
    { size: 29, dataCw: 55,  ecPerBlk: 15, blocks: 1, align: [6, 22] },
    { size: 33, dataCw: 80,  ecPerBlk: 20, blocks: 1, align: [6, 26] },
    { size: 37, dataCw: 108, ecPerBlk: 26, blocks: 1, align: [6, 30] },
    { size: 41, dataCw: 136, ecPerBlk: 18, blocks: 2, align: [6, 34] }
  ];
  const GF_EXP = new Uint8Array(512);
  const GF_LOG = new Uint8Array(256);
  (() => {
    let x = 1;
    for (let i = 0; i < 255; i++) { GF_EXP[i] = x; GF_LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
    for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
  })();
  const gfMul = (a, b) => (a === 0 || b === 0) ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]];
  function rsRemainder(data, ecLen) {
    let gen = [1];
    for (let i = 0; i < ecLen; i++) {
      const next = new Array(gen.length + 1).fill(0);
      const root = GF_EXP[i];
      for (let j = 0; j < gen.length; j++) { next[j] ^= gen[j]; next[j + 1] ^= gfMul(gen[j], root); }
      gen = next;
    }
    const rem = new Uint8Array(ecLen);
    for (let i = 0; i < data.length; i++) {
      const factor = data[i] ^ rem[0];
      for (let j = 0; j < ecLen - 1; j++) rem[j] = rem[j + 1];
      rem[ecLen - 1] = 0;
      if (factor !== 0) for (let j = 0; j < ecLen; j++) rem[j] ^= gfMul(gen[j + 1], factor);
    }
    return rem;
  }
  function renderQRSvg(text) {
    const bytes = Array.from(new TextEncoder().encode(text));
    let v = 1;
    while (v <= 6 && bytes.length + 2 > QR_VER[v].dataCw) v++;
    if (v > 6) return `<div style="font-size:11px;text-align:center;color:#b34712;padding:8px">URL too long (${bytes.length} B) for QR</div>`;
    const spec = QR_VER[v], n = spec.size, bits = [];
    const pushBits = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    pushBits(0b0100, 4); pushBits(bytes.length, 8);
    for (const b of bytes) pushBits(b, 8);
    const maxBits = spec.dataCw * 8;
    for (let i = 0; i < 4 && bits.length < maxBits; i++) bits.push(0);
    while (bits.length % 8 !== 0) bits.push(0);
    const dataBytes = [];
    for (let i = 0; i < bits.length; i += 8) {
      let b = 0; for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
      dataBytes.push(b);
    }
    const pads = [0xec, 0x11]; let pi = 0;
    while (dataBytes.length < spec.dataCw) dataBytes.push(pads[(pi++) & 1]);
    const blkLen = spec.dataCw / spec.blocks, dBlks = [], eBlks = [];
    for (let b = 0; b < spec.blocks; b++) {
      const s = dataBytes.slice(b * blkLen, (b + 1) * blkLen);
      dBlks.push(s); eBlks.push(rsRemainder(s, spec.ecPerBlk));
    }
    const cw = [];
    for (let i = 0; i < blkLen; i++) for (let b = 0; b < spec.blocks; b++) cw.push(dBlks[b][i]);
    for (let i = 0; i < spec.ecPerBlk; i++) for (let b = 0; b < spec.blocks; b++) cw.push(eBlks[b][i]);

    const mat = Array.from({ length: n }, () => new Int8Array(n));
    const fn = Array.from({ length: n }, () => new Uint8Array(n));
    const setFn = (r, c, val) => { if (r >= 0 && r < n && c >= 0 && c < n) { mat[r][c] = val ? 1 : 0; fn[r][c] = 1; } };
    const drawFinder = (r0, c0) => {
      for (let dr = -1; dr <= 7; dr++) for (let dc = -1; dc <= 7; dc++) {
        const r = r0 + dr, c = c0 + dc;
        if (r < 0 || r >= n || c < 0 || c >= n) continue;
        setFn(r, c, dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6 && (dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4)));
      }
    };
    drawFinder(0, 0); drawFinder(0, n - 7); drawFinder(n - 7, 0);
    for (let i = 8; i < n - 8; i++) { setFn(6, i, (i & 1) === 0); setFn(i, 6, (i & 1) === 0); }
    for (const r0 of spec.align) for (const c0 of spec.align) {
      if (fn[r0][c0]) continue;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) setFn(r0 + dr, c0 + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
    }
    for (let i = 0; i <= 8; i++) if (i !== 6) { setFn(8, i, 0); setFn(i, 8, 0); }
    for (let i = 0; i < 8; i++) setFn(8, n - 1 - i, 0);
    for (let i = 0; i < 7; i++) setFn(n - 1 - i, 8, 0);
    setFn(4 * v + 9, 8, 1);

    let bitIdx = 0, totalBits = cw.length * 8, upward = true;
    for (let right = n - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let step = 0; step < n; step++) {
        const r = upward ? (n - 1 - step) : step;
        for (let dx = 0; dx < 2; dx++) {
          const c = right - dx;
          if (!fn[r][c]) {
            let bit = 0;
            if (bitIdx < totalBits) { bit = (cw[bitIdx >>> 3] >>> (7 - (bitIdx & 7))) & 1; bitIdx++; }
            mat[r][c] = bit;
          }
        }
      }
      upward = !upward;
    }
    const maskFns = [
      (r, c) => (r + c) % 2 === 0, (r, c) => r % 2 === 0, (r, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0,
      (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
      (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
      (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
      (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0
    ];
    const tlCoords = [[8,0],[8,1],[8,2],[8,3],[8,4],[8,5],[8,7],[8,8],[7,8],[5,8],[4,8],[3,8],[2,8],[1,8],[0,8]];
    let bestScore = Infinity, bestGrid = null;
    for (let m = 0; m < 8; m++) {
      const g = mat.map((row, r) => row.map((val, c) => (!fn[r][c] && maskFns[m](r, c)) ? (val ^ 1) : val));
      const d5 = (0b01 << 3) | m;
      let rem = d5 << 10;
      for (let i = 14; i >= 10; i--) if ((rem >>> i) & 1) rem ^= 0x537 << (i - 10);
      const fmt = ((d5 << 10) | rem) ^ 0x5412;
      const gb = i => (fmt >>> i) & 1;
      for (let i = 0; i < 15; i++) g[tlCoords[i][0]][tlCoords[i][1]] = gb(14 - i);
      for (let i = 0; i < 7; i++) g[n - 1 - i][8] = gb(14 - i);
      for (let i = 0; i < 8; i++) g[8][n - 8 + i] = gb(7 - i);
      let score = 0, dark = 0;
      for (let r = 0; r < n; r++) {
        let run = 1;
        for (let c = 0; c < n; c++) {
          dark += g[r][c];
          if (c > 0 && g[r][c] === g[r][c - 1]) { run++; if (run === 5) score += 3; else if (run > 5) score += 1; } else run = 1;
        }
      }
      score += Math.abs(dark * 2 - n * n);
      if (score < bestScore) { bestScore = score; bestGrid = g; }
    }
    const q = 3, dim = n + q * 2;
    let paths = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (bestGrid[r][c]) paths += `M${c + q},${r + q}h1v1h-1z`;
    return `<svg viewBox="0 0 ${dim} ${dim}" style="width:100%;height:100%;display:block" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg"><rect width="${dim}" height="${dim}" fill="#fff"/><path d="${paths}" fill="#0b0f14"/></svg>`;
  }

  /* ==========================================================================
     2. SHARED STYLES & HELPERS
     ========================================================================== */
  function injectStyles() {
    if (document.getElementById('sr-styles')) return;
    const style = document.createElement('style');
    style.id = 'sr-styles';
    style.textContent = `
      .sr-laser { position:absolute; left:0; top:0; pointer-events:none; z-index:999; opacity:0; will-change:transform,opacity; transition:opacity .16s ease; }
      .sr-laser.visible { opacity:1; }
      .sr-laser-dot { width:18px; height:18px; margin:-9px 0 0 -9px; border-radius:9999px; background:radial-gradient(circle,#fff 0%,#ef4444 42%,rgba(239,68,68,.25) 75%,transparent 100%); box-shadow:0 0 14px 4px rgba(239,68,68,.7),0 0 28px 8px rgba(239,68,68,.28); }
      .sr-laser-spot { width:78px; height:78px; margin:-39px 0 0 -39px; border-radius:9999px; border:3px solid rgba(224,112,22,.92); background:radial-gradient(circle,rgba(249,213,102,.22) 0%,rgba(224,112,22,.08) 70%,transparent 100%); box-shadow:0 0 20px rgba(224,112,22,.35); }
      .sr-modal-bg { position:fixed; inset:0; z-index:9999; background:rgba(15,23,42,.62); backdrop-filter:blur(4px); display:flex; align-items:center; justify-content:center; padding:16px; font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
      .sr-modal { width:100%; max-width:520px; background:#fff; color:#14213d; border:1px solid #d9d2c7; border-radius:16px; padding:20px; box-shadow:0 24px 60px rgba(0,0,0,.3); }
      .sr-modal input { width:100%; padding:7px 10px; border:1px solid #cbd5e1; border-radius:8px; font-family:ui-monospace,Menlo,Consolas,monospace; font-size:11.5px; color:#14213d; background:#f8fafc; }
      .sr-btn { cursor:pointer; border:none; border-radius:8px; padding:7px 12px; font-size:12px; font-weight:600; transition:opacity .15s; }
      .sr-btn:hover { opacity:.9; }
      .sr-sim-drawer { position:fixed; right:16px; bottom:16px; width:320px; max-width:calc(100vw - 32px); z-index:9998; border-radius:22px; background:#0f172a; color:#f1f5f9; border:2px solid #334155; padding:14px; box-shadow:0 20px 50px rgba(0,0,0,.45); font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
      .sr-pad { touch-action:none; user-select:none; -webkit-user-select:none; position:relative; width:100%; border-radius:14px; background:#020617; border:2px solid #334155; overflow:hidden; display:flex; align-items:center; justify-content:center; cursor:crosshair; }
      .sr-remote-wrap { display:flex; flex-direction:column; gap:10px; max-width:460px; margin:0 auto; padding:12px 14px max(14px, env(safe-area-inset-bottom)); height:100dvh; overflow-y:auto; }
      .sr-remote-wrap .sr-pad { flex:1; min-height:200px; }
      .sr-sim-wrap { display:flex; flex-direction:column; gap:9px; }
      .sr-sim-wrap .sr-pad { aspect-ratio:16/10; min-height:165px; }
      .sr-nav-btn { cursor:pointer; touch-action:manipulation; user-select:none; -webkit-user-select:none; -webkit-tap-highlight-color:transparent; transition:transform .08s ease, filter .08s ease; }
      .sr-nav-btn:active { transform:scale(0.97); filter:brightness(1.12); }
      .sr-gesture-hover { outline:2px dashed rgba(29,92,168,.65); outline-offset:4px; border-radius:8px; transition:outline-color .12s, box-shadow .12s; }
      .sr-gesture-active { outline:2.5px solid #1d5ca8; outline-offset:4px; border-radius:8px; box-shadow:0 0 0 5px rgba(29,92,168,.18); transition:outline-color .12s, box-shadow .12s; }
      .sr-gesture-hud { position:absolute; left:50%; bottom:12px; transform:translateX(-50%); z-index:998; pointer-events:none; background:rgba(15,23,42,.92); color:#f8fafc; border:1px solid #3b82f6; border-radius:9999px; padding:5px 12px; font-size:11.5px; font-weight:600; white-space:nowrap; box-shadow:0 8px 24px rgba(0,0,0,.28); opacity:0; transition:opacity .15s ease; }
      .sr-gesture-hud.visible { opacity:1; }
    `;
    document.head.appendChild(style);
  }

  function randId(len) {
    const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
    const arr = new Uint8Array(len);
    crypto.getRandomValues(arr);
    return Array.from(arr, b => chars[b % chars.length]).join('');
  }

  function esc(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  function buildWsUrl(base, room, token, role) {
    if (!base || !/^https?:\/\//i.test(base)) return null;
    const clean = base.replace(/\/+$/, '');
    const proto = clean.startsWith('https://') ? 'wss://' : 'ws://';
    const host = clean.replace(/^https?:\/\//i, '');
    return `${proto}${host}/ws?room=${encodeURIComponent(room)}&token=${encodeURIComponent(token)}&role=${role}`;
  }

  /* ==========================================================================
     3. SHARED PHONE CONTROLLER UI (Used on /remote AND in Simulator Drawer)
     ========================================================================== */
  function createControllerUI(mountEl, { isSim, sendMsg, onCloseSim }) {
    injectStyles();
    let pointerMode = 'dot';
    let notesOpen = false;
    let timerSec = 0, timerRun = false, timerId = null;

    const prevStyle = isSim
      ? 'min-height:56px;border-radius:12px;background:#1e293b;border:1px solid #334155;color:#f8fafc;font-weight:700;font-size:14px'
      : 'min-height:clamp(92px,16dvh,140px);border-radius:16px;background:#1e293b;border:1.5px solid #475569;color:#f8fafc;font-weight:700;font-size:18px';
    const nextStyle = isSim
      ? 'min-height:56px;border-radius:12px;background:#1d5ca8;border:none;color:#fff;font-weight:800;font-size:16px'
      : 'min-height:clamp(92px,16dvh,140px);border-radius:16px;background:#1d5ca8;border:none;color:#fff;font-weight:800;font-size:21px;box-shadow:0 6px 20px rgba(29,92,168,.35)';

    mountEl.innerHTML = `<div class="${isSim ? 'sr-sim-wrap' : 'sr-remote-wrap'}">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-shrink:0">
        <div data-sr="conn" style="display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:700;color:${isSim ? '#86efac' : '#fcd34d'}">
          <span style="width:8px;height:8px;border-radius:9999px;background:${isSim ? '#22c55e' : '#f59e0b'}"></span>
          <span>${isSim ? 'Phone Simulator' : 'Connecting…'}</span>
        </div>
        <div style="display:flex;align-items:center;gap:6px">
          <button data-sr="toggleNotes" aria-expanded="false" style="cursor:pointer;font-size:11px;font-weight:700;padding:4px 9px;border-radius:9999px;background:#1e293b;color:#94a3b8;border:1px solid #334155">Notes</button>
          <button data-sr="timer" style="cursor:pointer;font-family:ui-monospace,monospace;font-size:11px;padding:4px 9px;border-radius:9999px;background:#1e293b;color:#cbd5e1;border:1px solid #334155">00:00 ▸</button>
          ${isSim ? `<button data-sr="closeSim" style="cursor:pointer;background:transparent;border:none;color:#94a3b8;font-size:12px;padding:3px 6px">✕</button>` : ''}
        </div>
      </div>

      <div style="border-radius:12px;background:#1e293b;border:1px solid #334155;padding:8px 11px;flex-shrink:0">
        <div data-sr="meta" style="font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:#93c5fd;font-weight:700">Waiting for deck…</div>
        <div data-sr="title" style="font-size:13px;font-weight:700;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px">—</div>
      </div>

      <div data-sr="notesCard" style="display:none;border-radius:12px;background:rgba(30,41,59,.9);border:1px solid #334155;padding:9px 12px;max-height:22dvh;overflow-y:auto;flex-shrink:0">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:.06em;font-weight:700;color:#94a3b8;margin-bottom:4px">Speaker Notes</div>
        <div data-sr="notes" style="font-size:12.5px;line-height:1.45;color:#e2e8f0"></div>
      </div>

      <div data-sr="controls" style="display:none;border-radius:12px;background:rgba(23,37,84,.65);border:1px solid #1d5ca8;padding:9px 10px;flex-direction:column;gap:8px;flex-shrink:0"></div>

      <div style="display:flex;flex-direction:column;${isSim ? '' : 'flex:1;min-height:0;'}">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:5px;font-size:11px;color:#94a3b8;flex-shrink:0">
          <span style="font-weight:600">Touchpad Laser Pointer</span>
          <div style="display:flex;gap:4px">
            <button data-sr="modeDot" style="cursor:pointer;border:none;padding:3px 9px;border-radius:6px;font-size:10.5px;font-weight:700;background:#ef4444;color:#fff">Dot</button>
            <button data-sr="modeSpot" style="cursor:pointer;border:none;padding:3px 9px;border-radius:6px;font-size:10.5px;font-weight:700;background:#1e293b;color:#94a3b8">Spotlight</button>
          </div>
        </div>
        <div data-sr="pad" class="sr-pad">
          <div style="position:absolute;inset:0;opacity:.16;pointer-events:none;background-image:linear-gradient(to right,#64748b 1px,transparent 1px),linear-gradient(to bottom,#64748b 1px,transparent 1px);background-size:25% 25%"></div>
          <span data-sr="padHint" style="font-size:11.5px;color:#64748b;pointer-events:none;text-align:center;padding:0 12px">Drag finger here to point on slide</span>
          <div data-sr="thumb" style="display:none;position:absolute;width:16px;height:16px;margin:-8px 0 0 -8px;border-radius:9999px;background:#ef4444;box-shadow:0 0 0 4px rgba(239,68,68,.3);pointer-events:none"></div>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1.85fr;gap:10px;flex-shrink:0">
        <button data-sr="prev" class="sr-nav-btn" style="${prevStyle}">← Prev</button>
        <button data-sr="next" class="sr-nav-btn" style="${nextStyle}">Next →</button>
      </div>
    </div>`;

    const q = name => mountEl.querySelector(`[data-sr="${name}"]`);
    const pad = q('pad'), thumb = q('thumb'), modeDot = q('modeDot'), modeSpot = q('modeSpot');
    const notesBtn = q('toggleNotes'), notesCard = q('notesCard');

    notesBtn?.addEventListener('click', () => {
      notesOpen = !notesOpen;
      notesCard.style.display = notesOpen ? 'block' : 'none';
      notesBtn.setAttribute?.('aria-expanded', String(notesOpen));
      notesBtn.style.background = notesOpen ? '#1d5ca8' : '#1e293b';
      notesBtn.style.color = notesOpen ? '#fff' : '#94a3b8';
      notesBtn.style.borderColor = notesOpen ? 'transparent' : '#334155';
    });

    q('closeSim')?.addEventListener('click', () => onCloseSim?.());
    q('prev').addEventListener('click', () => { navigator.vibrate?.(12); sendMsg({ type: 'nav', action: 'prev' }); });
    q('next').addEventListener('click', () => { navigator.vibrate?.(12); sendMsg({ type: 'nav', action: 'next' }); });

    const setMode = (m) => {
      pointerMode = m;
      modeDot.style.background = m === 'dot' ? '#ef4444' : '#1e293b';
      modeDot.style.color = m === 'dot' ? '#fff' : '#94a3b8';
      modeSpot.style.background = m === 'spotlight' ? '#e07016' : '#1e293b';
      modeSpot.style.color = m === 'spotlight' ? '#fff' : '#94a3b8';
    };
    modeDot.addEventListener('click', () => setMode('dot'));
    modeSpot.addEventListener('click', () => setMode('spotlight'));

    const timerBtn = q('timer');
    const drawTimer = () => {
      const m = String(Math.floor(timerSec / 60)).padStart(2, '0');
      const s = String(timerSec % 60).padStart(2, '0');
      timerBtn.textContent = `${m}:${s} ${timerRun ? '❚❚' : '▸'}`;
    };
    timerBtn.addEventListener('click', () => {
      timerRun = !timerRun;
      clearInterval(timerId);
      drawTimer();
      if (timerRun) timerId = setInterval(() => { timerSec++; drawTimer(); }, 1000);
    });

    // Pointer / touch tracking (with lossless relative drag + tap detection)
    const padHint = q('padHint');
    let dragging = false, lastSent = 0, downTime = 0, downX = 0, downY = 0, prevX = 0, prevY = 0, accDx = 0, accDy = 0, moved = false;
    const padPos = (cx, cy) => {
      const r = pad.getBoundingClientRect();
      const w = r.width || 1, h = r.height || 1;
      return [
        Math.max(0, Math.min(1, (cx - r.left) / w)),
        Math.max(0, Math.min(1, (cy - r.top) / h))
      ];
    };
    const showThumb = (nx, ny) => {
      thumb.style.display = 'block';
      thumb.style.left = `${(nx * 100).toFixed(1)}%`;
      thumb.style.top = `${(ny * 100).toFixed(1)}%`;
    };
    pad.addEventListener('pointerdown', e => {
      dragging = true;
      moved = false;
      downTime = performance.now();
      pad.setPointerCapture?.(e.pointerId);
      const [nx, ny] = padPos(e.clientX, e.clientY);
      downX = prevX = nx;
      downY = prevY = ny;
      accDx = 0;
      accDy = 0;
      lastSent = downTime;
      showThumb(nx, ny);
      sendMsg({ type: 'pointer', phase: 'start', x: nx, y: ny, dx: 0, dy: 0, mode: pointerMode });
    });
    pad.addEventListener('pointermove', e => {
      if (!dragging) return;
      const [nx, ny] = padPos(e.clientX, e.clientY);
      accDx += nx - prevX;
      accDy += ny - prevY;
      prevX = nx;
      prevY = ny;
      if (!moved && Math.hypot(nx - downX, ny - downY) > 0.03) moved = true;
      showThumb(nx, ny);
      const now = performance.now();
      if (now - lastSent >= 18) {
        lastSent = now;
        const dx = accDx, dy = accDy;
        accDx = 0;
        accDy = 0;
        sendMsg({ type: 'pointer', phase: 'move', x: nx, y: ny, dx, dy, mode: pointerMode });
      }
    });
    const endDrag = (isCancel) => {
      if (!dragging) return;
      dragging = false;
      thumb.style.display = 'none';
      if (moved && (accDx !== 0 || accDy !== 0)) {
        sendMsg({ type: 'pointer', phase: 'move', x: prevX, y: prevY, dx: accDx, dy: accDy, mode: pointerMode });
        accDx = 0;
        accDy = 0;
      }
      if (!isCancel && !moved && (performance.now() - downTime) < 350) {
        navigator.vibrate?.(10);
        sendMsg({ type: 'pointer_tap', x: prevX, y: prevY, mode: pointerMode });
      }
      sendMsg({ type: 'pointer_hide' });
    };
    pad.addEventListener('pointerup', () => endDrag(false));
    pad.addEventListener('pointercancel', () => endDrag(true));

    function setGestureState(msg) {
      if (msg && msg.active) {
        pad.style.borderColor = '#3b82f6';
        pad.style.boxShadow = '0 0 0 2px rgba(59,130,246,.35)';
        if (padHint) {
          padHint.textContent = `${msg.label || 'Control'} · ${msg.hint || 'Drag to adjust · tap away to release'}`;
          padHint.style.color = '#93c5fd';
        }
      } else {
        pad.style.borderColor = '#334155';
        pad.style.boxShadow = 'none';
        if (padHint) {
          padHint.textContent = 'Drag finger here to point on slide';
          padHint.style.color = '#64748b';
        }
      }
    }

    function setConnectionStatus(status, peers) {
      if (isSim) return;
      const el = q('conn');
      if (status === 'connected' && peers > 0) {
        el.style.color = '#86efac';
        el.innerHTML = `<span style="width:8px;height:8px;border-radius:9999px;background:#22c55e"></span><span>Connected to Projector</span>`;
      } else if (status === 'connected') {
        el.style.color = '#fcd34d';
        el.innerHTML = `<span style="width:8px;height:8px;border-radius:9999px;background:#f59e0b"></span><span>Relay ready · waiting for projector</span>`;
      } else {
        el.style.color = '#fca5a5';
        el.innerHTML = `<span style="width:8px;height:8px;border-radius:9999px;background:#ef4444"></span><span>Reconnecting…</span>`;
      }
    }

    function renderState(st) {
      q('meta').textContent = `Slide ${st.id ?? (st.index + 1)} / ${st.total ?? '?'}${st.section ? ' · ' + st.section : ''}`;
      q('title').textContent = st.title || '—';
      q('notes').textContent = st.notes || 'No speaker notes on this slide.';

      const box = q('controls');
      if (!st.controls || !Array.isArray(st.controls.items) || st.controls.items.length === 0) {
        box.style.display = 'none';
        box.innerHTML = '';
        return;
      }
      box.style.display = 'flex';
      box.innerHTML = `<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#93c5fd">${esc(st.controls.title || 'Live Controls')}</div>`;

      const btnRow = document.createElement('div');
      btnRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px';
      let hasButtons = false;

      st.controls.items.forEach(item => {
        if (item.type === 'slider') {
          const row = document.createElement('div');
          row.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:11.5px;color:#cbd5e1';
          const lbl = document.createElement('span');
          lbl.style.cssText = 'min-width:74px;font-family:ui-monospace,monospace';
          lbl.textContent = `${item.label}: ${item.value}${item.suffix || ''}`;
          const inp = document.createElement('input');
          inp.type = 'range';
          inp.min = item.min; inp.max = item.max; inp.step = item.step || 1; inp.value = item.value;
          inp.style.flex = '1';
          inp.addEventListener('input', () => {
            const val = parseFloat(inp.value);
            lbl.textContent = `${item.label}: ${val}${item.suffix || ''}`;
            sendMsg({ type: 'action', action: item.action, payload: val });
          });
          row.append(lbl, inp);
          box.appendChild(row);
        } else {
          hasButtons = true;
          const b = document.createElement('button');
          b.textContent = item.label;
          const bg = item.active ? (item.color || '#1d5ca8') : (item.primary ? '#1d5ca8' : '#0f172a');
          const fg = (item.active || item.primary) ? '#fff' : '#e2e8f0';
          b.style.cssText = `cursor:pointer;border:1px solid ${item.active || item.primary ? 'transparent' : '#334155'};background:${bg};color:${fg};padding:6px 10px;border-radius:8px;font-size:11px;font-weight:700;${item.full ? 'width:100%' : ''}`;
          b.addEventListener('click', () => {
            navigator.vibrate?.(10);
            sendMsg({ type: 'action', action: item.action, payload: item.payload });
          });
          btnRow.appendChild(b);
        }
      });
      if (hasButtons) box.appendChild(btnRow);
    }

    return { setConnectionStatus, renderState, setGestureState };
  }

  /* ==========================================================================
     4. STANDALONE MOBILE CONTROLLER ENTRYPOINT (/remote?r=...&t=...)
     ========================================================================== */
  function mountMobileController(rootEl) {
    const params = new URLSearchParams(location.search);
    const room = params.get('r') || '';
    const token = params.get('t') || '';
    const relay = params.get('relay') || location.origin;

    let ws = null, reconnectTimer = null, peers = 0;

    const sendMsg = (msg) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify(msg)); } catch {}
      }
    };

    const ui = createControllerUI(rootEl, { isSim: false, sendMsg });

    async function keepAwake() {
      try { if ('wakeLock' in navigator) await navigator.wakeLock.request('screen'); } catch {}
    }
    keepAwake();

    function connect() {
      if (ws) { try { ws.close(); } catch {} ws = null; }
      clearTimeout(reconnectTimer);
      const wsUrl = buildWsUrl(relay, room, token, 'remote');
      if (!wsUrl) { ui.setConnectionStatus('offline', 0); return; }
      ws = new WebSocket(wsUrl);
      ws.onopen = () => { ui.setConnectionStatus('connected', peers); sendMsg({ type: 'request_state' }); };
      ws.onmessage = (ev) => {
        let msg; try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === 'presence') { peers = msg.decks || 0; ui.setConnectionStatus('connected', peers); }
        else if (msg.type === 'state') ui.renderState(msg);
        else if (msg.type === 'gesture_state') ui.setGestureState(msg);
      };
      ws.onclose = () => { ui.setGestureState({ active: false }); ui.setConnectionStatus('offline', 0); reconnectTimer = setTimeout(connect, 2200); };
      ws.onerror = () => {};
    }

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        keepAwake();
        if (!ws || ws.readyState !== WebSocket.OPEN) connect();
      }
    });
    connect();
  }

  /* ==========================================================================
     5. REUSABLE STAGE GESTURE CONTROLS (Registry + Built-in Handlers)
     ========================================================================== */
  function clampNum(v, min, max) {
    return Math.min(max, Math.max(min, v));
  }

  function dispatchSimpleEvent(el, name) {
    if (!el || typeof el.dispatchEvent !== 'function' || typeof Event !== 'function') return;
    el.dispatchEvent(new Event(name, { bubbles: true }));
  }

  function dispatchCustomEvent(el, name, detail) {
    if (!el || typeof el.dispatchEvent !== 'function') return;
    if (typeof CustomEvent === 'function') {
      el.dispatchEvent(new CustomEvent(name, { bubbles: true, detail }));
    }
  }

  function createRangeSliderHandler(axis) {
    return {
      hint: axis === 'y'
        ? 'Drag ↑ ↓ to adjust · tap away to release'
        : 'Drag ← → to adjust · tap away to release',
      onActivate(ctx) {
        const { el, target, config } = ctx;
        const inp = (target && target.type === 'range')
          ? target
          : ((el.tagName === 'INPUT' && el.type === 'range') ? el : el.querySelector?.('input[type="range"]'));
        if (!inp) return false;
        const min = Number.isFinite(Number(inp.min)) && inp.min !== '' ? Number(inp.min) : 0;
        const max = Number.isFinite(Number(inp.max)) && inp.max !== '' ? Number(inp.max) : 100;
        const step = Number(inp.step) > 0 ? Number(inp.step) : 1;
        const decMatch = String(step).match(/\.(\d+)/);
        const decimals = decMatch ? decMatch[1].length : 0;
        const current = Number.isFinite(Number(inp.value)) ? Number(inp.value) : min;
        ctx.state = {
          inp,
          min,
          max,
          step,
          decimals,
          raw: current,
          lastApplied: current,
          sensitivity: Number(config.sensitivity) > 0 ? Number(config.sensitivity) : 1.4,
          invert: config.invert === true || config.invert === 'true'
        };
      },
      onDrag(ctx) {
        const s = ctx.state;
        if (!s) return;
        const deltaNorm = axis === 'y' ? -(ctx.dy || 0) : (ctx.dx || 0);
        const signed = s.invert ? -deltaNorm : deltaNorm;
        const span = s.max - s.min;
        if (span <= 0) return;
        s.raw = clampNum(s.raw + signed * span * s.sensitivity, s.min, s.max);
        const snapped = s.min + Math.round((s.raw - s.min) / s.step) * s.step;
        const val = Number(clampNum(snapped, s.min, s.max).toFixed(s.decimals));
        if (val !== s.lastApplied) {
          s.lastApplied = val;
          s.inp.value = String(val);
          dispatchSimpleEvent(s.inp, 'input');
          dispatchSimpleEvent(s.inp, 'change');
        }
      }
    };
  }

  const gestureTypes = {
    'slider-x': createRangeSliderHandler('x'),
    'slider-y': createRangeSliderHandler('y'),
    counter: {
      hint: 'Tap to step · drag ← → to adjust · tap away to release',
      onActivate(ctx) {
        const { el, target, config } = ctx;
        const vt = config.valueTarget ? (el.querySelector?.(config.valueTarget) || document.querySelector?.(config.valueTarget)) : target;
        const step = Number(config.step) > 0 ? Number(config.step) : 1;
        const min = config.min !== undefined && config.min !== '' && Number.isFinite(Number(config.min)) ? Number(config.min) : -Infinity;
        const max = config.max !== undefined && config.max !== '' && Number.isFinite(Number(config.max)) ? Number(config.max) : Infinity;
        const rawInit = el.dataset?.srValue !== undefined ? Number(el.dataset.srValue) : (('value' in vt && vt.value !== undefined && vt.value !== '') ? Number(vt.value) : parseFloat(vt?.textContent || '0'));
        const value = Number.isFinite(rawInit) ? rawInit : 0;
        ctx.state = { vt: vt || el, step, min, max, value, dragAccum: 0 };
        const applyDelta = (delta) => {
          const s = ctx.state;
          const next = clampNum(s.value + delta, s.min, s.max);
          if (next === s.value) return;
          s.value = next;
          if (el.dataset) el.dataset.srValue = String(next);
          if (s.vt && 'value' in s.vt && s.vt.tagName === 'INPUT') s.vt.value = String(next);
          else if (s.vt) s.vt.textContent = String(next);
          dispatchCustomEvent(el, 'sr-gesture-change', { value: next, delta, type: 'counter' });
        };
        ctx.state.applyDelta = applyDelta;
        if (config.activateStep !== false && config.activateStep !== 'false') {
          applyDelta(step);
        }
      },
      onTap(ctx) {
        ctx.state?.applyDelta(ctx.state.step);
      },
      onDrag(ctx) {
        const s = ctx.state;
        if (!s) return;
        s.dragAccum += (ctx.dx || 0);
        const unit = 0.08;
        while (Math.abs(s.dragAccum) >= unit) {
          const dir = s.dragAccum > 0 ? 1 : -1;
          s.dragAccum -= dir * unit;
          s.applyDelta(dir * s.step);
        }
      }
    },
    resize: {
      hint: 'Drag to resize · tap away to release',
      onActivate(ctx) {
        const { el, target, config } = ctx;
        const box = target || el;
        const rect = box.getBoundingClientRect ? box.getBoundingClientRect() : { width: 120, height: 80 };
        const w = rect.width || box.offsetWidth || 120;
        const h = rect.height || box.offsetHeight || 80;
        ctx.state = {
          box,
          w,
          h,
          ratio: w / Math.max(1, h),
          minW: Number(config.minW) > 0 ? Number(config.minW) : 40,
          maxW: Number(config.maxW) > 0 ? Number(config.maxW) : Infinity,
          minH: Number(config.minH) > 0 ? Number(config.minH) : 40,
          maxH: Number(config.maxH) > 0 ? Number(config.maxH) : Infinity,
          aspect: config.aspect === true || config.aspect === 'true'
        };
      },
      onDrag(ctx) {
        const s = ctx.state;
        if (!s) return;
        const sw = ctx.stageRect?.width || 1000;
        const sh = ctx.stageRect?.height || 562.5;
        const dxPx = (ctx.dx || 0) * sw;
        const dyPx = (ctx.dy || 0) * sh;
        s.w = clampNum(s.w + dxPx, s.minW, s.maxW);
        if (s.aspect) {
          s.h = clampNum(s.w / Math.max(0.01, s.ratio), s.minH, s.maxH);
        } else {
          s.h = clampNum(s.h + dyPx, s.minH, s.maxH);
        }
        const rw = Math.round(s.w), rh = Math.round(s.h);
        if (s.box.style) {
          s.box.style.width = `${rw}px`;
          s.box.style.height = `${rh}px`;
        }
        dispatchCustomEvent(ctx.el, 'sr-gesture-resize', { width: rw, height: rh });
      }
    },
    toggle: {
      hint: 'Tap to toggle',
      onActivate(ctx) {
        (ctx.target || ctx.el).click?.();
        return false;
      }
    }
  };

  function registerGestureType(name, handler) {
    if (!name || !handler) return;
    gestureTypes[name] = handler;
  }

  /* ==========================================================================
     6. PROJECTOR DECK INTEGRATION: SlideRemote.init(options)
     ========================================================================== */
  function init(opts = {}) {
    injectStyles();
    const { stageSelector = '#slideStage', getState, onNav, onAction, onStatusChange, bindKeyR = true, gesture = {} } = opts;
    const gestureOpts = {
      activateRadius: Number(gesture.activateRadius) > 0 ? Number(gesture.activateRadius) : 0.045,
      deactivateRadius: Number(gesture.deactivateRadius) > 0 ? Number(gesture.deactivateRadius) : 0.09
    };
    const params = new URLSearchParams(location.search);

    function safeGet(kind, key) { try { return global[kind]?.getItem(key) ?? null; } catch { return null; } }
    function safeSet(kind, key, val) { try { global[kind]?.setItem(key, val); } catch {} }
    function safeRemove(kind, key) { try { global[kind]?.removeItem(key); } catch {} }

    let room = safeGet('sessionStorage', 'sr_room') || randId(6);
    let token = safeGet('sessionStorage', 'sr_token') || randId(10);
    safeSet('sessionStorage', 'sr_room', room);
    safeSet('sessionStorage', 'sr_token', token);

    const isHttpUrl = (u) => Boolean(u && /^https?:\/\//i.test(u));
    const defaults = global.SLIDE_REMOTE_DEFAULTS || {};

    let relayBase = params.get('relay') || safeGet('localStorage', 'sr_relay_base') || opts.relayBase || defaults.relayBase ||
      ((location.protocol === 'http:' || location.protocol === 'https:') ? location.origin : '');
    let backupRelay = params.get('backup') || safeGet('localStorage', 'sr_backup_relay') || opts.backupRelay || defaults.backupRelay || '';
    let usingBackup = false;

    let ws = null, reconnectTimer = null, connectTimer = null, remoteCount = 0;
    let modalEl = null, simEl = null, simUI = null, laserEl = null, laserVis = null, laserTimer = null;
    let hudEl = null, activeGesture = null, hoveredEl = null;
    const manualGestures = [];

    function ensureLaser() {
      const stage = document.querySelector(stageSelector);
      if (!stage) return null;
      if (getComputedStyle(stage).position === 'static') stage.style.position = 'relative';
      if (!laserEl || !stage.contains(laserEl)) {
        laserEl = document.createElement('div');
        laserEl.className = 'sr-laser';
        laserVis = document.createElement('div');
        laserVis.className = 'sr-laser-dot';
        laserEl.appendChild(laserVis);
        stage.appendChild(laserEl);
      }
      return stage;
    }

    function ensureHud(stage) {
      if (!stage) return null;
      if (!hudEl || !stage.contains(hudEl)) {
        hudEl = document.createElement('div');
        hudEl.className = 'sr-gesture-hud';
        stage.appendChild(hudEl);
      }
      return hudEl;
    }

    function showLaser(nx, ny, mode, duration = 2200) {
      const stage = ensureLaser();
      if (!stage) return;
      const x = Math.max(0, Math.min(1, nx)) * stage.clientWidth;
      const y = Math.max(0, Math.min(1, ny)) * stage.clientHeight;
      laserVis.className = mode === 'spotlight' ? 'sr-laser-spot' : 'sr-laser-dot';
      laserEl.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
      laserEl.classList.add('visible');
      clearTimeout(laserTimer);
      laserTimer = setTimeout(hideLaser, duration);
    }

    function hideLaser() {
      if (laserEl) laserEl.classList.remove('visible');
    }

    function sendGestureState(payload) {
      const msg = { ...payload, type: 'gesture_state' };
      if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify(msg)); } catch {}
      }
      if (simUI) simUI.setGestureState?.(msg);
    }

    function clearHover() {
      if (hoveredEl) {
        hoveredEl.classList?.remove('sr-gesture-hover');
        hoveredEl = null;
      }
    }

    function parseDomGestureConfig(el) {
      const ds = el.dataset || {};
      return {
        type: ds.srGesture,
        label: ds.srLabel || '',
        target: ds.srTarget || '',
        sensitivity: ds.srSensitivity,
        radius: ds.srRadius,
        step: ds.srStep,
        min: ds.srMin,
        max: ds.srMax,
        invert: ds.srInvert,
        aspect: ds.srAspect,
        minW: ds.srMinW,
        maxW: ds.srMaxW,
        minH: ds.srMinH,
        maxH: ds.srMaxH,
        valueTarget: ds.srValueTarget,
        activateStep: ds.srActivateStep
      };
    }

    function getGestureEntries(stage) {
      const entries = [];
      const seen = new Set();
      for (const m of manualGestures) {
        if (m.el && stage.contains(m.el)) {
          entries.push(m);
          seen.add(m.el);
        }
      }
      const nodes = stage.querySelectorAll ? stage.querySelectorAll('[data-sr-gesture]') : [];
      for (const el of nodes) {
        if (seen.has(el)) continue;
        const config = parseDomGestureConfig(el);
        if (config.type) entries.push({ el, type: config.type, config });
      }
      return entries;
    }

    function measureControls(stage, nx, ny) {
      const entries = getGestureEntries(stage);
      if (entries.length === 0) return [];
      const sr = stage.getBoundingClientRect();
      const sw = sr.width || stage.clientWidth || 1;
      const sh = sr.height || stage.clientHeight || 1;
      const diag = Math.hypot(sw, sh) || 1;
      const px = sr.left + clampNum(nx, 0, 1) * sw;
      const py = sr.top + clampNum(ny, 0, 1) * sh;
      return entries.map(entry => {
        const er = entry.el.getBoundingClientRect();
        const cx = clampNum(px, er.left, er.right);
        const cy = clampNum(py, er.top, er.bottom);
        const distPx = Math.hypot(px - cx, py - cy);
        const centerDistPx = Math.hypot(px - (er.left + er.width / 2), py - (er.top + er.height / 2));
        return {
          entry,
          er,
          sr,
          distPx,
          normDist: distPx / diag,
          centerDistPx
        };
      }).sort((a, b) => (a.normDist - b.normDist) || (a.centerDistPx - b.centerDistPx));
    }

    function resolveTarget(el, config) {
      if (!config.target) return el;
      if (typeof config.target === 'string') {
        return el.querySelector?.(config.target) || document.querySelector?.(config.target) || el;
      }
      return config.target;
    }

    function buildGestureCtx(active, stage, extra = {}) {
      const stageRect = stage?.getBoundingClientRect ? stage.getBoundingClientRect() : { left: 0, top: 0, width: 1, height: 1 };
      const elRect = active.el.getBoundingClientRect ? active.el.getBoundingClientRect() : { left: 0, top: 0, width: 1, height: 1 };
      return {
        el: active.el,
        target: active.target,
        config: active.config,
        stage,
        stageRect,
        elRect,
        state: active.state,
        ...extra
      };
    }

    function deactivateGesture() {
      if (!activeGesture) return;
      const prev = activeGesture;
      const stage = document.querySelector(stageSelector);
      try {
        prev.handler.onDeactivate?.(buildGestureCtx(prev, stage));
      } catch {}
      prev.el.classList?.remove('sr-gesture-active');
      if (hudEl) hudEl.classList.remove('visible');
      activeGesture = null;
      sendGestureState({ active: false });
    }

    function activateGesture(entry, stage, nx, ny) {
      const handler = gestureTypes[entry.type];
      if (!handler) return false;
      if (activeGesture && activeGesture.el !== entry.el) {
        deactivateGesture();
      }
      clearHover();
      const target = resolveTarget(entry.el, entry.config);
      const next = {
        el: entry.el,
        target,
        type: entry.type,
        config: entry.config,
        handler,
        state: null,
        strokeStart: { x: nx, y: ny },
        strokeLast: { x: nx, y: ny },
        totalDx: 0,
        totalDy: 0
      };
      const ctx = buildGestureCtx(next, stage, { nx, ny });
      const res = handler.onActivate?.(ctx);
      next.state = ctx.state;
      if (res === false) {
        return false;
      }
      activeGesture = next;
      entry.el.classList?.add('sr-gesture-active');
      hideLaser();
      const label = entry.config.label || entry.type;
      const hint = entry.config.hint || handler.hint || 'Drag to adjust · tap away to release';
      const hud = ensureHud(stage);
      if (hud) {
        hud.textContent = `● ${label} · ${hint}`;
        hud.classList.add('visible');
      }
      sendGestureState({ active: true, label, hint, gestureType: entry.type });
      return true;
    }

    function registerGesture(elOrSelector, config = {}) {
      const el = typeof elOrSelector === 'string' ? document.querySelector(elOrSelector) : elOrSelector;
      if (!el) return () => {};
      const entry = { el, type: config.type || el.dataset?.srGesture || 'slider-x', config };
      manualGestures.push(entry);
      return () => {
        const idx = manualGestures.indexOf(entry);
        if (idx !== -1) manualGestures.splice(idx, 1);
        if (activeGesture?.el === el) deactivateGesture();
      };
    }

    function handleCommand(msg) {
      if (!msg || !msg.type) return;
      const stage = document.querySelector(stageSelector);
      if (activeGesture && (!stage || !stage.contains(activeGesture.el))) {
        deactivateGesture();
      }
      if (msg.type === 'request_state') {
        sync();
      } else if (msg.type === 'nav') {
        deactivateGesture();
        hideLaser();
        onNav?.(msg.action, msg.index);
      } else if (msg.type === 'pointer_tap') {
        if (!stage) return;
        const measured = measureControls(stage, msg.x, msg.y);
        if (!activeGesture) {
          const hit = measured[0];
          const rad = hit ? (Number(hit.entry.config.radius) > 0 ? Number(hit.entry.config.radius) : gestureOpts.activateRadius) : 0;
          if (hit && hit.normDist <= rad) {
            activateGesture(hit.entry, stage, msg.x, msg.y);
          } else {
            showLaser(msg.x, msg.y, msg.mode || 'dot', 500);
          }
          return;
        }
        const activeM = measured.find(m => m.entry.el === activeGesture.el);
        const otherHit = measured.find(m => {
          if (m.entry.el === activeGesture.el) return false;
          const r = Number(m.entry.config.radius) > 0 ? Number(m.entry.config.radius) : gestureOpts.activateRadius;
          return m.normDist <= r;
        });
        const activeDist = activeM ? activeM.normDist : Infinity;
        if (otherHit && otherHit.normDist < activeDist) {
          activateGesture(otherHit.entry, stage, msg.x, msg.y);
        } else if (activeDist <= gestureOpts.deactivateRadius) {
          const ctx = buildGestureCtx(activeGesture, stage, { nx: msg.x, ny: msg.y });
          activeGesture.handler.onTap?.(ctx);
        } else {
          deactivateGesture();
        }
      } else if (msg.type === 'pointer') {
        if (activeGesture && stage) {
          if (msg.phase === 'start' || !activeGesture.strokeLast) {
            activeGesture.strokeStart = { x: msg.x, y: msg.y };
            activeGesture.strokeLast = { x: msg.x, y: msg.y };
            activeGesture.totalDx = 0;
            activeGesture.totalDy = 0;
            if (msg.phase === 'start') {
              activeGesture.handler.onDragStart?.(buildGestureCtx(activeGesture, stage, { nx: msg.x, ny: msg.y, dx: 0, dy: 0, totalDx: 0, totalDy: 0 }));
              return;
            }
          }
          const dx = typeof msg.dx === 'number' ? msg.dx : (msg.x - activeGesture.strokeLast.x);
          const dy = typeof msg.dy === 'number' ? msg.dy : (msg.y - activeGesture.strokeLast.y);
          activeGesture.strokeLast = { x: msg.x, y: msg.y };
          activeGesture.totalDx += dx;
          activeGesture.totalDy += dy;
          activeGesture.handler.onDrag?.(buildGestureCtx(activeGesture, stage, {
            nx: msg.x,
            ny: msg.y,
            dx,
            dy,
            totalDx: activeGesture.totalDx,
            totalDy: activeGesture.totalDy
          }));
          return;
        }
        showLaser(msg.x, msg.y, msg.mode || 'dot');
        if (stage) {
          const measured = measureControls(stage, msg.x, msg.y);
          const hit = measured[0];
          const rad = hit ? (Number(hit.entry.config.radius) > 0 ? Number(hit.entry.config.radius) : gestureOpts.activateRadius) : 0;
          const nextHover = (hit && hit.normDist <= rad) ? hit.entry.el : null;
          if (nextHover !== hoveredEl) {
            clearHover();
            if (nextHover) {
              nextHover.classList?.add('sr-gesture-hover');
              hoveredEl = nextHover;
            }
          }
        }
      } else if (msg.type === 'pointer_hide') {
        clearHover();
        if (activeGesture && stage) {
          activeGesture.handler.onDragEnd?.(buildGestureCtx(activeGesture, stage, {
            totalDx: activeGesture.totalDx,
            totalDy: activeGesture.totalDy
          }));
        }
        hideLaser();
      } else if (msg.type === 'action') {
        onAction?.(msg.action, msg.payload);
      }
    }

    function sync() {
      const stage = document.querySelector(stageSelector);
      if (activeGesture && (!stage || !stage.contains(activeGesture.el))) {
        deactivateGesture();
      }
      if (typeof getState !== 'function') return;
      const st = { type: 'state', ...getState() };
      if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify(st)); } catch {}
      }
      if (simUI) simUI.renderState(st);
    }

    function getActiveBase() {
      if (usingBackup && isHttpUrl(backupRelay)) return backupRelay;
      if (isHttpUrl(relayBase)) return relayBase;
      if (isHttpUrl(backupRelay)) return backupRelay;
      return '';
    }

    function getPairingUrl() {
      const active = getActiveBase();
      const base = active ? active.replace(/\/+$/, '') : 'https://<your-machine>.<your-tailnet>.ts.net:10000';
      return `${base}/remote?r=${encodeURIComponent(room)}&t=${encodeURIComponent(token)}`;
    }

    function emitStatus(status) {
      onStatusChange?.({ status, remotes: remoteCount, usingBackup });
      updateModalStatus(status);
    }

    function connect(preferBackup = false) {
      clearTimeout(reconnectTimer);
      clearTimeout(connectTimer);
      if (ws) {
        ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
        try { ws.close(); } catch {}
        ws = null;
      }
      remoteCount = 0;

      const hasPrimary = isHttpUrl(relayBase);
      const hasBackup = isHttpUrl(backupRelay);
      const canFailoverToBackup = hasBackup && backupRelay !== relayBase;
      usingBackup = (preferBackup && hasBackup) || (!hasPrimary && hasBackup);

      const targetBase = getActiveBase();
      const wsUrl = buildWsUrl(targetBase, room, token, 'deck');
      if (!wsUrl) { emitStatus('local'); return; }

      emitStatus('connecting');
      let sock;
      try { sock = new WebSocket(wsUrl); } catch {
        if (!usingBackup && canFailoverToBackup) { connect(true); return; }
        emitStatus('offline');
        reconnectTimer = setTimeout(() => connect(false), 2500);
        return;
      }
      ws = sock;
      let opened = false;

      if (!usingBackup && canFailoverToBackup) {
        connectTimer = setTimeout(() => {
          if (sock !== ws || opened) return;
          connect(true);
        }, 5000);
      }

      sock.onopen = () => {
        if (sock !== ws) return;
        clearTimeout(connectTimer);
        opened = true;
        refreshModal();
        emitStatus('connected');
        sync();
      };
      sock.onmessage = (ev) => {
        if (sock !== ws) return;
        let msg; try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === 'presence') {
          remoteCount = msg.remotes || 0;
          emitStatus('connected');
          if (remoteCount > 0) sync();
        } else {
          handleCommand(msg);
        }
      };
      sock.onclose = () => {
        if (sock !== ws) return;
        clearTimeout(connectTimer);
        ws = null;
        remoteCount = 0;
        // Automatic failover: if primary failed to open and a backup relay is configured, switch immediately
        if (!opened && !usingBackup && canFailoverToBackup) {
          connect(true);
          return;
        }
        emitStatus('offline');
        const nextPreferBackup = (!opened && usingBackup && hasPrimary) ? false : usingBackup;
        reconnectTimer = setTimeout(() => connect(nextPreferBackup), 2500);
      };
      sock.onerror = () => {};
    }

    function updateModalStatus(status) {
      if (!modalEl) return;
      const el = modalEl.querySelector('[data-sr-m="status"]');
      if (!el) return;
      const tag = usingBackup ? ' (Backup)' : '';
      if (status === 'connected' && remoteCount > 0) el.innerHTML = `<span style="color:#15803d;font-weight:700">● ${remoteCount} phone connected${tag}</span>`;
      else if (status === 'connected') el.innerHTML = `<span style="color:#1d5ca8;font-weight:600">● Relay ready${tag} · scan QR</span>`;
      else if (status === 'connecting') el.innerHTML = `<span style="color:#5b6472">Connecting${tag}…</span>`;
      else if (status === 'local') el.innerHTML = `<span>Local preview · paste Relay URL or test Simulator</span>`;
      else el.innerHTML = `<span style="color:#b34712">Relay offline · trying backup / reconnect</span>`;
    }

    function openSimulator() {
      if (simEl) return;
      simEl = document.createElement('div');
      simEl.className = 'sr-sim-drawer';
      document.body.appendChild(simEl);
      simUI = createControllerUI(simEl, {
        isSim: true,
        sendMsg: handleCommand,
        onCloseSim: () => { simEl.remove(); simEl = null; simUI = null; deactivateGesture(); hideLaser(); }
      });
      sync();
    }

    function openModal() {
      if (modalEl) { closeModal(); return; }
      const link = getPairingUrl();
      modalEl = document.createElement('div');
      modalEl.className = 'sr-modal-bg';
      modalEl.innerHTML = `
        <div class="sr-modal">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:1px solid #e2ddd3;padding-bottom:10px;margin-bottom:14px">
            <div>
              <div style="font-size:16px;font-weight:800">Phone Controller &amp; Laser Pointer</div>
              <div style="font-size:12px;color:#5b6472;margin-top:2px">Scan with your phone camera — no Tailscale needed on the projector PC.</div>
            </div>
            <button data-sr-m="close" class="sr-btn" style="background:#f1f5f9;color:#14213d">Esc</button>
          </div>
          <div style="display:grid;grid-template-columns:168px 1fr;gap:16px;align-items:center">
            <div style="display:flex;flex-direction:column;align-items:center;gap:8px">
              <div data-sr-m="qr" style="width:160px;height:160px;padding:8px;background:#fff;border:1px solid #d9d2c7;border-radius:12px">${renderQRSvg(link)}</div>
              <div data-sr-m="status" style="font-size:11px;text-align:center;color:#5b6472"></div>
            </div>
            <div style="display:flex;flex-direction:column;gap:9px;font-size:12px">
              <div>
                <div style="font-size:11px;font-weight:700;color:#5b6472;margin-bottom:3px">Primary Relay (Tailscale Funnel)</div>
                <input data-sr-m="relay" value="${esc(relayBase)}" placeholder="https://machine.tailnet.ts.net:10000" />
              </div>
              <div>
                <div style="font-size:11px;font-weight:700;color:#5b6472;margin-bottom:3px">Backup Relay (Cloudflare Worker · auto-failover)</div>
                <div style="display:flex;gap:6px">
                  <input data-sr-m="backup" value="${esc(backupRelay)}" placeholder="https://slides-remote.you.workers.dev" />
                  <button data-sr-m="connect" class="sr-btn" style="background:#1d5ca8;color:#fff;white-space:nowrap">Connect</button>
                </div>
              </div>
              <div>
                <div style="font-size:11px;font-weight:700;color:#5b6472;margin-bottom:3px">Phone Remote Link</div>
                <div style="display:flex;gap:6px">
                  <input data-sr-m="link" readonly value="${esc(link)}" />
                  <button data-sr-m="copy" class="sr-btn" style="background:#ece8e1;color:#14213d">Copy</button>
                </div>
              </div>
              <div style="display:flex;gap:8px;flex-wrap:wrap;padding-top:2px">
                <button data-sr-m="sim" class="sr-btn" style="background:#b34712;color:#fff">📱 Test Phone Simulator</button>
                <button data-sr-m="regen" class="sr-btn" style="background:#f1f5f9;color:#475569">New PIN</button>
              </div>
            </div>
          </div>
        </div>`;
      modalEl.addEventListener('click', e => { if (e.target === modalEl) closeModal(); });
      modalEl.querySelector('[data-sr-m="close"]').onclick = closeModal;
      modalEl.querySelector('[data-sr-m="connect"]').onclick = () => {
        relayBase = modalEl.querySelector('[data-sr-m="relay"]').value.trim().replace(/\/+$/, '');
        backupRelay = modalEl.querySelector('[data-sr-m="backup"]').value.trim().replace(/\/+$/, '');
        if (relayBase) safeSet('localStorage', 'sr_relay_base', relayBase);
        else safeRemove('localStorage', 'sr_relay_base');
        if (backupRelay) safeSet('localStorage', 'sr_backup_relay', backupRelay);
        else safeRemove('localStorage', 'sr_backup_relay');
        connect(false);
        refreshModal();
      };
      modalEl.querySelector('[data-sr-m="copy"]').onclick = (e) => {
        const inp = modalEl.querySelector('[data-sr-m="link"]');
        navigator.clipboard?.writeText(inp.value).catch(() => { inp.select(); document.execCommand('copy'); });
        e.target.textContent = 'Copied!';
        setTimeout(() => { e.target.textContent = 'Copy'; }, 1200);
      };
      modalEl.querySelector('[data-sr-m="sim"]').onclick = () => { closeModal(); openSimulator(); };
      modalEl.querySelector('[data-sr-m="regen"]').onclick = () => {
        room = randId(6); token = randId(10);
        safeSet('sessionStorage', 'sr_room', room); safeSet('sessionStorage', 'sr_token', token);
        connect(false);
        refreshModal();
      };
      document.body.appendChild(modalEl);
      const initStatus = !getActiveBase()
        ? 'local'
        : (ws && ws.readyState === WebSocket.OPEN
          ? 'connected'
          : (ws && ws.readyState === WebSocket.CONNECTING ? 'connecting' : 'offline'));
      updateModalStatus(initStatus);
    }

    function refreshModal() {
      if (!modalEl) return;
      const link = getPairingUrl();
      modalEl.querySelector('[data-sr-m="link"]').value = link;
      modalEl.querySelector('[data-sr-m="qr"]').innerHTML = renderQRSvg(link);
    }

    function closeModal() {
      if (modalEl) { modalEl.remove(); modalEl = null; }
    }

    if (bindKeyR) {
      document.addEventListener('keydown', (e) => {
        if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
        if (e.key === 'r' || e.key === 'R') openModal();
        else if (e.key === 'Escape') { deactivateGesture(); closeModal(); }
      });
    }

    connect();
    return {
      sync,
      openModal,
      closeModal,
      openSimulator,
      hideLaser,
      registerGesture,
      deactivateGesture,
      getActiveGesture: () => activeGesture ? { el: activeGesture.el, type: activeGesture.type, config: activeGesture.config } : null
    };
  }

  global.SlideRemote = { init, mountMobileController, renderQRSvg, registerGestureType, gestureTypes };
})(window);
