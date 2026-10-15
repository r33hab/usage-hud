#!/usr/bin/env node
// Drives the editor in headless Chrome and asserts that no edit can silently
// lose a component. The editor is the only part of this tool that can destroy
// hand-made work, so it gets the test.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

import { sampleData } from "./sample-data.mjs";
const data = sampleData();

const driver = `
<div id="testout" style="display:none"></div>
<script>
const out = [];
const cfg = () => window.hudState.config;
const specs = () => {
  const all = [];
  const walk = (list) => { for (const s of list || []) { all.push(s); walk(s.items); } };
  cfg().cards.forEach((c) => walk(c.rows));
  return all;
};
const check = (name, cond, detail) => out.push({ name, pass: !!cond, detail: detail || "" });

function dragTo(fromWrap, toWrap, atTop) {
  const grip = fromWrap.querySelector(":scope > .grip");
  const g = grip.getBoundingClientRect();
  grip.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: g.x + 2, clientY: g.y + 2 }));
  toWrap.scrollIntoView({ block: "center" });
  const t = toWrap.getBoundingClientRect();
  const y = atTop ? t.top + 1 : t.bottom - 1;
  window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: t.x + 8, clientY: y }));
  window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
}

const topRows = (cardIndex) =>
  [...document.querySelectorAll(".card")[cardIndex].querySelectorAll(':scope > .rows > .wrap[data-domain="top"]')];
const nested = () => [...document.querySelectorAll('.wrap[data-domain="nested"]')];

window.hudUpdate(PAYLOAD);
window.hudSetBounds({height: 600});
window.hudSetEditing(true);

const live = document.getElementById("live-preview");
const preview = live.shadowRoot;
check("live preview is visible while editing", getComputedStyle(document.getElementById("preview-pane")).display !== "none");
check("there is no separate Preview tab", !document.querySelector('#custom-tabs [data-tab="preview"]'));
check("preview renders components without editing controls", preview.querySelectorAll(".wrap").length === specs().length && !preview.querySelector(".grip, .outline-row, .ctl"));
const baseline = specs().length;
const cardsBaseline = cfg().cards.map((c) => c.rows.length);
check("layout built", baseline > 0, baseline + " specs");

// 1. reorder inside one card
let rows = topRows(1);
dragTo(rows[rows.length - 1], rows[1], true);
check("reorder within a card keeps every spec", specs().length === baseline, specs().length + " vs " + baseline);

// 2. move a row into the other card
rows = topRows(1);
dragTo(rows[rows.length - 1], topRows(0)[2], true);
check("move between cards keeps every spec", specs().length === baseline, specs().length + " vs " + baseline);

// 3. drag a nested item into the header item zone - the old silent-loss path
const n = nested();
const headerZone = document.querySelector('.wrap.row-header [data-dropzone="nested"] .wrap') || n[0];
if (n.length > 1) {
  dragTo(n[n.length - 1], headerZone, true);
  check("nested item into header keeps every spec", specs().length === baseline, specs().length + " vs " + baseline);
} else {
  check("nested item into header keeps every spec", false, "not enough nested items to test");
}

// 4. a card must never be emptied down to nothing by dragging
const before4 = specs().length;
let guard = 0;
while (topRows(1).length > 1 && guard++ < 12) {
  dragTo(topRows(1)[topRows(1).length - 1], topRows(0)[1], true);
}
check("emptying a card by dragging loses nothing", specs().length === before4, specs().length + " vs " + before4);

// 5. delete removes exactly one
const before5 = specs().length;
const del = [...topRows(0)].reverse().find((w) => !["header", "row"].includes(w.dataset.type));
if (del) {
  del.querySelector(".outline-select").click();
  document.querySelector('#inspector button[data-act="remove"]').click();
  check("delete removes exactly one spec", specs().length === before5 - 1, specs().length + " vs " + (before5 - 1));
} else {
  check("delete removes exactly one spec", false, "no remove button found");
}

// 6. add appends exactly one
const before6 = specs().length;
document.querySelectorAll(".cardedit")[0].querySelector(".mini").click();
const palBtn = document.querySelectorAll(".cardedit")[0].querySelector(".palette .mini");
if (palBtn) {
  palBtn.click();
  check("add appends exactly one spec", specs().length === before6 + 1, specs().length + " vs " + (before6 + 1));
} else {
  check("add appends exactly one spec", false, "palette did not open");
}

// 7. every spec still renders without throwing
let rendered = 0;
document.querySelectorAll(".wrap").forEach(() => rendered++);
check("all wrappers rendered", rendered >= specs().length, rendered + " wrappers, " + specs().length + " specs");

// The DOM is rebuilt after every edit, so a spec has to be re-found each time.
const findWrap = (spec) => [...document.querySelectorAll(".wrap")].find((w) => w.__spec === spec);

// 8. the move buttons reach out of a side-by-side row, and lose nothing
const before8 = specs().length;
const nestedWrap = nested()[0];
if (nestedWrap) {
  const target = nestedWrap.__spec;
  let guard8 = 0;
  while (guard8++ < 6) {
    const w = findWrap(target);
    if (!w || w.dataset.domain === "top") break;
    w.querySelector(".outline-select").click();
    const btn = document.querySelector('#inspector button[data-act="up"]');
    if (!btn || btn.disabled) break;
    btn.click();
  }
  const landed = findWrap(target);
  check("move up lifts a nested component out of its row", landed && landed.dataset.domain === "top",
    landed ? landed.dataset.domain : "gone");
  check("move buttons keep every spec", specs().length === before8, specs().length + " vs " + before8);
} else {
  check("move up lifts a nested component out of its row", false, "no nested component with a move button");
  check("move buttons keep every spec", false, "not run");
}

// 9. a drag can put a top-level component inside a side-by-side row
const before9 = specs().length;
const rowWrap = document.querySelector('.wrap[data-type="row"]');
const insideRow = rowWrap && rowWrap.querySelector('[data-dropzone="nested"] > .wrap');
const mover = [...document.querySelectorAll('.wrap[data-domain="top"]')]
  .find((w) => !["row", "header"].includes(w.dataset.type) && !w.contains(rowWrap));
if (insideRow && mover) {
  const moverSpec = mover.__spec;
  dragTo(mover, insideRow, true);
  const landed = findWrap(moverSpec);
  check("drag can nest a component inside a row", landed && landed.dataset.domain === "nested",
    landed ? landed.dataset.domain : "gone");
  check("nesting by drag keeps every spec", specs().length === before9, specs().length + " vs " + before9);
} else {
  check("drag can nest a component inside a row", false, "no row to drag into");
  check("nesting by drag keeps every spec", false, "not run");
}

// 10. minimised "bars" leaves the gauges and nothing else
window.hudSetEditing(false);
// The button toggles, and the live config may already be minimised: clear the
// flag first so one click always lands on "minimised".
const minimise = (mode) => {
  cfg().theme.collapsedMode = mode;
  cfg().theme.collapsed = false;
  document.getElementById("b-collapse").click();
};
minimise("bars");
const shown = (w) => getComputedStyle(w).display !== "none";
const visibleTop = [...document.querySelectorAll(".rows > .wrap")].filter(shown);
const strays = [...document.querySelectorAll('.wrap[data-meter="1"] .wrap:not([data-meter="1"])')].filter(shown);
check("minimised keeps at least one gauge", visibleTop.some((w) => w.dataset.meter === "1"),
  visibleTop.length + " visible");
check("minimised shows bars only",
  visibleTop.every((w) => w.dataset.meter === "1" || w.querySelector(".banner.on.urgent")) && !strays.length,
  visibleTop.map((w) => w.dataset.type).join(",") + " | strays " + strays.length);

// 11. minimised "headers" is still reachable, and is a different thing
minimise("headers");
const headerOnly = [...document.querySelectorAll(".rows > .wrap")].filter(shown);
check("minimised headers shows headers",
  headerOnly.length > 0 && headerOnly.every((w) => w.classList.contains("row-header") || w.querySelector(".banner.on.urgent")),
  headerOnly.map((w) => w.dataset.type).join(","));

// 12. Long layouts stay inside the screen, with a persistent exit and inspector.
window.hudSetEditing(true);
const beforeLong = JSON.stringify(cfg());
for (let i = 0; i < 70; i++) cfg().cards[0].rows.push({type: "text", value: "Extra component " + i});
buildLayout();
window.hudSetBounds({height: 420});
const rect = id => document.getElementById(id).getBoundingClientRect();
check("long layout fits a short screen", rect("root").height <= 420);
check("Done stays visible", rect("b-done").top >= 0 && rect("b-done").bottom < 420);
check("footer stays visible", rect("custom-foot").bottom <= 420);
const cardList = document.getElementById("cards");
check("layout scrolls instead of growing", cardList.scrollHeight > cardList.clientHeight && cardList.clientHeight > 60, cardList.clientHeight + "px visible / " + cardList.scrollHeight + "px content");
const lastText = [...document.querySelectorAll('.wrap[data-type="text"]')].at(-1);
lastText.querySelector(".outline-select").click();
check("only the selected component has controls", document.querySelectorAll(".ctl").length === 1 && document.querySelector("#inspector input").value === "Extra component 69");
check("inspector remains accessible", rect("inspector").height > 80 && rect("inspector").bottom <= rect("custom-foot").top + 1);

// Undo a removal with its exact nested data intact.
flushSave();
savedSnapshot = JSON.stringify(cfg());
const beforeRemove = JSON.stringify(cfg());
document.querySelector('#inspector [data-act="remove"]').click();
document.getElementById("b-undo").click();
check("Undo restores the removed component exactly", JSON.stringify(cfg()) === beforeRemove);

// 13. Appearance has independent scrolling and never resizes under a slider.
window.hudOpenDrawer();
check("Appearance replaces the layout list", getComputedStyle(cardList).display === "none" && !window.hudState.editing && window.hudState.customizing);
const drawer = document.getElementById("drawer");
check("Appearance scrolls on short screens", drawer.scrollHeight > drawer.clientHeight && drawer.clientHeight > 60);
const beforeWidth = rect("root").width;
const widthControl = document.getElementById("appearance-width");
widthControl.value = "620";
widthControl.dispatchEvent(new Event("input", {bubbles: true}));
check("width previews continuously before release", live.style.width === "620px");
widthControl.dispatchEvent(new Event("change", {bubbles: true}));
check("width changes preserve the workspace size", cfg().theme.width === 620 && rect("root").width === beforeWidth);
flushSave();
const stalePayload = JSON.parse(JSON.stringify(window.hudState.data));
stalePayload.config = JSON.parse(beforeLong);
window.hudUpdate(stalePayload);
check("refresh cannot overwrite appearance edits", cfg().theme.width === 620);
drawer.scrollTop = drawer.scrollHeight;
check("last appearance option is reachable", rect("appearance-refresh").top >= rect("drawer").top && rect("appearance-refresh").bottom <= rect("drawer").bottom);
check("Done stays fixed while options scroll", rect("b-done").bottom < rect("drawer").top);

// 14. Editing and appearance changes render immediately in the pinned preview.
check("preview stays visible alongside Appearance", getComputedStyle(document.getElementById("preview-pane")).display !== "none" && getComputedStyle(drawer).display !== "none");
document.querySelector('#appearance-density button:last-child').click();
check("preview reflects density independently of the editor", getComputedStyle(preview.querySelector(".card")).paddingTop === "15px");
document.querySelector('#appearance-theme button:last-child').click();
check("preview follows the light palette", live.dataset.scheme === "light");
window.hudSetEditing(true);
const textWrap = [...document.querySelectorAll('#cards .wrap[data-type="text"]')].at(-1);
const textSpec = textWrap.__spec;
textWrap.querySelector(".outline-select").click();
const textInput = document.querySelector('#inspector input');
textInput.value = "A live edit";
textInput.dispatchEvent(new Event("input", {bubbles: true}));
check("typing updates the preview without leaving the editor", preview.textContent.includes("A live edit") && document.activeElement !== document.getElementById("b-done"));
const previewWrap = () => [...preview.querySelectorAll('.wrap')].find(w => w.__spec === textSpec);
document.querySelector('#inspector [data-act="hide"]').click();
check("hiding immediately removes the preview component", getComputedStyle(previewWrap()).display === "none");
document.getElementById("b-undo").click();
check("undo updates the live preview", [...preview.querySelectorAll('.wrap[data-type="text"]')].some(w => w.textContent === "A live edit" && getComputedStyle(w).display !== "none"));
const unchangedConfig = JSON.stringify(cfg());
document.getElementById("b-preview-collapse").click();
check("minimised preview leaves saved layout untouched", live.dataset.collapsed === "1" && JSON.stringify(cfg()) === unchangedConfig);
document.getElementById("b-preview-collapse").click();
const refreshPayload = JSON.parse(JSON.stringify(window.hudState.data));
refreshPayload.claude.gauges.session.pct = .73;
window.hudUpdate(refreshPayload);
check("preview keeps receiving live usage data", [...preview.querySelectorAll('.pct')].some(n => n.textContent === "73%"));
// The stacked fallback must also reserve room for both settings and preview.
// Responsive rules follow the viewport, so the shell runner checks both widths.
check("preview and settings stay within the short window", rect("preview-pane").bottom <= rect("custom-foot").top + 1 && rect("inspector").height > 60);
check("wide HUD previews scale to the available space", rect("preview-size").width <= document.getElementById("preview-viewport").clientWidth);
cfg().theme.collapsed = true;
document.getElementById("b-done").click();
check("Done restores the compact HUD", !window.hudState.customizing && document.documentElement.dataset.collapsed === "1");
check("Done flushes pending changes", !window.hudState.savePending);
check("Done hides the live preview", getComputedStyle(document.getElementById("preview-pane")).display === "none");
window.hudOpenDrawer();
document.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true}));
check("Escape exits customization", !window.hudState.customizing);

// Every usage family offers all three periods, including nested headlines and
// individual stat values; switching one component must not change its peers.
window.hudSetEditing(true);
const selectSpec = spec => {
  state.selected = spec;
  buildLayout();
};
const pickPeriod = (label, index = 0) => {
  const select = document.querySelectorAll('#inspector .period-picker')[index];
  const option = [...select.options].find(o => o.textContent === label);
  select.value = option.value;
  select.dispatchEvent(new Event('change', {bubbles: true}));
};
// One rule: every quantity of a kind offers every window of that kind.
const VALUE_WINDOWS = ['daily', 'weekly', 'monthly', 'lastWeek', 'lastMonth', 'session', 'quotaWeek', 'rolling7d'];
const CHART_SPANS = ['daily', 'weekly', 'monthly', '7d', '14d', '12wk', '12mo'];
for (const [name, registry, windows] of [["metrics", METRICS, VALUE_WINDOWS], ["models", CHIPSOURCES, VALUE_WINDOWS], ["charts", SERIES, CHART_SPANS]]) {
  const families = [...new Set(Object.values(registry).map(item => item.family).filter(Boolean))];
  check(name + " offer every window for every usage family", families.length > 0 && families.every(family =>
    windows.every(period => Object.values(registry).some(item => item.family === family && item.period === period))), families.length + " families");
}
check("saved layouts' old ids resolve to the same entries",
  METRICS['claude.cost.weekly'] === METRICS['claude.cost.quotaWeek'] && METRICS['codex.tokens.week'] === METRICS['codex.tokens.quotaWeek']
  && METRICS['codex.tokens.window'] === METRICS['codex.tokens.session'] && METRICS['claude.cost.fable'] === METRICS['claude.fableCost.quotaWeek']
  && CHIPSOURCES['claude.models'] === CHIPSOURCES['claude.models.today'] && CHIPSOURCES['claude.models.wk'] === CHIPSOURCES['claude.models.quotaWeek']
  && SERIES['claude.daily.cost'] === SERIES['claude.activity.cost.14d'] && SERIES['codex.daily.tokens'] === SERIES['codex.activity.tokens.14d']);
const periodHeadline = {type: 'headline', metric: 'codex.cost.today', sub: null};
const periodChips = {type: 'chips', source: 'claude.models.wk', limit: 3};
const periodSpark = {type: 'spark', series: 'codex.daily.tokens'};
const periodStat = {type: 'stat', metrics: ['claude.out.today', 'codex.turns.today', 'codex.plan']};
cfg().cards[0].rows.push({type: 'row', items: [periodHeadline, periodChips, periodSpark]}, periodStat);
selectSpec(periodHeadline);
const periodLabels = () => [...document.querySelector('#inspector .period-picker').options].map(o => o.textContent).join('|');
const CODEX_WINDOWS = 'Daily|Weekly|Monthly|Last week|Last month|5h window|Quota week|Last 7 days';
const CLAUDE_WINDOWS = 'Daily|Weekly|Monthly|Last week|Last month|5h block|Quota week|Last 7 days';
check('headline offers the full window list', periodLabels() === CODEX_WINDOWS, periodLabels());
const valueLabels = [...document.querySelector('#inspector .control-field select').options].map(o => o.textContent);
// Quantities only: no window suffix, no leftover "quota week" / "7d rolling" variants.
const windowish = / · |Daily|Weekly|Monthly|Quota week|Last 7 days|14 days|rolling|7d/;
check('value picker names quantities without a period', valueLabels.length > 10 && !valueLabels.some(l => windowish.test(l)),
  valueLabels.filter(l => windowish.test(l)).join(', '));
const listsFor = (spec, ids) => ids.map(id => { spec.metric = id; selectSpec(spec); return periodLabels(); });
const dailyIds = provider => Object.keys(METRICS).filter(id => METRICS[id].provider === provider && METRICS[id].period === 'daily' && METRICS[id].id === id);
const codexLists = listsFor(periodHeadline, dailyIds('codex'));
check('every Codex value offers the same windows', codexLists.length >= 8 && codexLists.every(l => l === CODEX_WINDOWS), [...new Set(codexLists)].join(' / '));
const claudeLists = listsFor(periodHeadline, dailyIds('claude'));
check('every Claude value offers the same windows', claudeLists.length >= 9 && claudeLists.every(l => l === CLAUDE_WINDOWS), [...new Set(claudeLists)].join(' / '));
periodHeadline.metric = 'codex.cost.today';
selectSpec(periodHeadline);
pickPeriod('Weekly');
check('headline switches to weekly cost with a matching caption', periodHeadline.metric === 'codex.cost.calendarWeek' && metricValue(periodHeadline.metric, state.data).caption.includes('this week'));
pickPeriod('Monthly');
check('monthly Codex cost renders in the live preview', periodHeadline.metric === 'codex.cost.month' && [...preview.querySelectorAll('.headline')].some(n => n.textContent.includes('$298') && n.textContent.includes('this month')));
const monthlyConfig = JSON.stringify(cfg());
pickPeriod('Daily');
document.getElementById('b-undo').click();
check('Undo restores the selected period exactly', JSON.stringify(cfg()) === monthlyConfig);
// Undo restores cloned objects; retrieve their new identities.
const restoredRow = cfg().cards[0].rows.at(-2);
selectSpec(restoredRow.items[1]);
check('existing quota-week model chips expose all calendar periods', [...document.querySelector('#inspector .period-picker').options].some(o => o.textContent === 'Monthly'));
pickPeriod('Monthly');
check('model chips can use monthly data', restoredRow.items[1].source === 'claude.models.month');
selectSpec(restoredRow.items[2]);
pickPeriod('Daily');
check('daily chart shows hourly activity', SERIES[restoredRow.items[2].series].get(state.data).length === 12);
pickPeriod('Weekly');
check('weekly chart shows the current calendar week', SERIES[restoredRow.items[2].series].get(state.data).length === 5);
pickPeriod('Monthly');
check('monthly chart shows the current calendar month', SERIES[restoredRow.items[2].series].get(state.data).length === 18);
const restoredStat = cfg().cards[0].rows.at(-1);
selectSpec(restoredStat);
check('each time-based stat has its own period control', document.querySelectorAll('#inspector .period-picker').length === 2);
pickPeriod('Monthly', 0);
pickPeriod('Weekly', 1);
check('stat periods change independently', restoredStat.metrics[0] === 'claude.out.month' && restoredStat.metrics[1] === 'codex.turns.calendarWeek' && restoredStat.metrics[2] === 'codex.plan');
check('period controls stay inside the inspector', [...document.querySelectorAll('#inspector select')].every(n => n.getBoundingClientRect().right <= rect('inspector').right + 1));
const partialData = structuredClone(state.data);
partialData.codex.periods.monthly.unpricedTokens = 100;
partialData.codex.periods.monthly.unpricedModels = {'codex-auto-review': 100};
const partialCost = metricValue('codex.cost.month', partialData);
check('unpriced models mark a partial cost and name the missing model', partialCost.text.endsWith('+') && partialCost.caption.includes('partial') && partialCost.title.includes('codex-auto-review'));
partialData.codex.periods.monthly.pricedTokens = 0;
check('entirely unpriced usage is not displayed as free', metricValue('codex.cost.month', partialData).value === null);
// A layout saved before the windows were unified keeps working, and shows as
// the window it always was rather than as a fourth ad-hoc entry.
const legacyHeadline = {type: 'headline', metric: 'claude.cost.weekly', sub: null};
cfg().cards[0].rows.push(legacyHeadline);
selectSpec(legacyHeadline);
const legacyPicker = document.querySelector('#inspector .period-picker');
check('a saved quota-week id shows the standard list with Quota week selected',
  periodLabels() === CLAUDE_WINDOWS && legacyPicker.selectedOptions[0].textContent === 'Quota week' && legacyPicker.value === 'claude.cost.weekly',
  periodLabels() + ' :: ' + (legacyPicker.selectedOptions[0] || {}).textContent);
check('a saved quota-week id still renders the quota-week figure', metricValue('claude.cost.weekly', state.data).caption === 'quota week' && metricValue('claude.cost.weekly', state.data).text === '$24.80');
const valueSelect = document.querySelector('#inspector .control-field select');
valueSelect.value = [...valueSelect.options].find(o => o.textContent === 'requests').value;
valueSelect.dispatchEvent(new Event('change', {bubbles: true}));
check('changing the quantity keeps the window', legacyHeadline.metric === 'claude.reqs.quotaWeek', legacyHeadline.metric);
pickPeriod('Monthly');
check('Monthly is one pick away from any value', legacyHeadline.metric === 'claude.reqs.month' && metricValue(legacyHeadline.metric, state.data).caption === 'req · this month', legacyHeadline.metric);
const statLabel = componentLabel({type: 'stat', metrics: ['claude.reqs.today', 'claude.cost.month', 'codex.tokens.week', 'claude.weeklyReset']});
check('stat outline names each value once, with its window', statLabel === 'requests · Daily, cost · Monthly, total tokens · Quota week, week resets in', statLabel);
const legacyChart = {type: 'spark', series: 'claude.daily.cost'};
cfg().cards[0].rows.push(legacyChart);
selectSpec(legacyChart);
check('a saved 14-day chart shows the chart spans with Last 14 days selected', periodLabels() === 'Daily|Weekly|Monthly|Last 7 days|Last 14 days|Last 12 weeks|Last 12 months' && document.querySelector('#inspector .period-picker').selectedOptions[0].textContent === 'Last 14 days', periodLabels());
check('a saved 14-day chart draws fourteen bars', SERIES[legacyChart.series].get(state.data).length === 14);
pickPeriod('Last 7 days');
check('charts can draw the last seven days', legacyChart.series === 'claude.activity.cost.7d' && SERIES[legacyChart.series].get(state.data).length === 7, legacyChart.series);
pickPeriod('Last 12 months');
const monthBars = SERIES[legacyChart.series].get(state.data);
check('a 12-month chart draws one bar per month, nothing for months before the history', legacyChart.series === 'claude.activity.cost.12mo'
  && monthBars.length === 12 && monthBars.slice(0, 7).every(v => v === null) && monthBars.at(-1) === state.data.claude.periods.monthly.cost, JSON.stringify(monthBars));
pickPeriod('Last 12 weeks');
const weekBars = SERIES[legacyChart.series].get(state.data);
check('a 12-week chart draws one bar per week, nothing for weeks before the history', legacyChart.series === 'claude.activity.cost.12wk'
  && weekBars.length === 12 && weekBars.slice(0, 8).every(v => v === null) && weekBars.at(-1) === state.data.claude.periods.weekly.cost, JSON.stringify(weekBars));
// Last month, and the month-by-month list, come from the collector's history.
const lastMonth = metricValue('claude.cost.lastMonth', state.data);
check('last month is the previous calendar month', lastMonth.value === state.data.claude.months.at(-2).cost && lastMonth.caption === 'last month' && !lastMonth.text.endsWith('+'), lastMonth.text);
const earlyData = structuredClone(state.data);
earlyData.claude.months.at(-2).partial = true;
const earlyMonth = metricValue('claude.cost.lastMonth', earlyData);
check('a last month older than the history is a lower bound', earlyMonth.text.endsWith('+') && earlyMonth.caption.includes('partial') && earlyMonth.title.includes('began before'));
check('a hit rate is never marked as a lower bound', !metricValue('claude.cacheHit.lastMonth', earlyData).text.endsWith('+'));
earlyData.claude.months.at(-2).tracked = false;
check('a last month the history knows nothing about shows no value', metricValue('claude.cost.lastMonth', earlyData).value === null);
const lastWeek = metricValue('claude.cost.lastWeek', state.data);
check('last week is the previous calendar week', lastWeek.value === state.data.claude.weeks.at(-2).cost && lastWeek.caption === 'last week' && !lastWeek.text.endsWith('+'), lastWeek.text);
earlyData.claude.weeks.at(-2).partial = true;
const earlyWeek = metricValue('claude.cost.lastWeek', earlyData);
check('a last week older than the history is a lower bound', earlyWeek.text.endsWith('+') && earlyWeek.caption.includes('partial') && earlyWeek.title.includes('the week began before'), earlyWeek.title);
earlyData.claude.weeks.at(-2).tracked = false;
check('a last week the history knows nothing about shows no value', metricValue('claude.cost.lastWeek', earlyData).value === null);
check('weeks are numbered the ISO way', isoWeek(new Date(2026, 9, 5)) === 41 && isoWeek(new Date(2026, 9, 11)) === 41
  && isoWeek(new Date(2025, 11, 29)) === 1 && isoWeek(new Date(2027, 0, 1)) === 53 && isoWeek(new Date(2027, 0, 4)) === 1);
const monthList = {type: 'months', source: 'claude.cost', count: 6};
cfg().cards[0].rows.push(monthList);
selectSpec(monthList);
const listRows = () => [...[...preview.querySelectorAll('.mlist')].at(-1).querySelectorAll('.mrow')];
const listText = () => listRows().map(r => r.textContent);
check('the month list shows only months the history covers, newest first', listRows().length === 5 && listRows()[0].classList.contains('now')
  && listText()[0].endsWith(FMT.money(state.data.claude.months.at(-1).cost)) && listText()[1].endsWith(FMT.money(state.data.claude.months.at(-2).cost)), listText().join(' / '));
check('a month older than the history is marked with a +', listText().at(-1).endsWith('+') && !listText()[1].endsWith('+'), listText().at(-1));
check('the month list scales its bars to the biggest month', listRows()[1].querySelector('i').style.width === '100%');
check('the month list has a value, a period and a length control', [...document.querySelectorAll('#inspector .control-label')].map(n => n.textContent).join('|') === 'Value|Per|Months to show');
const lengthPicker = [...document.querySelectorAll('#inspector select')][2];
lengthPicker.value = '3';
lengthPicker.dispatchEvent(new Event('change', {bubbles: true}));
check('the month list shows as many months as asked', cfg().cards[0].rows.at(-1).count === 3 && listRows().length === 3);
const sourcePicker = document.querySelector('#inspector select');
sourcePicker.value = 'codex.tokens';
sourcePicker.dispatchEvent(new Event('change', {bubbles: true}));
check('the month list can show any quantity of either provider', cfg().cards[0].rows.at(-1).source === 'codex.tokens'
  && listText()[0].endsWith(FMT.tok(state.data.codex.months.at(-1).tokens)) && componentLabel(cfg().cards[0].rows.at(-1)) === 'Codex · total tokens by month', listText()[0]);
const pickPer = (value) => {
  const select = [...document.querySelectorAll('#inspector select')][1];
  select.value = value;
  select.dispatchEvent(new Event('change', {bubbles: true}));
};
pickPer('week');
const thisWeek = new Date(state.data.codex.weeks.at(-1).start * 1000);
check('the list can show calendar weeks, named by their Monday', cfg().cards[0].rows.at(-1).per === 'week' && cfg().cards[0].rows.at(-1).source === 'codex.tokens'
  && listRows().length === 3 && listRows()[0].classList.contains('now') && listText()[0].endsWith(FMT.tok(state.data.codex.weeks.at(-1).tokens))
  && listRows()[0].querySelector('.mmon').textContent === thisWeek.toLocaleDateString('en', {month: 'short', day: 'numeric'})
  && listRows()[0].querySelector('.mmon').title.startsWith('Week ' + isoWeek(thisWeek) + ', ')
  && componentLabel(cfg().cards[0].rows.at(-1)) === 'Codex · total tokens by week'
  && [...document.querySelectorAll('#inspector .control-label')].map(n => n.textContent).join('|') === 'Value|Per|Weeks to show', listText().join(' / '));
const fullLength = [...document.querySelectorAll('#inspector select')][2];
fullLength.value = '12';
fullLength.dispatchEvent(new Event('change', {bubbles: true}));
check('a week older than the history is marked with a +', listRows().length === 4 && listText().at(-1).endsWith('+') && !listText()[1].endsWith('+')
  && listRows().at(-1).querySelector('.mmon').title.includes('the week began before'), listText().join(' / '));
pickPer('month');
check('switching back to months leaves the saved layout as it was', !('per' in cfg().cards[0].rows.at(-1)) && listRows().length === 5, listText().join(' / '));
// Two big numbers in a header stay side by side and level. When the panel is
// too narrow for the captions beside them, the captions go under the numbers.
const headerItems = cfg().cards[0].rows[0].items;
const secondHeadline = {type: 'headline', metric: 'claude.cost.calendarWeek', sub: null};
headerItems.push(secondHeadline);
const headerAt = width => {
  cfg().theme.width = width;
  syncLivePreview();
  const rh = preview.querySelector('.rh');
  const bigs = [...rh.querySelectorAll('.big')].map(b => Math.round(b.getBoundingClientRect().bottom));
  const subs = [...rh.querySelectorAll('.bigsub')].map(b => Math.round(b.getBoundingClientRect().height));
  return { tight: rh.classList.contains('tight'), level: bigs.length === 2 && bigs[0] === bigs[1], oneLineCaptions: subs.every(h => h < 16), height: Math.round(rh.getBoundingClientRect().height) };
};
const wide = headerAt(380), narrow = headerAt(300);
check('two header numbers share a baseline when they fit', !wide.tight && wide.level && wide.oneLineCaptions, JSON.stringify(wide));
check('a narrow header keeps both numbers level with captions underneath', narrow.tight && narrow.level && narrow.oneLineCaptions && narrow.height < 40, JSON.stringify(narrow));
headerItems.pop();
cfg().theme.width = 620;
syncLivePreview();
const persistedPeriods = JSON.stringify(cfg());
window.hudSetEditing(false);
savedSnapshot = persistedPeriods;
state.savePending = false;
const reload = structuredClone(state.data);
reload.config = JSON.parse(persistedPeriods);
state.config = JSON.parse(persistedPeriods);
state.config.cards[0].rows.findLast(r => r.type === 'stat').metrics[0] = 'claude.out.today';
window.hudUpdate(reload);
check('period choices survive a config reload', JSON.stringify(cfg()) === persistedPeriods);

const bannerText = () => [...document.querySelectorAll('.banner.on')].map(b => b.textContent).join(' | ');
const priced = structuredClone(state.data);
priced.claude.pricing = { feedModels: [], estimated: [], mismatches: [{ model: 'claude-opus-5-5', table: [4, 20, 0.05], feed: [5, 25, 0.1] }] };
window.hudUpdate(priced);
check('a changed published price is announced in the Claude banner', bannerText().includes('published price changed for opus-5-5'), bannerText());
priced.claude.pricing = { feedModels: [], estimated: [{ model: 'claude-opus-6-1', as: 'claude-opus-6' }], mismatches: [] };
window.hudUpdate(priced);
check('a model with no published price is named with the rate it borrows', bannerText().includes('no published price for opus-6-1 (priced as opus-6)'), bannerText());
delete priced.claude.pricing;
window.hudUpdate(priced);
check('output without pricing data raises no price banner', !/price/.test(bannerText()), bannerText());

// The usage history: week by week and month by month, as bars or laid over
// each other, one click from the panel.
const hist = document.getElementById('history');
const histOpen = () => document.body.classList.contains('history') && getComputedStyle(hist).display !== 'none' && getComputedStyle(cardList).display === 'none';
try { localStorage.removeItem('usage-hud.history'); } catch (e) { /* no storage */ }
Object.assign(state.history, { provider: 'claude', key: 'cost', per: 'week', view: 'bars' });
document.getElementById('b-history').click();
check('the title bar button opens the history in place of the cards', histOpen() && document.getElementById('b-history').getAttribute('aria-pressed') === 'true');
const histBars = () => [...hist.querySelectorAll('.hbar')];
const histRows = () => [...hist.querySelectorAll('.hlist .mrow')];
const segButton = (text) => [...hist.querySelectorAll('.seg button')].find(b => b.textContent === text);
const weekData = state.data.claude.weeks;
check('weeks run from the first one the history knows to this one', histBars().length === 4 && histBars().at(-1).classList.contains('cur') && histBars()[0].classList.contains('partial'), String(histBars().length));
check('the history leads with this week, last week and a typical week', hist.querySelector('.hsum .big').textContent === FMT.money(weekData.at(-1).cost)
  && hist.querySelectorAll('.hsum .hmid')[0].textContent === FMT.money(weekData.at(-2).cost)
  && hist.querySelectorAll('.hsum .bigsub')[2].textContent === 'avg of 2 weeks', hist.querySelector('.hsum').textContent);
check('it says how this week is pacing against last week', /vs last week at this point/.test(hist.querySelector('.hpace').textContent) && /on track for ≈[$]/.test(hist.querySelector('.hpace').textContent), hist.querySelector('.hpace').textContent);
check('the list gives each week newest first with its change on the week before', histRows().length === 4 && histRows()[0].textContent.endsWith('so far')
  && histRows()[1].querySelector('.hchg').textContent === '+200%' && histRows()[2].querySelector('.hchg').textContent === ''
  && histRows()[3].querySelector('.mval').textContent.endsWith('+'), histRows().map(r => r.textContent).join(' / '));
histBars()[2].dispatchEvent(new MouseEvent('mouseenter'));
check('hovering a bar names its week over the chart and lights its row', hist.querySelector('.hreadout').textContent.startsWith('Week ' + isoWeek(new Date(weekData.at(-2).start * 1000)) + ', ')
  && histRows()[1].classList.contains('hot'), hist.querySelector('.hreadout').textContent);
histBars()[2].dispatchEvent(new MouseEvent('mouseleave'));
segButton('Months').click();
check('Months gives one bar per month the history covers', histBars().length === 5 && hist.querySelector('.hsum .bigsub').textContent === 'this month', String(histBars().length));
segButton('Weeks').click();
segButton('Overlay').click();
const histCount = (selector) => hist.querySelectorAll(selector).length;
check('the overlay lays this week over last week, the earlier weeks and their average', histCount('path.hline.cur') === 1 && histCount('path.hline.last') === 1
  && histCount('path.havg') === 1 && histCount('path.hline:not(.cur):not(.last)') === 1 && hist.querySelector('.hlegend').textContent.includes('avg of 2 weeks'), hist.querySelector('.hlegend').textContent);
const model = state.history.model;
check('running totals end at the week totals', Math.abs(model.cur.curve.total - weekData.at(-1).cost) < 1e-9 && Math.abs(model.last.curve.total - weekData.at(-2).cost) < 1e-9
  && model.last.curve.points.length === 8 && model.cur.curve.points.at(-1).x <= 7, JSON.stringify(model.cur.curve.points));
check('the overlay reads out where this week stands', hist.querySelector('.hreadout').textContent.startsWith('By now: this ' + FMT.money(weekData.at(-1).cost) + ' · last $'), hist.querySelector('.hreadout').textContent);
const hit = hist.querySelector('.hhit').getBoundingClientRect();
hist.querySelector('.hhit').dispatchEvent(new MouseEvent('mousemove', { clientX: hit.left + hit.width / 7, clientY: hit.top + 10 }));
check('pointing at a day reads every week out at the end of it', /^End of Mon: this [$][0-9.]+ · last [$][0-9.]+ · avg [$][0-9.]+$/.test(hist.querySelector('.hreadout').textContent), hist.querySelector('.hreadout').textContent);
let keptPrefs = null;
try { keptPrefs = JSON.parse(localStorage.getItem('usage-hud.history')); } catch (e) { /* no storage */ }
check('the view remembers weeks and overlay for next time', keptPrefs && keptPrefs.per === 'week' && keptPrefs.view === 'overlay', JSON.stringify(keptPrefs));
const picked = hist.querySelector('.hhead select');
picked.value = 'cacheHit';
picked.dispatchEvent(new Event('change', { bubbles: true }));
check('a rate runs as the rate so far, with no projection', state.history.key === 'cacheHit' && !/on track/.test(hist.querySelector('.hpace')?.textContent || '')
  && histRows()[1].querySelector('.hchg').textContent === '±0 pts', histRows().map(r => r.textContent).join(' / '));
picked.value = 'reqs';
picked.dispatchEvent(new Event('change', { bubbles: true }));
hist.querySelector('.hhead select');
segButton('Codex').click();
check('switching provider keeps the nearest quantity', state.history.provider === 'codex' && state.history.key === 'turns' && hist.querySelector('.hhead select').value === 'turns');
const bumped = structuredClone(state.data);
bumped.codex.weeks.at(-1).turns += 1000;
window.hudUpdate(bumped);
check('a refresh redraws the open history', hist.querySelector('.hsum .big').textContent === FMT.int(bumped.codex.weeks.at(-1).turns));
document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
check('Esc goes back to the panel', !document.body.classList.contains('history') && getComputedStyle(cardList).display !== 'none' && !hist.childElementCount);
check('a click opens on the clicked value, by month for a monthly one',
  JSON.stringify(historyFocus({ type: 'headline', metric: 'codex.tokens.lastMonth' })) === JSON.stringify({ provider: 'codex', key: 'tokens', per: 'month' })
  && historyFocus({ type: 'spark', series: 'claude.activity.reqs.12wk' }).per === 'week'
  && JSON.stringify(historyFocus({ type: 'months', per: 'week', source: 'codex.cost' })) === JSON.stringify({ provider: 'codex', key: 'cost', per: 'week' })
  && historyFocus({ type: 'headline', metric: 'claude.weeklyReset' }, { id: 'claude' }).provider === 'claude');
const posted = [];
window.webkit = { messageHandlers: { hud: { postMessage: (m) => posted.push(m) } } };
const headWrap = document.querySelector('#cards .wrap[data-history][data-type="headline"]');
const headAt = headWrap.getBoundingClientRect();
const press = (dx) => {
  headWrap.querySelector('.big').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: headAt.x + 2, clientY: headAt.y + 2 }));
  if (dx) window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, buttons: 1, clientX: headAt.x + 2 + dx, clientY: headAt.y + 2 }));
  window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
};
press(20);
check('dragging a big number still moves the panel', !document.body.classList.contains('history') && posted.some((m) => m.action === 'drag'));
press(0);
const expected = historyFocus(headWrap.__spec, headWrap.__ctx.card);
check('clicking a big number opens the history on its value', histOpen() && state.history.provider === expected.provider && state.history.key === expected.key && state.history.per === expected.per, JSON.stringify(expected));
delete window.webkit;
closeHistory();
cfg().theme.collapsed = true;
applyTheme();
openHistory();
check('the history shows in full from a minimised panel', document.documentElement.dataset.collapsed === '0');
closeHistory();
check('closing it leaves the panel minimised', document.documentElement.dataset.collapsed === '1');
cfg().theme.collapsed = false;
applyTheme();
openHistory();
window.hudSetEditing(true);
check('editing the layout closes the history', !document.body.classList.contains('history') && !state.history.open);
window.hudSetEditing(false);

// Saved configs keep the layout and appearance under a name. Loading one is an
// ordinary, undoable edit that leaves machine settings alone.
const sent = [];
window.webkit = { messageHandlers: { hud: { postMessage: (m) => sent.push(JSON.parse(JSON.stringify(m))) } } };
window.hudSavedConfigs([]);
window.hudOpenSaved();
check("Saved tab replaces the layout list", getComputedStyle(cardList).display === "none" && document.querySelector('#custom-tabs [data-tab="saved"]').getAttribute("aria-pressed") === "true");
flushSave();
savedSnapshot = JSON.stringify(cfg());
const savedLayout = JSON.stringify(cfg().cards);
const savedDensity = cfg().theme.density;
const nameInput = document.getElementById("saved-name");
nameInput.value = "  Big numbers  ";
nameInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
const request = sent.find((m) => m.action === "saveNamedConfig");
check("saving sends the trimmed name with layout, appearance and refresh only",
  request && request.name === "Big numbers" && Object.keys(request.config).sort().join() === "cards,refreshSeconds,theme", JSON.stringify(request && Object.keys(request.config)));
check("a saved config is listed at once", document.querySelector(".saved-name")?.textContent === "Big numbers");
cfg().cards[0].rows.pop();
cfg().theme.density = savedDensity === "roomy" ? "compact" : "roomy";
cfg().pricingFeed = "https://example.test";
save(); flushSave();
const edited = JSON.stringify(cfg());
[...document.querySelectorAll(".saved-row .mini")].find((b) => b.textContent === "Load").click();
check("loading restores the saved layout and appearance", JSON.stringify(cfg().cards) === savedLayout && cfg().theme.density === savedDensity);
check("loading leaves machine settings alone", cfg().pricingFeed === "https://example.test");
document.getElementById("b-undo").click();
check("Undo last change reverts a load", JSON.stringify(cfg()) === edited);
const deleteButton = () => [...document.querySelectorAll(".saved-row .mini")].find((b) => /delete/i.test(b.textContent));
deleteButton().click();
check("the first Delete click only arms it", !sent.some((m) => m.action === "deleteNamedConfig") && deleteButton().textContent === "Confirm delete");
deleteButton().click();
check("the second Delete click deletes", sent.some((m) => m.action === "deleteNamedConfig" && m.name === "Big numbers") && !document.querySelector(".saved-row"));
window.hudSavedConfigs([{ name: "From disk", savedAt: "2026-09-28T08:00:00Z", config: JSON.parse(edited) }]);
check("the native list replaces the shown one", document.querySelector(".saved-name")?.textContent === "From disk");
check("the menu loads a saved config by name", window.hudApplySavedConfig("From disk") === true && window.hudApplySavedConfig("missing") === false);
delete window.webkit;
setEditing(false);

document.getElementById("testout").textContent = JSON.stringify(out);
</script>
`;

