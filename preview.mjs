#!/usr/bin/env node
// Renders ui/hud.html with live data into build/preview-{dark,light,compact}.html
// for design iteration in a browser, and for headless screenshots.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
import { sampleData } from "./sample-data.mjs";
const json = process.argv.includes("--sample") ? JSON.stringify(sampleData()) : execFileSync(process.execPath, [path.join(ROOT, "collect.mjs")], {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
}).trim();

const html = fs.readFileSync(path.join(ROOT, "ui", "hud.html"), "utf8");
const LIGHT_QUERY = "@media (prefers-color-scheme: light)";

const desktop = (a, b) => `
<style>
  html { background: linear-gradient(145deg, ${a}, ${b}); }
  body { padding: 22px; }
  #root { width: 380px; }
  body.customizing #root { width: min(820px, calc(100vw - 44px)); }
</style>`;

function variant({ file, scheme, compact, bg, after, config }) {
  let out = html;
  // The palette is dark on :root and switches under a light media query, so
  // pinning a scheme just means neutralising or forcing that one query.
  if (scheme === "dark") out = out.replace(LIGHT_QUERY, "@media (min-width: 99999px)");
  if (scheme === "light") out = out.replace(LIGHT_QUERY, "@media (min-width: 1px)");
  out += desktop(...bg);
  const sample = JSON.parse(json);
  sample.config = { ...sample.config, ...config, theme: { ...sample.config.theme, ...config?.theme, scheme } };
  const payload = JSON.stringify(sample);
  out += `\n<script>\nwindow.hudUpdate(${payload});\n${compact ? 'window.hudUpdate(Object.assign({}, ' + payload + '));' : ""}\n${after || ""}\n</script>\n`;
  fs.writeFileSync(path.join(ROOT, "build", file), out);
  return file;
}

fs.mkdirSync(path.join(ROOT, "build"), { recursive: true });
const DARK = ["#2b2f36", "#14161a"];
const base = JSON.parse(json).config;

// A layout that exercises the ring gauges and side-by-side rows, to prove the
// renderer is not just reproducing the shipped default.
const ringLayout = {
  cards: [
    {
      id: "claude", accent: "#e08a63", enabled: true,
      rows: [
        { type: "header", title: "Claude", items: [{ type: "headline", metric: "claude.cost.today", sub: "today" }] },
        { type: "row", items: [
          { type: "meter", gauge: "claude.session", style: "ring" },
          { type: "meter", gauge: "claude.weekly", style: "ring" },
          { type: "meter", gauge: "claude.weeklyFable", style: "ring" },
          { type: "spark", series: "claude.activity.cost.14d", width: 90 },
        ] },
        { type: "stat", metrics: ["claude.cost.quotaWeek", "claude.cap.weekly", "claude.weeklyReset"] },
      ],
    },
    {
      id: "codex", accent: "#3ecfa0", enabled: true,
      rows: [
        { type: "header", title: "Codex", items: [{ type: "headline", metric: "codex.tokens.quotaWeek", sub: "tok wk" }] },
        { type: "row", items: [
          { type: "meter", gauge: "codex.primary", style: "ring" },
          { type: "meter", gauge: "codex.secondary", style: "ring" },
          { type: "chips", source: "codex.models.today", limit: 2 },
        ] },
      ],
    },
  ],
};

const made = [
  variant({ file: "preview-dark.html", scheme: "dark", bg: DARK }),
  variant({ file: "preview-light.html", scheme: "light", bg: ["#e9eaee", "#cfd3da"] }),
  variant({ file: "preview-collapsed.html", scheme: "dark", bg: DARK,
    config: { theme: { ...base.theme, collapsed: true } } }),
  variant({ file: "preview-edit.html", scheme: "dark", bg: DARK,
    after: "window.hudSetEditing(true);" }),
  variant({ file: "preview-periods.html", scheme: "dark", bg: DARK,
    after: "state.selected = state.config.cards[1].rows[0].items[0]; state.selected.metric = 'codex.cost.month'; window.hudSetEditing(true);" }),
  variant({ file: "preview-drawer.html", scheme: "dark", bg: DARK,
    after: "window.hudOpenDrawer();" }),
  variant({ file: "preview-rings.html", scheme: "dark", bg: DARK, config: ringLayout }),
  variant({ file: "preview-history.html", scheme: "dark", bg: DARK,
    after: "window.hudOpenHistory({ provider: 'claude', key: 'cost', per: 'week', view: 'bars' });" }),
  variant({ file: "preview-overlay.html", scheme: "dark", bg: DARK,
    after: "window.hudOpenHistory({ provider: 'claude', key: 'cost', per: 'week', view: 'overlay' });" }),
  variant({ file: "preview-overlay-light.html", scheme: "light", bg: ["#e9eaee", "#cfd3da"],
    after: "window.hudOpenHistory({ provider: 'claude', key: 'cost', per: 'month', view: 'overlay' });" }),
];
console.log(made.map((f) => path.join(ROOT, "build", f)).join("\n"));
