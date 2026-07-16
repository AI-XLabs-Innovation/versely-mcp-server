/**
 * Generate a standalone, offline preview of the media card for local design work.
 *
 * The card HTML is taken verbatim from src/ui/templates.ts — this script only
 * wraps it. That matters: a hand-copied preview drifts from production the first
 * time either side changes, and then you are tuning a card that no longer exists.
 * Regenerate (npm run preview:card) after editing the template and the preview
 * follows automatically.
 *
 * What is added on top of the real template, and is NOT part of production:
 *   1. A hydration shim. In production the host pushes state over postMessage
 *      (ui/notifications/tool-result). Offline there is no host, so we set
 *      `window.openai.toolOutput` — a fallback channel the template already
 *      supports (see "Channel 1" in templates.ts) — before its script runs.
 *   2. A dev toolbar that live-overrides the solo height cap, swaps asset kind
 *      and aspect ratio, and reports the rendered size.
 * Both are clearly fenced below and are stripped from nothing — this file is
 * output-only and never shipped.
 *
 * Assets are inline SVG data URIs at exact aspect ratios, so the preview needs
 * no network, no CORS, and dodges the Cloudflare hotlink protection that blocks
 * *.versely.studio media from non-Versely referers.
 *
 * Usage:  npx tsx scripts/preview-card.ts  [outfile]
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getUiResource, MEDIA_CARD_URI, buildMediaCardPayload } from "../src/ui/templates.js";

// The production default, mirrored here only so the toolbar slider can start in
// the right place. Read from the generated CSS below rather than hardcoding a
// second source of truth.
const CAP_RE = /\.tile\.solo\s*\{[^}]*max-height:\s*(\d+)px/;

/** Inline placeholder at an exact aspect ratio — no network, no CORS. */
function placeholder(w: number, h: number, label: string, hue: number): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="hsl(${hue} 60% 72%)"/>` +
    `<stop offset="1" stop-color="hsl(${(hue + 40) % 360} 55% 42%)"/>` +
    `</linearGradient></defs>` +
    `<rect width="${w}" height="${h}" fill="url(#g)"/>` +
    `<text x="50%" y="50%" fill="rgba(255,255,255,.95)" font-family="system-ui,sans-serif" ` +
    `font-size="${Math.round(Math.min(w, h) / 9)}" font-weight="600" text-anchor="middle" ` +
    `dominant-baseline="middle">${label}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const RATIOS: Record<string, [number, number]> = {
  "4:3": [1024, 768],
  "16:9": [1280, 720],
  "1:1": [900, 900],
  "9:16": [720, 1280],
  "3:2": [1200, 800],
};

/** Payloads the toolbar can switch between, keyed by the label it shows. */
function samplePayloads(): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [name, [w, h]] of Object.entries(RATIOS)) {
    out[`image ${name}`] = buildMediaCardPayload(
      "image",
      [{ url: placeholder(w, h, name, 265), label: `serum-${name}.png` }],
      {
        status: "completed",
        model: "Flux 2 Pro",
        aspect_ratio: name,
        prompt:
          "Editorial skincare product photograph. A single unbranded frosted-glass serum bottle " +
          "with a matte dropper cap, centered on a smooth travertine stone ledge. Soft diffused " +
          "daylight from the left casting a gentle elongated shadow.",
        task_id: "preview-task-0001",
      },
    );
  }

  out["gallery x4"] = buildMediaCardPayload(
    "gallery",
    [
      { url: placeholder(1024, 1024, "1", 265), label: "a.png" },
      { url: placeholder(1024, 1024, "2", 200), label: "b.png" },
      { url: placeholder(1024, 1024, "3", 20), label: "c.png" },
      { url: placeholder(1024, 1024, "4", 140), label: "d.png" },
    ],
    { status: "completed", model: "Flux 2 Pro", prompt: "Four variations.", task_id: "preview-gallery" },
  );

  out["pending"] = buildMediaCardPayload("image", [], {
    status: "pending",
    model: "Flux 2 Pro",
    prompt: "A generation that has been submitted but has not finished yet.",
    task_id: "preview-pending",
    poll: {
      tool_name: "versely_get_task_status",
      args: { request_id: "preview-pending" },
      interval_ms: 5000,
      timeout_ms: 600000,
    },
  });

  out["failed"] = {
    status: "failed",
    task_id: "preview-failed",
    error: "The provider rejected this request (preview sample).",
  };

  return out;
}

