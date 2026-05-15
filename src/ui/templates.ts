// Self-contained HTML templates served via the MCP Apps (SEP-1865) extension.
//
// Each template is a single string that gets served from `resources/read` with
// mimeType `text/html+mcp`. The host renders it in a sandboxed iframe and
// hydrates it with the tool result's `structuredContent` via postMessage
// (and/or a window-injected `window.openai`-style object, depending on host).
//
// Templates must be:
//   - Self-contained (no external scripts, no external CSS frameworks)
//   - Resilient to multiple hydration channels (postMessage, window globals,
//     URL params) — we don't know in advance which the host uses
//   - Graceful when hydration never arrives ("Loading…" placeholder)
//
// Images/videos load from the Versely CDN — that domain must be reachable
// from the iframe (claude.ai's CSP permits arbitrary https origins as media
// sources for now).

export const IMAGE_VIEWER_HTML = String.raw`<!DOCTYPE html>
<html><head><meta charset="utf-8"/>
<style>
  :root { color-scheme: light dark; }
  html, body { margin: 0; padding: 0; background: transparent; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
  #app { padding: 4px; }
  .loading { padding: 16px; opacity: 0.6; font-size: 13px; }
  .grid { display: grid; gap: 8px; }
  .n1 { grid-template-columns: 1fr; }
  .n2 { grid-template-columns: 1fr 1fr; }
  .n3 { grid-template-columns: repeat(3, 1fr); }
  .nMany { grid-template-columns: repeat(2, 1fr); }
  figure { margin: 0; }
  img { width: 100%; display: block; border-radius: 8px; cursor: zoom-in; transition: transform 120ms ease; }
  img:hover { transform: scale(1.01); }
  figcaption { font-size: 11px; opacity: 0.55; margin-top: 4px; word-break: break-all; }
</style></head>
<body>
<div id="app"><div class="loading">Loading preview…</div></div>
<script>
(function () {
  var state = null;
  var root = document.getElementById('app');

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function render() {
    if (!state) { return; }
    var images = (state && state.images) || [];
    if (!images.length) {
      root.innerHTML = '<div class="loading">No images.</div>';
      return;
    }
    var n = images.length;
    var cls = n === 1 ? 'n1' : n === 2 ? 'n2' : n === 3 ? 'n3' : 'nMany';
    var html = '<div class="grid ' + cls + '">';
    for (var i = 0; i < n; i++) {
      var img = images[i] || {};
      var url = esc(img.url || '');
      var lab = esc(img.label || '');
      html += '<figure>' +
        '<a href="' + url + '" target="_blank" rel="noopener">' +
          '<img src="' + url + '" alt="' + lab + '"/>' +
        '</a>' +
        (lab ? '<figcaption>' + lab + '</figcaption>' : '') +
      '</figure>';
    }
    html += '</div>';
    root.innerHTML = html;
  }

  function hydrate(data) {
    if (!data) return;
    state = data;
    render();
  }

  // Channel 1: window.openai-style global injected by host before load.
  try {
    if (window.openai && window.openai.toolOutput) {
      hydrate(window.openai.toolOutput);
    }
  } catch (e) {}

  // Channel 2: postMessage from host. Accept several wire formats observed
  // in the SEP-1865 ecosystem.
  window.addEventListener('message', function (ev) {
    var m = ev.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'tool-output' && m.payload) return hydrate(m.payload);
    if (m.type === 'mcp.ui.state' && m.payload) return hydrate(m.payload);
    if (m.method === 'ui/state' && m.params) return hydrate(m.params);
    if (m.method === 'ui/setState' && m.params) return hydrate(m.params);
    if (m.structuredContent) return hydrate(m.structuredContent);
  });

  // Channel 3: URL hash fallback (?state=<base64-json>)
  try {
    var match = (location.hash || '').match(/state=([^&]+)/);
    if (match) hydrate(JSON.parse(atob(decodeURIComponent(match[1]))));
  } catch (e) {}

  // Signal readiness — many hosts wait for this before sending state.
  try {
    window.parent && window.parent.postMessage(
      { jsonrpc: '2.0', method: 'ui/ready', id: 1 }, '*'
    );
  } catch (e) {}
})();
</script>
</body></html>`;

