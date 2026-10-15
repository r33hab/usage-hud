import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { aggregateClaude, aggregateCodex, calendarUsage, claudeDays, claudeRecords, codexCost, codexDays, dailyHistory, historySince, mergeHistory, monthlyHistory, weeklyHistory, parsePriceFeed, recordHistory, refreshPriceFeed, sync, usePriceFeed, DEFAULT_CONFIG } from "./collect.mjs";

process.env.TZ = "Europe/Oslo";
const cfg = structuredClone(DEFAULT_CONFIG);
const now = +new Date("2026-09-18T12:00:00+02:00");
const ts = date => +new Date(date) / 1000;
const times = [
  "2026-08-31T23:59:59+02:00", "2026-09-01T00:00:00+02:00",
  "2026-09-13T23:59:59+02:00", "2026-09-14T00:00:00+02:00",
  "2026-09-17T23:59:59+02:00", "2026-09-18T00:00:00+02:00",
  "2026-09-18T12:00:00+02:00", "2026-09-18T12:00:01+02:00",
];
const claudeRows = times.map((date, i) => [ts(date), i % 2 ? "claude-fable-5-1" : "claude-opus-5", 100, 20, 30, 10, 0, 0, "request-" + i]);
const codexRows = times.map((date, i) => [ts(date), 100, 80, 20, 10, 120, i % 2 ? "gpt-5.6-sol" : "gpt-6-astra"]);

test("both providers use the same local daily, Monday-weekly and monthly boundaries", () => {
  const claude = aggregateClaude({a: {r: claudeRows}, copy: {r: [claudeRows[5]]}}, cfg, now, null);
  const codex = aggregateCodex({a: {r: codexRows}}, cfg, now);
  for (const [period, count] of [["daily", 2], ["weekly", 4], ["monthly", 6]]) {
    assert.equal(claude.periods[period].reqs, count);
    assert.equal(claude.periods[period].tokens, count * 160);
    assert.equal(codex.periods[period].turns, count);
    assert.equal(codex.periods[period].tokens, count * 120);
    assert.equal(claude.activity[period].reduce((n, b) => n + b.reqs, 0), count);
    assert.equal(codex.activity[period].reduce((n, b) => n + b.tokens, 0), count * 120);
    assert.equal(codex.periods[period].models.length, 2);
    assert.ok(Math.abs(codex.periods[period].models.reduce((n, m) => n + m.share, 0) - 1) < 1e-10);
    assert.ok(claude.periods[period].fableCost > 0);
  }
  assert.equal(codex.activity.daily.length, 13);
  assert.equal(codex.activity.weekly.length, 5);
  assert.equal(codex.activity.monthly.length, 18);
  assert.deepEqual(codex.month, codex.periods.monthly);
  // Rolling chart spans always have a full set of bars, and only the calendar
  // windows are period totals.
  for (const out of [claude, codex]) {
    assert.equal(out.activity["7d"].length, 7);
    assert.equal(out.activity["14d"].length, 14);
    assert.deepEqual(Object.keys(out.periods), ["daily", "weekly", "monthly"]);
  }
  assert.equal(codex.activity["7d"].reduce((n, b) => n + b.turns, 0), 5);
  assert.equal(codex.activity["14d"].reduce((n, b) => n + b.turns, 0), 5);
  // "Last 7 days" is the same rolling window for both providers.
  assert.equal(claude.window7d.reqs, 6);
  assert.equal(codex.window7d.turns, 6);
});

