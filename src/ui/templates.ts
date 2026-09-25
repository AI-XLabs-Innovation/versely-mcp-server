// Branded inline media card served via the MCP Apps extension (SEP-1865).
//
// Spec: https://github.com/modelcontextprotocol/ext-apps
// Stable: specification/2026-01-26/apps.mdx
//
// One template covers every Versely media-producing tool. The card detects
// asset kind (image / video / audio / mixed) from `structuredContent.kind`
// and renders accordingly. The card is display-only — it issues `tools/call`
// solely to poll its own status while a job is pending.
//
// Protocol (host ↔ iframe over `postMessage`):
//   Host → iframe (notifications):
//     `ui/notifications/tool-input`  — { arguments: <ToolInput> }
//     `ui/notifications/tool-result` — { content, structuredContent }
//     `ui/notifications/tool-cancelled` — { reason }
//   Iframe → host (requests):
//     `ui/initialize`               — handshake, declares display modes
//     `tools/call`                  — poll a status tool while pending
//     `ui/notifications/size-changed` — report iframe content size
//
// Fallbacks: also accepts `window.openai.{toolInput,toolOutput}` and a
// `#state=<base64-json>` URL hash for dev inspectors that don't speak the
// spec yet.
//
// CSP: hosts that respect `_meta.ui.csp.resourceDomains` will allow the
// Versely CDN subdomains declared on each tool. claude.ai currently
// hardcodes its sandbox CSP (anthropics/claude-ai-mcp#40); our declarations
// kick in once that's fixed.
//
// Two versions of the card live here: v1 (below, served to claude.ai and
// every profile not in MCP_CARD_V2_PROFILES — keep it byte-for-byte) and v2
// (further down, the ChatGPT plugin's). See the v2 header for the differences.

import { createHash } from "node:crypto";
import type { Profile } from "../profiles.js";
import { PICKER_DESCRIPTION, PICKER_HTML, PICKER_NAME, PICKER_URI, PICKER_URI_BASE } from "./picker.js";

