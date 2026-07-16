// Branded inline media card served via the MCP Apps extension (SEP-1865).
//
// Spec: https://github.com/modelcontextprotocol/ext-apps
// Stable: specification/2026-01-26/apps.mdx
//
// One template covers every Versely media-producing tool. The card detects
// asset kind (image / video / audio / mixed) from `structuredContent.kind`
// and renders accordingly. Buttons (Recreate, etc.) round-trip through the
// host via `tools/call` JSON-RPC over postMessage.
//
// Protocol (host ↔ iframe over `postMessage`):
//   Host → iframe (notifications):
//     `ui/notifications/tool-input`  — { arguments: <ToolInput> }
//     `ui/notifications/tool-result` — { content, structuredContent }
//     `ui/notifications/tool-cancelled` — { reason }
//   Iframe → host (requests):
//     `ui/initialize`               — handshake, declares display modes
//     `tools/call`                  — invoke a server tool (Recreate, etc.)
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
  .actions { display: flex; gap: 8px; flex: 1; }
  .btn {
    appearance: none; border: 1px solid var(--card-border);
    background: var(--card); color: var(--fg);
    padding: 6px 12px; border-radius: var(--radius-sm);
    font-size: 12px; font-weight: 500;
    cursor: pointer; display: inline-flex; align-items: center; gap: 5px;
    transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
  }
  .btn:hover { background: var(--chip-bg); }
  .btn.primary { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }
  .btn.primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
  .btn[disabled] { opacity: 0.5; cursor: default; }
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
    var canRecreate = !!(s.toolName);
    var html = '<div class="actions">';
    html += '<button class="btn primary" data-recreate' + (canRecreate ? '' : ' disabled') + '>' +
      '<span aria-hidden="true">↻</span>Recreate</button>';
    html += '</div>';
    var toolLabel = s.toolName ? s.toolName.replace(/^versely_/, '') : 'media';
    html += '<span class="brand"><span class="brand-dot"></span>Versely · ' + esc(toolLabel) + '</span>';
    return html;
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
    var recreate = root.querySelector('[data-recreate]');
    if (recreate && s.toolName) {
      recreate.addEventListener('click', function () {
        recreate.disabled = true;
        recreate.innerHTML = '<span aria-hidden="true">…</span>Working…';
        callTool(s.toolName, s.toolArgs || {});
      });
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
  function callTool(name, args) {
    send({
      jsonrpc: '2.0', id: nextId(),
      method: 'tools/call',
      params: { name: name, arguments: args || {} },
    });
  }

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
    if (!sc) return;

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
        // Treat tool-call errors during polling as a transient hiccup —
        // the next tick will retry. Only stop if it persists past the
        // overall timeout (handled by pollTimeoutHandle).
        console.warn('[versely-mcp ui] poll error', m.error);
        return;
      }
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
      var btn = document.querySelector('[data-recreate]');
      if (btn) { btn.disabled = false; btn.innerHTML = '<span aria-hidden="true">↻</span>Recreate'; }
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

const MEDIA_CARD_RESOURCE_META: Record<string, unknown> = {
  ui: {
    // Hosts that respect csp will allow the Versely CDN subdomains so the
    // iframe sandbox doesn't block media loads. claude.ai currently
    // hardcodes its sandbox CSP (anthropics/claude-ai-mcp#40); these
    // declarations kick in once that's fixed and on other hosts today.
    csp: {
      resourceDomains: [
        "https://img.versely.studio",
        "https://videos.versely.studio",
        "https://audio.versely.studio",
        "https://user-files.versely.studio",
        "https://slideshow-images.versely.studio",
        "https://slideshowvideos.versely.studio",
        "https://avatars.versely.studio",
        "https://cdn.versely.studio",
      ],
      connectDomains: [],
      frameDomains: [],
    },
  },
};

export const UI_RESOURCES: ReadonlyArray<UiResourceEntry> = [
  {
    uri: MEDIA_CARD_URI,
    name: "Versely Media Card",
    description:
      "Branded inline card rendering Versely-generated images, videos, audio, and slideshows. Hydrates from structuredContent { kind, assets, model, prompt, toolName, toolArgs }.",
    html: MEDIA_CARD_HTML,
    meta: MEDIA_CARD_RESOURCE_META,
  },
];

export function getUiResource(uri: string): UiResourceEntry | undefined {
  return UI_RESOURCES.find((r) => r.uri === uri);
}

// --- Tool _meta -------------------------------------------------------------

/**
 * Build the `_meta` block to attach to a tool definition. Per the
 * ext-apps spec, tool `_meta.ui` only carries `resourceUri` and
 * `visibility` — CSP and permissions live on the resource's _meta,
 * not the tool's. Extra fields here can cause hosts to reject the
 * tool as malformed, so keep this minimal.
 */
export function metaForMediaCard(): Record<string, unknown> {
  return {
    ui: {
      resourceUri: MEDIA_CARD_URI,
      visibility: ["model"],
    },
  };
}

// --- Payload contracts ------------------------------------------------------

export type MediaKind = "image" | "video" | "audio" | "gallery";

export type MediaStatus = "pending" | "completed" | "failed";

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
 * is normalized across image / video / audio. `toolName` + `toolArgs` enable
 * the Recreate button to round-trip the same call.
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
