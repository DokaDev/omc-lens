# omc-lens

omc-lens is a visually enhanced statusline HUD for Claude Code, built on top of the OMC (oh-my-claudecode) data bridge. It renders rich session information across three lines using Nerd Font icons and 256-colour ANSI gradient bars. The renderer is registered as a `statusLine` command in Claude Code's `settings.json`, giving you a live, always-visible view of your session state.

<img width="750" alt="screenshot" src="https://github.com/user-attachments/assets/33ea972a-7798-4374-a44e-45b6e4152a61" />

## Features

- **Three-line layout**: identity bar (Line 1), context/token/cost bar (Line 2), and orchestration/rate-limit bar (Line 3)
- **Model identity segment**: active model name (opus / sonnet / haiku) with tier-specific 256-colour coding and Nerd Font icon
- **Extended thinking indicator**: visual flag when extended thinking is active
- **Permission approval alert**: prominent `APPROVE?` badge when a tool permission is pending
- **CWD and git status**: current directory basename, branch name, staged/modified/untracked counts, ahead/behind indicators
- **OMC version display**: installed OMC version; shows `(*newVersion)` when an update is available on GitHub (cached 6-hour fetch)
- **omc-lens update indicator**: appears in magenta only when a newer omc-lens release exists — hidden otherwise
- **Worktree**: active worktree shown in Line 1
- **20-block 256-colour gradient context bar**: cyan-to-red fill with embedded percentage text; `COMPRESS?` and `CRITICAL` warnings at 80 % and 90 %
- **Token usage**: input, output, session total, and reasoning token counts with compact K/M formatting
- **Session cost**: cumulative USD cost formatted to four decimal places
- **Tool, agent, and skill call counters**: wrench / robot / flash icons with running totals; last activated skill name
- **Background task count**: live count of active background tasks
- **Todo progress**: completed/total ratio with first in-progress item label (up to 30 characters)
- **Vim mode indicator**: INSERT vs NORMAL with distinct colours
- **Cache hit metrics**: per-request hit rate (`hr`), per-request efficiency (`ef`), and cumulative session hit rate (`cu`) with colour-coded thresholds (green ≥85%, yellow ≥60%, red <60%)
- **Rate-limit gauges**: per-window usage bars with 14-step colour gradient
- **Agent tree**: running sub-agents rendered as a box-drawing tree, up to four entries with overflow count
- **Crash-safe**: any rendering error falls back to a dim one-line message; Claude Code is never interrupted

## Requirements

- macOS or Linux
- Node.js 18 or later
- [OMC (oh-my-claudecode)](https://github.com/yeachan-heo/oh-my-claudecode) plugin installed in Claude Code
- A terminal configured with a [Nerd Font](https://www.nerdfonts.com/) (e.g. JetBrainsMono Nerd Font, FiraCode Nerd Font)
- 256-colour terminal support

## Installation

Inside Claude Code, run:

```
/plugin marketplace add https://github.com/DokaDev/omc-lens
/plugin install omc-lens@omc-lens
```

## Activation

After installation, run the setup command inside Claude Code:

```
/install-omc-lens
```

This will:

1. Check dependencies (Node.js, OMC plugin).
2. Create `~/.claude/hud/omc-lens.mjs` as a symlink to the plugin's `src/hud.mjs`.
3. Back up the current `statusLine` entry in `~/.claude/settings.json`.
4. Set `statusLine` to `node ~/.claude/hud/omc-lens.mjs`.

Restart Claude Code to activate the HUD. To revert, run `/uninstall-omc-lens`.

## Updating

```
/plugin marketplace update omc-lens
/plugin update omc-lens@omc-lens
/reload-plugins
```

Then re-run `/install-omc-lens` if the symlink path has changed.

## Uninstalling

To deactivate omc-lens and restore the previous statusline:

```
/uninstall-omc-lens
```

This removes the symlink and restores your backed-up `statusLine` value in `settings.json`. If no backup is found, the `statusLine` key is removed entirely so Claude Code falls back to its built-in default. Restart Claude Code for the change to take effect.

To remove the plugin entirely:

```
/plugin uninstall omc-lens@omc-lens
```

## How It Works

1. **Data collection** (`src/data/context.mjs`): `assembleContext()` reads the OMC state bridge (`src/data/omc-bridge.mjs`) to gather model info, token counts, cost, todos, agents, git status, rate-limit windows, and more.
2. **Rendering pipeline**:
   - `renderLine1(ctx)` — identity bar (model with version extraction, CWD, git, OMC version with update check, omc-lens update indicator)
   - `renderLine2(ctx)` — context gradient bar, token/cost/call counters, todos
   - `renderLine3(ctx)` — vim mode, orchestration flags (ralph/ultrawork/autopilot), rate limits, cache hit metrics (hr/ef/cu), session summary
   - `renderAgentTree(ctx)` — box-drawing tree of running sub-agents
3. **Composition** (`src/render/compose.mjs`): `composeOutput()` joins the lines, enforces terminal-width truncation, and appends any active warnings.
4. **Output**: the composed string is written to `process.stdout` and consumed by Claude Code's statusline renderer.

## Configuration

No configuration file is required in this release. Future versions may expose a `~/.claude/omc-lens.json` settings file for colour theme, bar width, and segment visibility toggles.

## License

MIT — see [LICENSE](./LICENSE).