export const VIDEO_PLAYER_HTML = String.raw`<!DOCTYPE html>
<html><head><meta charset="utf-8"/>
<style>
  :root { color-scheme: light dark; }
  html, body { margin: 0; padding: 0; background: transparent; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
  #app { padding: 4px; }
  .loading { padding: 16px; opacity: 0.6; font-size: 13px; }
  video { width: 100%; max-height: 70vh; border-radius: 8px; background: #000; display: block; }
  .meta { font-size: 11px; opacity: 0.6; margin-top: 6px; word-break: break-all; }
</style></head>
<body>
<div id="app"><div class="loading">Loading video…</div></div>
<script>
(function () {
  var root = document.getElementById('app');
  function esc(s) { return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function render(state) {
    if (!state) return;
    var url = state.videoUrl || (state.video && state.video.url);
    var poster = state.posterUrl || state.poster;
    var label = state.label || state.title || '';
    if (!url) { root.innerHTML = '<div class="loading">No video URL.</div>'; return; }
    var u = esc(url);
    root.innerHTML =
      '<video src="' + u + '" controls playsinline preload="metadata"' +
        (poster ? ' poster="' + esc(poster) + '"' : '') + '></video>' +
      (label ? '<div class="meta">' + esc(label) + '</div>' : '');
  }
  function hydrate(data) { if (data) render(data); }
  try { if (window.openai && window.openai.toolOutput) hydrate(window.openai.toolOutput); } catch (e) {}
  window.addEventListener('message', function (ev) {
    var m = ev.data; if (!m || typeof m !== 'object') return;
    if (m.type === 'tool-output' && m.payload) return hydrate(m.payload);
    if (m.type === 'mcp.ui.state' && m.payload) return hydrate(m.payload);
    if (m.method === 'ui/state' && m.params) return hydrate(m.params);
    if (m.method === 'ui/setState' && m.params) return hydrate(m.params);
    if (m.structuredContent) return hydrate(m.structuredContent);
  });
  try { var match = (location.hash || '').match(/state=([^&]+)/);
    if (match) hydrate(JSON.parse(atob(decodeURIComponent(match[1])))); } catch (e) {}
  try { window.parent && window.parent.postMessage({ jsonrpc: '2.0', method: 'ui/ready', id: 1 }, '*'); } catch (e) {}
})();
</script>
</body></html>`;

export const AUDIO_PLAYER_HTML = String.raw`<!DOCTYPE html>
<html><head><meta charset="utf-8"/>
<style>
  :root { color-scheme: light dark; }
  html, body { margin: 0; padding: 0; background: transparent; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
  #app { padding: 8px; }
  .loading { padding: 16px; opacity: 0.6; font-size: 13px; }
  audio { width: 100%; display: block; }
  .label { font-size: 12px; opacity: 0.7; margin-bottom: 6px; }
  .row { margin-bottom: 10px; }
</style></head>
<body>
<div id="app"><div class="loading">Loading audio…</div></div>
<script>
(function () {
  var root = document.getElementById('app');
  function esc(s) { return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function render(state) {
    if (!state) return;
    var tracks = state.tracks || (state.audioUrl ? [{ url: state.audioUrl, label: state.label || state.title }] : []);
    if (!tracks.length) { root.innerHTML = '<div class="loading">No audio URL.</div>'; return; }
    var html = '';
    for (var i = 0; i < tracks.length; i++) {
      var t = tracks[i] || {}; if (!t.url) continue;
      html += '<div class="row">' +
        (t.label ? '<div class="label">' + esc(t.label) + '</div>' : '') +
        '<audio src="' + esc(t.url) + '" controls preload="metadata"></audio>' +
      '</div>';
    }
    root.innerHTML = html || '<div class="loading">No audio URL.</div>';
  }
  function hydrate(data) { if (data) render(data); }
  try { if (window.openai && window.openai.toolOutput) hydrate(window.openai.toolOutput); } catch (e) {}
  window.addEventListener('message', function (ev) {
    var m = ev.data; if (!m || typeof m !== 'object') return;
    if (m.type === 'tool-output' && m.payload) return hydrate(m.payload);
    if (m.type === 'mcp.ui.state' && m.payload) return hydrate(m.payload);
    if (m.method === 'ui/state' && m.params) return hydrate(m.params);
    if (m.method === 'ui/setState' && m.params) return hydrate(m.params);
    if (m.structuredContent) return hydrate(m.structuredContent);
  });
  try { var match = (location.hash || '').match(/state=([^&]+)/);
    if (match) hydrate(JSON.parse(atob(decodeURIComponent(match[1])))); } catch (e) {}
  try { window.parent && window.parent.postMessage({ jsonrpc: '2.0', method: 'ui/ready', id: 1 }, '*'); } catch (e) {}
})();
</script>
</body></html>`;

