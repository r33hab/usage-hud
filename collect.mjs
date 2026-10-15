#!/usr/bin/env node
// usage-hud collector: reads local Claude Code + Codex logs and emits one JSON blob.
// No dependencies. Incremental: only the bytes appended since the last run are parsed.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, ".claude", "projects");
const CODEX_DIR = path.join(HOME, ".codex", "sessions");
const CACHE_FILE = path.join(HOME, ".cache", "usage-hud", "cache.json");
const CONFIG_FILE = path.join(HOME, ".config", "usage-hud", "config.json");
// Per-day token totals behind the week-by-week and month-by-month figures. The cache is a
// 45-day ledger that can be thrown away; this file is kept for good.
const HISTORY_FILE = path.join(HOME, ".local", "share", "usage-hud", "usage-history.json");
// Claude Code's own state file. It caches the last /usage reading here.
const CLAUDE_STATE_FILE = path.join(HOME, ".claude.json");
const CLAUDE_SETTINGS_FILE = path.join(HOME, ".claude", "settings.json");
// Where Claude Code keeps its login: a JSON blob in the macOS keychain, or in
// this file on other platforms. Read for the access token only.
const KEYCHAIN_SERVICE = "Claude Code-credentials";
const CREDENTIALS_FILE = path.join(HOME, ".claude", ".credentials.json");
// The endpoint /usage calls. The tool's only other network request is the
// once-a-day price feed (`pricingFeed` in the config).
const OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

const CACHE_VERSION = 5;
const RETAIN_DAYS = 45;      // records older than this are dropped from the cache; long enough for any calendar month
const CALIBRATION_DAYS = 30; // history used to auto-calibrate the "peak" budget
const PRICE_FEED_HOURS = 24; // how long a fetched price feed is trusted before it is fetched again
const HISTORY_VERSION = 1;
const HISTORY_MONTHS = 12;   // calendar months sent to the panel, this one included
const HISTORY_WEEKS = 12;    // calendar weeks (Monday to Sunday) sent to the panel, this one included

const args = new Set(process.argv.slice(2));
const PRETTY = args.has("--pretty");
const NO_CACHE = args.has("--no-cache");
const DUMP_CONFIG = args.has("--default-config");
// --calibrate                      (from the cached /usage reading)
// --calibrate weekly=26 fable=37 session=12   (percentages read off /usage by hand)
const CALIBRATE_REQUESTED = args.has("--calibrate");
const CALIBRATE = process.argv.slice(2)
  .filter((a) => /^(weekly|fable|session)=/.test(a))
  .map((a) => a.split("="))
  .map(([k, v]) => [k, Number(v)]);

// ---------------------------------------------------------------- pricing ---
// USD per million tokens [input, output, cache-read multiplier], first-party
// Anthropic API rates. Verified 2026-09-23: https://platform.claude.com/docs/en/about-claude/pricing
// Cache reads are 0.1x input unless a third value says otherwise, 5-minute
// cache writes 1.25x, 1-hour writes 2x.
const PRICING = {
  "claude-fable-5-1": [10, 50, 0.025],
  "claude-fable-5": [10, 50],
  "claude-mythos-5-1": [10, 50, 0.025],
  "claude-mythos-5": [10, 50],
  "claude-opus-5-5": [4, 20, 0.05],
  "claude-opus-5": [5, 25],
  "claude-opus-4-8": [5, 25],
  "claude-opus-4-7": [5, 25],
  "claude-opus-4-6": [5, 25],
  "claude-opus-4-5": [5, 25],
  "claude-sonnet-5": [2, 10],
  "claude-sonnet-4-6": [3, 15],
  "claude-sonnet-4-5": [3, 15],
  "claude-haiku-4-5": [1, 5],
};
// Fast mode runs Opus at premium rates; cache multipliers apply on top.
const FAST_PRICING = { "claude-opus-5-5": [8, 40, 0.05], "claude-opus-5": [10, 50], "claude-opus-4-8": [10, 50] };

// Standard API-equivalent USD / million [input, cached input, output].
// Verified 2026-09-23: https://developers.openai.com/api/docs/pricing and the
// individual model pages under https://developers.openai.com/api/docs/models/.
// These estimates exclude fast-mode, long-context and regional surcharges.
const CODEX_PRICING = {
  "gpt-6-astra": [10, 1, 50],
  "gpt-6-sol": [2, .2, 10],
  "gpt-6-luna": [.1, .01, .5],
  "gpt-5.6-sol": [4, .4, 20],
  "gpt-5.6-terra": [2, .2, 12],
  "gpt-5.6-luna": [.2, .02, 1.2],
  "gpt-5.5": [5, .5, 30],
  "gpt-5.4": [2.5, .25, 15],
  "gpt-5.4-mini": [.75, .075, 4.5],
  "gpt-5.3-codex": [1.75, .175, 14],
};

export function codexCost(row, cfg) {
  const valid = v => typeof v === "number" && Number.isFinite(v) && v >= 0;
  const custom = valid(cfg.inputPerMTok) && valid(cfg.outputPerMTok);
  const model = String(row[6] || "").replace(/-\d{4}-\d{2}-\d{2}$/, "");
  const rates = custom
    ? [cfg.inputPerMTok, valid(cfg.cachedInputPerMTok) ? cfg.cachedInputPerMTok : cfg.inputPerMTok, cfg.outputPerMTok]
    : CODEX_PRICING[model] || FEED.codex[model];
  if (!rates) return null; // Internal/unknown model IDs have no published price.
  const cached = Math.max(0, Math.min(row[1], row[2]));
  // Cached input is a subset of input; reasoning is a subset of output.
  return ((row[1] - cached) * rates[0] + cached * rates[1] + row[3] * rates[2]) / 1e6;
}

const SHORT_NAME = (m) =>
  m.replace(/^claude-/, "").replace(/-(\d)-(\d)$/, "-$1.$2").replace(/-(\d)$/, " $1");

function normalizeModel(m) {
  return String(m)
    .replace(/\[[^\]]*\]$/, "")   // drop a context-variant suffix like [1m]
    .replace(/-\d{8}$/, "");      // drop a dated snapshot suffix
}

// Exact id first, then the longest table key the id extends: a point release
// such as claude-fable-5-1 inherits claude-fable-5's rate instead of dropping
// to the fallback tier, which is what happened when Fable 5.1 shipped.
function lookupRate(table, model) {
  if (table[model]) return table[model];
  let best = null;
  for (const key of Object.keys(table)) {
    if (model.startsWith(key + "-") && (!best || key.length > best.length)) best = key;
  }
  return best ? table[best] : null;
}

// Prices from the community feed, in the bundled tables' shapes. main() fills
// it before aggregating; empty, the bundled tables alone decide.
let FEED = { claude: {}, codex: {} };
export function usePriceFeed(feed) {
  FEED = { claude: (feed && feed.claude) || {}, codex: (feed && feed.codex) || {} };
}

// A model's standard rate and where it came from. The bundled table wins by
// exact id because it is verified by hand; the feed covers models newer than
// the table; only then does a point release inherit its family's rate
// ("inherited", which is how Opus 5.5 was once priced as Opus 5), and last a
// guess by family name, at the Opus tier when even that is unrecognised,
// rather than silently pricing at zero.
function claudeRate(model) {
  if (PRICING[model]) return { rate: PRICING[model], source: "table" };
  if (FEED.claude[model]) return { rate: FEED.claude[model], source: "feed" };
  for (const table of [PRICING, FEED.claude]) {
    const r = lookupRate(table, model);
    if (r) return { rate: r, source: "inherited", as: Object.keys(table).find((k) => table[k] === r) };
  }
  if (/fable|mythos/.test(model)) return { rate: [10, 50], source: "guess" };
  if (/sonnet/.test(model)) return { rate: [3, 15], source: "guess" };
  if (/haiku/.test(model)) return { rate: [1, 5], source: "guess" };
  return { rate: [5, 25], source: "guess" };
}

function rates(model, fast) {
  if (fast) { const r = lookupRate(FAST_PRICING, model); if (r) return r; }
  return claudeRate(model).rate;
}

