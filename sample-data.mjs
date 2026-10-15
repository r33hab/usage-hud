// Deterministic, offline data for editor tests and `node preview.mjs --sample`.
import { DEFAULT_CONFIG } from './collect.mjs';

export function sampleData() {
  const now = Math.floor(Date.now() / 1000);
  const bin = { cost: 24.8, fableCost: 8.4, in: 1140000, out: 62000, cacheRead: 820000, cacheWrite: 180000, reqs: 43, tokens: 1202000, turns: 36, cached: 960000, reasoning: 24000, pricedTokens: 1202000, unpricedTokens: 0, unpricedModels: {}, models: [{ name: 'Model A', share: .72 }, { name: 'Model B', share: .28 }] };
  const scaled = factor => Object.fromEntries(Object.entries(structuredClone(bin)).map(([key, value]) => [key, typeof value === 'number' ? value * factor : value]));
  const calendar = () => ({
    periods: { daily: scaled(1), weekly: scaled(4), monthly: scaled(12) },
    activity: Object.fromEntries([['daily', 12, 1], ['weekly', 5, 4], ['monthly', 18, 12], ['7d', 7, 6], ['14d', 14, 12]].map(([period, count, factor]) => [period, Array.from({length: count}, (_, i) => ({start: now - (count - i - 1) * 3600, ...scaled(factor / count)}))])),
  });
  // The history: twelve calendar months, this one last. The oldest four with
  // data are 1.8, 2.6, 3.3 and 0.75 times this month's totals; the last of
  // those began before the history and is a lower bound.
  const months = () => Array.from({length: 12}, (_, i) => {
    const back = 11 - i, start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(1);
    start.setMonth(start.getMonth() - back);
    const factor = [12, 3.3 * 12, 2.6 * 12, 1.8 * 12, 0.75 * 12][back] || 0;
    return {start: Math.floor(+start / 1000), tracked: back <= 4, partial: back === 4, ...scaled(factor)};
  });
  // Twelve calendar weeks, this one last. The oldest three with data are 1.5,
  // 0.5 and 0.25 times this week's totals; the last of those began before the
  // history and is a lower bound.
  const weeks = () => Array.from({length: 12}, (_, i) => {
    const back = 11 - i, start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - (start.getDay() + 6) % 7 - 7 * back);
    const factor = [4, 1.5 * 4, 0.5 * 4, 0.25 * 4][back] || 0;
    return {start: Math.floor(+start / 1000), tracked: back <= 3, partial: back === 3, ...scaled(factor)};
  });
  // The days behind the history overlay, back to the first of the twelve
  // weeks: each week's totals spread over its days, heavier early in the week,
  // and this week's over the days so far, so the days add up to the weeks.
  const days = () => Array.from({length: 12}, (_, i) => 11 - i).flatMap(back => {
    const monday = new Date();
    monday.setHours(0, 0, 0, 0);
    monday.setDate(monday.getDate() - (monday.getDay() + 6) % 7 - 7 * back);
    const weights = [3, 4, 4, 3, 2, 1, 1].slice(0, back ? 7 : (new Date().getDay() + 6) % 7 + 1);
    const total = weights.reduce((a, b) => a + b);
    const factor = [4, 1.5 * 4, 0.5 * 4, 0.25 * 4][back] || 0;
    return weights.map((w, d) => {
      const start = new Date(monday);
      start.setDate(start.getDate() + d);
      const { models, unpricedModels, ...rest } = scaled(factor * w / total);
      return {start: Math.floor(+start / 1000), tracked: back <= 3, partial: back === 3, ...rest};
    });
  });
  const gauge = (pct, resetsAt) => ({ pct, resetsAt, source: 'usage', spend: 24.8 });
  return {
    ts: Date.now(), config: structuredClone(DEFAULT_CONFIG), meta: { elapsedMs: 34 },
    claude: {
      ...calendar(), months: months(), weeks: weeks(), days: days(),
      today: bin, month: bin, session: bin, weekly: bin, weeklyFable: bin, window7d: bin,
      lastActivity: now - 90, usage: { asOf: now, ageSec: 0 },
      limits: { caps: {}, resetsIn: 129600, sessionEnd: now + 7200 },
      gauges: { session: gauge(.26, now + 7200), weekly: gauge(.48, now + 129600), weeklyFable: gauge(.34, now + 129600) },
    },
    codex: {
      ...calendar(), months: months(), weeks: weeks(), days: days(),
      today: bin, week: bin, month: scaled(12), window: bin, window7d: bin, priced: true, lastActivity: now - 60, contextWindow: 200000,
      limits: { asOf: now, planType: 'Pro', primary: { usedPercent: 37, windowMinutes: 300, resetsAt: now + 9000 }, secondary: { usedPercent: 62, windowMinutes: 10080, resetsAt: now + 260000 } },
    },
  };
}