const MEDIA_CARD_HTML = String.raw`<!doctype html>
<html><head><meta charset="utf-8"/>
<meta name="color-scheme" content="light dark"/>
<!-- Strip Referer so Cloudflare hotlink protection on img/videos/audio
     .versely.studio doesn't 1011 us when the iframe (claudemcpcontent.com)
     loads asset URLs. Per-element referrerpolicy on img/video/audio gives
     belt-and-suspenders coverage. -->
<meta name="referrer" content="no-referrer"/>
<style>
  :root {
    color-scheme: light dark;
    --bg: transparent;
    --card: #ffffff;
    --card-border: #e5e7eb;
    --fg: #0a0a0b;
    --muted: #6b7280;
    --chip-bg: #f3f4f6;
    --chip-fg: #374151;
    --accent: #7c3aed;
    --accent-fg: #ffffff;
    --accent-hover: #6d28d9;
    --radius: 14px;
    --radius-sm: 8px;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --card: #131316;
      --card-border: #27272a;
      --fg: #f4f4f5;
      --muted: #a1a1aa;
      --chip-bg: #1f1f23;
      --chip-fg: #d4d4d8;
    }
  }
  html, body {
    margin: 0; padding: 0; background: var(--bg);
    font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", system-ui, sans-serif;
    color: var(--fg); -webkit-font-smoothing: antialiased;
  }
  .card {
    background: var(--card);
    border: 1px solid var(--card-border);
    border-radius: var(--radius);
    overflow: hidden;
    display: flex; flex-direction: column;
    /* border-box so max-width below is the card's REAL outer width. Under the
       default content-box the 1px border sits outside the cap and the card
       renders 2px wider than the number says. */
    box-sizing: border-box;
    /* Cap the card's own width rather than letting it fill the host frame.
       reportSize() measures .card and reports this as the iframe width, so the
       host is told to shrink with us. A plain max-width (not a fixed width)
       keeps it responsive: on a viewport narrower than the cap the card is
       still 100% of what's available. */
    max-width: 440px;
    /* Defensive: if neither state nor placeholder fills the card, keep a
       visible minimum so iframe sandboxes that ignore size-changed don't
       collapse us to 0. */
    min-height: 96px;
  }
  .head {
    padding: 14px 16px 10px;
    display: flex; align-items: flex-start; gap: 8px;
  }
  .prompt {
    flex: 1; min-width: 0;
    font-size: 13px; line-height: 1.45; color: var(--fg);
    overflow: hidden; text-overflow: ellipsis;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  }
  .prompt.expanded { -webkit-line-clamp: unset; display: block; }
  .toggle {
    flex: 0 0 auto; background: none; border: 0; cursor: pointer;
    color: var(--muted); padding: 0 2px; line-height: 1;
    font-size: 14px;
  }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 16px 12px; }
  .chip {
    background: var(--chip-bg); color: var(--chip-fg);
    border-radius: 999px; padding: 3px 10px;
    font-size: 11px; font-weight: 500; line-height: 1.5;
    white-space: nowrap;
  }
  .body { padding: 0 0 0 0; }
  .body.padded { padding: 0 16px; }
  .loading { padding: 28px 16px; color: var(--muted); font-size: 13px; text-align: center; }
  /* Image grid */
  .grid { display: grid; gap: 4px; padding: 0; }
  .grid.n1 { grid-template-columns: 1fr; }
  .grid.n2 { grid-template-columns: 1fr 1fr; }
  .grid.n3 { grid-template-columns: repeat(3, 1fr); }
  .grid.n4plus { grid-template-columns: repeat(2, 1fr); }
  .tile { position: relative; overflow: hidden; background: #000; }
  .tile img, .tile video {
    width: 100%; height: 100%; display: block;
    object-fit: cover; cursor: zoom-in;
  }
  /* Mixed galleries can put an audio asset in a tile; give it the tile width
     rather than leaving it at the UA's intrinsic size. */
  .tile audio { width: 100%; display: block; align-self: center; }
  /* Single-asset (solo) tiles use a centered, contained image with a cap
     on height so 1:1 / portrait sources don't dominate the chat. The
     card is capped at 440px wide, so anything taller than ~4:3 hits this cap
     rather than the width — it is the knob that decides how much vertical
     space a card claims. Full resolution is still one click away.
     Keep the three values below in sync: the wrapper and the media share a
     cap so a portrait source letterboxes inside the frame instead of
     overflowing it. */
  .tile.solo { display: flex; align-items: center; justify-content: center; background: #000; max-height: 340px; }
  .tile.solo img, .tile.solo video {
    width: auto; height: auto;
    max-width: 100%; max-height: 340px;
    display: block; object-fit: contain; cursor: pointer; background: #000;
  }
  /* Video / single-asset (when not rendered as a .tile) */
  .player { width: 100%; max-height: 340px; display: block; background: #000; object-fit: contain; }
  /* Audio rows */
  .audio-list { padding: 8px 16px 14px; display: flex; flex-direction: column; gap: 10px; }
  .audio-row { display: flex; flex-direction: column; gap: 4px; }
  .audio-label { font-size: 12px; color: var(--muted); }
  audio { width: 100%; }
  /* Footer */
  .foot {
    display: flex; align-items: center; gap: 10px;
    padding: 12px 16px 14px;
    border-top: 1px solid var(--card-border);
  }
  /* .actions / .btn rules lived here — the Recreate button was their only
     user. The footer now carries the brand alone; .toggle (prompt expand) is
     styled separately above. */
  .brand {
    margin-left: auto;
    font-size: 11px; color: var(--muted);
    display: inline-flex; align-items: center; gap: 6px;
  }
  .brand-dot {
    width: 6px; height: 6px; border-radius: 999px;
    background: var(--accent); display: inline-block;
  }
  .err { padding: 16px; color: #b91c1c; font-size: 13px; }
  @media (prefers-color-scheme: dark) { .err { color: #f87171; } }
  /* Placeholder shown before state arrives so the iframe has visible content
     and claude.ai grows the chat-bubble iframe instead of collapsing it.
     Strong colors so it can't be lost in a sandboxed color-scheme. */
  .placeholder {
    min-height: 120px;
    padding: 24px 20px;
    display: flex; align-items: center; gap: 14px;
    background: linear-gradient(135deg, #7c3aed 0%, #5b21b6 100%);
    color: #ffffff;
    font-size: 14px; font-weight: 500;
  }
  .placeholder .dot {
    width: 10px; height: 10px; border-radius: 999px;
    background: #ffffff;
    animation: pulse 1.4s ease-in-out infinite;
    flex: 0 0 auto;
  }
  .placeholder .tag {
    font-size: 11px; font-weight: 600;
    letter-spacing: 0.06em; text-transform: uppercase;
    opacity: 0.85;
  }
  .placeholder .col { display: flex; flex-direction: column; gap: 4px; }
  @keyframes pulse {
    0%, 100% { transform: scale(0.85); opacity: 0.5; }
    50%      { transform: scale(1.2);  opacity: 1; }
  }
  /* Pending state shown while the iframe polls an async job. Lives inside
     the .card so the prompt/chips above it stay visible — only the body
     swaps to this strip while waiting. */
  .pending {
    margin: 0 16px 16px;
    padding: 18px 16px;
    display: flex; align-items: center; gap: 12px;
    background: linear-gradient(135deg, #7c3aed 0%, #5b21b6 100%);
    color: #ffffff; border-radius: var(--radius-sm);
  }
  .pending {
    /* Override the inherited flex from .pending-row so the thumb strip
       wraps under the header row instead of squishing alongside it. */
    flex-direction: column;
    align-items: stretch;
  }
  .pending .pending-row { display: flex; align-items: flex-start; gap: 12px; }
  .pending .spin {
    width: 18px; height: 18px; flex: 0 0 auto;
    border-radius: 999px;
    border: 2px solid rgba(255,255,255,0.3);
    border-top-color: #ffffff;
    animation: spin 0.9s linear infinite;
    margin-top: 2px;
  }
  /* Static dot for the blueprint/planning state — no work in flight, no spin. */
  .pending .planning-dot {
    width: 10px; height: 10px; flex: 0 0 auto;
    border-radius: 999px; background: rgba(255,255,255,0.85);
    margin-top: 5px; margin-left: 4px; margin-right: 4px;
  }
  .pending .label { font-size: 13px; font-weight: 500; }
  .pending .elapsed { font-size: 11px; opacity: 0.8; margin-top: 2px; }
  .pending .col { display: flex; flex-direction: column; flex: 1; min-width: 0; }
  .pending .progress {
    margin-top: 6px; height: 4px; background: rgba(255,255,255,0.2);
    border-radius: 999px; overflow: hidden;
  }
  .pending .bar {
    height: 100%; background: #ffffff;
    transition: width 0.4s ease;
  }
  /* Multi-scene movies: thumbnail strip below the spinner, scenes pop in
     as they complete. Capped height so a 10-scene movie doesn't blow up
     the iframe. */
  .pending .pending-thumbs {
    display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px;
  }
  .pending .pending-thumb {
    width: 96px; max-width: 30%;
    display: flex; flex-direction: column; gap: 4px;
    border-radius: 6px; overflow: hidden;
    background: rgba(255,255,255,0.08);
  }
  .pending .pending-thumb video,
  .pending .pending-thumb img {
    width: 100%; aspect-ratio: 16/9; object-fit: cover; display: block;
    background: rgba(0,0,0,0.2);
  }
  .pending .pending-thumb span {
    font-size: 10px; opacity: 0.85; padding: 0 4px 4px; white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis;
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  /* Failed state. */
  .failed-body {
    margin: 0 16px 16px;
    padding: 14px 16px;
    background: rgba(185, 28, 28, 0.08);
    border: 1px solid rgba(185, 28, 28, 0.25);
    color: #b91c1c;
    border-radius: var(--radius-sm);
    font-size: 13px;
  }
  @media (prefers-color-scheme: dark) {
    .failed-body { color: #f87171; background: rgba(248, 113, 113, 0.08); border-color: rgba(248, 113, 113, 0.25); }
  }
</style></head>
<body>
<div id="root"><div class="card"><div class="placeholder"><span class="dot"></span><div class="col"><span class="tag">Versely Media Card</span><span>Preparing preview…</span></div></div></div></div>
<script>
(function () {
  var root = document.getElementById('root');
  var state = null;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function urlExt(u) {
    try { var p = new URL(u).pathname; var m = p.match(/\.([a-z0-9]+)$/i); return (m ? m[1] : '').toLowerCase(); }
    catch (e) { return ''; }
  }
  function isVideoUrl(u) { return /^(mp4|mov|webm|m4v|mkv)$/.test(urlExt(u)); }
  function isAudioUrl(u) { return /^(mp3|wav|m4a|ogg|oga|flac|aac|mpeg|mpga|opus|weba)$/.test(urlExt(u)); }
  function defaultKind(assets) {
    if (!assets || !assets.length) return 'image';
    var kinds = assets.map(function (a) {
      var u = a && a.url;
      if (isVideoUrl(u)) return 'video';
      if (isAudioUrl(u)) return 'audio';
      return 'image';
    });
    var uniq = {}; kinds.forEach(function (k) { uniq[k] = true; });
    var u = Object.keys(uniq);
    if (u.length === 1) {
      if (u[0] === 'image') return assets.length === 1 ? 'image' : 'gallery';
      if (u[0] === 'video') return assets.length === 1 ? 'video' : 'gallery';
      return 'audio';
    }
    return 'gallery';
  }

  function renderChips(s) {
    var chips = [];
    if (s.model) chips.push('<span class="chip">' + esc(s.model) + '</span>');
    if (s.aspect_ratio) chips.push('<span class="chip">' + esc(s.aspect_ratio) + '</span>');
    if (s.size) chips.push('<span class="chip">' + esc(s.size) + '</span>');
    if (s.duration_seconds) chips.push('<span class="chip">' + esc(s.duration_seconds) + 's</span>');
    if (s.seed != null) chips.push('<span class="chip">seed ' + esc(s.seed) + '</span>');
    return chips.length ? '<div class="chips">' + chips.join('') + '</div>' : '';
  }

  function renderHead(s) {
    var text = s.prompt || s.text || s.title || s.summary || '';
    if (!text) return '';
    var safe = esc(text);
    return '<div class="head">' +
      '<div class="prompt" data-prompt>' + safe + '</div>' +
      '<button class="toggle" data-toggle aria-label="Expand">⌄</button>' +
    '</div>';
  }

  function renderImageGrid(assets) {
    var n = assets.length;
    var cls = n === 1 ? 'n1' : n === 2 ? 'n2' : n === 3 ? 'n3' : 'n4plus';
    var html = '<div class="grid ' + cls + '">';
    for (var i = 0; i < n; i++) {
      var a = assets[i] || {};
      var url = esc(a.url || '');
      var label = esc(a.label || '');
      var tileCls = n === 1 ? 'tile solo' : 'tile';
      // This grid is also the landing spot for 'gallery-mixed' (multiple assets
      // of differing kinds), so a tile is not necessarily an image. Rendering a
      // video or audio URL into <img> yields a silently broken tile — pick the
      // element per asset instead.
      var inner;
      if (isVideoUrl(a.url)) {
        inner = '<video src="' + url + '" controls playsinline preload="metadata" referrerpolicy="no-referrer"></video>';
      } else if (isAudioUrl(a.url)) {
        inner = '<audio src="' + url + '" controls preload="metadata"></audio>';
      } else {
        inner = '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' +
          '<img src="' + url + '" alt="' + label + '" loading="lazy" referrerpolicy="no-referrer"/>' +
        '</a>';
      }
      html += '<div class="' + tileCls + '">' + inner + '</div>';
    }
    html += '</div>';
    return html;
  }

  function renderVideo(asset) {
    if (!asset || !asset.url) return '<div class="err">No video.</div>';
    var u = esc(asset.url);
    return '<video class="player" src="' + u + '" controls playsinline preload="metadata" referrerpolicy="no-referrer"></video>';
  }

  function renderAudio(assets) {
    if (!assets.length) return '<div class="err">No audio.</div>';
    var html = '<div class="audio-list">';
    for (var i = 0; i < assets.length; i++) {
      var a = assets[i] || {}; if (!a.url) continue;
      var lab = esc(a.label || ('Track ' + (i + 1)));
      html += '<div class="audio-row">' +
        '<div class="audio-label">' + lab + '</div>' +
        '<audio src="' + esc(a.url) + '" controls preload="metadata" referrerpolicy="no-referrer"></audio>' +
      '</div>';
    }
    html += '</div>';
    return html;
  }

  function renderPending(s, elapsedMs) {
    var secs = Math.max(0, Math.round(elapsedMs / 1000));
    var mm = Math.floor(secs / 60), ss = secs % 60;
    var time = mm + ':' + (ss < 10 ? '0' + ss : ss);

    // Movie pending payloads carry scene-count fields. When present, use them
    // to render a more useful headline ("Movie: 2 of 5 scenes ready") and an
    // optional thumbnail strip of completed scenes so the user sees progress
    // accumulate. Falls back to the generic "Generating <kind>…" otherwise.
    var isMovie = (typeof s.scenes_total === 'number' && s.scenes_total > 0);
    var headline;
    if (isMovie) {
      var done = (typeof s.scenes_completed === 'number') ? s.scenes_completed : 0;
      var totalScenes = s.scenes_total;
      var phase = s.phase || '';
      if (phase === 'planning') {
        headline = (s.title ? esc(s.title) + ' — ' : '') + 'planned ' + totalScenes + ' scene' + (totalScenes === 1 ? '' : 's') + ' (not yet generating)';
      } else if (phase === 'combining') {
        headline = (s.title ? esc(s.title) + ' — ' : '') + 'all scenes ready, combining…';
      } else {
        headline = (s.title ? esc(s.title) + ' — ' : '') + done + ' of ' + totalScenes + ' scene' + (totalScenes === 1 ? '' : 's') + ' ready';
      }
    } else {
      var kindLabel =
        s.kind === 'video' ? 'video' :
        s.kind === 'audio' ? 'audio' :
        s.kind === 'gallery' ? 'media' : 'image';
      headline = 'Generating ' + kindLabel + '…';
    }

    var pct = (typeof s.progress === 'number' && !isNaN(s.progress))
      ? Math.max(0, Math.min(100, s.progress > 1 ? s.progress : s.progress * 100))
      : null;
    var progressHtml = (pct != null)
      ? '<div class="progress"><div class="bar" data-bar style="width:' + pct.toFixed(0) + '%"></div></div>'
      : '';

    // Thumbnail strip for any scenes that have already completed. Lets the
    // user see the movie build up scene by scene without having to wait for
    // the final combined video.
    var thumbsHtml = '';
    if (isMovie) {
      var assets = Array.isArray(s.assets) ? s.assets.filter(function (a) { return a && a.url; }) : [];
      if (assets.length > 0) {
        thumbsHtml += '<div class="pending-thumbs" data-pending-thumbs>';
        for (var i = 0; i < assets.length; i++) {
          var a = assets[i];
          var label = a.label ? esc(a.label) : '';
          if (isVideoUrl(a.url)) {
            thumbsHtml += '<div class="pending-thumb"><video src="' + esc(a.url) + '" muted playsinline preload="metadata" referrerpolicy="no-referrer"></video><span>' + label + '</span></div>';
          } else if (!isAudioUrl(a.url)) {
            thumbsHtml += '<div class="pending-thumb"><img src="' + esc(a.url) + '" alt="' + label + '" referrerpolicy="no-referrer"><span>' + label + '</span></div>';
          }
        }
        thumbsHtml += '</div>';
      }
    }

    // Blueprint state (movie created, not yet generating) shouldn't spin or
    // show "elapsed" — there's no work in flight. Render a static info row.
    var isPlanning = isMovie && s.phase === 'planning';
    var spinHtml = isPlanning ? '<div class="planning-dot"></div>' : '<div class="spin"></div>';
    var elapsedHtml = isPlanning ? '' : '<div class="elapsed" data-elapsed>' + esc(time) + ' elapsed</div>';
    var barHtml = isPlanning ? '' : progressHtml;

    return '<div class="pending">' +
      '<div class="pending-row">' +
        spinHtml +
        '<div class="col">' +
          '<div class="label">' + headline + '</div>' +
          elapsedHtml +
          barHtml +
        '</div>' +
      '</div>' +
      thumbsHtml +
    '</div>';
  }

  function renderFailed(s) {
    var msg = s.error ? String(s.error) : 'Generation failed.';
    return '<div class="failed-body">' + esc(msg) + '</div>';
  }

  function renderActions(s) {
    // The Recreate button lived here. structuredContent still carries
    // toolName / toolArgs — they're the label source below, and the payload
    // contract is shared with hosts that read structuredContent directly, so
    // they stay.
    var toolLabel = s.toolName ? s.toolName.replace(/^versely_/, '') : 'media';
    return '<span class="brand"><span class="brand-dot"></span>Versely · ' + esc(toolLabel) + '</span>';
  }

  function render() {
    if (!state) return;
    var s = state;
    var assets = Array.isArray(s.assets) ? s.assets.filter(function (a) { return a && a.url; }) : [];
    var kind = s.kind || defaultKind(assets);
    if (kind === 'gallery') kind = assets.every(function (a) { return !isVideoUrl(a.url) && !isAudioUrl(a.url); })
      ? 'gallery-images' : 'gallery-mixed';

    var bodyHtml;
    if (s.status === 'pending') {
      // Async job in flight — show the polling UI. The poll loop will
      // re-render when status flips to completed/failed.
      bodyHtml = renderPending(s, pollElapsedMs());
    } else if (s.status === 'failed') {
      bodyHtml = renderFailed(s);
    } else if (assets.length === 0) {
      bodyHtml = '<div class="loading">No assets returned.</div>';
    } else if (kind === 'video' || (assets.length === 1 && isVideoUrl(assets[0].url))) {
      bodyHtml = renderVideo(assets[0]);
    } else if (kind === 'audio' || (assets.length >= 1 && isAudioUrl(assets[0].url))) {
      bodyHtml = renderAudio(assets);
    } else {
      bodyHtml = renderImageGrid(assets);
    }

    var html = '<div class="card">' +
      renderHead(s) +
      renderChips(s) +
      '<div class="body">' + bodyHtml + '</div>' +
      '<div class="foot">' + renderActions(s) + '</div>' +
    '</div>';
    root.innerHTML = html;

    var toggle = root.querySelector('[data-toggle]');
    var prompt = root.querySelector('[data-prompt]');
    if (toggle && prompt) {
      toggle.addEventListener('click', function () { prompt.classList.toggle('expanded'); });
    }
  }

  function nextId() { return Date.now() * 1000 + Math.floor(Math.random() * 1000); }
  function send(msg) {
    try {
      console.log('[versely-mcp ui] → host', msg && msg.method, msg);
      window.parent && window.parent.postMessage(msg, '*');
    } catch (e) {
      console.warn('[versely-mcp ui] send failed', e);
    }
  }
  // (callTool lived here — the Recreate button was its only caller. The poll
  // loop below builds its own tools/call because it has to retain the request
  // id to match the response.)

  // --- Async-job polling ----------------------------------------------------
  // When state arrives with status:"pending" + poll instruction, fire a
  // tools/call to the named status tool every interval_ms. The response
  // comes back as a JSON-RPC result we match by id. On terminal state
  // (completed / failed) we stop and re-render. The host's per-tool
  // execution timeout doesn't apply here — each poll call is a single
  // sub-second JSON-RPC round-trip.
  var pollHandle = null;
  var pollStartTime = 0;
  var pollPendingId = null;
  var pollTimeoutHandle = null;
  var elapsedTickHandle = null;
  // Consecutive tools/call failures. A poll error used to be treated as always
  // transient, which is only true when the bridge itself is healthy. When the
  // host CANNOT service tools/call at all — claude.ai reports "Client server
  // capabilities not available" — every tick fails identically, and retrying at
  // interval_ms for the whole timeout_ms budget means 120 failed calls, each one
  // surfacing to the user as "Unable to reach versely-mcp". The card looked like
  // the server was down when the server was fine.
  var pollErrorStreak = 0;
  var POLL_ERROR_LIMIT = 3;

  function pollElapsedMs() {
    return pollStartTime ? (Date.now() - pollStartTime) : 0;
  }

  function stopPolling(reason) {
    if (pollHandle) { clearInterval(pollHandle); pollHandle = null; }
    if (pollTimeoutHandle) { clearTimeout(pollTimeoutHandle); pollTimeoutHandle = null; }
    if (elapsedTickHandle) { clearInterval(elapsedTickHandle); elapsedTickHandle = null; }
    console.log('[versely-mcp ui] polling stopped:', reason);
  }

  function ensurePollingFor(s) {
    if (!s || s.status !== 'pending' || !s.poll || !s.poll.tool_name) return;
    if (pollHandle) return; // already running
    var interval = (s.poll.interval_ms && s.poll.interval_ms > 0) ? s.poll.interval_ms : 5000;
    var budget = (s.poll.timeout_ms && s.poll.timeout_ms > 0) ? s.poll.timeout_ms : 600000;
    pollStartTime = Date.now();
    console.log('[versely-mcp ui] polling started', s.poll.tool_name, 'every', interval, 'ms');

    function tick() {
      pollPendingId = nextId();
      send({
        jsonrpc: '2.0', id: pollPendingId,
        method: 'tools/call',
        params: { name: s.poll.tool_name, arguments: s.poll.args || {} },
      });
    }

    pollHandle = setInterval(tick, interval);
    // Update the elapsed timer label every second without re-rendering the
    // whole card.
    elapsedTickHandle = setInterval(function () {
      var el = root.querySelector('[data-elapsed]');
      if (!el) return;
      var secs = Math.round(pollElapsedMs() / 1000);
      var mm = Math.floor(secs / 60), ss = secs % 60;
      el.textContent = mm + ':' + (ss < 10 ? '0' + ss : ss) + ' elapsed';
    }, 1000);
    pollTimeoutHandle = setTimeout(function () {
      stopPolling('timeout');
      state = Object.assign({}, state, { status: 'failed', error: 'Generation timed out. The job may still complete in the background — try versely_get_task_status later.' });
      render();
      reportSize();
    }, budget);
    // Fire one immediate poll so the UI doesn't wait interval_ms for the
    // first datapoint.
    tick();
  }

  function handlePollResponse(result) {
    if (!result || typeof result !== 'object') return;
    var sc = result.structuredContent || null;
    // Some hosts only forward the content array; try to find embedded JSON.
    if (!sc && Array.isArray(result.content)) {
      for (var i = 0; i < result.content.length; i++) {
        var c = result.content[i];
        if (c && c.type === 'text' && typeof c.text === 'string') {
          try {
            var parsed = JSON.parse(c.text);
            if (parsed && typeof parsed === 'object' && (parsed.status || parsed.assets)) {
              sc = parsed;
              break;
            }
          } catch (e) {}
        }
      }
    }
    if (!sc) {
      // A tool result we can't read state from. If it's flagged isError, the
      // status tool is telling us something went wrong — stop rather than spin
      // (an unreadable error every interval_ms is the same visible spam as a
      // transport failure). Anything else, wait for the next tick.
      if (result.isError) {
        stopPolling('poll-returned-error');
        var msg = '';
        if (Array.isArray(result.content)) {
          for (var j = 0; j < result.content.length; j++) {
            if (result.content[j] && result.content[j].type === 'text') { msg = result.content[j].text; break; }
          }
        }
        state = Object.assign({}, state, { status: 'failed', error: msg || 'Generation failed.' });
        state.poll = undefined;
        render();
        reportSize();
      }
      return;
    }

    var hasAssets = Array.isArray(sc.assets) && sc.assets.length > 0;
    var status = sc.status;
    if (status === 'completed' || (!status && hasAssets)) {
      stopPolling('completed');
      // The generating tool set the kind from what it ASKED for, which is
      // authoritative. The poll response only knows what came back, and can
      // re-derive a different kind (e.g. a video plus its poster thumbnail
      // infers as a mixed gallery and would then render in the image grid).
      // Keep the original unless the card never had one.
      var originalKind = state && state.kind;
      // Merge new assets/status into the original card state so display
      // fields (prompt, model, chips) survive.
      state = Object.assign({}, state, sc, { status: 'completed' });
      if (originalKind) state.kind = originalKind;
      // Drop the poll instruction so render() takes the asset-rendering
      // branch on the next pass.
      state.poll = undefined;
      render();
      reportSize();
      return;
    }
    if (status === 'failed') {
      stopPolling('failed');
      state = Object.assign({}, state, { status: 'failed', error: sc.error || 'Generation failed.' });
      state.poll = undefined;
      render();
      reportSize();
      return;
    }
    // Still pending — merge fresh fields into state. For movies, new scenes
    // that completed since the last poll arrive as a growing assets array
    // (the translator returns ALL completed scenes each poll). Re-render
    // when the asset count changed so newly-finished scenes pop into the
    // thumbnail strip without remounting the spinner.
    var prevAssetCount = (state && Array.isArray(state.assets)) ? state.assets.length : 0;
    var newAssetCount = Array.isArray(sc.assets) ? sc.assets.length : 0;
    var prevScenesCompleted = (state && typeof state.scenes_completed === 'number') ? state.scenes_completed : null;
    var sceneCountChanged =
      (typeof sc.scenes_completed === 'number') &&
      prevScenesCompleted !== null &&
      sc.scenes_completed !== prevScenesCompleted;
    var assetsGrew = newAssetCount > prevAssetCount;

    if (state) {
      // Merge — don't overwrite host-provided fields (toolName, toolArgs,
      // poll) that aren't part of the poll response.
      var merged = Object.assign({}, state);
      var mergeable = ['assets', 'progress', 'phase', 'scenes_total', 'scenes_completed',
                       'scenes_failed', 'scenes_generating', 'scenes_pending', 'title'];
      for (var i = 0; i < mergeable.length; i++) {
        var k = mergeable[i];
        if (k in sc) merged[k] = sc[k];
      }
      state = merged;
    }

    if (assetsGrew || sceneCountChanged) {
      // Full re-render picks up new thumbnails + updated headline.
      render();
      reportSize();
    } else if (typeof sc.progress === 'number') {
      // No new scenes — cheaper in-place progress-bar update.
      var bar = root.querySelector('[data-bar]');
      var pct = sc.progress > 1 ? sc.progress : sc.progress * 100;
      pct = Math.max(0, Math.min(100, pct));
      if (bar) bar.style.width = pct.toFixed(0) + '%';
    }
  }

  // Track the two halves of host-delivered state separately. The host sends
  // tool-input and tool-result as independent notifications, sometimes in
  // either order, so we merge as each arrives.
  var lastToolInput = null;
  var lastResultStructured = null;

  function recomputeState() {
    var s = lastResultStructured ? Object.assign({}, lastResultStructured) : null;
    if (!s) return;
    // Prefer host-provided tool-input for Recreate args; fall back to whatever
    // the server echoed in structuredContent.toolArgs if the host didn't send
    // tool-input separately.
    if (lastToolInput && !s.toolArgs) s.toolArgs = lastToolInput;
    state = s;
    render();
    reportSize();
    // Kick off iframe-side polling if this is an async-job pending payload.
    // No-op when status is undefined (legacy completed payloads, image gen).
    ensurePollingFor(state);
  }

  // Report iframe content size so the host can grow the chat-bubble iframe
  // to fit. Without this, claude.ai renders us at height 0 and the card is
  // invisible even when fully populated.
  var lastReportedH = -1;
  function reportSize() {
    try {
      var card = document.querySelector('.card') || document.body;
      var rect = card.getBoundingClientRect();
      var h = Math.ceil(rect.height) || document.documentElement.scrollHeight;
      var w = Math.ceil(rect.width) || document.documentElement.scrollWidth;
      if (h === lastReportedH || h <= 0) return;
      lastReportedH = h;
      send({
        jsonrpc: '2.0',
        method: 'ui/notifications/size-changed',
        params: { width: w, height: h },
      });
    } catch (e) {}
  }
  // Watch for layout changes (image load, prompt expand) and re-report.
  try {
    var ro = new ResizeObserver(function () { reportSize(); });
    ro.observe(document.body);
  } catch (e) {}
  // Report eagerly at multiple lifecycle points so the iframe grows to fit the
  // placeholder before state arrives — otherwise claude.ai keeps it at h=0
  // and the user sees a blank gap.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', reportSize);
  } else {
    reportSize();
  }
  window.addEventListener('load', reportSize);
  setTimeout(reportSize, 50);
  setTimeout(reportSize, 200);
  setTimeout(reportSize, 800);

  // Channel 1: window.openai-style globals (ChatGPT and look-alikes).
  try {
    if (window.openai) {
      if (window.openai.toolInput) lastToolInput = window.openai.toolInput;
      if (window.openai.toolOutput) lastResultStructured = window.openai.toolOutput;
      if (lastResultStructured) recomputeState();
    }
  } catch (e) {}

  // Channel 2: spec-canonical postMessage notifications from the host.
  // Also accept several legacy/non-spec shapes seen in inspectors during the
  // SEP-1865 transition period.
  // Track the ui/initialize id so we can recognize the host's reply and
  // send the spec-required ui/notifications/initialized acknowledgement.
  // Without that ack, claude.ai sits on tool-result delivery and keeps the
  // iframe container at visibility:hidden — confirmed empirically.
  var initRequestId = null;
  var initAcked = false;
  function ackInitialized() {
    if (initAcked) return;
    initAcked = true;
    send({
      jsonrpc: '2.0',
      method: 'ui/notifications/initialized',
      params: {},
    });
  }

  window.addEventListener('message', function (ev) {
    var m = ev.data;
    if (!m || typeof m !== 'object') return;
    console.log('[versely-mcp ui] ← host', m && (m.method || m.type), 'from', ev.origin, m);

    // Response to our ui/initialize: ack with ui/notifications/initialized.
    if (m.result && m.id != null && initRequestId != null && m.id === initRequestId) {
      ackInitialized();
      return;
    }

    // Response to a tools/call we issued for async-job polling.
    if ((m.result || m.error) && m.id != null && pollPendingId != null && m.id === pollPendingId) {
      pollPendingId = null;
      if (m.error) {
        // A few failures really are transient (a dropped tick, a blip), so
        // tolerate a short streak. Beyond that the bridge is broken, not busy —
        // retrying just emits another visible error every interval and can never
        // succeed. Give up and say so; the generation itself is unaffected and
        // is still retrievable via the status tool.
        pollErrorStreak++;
        console.warn('[versely-mcp ui] poll error ' + pollErrorStreak + '/' + POLL_ERROR_LIMIT, m.error);
        if (pollErrorStreak >= POLL_ERROR_LIMIT) {
          stopPolling('poll-bridge-unavailable');
          var pollArgs = (state && state.poll && state.poll.args) || {};
          var pollId = pollArgs.request_id || pollArgs.run_id || pollArgs.project_id ||
            (state && state.task_id) || '';
          state = Object.assign({}, state, {
            status: 'failed',
            error: 'Live preview updates are unavailable in this chat, so this card ' +
              'cannot refresh itself. The generation is still running normally — ' +
              'ask for the status of ' + (pollId || 'this task') + ' to collect the result.',
          });
          state.poll = undefined;
          render();
          reportSize();
        }
        return;
      }
      pollErrorStreak = 0;
      handlePollResponse(m.result);
      return;
    }

    // Spec methods (SEP-1865 / 2026-01-26).
    if (m.method === 'ui/notifications/tool-input' && m.params) {
      lastToolInput = m.params.arguments || m.params;
      return recomputeState();
    }
    if (m.method === 'ui/notifications/tool-result' && m.params) {
      lastResultStructured = m.params.structuredContent || null;
      return recomputeState();
    }
    if (m.method === 'ui/notifications/tool-cancelled') {
      // Only ever re-enabled the Recreate button, which no longer exists.
      // Kept as an explicit no-op so the spec method stays handled rather
      // than falling through to the structuredContent catch-all below, which
      // would misread a cancellation as new state.
      return;
    }

    // Legacy / inspector fallbacks.
    if (m.type === 'tool-output' && m.payload) { lastResultStructured = m.payload; return recomputeState(); }
    if (m.type === 'mcp.ui.state' && m.payload) { lastResultStructured = m.payload; return recomputeState(); }
    if (m.method === 'ui/state' && m.params) { lastResultStructured = m.params; return recomputeState(); }
    if (m.method === 'ui/setState' && m.params) { lastResultStructured = m.params; return recomputeState(); }
    if (m.structuredContent) { lastResultStructured = m.structuredContent; return recomputeState(); }
  });

  // Channel 3: URL hash debug fallback.
  try {
    var match = (location.hash || '').match(/state=([^&]+)/);
    if (match) { lastResultStructured = JSON.parse(atob(decodeURIComponent(match[1]))); recomputeState(); }
  } catch (e) {}

  // Spec-canonical initialization handshake. claude.ai's Zod schema for
  // ui/initialize requires appInfo (object) and appCapabilities (object) —
  // NOT clientInfo / capabilities as some older docs suggest. Confirmed
  // by capturing claude.ai's JSON-RPC error response. The container stays
  // at visibility:hidden until this handshake lands. availableDisplayModes
  // is restricted to the spec enum (inline | fullscreen | pip) — unknown
  // modes get the handshake rejected.
  console.log('[versely-mcp ui] script start, sending ui/initialize');
  initRequestId = nextId();
  send({
    jsonrpc: '2.0', id: initRequestId,
    method: 'ui/initialize',
    params: {
      protocolVersion: '2025-06-18',
      appInfo: { name: 'Versely Media Card', version: '1.0.0' },
      appCapabilities: {
        availableDisplayModes: ['inline', 'fullscreen'],
      },
    },
  });
})();
</script>
</body></html>`;