test("calendar periods and hourly charts survive DST, month and year boundaries", () => {
  for (const [date, hours] of [["2026-03-29T23:59:59+02:00", 23], ["2026-10-25T23:59:59+01:00", 25]]) {
    const end = +new Date(date);
    const start = +new Date(new Date(end).setHours(0, 0, 0, 0));
    const records = Array.from({length: hours}, (_, i) => start / 1000 + i * 3600);
    const result = calendarUsage(records, end, () => ({count: 0}), b => b.count++, b => b, x => x);
    assert.equal(result.activity.daily.length, hours);
    assert.equal(result.periods.daily.count, hours);
    assert.ok(result.activity.daily.every(b => b.count === 1));
  }
  const rows = ["2025-12-28T23:59:59+01:00", "2025-12-29T00:00:00+01:00", "2026-01-01T00:00:00+01:00"].map(date => [ts(date), 100, 0, 20, 0, 120, "gpt-5.5"]);
  const result = aggregateCodex({a: {r: rows}}, cfg, +new Date("2026-01-01T01:00:00+01:00"));
  assert.equal(result.periods.weekly.turns, 2);
  assert.equal(result.periods.monthly.turns, 1);
  assert.equal(result.periods.daily.turns, 1);
});

test("automatic Codex prices discount cached input and never double-count reasoning", () => {
  const row = [now / 1000, 1000000, 800000, 100000, 90000, 1100000, "gpt-6-astra"];
  assert.equal(codexCost(row, cfg.codex), 7.8);
  assert.equal(codexCost([...row.slice(0, 6), "gpt-5.6-sol"], cfg.codex), 3.12);
  assert.ok(Math.abs(codexCost([...row.slice(0, 6), "gpt-6-sol"], cfg.codex) - 1.56) < 1e-10);
  assert.equal(codexCost([...row.slice(0, 6), "gpt-5.4-2026-03-05"], cfg.codex), 2.2);
  assert.equal(codexCost([...row.slice(0, 6), "gpt-6-astra-unknown"], cfg.codex), null);
  assert.equal(codexCost([...row.slice(0, 6), "codex-auto-review"], cfg.codex), null);
  assert.equal(codexCost(row, {inputPerMTok: 2, cachedInputPerMTok: .5, outputPerMTok: 10}), 1.8);
  assert.equal(codexCost(row, {inputPerMTok: 0, cachedInputPerMTok: 0, outputPerMTok: 0}), 0);
});

test("Claude cache reads use each model's own multiplier, fast mode included", () => {
  const cost = (model, cells, fast = 0) => aggregateClaude({a: {r: [[ts("2026-09-18T10:00:00+02:00"), model, ...cells, fast, "r"]]}}, cfg, now, null).periods.daily.cost;
  const read = [0, 0, 1e6, 0, 0];
  for (const [model, want, fast] of [["claude-fable-5-1", .25], ["claude-fable-5", 1], ["claude-opus-5-5", .2], ["claude-opus-5-5", .4, 1], ["claude-opus-5", .5], ["claude-opus-5", 1, 1], ["claude-sonnet-5", .2]])
    assert.ok(Math.abs(cost(model, read, fast) - want) < 1e-10, model + (fast ? " fast" : ""));
  assert.ok(Math.abs(cost("claude-opus-5-5", [1e6, 1e6, 0, 1e6, 1e6]) - 37) < 1e-10);
});

const litellm = {
  "claude-opus-6": {litellm_provider: "anthropic", input_cost_per_token: 6e-6, output_cost_per_token: 30e-6, cache_read_input_token_cost: 0.3e-6},
  "claude-opus-6-20270101": {litellm_provider: "anthropic", input_cost_per_token: 9e-6, output_cost_per_token: 9e-6},
  "claude-opus-5": {litellm_provider: "anthropic", input_cost_per_token: 5e-6, output_cost_per_token: 25e-6, cache_read_input_token_cost: 0.5e-6},
  "claude-sonnet-5": {litellm_provider: "anthropic", input_cost_per_token: 3e-6, output_cost_per_token: 15e-6, cache_read_input_token_cost: 0.3e-6},
  "bedrock/anthropic.claude-opus-6": {litellm_provider: "bedrock", input_cost_per_token: 1e-6, output_cost_per_token: 1e-6},
  "gpt-7": {litellm_provider: "openai", mode: "chat", input_cost_per_token: 1e-6, output_cost_per_token: 8e-6, cache_read_input_token_cost: 0.1e-6},
  "gpt-7-2027-01-01": {litellm_provider: "openai", mode: "chat", input_cost_per_token: 9e-6, output_cost_per_token: 9e-6},
  "gpt-image-3": {litellm_provider: "openai", mode: "image_generation", input_cost_per_token: 1e-6, output_cost_per_token: 1e-6},
  "gpt-5.6-sol": {litellm_provider: "openai", mode: "chat", input_cost_per_token: 4e-6, output_cost_per_token: 20e-6, cache_read_input_token_cost: 0.4e-6},
};