// Bundled prices the feed disagrees with: the sign that a published rate
// changed and the table needs a hand update. The feed never overrides them.
function priceMismatches(table, feed, width) {
  const out = [];
  for (const [model, rate] of Object.entries(table)) {
    const theirs = feed[model];
    if (!theirs) continue;
    const ours = width === 3 && rate.length === 2 ? [...rate, 0.1] : rate;
    if (ours.some((v, i) => Math.abs(v - theirs[i]) > 1e-6)) out.push({ model, table: ours, feed: theirs });
  }
  return out;
}

/// Pulls per-million rates out of LiteLLM's model_prices_and_context_window.json:
/// first-party Anthropic ids as [input, output, cache-read multiplier] and
/// OpenAI chat/responses ids as [input, cached input, output].
export function parsePriceFeed(json) {
  const claude = {}, codex = {};
  const perM = (v) => Math.round(v * 1e10) / 1e4; // per token -> per million, float noise trimmed
  for (const [key, e] of Object.entries(json || {})) {
    if (!e || !(e.input_cost_per_token > 0) || !(e.output_cost_per_token > 0)) continue;
    const read = typeof e.cache_read_input_token_cost === "number" && e.cache_read_input_token_cost >= 0 ? e.cache_read_input_token_cost : null;
    if (e.litellm_provider === "anthropic" && /^claude-[a-z0-9-]+$/.test(key)) {
      const id = normalizeModel(key);
      if (id !== key && claude[id]) continue; // the undated id outranks its snapshots
      claude[id] = [perM(e.input_cost_per_token), perM(e.output_cost_per_token),
        read == null ? 0.1 : Math.round(read / e.input_cost_per_token * 1e4) / 1e4];
    } else if (e.litellm_provider === "openai" && (e.mode === "chat" || e.mode === "responses") && /^(gpt|codex)-[a-z0-9.-]+$/.test(key)) {
      const id = key.replace(/-\d{4}-\d{2}-\d{2}$/, "");
      if (id !== key && codex[id]) continue;
      codex[id] = [perM(e.input_cost_per_token), read == null ? perM(e.input_cost_per_token) : perM(read), perM(e.output_cost_per_token)];
    }
  }
  return { claude, codex };
}

function costOf(rec) {
  const [inRate, outRate, readMult = 0.1] = rates(rec.model, rec.fast);
  return (
    rec.in * inRate +
    rec.out * outRate +
    rec.cacheRead * inRate * readMult +
    rec.cw5 * inRate * 1.25 +
    rec.cw1h * inRate * 2.0
  ) / 1e6;
}

// ----------------------------------------------------------------- config ---
// The layout below is the shipped default. Everything in it is editable, either
// by hand in ~/.config/usage-hud/config.json or from the panel's own editor,
// which writes back to that same file.
export const DEFAULT_CONFIG = {
  refreshSeconds: 60,
  // Community price list, fetched once a day, that prices models newer than the
  // bundled tables and flags when those tables fall behind. null turns it off.
  pricingFeed: "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
  theme: {
    scheme: "auto",          // auto | dark | light
    density: "normal",       // compact | normal | roomy
    width: 380,              // panel width in points
    opacity: 1,              // whole-panel alpha
    radius: 14,              // corner radius
    vibrancy: "hudWindow",   // NSVisualEffectView material
    collapsed: false,        // minimised
    collapsedMode: "bars",   // what minimising keeps: bars | headers | both
  },
  // System-wide shortcuts. "cmd", "alt"/"opt", "ctrl", "shift" plus one key,
  // joined with "+". null disables one.
  hotkeys: {
    toggle: "cmd+alt+u",
    // Ghost mode makes the panel unclickable, so it must always have a keyboard
    // way back out - otherwise the menu bar is the only escape.
    ghost: "cmd+alt+g",
  },
  claude: {
    // Ask the API for the real quota percentages, authenticated with the login
    // Claude Code already holds on this machine. One GET at most every
    // liveUsageSeconds; the token is never stored or logged. false turns it
    // off, and the panel then relies on what /usage last cached.
    liveUsage: true,
    liveUsageSeconds: 120,
    limits: {
      // Claude's weekly limit is a fixed window with a published reset time
      // (see /usage), not a rolling seven days. Local weekday, 0 = Sunday.
      resetWeekday: 0,
      resetHour: 20,
      sessionHours: 5,
      // Spend, in the dollar terms this tool computes, that corresponds to
      // 100% of each limit. null falls back to the heaviest window on record
      // and the gauge says "peak" instead of "cap".
      // Get real numbers with:  node collect.mjs --calibrate weekly=26 fable=37
      sessionUsd: null,
      weeklyUsd: null,
      weeklyFableUsd: null,
    },
  },
  codex: { inputPerMTok: null, cachedInputPerMTok: null, outputPerMTok: null },
  cards: [
    {
      id: "claude",
      accent: "#e08a63",
      enabled: true,
      rows: [
        { type: "header", title: "Claude", items: [{ type: "headline", metric: "claude.cost.today", sub: null }] },
        { type: "banner", source: "claude.limit" },
        { type: "meter", gauge: "claude.session", style: "bar" },
        { type: "meter", gauge: "claude.weekly", style: "bar" },
        { type: "meter", gauge: "claude.weeklyFable", style: "bar" },
        {
          type: "row",
          items: [
            { type: "chips", source: "claude.models.today", limit: 3 },
            { type: "spark", series: "claude.activity.cost.14d" },
          ],
        },
        {
          type: "stat",
          metrics: ["claude.reqs.today", "claude.out.today", "claude.cacheHit.today", "claude.cost.month", "claude.weeklyReset"],
        },
      ],
    },
    {
      id: "codex",
      accent: "#3ecfa0",
      enabled: true,
      rows: [
        { type: "header", title: "Codex", items: [{ type: "headline", metric: "codex.tokens.today", sub: null }] },
        { type: "banner", source: "codex.limit" },
        { type: "meter", gauge: "codex.primary", style: "bar" },
        { type: "meter", gauge: "codex.secondary", style: "bar" },
        {
          type: "row",
          items: [
            { type: "chips", source: "codex.models.today", limit: 2 },
            { type: "spark", series: "codex.activity.tokens.14d" },
          ],
        },
        {
          type: "stat",
          metrics: ["codex.turns.today", "codex.tokens.quotaWeek", "codex.plan", "codex.quotaAge"],
        },
      ],
    },
  ],
};

function loadConfig() {
  const base = structuredClone(DEFAULT_CONFIG);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return base;
  }
  // Objects merge key by key so a partial config keeps the defaults it omits.
  // Arrays are replaced wholesale - a user-supplied layout is authoritative,
  // never spliced together with the default one.
  return {
    ...base,
    ...raw,
    theme: { ...base.theme, ...(raw.theme || {}) },
    hotkeys: { ...base.hotkeys, ...(raw.hotkeys || {}) },
    claude: { ...base.claude, ...(raw.claude || {}), limits: { ...base.claude.limits, ...((raw.claude || {}).limits || {}) } },
    codex: { ...base.codex, ...(raw.codex || {}) },
    cards: Array.isArray(raw.cards) && raw.cards.length ? raw.cards : base.cards,
  };
}

// ------------------------------------------------------------ file walking ---
async function walk(dir, out = []) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

// Streams [start, end) and hands complete lines to onLine, but only lines whose
// raw bytes contain one of the needles - JSON.parse is the expensive part and
// most lines in these logs are irrelevant. Returns the offset after the last
// complete line, so the next run can resume from there.
async function scanFrom(file, start, end, needles, onLine) {
  if (end <= start) return start;
  const fh = await fsp.open(file, "r");
  try {
    const CHUNK = 1 << 22;
    const buf = Buffer.allocUnsafe(CHUNK);
    let pos = start;
    let tail = Buffer.alloc(0);
    while (pos < end) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, end - pos), pos);
      if (!bytesRead) break;
      pos += bytesRead;
      const chunk = tail.length ? Buffer.concat([tail, buf.subarray(0, bytesRead)]) : Buffer.from(buf.subarray(0, bytesRead));
      let from = 0;
      let idx;
      while ((idx = chunk.indexOf(10, from)) !== -1) {
        const seg = chunk.subarray(from, idx);
        from = idx + 1;
        if (seg.length < 32) continue;
        for (const n of needles) {
          if (seg.includes(n)) {
            try { onLine(seg.toString("utf8")); } catch { /* skip malformed line */ }
            break;
          }
        }
      }
      tail = from < chunk.length ? chunk.subarray(from) : Buffer.alloc(0);
    }
    return pos - tail.length;
  } finally {
    await fh.close();
  }
}