// --- Media card v2 ----------------------------------------------------------
//
// Served to the profiles in MCP_CARD_V2_PROFILES (default: openai). v1 above
// stays byte-for-byte for everyone else until v2 has shipped a release.
//
// What changed from v1, and why:
//   - Polling is a setTimeout CHAIN with one request in flight. v1 used
//     setInterval, so a slow host piled up concurrent tools/call requests and
//     a late answer to an old poll could overwrite a newer one. Here only the
//     in-flight id's response is used, and a poll with no answer after 30s
//     counts as an error (three in a row and the card stops and says why).
//   - A poll that errors WITHOUT describing the job (transport trouble, a
//     transient 5xx) is a retryable error, not a verdict on the job; only a
//     result that carries the job's task_id can mark it failed.
//   - Answers the host's `ping` and `ui/resource-teardown` requests (teardown
//     also stops polling), and follows the host theme: ui/initialize's
//     hostContext.theme and ui/notifications/host-context-changed set
//     data-theme on <html>, falling back to prefers-color-scheme.
//   - Opens media through `ui/open-link` (sandboxed frames often can't
//     navigate), falling back to window.open(noopener) on an error or after
//     1.5s without an answer.
//   - State = result _meta["studio.versely/card"] merged under
//     structuredContent (ChatGPT shows structuredContent to the model, so the
//     server keeps the bulky card-only fields in _meta), plus
//     window.openai.toolResponseMetadata when the host provides it.
//   - status "info" renders a plain message (used when a card tool had no
//     media to show, so the card never sits on its placeholder).
//
// Same build trap as v1: no backticks and no dollar-brace sequences anywhere
// in this template, comments included.

