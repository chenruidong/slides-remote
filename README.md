# slides-remote

Turn your smartphone into a touch controller and laser pointer for **any** HTML presentation — with zero dependencies, zero cloud accounts, and **no software or Tailscale needed on the projector computer**.

```
[Any Projector PC Browser]  ──HTTPS/WSS──▶  [Your Tailnet Machine]  ◀──HTTPS/WSS──  [Your Phone]
   (no Tailscale needed)                     node server.mjs +                       Touchpad laser,
                                             tailscale funnel                        Prev/Next, notes,
                                                                                     & live demo sliders
```

## Features
- **Zero `npm install`, zero third-party cloud:** Pure Node.js (18+) HTTP + RFC-6455 WebSocket relay (`server.mjs`) and self-contained drop-in browser script (`remote.js`).
- **Touchpad laser pointer & spotlight ring:** Drag your thumb on a 16:9 dark touchpad on your phone to move a smooth red laser dot or orange spotlight ring directly on the projected slide (zero gyroscope drift).
- **Synced speaker notes & talk timer:** Read your speaker notes and elapsed time on your phone while the projector stays uncluttered.
- **Declarative live demo controls:** Interactive slides can expose custom toggle buttons, prompt chips, or sliders directly on your phone screen (see `decks/ai-presentations.html` Slides 23–26 and `decks/starter.html` Slide 3).
- **Built-in scannable QR code pairing (`R`):** Generates a per-session random room & secret PIN (pure-JS ISO/IEC 18004 QR generator — no external CDN).
- **In-page Phone Simulator:** Press `R` → **Test Phone Simulator** to test pointer and controls on one screen before stepping on stage.

---

## Quick Start (Tailscale Funnel)

Run this on any always-on machine on your Tailnet (Mac mini, lab workstation, Linux box):

1. **Start the relay server:**
   ```bash
   node server.mjs
   ```
   *(Listens on `127.0.0.1:8787` by default. Set `PORT=8787` or `DECK=decks/ai-presentations.html` to customize.)*

2. **Expose it publicly with Tailscale Funnel:**
   ```bash
   tailscale funnel 8787
   ```
   > **Port `443` already in use by `tailscale serve`?** Tailscale Funnel also supports `--https=8443` and `--https=10000`:
   > ```bash
   > tailscale funnel --https=10000 8787
   > ```

3. **Present from *any* computer** (even an unfamiliar podium PC not on Tailscale):
   - Open your Funnel URL (e.g. `https://<your-machine>.<your-tailnet>.ts.net:10000/`).
   - Pick a deck from `decks/` (try `ai-presentations.html` or `starter.html`).
   - Press **`R`** before the talk starts and scan the QR code with your phone camera.
   - Press **`F`** for fullscreen. Standard keyboard arrows (`←` / `→`) always stay active as a fallback.

---

## Adding Your Own HTML Deck

Drop any `.html` file into `decks/` and refresh `/` — `server.mjs` lists it automatically without restarting.

To wire **any** HTML presentation (custom HTML, Reveal.js, Livedeck, etc.) into `slides-remote`, include `/remote.js` and call `SlideRemote.init(...)`:

```html
<script src="/remote.js"></script>
<script>
  const remote = SlideRemote.init({
    stageSelector: '#slideStage',          // Element where the laser dot overlays
    getState: () => ({
      id: currentIndex + 1,
      total: slides.length,
      section: 'Intro',
      title: slides[currentIndex].title,
      notes: slides[currentIndex].notes,
      // Optional: slide-specific buttons/sliders rendered on your phone!
      controls: null
    }),
    onNav: (action) => {
      if (action === 'next') nextSlide();
      else if (action === 'prev') prevSlide();
    },
    onAction: (action, payload) => {
      // Handle custom controls from your phone
    }
  });

  // Call remote.sync() whenever your slide or interactive state updates
</script>
```

See [`decks/starter.html`](decks/starter.html) for a complete ~90-line working example, or [`decks/ai-presentations.html`](decks/ai-presentations.html) for a full 26-slide talk that looks like a classic slide deck and reveals live interactive plots, Q&A prompt editing, real-time rule checking, and a 1-page handout generator at the end.

---

## Backup Relay: Cloudflare Worker (When Your Tailnet Machine Is Offline)

Want phone control to keep working even if your home/lab machine is asleep *and* you're presenting on a locked-down podium PC? Deploy the included free-tier Cloudflare Worker once (~1 minute):

```bash
cd cloudflare-worker
npx wrangler login
npx wrangler deploy
```

Cloudflare prints a permanent HTTPS/WSS URL such as `https://slides-remote.<your-subdomain>.workers.dev`.

* **Automatic failover:** Press **`R`** in any deck, paste your `workers.dev` URL into **Backup Relay**, and click **Connect** (or pass `backupRelay: 'https://...'` in `SlideRemote.init`). If your Tailscale Funnel machine is unreachable, `remote.js` automatically fails over to the Cloudflare Worker and updates the QR code.
* **Works with standalone HTML files too:** Open a local `.html` presentation (e.g., downloaded from Google Drive), press **`R`**, paste your `workers.dev` URL, and scan the QR code — the Worker serves the phone touch controller directly.

### Standalone Single-File Export (Works Without Tailscale or Any Server)

Want a single `.html` file you can copy to any podium PC (via USB, AirDrop, or Google Drive) with **both** relays baked in — without committing your personal URLs to Git?

1. **Configure your gitignored `.env` once:**
   ```bash
   cp .env.example .env
   ```
   Edit `.env` with your Tailscale Funnel `PRIMARY_RELAY` and Cloudflare `BACKUP_RELAY`. (`server.mjs` also reads `BACKUP_RELAY` from `.env` automatically.)

2. **Export standalone `.html` file(s) into gitignored `dist/`:**
   ```bash
   node export.mjs                      # exports all decks/*.html to dist/*.standalone.html
   node export.mjs decks/my-talk.html   # or export a single deck
   ```

3. **Open the exported `.standalone.html` directly in any browser (`file://`):**
   It tries your Tailnet primary relay first, and if your Tailnet machine is offline or unreachable, it automatically fails over to your Cloudflare Worker within 5 seconds.

---

## Repository Structure

```
slides-remote/
├── server.mjs                  # Zero-dependency HTTP + WebSocket relay & deck server
├── export.mjs                  # Single-file standalone HTML exporter (inlines remote.js + .env relays)
├── remote.js                   # Reusable drop-in phone controller, QR modal, auto-failover
├── .env.example                # Template for personal PRIMARY_RELAY / BACKUP_RELAY (copy to .env)
├── cloudflare-worker/
│   ├── worker.js               # Free-tier Durable Object WebSocket backup relay + mobile UI
│   └── wrangler.toml           # Cloudflare Workers config (SQLite Durable Objects)
├── decks/
│   ├── starter.html            # Minimal 4-slide template with phone slider demo
│   └── ai-presentations.html   # 26-slide interactive reveal talk showcase
├── LICENSE
└── README.md
```

## Talk-Day Tips
- Disable phone Auto-Lock (or set to 5 min) during your talk; `remote.js` also requests Screen Wake Lock and auto-reconnects on wake.
- Because `tailscale funnel` runs in the foreground without `--bg`, pressing `Ctrl+C` cleanly turns off the public Funnel endpoint when your talk ends.

## License
MIT