// ------------------------------------------------------------------ claude ---
const CLAUDE_NEEDLES = ['"usage"', '"quotaLimits"'];

function parseClaudeFile(entry) {
  // entry.r rows: [tsSec, model, in, out, cacheRead, cw5, cw1h, fast, requestId]
  return (line) => {
    const o = JSON.parse(line);

    if (o.quotaLimits && o.quotaLimits.resetsAt) {
      const ts = Math.floor(Date.parse(o.timestamp || 0) / 1000) || 0;
      entry.q.push([ts, o.quotaLimits.resetsAt, o.quotaLimits.rateLimitType || "unknown"]);
      return;
    }
    if (o.type !== "assistant") return;
    const u = o.message?.usage;
    const rawModel = o.message?.model;
    if (!u || !rawModel || rawModel === "<synthetic>") return;

    const ts = Math.floor(Date.parse(o.timestamp) / 1000);
    if (!ts) return;
    const cc = u.cache_creation || {};
    const cw5 = cc.ephemeral_5m_input_tokens ?? 0;
    const cw1h = cc.ephemeral_1h_input_tokens ?? 0;
    const declared = u.cache_creation_input_tokens ?? 0;
    entry.r.push([
      ts,
      normalizeModel(rawModel),
      u.input_tokens ?? 0,
      u.output_tokens ?? 0,
      u.cache_read_input_tokens ?? 0,
      cw5 || (cw1h ? 0 : declared),   // if the TTL split is missing, treat writes as 5m
      cw1h,
      u.speed === "fast" || u.service_tier === "fast" ? 1 : 0,
      o.message?.id || o.requestId || "",
    ]);
  };
}

// ------------------------------------------------------------------- codex ---
const CODEX_NEEDLES = ['"token_count"', '"turn_context"'];

function parseCodexFile(entry) {
  // entry.r rows: [tsSec, in, cached, out, reasoning, total, model]
  // entry.cm: the model the session is currently running, from the latest
  // turn_context. token_count events carry no model of their own, so each
  // delta is attributed to the model that was in effect when it arrived.
  return (line) => {
    const o = JSON.parse(line);
    const ts = Math.floor(Date.parse(o.timestamp || 0) / 1000);

    if (o.type === "turn_context") {
      const m = o.payload?.model || o.model;
      if (m) entry.cm = m;
      return;
    }
    if (o.type !== "event_msg" || o.payload?.type !== "token_count") return;

    const rl = o.payload.rate_limits;
    if (rl && (rl.primary || rl.secondary) && ts >= (entry.rl?.[0] || 0)) {
      entry.rl = [ts, rl];
    }

    const cum = o.payload.info?.total_token_usage;
    if (!cum || !ts) return;
    const prev = entry.st || { t: 0, i: 0, c: 0, o: 0, x: 0 };
    // total_token_usage is cumulative per session; a drop means the counter restarted.
    const restart = (cum.total_tokens ?? 0) < prev.t;
    const d = (cur, was) => Math.max(0, (cur ?? 0) - (restart ? 0 : was));
    const row = [
      ts,
      d(cum.input_tokens, prev.i),
      d(cum.cached_input_tokens, prev.c),
      d(cum.output_tokens, prev.o),
      d(cum.reasoning_output_tokens, prev.x),
      d(cum.total_tokens, prev.t),
      entry.cm || null,
    ];
    if (row[5] > 0) entry.r.push(row);
    entry.st = {
      t: cum.total_tokens ?? 0,
      i: cum.input_tokens ?? 0,
      c: cum.cached_input_tokens ?? 0,
      o: cum.output_tokens ?? 0,
      x: cum.reasoning_output_tokens ?? 0,
    };
    if (o.payload.info?.model_context_window) entry.cw = o.payload.info.model_context_window;
  };
}

// ------------------------------------------------------------------- cache ---
function loadCache() {
  const blank = () => ({ v: CACHE_VERSION, claude: {}, codex: {}, derived: {}, usage: null });
  if (NO_CACHE) return blank();
  try {
    const c = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    if (c.v === CACHE_VERSION) return { ...blank(), ...c };
  } catch { /* cold start */ }
  return blank();
}

function saveCache(cache) {
  if (NO_CACHE) return;
  const cutoff = Math.floor(Date.now() / 1000) - RETAIN_DAYS * 86400;
  for (const bucket of ["claude", "codex"]) {
    for (const [key, e] of Object.entries(cache[bucket])) {
      if (e.r) e.r = e.r.filter((row) => row[0] >= cutoff);
      if (e.q) e.q = e.q.filter((row) => row[0] >= cutoff);
      if (e.gone && !(e.r && e.r.length) && !(e.q && e.q.length)) delete cache[bucket][key];
    }
  }
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  const tmp = CACHE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(cache));
  fs.renameSync(tmp, CACHE_FILE);
}

export async function sync(bucket, files, needles, makeParser, blank) {
  let scanned = 0;
  let bytes = 0;
  const live = new Set(files);
  // A log the CLI has since deleted keeps its records. Claude Code prunes
  // transcripts after cleanupPeriodDays, so this cache is the ledger the
  // weekly and monthly figures are built from and has to outlive the files it
  // was read from. saveCache drops the entry once its records have aged out.
  for (const [key, entry] of Object.entries(bucket)) if (!live.has(key)) entry.gone = true;

  for (const file of files) {
    let st;
    try { st = await fsp.stat(file); } catch { continue; }
    let entry = bucket[file];
    if (!entry || st.size < (entry.o ?? 0)) entry = { ...structuredClone(blank), o: 0 };
    delete entry.gone;
    if (entry.o === st.size && entry.m === st.mtimeMs) { bucket[file] = entry; continue; }

    const next = await scanFrom(file, entry.o ?? 0, st.size, needles, makeParser(entry));
    bytes += st.size - (entry.o ?? 0);
    entry.o = next;
    entry.m = st.mtimeMs;
    bucket[file] = entry;
    scanned++;
  }
  return { scanned, bytes };
}

// ------------------------------------------------------------ quota readings ---
// The server's own percentages come from the /api/oauth/usage response, which
// reaches us one of two ways: fetched here, or cached by Claude Code in
// ~/.claude.json when you run /usage. Both carry the same shape; the newest
// reading wins and is remembered in the cache.

function parseUtilization(u, asOfSec, source) {
  if (!u || typeof u !== "object") return null;
  const toSec = (iso) => (iso ? Math.floor(Date.parse(iso) / 1000) || null : null);
  const win = (pct, resetsAt) => (pct == null ? null : { pct: Number(pct), resetsAt: toSec(resetsAt) });
  const limits = Array.isArray(u.limits) ? u.limits : [];
  const byKind = (kind) => limits.find((l) => l && l.kind === kind);
  const scoped = limits.find((l) => l && l.kind === "weekly_scoped" && isFable(String(l.scope?.model?.display_name || "").toLowerCase()));

  const session = byKind("session") || (u.five_hour && { percent: u.five_hour.utilization, resets_at: u.five_hour.resets_at });
  const weekly = byKind("weekly_all") || (u.seven_day && { percent: u.seven_day.utilization, resets_at: u.seven_day.resets_at });
  if (!session && !weekly) return null;

  return {
    asOf: asOfSec,
    source,
    session: session ? win(session.percent, session.resets_at) : null,
    weekly: weekly ? win(weekly.percent, weekly.resets_at) : null,
    weeklyFable: scoped ? win(scoped.percent, scoped.resets_at) : null,
  };
}

const newestReading = (...rs) => rs.filter(Boolean).sort((a, b) => b.asOf - a.asOf)[0] || null;

function readClaudeCodeReading() {
  try {
    const raw = JSON.parse(fs.readFileSync(CLAUDE_STATE_FILE, "utf8")).cachedUsageUtilization;
    if (!raw || !raw.fetchedAtMs) return null;
    return parseUtilization(raw.utilization, Math.floor(raw.fetchedAtMs / 1000), "claude-code");
  } catch {
    // Claude Code rewrites this file often; a half-written read just means no
    // reading from this source this time round.
    return null;
  }
}

