# my-pi

A collection of [pi](https://pi.dev) extensions for an enhanced coding experience.

![Screenshot](https://github.com/user-attachments/assets/e8766ffd-3ff5-474b-a876-3b8f78bfd069)

## Quick Start

### Install with pi (recommended)

```bash
pi install git:git@github.com:Narcissus153/my-pi
```

(`git:github.com/Narcissus153/my-pi` is equivalent.) pi clones the repo into `~/.pi/agent/git/github.com/Narcissus153/my-pi` and records the source in your `settings.json` (`packages`). The extensions listed in the package manifest (`package.json` → `pi.extensions`) are loaded on the next startup — no manual copying, and **no filename conflicts**: the package lives in its own directory, fully separate from `~/.pi/agent/extensions/`.

Then reload pi:

```
/reload
```

Update later with `pi update` (all packages) or `pi update git:git@github.com:Narcissus153/my-pi`.

How it shows up in pi:

- `pi list` → the source string you installed (`git:git@github.com:Narcissus153/my-pi`) with install path `~/.pi/agent/git/github.com/Narcissus153/my-pi`
- loaded-resources panel (compact labels) → `Narcissus153/my-pi:editor.ts`, `Narcissus153/my-pi:status`, `Narcissus153/my-pi:diff.ts`, `Narcissus153/my-pi:ask.ts`

> [!NOTE]
> The git clone is managed by pi — updating runs `git clean -fdx` + `git pull`, so **don't edit files inside `~/.pi/agent/git/`**. Keep personal customizations in `~/.pi/agent/extensions/` (loaded alongside packages).

### Legacy — migrating from manual setup

Previously this collection was installed by copying files into `~/.pi/agent/extensions/`. To migrate to the recommended install:

```bash
pi install git:git@github.com:Narcissus153/my-pi
```

Then remove the manual copies from `~/.pi/agent/extensions/` (the ones that exist in the package), and run `/reload`.

> [!WARNING]
> If you keep both, the same extensions load twice — duplicate patches, first-wins tool registration.

<details>
<summary>Archived: old manual setup (deprecated — for reference only)</summary>

```bash
git clone git@github.com:Narcissus153/my-pi.git /tmp/pi-extensions
cp -r /tmp/pi-extensions/*.ts ~/.pi/agent/extensions/
cp -r /tmp/pi-extensions/status/ ~/.pi/agent/extensions/status/
```


> [!WARNING]
> Check for filename conflicts. If you already have an extension with the same name in `~/.pi/agent/extensions`, **rename the incoming files** (e.g., `collapse-tools.new.ts`) rather than overwriting your existing ones.

</details>

## Extensions

### status

A comprehensive status bar suite with multiple modules:

| Module | Description |
|--------|-------------|
| **index.ts** | Main extension entry point, orchestrates all status modules |
| **header.ts** | Rich status header above the editor showing model, working directory + git branch, token statistics, context usage, generation speed, and TTFT |
| **git.ts** | Git status detection — branch name, ahead/behind counts, staged/modified/deleted/conflicted/untracked file counts |
| **tps.ts** | Token speed engine — real-time TPS estimation during streaming, accurate TPS after completion, TTFT measurement |
| **title.ts** | Animated terminal title with a braille spinner during agent activity |
| **statusline.ts** | `/statusline` command for interactive configuration of which items appear in the header |

**Files:** `status/index.ts`, `status/header.ts`, `status/git.ts`, `status/tps.ts`, `status/title.ts`, `status/statusline.ts`

---

### editor

![editor](https://github.com/user-attachments/assets/37fdd8a3-f924-4829-a4eb-ad9b2f42c187)

- **Composer** — codex-style input area with a bold `❯` prompt (highlighted in `!bash` mode)

**File:** `editor.ts`

---

### request-logger

Logs every provider request to `~/.pi/agent/requests/<session>.request.log` — HTTP status, headers, token counts, model info — with sensitive query parameters sanitized.

**File:** `request-logger.ts`

---

### shortcuts

`Ctrl+Shift+C` copies the current editor content to the system clipboard.

**File:** `shortcuts.ts`

---

### diff

Overrides Pi's `edit` and `write` renderers while delegating file mutation to
Pi's native tools. Changed files show Shiki syntax highlighting, word-level
change emphasis, and an adaptive layout: wide terminals use split `old/new`
view, while narrow terminals use unified view. The first-phase defaults are
`github-dark`, a split threshold of `150` columns, and `60` code columns per
side.

After installing or updating the package, restart Pi or run `/reload`. To
verify the renderer, edit an existing TypeScript file with multiple changed
lines; a new file or unchanged write does not produce a comparable file Diff.

**File:** `diff.ts` (runtime dependency: `@pi-archimedes/diff@2.0.1`)

---

### ask

Registers a model-callable structured question in interactive TUI sessions. Each
ordinary user prompt can open at most one bounded question. Single-select is the
default; compatible choices can use explicit multi-select submission. Options
support a recommended marker, Markdown context, per-option notes, and an
automatic `Other` response.

Ask is input transport only. Its answer is a tool result, not a subsequent user
message, so it cannot approve task creation or start, implementation, commits,
pushes, publication, settings, active-package updates, destructive actions, or
other external-state changes. Load-bearing workflow decisions still belong in
the owning Trellis artifact.

Ask is registered only in TUI mode and is absent from RPC, JSON, and print tool
registries. It adds no Archimedes Ask/Core dependency, notification bus, child
process, socket, or subagent routing.

**File:** `ask.ts`
