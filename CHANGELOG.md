# Changelog

## 2026-10-15
### Changed
- First public release, with a step-by-step setup guide in the README.

## 2026-10-06
### Added
- **History view** in the panel: week by week or month by month for any quantity of either provider, without adding anything to the layout. Opens from a new bar-chart button in the title bar, **Usage History…** in the right-click menu, or a click on any big number, sparkline or history list (on that value; a drag still moves the panel). Shows this period so far, last one and the average, the change on last week at the same point and an "on track for" figure, then **Bars** (with the average and the rest of the current period dashed) or **Overlay** (running totals laid over each other, Monday to Sunday or by day of the month: this, last, earlier and average), and a list with each period's change. Escape goes back; choices are remembered. Before this, week by week only existed as a component you had to find in the + menu.
- The collector sends `days`: daily totals per provider back to the first of the twelve weeks or the first of the month before last, whichever is earlier, which the overlay is drawn from.
- Week-by-week usage from the same usage history as the months: a **Last week** window (the previous Monday to Sunday) for every value and model breakdown, a **Last 12 weeks** chart span, and a **Per: Week** option on the history list (**week by week** in the + menu) showing 3, 6 or 12 weeks, each named by its Monday with the ISO week number on hover. Weeks that began before the history are lower bounds, like months. The collector now also sends `weeks` (twelve calendar weeks, this one last) next to `months`.

## 2026-10-01
### Added
- Month-by-month usage history in `~/.local/share/usage-hud/usage-history.json`: per-day token totals per model and provider, written from the ledger on every refresh and never shrunk, so past months survive the 45-day cache, pruned transcripts and a deleted cache. Months are priced with the current tables. The first run backfills from every log still on disk; months that began before the history are marked as lower bounds.
- **Last month** window for every value and model breakdown, a **Last 12 months** chart span (one bar per month), and a **month by month** component listing 3, 6 or 12 months with a bar each, for any quantity of either provider.

## 2026-09-28
### Added
- Saved configs: the editor's new **Saved** tab stores the current layout, appearance and refresh interval under a custom name, and loads or deletes them; the right-click menu's **Saved Configs** switches between them. Loading is undoable and never touches calibrated caps, hotkeys or pricing. Stored one file each in `~/.config/usage-hud/saved/`.

## 2026-09-23
### Changed
- The menu bar icon is off by default. Right-clicking the panel opens the same menu, and **Show Menu Bar Icon** in it brings the icon (and its `C · X` gauge title) back, persisted as `menuBarIcon`.
### Added
- Opening the app while it runs shows the panel and turns ghost mode off, so a hidden or click-through panel is recoverable without the menu bar icon or the hotkeys.
- Daily price feed: the collector downloads LiteLLM's community model price list at most once a day (config `pricingFeed`, `null` to disable). Models the bundled tables don't know yet are priced from it automatically instead of by a family guess, and the Claude and Codex alert banners say when a bundled price disagrees with the feed (**published price changed for …**) or a model is priced by estimate (**no published price for …**). The bundled tables stay authoritative; a failed download keeps the last good list.
- Published Codex prices for `gpt-6-sol` ($2 / $0.20 / $10) and `gpt-6-luna` ($0.10 / $0.01 / $0.50), so they price automatically instead of showing as partial.
### Fixed
- Claude cost overstated: Opus 5.5 had no entry and priced as Opus 5 ($5 / $25 instead of $4 / $20), and every model's cache reads were charged at 0.1× input although Fable 5.1 and Mythos 5.1 read at 0.025× and Opus 5.5 at 0.05×. The table now carries a per-model cache-read multiplier and Opus 5.5 fast mode ($8 / $40). Caps calibrated before this fix are in the old, inflated dollars; re-run `--calibrate`.

## 2026-09-21
### Fixed
- Two big numbers in a card header sat at different heights on a narrow panel: the header ran out of room, flex shrank the headlines, and the second caption ("this week") broke onto two lines and lifted its number. Header items now share the numbers' baseline, and the header measures itself after every update: when the numbers no longer fit side by side with their captions, each caption moves under its number, so both numbers stay on one row and level. The card's dot follows the name's baseline.