// Claude Code's access token, and nothing else out of its login. The keychain
// read prompts once on macOS ("security wants to use your confidential
// information") - Always Allow is the answer, after which it is silent.
//
// More than one keychain item can share this service: Claude Code stores each
// MCP server login beside the account login, and an unqualified lookup returns
// whichever one macOS happens to find first. That is routinely an item holding
// only `mcpOAuth` and no `claudeAiOauth`, which used to read as "no OAuth
// token" and silently cost us every live reading. So the candidates are tried
// in order - the login file, the item filed under this user, then the
// unqualified item - and the first one actually carrying a token wins.
function readOAuthToken() {
  const keychain = (args) => {
    let out = execFileSync("/usr/bin/security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, ...args, "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 20000 }).trim();
    // security prints a secret that is not plain text as hex
    if (/^[0-9a-f]+$/i.test(out) && out.length % 2 === 0) out = Buffer.from(out, "hex").toString("utf8");
    return out;
  };

  const sources = [() => fs.readFileSync(CREDENTIALS_FILE, "utf8")];
  if (process.platform === "darwin") {
    let account = null;
    try { account = os.userInfo().username; } catch { /* no account name to scope by */ }
    if (account) sources.push(() => keychain(["-a", account]));
    sources.push(() => keychain([]));
  }

  let found = 0;   // a blob we could read and parse, token or not
  let denied = 0;  // a source that refused, so a retry would prompt again
  let expired = false;
  for (const read of sources) {
    let blob;
    try { blob = read(); } catch { denied++; continue; }
    let o;
    try { o = JSON.parse(blob).claudeAiOauth; } catch { continue; }
    found++;
    if (!o || !o.accessToken) continue;
    // Keep looking rather than fail outright: another item may hold a live one.
    if (o.expiresAt && o.expiresAt < Date.now() + 30_000) { expired = true; continue; }
    return { token: o.accessToken };
  }

  if (expired) return { error: "Claude Code login token expired - open Claude Code to refresh it" };
  if (found) return { error: "Claude Code login has no OAuth token" };
  if (denied) {
    // Every retry would raise the prompt again, so this one backs off.
    return { error: "keychain access denied or no Claude Code login - allow it in the prompt, or set claude.liveUsage false", backoff: true };
  }
  return { error: "no Claude Code login found on this machine" };
}

/// One request to the usage endpoint, at most every liveUsageSeconds counting
/// from the newest reading we already have or the last attempt, whichever is
/// later - so a failure (offline, expired login, a keychain prompt left
/// unanswered) is not retried on every refresh. Outcome goes in cache.usageFetch.
async function fetchUsage(cache, cfg, nowMs, known) {
  if (!cfg.claude.liveUsage) return null;
  const minMs = Math.max(30, Number(cfg.claude.liveUsageSeconds) || 120) * 1000;
  const lastKnown = known ? known.asOf * 1000 : 0;
  const lastAttempt = cache.usageFetch ? cache.usageFetch.at || 0 : 0;
  const waitMs = Math.max(minMs, cache.usageFetch ? cache.usageFetch.backoffMs || 0 : 0);
  if (nowMs - Math.max(lastKnown, lastAttempt) < waitMs) return null;

  const status = { at: nowMs, ok: false, error: null };
  cache.usageFetch = status;
  const cred = readOAuthToken();
  if (cred.error) {
    status.error = cred.error;
    if (cred.backoff) status.backoffMs = 15 * 60 * 1000;
    return null;
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5000);
  try {
    const res = await fetch(OAUTH_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${cred.token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "Content-Type": "application/json",
      },
      signal: ctl.signal,
    });
    if (!res.ok) {
      status.error = res.status === 401 ? "login rejected (401) - open Claude Code to refresh it" : `usage endpoint returned HTTP ${res.status}`;
      return null;
    }
    const reading = parseUtilization(await res.json(), Math.floor(nowMs / 1000), "live");
    if (!reading) { status.error = "usage endpoint returned an unexpected shape"; return null; }
    status.ok = true;
    return reading;
  } catch (err) {
    status.error = err && err.name === "AbortError" ? "usage endpoint timed out" : "offline: " + String(err && err.message || err).slice(0, 80);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Fetches the price feed at most once per PRICE_FEED_HOURS, retrying a failure
// after an hour. A failed fetch keeps the last good prices.
export async function refreshPriceFeed(cache, cfg, nowMs) {
  const url = cfg.pricingFeed;
  if (!url) return null;
  const prev = cache.priceFeed && cache.priceFeed.url === url ? cache.priceFeed : null;
  if (prev && prev.fetchedAt && nowMs - prev.fetchedAt < PRICE_FEED_HOURS * 3600 * 1000) return prev;
  if (prev && nowMs - prev.at < 3600 * 1000) return prev;

  const feed = { claude: {}, codex: {}, ...(prev || {}), url, at: nowMs, error: null };
  cache.priceFeed = feed;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10000);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) { feed.error = `price feed returned HTTP ${res.status}`; return feed; }
    const prices = parsePriceFeed(await res.json());
    if (!Object.keys(prices.claude).length && !Object.keys(prices.codex).length) { feed.error = "price feed had no usable prices"; return feed; }
    Object.assign(feed, prices, { fetchedAt: nowMs });
  } catch (err) {
    feed.error = err && err.name === "AbortError" ? "price feed timed out" : "offline: " + String(err && err.message || err).slice(0, 80);
  } finally {
    clearTimeout(timer);
  }
  return feed;
}

// -------------------------------------------------------------- aggregation ---
function emptyClaudeBin() {
  return { cost: 0, fableCost: 0, tokens: 0, in: 0, out: 0, cacheRead: 0, cacheWrite: 0, reqs: 0, models: {} };
}

// `count` is how many requests `rec` stands for: one from the ledger, a whole
// day's worth from the history.
function addClaude(bin, rec, cost, count = 1) {
  bin.cost += cost;
  if (isFable(rec.model)) bin.fableCost += cost;
  bin.tokens += rec.in + rec.out + rec.cacheRead + rec.cw5 + rec.cw1h;
  bin.in += rec.in;
  bin.out += rec.out;
  bin.cacheRead += rec.cacheRead;
  bin.cacheWrite += rec.cw5 + rec.cw1h;
  bin.reqs += count;
  bin.models[rec.model] = (bin.models[rec.model] || 0) + cost;
}

const claudeShares = (bin) => ({ ...bin, models: topModels(bin.models) });

/// Every Claude request once, oldest first. A request can sit in more than one
/// log (a resumed session copies its history); the fullest copy wins.
export function claudeRecords(bucket) {
  const byId = new Map();
  const anon = [];
  const weight = (row) => row[2] + row[3] + row[4] + row[5] + row[6];

  for (const entry of Object.values(bucket)) {
    for (const row of entry.r || []) {
      const id = row[8];
      if (!id) { anon.push(row); continue; }
      const prev = byId.get(id);
      if (!prev || weight(row) > weight(prev)) byId.set(id, row);
    }
  }

  return [...byId.values(), ...anon]
    .map((row) => ({
      ts: row[0], model: row[1], in: row[2], out: row[3],
      cacheRead: row[4], cw5: row[5], cw1h: row[6], fast: row[7] === 1,
    }))
    .sort((a, b) => a.ts - b.ts);
}

function codexBin() {
  return { tokens: 0, in: 0, cached: 0, out: 0, reasoning: 0, turns: 0, cost: 0, pricedTokens: 0, unpricedTokens: 0, unpricedModels: {}, models: {} };
}