const MEDIA_CARD_V2_HTML = String.raw`<!doctype html>
<html><head><meta charset="utf-8"/>
<meta name="color-scheme" content="light dark"/>
<meta name="referrer" content="no-referrer"/>
<style>
  :root {
    color-scheme: light dark;
    --bg: transparent;
    --card: #ffffff;
    --card-border: #e5e7eb;
    --fg: #0a0a0b;
    --muted: #4b5563;
    --chip-bg: #f3f4f6;
    --chip-fg: #1f2937;
    --accent: #7c3aed;
    --radius: 14px;
    --radius-sm: 8px;
    --err-fg: #b91c1c;
    --err-bg: rgba(185, 28, 28, 0.08);
    --err-border: rgba(185, 28, 28, 0.25);
    --info-bg: #f3f4f6;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --card: #131316;
      --card-border: #27272a;
      --fg: #f4f4f5;
      --muted: #d4d4d8;
      --chip-bg: #1f1f23;
      --chip-fg: #e4e4e7;
      --err-fg: #f87171;
      --err-bg: rgba(248, 113, 113, 0.08);
      --err-border: rgba(248, 113, 113, 0.25);
      --info-bg: #1f1f23;
    }
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --card: #131316;
    --card-border: #27272a;
    --fg: #f4f4f5;
    --muted: #d4d4d8;
    --chip-bg: #1f1f23;
    --chip-fg: #e4e4e7;
    --err-fg: #f87171;
    --err-bg: rgba(248, 113, 113, 0.08);
    --err-border: rgba(248, 113, 113, 0.25);
    --info-bg: #1f1f23;
  }
  :root[data-theme="light"] { color-scheme: light; }
  html, body {
    margin: 0; padding: 0; background: var(--bg);
    font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", system-ui, sans-serif;
    color: var(--fg); -webkit-font-smoothing: antialiased;
  }
  .card {
    background: var(--card);
    border: 1px solid var(--card-border);
    border-radius: var(--radius);
    overflow: hidden;
    display: flex; flex-direction: column;
    box-sizing: border-box;
    max-width: 440px;
    min-height: 96px;
  }
  .head { padding: 14px 16px 10px; display: flex; align-items: flex-start; gap: 8px; }
  .prompt {
    flex: 1; min-width: 0;
    font-size: 13px; line-height: 1.45; color: var(--fg);
    overflow: hidden; text-overflow: ellipsis;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  }
  .prompt.expanded { -webkit-line-clamp: unset; display: block; }
  .toggle {
    flex: 0 0 auto; background: none; border: 0; cursor: pointer;
    color: var(--fg); padding: 0 2px; line-height: 1; font-size: 14px;
  }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 16px 12px; }
  .chip {
    background: var(--chip-bg); color: var(--chip-fg);
    border-radius: 999px; padding: 3px 10px;
    font-size: 11px; font-weight: 500; line-height: 1.5; white-space: nowrap;
  }
  .loading { padding: 28px 16px; color: var(--fg); font-size: 13px; text-align: center; }
  .grid { display: grid; gap: 4px; }
  .grid.n1 { grid-template-columns: 1fr; }
  .grid.n2 { grid-template-columns: 1fr 1fr; }
  .grid.n3 { grid-template-columns: repeat(3, 1fr); }
  .grid.n4plus { grid-template-columns: repeat(2, 1fr); }
  .tile { position: relative; overflow: hidden; background: #000; }
  .tile img, .tile video { width: 100%; height: 100%; display: block; object-fit: cover; cursor: zoom-in; }
  .tile audio { width: 100%; display: block; align-self: center; }
  .tile.solo { display: flex; align-items: center; justify-content: center; background: #000; max-height: 340px; }
  .tile.solo img, .tile.solo video {
    width: auto; height: auto; max-width: 100%; max-height: 340px;
    display: block; object-fit: contain; cursor: pointer; background: #000;
  }
  .player { width: 100%; max-height: 340px; display: block; background: #000; object-fit: contain; }
  .audio-list { padding: 8px 16px 14px; display: flex; flex-direction: column; gap: 10px; }
  .audio-row { display: flex; flex-direction: column; gap: 4px; }
  .audio-label { font-size: 12px; color: var(--fg); }
  audio { width: 100%; }
  .foot { display: flex; align-items: center; gap: 10px; padding: 12px 16px 14px; border-top: 1px solid var(--card-border); }
  .open-link {
    background: none; border: 0; padding: 0; cursor: pointer;
    font: inherit; font-size: 12px; font-weight: 600; color: var(--fg); text-decoration: underline;
  }
  .brand { margin-left: auto; font-size: 11px; color: var(--fg); display: inline-flex; align-items: center; gap: 6px; }
  .brand-dot { width: 6px; height: 6px; border-radius: 999px; background: var(--accent); display: inline-block; }
  .placeholder {
    min-height: 120px; padding: 24px 20px;
    display: flex; align-items: center; gap: 14px;
    background: linear-gradient(135deg, #7c3aed 0%, #5b21b6 100%);
    color: #ffffff; font-size: 14px; font-weight: 500;
  }
  .placeholder .dot { width: 10px; height: 10px; border-radius: 999px; background: #ffffff; animation: pulse 1.4s ease-in-out infinite; flex: 0 0 auto; }
  .placeholder .tag { font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; }
  .placeholder .col { display: flex; flex-direction: column; gap: 4px; }
  @keyframes pulse { 0%, 100% { transform: scale(0.85); opacity: 0.5; } 50% { transform: scale(1.2); opacity: 1; } }
  .pending {
    margin: 0 16px 16px; padding: 18px 16px;
    display: flex; flex-direction: column; align-items: stretch;
    background: linear-gradient(135deg, #7c3aed 0%, #5b21b6 100%);
    color: #ffffff; border-radius: var(--radius-sm);
  }
  .pending .pending-row { display: flex; align-items: flex-start; gap: 12px; }
  .pending .spin {
    width: 18px; height: 18px; flex: 0 0 auto; border-radius: 999px;
    border: 2px solid rgba(255,255,255,0.3); border-top-color: #ffffff;
    animation: spin 0.9s linear infinite; margin-top: 2px;
  }
  .pending .planning-dot { width: 10px; height: 10px; flex: 0 0 auto; border-radius: 999px; background: #ffffff; margin: 5px 4px 0; }
  .pending .label { font-size: 13px; font-weight: 500; }
  .pending .elapsed { font-size: 11px; margin-top: 2px; }
  .pending .col { display: flex; flex-direction: column; flex: 1; min-width: 0; }
  .pending .progress { margin-top: 6px; height: 4px; background: rgba(255,255,255,0.2); border-radius: 999px; overflow: hidden; }
  .pending .bar { height: 100%; background: #ffffff; transition: width 0.4s ease; }
  .pending .pending-thumbs { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
  .pending .pending-thumb { width: 96px; max-width: 30%; display: flex; flex-direction: column; gap: 4px; border-radius: 6px; overflow: hidden; background: rgba(255,255,255,0.08); }
  .pending .pending-thumb video, .pending .pending-thumb img { width: 100%; aspect-ratio: 16/9; object-fit: cover; display: block; background: rgba(0,0,0,0.2); }
  .pending .pending-thumb span { font-size: 10px; padding: 0 4px 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .failed-body {
    margin: 0 16px 16px; padding: 14px 16px;
    background: var(--err-bg); border: 1px solid var(--err-border); color: var(--err-fg);
    border-radius: var(--radius-sm); font-size: 13px;
  }
  .info-body {
    margin: 0 16px 16px; padding: 14px 16px;
    background: var(--info-bg); color: var(--fg);
    border-radius: var(--radius-sm); font-size: 13px; line-height: 1.45;
  }
  .card > .info-body:first-child, .card > .failed-body:first-child { margin-top: 16px; }
</style></head>
<body>
<div id="root"><div class="card"><div class="placeholder"><span class="dot"></span><div class="col"><span class="tag">Versely</span><span>Preparing preview...</span></div></div></div></div>
<script>
(function () {
  var root = document.getElementById('root');
  var CARD_META_KEY = 'studio.versely/card';
  var POLL_ERROR_LIMIT = 3;
  var POLL_STALE_MS = 30000;
  var OPEN_LINK_FALLBACK_MS = 1500;
  // ChatGPT keeps a widget's state with its message (window.openai.widgetState),
  // across re-renders and page reloads. A finished card saves itself there, so
  // a card mounted again shows its result straight away and never re-polls.
  var WIDGET_STATE_KEY = 'versely_card';
  var state = null;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function urlExt(u) {
    try { var p = new URL(u).pathname; var m = p.match(/\.([a-z0-9]+)$/i); return (m ? m[1] : '').toLowerCase(); }
    catch (e) { return ''; }
  }
  function isVideoUrl(u) { return /^(mp4|mov|webm|m4v|mkv)$/.test(urlExt(u)); }
  function isAudioUrl(u) { return /^(mp3|wav|m4a|ogg|oga|flac|aac|mpeg|mpga|opus|weba)$/.test(urlExt(u)); }
  function assign() {
    var out = {};
    for (var i = 0; i < arguments.length; i++) {
      var src = arguments[i];
      if (!src || typeof src !== 'object') continue;
      for (var k in src) if (Object.prototype.hasOwnProperty.call(src, k)) out[k] = src[k];
    }
    return out;
  }

  // --- Rendering -------------------------------------------------------------
  function renderChips(s) {
    var chips = [];
    if (s.model) chips.push('<span class="chip">' + esc(s.model) + '</span>');
    if (s.aspect_ratio) chips.push('<span class="chip">' + esc(s.aspect_ratio) + '</span>');
    if (s.size) chips.push('<span class="chip">' + esc(s.size) + '</span>');
    if (s.duration_seconds) chips.push('<span class="chip">' + esc(s.duration_seconds) + 's</span>');
    if (s.seed != null) chips.push('<span class="chip">seed ' + esc(s.seed) + '</span>');
    return chips.length ? '<div class="chips">' + chips.join('') + '</div>' : '';
  }
  function renderHead(s) {
    var text = s.prompt || s.text || s.title || s.summary || '';
    if (!text) return '';
    return '<div class="head"><div class="prompt" data-prompt>' + esc(text) + '</div>' +
      '<button class="toggle" data-toggle aria-label="Expand">&#8964;</button></div>';
  }
  function renderImageGrid(assets) {
    var n = assets.length;
    var cls = n === 1 ? 'n1' : n === 2 ? 'n2' : n === 3 ? 'n3' : 'n4plus';
    var html = '<div class="grid ' + cls + '">';
    for (var i = 0; i < n; i++) {
      var a = assets[i] || {};
      var url = esc(a.url || '');
      var inner;
      if (isVideoUrl(a.url)) {
        inner = '<video src="' + url + '" controls playsinline preload="metadata" referrerpolicy="no-referrer"></video>';
      } else if (isAudioUrl(a.url)) {
        inner = '<audio src="' + url + '" controls preload="metadata"></audio>';
      } else {
        inner = '<img src="' + url + '" alt="' + esc(a.label || '') + '" loading="lazy" referrerpolicy="no-referrer" data-open="' + url + '"/>';
      }
      html += '<div class="' + (n === 1 ? 'tile solo' : 'tile') + '">' + inner + '</div>';
    }
    return html + '</div>';
  }
  function renderVideo(asset) {
    return '<video class="player" src="' + esc(asset.url) + '" controls playsinline preload="metadata" referrerpolicy="no-referrer"></video>';
  }
  function renderAudio(assets) {
    var html = '<div class="audio-list">';
    for (var i = 0; i < assets.length; i++) {
      var a = assets[i] || {}; if (!a.url) continue;
      html += '<div class="audio-row"><div class="audio-label">' + esc(a.label || ('Track ' + (i + 1))) + '</div>' +
        '<audio src="' + esc(a.url) + '" controls preload="metadata" referrerpolicy="no-referrer"></audio></div>';
    }
    return html + '</div>';
  }
  function formatElapsed(ms) {
    var secs = Math.max(0, Math.round(ms / 1000));
    var mm = Math.floor(secs / 60), ss = secs % 60;
    return mm + ':' + (ss < 10 ? '0' + ss : ss);
  }
  function renderPending(s) {
    var isMovie = (typeof s.scenes_total === 'number' && s.scenes_total > 0);
    var headline;
    var titlePrefix = s.title ? esc(s.title) + ' - ' : '';
    if (isMovie) {
      var done = (typeof s.scenes_completed === 'number') ? s.scenes_completed : 0;
      var total = s.scenes_total;
      var plural = total === 1 ? '' : 's';
      if (s.phase === 'planning') headline = titlePrefix + 'planned ' + total + ' scene' + plural + ' (not generating yet)';
      else if (s.phase === 'combining') headline = titlePrefix + 'all scenes ready, combining...';
      else headline = titlePrefix + done + ' of ' + total + ' scene' + plural + ' ready';
    } else {
      var kindLabel = s.kind === 'video' ? 'video' : s.kind === 'audio' ? 'audio' : s.kind === 'gallery' ? 'media' : 'image';
      headline = 'Generating ' + kindLabel + '...';
    }
    var planning = isMovie && s.phase === 'planning';
    var pct = (typeof s.progress === 'number' && !isNaN(s.progress))
      ? Math.max(0, Math.min(100, s.progress > 1 ? s.progress : s.progress * 100)) : null;
    var thumbs = '';
    if (isMovie) {
      var assets = Array.isArray(s.assets) ? s.assets.filter(function (a) { return a && a.url; }) : [];
      if (assets.length) {
        thumbs = '<div class="pending-thumbs">';
        for (var i = 0; i < assets.length; i++) {
          var a = assets[i], label = esc(a.label || '');
          if (isVideoUrl(a.url)) thumbs += '<div class="pending-thumb"><video src="' + esc(a.url) + '" muted playsinline preload="metadata" referrerpolicy="no-referrer"></video><span>' + label + '</span></div>';
          else if (!isAudioUrl(a.url)) thumbs += '<div class="pending-thumb"><img src="' + esc(a.url) + '" alt="' + label + '" referrerpolicy="no-referrer"><span>' + label + '</span></div>';
        }
        thumbs += '</div>';
      }
    }
    return '<div class="pending"><div class="pending-row">' +
      (planning ? '<div class="planning-dot"></div>' : '<div class="spin"></div>') +
      '<div class="col"><div class="label">' + headline + '</div>' +
      (planning ? '' : '<div class="elapsed" data-elapsed>' + formatElapsed(pollElapsedMs()) + ' elapsed</div>') +
      (planning || pct == null ? '' : '<div class="progress"><div class="bar" data-bar style="width:' + pct.toFixed(0) + '%"></div></div>') +
      '</div></div>' + thumbs + '</div>';
  }
  function primaryUrl(s, assets) {
    if (s.final_video_url) return s.final_video_url;
    return assets.length === 1 ? assets[0].url : '';
  }
  function renderFoot(s, assets) {
    var label = s.toolName ? String(s.toolName).replace(/^versely_/, '') : 'media';
    var open = '';
    var url = s.status === 'pending' || s.status === 'failed' || s.status === 'info' ? '' : primaryUrl(s, assets);
    if (url) open = '<button class="open-link" data-open="' + esc(url) + '">Open</button>';
    return '<div class="foot">' + open + '<span class="brand"><span class="brand-dot"></span>Versely &middot; ' + esc(label) + '</span></div>';
  }

  function render() {
    if (!state) return;
    var s = state;
    var assets = Array.isArray(s.assets) ? s.assets.filter(function (a) { return a && a.url; }) : [];
    var kind = s.kind;
    if (!kind) kind = assets.length === 1 ? (isVideoUrl(assets[0].url) ? 'video' : isAudioUrl(assets[0].url) ? 'audio' : 'image') : 'gallery';
    var body;
    if (s.status === 'pending') body = renderPending(s);
    else if (s.status === 'failed') body = '<div class="failed-body">' + esc(s.error || s.message || 'Generation failed.') + '</div>';
    else if (s.status === 'info') body = '<div class="info-body">' + esc(s.message || 'Done.') + '</div>';
    else if (!assets.length) body = '<div class="loading">No media returned.</div>';
    else if (kind === 'video' || (assets.length === 1 && isVideoUrl(assets[0].url))) body = renderVideo(assets[0]);
    else if (kind === 'audio' || isAudioUrl(assets[0].url)) body = renderAudio(assets);
    else body = renderImageGrid(assets);
    root.innerHTML = '<div class="card">' + renderHead(s) + renderChips(s) + body + renderFoot(s, assets) + '</div>';

    var toggle = root.querySelector('[data-toggle]');
    var prompt = root.querySelector('[data-prompt]');
    if (toggle && prompt) toggle.addEventListener('click', function () { prompt.classList.toggle('expanded'); });
    var links = root.querySelectorAll('[data-open]');
    for (var i = 0; i < links.length; i++) {
      links[i].addEventListener('click', function (ev) { ev.preventDefault(); openLink(this.getAttribute('data-open')); });
    }
    reportSize();
  }

  // --- Host bridge -----------------------------------------------------------
  var seq = 0;
  function nextId() { seq += 1; return Date.now() * 1000 + (seq % 1000); }
  function send(msg) { try { if (window.parent) window.parent.postMessage(msg, '*'); } catch (e) {} }
  function reply(id, result) { send({ jsonrpc: '2.0', id: id, result: result || {} }); }
  var callbacks = {};
  function request(method, params, onDone) {
    var id = nextId();
    if (onDone) callbacks[id] = onDone;
    send({ jsonrpc: '2.0', id: id, method: method, params: params || {} });
    return id;
  }

  function applyTheme(theme) {
    if (theme === 'dark' || theme === 'light') document.documentElement.setAttribute('data-theme', theme);
  }

  function openLink(url) {
    if (!url) return;
    var settled = false;
    function fallback() {
      if (settled) return;
      settled = true;
      try { window.open(url, '_blank', 'noopener,noreferrer'); } catch (e) {}
    }
    request('ui/open-link', { url: url }, function (msg) {
      if (msg.error || (msg.result && msg.result.isError)) fallback();
      else settled = true;
    });
    setTimeout(fallback, OPEN_LINK_FALLBACK_MS);
  }

  // --- Polling: one request in flight, chained with setTimeout -------------
  var poll = { active: false, spec: null, startedAt: 0, inflightId: null, errors: 0,
               nextTimer: null, staleTimer: null, budgetTimer: null, tickTimer: null };

  function pollElapsedMs() { return poll.startedAt ? Date.now() - poll.startedAt : 0; }
  function pollTaskLabel() {
    var args = (poll.spec && poll.spec.args) || {};
    return args.request_id || args.run_id || args.movie_id || args.project_id || (state && state.task_id) || 'this job';
  }

  function stopPolling() {
    poll.active = false;
    poll.inflightId = null;
    if (poll.nextTimer) { clearTimeout(poll.nextTimer); poll.nextTimer = null; }
    if (poll.staleTimer) { clearTimeout(poll.staleTimer); poll.staleTimer = null; }
    if (poll.budgetTimer) { clearTimeout(poll.budgetTimer); poll.budgetTimer = null; }
    if (poll.tickTimer) { clearInterval(poll.tickTimer); poll.tickTimer = null; }
  }

  function finish(patch) {
    stopPolling();
    var kind = state && state.kind;
    state = assign(state, patch);
    if (kind && !patch.kind) state.kind = kind;
    delete state.poll;
    render();
    saveFinished(state);
  }

  // Only what the card needs to draw itself again (the model reads widget
  // state too): no poll handle, no tool args, at most 12 assets.
  function saveFinished(s) {
    try {
      var o = window.openai;
      if (!o || typeof o.setWidgetState !== 'function' || !s) return;
      var keep = { status: s.status, kind: s.kind, task_id: s.task_id, model: s.model, toolName: s.toolName,
                   title: s.title, final_video_url: s.final_video_url, error: s.error, message: s.message };
      if (Array.isArray(s.assets)) keep.assets = s.assets.slice(0, 12);
      if (typeof s.prompt === 'string') keep.prompt = s.prompt.slice(0, 200);
      var ws = assign(o.widgetState || {});
      ws[WIDGET_STATE_KEY] = keep;
      o.setWidgetState(ws);
    } catch (e) {}
  }

  // A saved finished card wins over the original "pending" tool output.
  function restoreFinished() {
    try {
      var ws = window.openai && window.openai.widgetState;
      var saved = ws && ws[WIDGET_STATE_KEY];
      if (!saved || (saved.status !== 'completed' && saved.status !== 'failed')) return;
      if (state && (state.status === 'completed' || state.status === 'failed')) return;
      stopPolling();
      state = assign(saved);
      render();
    } catch (e) {}
  }

  function startPolling(s) {
    if (poll.active || !s || s.status !== 'pending' || !s.poll || !s.poll.tool_name) return;
    poll.active = true;
    poll.spec = s.poll;
    poll.startedAt = Date.now();
    poll.errors = 0;
    var budget = s.poll.timeout_ms > 0 ? s.poll.timeout_ms : 600000;
    poll.budgetTimer = setTimeout(function () {
      finish({ status: 'failed', error: 'This preview stopped checking, but the job may still finish. Ask for the status of ' + pollTaskLabel() + ' to collect it.' });
    }, budget);
    poll.tickTimer = setInterval(function () {
      var el = root.querySelector('[data-elapsed]');
      if (el) el.textContent = formatElapsed(pollElapsedMs()) + ' elapsed';
    }, 1000);
    sendPoll();
  }

  function scheduleNextPoll() {
    if (!poll.active || poll.nextTimer || poll.inflightId != null) return;
    var interval = poll.spec.interval_ms > 0 ? poll.spec.interval_ms : 5000;
    poll.nextTimer = setTimeout(function () { poll.nextTimer = null; sendPoll(); }, interval);
  }

  function sendPoll() {
    if (!poll.active || poll.inflightId != null) return;
    var id = nextId();
    poll.inflightId = id;
    // ChatGPT's own bridge first: window.openai.callTool is its supported way
    // for a widget to call a tool, and the MCP Apps tools/call message is not
    // answered on every surface. Anything else gets the standard message.
    var oa = window.openai;
    if (oa && typeof oa.callTool === 'function') {
      try {
        Promise.resolve(oa.callTool(poll.spec.tool_name, poll.spec.args || {})).then(function (res) {
          if (poll.inflightId !== id) return;
          var r = res && res.result && typeof res.result === 'object' ? res.result : res;
          onPollResponse({ id: id, result: r || {} });
        }, function (err) {
          if (poll.inflightId !== id) return;
          onPollResponse({ id: id, error: { message: String((err && err.message) || err) } });
        });
      } catch (e) {
        send({ jsonrpc: '2.0', id: id, method: 'tools/call',
               params: { name: poll.spec.tool_name, arguments: poll.spec.args || {} } });
      }
    } else {
      send({ jsonrpc: '2.0', id: id, method: 'tools/call',
             params: { name: poll.spec.tool_name, arguments: poll.spec.args || {} } });
    }
    poll.staleTimer = setTimeout(function () {
      if (poll.inflightId !== id) return;
      poll.inflightId = null;
      poll.staleTimer = null;
      onPollError();
    }, POLL_STALE_MS);
  }

  function onPollError() {
    poll.errors += 1;
    if (poll.errors >= POLL_ERROR_LIMIT) {
      finish({ status: 'failed', error: 'Live updates are unavailable here, so this card cannot refresh itself. The job keeps running: ask for the status of ' + pollTaskLabel() + ' to collect the result.' });
      return;
    }
    scheduleNextPoll();
  }

  // Accepts every shape a host hands back for a tool call: the MCP result,
  // one wrapped in { result }, or that result serialized to a string.
  function cardStateFromResult(result, depth) {
    if (typeof result === 'string') {
      try { result = JSON.parse(result); } catch (e) { return null; }
    }
    if (!result || typeof result !== 'object') return null;
    var metaObj = result._meta || result.meta;
    var meta = metaObj && metaObj[CARD_META_KEY];
    var sc = result.structuredContent;
    if (sc || meta) return assign(meta, sc);
    if (result.result && !depth) return cardStateFromResult(result.result, 1);
    if (Array.isArray(result.content)) {
      for (var i = 0; i < result.content.length; i++) {
        var c = result.content[i];
        if (c && c.type === 'text' && typeof c.text === 'string') {
          try {
            var parsed = JSON.parse(c.text);
            if (parsed && typeof parsed === 'object' && (parsed.status || parsed.assets)) return parsed;
          } catch (e) {}
        }
      }
    }
    return null;
  }

  var MERGEABLE = ['assets', 'progress', 'phase', 'scenes_total', 'scenes_completed', 'scenes_failed',
                   'scenes_generating', 'scenes_pending', 'title'];

  function onPollResponse(msg) {
    if (poll.staleTimer) { clearTimeout(poll.staleTimer); poll.staleTimer = null; }
    poll.inflightId = null;
    if (!poll.active) return;
    if (msg.error) return onPollError();
    var result = msg.result || {};
    var sc = cardStateFromResult(result);
    // An error that doesn't describe the job (no task_id) is transport or
    // tool trouble: retry it. Only the job itself can say it failed.
    if (!sc || (result.isError && !sc.task_id) || sc.status === 'info') return onPollError();
    poll.errors = 0;
    var hasAssets = Array.isArray(sc.assets) && sc.assets.length > 0;
    if (sc.status === 'completed' || (!sc.status && hasAssets)) {
      finish(assign(sc, { status: 'completed', kind: (state && state.kind) || sc.kind }));
      return;
    }
    if (sc.status === 'failed') {
      finish({ status: 'failed', error: sc.error || sc.message || 'Generation failed.' });
      return;
    }
    var before = state && Array.isArray(state.assets) ? state.assets.length : 0;
    var scenesBefore = state ? state.scenes_completed : undefined;
    var merged = assign(state);
    for (var i = 0; i < MERGEABLE.length; i++) if (MERGEABLE[i] in sc) merged[MERGEABLE[i]] = sc[MERGEABLE[i]];
    state = merged;
    var grew = (Array.isArray(state.assets) ? state.assets.length : 0) > before;
    if (grew || state.scenes_completed !== scenesBefore) {
      render();
    } else if (typeof sc.progress === 'number') {
      var bar = root.querySelector('[data-bar]');
      var pct = Math.max(0, Math.min(100, sc.progress > 1 ? sc.progress : sc.progress * 100));
      if (bar) bar.style.width = pct.toFixed(0) + '%';
    }
    scheduleNextPoll();
  }

  // --- State ingestion ---------------------------------------------------------
  var lastInput = null;
  var lastIngestKey = null;
  function ingest(structured, meta) {
    var cardMeta = meta && meta[CARD_META_KEY];
    if (!structured && !cardMeta) return;
    // Hosts re-deliver the same tool output (ChatGPT on every
    // openai:set_globals, which the card's own resize fires once it has
    // finished). Taking it again reset the finished card to "Generating" and
    // restarted polling, in a loop, so the media never showed.
    var key;
    try { key = JSON.stringify([structured || null, cardMeta || null]); } catch (e) { key = null; }
    if (key !== null && key === lastIngestKey) return;
    var next = assign(cardMeta, structured);
    // This iframe renders one tool call, so a finished card never goes back to pending.
    if (state && (state.status === 'completed' || state.status === 'failed') && next.status === 'pending') return;
    lastIngestKey = key;
    if (lastInput && !next.toolArgs) next.toolArgs = lastInput;
    state = next;
    render();
    startPolling(state);
  }

  var lastReportedH = -1;
  function reportSize() {
    try {
      var card = document.querySelector('.card') || document.body;
      var rect = card.getBoundingClientRect();
      var h = Math.ceil(rect.height) || document.documentElement.scrollHeight;
      var w = Math.ceil(rect.width) || document.documentElement.scrollWidth;
      if (h === lastReportedH || h <= 0) return;
      lastReportedH = h;
      send({ jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { width: w, height: h } });
    } catch (e) {}
  }
  try { new ResizeObserver(function () { reportSize(); }).observe(document.body); } catch (e) {}
  window.addEventListener('load', reportSize);
  setTimeout(reportSize, 50);
  setTimeout(reportSize, 300);

  // window.openai globals (ChatGPT), read once now and again on each update.
  // openai:set_globals fires for every global (theme, maxHeight, display
  // mode...); ingest() ignores a tool output it has already taken.
  function readOpenAiGlobals() {
    try {
      var o = window.openai;
      if (!o) return;
      if (o.theme) applyTheme(o.theme);
      if (o.toolInput) lastInput = o.toolInput;
      restoreFinished();
      if (o.toolOutput || o.toolResponseMetadata) ingest(o.toolOutput, o.toolResponseMetadata);
    } catch (e) {}
  }
  window.addEventListener('openai:set_globals', readOpenAiGlobals);
  readOpenAiGlobals();

  var initId = null;
  var initAcked = false;

  window.addEventListener('message', function (ev) {
    var m = ev.data;
    if (!m || typeof m !== 'object') return;

    // Answers to our own requests.
    if (m.id != null && (m.result !== undefined || m.error !== undefined) && !m.method) {
      if (m.id === initId) {
        var hc = m.result && m.result.hostContext;
        if (hc && hc.theme) applyTheme(hc.theme);
        if (!initAcked) {
          initAcked = true;
          send({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} });
        }
        return;
      }
      if (poll.inflightId != null && m.id === poll.inflightId) return onPollResponse(m);
      var cb = callbacks[m.id];
      if (cb) { delete callbacks[m.id]; cb(m); }
      // Anything else is a late answer to a poll we already gave up on: ignore.
      return;
    }

    // Requests from the host.
    if (m.method === 'ping' && m.id != null) return reply(m.id, {});
    if (m.method === 'ui/resource-teardown') {
      stopPolling();
      if (m.id != null) reply(m.id, {});
      return;
    }

    // Notifications from the host.
    var p = m.params || {};
    if (m.method === 'ui/notifications/host-context-changed') return applyTheme(p.theme);
    if (m.method === 'ui/notifications/tool-input') { lastInput = p.arguments || p; return; }
    if (m.method === 'ui/notifications/tool-result') return ingest(p.structuredContent, p._meta);
    if (m.method === 'ui/notifications/tool-cancelled') {
      if (!state) { state = { status: 'info', message: 'This request was cancelled.' }; render(); }
      return;
    }
    // Inspector / legacy shapes.
    if (m.type === 'tool-output' && m.payload) return ingest(m.payload, null);
    if (m.structuredContent) return ingest(m.structuredContent, m._meta);
  });

  try {
    var hash = (location.hash || '').match(/state=([^&]+)/);
    if (hash) ingest(JSON.parse(atob(decodeURIComponent(hash[1]))), null);
  } catch (e) {}

  initId = nextId();
  send({
    jsonrpc: '2.0', id: initId, method: 'ui/initialize',
    params: {
      protocolVersion: '2026-01-26',
      appInfo: { name: 'Versely Media Card', version: '2.0.0' },
      appCapabilities: { availableDisplayModes: ['inline', 'fullscreen'] },
    },
  });
})();
</script>
</body></html>`;

