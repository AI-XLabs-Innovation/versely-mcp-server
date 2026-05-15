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
    max-width: 100%;
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
  .tile.solo img, .tile.solo video { aspect-ratio: var(--ar, auto); object-fit: contain; background: #000; cursor: pointer; }
  /* Video / single-asset */
  .player { width: 100%; display: block; background: #000; }
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
</style></head>
<body>
<div id="root"><div class="loading">Loading preview…</div></div>
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
  function isAudioUrl(u) { return /^(mp3|wav|m4a|ogg|flac|aac)$/.test(urlExt(u)); }
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
      html += '<div class="' + tileCls + '">' +
        '<a href="' + url + '" target="_blank" rel="noopener">' +
          '<img src="' + url + '" alt="' + label + '" loading="lazy"/>' +
        '</a>' +
      '</div>';
    }
    html += '</div>';
    return html;
  }

  function renderVideo(asset) {
    if (!asset || !asset.url) return '<div class="err">No video.</div>';
    var u = esc(asset.url);
    return '<video class="player" src="' + u + '" controls playsinline preload="metadata"></video>';
  }

  function renderAudio(assets) {
    if (!assets.length) return '<div class="err">No audio.</div>';
    var html = '<div class="audio-list">';
    for (var i = 0; i < assets.length; i++) {
      var a = assets[i] || {}; if (!a.url) continue;
      var lab = esc(a.label || ('Track ' + (i + 1)));
      html += '<div class="audio-row">' +
        '<div class="audio-label">' + lab + '</div>' +
        '<audio src="' + esc(a.url) + '" controls preload="metadata"></audio>' +
      '</div>';
    }
    html += '</div>';
    return html;
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
    if (assets.length === 0) {
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
    try { window.parent && window.parent.postMessage(msg, '*'); } catch (e) {}
  }
  function callTool(name, args) {
    send({
      jsonrpc: '2.0', id: nextId(),
      method: 'tools/call',
      params: { name: name, arguments: args || {} },
    });
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
  window.addEventListener('load', function () { reportSize(); });

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
  window.addEventListener('message', function (ev) {
    var m = ev.data;
    if (!m || typeof m !== 'object') return;

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

  // Spec-canonical initialization handshake. Hosts wait for this before
  // delivering tool-input / tool-result notifications.
  send({
    jsonrpc: '2.0', id: nextId(),
    method: 'ui/initialize',
    params: {
      protocolVersion: '2026-01-26',
      appCapabilities: { availableDisplayModes: ['inline'] },
    },
  });
})();
</script>
</body></html>`;

// --- Registry ---------------------------------------------------------------

/**
 * Spec-canonical MIME for SEP-1865 UI resources, per the 2026-01-26 stable
 * spec (corrected from the original `text/html+mcp` proposal after IANA
 * review — `+mcp` is not a valid structured-suffix). Some hosts still
 * recognize the legacy form; we ship the canonical one and accept that
 * out-of-date hosts may need to update.
 */
export const UI_MIME_TYPE = "text/html;profile=mcp-app";

/** Single resource URI all media tools point at. */
export const MEDIA_CARD_URI = "ui://versely/media-card";

interface UiResourceEntry {
  uri: string;
  name: string;
  description: string;
  html: string;
}

export const UI_RESOURCES: ReadonlyArray<UiResourceEntry> = [
  {
    uri: MEDIA_CARD_URI,
    name: "Versely Media Card",
    description:
      "Branded inline card rendering Versely-generated images, videos, audio, and slideshows. Hydrates from structuredContent { kind, assets, model, prompt, toolName, toolArgs }.",
    html: MEDIA_CARD_HTML,
  },
];

export function getUiResource(uri: string): UiResourceEntry | undefined {
  return UI_RESOURCES.find((r) => r.uri === uri);
}

// --- Tool _meta -------------------------------------------------------------

/**
 * Build the `_meta` block to attach to a tool definition. Emits the
 * spec-canonical nested `_meta.ui = { resourceUri, csp, ... }` form **and**
 * the deprecated flat `ui/resourceUri` key for compatibility with hosts
 * that still match the old shape.
 */
export function metaForMediaCard(): Record<string, unknown> {
  return {
    // Spec-canonical (SEP-1865 stable, 2026-01-26).
    ui: {
      resourceUri: MEDIA_CARD_URI,
      // Hosts that respect csp will whitelist the Versely CDN subdomains so
      // the iframe sandbox doesn't block media loads. claude.ai currently
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
      prefersBorder: true,
      visibility: ["model"],
    },
    // Deprecated flat-key form — kept as a compatibility hint for older
    // host implementations that haven't migrated to the nested object yet.
    "ui/resourceUri": MEDIA_CARD_URI,
  };
}

// --- Payload contracts ------------------------------------------------------

export type MediaKind = "image" | "video" | "audio" | "gallery";

export interface UiAsset {
  url: string;
  label?: string;
}

/**
 * Shape the `structuredContent` payload the media-card template hydrates from.
 * `kind` is a discriminator the card uses to pick its render path; `assets`
 * is normalized across image / video / audio. `toolName` + `toolArgs` enable
 * the Recreate button to round-trip the same call.
 */
export interface MediaCardPayload {
  kind: MediaKind;
  assets: UiAsset[];
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
  if (assets.length === 0) return undefined;
  return { kind, assets, ...extra };
}