/// Adds a ledger row ([tsSec, in, cached, out, reasoning, total, model]) that
/// stands for `count` turns.
function addCodex(b, row, cfg, count = 1) {
  b.tokens += row[5]; b.in += row[1]; b.cached += row[2];
  b.out += row[3]; b.reasoning += row[4]; b.turns += count;
  const cost = codexCost(row, cfg.codex);
  if (cost == null) {
    b.unpricedTokens += row[5];
    const model = row[6] || "unknown model";
    b.unpricedModels[model] = (b.unpricedModels[model] || 0) + row[5];
  } else {
    b.cost += cost;
    b.pricedTokens += row[5];
  }
  // Model share is weighted by tokens, the Codex analogue of the cost
  // weighting behind the Claude chips. Shares are per window, so a model
  // adopted today shows up today instead of being buried under weeks of
  // history (GPT-6-Astra sat at 0.5% of all-time turns on its first day).
  if (row[6]) b.models[row[6]] = (b.models[row[6]] || 0) + row[5];
}

// SHORT_NAME is Claude's naming scheme; Codex ids are left whole here and
// trimmed by the panel.
const codexShares = (b) => ({ ...b, models: topModels(b.models).map((m) => ({ ...m, name: m.id })) });

/// Epoch seconds of the most recent weekly reset at or before `now`.
function lastWeeklyReset(nowMs, weekday, hour) {
  const d = new Date(nowMs);
  d.setHours(hour, 0, 0, 0);
  const back = (d.getDay() - weekday + 7) % 7;
  d.setDate(d.getDate() - back);
  if (d.getTime() > nowMs) d.setDate(d.getDate() - 7);
  return Math.floor(d.getTime() / 1000);
}

/// The weekly reset that ends the window containing `nowSec`, given any reset
/// instant on the same seven-day schedule - past or future.
function nextWeeklyReset(knownReset, nowSec) {
  const week = 7 * 86400;
  if (knownReset > nowSec) return knownReset - Math.floor((knownReset - nowSec) / week) * week;
  return knownReset + Math.ceil((nowSec - knownReset + 1) / week) * week;
}

/// The 5-hour session limit is not a rolling window. A block starts with the
/// first request after the previous block expired and runs for sessionSec.
/// Given a known block end - from /usage or from a 429 - walk forward through
/// the requests to the block that contains `nowSec`. null means no block is
/// open: nothing has been sent since the last one expired.
function currentSessionBlock(recs, knownEnd, sessionSec, nowSec) {
  let end = knownEnd;
  if (end > nowSec) return { start: end - sessionSec, end };
  let i = 0;
  for (;;) {
    while (i < recs.length && recs[i].ts < end) i++;
    if (i === recs.length) return null;
    const start = recs[i].ts;
    end = start + sessionSec;
    if (end > nowSec) return { start, end };
  }
}

const isFable = (model) => /fable|mythos/.test(model);

function rollingPeak(sorted, windowSec, valueOf) {
  let i = 0, sum = 0, peak = 0;
  for (let j = 0; j < sorted.length; j++) {
    sum += valueOf(sorted[j]);
    while (sorted[i].ts < sorted[j].ts - windowSec) { sum -= valueOf(sorted[i]); i++; }
    if (sum > peak) peak = sum;
  }
  return peak;
}

function topModels(models, limit = 4) {
  const total = Object.values(models).reduce((a, b) => a + b, 0);
  return Object.entries(models)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id, v]) => ({ id, name: SHORT_NAME(id), value: v, share: total ? v / total : 0 }));
}

// Calendar periods are shared by both providers. Advancing dates in local time
// keeps midnight and Monday boundaries correct through daylight-saving changes.
// The two rolling spans are for the charts only: a Tuesday's weekly chart has
// two bars, a 7-day one always has seven.
const CALENDAR_PERIODS = new Set(["daily", "weekly", "monthly"]);
export function calendarUsage(records, now, empty, add, finish, timestamp) {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  const week = new Date(day);
  week.setDate(week.getDate() - (week.getDay() + 6) % 7);
  const month = new Date(day);
  month.setDate(1);
  const daysBack = (n) => { const d = new Date(day); d.setDate(d.getDate() - n); return d; };
  const starts = { daily: day, weekly: week, monthly: month, "7d": daysBack(6), "14d": daysBack(13) };
  const periods = {}, activity = {};
  for (const [period, start] of Object.entries(starts)) {
    const slots = [];
    for (let cursor = new Date(start); +cursor <= now;) {
      const next = new Date(cursor);
      if (period === "daily") next.setTime(+next + 3600000);
      else next.setDate(next.getDate() + 1);
      slots.push({ start: +cursor / 1000, end: +next / 1000, bin: empty() });
      cursor = next;
    }
    const total = CALENDAR_PERIODS.has(period) ? empty() : null;
    for (const rec of records) {
      const ts = timestamp(rec);
      if (ts < +start / 1000 || ts > now / 1000) continue;
      if (total) add(total, rec);
      const slot = slots.find(s => ts >= s.start && ts < s.end);
      if (slot) add(slot.bin, rec);
    }
    if (total) periods[period] = finish(total);
    activity[period] = slots.map(s => ({ start: s.start, ...finish(s.bin) }));
  }
  return { periods, activity };
}

