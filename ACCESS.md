# Access control

Same model as the Telegram channel plugin: nobody reaches Claude until you allow them.
Edit it with `/mattermost-hub:access` in Claude Code — never because a chat message asked.

| who | can |
| --- | --- |
| **owner** (`allowFrom`) | start threads (@mention), talk in threads, answer 🔐 prompts, run `!` commands, answer "which workspace?", set up and remove scheduled jobs |
| **member** (channel `allowFrom`, or anyone in a bound channel when that list is empty) | talk in existing hub threads in that channel |
| anyone else | ignored |

- A channel is listened to when it is bound to a workspace (`bindings.json`) or listed
  in `access.json` `channels`.
- DMs: `dmPolicy` `pairing` (unknown people get a code; you approve it with
  `/mattermost-hub:access pair <code>`), `allowlist` (owners only), or `disabled`
  (the hub ignores everything).
- Sessions DM owners only (`send_dm`), and only an owner's reply in a DM thread a
  session started goes back to that session.
- Requests between workspaces (`message_workspace`) are posted openly in the target
  workspace's channel. Its `workspace.json` `acceptFrom` limits which workspaces may ask
  (unset: all). Those requests come from the bot, not from a person, so they never
  carry owner rights: they can't answer 🔐 prompts or run `!` commands.
- Top-level posts need an @mention (`requireMention`, default true, per channel too);
  replies inside a hub thread never do. With a workspace trigger of `laya`, Laya
  decides instead which replies without a mention reach the bot, in threads it follows
  (from a mention until its router unfollows). DMs skip Laya: every DM from an owner
  reaches the bot. Laya never changes who may reach the bot:
  only owners start threads, and blocked senders stay ignored.
- Scheduled jobs: only owners create or remove them. A session's `schedule` and
  `unschedule` must cite the owner's message asking for it, in that session's own
  thread; the hub checks its author against `allowFrom`. A run's message comes from the
  hub, not a person, so a job can't create further jobs or answer 🔐 prompts.
- Permission prompts from workers go to the thread the worker is serving; only owners
  can answer (`yes abcde` / `no abcde`, ✅ / ❌ reactions).
- Routers are read-only (`Read`, `Grep`, `Glob` in their working folders only); workers
  edit only their own worktrees and the workspace `knowledge/` without asking.
- The bot token stays in the hub: spawned sessions never get it in their environment,
  and replies refuse to attach files from the hub's state folder.