function build(): string {
  const resource = getUiResource(MEDIA_CARD_URI);
  if (!resource) throw new Error(`No UI resource registered at ${MEDIA_CARD_URI}`);

  const html = resource.html;
  const cap = html.match(CAP_RE)?.[1] ?? "360";
  const payloads = samplePayloads();
  const defaultKey = "image 4:3";

  // Escape so the JSON can't terminate the <script> that carries it.
  const json = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

  // ── 1. Hydration shim ──────────────────────────────────────────────────────
  // Must execute BEFORE the template's own inline script, which reads
  // window.openai.toolOutput once at startup. Injecting straight after <head>
  // guarantees that ordering.
  const shim = `
<script>
  // PREVIEW ONLY — not part of the production card.
  // Stands in for the MCP host, which normally delivers state via postMessage.
  window.__PREVIEW_PAYLOADS__ = ${json(payloads)};
  window.__PREVIEW_DEFAULT__ = ${json(defaultKey)};
  window.__PREVIEW_CAP__ = ${json(Number(cap))};
  window.openai = { toolOutput: window.__PREVIEW_PAYLOADS__[window.__PREVIEW_DEFAULT__] };
  // The card posts JSON-RPC to window.parent. Standalone, parent === self, so
  // the messages would loop back into its own handler. Swallow them.
  window.addEventListener('message', function (e) {
    if (e.data && e.data.jsonrpc) e.stopImmediatePropagation();
  }, true);
</script>`;

  // ── 2. Dev toolbar ─────────────────────────────────────────────────────────
  const toolbar = `
<div id="devbar">
  <div class="row">
    <label>Height cap <b id="capval">${cap}px</b></label>
    <input id="cap" type="range" min="160" max="640" step="10" value="${cap}"/>
    <span class="hint">production: ${cap}px</span>
  </div>
  <div class="row">
    <label>Sample</label>
    <select id="kind">${Object.keys(payloads)
      .map((k) => `<option${k === defaultKey ? " selected" : ""}>${k}</option>`)
      .join("")}</select>
    <label>Frame width <b id="wval">720px</b></label>
    <input id="w" type="range" min="320" max="720" step="10" value="720"/>
  </div>
  <div class="row"><span class="hint" id="size">rendered: —</span></div>
</div>
<style>
  /* PREVIEW ONLY. */
  body { margin: 0; padding: 0; background: #1a1a1c; }
  #devbar {
    position: fixed; top: 0; left: 0; right: 0; z-index: 99999;
    background: #101012; border-bottom: 1px solid #2a2a2e; color: #e7e7ea;
    font: 12px/1.5 system-ui, sans-serif; padding: 10px 14px;
    display: flex; flex-direction: column; gap: 8px;
  }
  #devbar .row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  #devbar label { color: #9b9ba3; }
  #devbar b { color: #c4b5fd; font-variant-numeric: tabular-nums; }
  #devbar input[type=range] { width: 200px; accent-color: #7c3aed; }
  #devbar select { background: #1c1c20; color: #e7e7ea; border: 1px solid #35353b; border-radius: 6px; padding: 3px 6px; }
  #devbar .hint { color: #6b6b74; }
  /* Push the real card below the toolbar and give it the host's frame width. */
  #previewframe { padding: 96px 0 40px; display: flex; justify-content: center; }
  #previewwrap { width: 720px; max-width: 100%; }
</style>
<script>
  // PREVIEW ONLY — drives the toolbar. None of this ships.
  (function () {
    var card = document.querySelector('.card') || document.body.firstElementChild;
    // Wrap the real card so we can constrain its width like the host does.
    var frame = document.createElement('div'); frame.id = 'previewframe';
    var wrap = document.createElement('div'); wrap.id = 'previewwrap';
    frame.appendChild(wrap);
    document.body.appendChild(frame);
    function adopt() {
      var c = document.querySelector('#previewwrap > .card') ? null : document.querySelector('.card');
      if (c && c.parentElement !== wrap) wrap.appendChild(c);
    }
    adopt();
    new MutationObserver(adopt).observe(document.body, { childList: true, subtree: true });

    var override = document.createElement('style');
    document.head.appendChild(override);
    var capEl = document.getElementById('cap');
    var capVal = document.getElementById('capval');
    var wEl = document.getElementById('w');
    var wVal = document.getElementById('wval');
    var sizeEl = document.getElementById('size');

    function applyCap() {
      var v = capEl.value;
      capVal.textContent = v + 'px';
      // Mirrors the three production rules that share the cap.
      override.textContent =
        '.tile.solo{max-height:' + v + 'px!important}' +
        '.tile.solo img,.tile.solo video{max-height:' + v + 'px!important}' +
        '.player{max-height:' + v + 'px!important}';
      measure();
    }
    function applyW() {
      wVal.textContent = wEl.value + 'px';
      wrap.style.width = wEl.value + 'px';
      measure();
    }
    function measure() {
      requestAnimationFrame(function () {
        var c = wrap.querySelector('.card');
        var m = wrap.querySelector('.tile.solo img, .tile.solo video, .player, .grid');
        sizeEl.textContent = c
          ? 'rendered: card ' + Math.round(c.getBoundingClientRect().width) + '×' +
            Math.round(c.getBoundingClientRect().height) + 'px' +
            (m ? '  ·  media ' + Math.round(m.getBoundingClientRect().width) + '×' +
                 Math.round(m.getBoundingClientRect().height) + 'px' : '')
          : 'rendered: —';
      });
    }
    capEl.addEventListener('input', applyCap);
    wEl.addEventListener('input', applyW);
    document.getElementById('kind').addEventListener('change', function (e) {
      var p = window.__PREVIEW_PAYLOADS__[e.target.value];
      // Re-hydrate through the same postMessage shape the real host uses, so we
      // exercise the template's actual render path rather than a special case.
      window.postMessage({
        jsonrpc: '2.0',
        method: 'ui/notifications/tool-result',
        params: { structuredContent: p, content: [] },
      }, '*');
      setTimeout(measure, 60);
    });
    applyCap(); applyW();
    setTimeout(measure, 200);
  })();
</script>`;

  return html
    .replace("<head>", "<head>" + shim)
    .replace("</body></html>", toolbar + "</body></html>");
}

const outPath = resolve(process.argv[2] ?? "preview/media-card.html");
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, build(), "utf8");
console.log(`Wrote ${outPath}`);
console.log("Open it in a browser. Regenerate after editing src/ui/templates.ts.");