## 2026-09-18
### Changed
- The customization pickers follow one rule: every quantity can be shown over every window, and the list is the same for both providers. The Value picker names quantities only (cost, tokens, requests, cache hit rate...) and the Time period picker beside it offers Daily, Weekly, Monthly, the 5h block/window, the quota week and the last 7 days for every one of them; charts offer Daily, Weekly, Monthly, last 7 and last 14 days. Before, generated Daily-only entries sat next to leftover quota-window entries ("cost · quota week", "cost week fable", "tokens · rolling quota week", "requests 7d"), so which windows a value could take looked random and Monthly never appeared in the Value list.
- Registry ids are now `<provider>.<quantity>.<window>`, generated from three tables (quantities, windows, chart spans). The ids older layouts were saved with are aliases of the same entries, so existing configs keep working and show up in the editor as the window they always were instead of as a fourth ad-hoc option. The stat line's outline label names each value once with its window instead of repeating the full label.
- The collector keeps the records of a log the CLI has since deleted (Claude Code prunes transcripts after `cleanupPeriodDays`), so the cache is a ledger the monthly figures can rely on rather than a mirror of whatever files still exist. Records still age out after 45 days.
### Added
- Daily, Weekly and Monthly controls for every usage metric, model breakdown and activity chart, including each individual value in a stat line. Both providers share local calendar boundaries, with weeks starting on Monday.
- Monthly Codex totals, cache-hit rates, full token breakdowns and period-specific activity charts for both providers. Existing quota and rolling-window layouts keep their meanings.
- Sparklines for every quantity over the last 7 and last 14 days, and a rolling 7-day window for Codex values so "Last 7 days" means the same thing for both providers.
### Fixed
- Codex cost now uses published model prices automatically instead of requiring manual rates. Cached input gets its own discounted rate and reasoning is not counted twice. Estimates with unpriced models are explicitly marked as partial.
- Regression coverage for calendar boundaries, daylight-saving changes, model pricing, independent period selection, undo, persistence and narrow editor layouts.

## 2026-09-17
### Changed
- Customization now uses a bounded workspace with Layout and Appearance sections and a persistent live preview. A compact component outline and one selected-component inspector replace the expanded controls on every row.
- Done, section navigation, and Undo stay visible while long layouts and appearance options scroll independently. HUD width changes leave the editor steady.
- Native window sizing respects the usable display area and restores the configured HUD width when customization closes.
### Added
- A live HUD preview beside the settings, updating immediately for layout, text, appearance, and usage changes; narrow windows stack it above the settings. Preview minimisation does not change the saved HUD state.
- Labeled component settings, recent-edit undo, Escape to finish, and regression coverage for long layouts, small screens, appearance changes, and exact undo restoration.
- Deterministic offline test data and `node preview.mjs --sample`.