// --- Registry ---------------------------------------------------------------

/**
 * MIME type for SEP-1865 UI resources.
 *
 * The 2026-01-26 spec specifies `text/html;profile=mcp-app` (the original
 * `+mcp` form was rejected by the IANA reviewer as not a valid structured-
 * suffix). claude.ai may detect tools as "Interactive" based on
 * `_meta.ui.resourceUri` presence regardless of resource MIME, but its
 * actual iframe-render validation may strictly require the spec form —
 * which would explain "30 Interactive tools" *and* a non-rendering iframe.
 * Shipping the spec form.
 */
export const UI_MIME_TYPE = "text/html;profile=mcp-app";

/** Single resource URI all media tools point at. */
export const MEDIA_CARD_URI = "ui://versely/media-card";

/** The v2 card's HTML, exported for the offline preview script. */
export const MEDIA_CARD_V2 = MEDIA_CARD_V2_HTML;

/**
 * The v2 card's URI carries a hash of its HTML. ChatGPT caches a widget
 * template by its URI, so a fixed card served under the old URI can keep
 * running the old code (the "Generating" loop was still polling after its
 * fix shipped). A new hash per change makes ChatGPT fetch the new card; old
 * URIs are still answered, with the current card (resolveUiResource).
 */
export const MEDIA_CARD_V2_URI = `${MEDIA_CARD_URI}-${createHash("sha256").update(MEDIA_CARD_V2_HTML).digest("hex").slice(0, 10)}`;

