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
- **Scheduled jobs.** "Every weekday at 9, check the alerts": at set times the hub
  opens a thread and gives the workspace's router the instruction, so recurring work
  runs without anyone posting (see [Scheduled jobs](#scheduled-jobs)).
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
   permission prompts. `/mattermost-hub:access allow *` makes every person an owner
   (bots excluded; see [ACCESS.md](ACCESS.md)).
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
- `@claude recap the issues reported in <link to a thread> as a table`, or a question
  about a channel or past discussion → the bot reads Mattermost for you: a thread from
  its link (or any post's), a channel's latest posts, a search, the channels it is in.
  It reads for whoever asked: only channels that person is a member of, besides its own
  thread's and its workspace's bound channels, so nobody can use it to look into a
  channel they aren't in. What it reads it may quote in the thread you asked in, as if
  you had pasted it there. The bot itself can read public channels of its teams, but
  private channels, DMs and group messages only when it is a member, and search covers
  only channels it is a member of.
- `@claude fill in the rekap tab of <link to a Google Sheet>` → a worker opens it. Routers
  only read Mattermost and the workspace's files, with no logins, so anything behind an
  account (a sheet, a dashboard, an API) goes to a worker, which has the machine's
  accounts and skills. Each router's context lists the skills workers have (the
  machine's `~/.claude/skills` and the workspace's `.claude/skills`, with their
  descriptions), so it knows that, for example, `gws-access` opens Google Sheets as the
  bot. It never tells you something can't be done or accessed before a worker has tried.
- `@claude introduce yourself to the channel` → the router starts a new thread: a new
  top-level post in this thread's channel, or another channel bound to the same
  workspace that you are a member of. The new thread gets a router of its own, which
  starts with the first reply there and is told what was posted, for whom and from which
  thread; the router you asked stays in your thread. Only when a person asks, at most 5
  an hour per thread.
- The bot never hands work to another AI agent on its own: not to another bot on the
  server, such as Hermes, and not to another agent's CLI on the machine. Two checks
  enforce it, and both let it through when a person in the thread (or the scheduled job
  it runs) named that agent: `@claude ask hermes for the nightly numbers` is fine.
  - A post that @mentions another bot is refused.
  - Every shell command a worker runs passes the hub first (a `PreToolUse` hook): one
    that runs another agent's command (`hermes`, `codex`, `gemini`, … in `config.json`
    `otherAgents`; `[]` allows them all) is denied, also in the background (`nohup`,
    `&`, `tmux`, `bash -c`, `npx`). An agent's name as an argument, such as in a commit
    message, doesn't count. It can't see an agent reached in other ways, such as its
    HTTP API.
- Thanks, or a bare "ok", gets a 🙏 reaction rather than a reply. Which replies reach the
  bot at all depends on the workspace's trigger: with `laya` or `openrouter`, thanks
  reach it only right after its own post.
- While a router or worker is working for a thread, the bot shows as **typing…** there:
  while the session runs, and while work it left running in the background goes on (a
  command run in the background, an async agent, a Monitor watch: its turn ended, the
  work didn't). Not while it starts up, while Laya or OpenRouter judges a reply, or while
  it waits for a 🔐 answer or an API-error retry. The hub reads that work from the
  session's transcript; when it ends, the turn Claude Code starts for it shows as
  typing too. Meanwhile the session isn't closed for being idle, cleaned up or evicted
  (`mmhub status` shows `⚙ 1 in background`).
- Worker permission prompts appear as 🔐 posts: owners reply `yes abcde` / `no abcde`
  or react ✅ / ❌. Pre-approve common commands in the workspace's `.claude/settings.json`.
- **DM the bot** → your own workspace. The first DM from a chat that isn't connected to a
  workspace creates `personal-<your user id>` from the [template](#workspace-template),
  binds the chat to it and starts the thread there, without asking "which workspace?".
  Later DMs go to the same workspace; add repos to it like to any other
  (`mmhub repo add personal-<id> …`). A chat bound to another workspace stays there
  (`mmhub ws bind <ws> <dm-channel-id>`). `personalWorkspaces: false` in `config.json`
  brings back the question.
- `@claude every weekday at 9, check the alerts dashboard and post anything red` (an
  owner) → a scheduled job; each run opens its own thread ([Scheduled jobs](#scheduled-jobs)).
- `@claude add ~/code/billing to this workspace` or `@claude add
  https://github.com/acme/billing.git` (an owner) → the router adds the repo, like
  `mmhub repo add`. A git URL is cloned into the workspace's `repos/` with this machine's
  git login (never waiting on a password prompt; a clone over 2.5 minutes goes on, and the
  router says when it's done). A folder outside the workspace folder needs a restart to be
  read: the workspace's live routers restart gracefully (the asking one after its turn,
  with its memory), and its workers too when the folder isn't a git repo. Not a folder
  with the hub's state, Claude Code's config or `~/.ssh` in it or around it, the folder of
  every workspace, or another workspace's folder.
- Owner commands: `!ws`, `!workers`, `!wake [id]`, `!stop`, `!restart [id|all|workers|routers] [now]`,
  `!pin [id]`, `!unpin [id]`, `!worker stop|rm <id>`, `!delegate <id|new> <task>`,
  `!cron [add|show|rm|pause|resume|run …]`, `!help`.

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
threads reaches the thread's router. To have the bot take only posts that @mention it,
replies in its threads included, set the workspace's trigger to `mention-only`:

```bash
mmhub ws trigger <workspace> mention-only
```

DMs, answers to 🔐 prompts and `!` commands still need no mention, and when a mention
does reach the router it is told how many replies it didn't get (`fetch_thread` shows
them). `mmhub ws trigger <workspace> mention` goes back to the default.

A workspace can instead let
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
- **Quiet → unfollowed.** The hub also stops following a thread by itself once
  `unfollowAfter` (15) posts went by since the bot's last post there, counting the new
  one: people have moved on. That post isn't judged, and later ones without a mention
  are ignored. `0` turns this off. It applies to `openrouter` too.
- **A new mention follows the thread again.** The router hears how many messages it
  missed while it wasn't following, and why it stopped. Owners can also switch by hand with
  `!unfollow` and `!follow` in the thread.

Posts outside the bot's threads still need a mention. DMs are never judged: every DM from
an owner reaches the bot, without a mention, and there is nothing to follow or unfollow.

**Two people: always for the bot.** When only the bot and one person have posted in the
thread, every reply from that person reaches the router without asking Laya, greetings
and thanks included. This doesn't apply when the reply @mentions someone else (Laya then
judges it), or when a bot account wrote it, so two bots can't keep answering each other.

**More people: Laya judges.** Laya sees who has posted in the thread ("People in this
thread: …"), the new reply, and up to 10 posts before it, clipped to fit its 512-token
window. Each poster is labelled: the bot as the AI assistant, other bot accounts as other
AI bots. Laya is asked who the reply is talking to, and the answers are built
from the thread itself: the bot, the people and bots the reply @mentions, the thread's
other posters (up to 6 in all), and "nobody". The reply reaches the router when Laya
picks the bot with a probability of at least `threshold` (0.45). Since the answers name
everyone, Laya can tell a reply to another bot or person from one to this bot. In a
channel where a person mostly talks to another bot, the older assistant-or-people
question sent nearly every reply to this bot. Without the "People in this thread" line,
this question sent about a quarter. With it, 4 in 526 reach the bot, along with 3 of the 5
requests that were for the bot in threads of three or more (a `threshold` of 0.5 sends 1
in 526, but only 2 of the 5). In such threads an @mention always gets through.

For each person or bot the reply @mentions, Laya is also asked whether the reply is
talking to them. When it is sure (`ruleThreshold`, 0.85), the reply isn't for the bot,
even in a thread where the person has mostly talked to the bot. A reply that only names
someone ("summarize what @devbot said") scores lower, and the main question decides.

Laya is also asked whether the reply is just a greeting, or thanks. Both are for whoever
wrote the post before it: a greeting ("hi", "selamat pagi") or thanks reaches the bot only
right after the bot's own post. A greeting that @mentions the bot, or in a thread of only
the bot and that person, always reaches it, as any such reply does. Laya is sure of these
at `kindThreshold` (0.7), and both come before the `TRIGGER.md` rules. English greetings and
thanks are recognised reliably. Indonesian thanks ("makasih", "terima kasih") score only
about 0.5, so for them the rules and the main question decide.

The rules in `TRIGGER.md` correct it. They are an `## Answer` list and a `## Don't answer`
list, one rule per line, at most 24 rules of 150 characters. Laya checks each rule on its
own, and a rule decides only when Laya is sure it describes the post (`ruleThreshold`,
0.85). A sure "don't answer" rule wins. Specific rules work ("Lunch plans", "Deploy
requests"); vague ones ("anything about work") change nothing. A post takes about
0.05 s to judge (up to 0.5 s for long ones, about 1 s when the model first loads).

The rules learn. When someone says the bot answered something that wasn't for it, or
missed something that was, the router has a worker change the rules with the
`trigger_rules` tool. Owners can also edit `TRIGGER.md` by hand. Changes apply to the
next post.

A mention always works and skips Laya. If Laya is down or slow (5 s), replies in
followed threads go to the router as usual; `mmhub doctor` shows whether Laya is ready. The `laya` model is English-only. For other languages, set
`"laya": {"model": "laya:322m-multilingual-bf16"}` in `config.json` (after
`ollama pull laya:322m-multilingual-bf16`), then run `mmhub reload`, or use
laya-serve, which picks the model by each post's language.

### Without Ollama: laya-serve

Laya's makers also publish a Python server, `laya-serve`, that answers the same
requests. Measured on the same 540 posts, it made the same decision as Ollama on every
one. The hub can install and run it for you:

```bash
mmhub laya install
```

This needs [uv](https://docs.astral.sh/uv/) (`brew install uv`), which also fetches the
Python it uses. It puts about 2.2 GB in `<state>/laya`: Python 3.12 with PyTorch and the
pinned `laya` package, the English model (the one Ollama's `laya` is) and the
multilingual one (100+ languages), and a random API key (mode 0600). It then points
`config.json` at it (port 8788, model `auto`: each post goes to the English or the
multilingual model by its language) and reloads the hub. `--english-only` skips the
multilingual model, `--port N` and `--device cpu|mps|cuda` change the defaults.
`--unload-after MIN` sets when idle models are freed (below).

From then on the hub runs it in the tmux session `mmhub-laya` while some workspace's
trigger is `laya`, and starts it again if it exits (after 10 minutes if it died within 2
minutes of starting; `mmhub laya logs` shows why). It listens on 127.0.0.1 only, judges
only requests that carry the key (the hub sends it; its `/health` needs none), and works
offline: the models are downloaded at install. The first post after a start would take a few seconds more, so the
hub sends one small request first.

**Memory.** With its models loaded, laya-serve takes about 3.6 GB (2.8 GB of it on the
GPU; Ollama's `laya` takes about 0.9 GB). So, like Ollama, it frees them after 5 minutes
without a post and keeps about 0.5 GB. The next post loads the English model again and
takes about 2–3 s instead of 0.1–0.2 s, inside the 5 s limit. The multilingual model loads
only for a post in another language. `--unload-after 0` keeps them loaded.

```
mmhub laya status            # installed version, device, loaded models, who uses it
mmhub laya restart | logs [-n N]
mmhub laya use ollama        # back to Ollama; laya-serve stays installed
mmhub laya use serve         # and back
mmhub laya uninstall         # remove it, its models and key; back to Ollama
```

It wants a GPU (Apple silicon or NVIDIA): on an Apple GPU a post takes about 0.2 s,
like Ollama, but on CPU alone about 2 s, and 1 in 20 posts takes over the 5 s limit
(that reply then reaches the router unjudged). On posts in English, `auto` decided like the
English model alone; the multilingual model alone did worse (36 of 528 replies not
for the bot let through, against 6).

### A hosted judge: OpenRouter

Instead of Laya, a hosted model can judge, through [OpenRouter](https://openrouter.ai).
It needs no GPU and nothing installed, and it reads any language well, but each
judged reply is an API call that costs a little and sends the thread out:

```bash
mmhub openrouter key
```

```bash
mmhub ws trigger <workspace> openrouter
```

`mmhub openrouter key` reads the key from stdin (paste it at the prompt, so it stays out of
your shell history), checks it with OpenRouter and saves it as `OPENROUTER_API_KEY` in
the hub's `.env` (0600). The hub reads it on each call and never passes it to sessions.
The default model is `google/gemini-decision-1`, Google's decision model: it doesn't write
text, it answers typed questions with probabilities, through OpenRouter's Decisions API,
at $0.10 per million input tokens with output free. OpenAI's counterpart is
`openai/gpt-6-luna-decisions` (same price). `mmhub openrouter model <id>` picks another;
any OpenRouter chat model works too (it answers in JSON instead). Which API a model
needs comes from its OpenRouter listing (`openrouter.api` overrides it).
`mmhub openrouter` says whether the key and model work, with one test judgement (a
fraction of a cent), and `mmhub doctor` checks it too.

Everything else is as with Laya: the bot follows threads from a mention until the router
unfollows, the workspace's `TRIGGER.md` rules apply, and a thread of only the bot and one
person needs no judge. The model gets the same view of the thread (who is in it, up to
`openrouter.messages` (10) posts before the reply, the reply marked `>>`) and the rules. A
decision model gets Laya's own questions and is decided as Laya is: the reply is for the
bot when "talking to the bot" is at least `openrouter.threshold` (0.5) likely, a rule
decides from `openrouter.ruleThreshold` (0.8), and a sure greeting or thanks from
`openrouter.kindThreshold` (0.7). A chat model answers who the reply is talking to and
whether a rule describes it; a "don't answer" rule wins, then an "answer" rule, then
whether it talks to the bot. If OpenRouter fails or times out (`openrouter.timeoutMs`,
10 s), the reply reaches the router.

**What leaves the machine:** for each reply without a mention in a followed thread, its
text, up to 10 posts before it, the usernames in the thread and the workspace's rules go
to OpenRouter and the model's provider. By default only to providers that neither store
nor train on prompts (`openrouter.dataCollection: "deny"`; `"allow"` lifts it). Settings
live under `"openrouter"` in `config.json`: `model`, `api`, `url`, `timeoutMs`,
`messages`, `dataCollection`, the three thresholds, and `reasoningEffort` for chat models
that think.

## Other workspaces and DMs

A router or worker can ask another workspace, through that workspace's router:

- `message_workspace(workspace, text)` hands the request to a new router of the other
  workspace, agent to agent. The hub posts nothing in its channel: no template, and
  none of the asker's text as it is. That router treats it like a person's request: it
  answers itself or delegates to its workers. Its first reply opens a thread in a
  channel bound to its workspace (O/P channels first), written in its own words for
  the people there: what is asked, by whom, and the answer or next step. Whatever that
  workspace's sessions post in the thread goes back to the asker: a router gets it as
  a message, a worker as work for the thread it was busy on. Follow-ups use
  `request_id` and reach that router as messages, not posts. Everything it answers
  stays visible in its channel. The other side learns who asks as "workspace A" (a
  personal one as "@ami's personal workspace") and "the router of one of its threads,
  for @ami", never the asking thread's first message.
- `send_dm(user, text)` asks a person **privately**, agent to agent. Only routers can: a
  worker reports the question to its thread's router. The hub hands the question to a
  new router in the person's own workspace (`personal-<user id>`, created and bound to
  their DM with the bot if needed), not to the person. That router asks them in the DM
  in its own words (its first post opens the thread), talks it through, and sends back
  what was asked with `answer_request(text)`. The asker gets it as a `dm_reply` message;
  it never sees the DM itself. The answer is in the agent's words: the decision or facts
  the asker needs, not the person's messages, and nothing they didn't mean to share. The
  hub refuses an answer with six or more of the person's words in a row (words of the
  question they echo don't count). Their exact words go through only when they asked
  for it and the wording matters: the agent then says why (`verbatim`), and the asker
  is told it is a quote. The asker in turn passes on only what its thread needs, in its
  own words. Follow-ups use the `thread_id` the asker was given. Only **owners**
  (`access.json` `allowFrom`) can be asked; with `"*"` in `allowFrom`, any person (never
  a bot). With `personalWorkspaces: false` in `config.json`, `send_dm` DMs the owner
  directly from the bot, with the router's text as it is (no header), and their replies
  in that DM thread go back to the router.
- `list_workspaces` shows the other workspaces, which of them take requests, and the
  session's open requests, DMs and private questions.

Guards: a workspace takes requests from every workspace unless its `workspace.json` sets
`acceptFrom` (`["ops", "web"]`; `[]` takes none); a personal workspace's `acceptFrom`
limits who may ask its person privately. A request never goes back into a
workspace it came through, and passes through at most two workspaces. Each session opens
at most 10 requests or DMs an hour, and each one carries at most 60 messages. Running
sessions get these tools at `mmhub session restart all`.

## Scheduled jobs

Recurring work that runs without anyone posting. A job has a schedule, a time zone, a
workspace, where its runs go, and the instruction each run gets. Jobs live in `hub.db`.

**Setting one up** (owners only):

- Ask the bot in a thread: *"every weekday at 9, check the alerts dashboard and post
  anything red"*. The router calls `schedule` with the id of the owner's message (a
  worker can too, from the owner's words its task quotes). The hub checks that the
  message is in that session's thread and that its author is an owner, and the session
  confirms it in the thread: when it runs next and where, nothing more. Sessions never
  mention the `!cron` commands; asked to remove or move a job, an owner's router does it
  itself (`unschedule`, then `schedule`).
- In chat: `!cron add every weekday 09:00 | check the alerts dashboard and post anything red`
  (runs open threads in this channel).
- In a terminal: `mmhub cron add <ws> "every weekday 09:00" Check the alerts…`
  (`--channel`, `--thread`, `--name`, `--tz`, `--grace`; `-` reads the instruction from stdin).

**Schedules:** `every day 09:00`, `every weekday 8:30`, `every weekend 10am`,
`every mon,thu 17:00`, `every month on the 1st 09:00`, `every hour`, `every 2h [at :30]`,
`every 30m`, `@daily`, or a 5-field cron expression (`0 9 * * 1-5`). Times are wall-clock
times in the job's zone: a zone at the end (`… Asia/Jakarta`), `--tz`, or else the hub
machine's. The zone is stored with the job, so moving the hub doesn't shift it. Runs are
at least 15 minutes apart, a workspace has at most 20 jobs, and an instruction is at most
4000 characters. `mmhub cron next "<schedule>"` shows the times a schedule gives.

**A run** gets a router of its own, which receives the instruction as a `kind="scheduled"`
message and handles it like a person's request (answers itself, or delegates to
workers). The hub posts nothing for it: the router's first reply is a new post in the
job's channel (a channel bound to its workspace, by default the one it was set up in),
and that post opens the run's thread, where people can reply as usual. People never see
the instruction, and a run with nothing worth posting ("post anything red", and nothing
is) posts nothing at all. A job can instead send every run to
one existing hub thread (the `in_this_thread` option, `--thread`). That thread's router
then remembers earlier runs ("compare with yesterday"). No session has to be running: the
message goes through the router's inbox, which starts or resumes it like any message,
within the session caps. When the pool is full, the run waits for a slot.

**Reliability:**

- The hub looks for due jobs on its 5-second tick (see [Lifecycle](#lifecycle)) and in
  the reaper, never on a long timer.
- Each due time gets one `job_runs` row per job and time, written together with the
  job's next time before anything is posted. So a time never runs twice, even across a
  crash or a restart.
- A time found due more than its grace (30 min, `--grace`) late is skipped and logged.
  That happens when the hub was down or the Mac asleep.
- When several times were missed, the job runs once, for the latest, if that one is
  within the grace.
- A time whose previous run is still waiting or being worked on is skipped, so runs
  never pile up.
- While Mattermost is unreachable, due jobs wait, and the grace keeps counting.

**Managing jobs:**

- `!cron` lists the workspace's jobs. `!cron show|rm|pause|resume|run <id>` does the
  rest, and so do `mmhub cron list|show|rm|pause|resume|run`.
- Sessions have `list_schedules`, and `unschedule` when an owner asks.
- A paused job skips its times. When it's resumed, it carries on from the next one.
- `run` runs a job once now, besides its schedule.
- `show` lists recent runs (started, skipped, missed, failed). Each skip and miss is in
  `mmhub logs` too.

Running sessions get the new tools and instructions at `mmhub session restart all`.

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
  `idleMinutes`, `cleanupHours`, `baseRef`); `name`, `description` and `repos` there are ignored.
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
mmhub laya install [--port N] [--device D] [--english-only] | status | restart | logs | use ollama|serve | uninstall
mmhub provider list | add <name> <kind> [--env K=V]… | login <name> | secret <name> <VAR> | check <name>
mmhub provider use <ws|--hub> <name>… | use <ws> --inherit | reset <name> | rm <name> [--purge]
mmhub cron list [<ws>] | show <id> | rm|pause|resume|run <id> | next "<schedule>" [--tz ZONE] [-n N]
mmhub cron add <ws> "<schedule>" <instruction…|-> [--name N] [--tz ZONE] [--channel ID | --thread ID] [--grace MIN]
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
`announceClose`, `personalWorkspaces` (true: a DM from a chat without a workspace gets
the person their own, `personal-<user id>`; false: the "which workspace?" question),
`otherAgents` (other AI agents' commands a worker may run only when a person in its
thread named them: `hermes`, `hermes-agent`, `codex`, `gemini`, `opencode`, `aider`,
`openclaw`, `cursor-agent`, `qwen`; `[]` allows them all), `cleanupHours` (24: a worker with no work this long cleans up after
itself, see [Lifecycle](#lifecycle); 0 = never), `busyWatchdogMinutes` (30), `routerAutocompact`, `claudeBin`, `bunBin`,
`gitBin`, `path`, `tmuxSocket` (`mmhub`), `providers` (`["default"]`),
`providerCooldownMinutes` (`{auth:60, quota:60, rate_limit:10, errors:15, channels:360}`),
`trigger` (`mention`; or `mention-only`, `laya`, `openrouter`, see [above](#answering-without-a-mention-laya)),
`unfollowAfter` (15: with `laya` or `openrouter`, stop following a thread after this many
posts without one from the bot; 0 = never), `openrouter` ([above](#a-hosted-judge-openrouter)), `laya`
(`{url: "http://127.0.0.1:11434", model: "laya", threshold: 0.45, ruleThreshold: 0.85, kindThreshold: 0.7, timeoutMs: 5000, messages: 10}`).
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

**Cleanup.** A worker with no work for `cleanupHours` (24 by default) gets a cleanup
job from the hub, and its own session does it: it stops the dev servers, watchers and
background jobs it left running (freeing their ports), removes the Docker containers it
started and the images it built, and deletes build output and installed dependencies in
its own worktrees (`node_modules`, `dist`, `build`, `.next`, `target`, …). It leaves
source files, uncommitted changes, `.env` and config files, shared folders and anything
it didn't create alone, and posts nothing. A closed worker is resumed for the job when a
worker slot is free, and closed again after it. A worker gets one job per stretch
without work, and none while it is pinned, failed or has a task waiting; a task that
comes in first drops the job. The job runs unattended, as with `bypassPermissions`:
whatever the worker's permission mode, its permission prompts are allowed at once (no
🔐 post), and each one is logged in `hub.log` (`perm: … cleanup — allowed …`). Routers
can't run commands, so they get no job. `cleanupHours: 0` turns it off, in `config.json` or a workspace's
`workspace.json`.

**Sleep.** Bun timers pending while macOS sleeps can stay stuck after it wakes (seen
with Bun 1.3.14 after a hibernate: no heartbeat, no reaper, no Mattermost ping, while
the hub still answered `mmhub`). So the hub also takes a tick every 5 s from a child
`sh` (`while sleep 5; do echo; done`), plain I/O that keeps working. After a gap of
more than 30 s between ticks, or when its own timers go quiet, it re-arms its timers
and scheduled retries, checks busy sessions' screens, and opens a new Mattermost
socket, which catches up on posts missed meanwhile. [Scheduled jobs](#scheduled-jobs) are
checked on these ticks, so a job never waits on a timer that slept. A hub that still has no heartbeat
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
| the turn ended with text but posted nothing (it wrote its answer in its terminal instead of calling `reply`) | its Stop hook sends the turn back once ("Nothing was posted this turn…"), so it posts it; a turn that reached someone (`reply`, `react`, `edit_message`, `delegate`, `message_workspace`, `send_dm`, `answer_request`, `new_thread`, `unfollow`) or ended without text isn't |
| the turn ended with an API error (StopFailure) | overloaded / 5xx / network: retry after 20 s, 1 m, 3 m, 10 m (a ⚠️ post only from the third try). Rate limit: 5 m, 15 m, 30 m, then hourly (≈5 h), with one ⏸ post. Output limit: once, quietly. Invalid request: no retry, a ⚠️ post. Sign-in, usage/credit limits, rate limits, and errors that outlast these retries move the work to the workspace's next provider when it has one ([above](#providers-and-fallback)); otherwise sign-in errors aren't retried (a ⚠️ post) and usage limits wait like rate limits. New work for it waits for the retry; `!wake <id>` retries now |
| an owner stopped it (`Stop`, `!stop`, `!worker stop`) | it stays stopped: its unfinished work waits for the next message, delegate or wake |

**Restart** (`mmhub session restart <key>`, `!restart`, the panel's **Restart**) relaunches
a session with the current settings (config, workspace `CLAUDE.md`, permission mode)
and the same conversation. It happens right away if the session is idle, otherwise
**after its current turn ends** — the work in progress is never cut off, and the status
shows `restart after this turn` meanwhile. Messages and tasks that arrive meanwhile wait
for the restarted session, so they get the new settings. Work the session left running in
the background would die with its process, so the restart also waits for that to finish
(new work goes in meanwhile, since it may take long). `--now` / `!restart <id> now` / **Restart now**
interrupts it instead; the cut-off work is re-delivered (background work just stops). `restart all|workers|routers`
does every live session (e.g. after editing `config.json` and `mmhub reload`).

## Development

```bash
bun test            # hub tests in test/ (inbound table, lifecycle, providers, hub, …)
bun run typecheck
claude plugin test . # the panel mod's tests (hooks/*.test.tsx); tsc -p hooks type-checks it
bun scripts/e2e.ts  # real hub + real claude sessions against an in-memory Mattermost
claude plugin validate .
```