## 2026-09-16
### Fixed
- Every Claude gauge had been running on guesses since 14 Sep: the live quota fetch failed with "Claude Code login has no OAuth token" on every poll. Claude Code now files each MCP server login under the same `Claude Code-credentials` keychain service as the account login, and the unqualified `security find-generic-password -s` lookup returns whichever item macOS finds first, which is an `mcpOAuth`-only item carrying no `claudeAiOauth`. The lookup now tries the item filed under the current user first and falls back to the unqualified one, taking the first blob that actually holds a token. With no live reading the 5h gauge had silently degraded to a dollar-cap estimate (81% against the API's real 29%) while the weekly and Fable gauges stayed anchored to a two-day-old percentage, since their reset was still in the future and the reading still counted as applicable.
### Changed
- ☰ minimises to the gauge bars instead of the card headers, and `theme.collapsedMode` (`bars` | `headers` | `both`) picks what it keeps, so the old headers-only view is still a setting away. A limit actually being hit shows through; a stale-reading warning no longer camps over a minimised panel.
- The layout editor explains itself: a key to the controls while editing is on, a grey line under every component saying what it is and what its chosen option measures, pickers grouped by source instead of one flat thirty-item list, and a tooltip on every control and drawer setting.
- A component can now be dragged anywhere it makes sense, including from the top level into a side-by-side row and back out, with the container that would take the drop outlined during the drag. Dropping into a row also hit-tests on the axis that row is actually laid out on.
- Editing straightens side-by-side rows into an indented stack: at a third of the panel's width a nested component's pickers and hint line overlapped each other and left nothing to aim a drop at.
### Added
- ↑ ↓ on every component: one step within its list, out of the row at a row's edge, into the next card at a card's edge, greyed out when there is nowhere further to go. Dragging is no longer the only way to place something.
- Editor tests for the move buttons, for nesting by drag, and for what each minimised mode leaves on screen.

## 2026-09-07
### Fixed
- Codex model chips counted turns over the whole 45-day cache, so a model adopted today (GPT-6-Astra) sat under 1% behind six weeks of Sol and auto-review and never made the chip. Each Codex token delta is now attributed to the model the session was running (from its `turn_context`) and the chips show token share per window: `codex.models` is today, `codex.models.wk` this week, matching the Claude chips. Cache format bumped to v5, so the first run after updating re-reads the Codex logs once.

## 2026-09-02
### Fixed
- Claude gauges disagreed with the Claude app (8% / 34% / 38% against 34% / 5% / 7%). The dollar caps calibrated a day earlier no longer described the limit once Anthropic re-based the weekly counter, and the 5h gauge had no cap at all. Gauges now anchor to the API's real percentages (fetched live, or cached by `/usage`), plus the spend measured since; dollar caps are only the fallback.
- Fable 5.1 was priced at Opus rates: `claude-fable-5-1` was missing from the pricing table and fell to the unknown-model tier, halving its cost. Pricing now resolves a point release to its family's rate, and an unknown id by family name.
- The 5h session window was modelled as rolling. Anthropic's session limit is a 5-hour block that starts with the first request after the previous block expired; the panel now chains blocks forward from the last known block end (`/usage` or a 429), so the 5h spend and its reset match the app's "resets in".
- The weekly window's reset time comes from the `/usage` reading when there is one, instead of only the configured weekday and hour.
- Opacity was broken two ways. The slider thumb was disconnected from the panel: the stored value is a 0-1 fraction but the slider runs 40-100, and the init fed the raw fraction in, so the browser clamped the thumb to the minimum while the readout showed the true value; rebuilding the drawer (on any theme or density change) re-pinned it, and the next drag wrote back the mislabelled position. And "opacity" drove the whole window's `alphaValue`, which over a bright wallpaper let the desktop bleed through the vibrancy and washed the panel white — worse the lower it went. Opacity is now the panel's own dark veil (near-solid at 100%, translucent at 40%), the window stays fully opaque, and the thumb is scaled into slider units.
### Added
- Live quota fetch: the collector asks `api.anthropic.com/api/oauth/usage` (the call `/usage` makes) for the real percentages itself, at most every two minutes, using the OAuth token Claude Code keeps in the keychain (or `~/.claude/.credentials.json`). Nothing to run by hand; `claude.liveUsage: false` turns it off. The token is never stored or logged; failures (offline, expired login) surface as a banner instead of a stale gauge. The `/usage` cache in `~/.claude.json` remains a second source, used when newer.
- `node collect.mjs --calibrate` with no arguments calibrates from the latest quota reading. Caps are also derived automatically from every applicable reading (`auto` in the gauge note) and kept in the cache, so the gauges stay calibrated between readings.
- Metrics `claude.sessionReset` (time to the 5h block reset) and `claude.quotaAge` (time since `/usage`); a banner when the reading is over a day old, or when `/usage` has never been run and nothing is calibrated.
### Changed
- Gauge values are resolved once in the collector (`claude.gauges`) and shared by the panel and the menu bar title, instead of each computing its own.

## 2026-09-01
### Added
- usage-hud: floating always-on-top macOS panel showing Claude Code and Codex cost and quota, as a native NSPanel + WKWebView with no Electron or npm dependencies.
- Collector (`collect.mjs`) reading `~/.claude/projects` and `~/.codex/sessions` directly: exact Claude cost from token counts at published rates, real Codex quota percentages from the CLI's own `rate_limits` events, incremental byte-offset caching so a refresh costs ~40 ms against ~450 MB of logs.
- Fully declarative layout: every component is a config entry, with an in-panel editor (drag to reorder within and between cards, per-row metric pickers, hide/delete, add from a palette, card accent/order/visibility) that writes back to `~/.config/usage-hud/config.json`.
- Appearance drawer: light/dark/auto, three densities, width, opacity, corner radius, NSVisualEffectView material, refresh interval. Config file changes are picked up within two seconds without a restart.
- Metric registry of 32 values plus gauge, series, chip and banner registries; adding an entry exposes it in every editor picker. Bar and ring gauge styles.
- `--calibrate weekly=N fable=N session=N` converts a `/usage` reading into real dollar caps; `--default-config` prints the shipped layout.
- Menu bar item mirroring both headline gauges, with show/hide, edit layout, appearance, open config, ghost (click-through) mode, float-above-full-screen, and reset position.
- `preview.mjs` renders six UI variants with live data to standalone HTML for design iteration without rebuilding the app.

### Added
- `install.sh`: builds, installs to `~/Applications`, and registers a user LaunchAgent so the panel starts at login. `--uninstall` reverses it. Also a "Launch at Login" toggle in the menu bar menu.
- Global hotkeys via Carbon `RegisterEventHotKey` (no Accessibility permission needed): ⌥⌘U shows/hides the panel, ⌥⌘G toggles ghost mode. Rebindable under `hotkeys` in the config, applied without a restart; a combo another app already owns is reported as `unavailable` in the menu rather than failing silently.
- Config history: every write archives the previous version to `~/.config/usage-hud/history/` (newest 20), with "Undo Config Change" and "Show Config History" in the menu.
- `test.mjs`: drives the layout editor in headless Chrome — synthetic drags within a card, between cards, into the header zone, and emptying a card, plus delete and add — asserting the component count changes by exactly the expected amount.

### Fixed
- Claude quota gauges were wrong in three ways: they compared a rolling 7-day cost against the heaviest 7 days on record, which is not the limit; Claude's weekly limit is a fixed window with a scheduled reset, so pre-reset spend was being counted; and Fable's separate weekly bucket was lumped in with all models. Now modelled as a rolling 5h session window plus two fixed weekly windows, calibrated against `/usage` — reads 26% / 37% where `/usage` says 26% / 37%.
- Headline captions were stored literals, so changing a headline's metric left a stale label ("today" under a weekly figure). Captions now follow the metric, with an optional custom override.
- Width slider resized the panel mid-drag; because the panel is right-anchored that slid the slider out from under the cursor. Width now applies on release.
- Ghost mode could trap the panel: it makes the panel ignore the mouse, so the only way to turn it back off was the menu bar. It now ships with a keyboard escape (⌥⌘G) by default.
- A layout edit could silently delete components. The card header's item area was not a registered drop zone, so a component dragged into it left its previous parent and was never recorded anywhere; and reading the layout back out of the DOM trusted the DOM completely. Reading back now accounts for every component and puts anything unaccounted for back where it came from.
- Two instances could run at once (a launch-at-login start racing a manual open, or a rebuild during an edit), each holding its own copy of the layout in memory, so whichever saved last silently overwrote the other's work. A second instance now exits at startup.
- `collect.mjs` ran its main routine on import, so importing `DEFAULT_CONFIG` from it printed a full data dump.
- Claude requests were de-duplicated by `requestId`, keeping the first line seen. Claude Code writes one transcript line per content block of a single response (thinking / text / tool_use), and a few of those lines carry a partial usage snapshot before the complete one, so the first line could undercount. Now keyed on `message.id` — the identity of one billed API response — keeping the largest snapshot per id.
- Panel placement used `NSScreen.main`, which follows keyboard focus, so on a multi-display setup the panel could appear on a screen the user was not looking at. Placement is now on the primary screen, and any frame change is clamped to leave the panel substantially visible.