export const GALLERY_HTML = String.raw`<!DOCTYPE html>
<html><head><meta charset="utf-8"/>
<style>
  :root { color-scheme: light dark; }
  html, body { margin: 0; padding: 0; background: transparent; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
  #app { padding: 4px; }
  .loading { padding: 16px; opacity: 0.6; font-size: 13px; }
  .wrap { display: flex; flex-wrap: wrap; gap: 8px; }
  .tile { flex: 1 1 calc(33.333% - 8px); min-width: 120px; }
  .tile img, .tile video { width: 100%; display: block; border-radius: 8px; aspect-ratio: 1 / 1; object-fit: cover; background: #000; }
  .tile .cap { font-size: 11px; opacity: 0.55; margin-top: 4px; word-break: break-all; }
</style></head>
<body>
<div id="app"><div class="loading">Loading…</div></div>
<script>
(function () {
  var root = document.getElementById('app');
  function esc(s) { return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function isVideo(url) { return /\.(mp4|webm|mov|m4v|mkv)(\?|$)/i.test(url || ''); }
  function render(state) {
    if (!state) return;
    var items = state.items || state.images || [];
    if (!items.length) { root.innerHTML = '<div class="loading">No items.</div>'; return; }
    var html = '<div class="wrap">';
    for (var i = 0; i < items.length; i++) {
      var it = items[i] || {}; var url = it.url || ''; if (!url) continue;
      var cap = esc(it.label || '');
      var tag = isVideo(url)
        ? '<video src="' + esc(url) + '" muted playsinline preload="metadata"></video>'
        : '<img src="' + esc(url) + '" alt="' + cap + '"/>';
      html += '<div class="tile">' +
        '<a href="' + esc(url) + '" target="_blank" rel="noopener">' + tag + '</a>' +
        (cap ? '<div class="cap">' + cap + '</div>' : '') +
      '</div>';
    }
    html += '</div>';
    root.innerHTML = html;
  }
  function hydrate(data) { if (data) render(data); }
  try { if (window.openai && window.openai.toolOutput) hydrate(window.openai.toolOutput); } catch (e) {}
  window.addEventListener('message', function (ev) {
    var m = ev.data; if (!m || typeof m !== 'object') return;
    if (m.type === 'tool-output' && m.payload) return hydrate(m.payload);
    if (m.type === 'mcp.ui.state' && m.payload) return hydrate(m.payload);
    if (m.method === 'ui/state' && m.params) return hydrate(m.params);
    if (m.method === 'ui/setState' && m.params) return hydrate(m.params);
    if (m.structuredContent) return hydrate(m.structuredContent);
  });
  try { var match = (location.hash || '').match(/state=([^&]+)/);
    if (match) hydrate(JSON.parse(atob(decodeURIComponent(match[1])))); } catch (e) {}
  try { window.parent && window.parent.postMessage({ jsonrpc: '2.0', method: 'ui/ready', id: 1 }, '*'); } catch (e) {}
})();
</script>
</body></html>`;

// Registry of all UI resources. Keys are the `ui://` URIs declared on tools
// via `_meta["ui/resourceUri"]`. Values are the raw HTML served from
// resources/read with mimeType `text/html+mcp`.