let html = fs.readFileSync(path.join(ROOT, "ui", "hud.html"), "utf8");
html += driver.replace("PAYLOAD", JSON.stringify(data));
fs.mkdirSync(path.join(ROOT, "build"), { recursive: true });
const file = path.join(ROOT, "build", "test-edit.html");
fs.writeFileSync(file, html);

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "usage-hud-test-"));
let dom;
try { dom = execFileSync(CHROME, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--disable-background-networking", "--user-data-dir=" + profile, "--window-size=" + (process.env.HUD_TEST_WIDTH || "820") + ",780", "--virtual-time-budget=3000",
  "--dump-dom", "file://" + file,
], { encoding: "utf8", maxBuffer: 1 << 26, timeout: 15000, stdio: ["ignore", "pipe", "ignore"] });
} catch (error) {
  // Some Chrome versions finish the DOM dump only when terminated. A complete
  // assertion report is required; a timeout with no report remains a failure.
  if (error.code === "ETIMEDOUT" && /<div id="testout"[^>]*>\[/.test(error.stdout || "")) {
    dom = error.stdout;
    console.warn("Chrome needed termination after producing its assertion report.");
  } else { throw error; }
} finally { fs.rmSync(profile, { recursive: true, force: true }); }

const m = dom.match(/<div id="testout"[^>]*>(.*?)<\/div>/s);
if (!m) {
  console.error("test harness produced no output - the page probably threw early");
  process.exit(1);
}
const results = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
let failed = 0;
for (const r of results) {
  console.log((r.pass ? "  ok   " : "  FAIL ") + r.name + (r.detail ? "   [" + r.detail + "]" : ""));
  if (!r.pass) failed++;
}
console.log("");
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