test("the price feed prices models newer than the table but never overrides it", () => {
  const feed = parsePriceFeed(litellm);
  assert.deepEqual(feed.claude["claude-opus-6"], [6, 30, 0.05]);
  assert.equal(Object.keys(feed.claude).length, 3);
  assert.deepEqual(feed.codex, {"gpt-7": [1, 0.1, 8], "gpt-5.6-sol": [4, 0.4, 20]});
  const rows = ["claude-opus-6", "claude-opus-6-1", "claude-sonnet-5", "claude-nova-1"].map((model, i) => [ts("2026-09-18T10:00:00+02:00") + i, model, 1e6, 1e6, 1e6, 0, 0, 0, "feed-" + i]);
  const cost = row => aggregateClaude({a: {r: [row]}}, cfg, now, null).periods.daily.cost;
  const codexRow = [now / 1000, 1000000, 800000, 100000, 90000, 1100000, "gpt-7-2027-01-01"];
  usePriceFeed(feed);
  try {
    for (const [row, want] of rows.map((row, i) => [row, [36.3, 36.3, 12.2, 30.5][i]])) assert.ok(Math.abs(cost(row) - want) < 1e-9, row[1]);
    const pricing = aggregateClaude({a: {r: rows}}, cfg, now, null).pricing;
    assert.deepEqual(pricing.feedModels, ["claude-opus-6"]);
    assert.deepEqual(pricing.estimated, [{model: "claude-opus-6-1", as: "claude-opus-6"}, {model: "claude-nova-1", as: null}]);
    assert.deepEqual(pricing.mismatches, [{model: "claude-sonnet-5", table: [2, 10, 0.1], feed: [3, 15, 0.1]}]);
    assert.ok(Math.abs(codexCost(codexRow, cfg.codex) - 1.08) < 1e-9);
    const codex = aggregateCodex({a: {r: [codexRow]}}, cfg, now).pricing;
    assert.deepEqual(codex.feedModels, ["gpt-7"]);
    assert.deepEqual(codex.mismatches, []);
  } finally {
    usePriceFeed(null);
  }
  assert.ok(Math.abs(cost(rows[0]) - 30.5) < 1e-9, "without the feed a new model is a guess");
  assert.equal(codexCost(codexRow, cfg.codex), null);
});

