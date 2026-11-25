# The Mattermost Hub panel

The panel is a Claude Code mod (a function-hooks plugin) that ships inside the `mattermost-hub` plugin. It shows the hub, its workspaces and every router and worker session in a pane next to the chat. Row buttons stop, wake, restart, pin or unpin a session, and copy its tmux attach command. A workspace's **Select** button replaces the open Claude Code session with a new one in its folder.

| File | What it is |
| --- | --- |
| `.claude-plugin/plugin.json` | The manifest. `"types": "./types/index.d.ts"` names the state contract. |
| `.claude-plugin/marketplace.json` | Makes this repository a marketplace that lists the plugin at `./`. |
| `hooks/hooks.json` | `{"modules": ["./register.tsx"]}` |
| `hooks/register.tsx` | Wires up the hooks: `session.start`, `/mm`, auto-open and the pane's `ui.render`. |
| `hooks/panel.tsx` | Reads `status.json`, runs the poll, draws the pane and runs the CLI actions. |
| `hooks/panel.test.tsx` | Kit tests (`claude plugin test .`) that run against a fixture snapshot. |
| `hooks/tsconfig.json` | `tsc -p hooks`. It extends the types the engine lays in `.claude-plugin/types/`. |
| `types/index.d.ts` | The snapshot types and the `$.state` contract (`view`, `stoppedOpen`, `autoOpened`). |

## Loading it

From the repository root, in a terminal:

```bash
claude --plugin-dir /path/to/claude-mattermost-mods
```

