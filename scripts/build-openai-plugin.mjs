#!/usr/bin/env node
// Builds the ChatGPT / Codex plugin ZIP from openai/ and checks it against
// OpenAI's submission limits first (developers.openai.com/plugins/deploy/submission).
//
//   node scripts/build-openai-plugin.mjs          # writes output/versely-openai-<version>.zip
//   node scripts/build-openai-plugin.mjs --check  # validate only
//
// Never put reviewer credentials or the demo video URL in openai/: both go in
// the OpenAI dashboard, and this repo is public.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "openai");
const manifest = JSON.parse(readFileSync(join(src, "plugin.json"), "utf8"));
const mcp = JSON.parse(readFileSync(join(src, "mcp.json"), "utf8"));
const ui = manifest.extensions?.["com.openai"]?.interface ?? {};
const review = manifest.extensions?.["com.openai"]?.review ?? {};

const problems = [];
const check = (ok, msg) => { if (!ok) problems.push(msg); };
const len = (s) => [...(s ?? "")].length;

check(/^[a-z0-9-]{1,64}$/.test(manifest.name ?? ""), "name: 1-64 lowercase letters, digits or dashes");
check(/^\d+\.\d+\.\d+$/.test(manifest.version ?? ""), "version: semver x.y.z");
check(len(ui.displayName) > 0 && len(ui.displayName) <= 30, "displayName: 1-30 characters");
check(!/\b(mcp|plugin)\b/i.test(ui.displayName ?? ""), "displayName: no MCP / Plugin suffix");
check(len(ui.shortDescription) > 0 && len(ui.shortDescription) <= 30, "shortDescription: 1-30 characters");
check(len(ui.longDescription) > 0 && len(ui.longDescription) <= 4000, "longDescription: 1-4000 characters");
check(!/\b(price|pricing|\$\d|subscri|free trial|trial|discount|promo|coupon|free credits)\b/i.test(ui.longDescription ?? ""), "longDescription: no pricing, subscriptions, trials, discounts or promotions");
check(len(ui.developerName) > 0 && len(ui.developerName) <= 80, "developerName: 1-80 characters");
for (const k of ["websiteURL", "supportURL", "privacyPolicyURL", "termsOfServiceURL"]) {
  check(/^https:\/\/\S+$/.test(ui[k] ?? "") && len(ui[k]) <= 1024, `${k}: an https URL of at most 1024 characters`);
}
const prompts = ui.defaultPrompt ?? [];
check(Array.isArray(prompts) && prompts.length <= 3, "defaultPrompt: at most 3");
for (const p of prompts) check(len(p) > 0 && len(p) <= 128 && !/@\w/.test(p), `defaultPrompt "${p.slice(0, 40)}…": 1-128 characters, no @mentions`);
for (const k of ["logo", "composerIcon"]) check(!!ui[k] && existsSync(join(src, ui[k])), `${k}: file exists in openai/`);
check((review.test_cases?.positive ?? []).length === 5, "review: exactly 5 positive test cases");
check((review.test_cases?.negative ?? []).length === 3, "review: exactly 3 negative test cases");
for (const t of review.test_cases?.positive ?? []) check(!!(t.prompt && t.tools_triggered && t.expected_behavior), `positive case "${String(t.prompt).slice(0, 40)}…": prompt, tools_triggered and expected_behavior`);
check(review.commerce === false && !!review.commerce_description, "review: commerce statement");
const servers = Object.values(mcp.mcpServers ?? {});
check(servers.length === 1 && servers[0].type === "streamable-http" && /^https:\/\//.test(servers[0].url), "mcp.json: exactly one streamable-http https server");

const secretish = /(vsk_[A-Za-z0-9]{8,}|password|passwd|secret|api[_-]?key)/i;
check(!secretish.test(JSON.stringify(manifest)) && !secretish.test(JSON.stringify(mcp)), "no credentials or keys in the package");

if (problems.length) {
  console.error(`openai plugin: ${problems.length} problem(s)\n - ${problems.join("\n - ")}`);
  process.exit(1);
}
console.log(`openai plugin ${manifest.version}: all submission limits pass`);
if (process.argv.includes("--check")) process.exit(0);

const outDir = join(root, "output");
mkdirSync(outDir, { recursive: true });
const zip = join(outDir, `versely-openai-${manifest.version}.zip`);
rmSync(zip, { force: true });
execFileSync("zip", ["-q", "-r", "-X", zip, "plugin.json", "mcp.json", "assets"], { cwd: src, stdio: "inherit" });
console.log(`wrote ${zip}`);