test("the price feed is fetched once a day and a failure keeps the last good prices", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0, fail = false;
  globalThis.fetch = async () => { calls++; if (fail) throw new Error("network down"); return {ok: true, json: async () => litellm}; };
  try {
    const cache = {};
    const conf = {pricingFeed: "https://feed.test/prices.json"};
    const t0 = Date.now();
    const first = await refreshPriceFeed(cache, conf, t0);
    assert.equal(calls, 1);
    assert.equal(first.fetchedAt, t0);
    assert.deepEqual(first.claude["claude-opus-6"], [6, 30, 0.05]);
    await refreshPriceFeed(cache, conf, t0 + 23 * 3600e3);
    assert.equal(calls, 1, "refetched inside a day");
    fail = true;
    const failed = await refreshPriceFeed(cache, conf, t0 + 25 * 3600e3);
    assert.equal(calls, 2);
    assert.match(failed.error, /network down/);
    assert.equal(failed.fetchedAt, t0);
    assert.deepEqual(failed.claude["claude-opus-6"], [6, 30, 0.05], "failure dropped the last good prices");
    await refreshPriceFeed(cache, conf, t0 + 25.5 * 3600e3);
    assert.equal(calls, 2, "retried within the hour");
    fail = false;
    const retried = await refreshPriceFeed(cache, conf, t0 + 26.1 * 3600e3);
    assert.equal(calls, 3);
    assert.equal(retried.error, null);
    assert.equal(await refreshPriceFeed(cache, {pricingFeed: null}, t0), null);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("mixed models are priced per record and missing prices are explicit in each period", () => {
  const row = [now / 1000, 1000000, 800000, 100000, 90000, 1100000, "gpt-6-astra"];
  const result = aggregateCodex({a: {r: [row, [...row.slice(0, 6), "gpt-5.6-sol"], [...row.slice(0, 6), "codex-auto-review"]]}}, cfg, now);
  for (const b of Object.values(result.periods)) {
    assert.ok(Math.abs(b.cost - 10.92) < 1e-10);
    assert.equal(b.pricedTokens, 2200000);
    assert.equal(b.unpricedTokens, 1100000);
    assert.deepEqual(b.unpricedModels, {"codex-auto-review": 1100000});
  }
  const empty = aggregateCodex({}, cfg, now);
  for (const b of Object.values(empty.periods)) assert.equal(b.cost, 0);
});

test("records from a log the CLI has deleted stay in the cache", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-hud-sync-"));
  const file = path.join(dir, "session.jsonl");
  const line = JSON.stringify({ usage: 1, pad: "x".repeat(40) }) + "\n";
  const parser = entry => () => entry.r.push([Math.floor(Date.now() / 1000)]);
  try {
    fs.writeFileSync(file, line);
    const bucket = {};
    await sync(bucket, [file], ['"usage"'], parser, { r: [] });
    assert.equal(bucket[file].r.length, 1);
    fs.rmSync(file);
    await sync(bucket, [], ['"usage"'], parser, { r: [] });
    assert.equal(bucket[file].r.length, 1, "deleted log keeps its records");
    assert.equal(bucket[file].gone, true);
    fs.writeFileSync(file, line + line);
    await sync(bucket, [file], ['"usage"'], parser, { r: [] });
    assert.equal(bucket[file].gone, undefined, "a log that comes back is live again");
    assert.equal(bucket[file].r.length, 2, "a shorter file than the cached offset is re-read from the start");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const historyOf = (claude, codex) => {
  const history = { v: 1, since: { claude: 0, codex: 0 }, days: {} };
  recordHistory(history, claudeRecords({ a: { r: claude } }), codex);
  return history;
};

test("a day in the history only grows, so ageing out of the ledger never shrinks a month", () => {
  const history = historyOf(claudeRows, codexRows);
  assert.deepEqual(Object.keys(history.days).sort(), ["2026-08-31", "2026-09-01", "2026-09-13", "2026-09-14", "2026-09-17", "2026-09-18"]);
  const before = JSON.stringify(history);
  // The ledger after the oldest records aged out, or after the cache was lost.
  recordHistory(history, claudeRecords({ a: { r: claudeRows.slice(3) } }), codexRows.slice(3));
  assert.equal(JSON.stringify(history), before, "a smaller reading of a day is ignored");
  // A request arriving later for a day already stored.
  const late = [ts("2026-09-01T09:00:00+02:00"), "claude-opus-5", 1, 1, 0, 0, 0, 0, "late"];
  recordHistory(history, claudeRecords({ a: { r: [...claudeRows, late] } }), []);
  assert.equal(history.days["2026-09-01"].claude.reduce((n, row) => n + row[7], 0), 2);
  assert.equal(history.days["2026-09-01"].codex.length, 1, "Codex days are kept when only Claude is merged");
});

test("day rows keep models and fast mode apart and clamp cached input like the price does", () => {
  const recs = [
    { ts: ts("2026-09-18T10:00:00+02:00"), model: "claude-opus-5-5", fast: false, in: 10, out: 1, cacheRead: 0, cw5: 0, cw1h: 0 },
    { ts: ts("2026-09-18T11:00:00+02:00"), model: "claude-opus-5-5", fast: true, in: 10, out: 1, cacheRead: 0, cw5: 0, cw1h: 0 },
    { ts: ts("2026-09-18T12:00:00+02:00"), model: "claude-opus-5-5", fast: false, in: 5, out: 2, cacheRead: 3, cw5: 4, cw1h: 5 },
  ];
  assert.deepEqual(claudeDays(recs), { "2026-09-18": [["claude-opus-5-5", 0, 15, 3, 3, 4, 5, 2], ["claude-opus-5-5", 1, 10, 1, 0, 0, 0, 1]] });
  const codex = codexDays([[ts("2026-09-18T10:00:00+02:00"), 100, 150, 10, 1, 110, "gpt-6-sol"], [ts("2026-09-18T23:59:59+02:00"), 100, 50, 10, 1, 110, null]]);
  assert.deepEqual(codex, { "2026-09-18": [["gpt-6-sol", 100, 100, 10, 1, 110, 1], ["", 100, 50, 10, 1, 110, 1]] });
});

test("month totals match the ledger's own monthly figures and cover twelve calendar months", () => {
  const months = monthlyHistory(historyOf(claudeRows, codexRows), cfg, now);
  for (const provider of ["claude", "codex"]) {
    const list = months[provider];
    assert.equal(list.length, 12);
    assert.equal(list.at(-1).start, ts("2026-09-01T00:00:00+02:00"));
    assert.equal(list.at(-2).start, ts("2026-08-01T00:00:00+02:00"));
    assert.equal(list[0].start, ts("2025-10-01T00:00:00+02:00"));
  }
  // The ledger's figures leave out the row stamped a second after `now`.
  const later = now + 3600000;
  const claude = aggregateClaude({ a: { r: claudeRows } }, cfg, later, null);
  const codex = aggregateCodex({ a: { r: codexRows } }, cfg, later);
  for (const key of ["reqs", "tokens", "in", "out", "cacheRead", "cacheWrite"]) assert.equal(months.claude.at(-1)[key], claude.periods.monthly[key]);
  for (const key of ["cost", "fableCost"]) assert.ok(Math.abs(months.claude.at(-1)[key] - claude.periods.monthly[key]) < 1e-9);
  for (const key of ["turns", "tokens", "in", "cached", "out", "reasoning", "pricedTokens"]) assert.equal(months.codex.at(-1)[key], codex.periods.monthly[key]);
  assert.ok(Math.abs(months.codex.at(-1).cost - codex.periods.monthly.cost) < 1e-9);
  assert.deepEqual(months.claude.at(-1).models.map((m) => m.id).sort(), ["claude-fable-5-1", "claude-opus-5"]);
  assert.equal(months.claude.at(-2).reqs, 1, "31 August 23:59:59 is last month");
  assert.equal(months.codex.at(-2).turns, 1);

  const january = monthlyHistory(historyOf(claudeRows, codexRows), cfg, +new Date("2027-01-15T12:00:00+01:00"));
  assert.equal(january.claude.at(-1).start, ts("2027-01-01T00:00:00+01:00"));
  assert.equal(january.claude.at(-2).start, ts("2026-12-01T00:00:00+01:00"));
  assert.equal(january.claude.at(-5).reqs, 7, "September is still there in the new year");
});

test("week totals match the ledger's weekly figures and cover twelve Monday-to-Sunday weeks", () => {
  const weeks = weeklyHistory(historyOf(claudeRows, codexRows), cfg, now);
  for (const provider of ["claude", "codex"]) {
    const list = weeks[provider];
    assert.equal(list.length, 12);
    assert.equal(list.at(-1).start, ts("2026-09-14T00:00:00+02:00"));
    assert.equal(list.at(-2).start, ts("2026-09-07T00:00:00+02:00"));
    assert.equal(list[0].start, ts("2026-06-29T00:00:00+02:00"));
  }
  const later = now + 3600000;
  const claude = aggregateClaude({ a: { r: claudeRows } }, cfg, later, null);
  const codex = aggregateCodex({ a: { r: codexRows } }, cfg, later);
  for (const key of ["reqs", "tokens", "in", "out", "cacheRead", "cacheWrite"]) assert.equal(weeks.claude.at(-1)[key], claude.periods.weekly[key]);
  assert.ok(Math.abs(weeks.claude.at(-1).cost - claude.periods.weekly.cost) < 1e-9);
  for (const key of ["turns", "tokens", "cached"]) assert.equal(weeks.codex.at(-1)[key], codex.periods.weekly[key]);
  assert.equal(weeks.claude.at(-2).reqs, 1, "Sunday 13 September 23:59:59 is last week");
  assert.equal(weeks.claude.at(-3).reqs, 2, "a week spanning two months holds both of its days");
  assert.equal(weeks.codex.at(-3).turns, 2);

  // Weeks step in local dates, so the one holding the October clock change
  // still starts at midnight.
  const november = weeklyHistory(historyOf(claudeRows, codexRows), cfg, +new Date("2026-11-04T12:00:00+01:00"));
  assert.equal(november.claude.at(-1).start, ts("2026-11-02T00:00:00+01:00"));
  assert.equal(november.claude.at(-2).start, ts("2026-10-26T00:00:00+01:00"));
  assert.equal(november.claude.at(-3).start, ts("2026-10-19T00:00:00+02:00"));
  assert.equal(november.claude.at(-8).reqs, 5, "the week of 14 September is still there");

  const history = historyOf(claudeRows, codexRows);
  history.since = { claude: ts("2026-09-10T00:00:00+02:00"), codex: ts("2026-09-14T00:00:00+02:00") };
  const partial = weeklyHistory(history, cfg, now);
  assert.deepEqual([partial.claude.at(-2).tracked, partial.claude.at(-2).partial], [true, true]);
  assert.deepEqual([partial.claude.at(-1).tracked, partial.claude.at(-1).partial], [true, false]);
  assert.deepEqual([partial.codex.at(-1).partial, partial.codex.at(-4).tracked], [false, false]);
});

test("days cover the twelve weeks and the two months before this one, and add up to them", () => {
  const history = historyOf(claudeRows, codexRows);
  const days = dailyHistory(history, cfg, now);
  const weeks = weeklyHistory(history, cfg, now);
  for (const provider of ["claude", "codex"]) {
    const list = days[provider];
    assert.equal(list[0].start, weeks[provider][0].start, "from the Monday of the first of the twelve weeks");
    assert.equal(list.at(-1).start, ts("2026-09-18T00:00:00+02:00"), "today last");
    assert.equal(list.length, 82);
    assert.ok(list.every((d) => !("models" in d) && !("unpricedModels" in d)), "days carry no model breakdown");
    for (const week of weeks[provider]) {
      const own = list.filter((d) => d.start >= week.start && d.start < week.start + 7 * 86400 - 3600);
      assert.equal(own.reduce((n, d) => n + d.tokens, 0), week.tokens);
    }
  }
  assert.equal(days.claude.find((d) => d.start === ts("2026-09-17T00:00:00+02:00")).reqs, 1);
  assert.ok(Math.abs(days.claude.reduce((n, d) => n + d.cost, 0) - weeks.claude.reduce((n, w) => n + w.cost, 0)) < 1e-9);
  // Late in a month the month before last reaches further back than the
  // twelve weeks do, and every day still starts at local midnight across the
  // October clock change.
  const december = dailyHistory(history, cfg, +new Date("2026-12-31T12:00:00+01:00")).claude;
  assert.equal(december[0].start, ts("2026-10-01T00:00:00+02:00"));
  assert.equal(december.at(-1).start, ts("2026-12-31T00:00:00+01:00"));
  assert.ok(december.every((d) => new Date(d.start * 1000).getHours() === 0));
});

test("stored months are priced with today's tables, not the ones they were recorded under", () => {
  const history = historyOf([[ts("2026-09-10T12:00:00+02:00"), "claude-unreleased-9", 1e6, 0, 0, 0, 0, 0, "x"]], []);
  const guessed = monthlyHistory(history, cfg, now).claude.at(-1).cost;
  usePriceFeed({ claude: { "claude-unreleased-9": [1, 5, 0.1] }, codex: {} });
  try {
    assert.equal(monthlyHistory(history, cfg, now).claude.at(-1).cost, 1);
    assert.notEqual(guessed, 1);
  } finally {
    usePriceFeed(null);
  }
});

test("a month that began before its provider's history is complete is marked partial", () => {
  const history = historyOf(claudeRows, codexRows);
  history.since = { claude: ts("2026-08-20T00:00:00+02:00"), codex: ts("2026-09-01T00:00:00+02:00") };
  const months = monthlyHistory(history, cfg, now);
  assert.deepEqual([months.claude.at(-2).tracked, months.claude.at(-2).partial], [true, true]);
  assert.deepEqual([months.claude.at(-1).tracked, months.claude.at(-1).partial], [true, false]);
  assert.deepEqual([months.codex.at(-2).tracked, months.codex.at(-2).partial], [true, true], "data before the start still shows, as a lower bound");
  assert.deepEqual([months.codex.at(-1).partial, months.codex.at(-3).tracked], [false, false]);

  const ledger = claudeRecords({ a: { r: claudeRows } });
  // Complete from whichever reaches further back: the transcripts Claude Code
  // still keeps, or the ledger's oldest record.
  assert.deepEqual(historySince(ledger, codexRows, now, { cold: false, keepDays: 10 }), { claude: ledger[0].ts, codex: codexRows[0][0] });
  assert.equal(historySince(ledger, codexRows, now, { cold: false, keepDays: 30 }).claude, now / 1000 - 30 * 86400);
  // A cold cache has just read the old sessions Claude Code happened to keep,
  // which say nothing about how complete those weeks are.
  const cold = historySince(ledger, codexRows, now, { cold: true, keepDays: 30 });
  assert.equal(cold.claude, now / 1000 - 30 * 86400);
});

test("the history survives the transcripts and the cache being deleted", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "usage-hud-history-"));
  const transcripts = path.join(home, ".claude", "projects", "sample");
  const file = path.join(home, ".local", "share", "usage-hud", "usage-history.json");
  const collect = async () => JSON.parse((await promisify(execFile)(process.execPath, ["collect.mjs"], {
    cwd: path.resolve("."), env: { ...process.env, HOME: home }, encoding: "utf8",
  })).stdout);
  try {
    fs.mkdirSync(transcripts, { recursive: true });
    fs.mkdirSync(path.join(home, ".config", "usage-hud"), { recursive: true });
    fs.writeFileSync(path.join(home, ".config", "usage-hud", "config.json"), JSON.stringify({ claude: { liveUsage: false }, pricingFeed: null }));
    const entry = { type: "assistant", timestamp: new Date().toISOString(),
      message: { id: "m1", model: "claude-sonnet-5", usage: { input_tokens: 1e6, output_tokens: 0 } } };
    fs.writeFileSync(path.join(transcripts, "log.jsonl"), JSON.stringify(entry) + "\n");

    const first = await collect();
    assert.equal(first.history.error, null);
    assert.equal(first.claude.months.at(-1).cost, 2);
    assert.equal(first.claude.weeks.at(-1).cost, 2);
    const written = fs.statSync(file).mtimeMs;
    await collect();
    assert.equal(fs.statSync(file).mtimeMs, written, "a refresh with nothing new does not rewrite the history");

    fs.rmSync(path.join(home, ".claude"), { recursive: true });
    fs.rmSync(path.join(home, ".cache"), { recursive: true });
    const after = await collect();
    assert.equal(after.claude.periods.monthly.reqs, 0, "the ledger has nothing left");
    assert.equal(after.claude.months.at(-1).cost, 2, "the history still has the month");
    assert.equal(after.claude.weeks.at(-1).cost, 2, "and the week");

    fs.writeFileSync(file, "{ not json");
    const reset = await collect();
    assert.equal(reset.history.error, null);
    assert.ok(fs.readdirSync(path.dirname(file)).some((name) => name.startsWith("usage-history.json.unreadable-")), "an unreadable history is set aside, not overwritten");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
