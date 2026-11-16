# Mattermost Hub for Claude Code

A Claude Code plugin plus a small daemon that put Claude in your Mattermost the way
the official Telegram channel plugin does, but with many sessions:

- **One thread → one router, the only voice in it.** @mention the bot and the thread
  gets its own cheap, read-only **router** session (Sonnet by default). By default it acts
  as a **project manager**: it clarifies what you need, hands the real work to workers,
  checks their results and tells you only what matters (results, decisions you need to
  make, blockers), never the process. Its persona is adjustable (see [Router persona](#router-persona)).
- **Workspaces.** Each workspace is a folder with its own `CLAUDE.md`, a `knowledge/`
  folder and several repos. Bind any number of channels to a workspace.
- **A worker pool per workspace.** Routers pick the worker whose title/summary fits
  (across threads and channels) or create a new one (Opus by default). Each works in its
  own git worktree (`mm/<worker>` branch) and reports to the router, which passes on what
  matters (see [What gets posted](#what-gets-posted)).
- **Auto-close and resume.** Idle sessions close after 30 min (routers) / 120 min
  (workers) and resume with their memory (`claude --resume`) when needed again.
- **Interrupted work carries on.** A session that crashes, is killed, dies with the
  machine or hits an API error (overloaded, rate limit) resumes on its own and gets
  its unfinished task or message again. `restart` applies new settings without cutting
  off a running turn.
- **A panel in Claude Code** (`/mm`) listing workspaces and their live and stopped
  sessions, with Stop / Wake / Restart / Pin / Copy attach.

Every session is a real interactive `claude` in tmux: `tmux -L mmhub attach -t mmw-<id>`.

```
Mattermost ──WS+REST──► mmhub daemon ──tmux -L mmhub──► claude (router, Sonnet, read-only)  ×threads
                         access, bindings,               claude (worker, Opus, worktrees)   ×pool
                         lifecycle, permission relay      ▲ each with the mmhub channel bridge (MCP)
                         status.json ──► /mm panel        └ hooks report turns to the hub
```

## Requirements

Claude Code ≥ 2.1.322 (logged in), [Bun](https://bun.sh) ≥ 1.3, tmux ≥ 3, git, a
Mattermost bot account and its token.

## Install

```bash
git clone <this repo> ~/claude-mattermost-mods && cd ~/claude-mattermost-mods && bun install
```

In Claude Code: `/plugin marketplace add ~/claude-mattermost-mods`, then
`/plugin install mattermost-hub@claude-mattermost-mods`. That gives you the skills and
the `/mm` panel. The CLI is `bun ~/claude-mattermost-mods/bin/mmhub` (alias it to `mmhub`).

## Set up

1. `/mattermost-hub:configure <url> <bot-token>`, then `/mattermost-hub:configure path`
   (records PATH and absolute `claude`/`bun` for the daemon).
2. `/mattermost-hub:access allow @your-username` — owners start threads and approve
   permission prompts.
3. Optionally edit `~/claude-workspaces/workspace-template/` (see [Workspace template](#workspace-template)).
   Then `/mattermost-hub:workspace create acme "Acme web app"`, then
   `/mattermost-hub:workspace repo add acme ~/code/acme-web` (or a git URL), and
   `/mattermost-hub:workspace bind acme <team>/<channel>`. Edit the workspace's
   `CLAUDE.md`. (Or skip binding: mention the bot in a new channel and answer
   "which workspace?" in the thread.)
4. `mmhub start`, then `mmhub doctor` / `mmhub status`.

## Using it

- `@claude why does checkout fail on Safari?` → a router answers in the thread.
- `@claude fix it and add a test` → the router reacts 👀 and hands it to a worker; when
  the worker is done, the router posts the outcome (what changed, where, how to use it)
  and keeps the details for when you ask.
- Replies in the thread need no mention. Follow-ups reach the same worker.
- While a router or worker is working for a thread, the bot shows as **typing…** there
  (not while it waits for a 🔐 answer or an API-error retry).
- Worker permission prompts appear as 🔐 posts: owners reply `yes abcde` / `no abcde`
  or react ✅ / ❌. Pre-approve common commands in the workspace's `.claude/settings.json`.
- Owner commands: `!ws`, `!workers`, `!wake [id]`, `!stop`, `!restart [id|all|workers|routers] [now]`,
  `!pin [id]`, `!unpin [id]`, `!worker stop|rm <id>`, `!delegate <id|new> <task>`, `!help`.

## What gets posted

The router is the only voice in a thread. It posts what you need (answers, results, a
question that needs your decision, blockers) and leaves out the process: no worker ids,
task numbers, queue positions or "passed it on" notes, unless you ask. Hand-offs get a
👀 reaction instead of a post. Workers report to the router, not to the thread, so their
plans, progress notes and long reports never reach you directly; the router keeps them
and answers from them when you ask for details.

The hub itself posts only when someone has to act or wait: 🔐 permission prompts, work
that is on hold (a session that can't start or keeps crashing), a rate limit, API errors
that persist (the third try in a row), and an error it won't retry. Problems it fixes on
its own (a crash it resumes from, a short API blip, a slow resume) stay out of the thread;
**typing…** shows that work is going on. They are all in `mmhub logs`.

To have workers post in the thread themselves (under a `🛠 <title>` header) instead, set
`"workerReports": "thread"` in `config.json`. The router then adds only what they leave out.
Either way the change reaches running sessions at `mmhub session restart all`.

## Answering without a mention (Laya)

By default a post must @mention the bot to start a thread, and every reply in the bot's
threads reaches the thread's router. A workspace can instead let
[Laya](https://ollama.com/library/laya) decide which replies are for the bot. Laya is a
small decision model (421M, Apache-2.0) that runs locally in Ollama:

```bash
ollama pull laya
```

```bash
mmhub ws trigger <workspace> laya
```

The second command also writes starter rules to the workspace's `TRIGGER.md`. From then
on, the bot **follows** each thread it is @mentioned in:

- **Mention → followed.** A mention starts the thread as usual (or reaches its router),
  and the bot follows it from then on.
- **While followed,** each reply without a mention goes to Laya, and reaches the router
  only when Laya judges it meant for the bot. The next message that does get through
  tells the router how many it didn't get (`fetch_thread` shows them).
- **Done → unfollowed.** When the request is done (the result is posted, and nothing waits
  on the person or a worker), the router calls `unfollow`. The hub refuses that while a
  worker still has work for the thread. From then on, replies without a mention are
  ignored, without asking Laya.
- **A new mention follows the thread again.** Owners can also switch by hand with
  `!unfollow` and `!follow` in the thread.

Posts outside the bot's threads still need a mention. DMs are never judged: every DM from
an owner reaches the bot, without a mention, and there is nothing to follow or unfollow.

Laya sees the new reply and up to 10 posts before it in the thread, clipped to fit its
512-token window, and judges who the reply is for.
The rules in `TRIGGER.md` correct it. They are an `## Answer` list and a `## Don't answer`
list, one rule per line, at most 24 rules of 150 characters. Laya checks each rule on its
own, and a rule decides only when Laya is sure it describes the post (`ruleThreshold`,
0.85). A sure "don't answer" rule wins. Specific rules work ("Lunch plans", "Thanks and
small talk"); vague ones ("anything about work") change nothing. On sample chats it
decided 12 of 13 correctly, in about 0.1 s per post.

The rules learn. When someone says the bot answered something that wasn't for it, or
missed something that was, the router has a worker change the rules with the
`trigger_rules` tool. Owners can also edit `TRIGGER.md` by hand. Changes apply to the
next post.

A mention always works and skips Laya. If Laya is down or slow (5 s), replies in
followed threads go to the router as usual; `mmhub doctor` shows whether Laya is ready. The `laya` model is English-only. For other languages, set
`"laya": {"model": "laya:322m-multilingual-bf16"}` in `config.json` (after
`ollama pull laya:322m-multilingual-bf16`), then run `mmhub reload`.

## Other workspaces and DMs

A router or worker can ask another workspace, through that workspace's router:

- `message_workspace(workspace, text)` posts **📨 Request from workspace A** in a channel
  bound to the other workspace (O/P channels first) and gives that thread a router of
  its own. The router treats it like a person's request: it answers itself or delegates
  to its workers. Whatever that workspace's sessions post in the thread goes back to the
  asker: a router gets it as a message, a worker as work for the thread it was busy on.
  Follow-ups use `request_id`. Everything stays visible in the channel.
- `send_dm(user, text)` DMs an **owner** (`access.json` `allowFrom`) from the bot; the
  owner's replies in that DM thread go back to the session. Others can't be DMed: the
  hub takes DM replies from owners only.
- `list_workspaces` shows the other workspaces, which of them take requests, and the
  session's open requests and DMs.

Guards: a workspace takes requests from every workspace unless its `workspace.json` sets
`acceptFrom` (`["ops", "web"]`; `[]` takes none). A request never goes back into a
workspace it came through, and passes through at most two workspaces. Each session opens
at most 10 requests or DMs an hour, and each one carries at most 60 messages. Running
sessions get these tools at `mmhub session restart all`.

## Router persona

How routers work with people is a short text added to their instructions. The first
one found wins:

1. `<workspace>/ROUTER.md`: that workspace's own persona (put one in
   `workspace-template/` and every new workspace gets a copy; `{{name}}` works there too).
2. `routerPersona` in `config.json`: for every workspace without a `ROUTER.md`.
3. Built in: a project manager. It treats the thread's people as the client, asks focused
   questions when scope or "done" is unclear, splits work into tasks for workers, tells
   the client what matters (not the process), checks worker results against the request
   and closes the loop.

```json
{ "routerPersona": "Act like a project manager that helps the client get whatever the task needs finished." }
```

`mmhub ws show <name>` prints the persona a workspace uses and where it comes from. A
change reaches new routers right away and running ones at their next restart:
`mmhub session restart routers`. Claude Code fixes a session's system prompt when the
session is created, so the hub also re-sends the current persona at every start and
resume. The persona shapes tone and approach. Routers stay read-only, still delegate
every change and keep to [what gets posted](#what-gets-posted).

## Workspace template

`<workspacesDir>/workspace-template/` (by default `~/claude-workspaces/workspace-template/`)
is created the first time the hub or `mmhub` uses the workspaces folder. Every **new**
workspace starts as a copy of it — edit it once to reuse your `CLAUDE.md`, `knowledge/`
notes, `.claude/settings.json` permission rules, `.mcp.json` servers or any other files:

- `{{name}}` and `{{description}}` in text files become the new workspace's values.
- Its `workspace.json` holds default settings for new workspaces (e.g. `workerModel`,
  `idleMinutes`, `baseRef`); `name`, `description` and `repos` there are ignored.
- Not copied: `_TEMPLATE.md` (its own notes), `workspace.json`, `repos/`, `.worktrees/`, `inbox/`, `.git`.
- Existing workspaces are never changed, and once the template exists the hub never
  re-adds files you deleted from it. `workspace-template` is a reserved name.
- `mmhub ws template` prints its path.

## CLI

```
mmhub start | stop | status [--json] | logs [-n N] [-f] | doctor | reload
mmhub session <stop|wake|pin|unpin> <key> [--json]     # {"ok":bool,"message":string}
mmhub session restart <key|all|workers|routers> [--now] # after the current turn, or right away
mmhub ws list | create <name> [desc] | bind <ws> <channel-id> | unbind <channel-id> | show <name> | template
mmhub repo add <ws> <path|git-url> [--name n] | rm <ws> <name>
mmhub lookup user <username> | lookup channel <team> <channel>
mmhub agent install | uninstall                         # macOS: start the hub at login (launchd)
mmhub provider list | add <name> <kind> [--env K=V]… | login <name> | secret <name> <VAR> | check <name>
mmhub provider use <ws|--hub> <name>… | use <ws> --inherit | reset <name> | rm <name> [--purge]
```

## Configuration

`~/.claude/channels/mattermost-hub/` (override with `MMHUB_STATE_DIR`):
`.env` (URL, token), `access.json` (see [ACCESS.md](ACCESS.md)), `config.json`,
`bindings.json`, `hub.db`, `status.json`, `hub.log`, `sessions/<key>/` (generated
launch files), `providers.json` and `providers/<name>/` (provider logins and secrets,
0700/0600).

`config.json` keys (defaults): `workspacesDir` (`~/claude-workspaces`),
`routerModel` (`sonnet`), `workerModel` (`opus`), `routerPersona` (built-in project manager), `routerArgs` (`["--effort","low"]`),
`workerArgs`, `workerPermissionMode` (`acceptEdits`), `workerReports` (`router`: workers report
to the router; `thread`: they post in the thread), `idleMinutes` (`{router:30, worker:120}`,
0 = never), `maxLiveRouters` (6), `maxLiveWorkers` (4), `maxWorkersPerWorkspace` (6),
`announceClose`, `busyWatchdogMinutes` (30), `routerAutocompact`, `claudeBin`, `bunBin`,
`gitBin`, `path`, `tmuxSocket` (`mmhub`), `providers` (`["default"]`),
`providerCooldownMinutes` (`{auth:60, quota:60, rate_limit:10, errors:15, channels:360}`),
`trigger` (`mention`; or `laya`, see [above](#answering-without-a-mention-laya)), `laya`
(`{url: "http://127.0.0.1:11434", model: "laya", threshold: 0.5, ruleThreshold: 0.85, timeoutMs: 5000, messages: 10}`).
A workspace's `workspace.json` can override models, permission mode, idle minutes and
`providers` and `trigger`, and sets which workspaces may ask it (`acceptFrom`,
[above](#other-workspaces-and-dms)).

## Providers and fallback

Each workspace can run its sessions on its own Claude Code login or key, with
fallbacks: a *chain* of providers, from `workspace.json` `providers`, else
config.json `providers`, else `default` (the hub's own environment and login). `hub`
in a workspace's chain splices in the hub-wide one.

| kind | how claude gets it |
| --- | --- |
| `login` | its own `CLAUDE_CONFIG_DIR` (`<state>/providers/<name>/config`), signed in by the user: `mmhub provider login <name>` prints `CLAUDE_CONFIG_DIR=… claude`, then `/login`. Its `projects/` links to the hub's, so `--resume` finds transcripts across providers |
| `oauth-token` | `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) |
| `api-key` | `apiKeyHelper` reading the key file (an env key would stop the session at Claude Code's "custom API key" dialog) |
| `gateway` | `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` |
| `bedrock` / `vertex` / `foundry` | `CLAUDE_CODE_USE_*` and the cloud settings. Claude Code (2.1.325) has no channels on these, so the hub skips them unless added with `--channels` |

Secrets are typed by the user (`mmhub provider secret <name> <VAR>`, hidden input)
into 0600 files under the 0700 state dir. A non-default launch runs
`/bin/sh -c '<unset inherited provider vars>; . <0600 env file>; rm it; exec claude …'`,
so no secret is in argv, `status.json`, the log or a post (StopFailure text is redacted too).

A turn that fails on sign-in, a usage/credit limit or a rate limit — or on other API
errors once the retries below gave up — and a start that shows a login screen or "channels
not available", rest that provider (cooldown per kind, doubled for each failure in a row,
at most 24 h; a usage limit's reset time when the error gives one). The workspace's
sessions then restart on the next usable, rested provider with `--resume`, the cut-off
work is re-delivered, and the thread gets one ⇄ post. When the rest ends they move back
(within a minute; busy ones after their turn). Prompt-too-long, invalid request and
model-not-found never switch. `!ws`, `mmhub status` and the panel show each workspace's
active provider and whether it is a fallback; `mmhub provider reset <name>` tries a
fixed one again now. Setup steps: `/mattermost-hub:configure providers`.

## How sessions are launched

| | router | worker |
| --- | --- | --- |
| cwd | `<ws>` | `<ws>/.worktrees/<id>` (still loads `<ws>/CLAUDE.md`) |
| model | `routerModel` + `--effort low` | `workerModel` |
| tools | `--tools Read,Grep,Glob`, `--permission-mode dontAsk` | default tools, `workerPermissionMode` |
| extra dirs | repos outside the workspace | `knowledge/`, `inbox/` |
| always | `--mcp-config` (bridge `mmhub` + workspace `.mcp.json`) `--strict-mcp-config`, generated `--settings` (hooks + workspace settings), `--setting-sources project,local`, `--append-system-prompt-file`, `--dangerously-load-development-channels server:mmhub` | same |

User-level plugins and settings don't load in spawned sessions (`--setting-sources
project,local`), so another channel plugin can't grab them. Spike findings behind these
choices: [docs/SPIKE.md](docs/SPIKE.md).

## Lifecycle

`starting → busy ⇄ idle → closing → stopped → resuming → …` (and `failed`).
The reaper (every 60 s) closes idle sessions past their threshold, never one that is
busy, pinned, attached in tmux, waiting on a 🔐 prompt or holding a task. Closing sends
`/exit`, then kills after 15 s. Caps close the least recently used idle session; when
nothing can give way, work waits (`delegate` reports `waiting_for_slot`). Resuming
checks the transcript first and falls back to a fresh session (the router is told to
re-read the thread). `mmhub stop` leaves sessions running; the next `mmhub start`
adopts them.

**Sleep.** Bun timers pending while macOS sleeps can stay stuck after it wakes (seen
with Bun 1.3.14 after a hibernate: no heartbeat, no reaper, no Mattermost ping, while
the hub still answered `mmhub`). So the hub also takes a tick every 5 s from a child
`sh` (`while sleep 5; do echo; done`), plain I/O that keeps working. After a gap of
more than 30 s between ticks, or when its own timers go quiet, it re-arms its timers
and scheduled retries, checks busy sessions' screens, and opens a new Mattermost
socket, which catches up on posts missed meanwhile. A hub that still has no heartbeat
(`mmhub status` warns; the panel shows it down) is restarted by `mmhub start` or the
panel's **Start hub**.

**Interruptions.** Work a session was given stays in `hub.db` until the turn that
handles it ends: worker tasks, and router messages (the router inbox). If the turn
doesn't end cleanly, the work goes back as *interrupted* and is delivered again, with
a note telling the session to check what it already did:

| what happened | what the hub does |
| --- | --- |
| the process crashed or was killed (`kill -9`, OOM) | noticed within seconds (its bridge drops and the tmux session is gone); resumes it (`--resume`) and re-delivers, without a post. At most 2 automatic restarts per 10 min, then `failed` and a ⚠️ post |
| the machine restarted / sessions died while the hub was down | at `mmhub start`: resume and re-deliver, without a post |
| the hub restarted while a turn ran | the session is adopted; the turn's Stop hook is checked against the screen |
| the turn ended with an API error (StopFailure) | overloaded / 5xx / network: retry after 20 s, 1 m, 3 m, 10 m (a ⚠️ post only from the third try). Rate limit: 5 m, 15 m, 30 m, then hourly (≈5 h), with one ⏸ post. Output limit: once, quietly. Invalid request: no retry, a ⚠️ post. Sign-in, usage/credit limits, rate limits, and errors that outlast these retries move the work to the workspace's next provider when it has one ([above](#providers-and-fallback)); otherwise sign-in errors aren't retried (a ⚠️ post) and usage limits wait like rate limits. New work for it waits for the retry; `!wake <id>` retries now |
| an owner stopped it (`Stop`, `!stop`, `!worker stop`) | it stays stopped: its unfinished work waits for the next message, delegate or wake |

**Restart** (`mmhub session restart <key>`, `!restart`, the panel's **Restart**) relaunches
a session with the current settings (config, workspace `CLAUDE.md`, permission mode)
and the same conversation. It happens right away if the session is idle, otherwise
**after its current turn ends** — the work in progress is never cut off, and the status
shows `restart after this turn` meanwhile. Messages and tasks that arrive meanwhile wait
for the restarted session, so they get the new settings. `--now` / `!restart <id> now` / **Restart now**
interrupts it instead; the cut-off work is re-delivered. `restart all|workers|routers`
does every live session (e.g. after editing `config.json` and `mmhub reload`).

## Development

```bash
bun test            # hub tests in test/ (inbound table, lifecycle, providers, hub, …)
bun run typecheck
claude plugin test . # the panel mod's tests (hooks/*.test.tsx); tsc -p hooks type-checks it
bun scripts/e2e.ts  # real hub + real claude sessions against an in-memory Mattermost
claude plugin validate .
```
