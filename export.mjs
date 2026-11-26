#!/usr/bin/env node
/**
 * export.mjs — Pack any slides-remote HTML deck into a single self-contained
 * .html file with remote.js and your personal Primary/Backup relay URLs baked in.
 *
 * Copy the exported .html file to any podium computer (no Node.js, no zip, no
 * Tailscale needed): it tries PRIMARY_RELAY first and automatically fails over
 * to BACKUP_RELAY (Cloudflare Worker) if your Tailnet machine is unreachable.
 *
 * Usage:
 *   node export.mjs                          # exports all ./decks/*.html into ./dist/
 *   node export.mjs decks/my-talk.html       # exports one deck into ./dist/
 *   node export.mjs decks/my-talk.html -o ~/Desktop/talk.html
 *   node export.mjs decks/my-talk.html --primary https://... --backup https://...
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DECKS_DIR = path.join(__dirname, 'decks');
const DIST_DIR = path.join(__dirname, 'dist');
const REMOTE_JS = path.join(__dirname, 'remote.js');
const REMOTE_TAG_RE = /<script\b[^>]*\bsrc=["'](?:\.?\/)?remote\.js["'][^>]*>\s*<\/script>/i;

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

function printHelp() {
  console.log(`Usage:
  node export.mjs                         Export all ./decks/*.html into ./dist/*.standalone.html
  node export.mjs <deck.html> [options]   Export a single HTML deck

Options:
  -o, --out <path>       Output file path (default: ./dist/<name>.standalone.html)
  --primary <url>        Override PRIMARY_RELAY from .env
  --backup <url>         Override BACKUP_RELAY from .env
  -h, --help             Show this help`);
}

function parseArgs(argv) {
  const opts = { deck: null, out: null, primary: null, backup: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { opts.help = true; }
    else if (a === '-o' || a === '--out') { opts.out = argv[++i] || ''; }
    else if (a === '--primary') { opts.primary = argv[++i] || ''; }
    else if (a === '--backup') { opts.backup = argv[++i] || ''; }
    else if (a.startsWith('-')) {
      console.error(`Unknown option: ${a}`);
      process.exit(1);
    } else if (!opts.deck) {
      opts.deck = a;
    } else {
      console.error(`Unexpected argument: ${a}`);
      process.exit(1);
    }
  }
  return opts;
}

function exportDeck(deckPath, outPath, remoteJsSrc, primaryRelay, backupRelay) {
  const html = fs.readFileSync(deckPath, 'utf8');
  if (!REMOTE_TAG_RE.test(html)) {
    throw new Error(`No <script src="/remote.js"></script> tag found in ${deckPath}`);
  }

  const defaults = {};
  if (primaryRelay) defaults.relayBase = primaryRelay;
  if (backupRelay) defaults.backupRelay = backupRelay;

  const safeDefaults = JSON.stringify(defaults).replace(/</g, '\\u003c');
  const safeRemoteJs = remoteJsSrc.replace(/<\/script/gi, '<\\/script');
  const replacement = `<script>\nwindow.SLIDE_REMOTE_DEFAULTS=${safeDefaults};\n${safeRemoteJs}\n</script>`;

  const outputHtml = html.replace(REMOTE_TAG_RE, () => replacement);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, outputHtml, 'utf8');

  const kb = (Buffer.byteLength(outputHtml, 'utf8') / 1024).toFixed(1);
  console.log(`Exported ${path.relative(__dirname, outPath)} (${kb} KB)`);
}

loadEnvFile(path.join(__dirname, '.env'));
const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}

const primaryRelay = (args.primary ?? process.env.PRIMARY_RELAY ?? '').trim().replace(/\/+$/, '');
const backupRelay = (args.backup ?? process.env.BACKUP_RELAY ?? '').trim().replace(/\/+$/, '');

if (!primaryRelay && !backupRelay) {
  console.warn('Warning: neither PRIMARY_RELAY nor BACKUP_RELAY is set (check .env or pass --primary / --backup).');
}

const remoteJsSrc = fs.readFileSync(REMOTE_JS, 'utf8');

if (args.deck) {
  const deckPath = path.resolve(process.cwd(), args.deck);
  if (!fs.existsSync(deckPath)) {
    console.error(`Deck not found: ${deckPath}`);
    process.exit(1);
  }
  const baseName = path.basename(deckPath, path.extname(deckPath));
  const outPath = args.out
    ? path.resolve(process.cwd(), args.out)
    : path.join(DIST_DIR, `${baseName}.standalone.html`);
  exportDeck(deckPath, outPath, remoteJsSrc, primaryRelay, backupRelay);
} else {
  if (args.out) {
    console.error('--out can only be used when exporting a single deck.');
    process.exit(1);
  }
  const files = fs.existsSync(DECKS_DIR)
    ? fs.readdirSync(DECKS_DIR).filter(f => f.endsWith('.html')).sort()
    : [];
  if (files.length === 0) {
    console.error(`No .html decks found in ${DECKS_DIR}`);
    process.exit(1);
  }
  for (const file of files) {
    const baseName = path.basename(file, '.html');
    exportDeck(
      path.join(DECKS_DIR, file),
      path.join(DIST_DIR, `${baseName}.standalone.html`),
      remoteJsSrc,
      primaryRelay,
      backupRelay
    );
  }
}

console.log(`Relays baked in: primary=${primaryRelay || '(none)'}, backup=${backupRelay || '(none)'}`);