export type UiTemplate =
  | "image-viewer"
  | "video-player"
  | "audio-player"
  | "gallery";

interface UiResourceEntry {
  template: UiTemplate;
  uri: string;
  name: string;
  description: string;
  html: string;
}

export const UI_RESOURCES: ReadonlyArray<UiResourceEntry> = [
  {
    template: "image-viewer",
    uri: "ui://versely/image-viewer",
    name: "Versely image viewer",
    description:
      "Grid viewer for generated images. Hydrates from structuredContent.images = [{url, label?}].",
    html: IMAGE_VIEWER_HTML,
  },
  {
    template: "video-player",
    uri: "ui://versely/video-player",
    name: "Versely video player",
    description:
      "Single-video player. Hydrates from structuredContent.videoUrl (+ optional posterUrl, label).",
    html: VIDEO_PLAYER_HTML,
  },
  {
    template: "audio-player",
    uri: "ui://versely/audio-player",
    name: "Versely audio player",
    description:
      "Audio playlist. Hydrates from structuredContent.tracks = [{url, label?}] or {audioUrl, label}.",
    html: AUDIO_PLAYER_HTML,
  },
  {
    template: "gallery",
    uri: "ui://versely/gallery",
    name: "Versely mixed-media gallery",
    description:
      "Flex-wrap gallery for slideshows / scenes / search results. Hydrates from structuredContent.items = [{url, label?}].",
    html: GALLERY_HTML,
  },
];

export const UI_MIME_TYPE = "text/html+mcp";

const TEMPLATE_TO_URI: Record<UiTemplate, string> = UI_RESOURCES.reduce(
  (acc, r) => {
    acc[r.template] = r.uri;
    return acc;
  },
  {} as Record<UiTemplate, string>,
);

export function getUiResource(uri: string): UiResourceEntry | undefined {
  return UI_RESOURCES.find((r) => r.uri === uri);
}

export function uriForTemplate(template: UiTemplate): string {
  return TEMPLATE_TO_URI[template];
}

/**
 * Build the `_meta` object declared on a tool definition. Emits both the spec
 * form (`ui/resourceUri`) and the dot-form compat alias (`ui.resourceUri`) so
 * hosts that haven't migrated to the slash form still pick up the binding.
 */
export function metaForTemplate(template: UiTemplate): Record<string, unknown> {
  const uri = uriForTemplate(template);
  return {
    "ui/resourceUri": uri,
    "ui.resourceUri": uri,
  };
}

// --- Payload contracts -------------------------------------------------------
// `structuredContent` shape per template. Each media tool builds one of these
// from its asset list and the host hydrates the iframe with it.

export interface UiAsset {
  url: string;
  label?: string;
}

export interface ImageViewerPayload {
  images: UiAsset[];
}
export interface VideoPlayerPayload {
  videoUrl: string;
  posterUrl?: string;
  label?: string;
}
export interface AudioPlayerPayload {
  tracks: UiAsset[];
}
export interface GalleryPayload {
  items: UiAsset[];
}

export type UiPayload =
  | { template: "image-viewer"; data: ImageViewerPayload }
  | { template: "video-player"; data: VideoPlayerPayload }
  | { template: "audio-player"; data: AudioPlayerPayload }
  | { template: "gallery"; data: GalleryPayload };

/**
 * Shape an asset list into the template-specific structuredContent payload.
 * Returns `undefined` when there's nothing renderable (caller falls back to
 * a plain JSON result with no iframe).
 */
export function buildUiPayload(
  template: UiTemplate,
  assets: UiAsset[],
): Record<string, unknown> | undefined {
  if (assets.length === 0) return undefined;
  switch (template) {
    case "image-viewer":
      return { images: assets } satisfies ImageViewerPayload;
    case "video-player": {
      const first = assets[0]!;
      return {
        videoUrl: first.url,
        ...(first.label ? { label: first.label } : {}),
      } satisfies VideoPlayerPayload;
    }
    case "audio-player":
      return { tracks: assets } satisfies AudioPlayerPayload;
    case "gallery":
      return { items: assets } satisfies GalleryPayload;
  }
}
