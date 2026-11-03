# Astra

All-in-one workspace: dashboard, vault search, OneDrive sync and markdown enhancements.

[![Version](https://img.shields.io/github/v/release/nightfall-yl/obsidian-astra?label=version)](https://github.com/nightfall-yl/obsidian-astra) | [![Obsidian](https://img.shields.io/badge/Obsidian-1.11.0%2B-purple)](https://obsidian.md) | [![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

English | [简体中文](README_zh-CN.md)

Astra is an Obsidian plugin that consolidates quick capture, task & project management, writing statistics, and a calendar into a single dashboard — plus vault-wide full-text search (Vault Search), OneDrive sync (Vault Sync), Minimal theme settings, and Markdown enhancements (forced view mode, a lightweight linter, and `` ```astra `` query blocks).

All data is stored locally as plain Markdown files. Except for the optional OneDrive sync, no external service or account is required.

Plugin ID: `astral-trek` (install directory: `.obsidian/plugins/astral-trek/`).

## Features

### Dashboard

#### Home

A persistent top bar shows: time-of-day greeting (customizable name), `vault · N notes · X words` stats, date/time/lunar date (refreshes every 30s), and home/settings buttons.

- **Quick Links** — Custom shortcuts in the top bar. Each link supports `label` + `icon` (Lucide icon name) + `url` (note path) or `action` (command ID, takes priority). Shows a placeholder when empty.

- **Writing Heatmap** — GitHub-green 52-week heatmap tracking recent writing activity. Four-level green gradient, empty cells for inactive days, today highlighted with edge glow. Click any active cell to view that day's notes.

- **Quick Capture (Flomo)** — Input box + send button, `Cmd/Ctrl + Enter` to submit. Content is appended to a single configured note file.

- **Daily Phrase** — Parses quotes from a configured note and shows one per day; prev/next arrows to browse, dice button for a random pick.

- **Tasks (Today)** — Daily tasks with overdue items pinned to top and priority sorting. Right-click menu for postpone/complete/skip; recurring tasks do not toggle status but advance their next reminder date.

- **Task Progress (Weekly)** — This week's task list + overdue reminders.

- **Project Stage Pipeline** — Stage columns (names and counts customizable in settings, 4–6 stages). Clicking a project row jumps to the full Project Board with that project selected.

- **Countdown** — Remaining days / weeks / completion percentage of the year (customizable event name and target date).

- **Recent Notes** — Persistent card at the end of the module grid.

Dashboard modules support **drag-to-reorder, drag-to-delete (trash icon in edit bar), card resize, and adding new cards from the "+ Add Card" menu**. Order, visibility, and size are persisted. On mobile, individual modules can be hidden in settings (Quick Links and Heatmap are always visible).

#### Quick Capture / All Memos

- **Waterfall timeline**, grouped by date.

- **Top bar search**: keyword, exclusion terms, `#tags`, `after:/before:/date:` date operators (debounced). Matching keywords highlighted.

- **View density toggle** (compact / relaxed).

- **Left sidebar**: notes / tags / days stats + preset filters (All, Pinned, Favorites, Today, This Week, To-Do, On This Day, Untagged, Has Images, Has Links) + hierarchical tag tree filter.

- **Pin / Favorite**: implemented via `#pinned` / `#favorite` tags.

- **Edit (incl. date/time modify)**, delete, right-click menu.

- **Export** current filtered results as Markdown / HTML / JSON to an `exports/` subdirectory next to the quick-capture file. Markdown export auto-opens preview.

#### Project Board

Left sidebar (drag-to-reorder, right-click delete, click stage to fast-forward), main panel with four tabs:

- **Gantt** — SVG timeline with day/week/month/quarter zoom, today line centered. Drag to change start/end dates, move tasks across projects, filter by status with multi-select. Drag the left/right edges of a time block to adjust duration.

- **List** — Column sorting, status filter, right-click menu, virtualized list scrolling.

- **Calendar** — Month view with task bars inside cells, drag to change due date.

- **Kanban** — To Do / In Progress / Blocked / Done / Cancelled, drag across columns to change status.

#### Calendar

Sidebar month view (position configurable in settings, left or right):

- **Word-count dots** — Up to 5 dots per day mapped from daily note word count (`wordsPerDot`, default 250).

- Click a date to open the daily note; creates one with confirmation if it doesn't exist (configurable).

- Date right-click menu: open / delete existing, or create new if absent.

- Today highlighting supported.

### Vault Search — Full-Text Search

A vault-wide search modal, recreating the omnisearch experience (UI only — no GPL code reused):

- **Entry points** — A persistent "Astra Search" ribbon button + the "Open full-text search" command (no default hotkey; bind your own in Settings → Hotkeys).

- **CJK-friendly** — minisearch engine + browser-native `Intl.Segmenter` Chinese tokenization (ICU word segmentation, zero external dependencies). Field weights match omnisearch defaults (filename / H1 / H2 / H3), with fuzzy and prefix matching.

- **Modal interactions** — `↑↓` / `Tab` to select, `Enter` to open, `Mod+Enter` for a new tab, `Alt+Enter` to insert a link, `Alt+↑↓` to browse persisted search history, `Mod+G` to toggle excerpts; IME composition Enter is never mis-triggered. Results show filename + `<mark>`-highlighted excerpts with hover preview.

- **Persistent index** — The index is saved to `search-index.json` in the plugin directory; after restart it restores in milliseconds instead of a full rebuild. On startup it reconciles by mtime in the background, healing files added/changed/removed externally (e.g. by sync) while Obsidian was closed.

- **Respects Obsidian settings** — Honors Obsidian's native "Excluded files" and "Simple search" options.

### Vault Sync — OneDrive Sync

Keep the entire vault in sync with OneDrive. The engine is ported from an upstream sync project and trimmed to OneDrive-only:

- **Authorization** — OAuth2 PKCE login; revoke access anytime in settings.

- **Sync directions** — Bidirectional (mirror) / Upload only (backup based on this vault) / Download only (pull from cloud), all including deletions. Conflicts resolve by keeping newer or larger; deletions go to the system trash or Obsidian `.trash`.

- **Sync scope** — `.obsidian` config directory (off by default), `bookmarks.json` syncable independently, `.trash` (off by default), underscore-prefixed hidden files (off by default), per-file size limit.

- **Safety guards** — Protection threshold: aborts the sync when the share of files to modify/delete exceeds the limit; optional password-based end-to-end encryption.

- **Triggers** — Manual (ribbon button / command), scheduled, delayed after startup, debounced on note save, remote-change detection — each independently configurable or disableable.

- **Status feedback** — Status bar shows relative time of last sync (auto-refresh every 30s) and live sync steps; the "Astra Sync" ribbon icon switches while syncing.

> **Data safety**: your Markdown files in the vault remain the single source of truth; Vault Sync is optional, with end-to-end encryption, a protection threshold, and revocable OAuth authorization.

### Markdown+

- **Forced View Mode** — Auto-set view mode (`obsidianUIMode` / `obsidianEditingMode`) per folder/file rule, with options to skip already-open files or files without frontmatter.

- **Linter Lite** — Auto-format on save with two built-in rules: "YAML timestamp" (maintains `date created` / `date modified`) and "line break between content lines" (trailing line-break markers for paragraphs, quotes, and list items). Supports folder ignores and applies diff-range replacement so your cursor and scroll position stay put while editing.

### Minimal Theme Settings

Graphical appearance settings for the Minimal theme (ported from obsidian-minimal-settings): color schemes, font size, multi-column images, sidebar shading, and more. Collapsed to a single "Show settings" toggle by default; flip it to reveal all items. Located in the Settings → Astra tab.

### ```astra Query Blocks

Write DQL queries in any note, rendered as tables / lists / task lists. Clause order matches Dataview (FROM → WHERE → SORT → LIMIT):

````markdown
```astra
TABLE status, due
FROM "Projects"
WHERE status != "done"
SORT due ASC
LIMIT 10
```
````

- **TABLE** — Dataview-style table; built-in `file.name/path/folder/link` fields + any frontmatter field, with `AS` aliases.

- **LIST** — File-link list with Dataview semantics (no field = file link; with field = "link: value"; `WITHOUT ID` = value only).

- **TASK** — Task list with checkable checkboxes that **write back to the source file** (atomic write + optimistic locking; zero writes with an inline notice if positioning fails). Hover shows source path and line number.

- **FROM** — `"path"` or `#tag` (including nested tags, case-insensitive); **WHERE** — `=` / `!=` and boolean form; **LIMIT N**.

## Commands & Entry Points

Ribbon buttons in the left sidebar:

| Ribbon | Action |
| --- | --- |
| **Astra Home** | Open the Astra dashboard. |
| **Astra Calendar** | Open the calendar view in the sidebar (can be disabled in settings). |
| **Astra Search** | Open the full-text search modal. |
| **Astra Sync** | Run Vault Sync now (icon switches while syncing). |

Command palette commands:

| Command | Action |
| --- | --- |
| **Open full-text search** | Open the vault-wide search modal (no default hotkey; bind your own in Settings → Hotkeys). |
| **Run Vault Sync now** | Trigger a OneDrive sync manually. |

## Settings

Settings are available both as an Obsidian plugin settings tab and via the gear icon in the dashboard header (identical content), organized into four tabs:

- **Astra** — General (greeting name, open dashboard on startup, startup behavior, blank/very-short threshold, excluded folders, cursor position), dashboard modules (projects folder, TODO scan folder, stage names, quick-capture file, daily-phrase file), calendar (sidebar position, word-count dots, week start, confirm before creating daily note), mobile module visibility, Minimal theme settings.

- **Markdown+** — Forced view mode rules, Linter Lite (YAML timestamp, line breaks between content, folder ignores).

- **Vault Search** — A single group of 7 options: excerpt display, highlight matches, fuzziness, jump to match, etc. (index scope and result weights are fixed to built-in defaults).

- **Vault Sync** — 4 groups: Status (authorization & last sync), General (direction & triggers), Scope (what to sync), Advanced (safety guards & encryption).

## Data Format

No database — everything is Markdown files in your vault, with Chinese frontmatter keys.

- **Quick capture entries** — Single file grouped by date: `## YYYY-MM-DD Day` headings, each followed by `- HH:MM content` list items. Multi-line content joins via indentation. Supports `#tags`, image/link auto-detection.

- **Projects** — A `projects/` folder containing `project-{name}.md` for project metadata.

- **Tasks** — `.md` files inside the projects folder (except `project-*.md`).

- **Daily nodes** — A `## Daily Nodes` list inside task bodies, format: `YYYY-MM-DD ✅/📝/⏭️ note` (✅ done / 📝 note / ⏭️ skipped).

Example task file:

```yaml
---
状态: 待办            # to-do / in-progress / blocked / done / cancelled
优先级: 重要且紧急     # urgent & important / important / urgent / neither
开始日期: 2026-01-01
截止日期: 2026-01-15
项目: MyProject
tags: ["任务"]
类型: 普通            # normal / recurring
# Optional: repeat rule, reminder, note, parent task, completion time, daily nodes
---
```

Project metadata `project-{name}.md`:

```yaml
---
项目名称: MyProject
项目类型: 阶段项目     # staged / non-staged
颜色: "#3b82f6"
tags: [配置]
描述: Project description
开始日期: 2026-01-01
结束日期: 2026-06-30
---
```

## Installation

Download the latest release assets (`main.js`, `manifest.json`, `styles.css`) from [GitHub Releases](https://github.com/nightfall-yl/obsidian-astra/releases/latest). Or build locally with `npm ci && npm run build` (outputs to repo root and `dist/`). Place into `<your-vault>/.obsidian/plugins/astral-trek/`, then run **Reload app without saving** from the Obsidian command palette (or restart Obsidian).

## License

[MIT](LICENSE)