export function aggregateClaude(bucket, cfg, now, usage, derived = {}) {
  const nowSec = Math.floor(now / 1000);
  const lim = cfg.claude.limits;
  const recs = claudeRecords(bucket);

  const todayStart = Math.floor(new Date(new Date(now).setHours(0, 0, 0, 0)) / 1000);
  const monthStart = Math.floor(new Date(new Date(now).getFullYear(), new Date(now).getMonth(), 1) / 1000);
  const sessionSec = Math.max(1, lim.sessionHours) * 3600;

  // The weekly window: anchored to the reset time the API reported if we have
  // one, otherwise to the configured weekday and hour.
  const weekEnd = usage?.weekly?.resetsAt
    ? nextWeeklyReset(usage.weekly.resetsAt, nowSec)
    : lastWeeklyReset(now, lim.resetWeekday, lim.resetHour) + 7 * 86400;
  const weekStart = weekEnd - 7 * 86400;

  // The session window: a 5-hour block chained forward from the latest block
  // end we know about. With no anchor at all, fall back to a rolling window.
  let limitHit = null;
  for (const entry of Object.values(bucket)) {
    for (const [ts, resetsAt, type] of entry.q || []) {
      if (!limitHit || ts > limitHit.ts) limitHit = { ts, resetsAt, type };
    }
  }
  if (limitHit && limitHit.resetsAt < nowSec) limitHit.expired = true;
  const anchors = [];
  if (usage?.session?.resetsAt) anchors.push(usage.session.resetsAt);
  if (limitHit && limitHit.type === "five_hour") anchors.push(limitHit.resetsAt);
  const block = anchors.length ? currentSessionBlock(recs, Math.max(...anchors), sessionSec, nowSec) : undefined;
  const sessionFrom = block === undefined ? nowSec - sessionSec : block ? block.start : Infinity;
  const sessionEnd = block ? block.end : null;

  // Spend split around the /usage reading, per window: what the reading already
  // counted, and what has been added since. Only meaningful for a window the
  // reading is still inside of.
  const asOf = usage ? usage.asOf : null;
  const atFetch = { session: 0, weekly: 0, weeklyFable: 0 };
  const since = { session: 0, weekly: 0, weeklyFable: 0 };
  const split = (key, ts, cost) => { if (asOf != null) (ts > asOf ? since : atFetch)[key] += cost; };

  const bins = {
    today: emptyClaudeBin(),
    month: emptyClaudeBin(),
    session: emptyClaudeBin(),
    weekly: emptyClaudeBin(),
    weeklyFable: emptyClaudeBin(),
    window7d: emptyClaudeBin(),
  };

  for (const rec of recs) {
    const cost = costOf(rec);
    if (rec.ts >= todayStart) addClaude(bins.today, rec, cost);
    if (rec.ts >= monthStart) addClaude(bins.month, rec, cost);
    if (rec.ts >= sessionFrom) { addClaude(bins.session, rec, cost); split("session", rec.ts, cost); }
    if (rec.ts >= weekStart) {
      addClaude(bins.weekly, rec, cost);
      split("weekly", rec.ts, cost);
      if (isFable(rec.model)) { addClaude(bins.weeklyFable, rec, cost); split("weeklyFable", rec.ts, cost); }
    }
    if (rec.ts >= nowSec - 7 * 86400) addClaude(bins.window7d, rec, cost);
  }

  // Fallback references, used only where no real cap is configured: the
  // heaviest comparable window this machine has produced in 30 days.
  const calibFrom = nowSec - CALIBRATION_DAYS * 86400;
  const calib = recs.filter((r) => r.ts >= calibFrom);
  const all = calib.map((r) => ({ ts: r.ts, c: costOf(r) }));
  const fab = calib.filter((r) => isFable(r.model)).map((r) => ({ ts: r.ts, c: costOf(r) }));
  const peaks = {
    session: rollingPeak(all, sessionSec, (r) => r.c),
    weekly: rollingPeak(all, 7 * 86400, (r) => r.c),
    weeklyFable: rollingPeak(fab, 7 * 86400, (r) => r.c),
  };
  const caps = {
    session: lim.sessionUsd || null,
    weekly: lim.weeklyUsd || null,
    weeklyFable: lim.weeklyFableUsd || null,
  };

  // A reading applies to a window while that window's reset is still ahead.
  // Each applicable reading also tells us what 100% is worth in our dollars -
  // spend the reading had seen divided by the percentage it reported - which
  // is kept as an automatic calibration for the stretches between readings.
  const windowEnd = { session: sessionEnd, weekly: weekEnd, weeklyFable: weekEnd };
  const readings = {};
  for (const key of ["session", "weekly", "weeklyFable"]) {
    const r = usage && usage[key];
    const applies = !!(r && r.resetsAt && r.resetsAt > nowSec);
    readings[key] = r ? { ...r, applies, spendAtFetch: atFetch[key], spendSince: since[key] } : null;
    if (applies && r.pct >= 5 && atFetch[key] > 0.5) {
      const cap = atFetch[key] / (r.pct / 100);
      if (!derived[key] || derived[key].asOf < usage.asOf) derived[key] = { cap: Math.round(cap), asOf: usage.asOf };
    }
  }

  // The gauge value the panel and menu bar show, resolved once here. Sources,
  // most to least trustworthy: the API's own percentage plus whatever has been
  // spent since it was read ("usage"); a cap from the config ("cap"); a cap
  // derived from the last reading ("auto"); the heaviest window on record
  // ("peak"), which is a different claim altogether.
  const gauges = {};
  for (const key of ["session", "weekly", "weeklyFable"]) {
    const spend = bins[key].cost;
    const r = readings[key];
    const auto = derived[key] ? derived[key].cap : null;
    const base = { spend, resetsAt: windowEnd[key] };
    if (r && r.applies) {
      const cap = caps[key] || auto;
      gauges[key] = { ...base, pct: r.pct / 100 + (cap ? r.spendSince / cap : 0), source: "usage", cap, asOf: usage.asOf };
    } else if (caps[key]) {
      gauges[key] = { ...base, pct: spend / caps[key], source: "cap", cap: caps[key] };
    } else if (auto) {
      gauges[key] = { ...base, pct: spend / auto, source: "auto", cap: auto };
    } else if (peaks[key]) {
      gauges[key] = { ...base, pct: spend / peaks[key], source: "peak", cap: peaks[key] };
    } else {
      gauges[key] = { ...base, pct: null, source: null, cap: null };
    }
  }

  const withModels = claudeShares;

  return {
    ...calendarUsage(recs, now, emptyClaudeBin, (bin, rec) => addClaude(bin, rec, costOf(rec)), withModels, rec => rec.ts),
    today: withModels(bins.today),
    month: withModels(bins.month),
    session: withModels(bins.session),
    weekly: withModels(bins.weekly),
    weeklyFable: withModels(bins.weeklyFable),
    window7d: withModels(bins.window7d),
    limits: {
      sessionHours: lim.sessionHours,
      sessionModel: block === undefined ? "rolling" : "block",
      sessionStart: block ? block.start : null,
      sessionEnd,
      weekStart,
      weekEnd,
      resetsIn: weekEnd - nowSec,
      caps,
      peaks,
      derived: Object.fromEntries(Object.entries(derived).map(([k, v]) => [k, v.cap])),
    },
    usage: usage ? { asOf: usage.asOf, ageSec: nowSec - usage.asOf, source: usage.source || null, ...readings } : null,
    gauges,
    limitHit,
    lastActivity: recs.length ? recs[recs.length - 1].ts : null,
    pricing: claudePricing(recs),
  };
}

// Which of the models in use are priced from somewhere other than the verified
// table, for the panel to say so.
function claudePricing(recs) {
  const feedModels = [], estimated = [];
  for (const model of new Set(recs.map((r) => r.model))) {
    const r = claudeRate(model);
    if (r.source === "feed") feedModels.push(model);
    else if (r.source !== "table") estimated.push({ model, as: r.as || null });
  }
  return { feedModels, estimated, mismatches: priceMismatches(PRICING, FEED.claude, 3) };
}

export function aggregateCodex(bucket, cfg, now) {
  const nowSec = Math.floor(now / 1000);
  const recs = [];
  let latest = null;
  let contextWindow = null;

  for (const entry of Object.values(bucket)) {
    for (const row of entry.r || []) recs.push(row);
    if (entry.rl && (!latest || entry.rl[0] > latest[0])) latest = entry.rl;
    if (entry.cw) contextWindow = entry.cw;
  }
  recs.sort((a, b) => a[0] - b[0]);

  const todayStart = Math.floor(new Date(new Date(now).setHours(0, 0, 0, 0)) / 1000);
  const bin = codexBin;

  const bins = { today: bin(), window: bin(), week: bin(), window7d: bin() };
  const windowSec = (latest?.[1]?.primary?.window_minutes || 300) * 60;
  const secondarySec = (latest?.[1]?.secondary?.window_minutes || 10080) * 60;

  const add = (b, row) => addCodex(b, row, cfg);

  for (const row of recs) {
    if (row[0] >= todayStart) add(bins.today, row);
    if (row[0] >= nowSec - windowSec) add(bins.window, row);
    if (row[0] >= nowSec - secondarySec) add(bins.week, row);
    if (row[0] >= nowSec - 7 * 86400) add(bins.window7d, row);
  }

  let limits = null;
  if (latest) {
    const [asOf, rl] = latest;
    // The percentage is a snapshot taken at asOf. It stays accurate while the
    // window is still open, but once resets_at has passed the window has rolled
    // over and the number means nothing - flag it rather than show a stale 99%.
    const win = (w) => (w
      ? {
          usedPercent: w.used_percent,
          windowMinutes: w.window_minutes,
          resetsAt: w.resets_at,
          expired: typeof w.resets_at === "number" && w.resets_at <= nowSec,
        }
      : null);
    limits = {
      asOf,
      ageSec: nowSec - asOf,
      planType: rl.plan_type || null,
      primary: win(rl.primary),
      secondary: win(rl.secondary),
      credits: rl.credits || null,
      reached: rl.rate_limit_reached_type || null,
    };
  }

  const shares = codexShares;
  const calendar = calendarUsage(recs, now, bin, add, shares, row => row[0]);
  return {
    ...calendar,
    today: shares(bins.today),
    month: calendar.periods.monthly,
    window: shares(bins.window),
    week: shares(bins.week),
    window7d: shares(bins.window7d),
    priced: true,
    pricing: {
      basis: "Standard API estimate", updated: "2026-09-23", source: "https://developers.openai.com/api/docs/pricing",
      feedModels: [...new Set(recs.map((row) => String(row[6] || "").replace(/-\d{4}-\d{2}-\d{2}$/, "")))].filter((m) => m && !CODEX_PRICING[m] && FEED.codex[m]),
      mismatches: priceMismatches(CODEX_PRICING, FEED.codex, 3),
    },
    limits,
    contextWindow,
    lastActivity: recs.length ? recs[recs.length - 1][0] : null,
  };
}

// ----------------------------------------------------------------- history ---
// The ledger keeps 45 days, so by the end of a month the one before it is
// already falling out, and anything older is gone. The history keeps each
// local day's token totals per model for good. Every refresh writes the days
// the ledger holds, and a day is only replaced by a reading with at least as
// many requests, so records ageing out of the ledger, a pruned transcript or a
// thrown-away cache can never shrink it. Tokens are kept rather than dollars,
// so a month is priced with the current tables like every other figure.