interface UiResourceEntry {
  uri: string;
  name: string;
  description: string;
  html: string;
  /**
   * Spec-canonical _meta attached to the resource (NOT the tool). The
   * resource's _meta.ui declares CSP/permissions — tool _meta.ui only
   * carries resourceUri + visibility.
   */
  meta: Record<string, unknown>;
}

const MEDIA_CARD_CSP = {
  resourceDomains: [
    "https://img.versely.studio",
    "https://videos.versely.studio",
    "https://audio.versely.studio",
    "https://user-files.versely.studio",
    "https://slideshow-images.versely.studio",
    "https://slideshowvideos.versely.studio",
    "https://avatars.versely.studio",
  ],
  connectDomains: [],
  frameDomains: [],
};

const MEDIA_CARD_RESOURCE_META: Record<string, unknown> = {
  ui: {
    // Hosts that respect csp will allow the Versely CDN subdomains so the
    // iframe sandbox doesn't block media loads. claude.ai currently
    // hardcodes its sandbox CSP (anthropics/claude-ai-mcp#40); these
    // declarations kick in once that's fixed and on other hosts today.
    csp: MEDIA_CARD_CSP,
  },
};

/**
 * ChatGPT requires a unique `domain` for the card's sandbox origin and an
 * explicit `prefersBorder`. claude.ai assigns its own sandbox domain per
 * connector, so the full profile keeps the plain meta above unchanged.
 */
