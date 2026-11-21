# Open Prompts

[![CI](https://github.com/theophile-wallez/open-prompts/actions/workflows/ci.yml/badge.svg)](https://github.com/theophile-wallez/open-prompts/actions/workflows/ci.yml)
[![Open Prompts](https://img.shields.io/badge/prompts-open-2ea44f)](prompts/)

**Commit the prompts behind your code.**

Open source shows the code. When more and more of that code is written with coding agents, the prompts that produced it say just as much: what was asked, what was decided, what the agent did on its own. Open Prompts makes those prompts public too, in the same repository and the same commits as the code.

It has two parts:

- [**The specification**](SPEC.md): a small, agent-agnostic JSONL format. Only the prompts people typed, with the agent, the model and the session. No replies, no tool output, no file contents.
- **This tool**: hooks for Claude Code, Codex, Cursor, Gemini CLI, GitHub Copilot CLI, OpenCode and Mistral Vibe that record every prompt you type, in the background, in repositories that opted in.

This repository follows its own rule: the prompts that built it are in [`prompts/`](prompts/).

## What gets recorded

One file per session, in `prompts/`, one line per prompt:

```text
prompts/
├── 2026-11-20-234908e6.jsonl
└── 2026-11-21-ses_e063.jsonl
```

```json
{"v":1,"id":"e766d02b-672b-4d86-9839-4719375e3ff5","timestamp":"2026-11-20T15:50:29.930Z","agent":"claude-code","agent_version":"2.1.328","model":"claude-opus-5-5","session":"234908e6-56a5-49e3-b055-a161f39d736f","prompt":"J'aimerais que ce soit juste les prompts, avec l'agent utilisé, le modèle, et la session"}
```

Each line is written before the agent touches any file, so a commit the agent makes during that turn already contains the prompt that asked for it.

## Supported agents

| Agent | Hook | Model recorded | Install |
| :- | :- | :- | :- |
| Claude Code | `UserPromptSubmit`, in the background | The model that answered | Plugin, or `open-prompts install` |
| Codex (CLI, IDE, app) | `UserPromptSubmit` | The session's model | `open-prompts install`, then approve in `/hooks` |
| Cursor (editor and CLI) | `beforeSubmitPrompt` | The selected model | `open-prompts install` |
| Gemini CLI | `BeforeAgent` | The model that answered | Extension, or `open-prompts install` |
| GitHub Copilot CLI | `userPromptSubmitted` | The model that answered | `open-prompts install` |
| OpenCode | Plugin (`chat.message`) | The selected model | `open-prompts install` |
| Mistral Vibe | `pre_agent` | The session's model | `open-prompts install` |

Claude Code, Gemini CLI and OpenCode are tested against real sessions. Codex, Cursor, Copilot and Mistral Vibe are tested against the payloads their documentation and source code describe; reports from real use are welcome.

## Install

You need Node.js 18 or later.

```sh
npm install -g @open-prompts/cli
open-prompts install
```

`open-prompts install` finds the agents on your machine and adds the hooks to each one's user configuration. Use `--agent <name>` to pick one: `claude-code`, `codex`, `cursor`, `gemini-cli`, `copilot`, `opencode` or `mistral-vibe`. Your existing settings are kept, and a backup of each file it changes is saved next to it as `*.open-prompts.bak`.

The hooks do not run the copy of open-prompts you ran `install` from, which may live in a worktree's `node_modules` (`pnpm exec`, `npx`) or a cache and disappear with it. `install` copies what the hooks need to `~/.local/share/open-prompts` (`$XDG_DATA_HOME/open-prompts`, `%LOCALAPPDATA%\open-prompts\runtime` on Windows, or `OPEN_PROMPTS_DATA_DIR`) and points every agent there. The copy is made next to the old one and swapped in, and is left alone when nothing changed. **Run `open-prompts install` again after you update open-prompts**: `status` says when the copy is older.

The hooks also need a Node.js that stays in place. When the one running `install` belongs to a version manager (nvm, fnm, Volta, asdf, mise and others) or to a versioned Homebrew directory, `install` uses a system-wide Node.js 18 or later instead, such as `/opt/homebrew/bin/node`, `/usr/local/bin/node` or `/usr/bin/node`. When there is none, it keeps the current one and says how to fix it: install Node.js for the whole system and run `install` again, or name one with `open-prompts install --node <path>`. `open-prompts status` lists the hooks whose Node.js or script no longer exists.

`open-prompts uninstall` removes the hooks of every agent and the copy. With `--agent`, it removes the hooks of that agent only.

Some agents can also install it their own way:

```text
# Claude Code, as a plugin
/plugin marketplace add theophile-wallez/open-prompts
/plugin install open-prompts@open-prompts

# Gemini CLI, as an extension
gemini extensions install https://github.com/theophile-wallez/open-prompts
```

The Claude Code plugin and the Gemini CLI extension run the files of the plugin or extension itself, with the `node` of your `PATH`, and need no copy.

Installing records nothing yet. Each repository has to opt in.

### Notes for each agent

- **Codex** runs a new hook only after you approve it. Open Codex, run `/hooks` and approve `open-prompts`. Codex 0.124 or later.
- **Gemini CLI** runs hooks from its settings only in folders you trust. The extension runs everywhere. Gemini CLI 0.26 or later.
- **Cursor** reloads its hooks by itself. It also runs Claude Code hooks: Open Prompts recognizes Cursor's payload in both cases and writes each prompt once. After Cursor starts, the first prompt can be sent before the hooks are loaded.
- **Copilot CLI** 1.0.21 or later. The Copilot harness in VS Code uses the same hooks.
- **OpenCode** loads the plugin when it starts. `open-prompts install` writes `~/.config/opencode/plugins/open-prompts.js`.
- **Mistral Vibe** reads the hook from `~/.vibe/hooks.toml` (or `$VIBE_HOME/hooks.toml`), in a block marked `open-prompts` that `uninstall` removes. It runs for the main session only, not for subagents.
- **Claude Code** deletes its transcripts after 30 days by default (`cleanupPeriodDays` in `~/.claude/settings.json`). Recording does not need them, but [`import`](#import-past-sessions) does, so `install` says when they are kept less than 90 days. `open-prompts install --agent claude-code --keep-transcripts [days]` sets `cleanupPeriodDays` to 365 days, or the number you give. Nothing changes that setting without the flag.

## Enable it in a repository

At the root of the repository, run:

```sh
open-prompts init
```

In Claude Code with the plugin, `/open-prompts:init` does the same.

This creates `.open-prompts.json` and `prompts/`, with an empty `prompts/.gitkeep` so that git keeps the directory before the first prompt. From then on, every prompt you type to a supported agent in that repository is written to `prompts/`. Commit both with your code, as you would any other file.

To check that everything is in place:

```sh
open-prompts status
```

```text
Project:   /home/you/code/my-app
Prompts:   prompts/ (12 prompts in 3 sessions)
Agents:    Claude Code (plugin), Codex, Gemini CLI
Hooks run: ~/.local/share/open-prompts (open-prompts 0.1.1)
Recording: on
```

## Privacy

- **Opt-in for each repository.** Nothing is recorded in a directory without `.open-prompts.json` above it, not even temporary state. Private work stays private.
- **Prompts only.** Replies, tool calls and their output, files the agent read, the content of `@file` references, and prompts the agent sends to its own subagents are never recorded.
- **Only what a person typed.** Messages that agents send to each other are left out: briefs to delegated agents and their results, messages from other sessions, and the sessions a host runs on its own, such as T3 Code naming a git branch. Under [T3 Code](#t3-code), the hooks ask T3 who wrote each message.
- **Attachments become placeholders.** An image becomes `[image]` and a file `[file]`. The local path where the host saved it, which holds your account name, is not kept. A prompt with nothing but attachments is not recorded.
- **Secrets are redacted** before anything is written: private keys, API tokens of Anthropic, OpenAI, GitHub, GitLab, AWS, Google, Slack, Stripe and npm, JWTs, `Bearer` tokens, values of variables such as `DB_PASSWORD=…`, cookies (`Cookie:` headers, also in a headers object or `document.cookie`, `--cookie=…`, `curl -b`, `sessionId=…`), a password typed after an email address (`jane@example.com Tr0ub4dor&3`, or on the next line, both are redacted), passwords in URLs, passwords after a keyword in several languages (`password: …`, `mot de passe : …`, `la contraseña es …`, `das Passwort ist …`), with the email address on the same line, and a prompt that is only a password or only an email address. They become `[REDACTED:<kind>]`. This is best effort, so run `open-prompts audit` and read the prompt files in your diff before you push.
- **Home directories are hidden:** `/Users/jane/code/app`, `/home/jane/…`, `C:\Users\Jane Doe\…` and, under WSL, `/mnt/c/Users/jane/…` are written as `~/code/app`, so your account name is not published. `/Users/Shared` is left alone.
- **Email addresses** are kept by default, because prompts often name a maintainer or an address on purpose. Turn on `"redact": { "emails": true }` to redact every one (see [Options](#options)).
- **`import` reads only this repository's sessions,** found by their working directory (see [Import past sessions](#import-past-sessions)). A weak match, a deleted directory whose path only looks like a worktree of the repository, could be another repository with the same name: `--dry-run` marks them, so check them before importing.
- **A local copy, for `collect`.** Each record the hooks write also goes to a spool in the state directory (`~/.local/state/open-prompts/spool`), outside every repository and never published, so that [`collect`](#recover-prompts-from-deleted-worktrees) can bring back the prompts of a worktree deleted before they were committed. It holds only the records of repositories that opted in, as redacted as the prompt files, readable by your account only. A spooled session is deleted after 90 days without a new prompt. Turn it off with `"spool": false` in `.open-prompts.json` or `OPEN_PROMPTS_SPOOL=off` in the environment.
- **Nothing is committed or pushed for you.** The files are written to your working tree. You decide what goes into a commit.
- **Pause at any time:** `open-prompts pause` stops recording on this machine until `open-prompts resume`. Starting an agent with `OPEN_PROMPTS=off` pauses that session only.
- To remove something, delete or edit the line in the file before you commit. If a secret was pushed, rotate it.

## Options

`.open-prompts.json` can also hold options for this tool. Other tools that follow the specification ignore them.

```json
{
  "version": 1,
  "dir": "prompts",
  "redact": { "emails": true, "homePaths": true },
  "ignoreCommands": ["/clear", "/compact", "/model"],
  "ignore": ["^(ok|thanks)$", "/^wip\\b/i"],
  "spool": true,
  "maxPasteLength": 4000
}
```

| Option | Default | What it does |
| :- | :- | :- |
| `dir` | `"prompts"` | Where the prompt files go, relative to the file |
| `redact.emails` | `false` | Redact every email address, not only one followed by a password |
| `redact.homePaths` | `true` | Write `/Users/<name>/…`, `/home/<name>/…` and `C:\Users\<name>\…` as `~/…`. `false` keeps the paths as typed |
| `ignoreCommands` | `[]` | Slash commands not to record, such as `"/clear"`. A prompt that is exactly the command, with or without arguments, is left out. `/compactor` and `please /compact` are still recorded |
| `ignore` | `[]` | Regular expressions (JavaScript syntax, as strings). A prompt that matches one, once host markup is removed, is left out. Write `"/pattern/i"` to add flags |
| `spool` | `true` | Keep a local copy of each record for [`collect`](#recover-prompts-from-deleted-worktrees), in the state directory. `false` keeps none for this repository. `OPEN_PROMPTS_SPOOL=off` does the same for every repository |
| `maxPasteLength` | off | Shorten pasted text longer than this many characters (100 or more): keep its first and last lines, about half the room each, and replace the lines in between with `[… 412 lines omitted …]`. For a pasted log of thousands of lines. See below |

The specification asks for every prompt, slash commands included, so nothing is left out unless you list it. The hooks and `import` both apply these lists.

**Long pastes.** The specification also asks for everything pasted, so `maxPasteLength` is off unless you set it, and setting it is a departure from that rule that the specification allows a repository to make. Claude Code marks the text you paste in what it gives the hook: only the pasted blocks longer than the limit are shortened, and what you typed around them is kept whole. Other agents mark nothing, and neither do Claude Code's transcripts, so for them, and for `import`, the whole prompt is shortened when it is longer than the limit. Lines are kept whole (one very long line keeps whole words), and a private key cut by the limit is left out whole. What is left out is never written, and what is kept is redacted as usual.

Fields this tool does not know are ignored. A known option with a wrong type, such as `"emails": "yes"`, or a regular expression that does not compile, is an error, reported by every command and in `errors.log` by the hooks.

## Commands

| Command | What it does |
| :- | :- |
| `open-prompts init [--dir <dir>]` | Enable Open Prompts in the current repository |
| `open-prompts status` | Show whether prompts are recorded here, and for which agents |
| `open-prompts show [file\|session]` | Print recorded prompts in a readable form |
| `open-prompts ui [--port <n>] [--no-open] [--offline]` | Browse, search, edit and delete the prompts of this repository in your browser |
| `open-prompts validate [path…]` | Check prompt files against the specification. Exits with 1 on problems, for CI. A repository with no prompts directory yet passes |
| `open-prompts audit [path…] [--staged]` | List what to read before committing: possible secrets, emails, passwords, cookies, random-looking strings, long pasted logs. `--staged` checks only the records added in staged changes. Exits with 1 when something is flagged |
| `open-prompts stats [--by day\|model\|session\|agent] [--json]` | Count the prompts of this repository per day (UTC), model, session (with its first day and agent) and agent, as aligned text, or as JSON with `--json`. `--by` shows some of these only, and can be repeated or take a list such as `day,model` |
| `open-prompts import <session\|file>` | Import past sessions of Claude Code, T3 Code, Codex and Gemini CLI: one session ID or file, or `--all` for every session of the repository, in every checkout and worktree. `--source` picks where to look, `--dry-run` shows what matched and why. See [Import past sessions](#import-past-sessions) |
| `open-prompts collect [--dry-run]` | Add the prompts of this repository that the hooks wrote in another checkout, such as a deleted worktree, and that this one is missing. See [Recover prompts from deleted worktrees](#recover-prompts-from-deleted-worktrees) |
| `open-prompts pause` / `resume` | Stop or restart recording on this machine |
| `open-prompts install` / `uninstall` | Add or remove the hooks, for every agent found or one `--agent`. `install` copies open-prompts to `~/.local/share/open-prompts` for the hooks to run, `--node <path>` picks their Node.js, and `--keep-transcripts [days]` also makes Claude Code keep its transcripts longer. `uninstall` without `--agent` also removes the copy |

### Count your prompts

```sh
open-prompts stats --by model,agent
```

```text
432 prompts in 12 sessions, from 2026-11-20 to 2026-12-03.

By model
  model            prompts  share
  claude-opus-5-5      301    70%
  gpt-5.5-codex         98    23%
  unknown model         33     8%

By agent
  agent        prompts  share
  claude-code      334    77%
  codex             98    23%
```

Without `--by`, it also lists the prompts of each day and each session. `--json` prints the same counts for scripts, with `null` for an unknown model.

### Browse your prompts

```sh
open-prompts ui
```

opens a page in your browser with every prompt of the repository, grouped by session. Search the text, filter by contributor, agent, model, session or day, and see which sessions are not committed yet. You can copy a prompt, edit it, redact part of it, or delete a prompt or a whole session before you commit. New prompts appear as you type them to your agents.

The page is served from your machine only, on `127.0.0.1`, and opens only with the link printed in the terminal. Edits rewrite the line in the prompt file and run the secret redaction again. Press Ctrl+C to stop.

Each session shows who wrote it, and you can filter by contributor. The author comes from git: the person who committed the session's prompt file, or your own git identity for a session that is not committed yet (`.mailmap` is applied). The page then matches each author to their account on the forge of the `origin` remote, to show their name, a link to their profile and their avatar:

- GitHub: from the private `…@users.noreply.github.com` address, or else from the commit, with the GitHub API. It goes through the `gh` CLI when it is signed in, which also covers private repositories, and anonymously otherwise.
- GitLab: the avatar for the email address, from the GitLab API.
- Anywhere else: the Gravatar of the address.

These lookups send the commit IDs, or for GitLab the email addresses, to the forge, and Gravatar receives a hash of the address. Their results and the avatars are kept for a week in the state directory. `open-prompts ui --offline` makes no request at all and shows initials instead.

The page shows the repository's icon, found the way T3 Code finds it: an `iconPath` in `t3.json`, a well-known favicon or logo file, the `<link rel="icon">` of the app's HTML, or the icons of a web app or browser extension manifest.

### Share them with a link

The same interface is published on GitHub Pages, at [theophile-wallez.github.io/open-prompts](https://theophile-wallez.github.io/open-prompts/). Paste the link of a GitHub repository that records its prompts, and the page shows them, read from GitHub in your browser. The repository is in the page's address, with the filters you pick, so the link can be shared:

```text
https://theophile-wallez.github.io/open-prompts/?repo=owner/name
https://theophile-wallez.github.io/open-prompts/?repo=owner/name&ref=a-branch#session=2026-11-20-234908e6.jsonl
```

The page reads the default branch, or the one in `ref`, as it is on GitHub: prompts that are not pushed are not there. It cannot change anything. To edit or delete prompts, use `open-prompts ui`.

- **Public repositories** need nothing. Without a token, GitHub allows 60 requests an hour from one address; opening a repository takes 4, and the prompt files come from `raw.githubusercontent.com`, which does not count. Who wrote each session is only shown with a token, since it comes from GitHub's GraphQL API.
- **Private repositories** need a token of someone who can read them. Choose **Add a token**, and create a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new) with read-only access to the contents of the repositories you want to open. For a repository of an organization, the organization may have to approve the token, or allow it for SAML single sign-on.

The token stays in your browser, for the tab only unless you choose **Remember on this device**, and is sent only to `api.github.com`. It is never part of the address: a link to a private repository only opens for people who can read it, with their own token. A static page cannot sign in to GitHub with OAuth, which needs a server to keep a secret, so a token is the only way.

To publish the page from your own fork, enable GitHub Pages with **GitHub Actions** as its source in the repository's settings. The [`Pages`](.github/workflows/pages.yml) workflow deploys it on each push to `main` that changes `src/ui/`.

The interface is set in [Allo](https://allo.joshpuckett.me) by Josh Puckett, bundled under the SIL Open Font License ([`src/ui/fonts/OFL.txt`](src/ui/fonts/OFL.txt)).

To check prompt files in CI:

```yaml
- run: npx --yes @open-prompts/cli validate
```

### Check prompts before each commit

`open-prompts audit` prints one line per thing to read, as `file:line: reason: excerpt`, with the flagged values cut short, and the words around them that could be a password too, so the output can be shared:

```text
prompts/2026-11-20-234908e6.jsonl:14: email and password: connecte toi: jan…
prompts/2026-11-20-234908e6.jsonl:21: high-entropy string: use the key Zx8… for staging

2 findings in 2 of 40 records. Read them, edit or delete the lines that should not be published, then commit. To delete a line, prefer "open-prompts ui": "open-prompts collect" adds back a line deleted by hand.
```

It looks wider than redaction, so some findings will be fine as they are. With `--staged`, it reads the records added in the staged changes of the prompt files (from `git diff --cached`, not from the working tree), which makes it a pre-commit check. Each record is checked once, in the commit that adds it.

A plain git hook, in `.git/hooks/pre-commit` (then `chmod +x .git/hooks/pre-commit`):

```sh
#!/bin/sh
exec open-prompts audit --staged
```

With [husky](https://typicode.github.io/husky/): `echo "npx --yes @open-prompts/cli audit --staged" >> .husky/pre-commit`.

With [lefthook](https://lefthook.dev), in `lefthook.yml`:

```yaml
pre-commit:
  commands:
    open-prompts:
      run: npx --yes @open-prompts/cli audit --staged
```

When the hook stops a commit, read the lines it lists. Edit or delete the ones that should not be published, then `git add` them again. Delete lines with `open-prompts ui`, which also removes them from the local copy that [`collect`](#recover-prompts-from-deleted-worktrees) reads: a line deleted in an editor comes back the next time you run `collect`. If everything it found is fine, commit with `git commit --no-verify`.

### Recover prompts from deleted worktrees

A worktree made for one task, by you or by a tool such as T3 Code, is often deleted once the task is merged. If its session shipped no commit, its prompt file was never committed and goes with it. The hooks keep a copy of each record in a local spool, by repository: the main checkout and all its worktrees share one, found from the git directory they share. In any checkout of the repository, run:

```sh
open-prompts collect --dry-run   # list what would be added
open-prompts collect
```

```text
prompts/2026-11-20-5f0c2a7e.jsonl
prompts/2026-11-21-9d3b1e40.jsonl

14 prompts added in 2 sessions, 230 already there.
```

`collect` adds every spooled record that the prompt files of this checkout are missing, in the file of its session, after the records already there. A record counts as there when a line has its ID, or, for agents that give none, its session and time, so a line you edited is not added again. A line you deleted by hand is, though: run `--dry-run` first, or delete prompts with `open-prompts ui`, which removes them from the spool too. Records `import` wrote are not spooled, since the agents' files still hold them.

Two kinds of records are left out, and listed, because adding their file here would make git refuse to bring it in later ("untracked working tree files would be overwritten"): the records of another checkout that still exists, such as a worktree in use, and a session whose file would be new here but that git already has, in a branch not merged yet or deleted from it on purpose. Commit them where they are, or check the branch out and run `collect` there.

### Import past sessions

Prompts typed before Open Prompts was installed, or while it was paused, are still in the agents' own session files. `open-prompts import --all` finds every session of the repository and writes its prompts, with the same filters and redaction as the hooks. Run it with `--dry-run` first: it lists the folders and projects that matched and why, and prints the prompts it would write.

```text
$ open-prompts import --all --dry-run
Claude Code: 230 sessions in 126 folders of ~/.claude/projects
  -Users-jane-code-my-app (12 sessions): this checkout
  -Users-jane--t3-worktrees-my-app-t3-1f2e3d4c (3 sessions): worktree of this repository (git worktree list: ~/.t3/worktrees/my-app/t3-1f2e3d4c)
  -Users-jane--t3-worktrees-my-app-t3-9a8b7c6d (1 session): T3 Code worktree of project "my-app"
  -Users-jane--t3-worktrees-my-app-t3-5e4f3a2b (2 sessions): weak: the directory is gone, and its path looks like a worktree of my-app
T3 Code: 422 threads in 1 project of this repository (~/.t3/userdata/statev2.sqlite)
  project "my-app" (422 threads): workspace ~/code/my-app: this checkout
Codex: no sessions of this repository (~/.codex/sessions)
Gemini CLI: no sessions (~/.gemini/tmp)
…
2735 prompts would be imported, 160 already there, 650 written by agents or hosts, skipped.
```

`open-prompts import <session>` imports one session, found by its ID in any of these places, and `open-prompts import <file>` reads one session file, wherever it is.

**Sources.** `--source claude,t3,codex,gemini` (or `--source` repeated) picks where to look. By default, `import` reads every source it finds:

| Source | Where | What it reads |
| :- | :- | :- |
| `claude` | `~/.claude/projects` (`CLAUDE_CONFIG_DIR`) | One transcript per session, in one folder per working directory |
| `t3` | `~/.t3/userdata/statev2.sqlite` (`OPEN_PROMPTS_T3_DB`) | The messages of the repository's threads that T3 says you wrote. Needs Node.js 22.13 or later |
| `codex` | `~/.codex/sessions` and `~/.codex/archived_sessions` (`CODEX_HOME`) | One rollout file per session, with its working directory, version and the model of each turn |
| `gemini` | `~/.gemini/tmp` (`.gemini` in `GEMINI_CLI_HOME`) | One chat file per session, in one directory per project |

**Which sessions belong to the repository.** A session belongs to it when its working directory does. Strong evidence: the directory is the checkout or inside it; `git worktree list` lists it; it exists and shares the repository's git directory or root commit (another clone); T3 Code says it is a worktree of one of the repository's projects, or says the session is one of their threads. Weak evidence: the directory is gone and its path looks like a worktree of a repository with the same name, such as `~/.t3/worktrees/my-app/…` or `~/.codex/worktrees/<id>/my-app`. Two repositories can share a name, so weak evidence is used only when nothing contradicts it: a weak match that T3 Code puts in another project is listed as `not used`.

**Each prompt once.** The same prompt can be in two places: a Claude Code transcript and T3 Code's database have it under different IDs. `import` keeps one copy, with T3's `x_host` and `x_thread` fields. It also skips what the prompt files already hold, by ID, or by session, text and time for records the hooks wrote, and the prompts that a forked or resumed session copied from the session it came from.

**Who wrote it.** Messages agents wrote, sub-agents' sessions, and the sessions a host ran on its own are skipped. When T3 Code's database can be read, `import` asks it, whatever `--source` says: an agent's message found in a transcript is skipped, and a message T3 says you wrote is kept even if it looks like an agent's. Elsewhere, `import` recognizes agents' messages by their wording, as the hooks do.

**Model.** The model that wrote the first reply. A turn that was cut short has no reply, so it gets the model the session used just before, or else the one after.

**What may be missing.** Claude Code deletes transcripts after 30 days by default, so `import` says when the repository's history starts well before the oldest session it found, and how to keep transcripts longer. Sessions on another machine are not found either.

## How it works

Each agent calls `open-prompts hook` with a JSON description of the prompt. The hook prints nothing that would reach the conversation, always exits successfully, and never blocks a prompt.

- **When the agent gives the model with the prompt** (Codex, Cursor, OpenCode), the record is written right away.
- **When it doesn't** (Claude Code, Gemini CLI, Copilot, Mistral Vibe), Open Prompts waits for the agent's first reply and reads the model from the agent's own session files. Claude Code runs the hook in the background. Gemini CLI, Copilot and Mistral Vibe wait for their hooks, so the hook hands the waiting to a detached process and returns in a few milliseconds.

The hooks run the copy of open-prompts that `install` made in `~/.local/share/open-prompts` (see [Install](#install)). Errors go to `errors.log` in the state directory (`~/.local/state/open-prompts`). `OPEN_PROMPTS_DEBUG=1` also logs every event to `debug.log` there. Note that `debug.log` contains your prompts.

### T3 Code

[T3 Code](https://t3.codes) runs Claude Code, Codex and Gemini CLI for you, and lets agents send messages to each other's sessions, which reach the agent like typed prompts. A session T3 starts has `T3CODE_THREAD_ID` in its environment. The hooks then read T3's database (`~/.t3/userdata/statev2.sqlite`, read-only) and skip a prompt when T3 says an agent wrote it, or when the thread is a sub-agent's. When T3 says you wrote it, it is recorded, even if it looks like an agent's message.

Records written under T3 Code get two extension fields, `"x_host": "t3"` and `"x_thread": "<T3 thread ID>"`, because one T3 thread can span several agent sessions.

Reading the database needs Node.js 22.13 or later (`node:sqlite` without a flag). With an older Node, or when the database cannot be read, the hooks fall back to recognizing agent messages by their text, and `OPEN_PROMPTS_DEBUG=1` logs why in `debug.log`. `OPEN_PROMPTS_T3_DB` points the hooks and `import` to another database file. `import` also reads T3's database to find the threads of the repository, as described in [Import past sessions](#import-past-sessions).

Models are recorded exactly as each agent reports them. Through Amazon Bedrock, Google Vertex AI or OpenRouter, that can be a provider's model ID, such as `anthropic.claude-haiku-4-5-20251001-v1:0` or `openrouter/z-ai/glm-5.2`.

### Environment variables

| Variable | What it does |
| :- | :- |
| `OPEN_PROMPTS=off` | Pause recording for the agent session started with it |
| `OPEN_PROMPTS_SPOOL=off` | Keep no local copy of the records for `collect`, in any repository |
| `OPEN_PROMPTS_DEBUG=1` | Log every hook event to `debug.log` in the state directory. It contains your prompts |
| `OPEN_PROMPTS_STATE_DIR` | The state directory, instead of `~/.local/state/open-prompts` (`$XDG_STATE_HOME/open-prompts`) |
| `OPEN_PROMPTS_DATA_DIR` | Where `install` copies open-prompts for the hooks, instead of `~/.local/share/open-prompts` |
| `OPEN_PROMPTS_T3_DB` | T3 Code's database, instead of `~/.t3/userdata/statev2.sqlite` |
| `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GEMINI_CLI_HOME` | Where Claude Code, Codex and Gemini CLI keep their files, as these agents read them. `import` reads sessions there, and `install` writes the hooks of Claude Code and Codex there |

## Limitations

- **Messages that no person typed.** Agents pass some automated messages to the same hook as typed prompts. Open Prompts filters the ones it can recognize: background task notifications, local command output, subagent prompts, and the messages agents send to each other. Under T3 Code, T3 says who wrote each message (with Node.js 22.13 or later). Elsewhere, a message from another session is recognized only by its wording, such as "Note from another session" or "Act as the implementation sub-agent", so one worded differently is recorded. `import` asks T3's database when it can, and relies on the wording otherwise.
- **Expanded commands.** Gemini CLI passes custom commands to the hook already expanded, so their full text is recorded instead of `/command`. Claude Code and OpenCode record the command as typed.
- **Redaction guesses.** Passwords and cookies are recognized by their shape and what surrounds them. To keep false positives rare, a password must contain a digit or a symbol, so one that is an ordinary word (`mot de passe : chocolat`) is not redacted, nor is a password typed with neither an email address nor a keyword before it. After a keyword (`password: …`), any such value is redacted unless it is code, a path, a URL or a placeholder. Elsewhere, the guess is stricter: a value that looks like a code identifier (`OAuth2Client`), a lowercase commit hash, a file name, a ticket (`PROJ-1234`), a date or `package@18` is kept, and "pass" or "clave" need `:`, `=` or "is" before a password, since they are also ordinary words. `open-prompts audit` points at some of what is left.
- **`maxPasteLength` cuts by position.** A shortened paste keeps its first and last lines, so a line that mattered in the middle of a long log is left out. Except with Claude Code's hook, which says what was pasted, the limit applies to the whole prompt, typed text included.
- **Images** are not recorded. The text of a prompt that had an image is.
- **Windows** is untested.
- **`collect` sees this machine only.** The spool is local, so a worktree deleted on another machine cannot be recovered here, and sessions recorded before the spool existed, or more than 90 days ago, are not in it. `import` may still find them in the agents' own files.
- **The installed copy does not update itself.** After you update open-prompts, the hooks keep running the copy `install` made until you run `open-prompts install` again.
- **What `import` reads.** Claude Code, T3 Code, Codex and Gemini CLI. Not Cursor, Copilot, OpenCode or Mistral Vibe, whose hooks record live only. The Codex and Gemini CLI readers are tested against the files these agents wrote on one machine (Codex Desktop, Gemini CLI through T3 Code), and other versions may differ. The older Gemini CLI chat format (`session-*.json` in a directory named after the hash of the project's path) follows Gemini CLI's layout but is untested. A Codex session that Codex imported from another agent is skipped, because its times are those of the import. A gone worktree is recognized only by T3 Code or by the shape of its path (see weak evidence above), so a session in a deleted directory elsewhere is not found. Two copies of a prompt that are more than six hours apart, such as a message queued for longer, are both written.

## Contributing

- **Another agent**: an adapter in [`src/agents/`](src/agents/) turns the agent's hook payload into a record with `writePrompt`, which takes extension fields (`x_…`) in `extensions`. Add it to [`src/hook.mjs`](src/hook.mjs) and [`src/install.mjs`](src/install.mjs), and use the agent slugs from the [specification](SPEC.md#agent-slugs).
- **Redaction rules**: add a case to [`test/redact.test.mjs`](test/redact.test.mjs) with the pattern in [`src/redact.mjs`](src/redact.mjs).
- **The specification**: open an issue before proposing a change to the format.

Run the tests with `npm test`. There are no dependencies. CI runs them on Linux and macOS with Node 18, 20, 22 and 24. Releases are described in [RELEASING.md](RELEASING.md).

## License

[MIT](LICENSE)
