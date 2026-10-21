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
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "openai");
const manifest = JSON.parse(readFileSync(join(src, "plugin.json"), "utf8"));
const mcp = JSON.parse(readFileSync(join(src, "mcp.json"), "utf8"));
const openai = manifest.extensions?.["com.openai"] ?? {};
const ui = openai.interface ?? {};
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
// Skills: a public ZIP needs at least one (submission-errors:
// plugin_runtime_surface_missing). Each is skills/<dir>/SKILL.md with YAML
// front matter naming it, and every versely_* tool it mentions must be in the
// openai profile, or ChatGPT would be told to call a tool it cannot see.
const policy = readFileSync(join(root, "src", "tools", "_policy.ts"), "utf8");
const inOpenaiProfile = (tool) => {
  const at = policy.indexOf(`\n  ${tool}: {`);
  if (at < 0) return false;
  const next = policy.indexOf("\n  versely_", at + 1);
  return /openai: true/.test(policy.slice(at, next < 0 ? undefined : next));
};
const skillsDir = join(src, "skills");
const skills = existsSync(skillsDir) ? readdirSync(skillsDir).filter((d) => statSync(join(skillsDir, d)).isDirectory()) : [];
check(skills.length > 0, "skills: at least one skill in openai/skills/");
for (const dir of skills) {
  const file = join(skillsDir, dir, "SKILL.md");
  if (!existsSync(file)) { check(false, `skills/${dir}: SKILL.md missing`); continue; }
  const text = readFileSync(file, "utf8");
  const fm = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!fm) { check(false, `skills/${dir}: YAML front matter between --- lines`); continue; }
  const field = (k) => (new RegExp(`^${k}:\\s*(.+)$`, "m").exec(fm[1])?.[1] ?? "").trim();
  const name = field("name");
  check(/^[a-z0-9-]+$/.test(name), `skills/${dir}: name of lowercase letters, digits or dashes`);
  check(len(`${manifest.name}:${name}`) <= 64, `skills/${dir}: plugin:skill name at most 64 characters`);
  check(len(field("description")) > 0 && len(field("description")) <= 1024, `skills/${dir}: description 1-1024 characters`);
  check(fm[2].trim().length > 0, `skills/${dir}: instructions not empty`);
  for (const tool of new Set(text.match(/versely_[a-z_]+/g) ?? [])) check(inOpenaiProfile(tool), `skills/${dir}: ${tool} is not in the openai profile`);
}
if (openai.onboardingSkill) {
  check(/^\.\/skills\/[^/]+\/SKILL\.md$/.test(openai.onboardingSkill) && existsSync(join(src, openai.onboardingSkill)), "onboardingSkill: ./skills/<dir>/SKILL.md that exists");
}

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
execFileSync("zip", ["-q", "-r", "-X", zip, "plugin.json", "mcp.json", "assets", "skills"], { cwd: src, stdio: "inherit" });
console.log(`wrote ${zip}`);