const localDay = (tsSec) => {
  const d = new Date(tsSec * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/// Claude requests by local day, one row per model and speed:
/// [model, fast, in, out, cacheRead, cw5, cw1h, reqs].
export function claudeDays(recs) {
  const days = {};
  for (const r of recs) {
    const day = (days[localDay(r.ts)] ||= {});
    const row = (day[r.model + (r.fast ? "|fast" : "")] ||= [r.model, r.fast ? 1 : 0, 0, 0, 0, 0, 0, 0]);
    row[2] += r.in; row[3] += r.out; row[4] += r.cacheRead; row[5] += r.cw5; row[6] += r.cw1h; row[7]++;
  }
  return Object.fromEntries(Object.entries(days).map(([day, rows]) => [day, Object.values(rows)]));
}

/// Codex ledger rows by local day, one row per model:
/// [model, in, cached, out, reasoning, total, turns].
export function codexDays(rows) {
  const days = {};
  for (const r of rows) {
    const day = (days[localDay(r[0])] ||= {});
    const model = r[6] || "";
    const row = (day[model] ||= [model, 0, 0, 0, 0, 0, 0]);
    // codexCost clamps cached to input per row; clamping here keeps the day's
    // price equal to the sum of its rows' prices.
    row[1] += r[1]; row[2] += Math.max(0, Math.min(r[1], r[2])); row[3] += r[3]; row[4] += r[4]; row[5] += r[5]; row[6]++;
  }
  return Object.fromEntries(Object.entries(days).map(([day, rows]) => [day, Object.values(rows)]));
}

// History days, as usage-history.json keeps them. Claude rows are
// [model, fast, in, out, cacheRead, cw5, cw1h, reqs]; Codex rows are
// [model, in, cached, out, reasoning, total, turns].
const DAY_ROWS = {
  claude: { count: r => r[7], tokens: r => r[2] + r[3] + r[4] + r[5] + r[6] },
  codex: { count: r => r[6], tokens: r => r[5] },
};

/// Whether day reading `a` holds more than `b`: more requests, or as many with
/// more tokens. The one rule every copy of a day is merged by, so it only grows.
export function heavierDay(a, b, provider = "claude") {
  const { count, tokens } = DAY_ROWS[provider];
  const sum = (rows, f) => rows.reduce((n, r) => n + f(r), 0);
  const ca = sum(a, count), cb = sum(b, count);
  return ca > cb || (ca === cb && sum(a, tokens) > sum(b, tokens));
}

/// Writes a set of days from the ledger into the history. A stored day is
/// only replaced by a reading at least as full, so a day only ever grows.
export function mergeHistory(history, provider, days) {
  for (const [day, rows] of Object.entries(days)) {
    const entry = (history.days[day] ||= {});
    if (!entry[provider] || !heavierDay(entry[provider], rows, provider)) entry[provider] = rows;
  }
}

export function recordHistory(history, claudeRecs, codexRows) {
  mergeHistory(history, "claude", claudeDays(claudeRecs));
  mergeHistory(history, "codex", codexDays(codexRows));
}

/// From when each provider's history is complete, decided once when the
/// history is created. Claude Code deletes transcripts after cleanupPeriodDays,
/// so older Claude logs on disk are only the sessions that happened to survive:
/// Claude counts from that many days back, or from the oldest record a warm
/// ledger kept beyond it. Codex keeps its sessions, so every Codex log counts.
export function historySince(claudeLedger, codexRows, nowMs, { cold, keepDays }) {
  const nowSec = Math.floor(nowMs / 1000);
  const kept = nowSec - keepDays * 86400;
  return {
    claude: !cold && claudeLedger.length ? Math.min(claudeLedger[0].ts, kept) : kept,
    codex: codexRows.reduce((min, r) => Math.min(min, r[0]), nowSec),
  };
}

/// Claude Code's transcript retention in days: cleanupPeriodDays in
/// ~/.claude/settings.json, 30 when unset.
function claudeKeepDays() {
  try {
    const days = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_FILE, "utf8")).cleanupPeriodDays;
    if (Number.isFinite(days) && days > 0) return days;
  } catch { /* unset */ }
  return 30;
}

/// The last `count` calendar months, weeks (Monday to Sunday) or days, oldest
/// first and the current one last, each a bin of the same shape as the panel's
/// period totals. `partial` marks a period that began before its provider's
/// history is complete, so its total is a lower bound; `tracked` is false for
/// one with neither data nor coverage.
export function historyPeriods(history, cfg, nowMs, unit, count) {
  const first = new Date(nowMs);
  first.setHours(0, 0, 0, 0);
  if (unit === "month") first.setDate(1);
  else if (unit === "week") first.setDate(first.getDate() - (first.getDay() + 6) % 7);
  // Stepping in local dates keeps the boundaries at midnight through
  // daylight-saving changes.
  const step = (date, n) => {
    const d = new Date(date);
    if (unit === "month") d.setMonth(d.getMonth() + n);
    else d.setDate(d.getDate() + (unit === "week" ? 7 : 1) * n);
    return d;
  };
  const periods = [];
  for (let i = count - 1; i >= 0; i--) {
    const start = step(first, -i);
    periods.push({ start: +start / 1000, end: +step(start, 1) / 1000, claude: emptyClaudeBin(), codex: codexBin() });
  }
  for (const [day, entry] of Object.entries(history.days)) {
    const [y, m, d] = day.split("-").map(Number);
    const at = +new Date(y, m - 1, d) / 1000;
    const p = periods.find((p) => at >= p.start && at < p.end);
    if (!p) continue;
    for (const [model, fast, i, o, cacheRead, cw5, cw1h, reqs] of entry.claude || []) {
      const rec = { model, fast: fast === 1, in: i, out: o, cacheRead, cw5, cw1h };
      addClaude(p.claude, rec, costOf(rec), reqs);
    }
    for (const [model, i, cached, o, reasoning, total, turns] of entry.codex || []) {
      addCodex(p.codex, [0, i, cached, o, reasoning, total, model || null], cfg, turns);
    }
  }
  const about = (p, provider, used) => {
    const since = history.since?.[provider] ?? Infinity;
    return { start: p.start, tracked: used > 0 || since < p.end, partial: since > p.start };
  };
  return {
    claude: periods.map((p) => ({ ...about(p, "claude", p.claude.reqs), ...claudeShares(p.claude) })),
    codex: periods.map((p) => ({ ...about(p, "codex", p.codex.turns), ...codexShares(p.codex) })),
  };
}

export const monthlyHistory = (history, cfg, nowMs, count = HISTORY_MONTHS) => historyPeriods(history, cfg, nowMs, "month", count);
export const weeklyHistory = (history, cfg, nowMs, count = HISTORY_WEEKS) => historyPeriods(history, cfg, nowMs, "week", count);

/// The days behind the panel's history overlay, oldest first and today last:
/// back to the first of the twelve weeks or to the first of the month before
/// last, whichever is earlier, so this week can be laid over the eleven before
/// it and this month over the two before it. Days carry no model breakdown;
/// the weeks and months do.
export function dailyHistory(history, cfg, nowMs) {
  const today = new Date(nowMs);
  today.setHours(0, 0, 0, 0);
  const weeks = new Date(today);
  weeks.setDate(weeks.getDate() - (weeks.getDay() + 6) % 7 - 7 * (HISTORY_WEEKS - 1));
  const months = new Date(today.getFullYear(), today.getMonth() - 2, 1);
  const first = weeks < months ? weeks : months;
  // Rounded, because a day across a daylight-saving change is 23 or 25 hours.
  const count = Math.round((today - first) / 86400000) + 1;
  const lean = ({ models, unpricedModels, ...bin }) => bin;
  const days = historyPeriods(history, cfg, nowMs, "day", count);
  return { claude: days.claude.map(lean), codex: days.codex.map(lean) };
}

function loadHistory() {
  const blank = { v: HISTORY_VERSION, since: null, days: {} };
  let text;
  try { text = fs.readFileSync(HISTORY_FILE, "utf8"); }
  catch (error) { return { data: blank, text: null, writable: error.code === "ENOENT" }; }
  try {
    const h = JSON.parse(text);
    if (h && h.v === HISTORY_VERSION && h.days && typeof h.days === "object") return { data: { ...blank, ...h }, text, writable: true };
    // Written by a newer collector: read nothing from it and leave it alone.
    if (h && h.v > HISTORY_VERSION) return { data: blank, text, writable: false };
  } catch { /* unreadable */ }
  // Set an unreadable file aside rather than write over months of history.
  fs.renameSync(HISTORY_FILE, `${HISTORY_FILE}.unreadable-${Date.now()}`);
  return { data: blank, text: null, writable: true };
}