const OPENAI_MEDIA_CARD_RESOURCE_META: Record<string, unknown> = {
  ui: {
    csp: MEDIA_CARD_CSP,
    domain: "https://mcp.versely.studio",
    prefersBorder: false,
  },
};

const MEDIA_CARD_NAME = "Versely Media Card";
const MEDIA_CARD_DESCRIPTION =
  "Branded inline card rendering Versely-generated images, videos, audio, and slideshows. Hydrates from structuredContent { kind, assets, model, prompt, toolName, toolArgs }.";

/** The full-profile / v1 resource list (what this server always served). */
export const UI_RESOURCES: ReadonlyArray<UiResourceEntry> = [
  {
    uri: MEDIA_CARD_URI,
    name: MEDIA_CARD_NAME,
    description: MEDIA_CARD_DESCRIPTION,
    html: MEDIA_CARD_HTML,
    meta: MEDIA_CARD_RESOURCE_META,
  },
];

export interface UiResourceOptions {
  profile: Profile;
  /** Serve the v2 card HTML (config.cardV2Profiles has this profile). */
  cardV2: boolean;
}

/** The card URI the tools of a profile point at (v2: hashed, see MEDIA_CARD_V2_URI). */
export function mediaCardUriFor(opts: { cardV2: boolean }): string {
  return opts.cardV2 ? MEDIA_CARD_V2_URI : MEDIA_CARD_URI;
}

