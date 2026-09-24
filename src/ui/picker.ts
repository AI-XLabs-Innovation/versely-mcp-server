// Visual picker served via MCP Apps: a grid of options (slideshow styles,
// avatars, voices, templates, brands) the user browses and picks from in the
// chat, instead of reading a list of ids. versely_browse fills it.
//
// A pick goes back to the conversation as the user's own message: ChatGPT's
// window.openai.sendFollowUpMessage when present, else the MCP Apps standard
// ui/message; if neither lands, ui/update-model-context so the model still
// sees it on the next turn. "Show more" and the search box page through the
// whole collection by calling versely_browse again from the card.
//
// NOTE: the HTML is a String.raw template - no backticks anywhere inside it,
// comments included (they close the template early).

import { createHash } from "node:crypto";

const PICKER_HTML = String.raw`<!doctype html>
<html><head><meta charset="utf-8"/>
<meta name="color-scheme" content="light dark"/>
<meta name="referrer" content="no-referrer"/>
<style>
  :root {
    color-scheme: light dark;
    --card: #ffffff; --card-border: #e5e7eb; --fg: #0a0a0b; --muted: #4b5563;
    --tile: #f3f4f6; --tile-border: #e5e7eb; --accent: #7c3aed; --radius: 14px;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --card: #131316; --card-border: #27272a; --fg: #f4f4f5; --muted: #d4d4d8;
      --tile: #1f1f23; --tile-border: #2e2e33;
    }
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --card: #131316; --card-border: #27272a; --fg: #f4f4f5; --muted: #d4d4d8;
    --tile: #1f1f23; --tile-border: #2e2e33;
  }
  :root[data-theme="light"] { color-scheme: light; }
  html, body { margin: 0; padding: 0; background: transparent; color: var(--fg);
    font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", system-ui, sans-serif;
    -webkit-font-smoothing: antialiased; }
  .card { background: var(--card); border: 1px solid var(--card-border); border-radius: var(--radius);
    padding: 14px; box-sizing: border-box; }
  .top { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; flex-wrap: wrap; }
  .title { font-size: 14px; font-weight: 600; flex: 1; min-width: 140px; }
  .count { font-size: 12px; color: var(--fg); }
  .search { width: 100%; box-sizing: border-box; padding: 8px 10px; border-radius: 10px; border: 1px solid var(--tile-border);
    background: var(--tile); color: var(--fg); font-size: 13px; outline: none; margin-bottom: 12px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
  .item { background: var(--tile); border: 1px solid var(--tile-border); border-radius: 12px; overflow: hidden;
    display: flex; flex-direction: column; }
  .item.picked { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  .media { position: relative; width: 100%; aspect-ratio: 3 / 4; background: rgba(0,0,0,0.25); overflow: hidden; }
  .media.wide { aspect-ratio: 16 / 9; }
  .media img, .media video { width: 100%; height: 100%; object-fit: cover; display: block; }
  .media .strip { position: absolute; left: 6px; right: 6px; bottom: 6px; display: flex; gap: 4px; }
  .media .strip img { width: 22%; aspect-ratio: 9 / 16; height: auto; border-radius: 4px; border: 1px solid rgba(255,255,255,0.6); }
  .media .noimg { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center;
    font-size: 30px; font-weight: 700; color: var(--fg); }
  .badge { position: absolute; top: 6px; left: 6px; background: rgba(0,0,0,0.65); color: #ffffff;
    font-size: 11px; padding: 2px 7px; border-radius: 999px; }
  .play { position: absolute; right: 8px; bottom: 8px; width: 34px; height: 34px; border-radius: 999px; border: 0;
    background: rgba(0,0,0,0.65); color: #ffffff; font-size: 13px; cursor: pointer; }
  .meta { padding: 8px 10px 10px; display: flex; flex-direction: column; gap: 3px; flex: 1; }
  .name { font-size: 13px; font-weight: 600; line-height: 1.3; }
  .sub { font-size: 11.5px; color: var(--fg); line-height: 1.35; overflow: hidden;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .use { margin-top: auto; padding: 7px 10px; border-radius: 9px; border: 0; cursor: pointer;
    background: var(--fg); color: var(--card); font-size: 12.5px; font-weight: 600; }
  .item.picked .use { background: var(--accent); color: #ffffff; }
  .foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 12px; flex-wrap: wrap; }
  .more { padding: 7px 12px; border-radius: 9px; border: 1px solid var(--tile-border); background: var(--tile);
    color: var(--fg); font-size: 12.5px; cursor: pointer; }
  .note { font-size: 12px; color: var(--fg); }
  .empty { font-size: 13px; color: var(--fg); padding: 18px 4px; text-align: center; }
  .brand { font-size: 11px; color: var(--fg); }
</style></head>
<body>
<div id="root"><div class="card"><div class="empty">Loading options...</div></div></div>
<script>
(function () {
  var root = document.getElementById('root');
  var META_KEY = 'studio.versely/picker';
  var WIDGET_KEY = 'versely_picker';
  var data = null;          // { collection, title, noun, items, total, offset, q, category, more }
  var query = '';
  var picked = null;        // id of the chosen item
  var note = '';
  var busy = false;

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function assign() {
    var out = {};
    for (var i = 0; i < arguments.length; i++) {
      var src = arguments[i];
      if (!src || typeof src !== 'object') continue;
      for (var k in src) if (Object.prototype.hasOwnProperty.call(src, k)) out[k] = src[k];
    }
    return out;
  }

  // --- Host bridge ---------------------------------------------------------
  var seq = 0;
  var callbacks = {};
  function nextId() { seq += 1; return Date.now() * 1000 + (seq % 1000); }
  function send(msg) { try { if (window.parent) window.parent.postMessage(msg, '*'); } catch (e) {} }
  function request(method, params, onDone) {
    var id = nextId();
    if (onDone) callbacks[id] = onDone;
    send({ jsonrpc: '2.0', id: id, method: method, params: params || {} });
    return id;
  }
  function applyTheme(theme) {
    if (theme === 'dark' || theme === 'light') document.documentElement.setAttribute('data-theme', theme);
  }
  var lastH = -1;
  function reportSize() {
    try {
      var card = document.querySelector('.card') || document.body;
      var r = card.getBoundingClientRect();
      var h = Math.ceil(r.height), w = Math.ceil(r.width);
      if (h <= 0 || h === lastH) return;
      lastH = h;
      send({ jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { width: w, height: h } });
    } catch (e) {}
  }
  try { new ResizeObserver(function () { reportSize(); }).observe(document.body); } catch (e) {}

  // --- State ---------------------------------------------------------------
  function pickerFrom(structured, meta) {
    var fromMeta = meta && (meta[META_KEY] || (meta['studio.versely/card'] && meta['studio.versely/card'].picker));
    var fromSc = structured && (structured.picker || (structured.items ? structured : null));
    var p = fromMeta || fromSc;
    return p && Array.isArray(p.items) ? p : null;
  }
  function ingest(structured, meta) {
    var p = pickerFrom(structured, meta);
    if (!p) {
      // A failed browse (the server's safety net) - say so instead of spinning.
      var err = structured && (structured.error || (structured.status === 'failed' && structured.message));
      if (err && !data) root.innerHTML = '<div class="card"><div class="empty">' + esc(err) + '</div></div>';
      return;
    }
    if (data && data.collection === p.collection && data.items && data.items.length && p.offset === data.offset && p.q === data.q) return;
    data = p;
    render();
  }
  function restoreChoice() {
    try {
      var ws = window.openai && window.openai.widgetState;
      var saved = ws && ws[WIDGET_KEY];
      if (saved && saved.picked) { picked = saved.picked; note = saved.note || ''; }
    } catch (e) {}
  }
  function saveChoice() {
    try {
      var o = window.openai;
      if (!o || typeof o.setWidgetState !== 'function') return;
      var ws = assign(o.widgetState || {});
      ws[WIDGET_KEY] = { picked: picked, note: note };
      o.setWidgetState(ws);
    } catch (e) {}
  }

  // --- Picking ---------------------------------------------------------------
  function contextFallback(text) {
    request('ui/update-model-context', { content: [{ type: 'text', text: text }] }, function () {});
    note = 'Chosen. Send a message to continue.';
    render();
  }
  function choose(item) {
    picked = item.id;
    note = 'Sent: ' + item.title;
    render();
    saveChoice();
    var text = item.pick || ('Use ' + item.title + ' (' + item.id + ').');
    var o = window.openai;
    if (o && typeof o.sendFollowUpMessage === 'function') {
      try {
        Promise.resolve(o.sendFollowUpMessage({ prompt: text })).then(null, function () { contextFallback(text); });
        return;
      } catch (e) {}
    }
    var answered = false;
    request('ui/message', { role: 'user', content: [{ type: 'text', text: text }] }, function (msg) {
      answered = true;
      if (msg.error || (msg.result && msg.result.isError)) contextFallback(text);
    });
    setTimeout(function () { if (!answered) contextFallback(text); }, 4000);
  }

  // --- More / search (versely_browse called from the card) ---------------------
  function browse(args, replace) {
    if (busy || !data) return;
    busy = true;
    render();
    var params = assign({ collection: data.collection }, args);
    function done(result) {
      busy = false;
      var r = result && result.result && typeof result.result === 'object' ? result.result : result;
      if (r && typeof r.result === 'string') { try { r = JSON.parse(r.result); } catch (e) {} }
      var p = r ? pickerFrom(r.structuredContent, r._meta || r.meta) : null;
      if (p) {
        if (replace) data = p;
        else data = assign(p, { items: (data.items || []).concat(p.items), offset: data.offset });
      } else {
        note = 'Could not load more here - ask in the chat instead.';
      }
      render();
    }
    var o = window.openai;
    if (o && typeof o.callTool === 'function') {
      try {
        Promise.resolve(o.callTool('versely_browse', params)).then(done, function () { done(null); });
        return;
      } catch (e) {}
    }
    request('tools/call', { name: 'versely_browse', arguments: params }, function (msg) {
      done(msg.error ? null : msg.result);
    });
  }

  // --- Rendering -------------------------------------------------------------
  function mediaHtml(it) {
    var wide = data && data.wide ? ' wide' : '';
    var inner;
    if (it.video) {
      inner = '<video src="' + esc(it.video) + '" muted loop playsinline preload="metadata" referrerpolicy="no-referrer"' +
        (it.image ? ' poster="' + esc(it.image) + '"' : '') + ' data-hover></video>';
    } else if (it.image) {
      inner = '<img src="' + esc(it.image) + '" alt="" data-initial="' + esc(String(it.title || '?').charAt(0).toUpperCase()) + '" loading="lazy" referrerpolicy="no-referrer"/>';
    } else {
      inner = '<div class="noimg">' + esc(String(it.title || '?').charAt(0).toUpperCase()) + '</div>';
    }
    var strip = '';
    if (Array.isArray(it.images) && it.images.length > 1) {
      strip = '<div class="strip">';
      for (var i = 1; i < Math.min(it.images.length, 5); i++) {
        strip += '<img src="' + esc(it.images[i]) + '" alt="" loading="lazy" referrerpolicy="no-referrer"/>';
      }
      strip += '</div>';
    }
    var badge = it.badge ? '<span class="badge">' + esc(it.badge) + '</span>' : '';
    var play = it.audio ? '<button class="play" data-audio="' + esc(it.audio) + '" aria-label="Play">&#9654;</button>' : '';
    return '<div class="media' + wide + '">' + inner + strip + badge + play + '</div>';
  }
  function visibleItems() {
    var items = (data && data.items) || [];
    var q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(function (it) {
      return (String(it.title) + ' ' + String(it.subtitle || '') + ' ' + String(it.id)).toLowerCase().indexOf(q) !== -1;
    });
  }
  function render() {
    if (!data) return;
    var items = visibleItems();
    var html = '<div class="card"><div class="top"><div class="title">' + esc(data.title || 'Choose one') + '</div>' +
      '<div class="count">' + esc(String((data.items || []).length)) + (data.total ? ' of ' + esc(String(data.total)) : '') + '</div></div>' +
      '<input class="search" data-search placeholder="Search ' + esc(data.noun ? data.noun + 's' : 'options') + ' (Enter searches all)" value="' + esc(query) + '"/>';
    if (!items.length) {
      html += '<div class="empty">Nothing matches.</div>';
    } else {
      html += '<div class="grid">';
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        html += '<div class="item' + (picked === it.id ? ' picked' : '') + '">' + mediaHtml(it) +
          '<div class="meta"><div class="name">' + esc(it.title) + '</div>' +
          (it.subtitle ? '<div class="sub">' + esc(it.subtitle) + '</div>' : '') +
          '<button class="use" data-pick="' + i + '">' + (picked === it.id ? 'Chosen' : 'Use this') + '</button></div></div>';
      }
      html += '</div>';
    }
    var hasMore = data.more && !busy;
    html += '<div class="foot"><span class="note">' + esc(busy ? 'Loading...' : note) + '</span>' +
      (hasMore ? '<button class="more" data-more>Show more</button>' : '<span class="brand">Versely</span>') + '</div></div>';
    root.innerHTML = html;

    var search = root.querySelector('[data-search]');
    if (search) {
      search.addEventListener('input', function () { query = search.value; renderGridOnly(); });
      search.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' && search.value.trim()) browse({ q: search.value.trim() }, true);
      });
    }
    bindItems(items);
    var more = root.querySelector('[data-more]');
    if (more) more.addEventListener('click', function () { browse({ q: data.q || undefined, category: data.category || undefined, offset: (data.items || []).length }, false); });
    reportSize();
  }
  function renderGridOnly() {
    var pos = null;
    var s = root.querySelector('[data-search]');
    if (s) pos = s.selectionStart;
    render();
    var s2 = root.querySelector('[data-search]');
    if (s2) { s2.focus(); try { s2.setSelectionRange(pos, pos); } catch (e) {} }
  }
  function bindItems(items) {
    // A preview the host blocks or that is gone (brand logos live on each
    // brand's own site) becomes the initial-letter tile, never a broken image.
    var covers = root.querySelectorAll('.media > img');
    for (var c = 0; c < covers.length; c++) {
      covers[c].addEventListener('error', function () {
        var tile = document.createElement('div');
        tile.className = 'noimg';
        tile.textContent = this.getAttribute('data-initial') || '?';
        if (this.parentNode) this.parentNode.replaceChild(tile, this);
      });
    }
    var buttons = root.querySelectorAll('[data-pick]');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].addEventListener('click', function () { choose(items[Number(this.getAttribute('data-pick'))]); });
    }
    var vids = root.querySelectorAll('[data-hover]');
    for (var j = 0; j < vids.length; j++) {
      (function (v) {
        v.addEventListener('mouseenter', function () { try { v.play(); } catch (e) {} });
        v.addEventListener('mouseleave', function () { try { v.pause(); } catch (e) {} });
        v.addEventListener('click', function () { try { v.paused ? v.play() : v.pause(); } catch (e) {} });
      })(vids[j]);
    }
    var plays = root.querySelectorAll('[data-audio]');
    for (var k = 0; k < plays.length; k++) {
      plays[k].addEventListener('click', function () {
        var src = this.getAttribute('data-audio');
        if (!window.__verselyAudio) window.__verselyAudio = new Audio();
        var a = window.__verselyAudio;
        if (a.src === src && !a.paused) { a.pause(); return; }
        a.src = src;
        try { a.play(); } catch (e) {}
      });
    }
  }

  // --- Wiring ----------------------------------------------------------------
  function readOpenAiGlobals() {
    try {
      var o = window.openai;
      if (!o) return;
      if (o.theme) applyTheme(o.theme);
      restoreChoice();
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
    if (m.id != null && (m.result !== undefined || m.error !== undefined) && !m.method) {
      if (m.id === initId) {
        var hc = m.result && m.result.hostContext;
        if (hc && hc.theme) applyTheme(hc.theme);
        if (!initAcked) { initAcked = true; send({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} }); }
        return;
      }
      var cb = callbacks[m.id];
      if (cb) { delete callbacks[m.id]; cb(m); }
      return;
    }
    if (m.method === 'ping' && m.id != null) return send({ jsonrpc: '2.0', id: m.id, result: {} });
    if (m.method === 'ui/resource-teardown') { if (m.id != null) send({ jsonrpc: '2.0', id: m.id, result: {} }); return; }
    var p = m.params || {};
    if (m.method === 'ui/notifications/host-context-changed') return applyTheme(p.theme);
    if (m.method === 'ui/notifications/tool-result') return ingest(p.structuredContent, p._meta);
    if (m.structuredContent) return ingest(m.structuredContent, m._meta);
  });

  initId = nextId();
  send({
    jsonrpc: '2.0', id: initId, method: 'ui/initialize',
    params: {
      protocolVersion: '2026-01-26',
      appInfo: { name: 'Versely Picker', version: '1.0.0' },
      appCapabilities: { availableDisplayModes: ['inline', 'fullscreen'] },
    },
  });
})();
</script>
</body></html>`;

/** The picker's URI carries a hash of its HTML: hosts that cache templates by URI (ChatGPT) fetch each new version. */
export const PICKER_URI_BASE = "ui://versely/picker";
export const PICKER_URI = `${PICKER_URI_BASE}-${createHash("sha256").update(PICKER_HTML).digest("hex").slice(0, 10)}`;
export const PICKER_HTML_FOR_TESTS = PICKER_HTML;
export const PICKER_META_KEY = "studio.versely/picker";

export const PICKER_NAME = "Versely Picker";
export const PICKER_DESCRIPTION =
  "A grid of options (slideshow styles, avatars, voices, templates, brands) the user picks from; the pick is sent to the chat.";
export { PICKER_HTML };
