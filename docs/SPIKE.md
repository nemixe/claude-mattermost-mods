# Phase-0 spike results (Claude Code 2.1.322, 2026-11-12)

Run with `bun scripts/spike/run.ts [router|worker|all]` — real interactive `claude` sessions on
`tmux -L mmhub-spike`, a stub channel bridge (`scripts/spike/bridge.ts`) and a hook logger
(`scripts/spike/hook.ts`). Raw events land in `.spike/<ts>/events.jsonl`.

| Question | Result |
| --- | --- |
| `--dangerously-load-development-channels server:mmhub` with `--mcp-config … --strict-mcp-config` delivers channel events (SDK 1.32.2) | ✅ yes; one "Loading development channels" dialog per launch, answered by the shepherd |
| Router lockdown: `--tools Read,Grep,Glob --permission-mode dontAsk --allowedTools mcp__mmhub` | ✅ MCP `reply` callable without prompt; Read inside cwd works; Read outside the working dirs is **denied** ("denied because Claude Code is running in don't ask mode"); no write-capable tools listed |
| `CLAUDE.md` loads under `--setting-sources project,local` | ✅ from cwd (router) and from a parent folder (worker cwd `<ws>/.worktrees/w1`) |
| `SessionStart` hook `additionalContext` | ✅ applied at startup, **and refreshed on `--resume`** (new value seen) |
| Hook events for channel-triggered turns | ✅ `SessionStart(startup|resume)`, `Stop` after each turn, `SessionEnd` on exit, all with `session_id` on stdin; env vars from `tmux -e` reach the hook |
| `--resume <id>` keeps the same session id | ✅ |
| `/exit` via `tmux send-keys` | ✅ session ends cleanly within seconds, `SessionEnd` fires |
| Worker `acceptEdits` + `--add-dir <ws>/knowledge` | ✅ writes to knowledge/ without a prompt |
| Permission relay (`claude/channel/permission`) | ✅ `permission_request` for a Bash command outside the working dirs; answering `allow` via `notifications/claude/channel/permission` runs it. Read-only commands (`sleep`, `echo`) need no permission at all |
| Channel message arriving mid-turn | ⚠️ folded into the running turn (or handled right after). The model may **ignore** it as "not part of the original request" — worker prompt must say same-thread follow-ups are genuine instructions |
| Folder-trust dialog | not shown for folders under an already-trusted project; expected for new workspaces under `~/claude-workspaces` — shepherd answers it |

Decisions taken from this:
- Use `server:mmhub` from a generated `--mcp-config` (no plugin needed in spawned sessions).
- Routers: `dontAsk` + `--tools Read,Grep,Glob` (no `--restricted` needed).
- Changing context (repo map, worktrees, workers) goes through `SessionStart` `additionalContext`; the appended system-prompt file is written once per session.
- Hub-side queue only for workers' cross-thread tasks; same-thread messages go straight through.