In the desktop app, or anywhere a flag can't be passed, put the folder in `CLAUDE_CODE_PLUGIN_DIRS`, either in the shell or in the `env` block of `~/.claude/settings.json`. Several folders are separated by `:`.

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/claude-mattermost-mods" } }
```

An interactive session watches the folder, so saving a file reloads the mod. While it is loaded, the engine writes the API types to `.claude-plugin/types/`, which git ignores. After that, `tsc -p hooks` type-checks the mod. The root `tsconfig.json` belongs to the hub, which runs on Bun, and it excludes `hooks/` and `types/`.

To install from a GitHub repository instead:

```bash
claude plugin install mattermost-hub --marketplace <owner>/claude-mattermost-mods
```

Checks:

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

```bash
tsc -p hooks
```

`claude plugin test .` runs every `*.test.ts` and `*.test.tsx` file under the folder inside the mod sandbox, which can only import `claude-code` and the plugin's own files. A Bun test named `test/foo.test.ts` therefore fails there with `cannot import "bun:test"`. Name the hub's Bun tests `*.spec.ts`: `bun test` still finds them, and the plugin test runner skips them.

## What it does

- **`/mm`** opens the pane `mm-hub`, titled "Mattermost Hub". The command is registered with `immediate: true`, so it runs even mid-turn.
- **Unasked opening.** The pane opens without being asked once per session, and only where a surface says it docks panes (`viewport.isFullscreen === true`), so it shows up as a sidebar rather than taking over the screen. `session.start` has no viewport. The mod learns it from `session.attach` (remote clients) and from the `AbovePrompt` render (every surface), and the next poll opens the pane. The `autoOpened` atom outlives a reload, so editing the mod doesn't reopen a pane the person closed.
- **Poll.** Every 2 s from `session.start` (`$.clock.every`), the mod reads `status.json` with `$.fs.read`. It writes the `view` atom only when its JSON changed. That happens at least on every 5 s heartbeat and whenever the hub goes up or down. The atom has a shape tag (`view-1`), so a reload with a different `HubView` ignores the stored value.
- **Pane** (sized to `e.props.bodyColumns`):
  - Header: `● hub running vX · up 3h`, or `○ hub down` with the reason and a **Start hub** button. Then Mattermost `● connected as @bot` or `○ disconnected`, then `routers n/max · workers n/max`.
  - Per workspace: `▌name` (a personal workspace: `▌@user personal-<user id>`), then `#channel #channel · N repos` (for one the hub can't read, the channels and `⚠ the hub can't read …`, in `error`). Then the provider line, unless the workspace runs on the hub's own login alone: `provider backup · fallback · acme sign-in, back in 42m · bk: <why it is unusable>`. The first part is dim on the first provider of the chain, `warning` on a fallback, and `error` when no provider is usable (`· no usable provider`) or all are resting (`· all resting`). Then a **Select** button; on the workspace the session is in, it reads **New session** with `✓ selected` beside it.
  - Live sessions, routers first, then by most recent activity: `🧭`/`🛠️`, the label, the model, `🔐n`, `📌` and `👁️`. Below that the status (`busy`, `idle 12m · closes in 18m`, `starting`, `n queued`, and `on <provider>` while a session still runs on another provider than its workspace's active one), the summary, and the buttons Stop, Pin/Unpin, Restart (Restart now while one waits for the turn), Copy attach, and a `Thread` link to the first permalink.
  - Stopped and failed sessions go in a collapsible `▸ N stopped` group, one `StateFamily<boolean>` member per workspace name. Each row reads `stopped 2h ago (idle)` with Wake and Pin/Unpin buttons. An expanded group lists up to 20 rows, then `+N more`.
- **Status line** (`$.ui.status`): `mm ● 1🧭 1🛠️ · 🔐1`, with ` · offline` added while Mattermost is disconnected. It is cleared (set to `undefined`) while the hub is down.

Button keys are `select:<workspace>`, `stop:<key>`, `wake:<key>`, `restart:<key>`, `restart-now:<key>`, `pin:<key>`, `unpin:<key>`, `copy:<key>`, `stopped:<workspace>` and `start-hub`.

## The data contract

The hub writes the file; the panel only reads it. The file is `${MMHUB_STATE_DIR}/status.json` when that variable is set (a leading `~` is expanded). Otherwise it is `${CLAUDE_CONFIG_DIR ?? $HOME/.claude}/channels/mattermost-hub/status.json`. This is the same rule as the hub's `src/shared/paths.ts`. The mod reads the variables with `$.env.get` from the Claude Code process's environment, so the hub and the session must agree on them.

The hub writes the file atomically on every change, plus a heartbeat every 5 s. The panel counts the hub as **down** when the file is missing, isn't JSON, has `schema !== 1`, or has a `heartbeatAt` more than 15 s old.

```ts
type HubSnapshot = { schema: 1
  hub: { pid: number; version: string; startedAt: number; heartbeatAt: number; cliPath: string; bunBin: string; stateDir: string }
  mattermost: { connected: boolean; url: string; bot?: string }
  caps: { liveRouters: number; maxLiveRouters: number; liveWorkers: number; maxLiveWorkers: number }
  workspaces: { name: string; path: string; description?: string
    label?: string /* "@user": whose personal workspace it is */
    unreadable?: string /* why the hub can't read it: its repos and settings are not known then */
    channels: { id: string; name: string; permalink?: string }[]
    repos: { name: string; path: string }[]
    sessions: SessionSnapshot[]
    provider?: WorkspaceProvider }[] }
type WorkspaceProvider = { active: string; kind: ProviderKind | 'unknown'
  fallback: boolean /* active isn't the chain's first */; healthy: boolean /* false: none usable, or all resting */
  chain: { name: string; kind: ProviderKind | 'unknown'; coolingUntil?: number; reason?: string /* "auth: …" */; unusable?: string }[] }
type ProviderKind = 'default'|'login'|'oauth-token'|'api-key'|'gateway'|'bedrock'|'vertex'|'foundry'
type SessionSnapshot = { key: string /* ^(r|w)-[a-z0-9]+$ */; role: 'router'|'worker'; label: string; summary?: string
  tmux: string /* session name on `tmux -L mmhub` */; model: string
  status: 'starting'|'busy'|'idle'|'closing'|'stopped'|'resuming'|'failed'
  pinned: boolean; attached: boolean; lastActiveAt: number; closesAt?: number; closedAt?: number
  closeReason?: 'idle'|'cap'|'manual'|'exited'|'failed'; pendingPermissions: number; queuedTasks: number; threadPermalinks: string[]
  retryAt?: number; restartPending?: boolean; provider?: string /* live sessions: the provider it was launched with */ }
```

`types/index.d.ts` (panel side) and `src/shared/snapshot.ts` (hub side) are two copies of this shape. Change them together.

### The CLI the buttons run

- **Session ops.** The key must match `^(r|w)-[a-z0-9]+$`; anything else is refused with a toast and never reaches argv. The mod runs `$.process.run([hub.bunBin, hub.cliPath, 'session', op, key, '--json'])` with op `stop`, `wake`, `restart` (plus `--now` for Restart now), `pin` or `unpin`, and a 90 s timeout.
- **Start hub.** The mod runs `[bunBin ?? 'bun', cliPath ?? '<plugin root>/bin/mmhub', 'start', '--json']`, taking the paths from the last snapshot read (a stale one included) when there is one. The timeout is 60 s. When a hub process still answers but its heartbeat is older than 15 s (the pane shows it down), `mmhub start` stops it and starts a new one, so the button recovers that state too.
- **Output.** Both print one JSON line on stdout, `{"ok": boolean, "message": string}`, and exit 0 on success. The mod reads the last non-empty stdout line and shows `mm: <message>` (or `mm failed: <message>`) with `$.ui.toast`. If there is no JSON line, the toast falls back to stderr's last line, then to `exited <code>`. After each action the mod polls once more, so the pane catches up straight away.
- **Start hub goes through launchd** when the [agent](../README.md#the-launchd-agent-macos) is installed for this hub, which can take up to 40 s (launchd holds back a hub that ran only a moment ago).
- **`mmhub start` has to detach.** `$.process.run` reads the child's output to EOF, so a daemon that inherits the CLI's stdout or stderr holds the button for the full 60 s and then fails. Start the daemon detached, with its stdio pointed at `hub.log` or `/dev/null`, print the JSON line and exit.

### Select

Select swaps the open session for a new one in the workspace's folder. It runs three slash commands with `$.command.run`, not the hub's CLI, so the hub isn't involved:

1. `/clear` ends the conversation, which stays in its own folder's `/resume`. It goes first because `/cd` moves the conversation along.
2. `/cd <folder>` moves the session. The first time, Claude Code asks whether to trust the folder; on a no, the session stays where it was, cleared.
3. `/clear` again, inside: the session that was moved has neither the folder's CLAUDE.md nor its SessionStart hooks' context. After it, the first request is the same as for a `claude` started there. (Variables that the old folder's settings put in the environment stay for the life of the process.)

On the workspace the session is already in, it is one `/clear`. Slash commands wait for the running turn, and the trust question can stay open, so the press doesn't wait for them: a press is cut off after 10 s. A path that isn't one absolute line, or isn't a folder on this machine, is refused with a toast.

Only a terminal session has `/cd`. Where `$.command.list()` doesn't offer it (the desktop app, the SDK), the conversation is left alone and `cd '<folder>' && claude` goes on the clipboard.

**Copy attach** puts `tmux -L mmhub attach -t <tmux>` on the clipboard of the surface that was pressed (`$.ui.copy({ text, surface: press.surface })`).