/**
 * The picker shows previews from more hosts than the media card: HeyGen's own
 * avatar and voice previews, and brand logos that live on brand.dev. OpenAI's
 * review wants exactly the domains the component fetches from, so every entry
 * here must be one a live picker actually loads.
 */
const PICKER_CSP = {
  ...MEDIA_CARD_CSP,
  resourceDomains: [
    ...MEDIA_CARD_CSP.resourceDomains,
    "https://media.brand.dev",
    "https://files2.heygen.ai",
    "https://resource.heygen.ai",
    "https://static.heygen.ai",
  ],
};

/** The ui:// resources a server for this profile lists and serves. */
export function uiResourcesFor(opts: UiResourceOptions): UiResourceEntry[] {
  const openai = opts.profile === "openai";
  return [
    {
      uri: mediaCardUriFor(opts),
      name: MEDIA_CARD_NAME,
      description: MEDIA_CARD_DESCRIPTION,
      html: opts.cardV2 ? MEDIA_CARD_V2_HTML : MEDIA_CARD_HTML,
      meta: openai ? OPENAI_MEDIA_CARD_RESOURCE_META : MEDIA_CARD_RESOURCE_META,
    },
    {
      uri: PICKER_URI,
      name: PICKER_NAME,
      description: PICKER_DESCRIPTION,
      html: PICKER_HTML,
      meta: {
        ui: openai
          ? { csp: PICKER_CSP, domain: "https://mcp.versely.studio", prefersBorder: false }
          : { csp: PICKER_CSP },
      },
    },
  ];
}

/**
 * The resource for a URI. Any earlier card or picker URI (the plain one, or an
 * older hash a host still holds in a cached tool list) gets the CURRENT one,
 * so a stale descriptor can't pin a broken template.
 */
export function resolveUiResource(resources: readonly UiResourceEntry[], uri: string): UiResourceEntry | undefined {
  const exact = resources.find((r) => r.uri === uri);
  if (exact) return exact;
  for (const base of [MEDIA_CARD_URI, PICKER_URI_BASE]) {
    if (uri === base || uri.startsWith(`${base}-`)) {
      return resources.find((r) => r.uri === base || r.uri.startsWith(`${base}-`));
    }
  }
  return undefined;
}

/** Tool _meta for a tool that opens the picker (the card itself calls versely_browse for "Show more"). */
export function metaForPicker(): Record<string, unknown> {
  return { ui: { resourceUri: PICKER_URI, visibility: ["model", "app"] } };
}

export function getUiResource(
  uri: string,
  opts: UiResourceOptions = { profile: "full", cardV2: false },
): UiResourceEntry | undefined {
  return resolveUiResource(uiResourcesFor(opts), uri);
}

// --- Tool _meta -------------------------------------------------------------

/**
 * Build the `_meta` block to attach to a tool definition. Per the
 * ext-apps spec, tool `_meta.ui` only carries `resourceUri` and
 * `visibility` — CSP and permissions live on the resource's _meta,
 * not the tool's. Extra fields here can cause hosts to reject the
 * tool as malformed, so keep this minimal.
 *
 * `app: true` is for the tools the card itself polls (get_movie_status,
 * get_dub, get_workflow_run, get_video_workflow_run): a host that enforces
 * visibility only lets the card call tools whose list includes "app", and an
 * explicit ["model"] shuts the card out of its own poll loop.
 */
export function metaForMediaCard(opts: { app?: boolean } = {}): Record<string, unknown> {
  return {
    ui: {
      resourceUri: MEDIA_CARD_URI,
      visibility: opts.app ? ["model", "app"] : ["model"],
    },
  };
}

// --- Payload contracts ------------------------------------------------------

export type MediaKind = "image" | "video" | "audio" | "gallery";

/**
 * "info" is a terminal, media-less state with a plain `message` (v2 card);
 * v1 renders it as an empty card.
 */
export type MediaStatus = "pending" | "completed" | "failed" | "info";

export interface UiAsset {
  url: string;
  label?: string;
}

/**
 * Instruction the iframe follows to self-poll an async job. The iframe sends
 * a `tools/call` JSON-RPC to the host every `interval_ms` until either the
 * status flips to `completed`/`failed` or `timeout_ms` elapses. Bypasses
 * claude.ai's per-tool execution budget — each individual poll call is
 * sub-second so it never trips the host-side timeout that wait-mode hits.
 */
export interface PollInstruction {
  tool_name: string;
  args: Record<string, unknown>;
  interval_ms?: number;
  timeout_ms?: number;
}

/**
 * Shape the `structuredContent` payload the media-card template hydrates from.
 * `kind` is a discriminator the card uses to pick its render path; `assets`
 * is normalized across image / video / audio. `toolName` labels the card's
 * footer; it and `toolArgs` are also part of the payload contract for hosts
 * that read structuredContent directly, so both are still emitted.
 *
 * Async tools emit a pending variant: `{kind, assets:[], status:"pending",
 * poll:{...}}`. The iframe then self-polls until the same payload comes back
 * with `status:"completed"` and assets filled in. Tools that finish
 * synchronously can leave `status` undefined — the card treats no-status as
 * completed for backward compatibility with the image-gen path.
 */
export interface MediaCardPayload {
  kind: MediaKind;
  assets: UiAsset[];
  status?: MediaStatus;
  poll?: PollInstruction;
  task_id?: string;
  progress?: number;
  error?: string;
  message?: string;
  model?: string;
  prompt?: string;
  aspect_ratio?: string;
  size?: string;
  duration_seconds?: number;
  seed?: number;
  request_id?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
}

export function buildMediaCardPayload(
  kind: MediaKind,
  assets: UiAsset[],
  extra: Omit<MediaCardPayload, "kind" | "assets"> & Record<string, unknown> = {},
): Record<string, unknown> | undefined {
  // Pending payloads legitimately carry no assets yet — the iframe will
  // poll and fill them in. Drop the empty-assets short-circuit in that case.
  if (assets.length === 0 && extra.status !== "pending") return undefined;
  return { kind, assets, ...extra };
}