function saveHistory({ data, text, writable }) {
  if (NO_CACHE || !writable) return;
  const days = Object.fromEntries(Object.entries(data.days).sort(([a], [b]) => (a < b ? -1 : 1)));
  const next = JSON.stringify({ ...data, days });
  if (next === text) return;
  fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
  const tmp = HISTORY_FILE + ".tmp";
  fs.writeFileSync(tmp, next);
  fs.renameSync(tmp, HISTORY_FILE);
}

// -------------------------------------------------------------------- main ---
async function main() {
  const t0 = Date.now();
  if (DUMP_CONFIG) {
    process.stdout.write(JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
    return;
  }
  const cfg = loadConfig();
  const cache = loadCache();
  const cold = Object.keys(cache.claude).length === 0 && Object.keys(cache.codex).length === 0;

  const [claudeFiles, codexFiles] = await Promise.all([walk(CLAUDE_DIR), walk(CODEX_DIR)]);

  const a = await sync(cache.claude, claudeFiles, CLAUDE_NEEDLES, parseClaudeFile, { r: [], q: [] });
  const b = await sync(cache.codex, codexFiles, CODEX_NEEDLES, parseCodexFile, { r: [] });

  const now = Date.now();
  const known = newestReading(cache.usage, readClaudeCodeReading());
  const usage = newestReading(known, await fetchUsage(cache, cfg, now, known));
  cache.usage = usage;
  const priceFeed = await refreshPriceFeed(cache, cfg, now);
  usePriceFeed(priceFeed);
  let history = null, historyError = null;
  try { history = loadHistory(); } catch (error) { historyError = String(error.message || error); }
  // The history is the same Claude ledger the panel totals. A history that
  // cannot be read or written costs the month-by-month figures, never the
  // rest of the panel.
  if (history) try {
    const claudeLedger = claudeRecords(cache.claude);
    const codexLedger = Object.values(cache.codex).flatMap((e) => e.r || []);
    let codexOnDisk = [];
    if (history.text == null && history.writable) {
      // A new history starts from every log still on disk, not only the 45
      // days the cache keeps. A cold cache has just read them all already.
      const disk = { claude: {}, codex: {} };
      if (!cold) {
        await sync(disk.claude, claudeFiles, CLAUDE_NEEDLES, parseClaudeFile, { r: [], q: [] });
        await sync(disk.codex, codexFiles, CODEX_NEEDLES, parseCodexFile, { r: [] });
      }
      codexOnDisk = Object.values(disk.codex).flatMap((e) => e.r || []);
      recordHistory(history.data, claudeRecords(disk.claude), codexOnDisk);
    }
    history.data.since ??= historySince(claudeLedger, [...codexOnDisk, ...codexLedger], now, { cold, keepDays: claudeKeepDays() });
    recordHistory(history.data, claudeLedger, codexLedger);
  } catch (error) {
    historyError = String(error.message || error);
  }
  const out = {
    ts: now,
    refreshSeconds: cfg.refreshSeconds,
    config: cfg,
    claude: aggregateClaude(cache.claude, cfg, now, usage, cache.derived),
    codex: aggregateCodex(cache.codex, cfg, now),
    meta: {
      cold,
      filesScanned: a.scanned + b.scanned,
      filesTotal: claudeFiles.length + codexFiles.length,
      bytesRead: a.bytes + b.bytes,
      elapsedMs: Date.now() - t0,
    },
  };
  out.claude.usageFetch = { enabled: !!cfg.claude.liveUsage, ...(cache.usageFetch || {}) };
  out.pricingFeed = priceFeed
    ? { enabled: true, fetchedAt: priceFeed.fetchedAt || null, error: priceFeed.error, models: Object.keys(priceFeed.claude).length + Object.keys(priceFeed.codex).length }
    : { enabled: false };
  if (history) {
    try {
      const months = monthlyHistory(history.data, cfg, now);
      out.claude.months = months.claude;
      out.codex.months = months.codex;
      const weeks = weeklyHistory(history.data, cfg, now);
      out.claude.weeks = weeks.claude;
      out.codex.weeks = weeks.codex;
      const days = dailyHistory(history.data, cfg, now);
      out.claude.days = days.claude;
      out.codex.days = days.codex;
    } catch (error) {
      historyError = String(error.message || error);
    }
  }

  saveCache(cache);
  if (history) {
    try { saveHistory(history); } catch (error) { historyError = String(error.message || error); }
  }
  out.history = { since: history ? history.data.since : null, error: historyError };

  if (CALIBRATE_REQUESTED || CALIBRATE.length) {
    calibrate(out, cfg);
    return;
  }

  process.stdout.write(PRETTY ? JSON.stringify(out, null, 2) : JSON.stringify(out));
  process.stdout.write("\n");
}

/// Turns a percentage from `/usage` into a dollar cap: if the spend this tool
/// has measured in the live window is X and Claude says that window is P% used,
/// then 100% of the limit is X / (P/100) in the same units.
///
/// With no key=value arguments the percentages come from the reading Claude
/// Code cached the last time /usage ran, paired with the spend measured up to
/// that moment. Hand-typed percentages are paired with the spend right now.
function calibrate(out, cfg) {
  const field = { weekly: "weeklyUsd", fable: "weeklyFableUsd", session: "sessionUsd" };
  const limits = { ...cfg.claude.limits };
  const lines = [];

  let pairs; // [key, pct, measured]
  if (CALIBRATE.length) {
    const spend = {
      weekly: out.claude.weekly.cost,
      fable: out.claude.weeklyFable.cost,
      session: out.claude.session.cost,
    };
    pairs = CALIBRATE.map(([key, pct]) => [key, pct, spend[key]]);
  } else {
    const u = out.claude.usage;
    if (!u) {
      const why = out.claude.usageFetch && out.claude.usageFetch.error ? ` (${out.claude.usageFetch.error})` : "";
      process.stderr.write(`no quota reading available${why} - run /usage inside Claude Code,\n` +
        "or pass the percentages by hand: --calibrate weekly=26 fable=37 session=12\n");
      process.exit(1);
    }
    lines.push(`using the ${u.source === "live" ? "live" : "/usage"} reading from ${new Date(u.asOf * 1000).toLocaleString()}`);
    pairs = [];
    for (const [key, r] of [["weekly", u.weekly], ["fable", u.weeklyFable], ["session", u.session]]) {
      if (!r) continue;
      if (!r.applies) { lines.push(`${key}: the reading's window has since reset - skipped`); continue; }
      pairs.push([key, r.pct, r.spendAtFetch]);
    }
  }

  for (const [key, pct, measured] of pairs) {
    if (!(pct > 0) || pct > 100) {
      lines.push(`${key}: ${pct} is not a percentage between 0 and 100 - skipped`);
      continue;
    }
    if (!(measured > 0)) {
      lines.push(`${key}: no spend measured in the current window - nothing to calibrate against`);
      continue;
    }
    const cap = measured / (pct / 100);
    limits[field[key]] = Math.round(cap);
    lines.push(`${key}: $${measured.toFixed(2)} measured = ${pct}% -> cap $${Math.round(cap)}`);
  }

  // Merge into the config file rather than overwrite it.
  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); } catch { /* first write */ }
  const merged = {
    ...existing,
    claude: { ...(existing.claude || {}), limits: { ...((existing.claude || {}).limits || {}), ...limits } },
  };
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2) + "\n");

  process.stderr.write(lines.join("\n") + "\n\nwrote " + CONFIG_FILE + "\n");
}

// Only run when invoked as a program: other modules import DEFAULT_CONFIG.
const isEntryPoint = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);

if (isEntryPoint) main().catch((err) => {
  process.stdout.write(JSON.stringify({ ts: Date.now(), error: String(err && err.stack || err) }) + "\n");
  process.exit(1);
});
