# Open Prompts

[![CI](https://github.com/theophile-wallez/open-prompts/actions/workflows/ci.yml/badge.svg)](https://github.com/theophile-wallez/open-prompts/actions/workflows/ci.yml)
[![Open Prompts](https://img.shields.io/badge/prompts-open-2ea44f)](prompts/)

**Commit the prompts behind your code.**

Open source shows the code. When more and more of that code is written with coding agents, the prompts that produced it say just as much: what was asked, what was decided, what the agent did on its own. Open Prompts makes those prompts public too, in the same repository and the same commits as the code.

It has two parts:

- [**The specification**](SPEC.md): a small, agent-agnostic JSONL format. Only the prompts people typed, with the agent, the model and the session. No replies, no tool output, no file contents.
- **This tool**: hooks for Claude Code, Codex, Cursor, Gemini CLI, GitHub Copilot CLI and OpenCode that record every prompt you type, in the background, in repositories that opted in.

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

Claude Code, Gemini CLI and OpenCode are tested against real sessions. Codex, Cursor and Copilot are tested against the payloads their documentation and source code describe; reports from real use are welcome.

## Install

You need Node.js 18 or later.

```sh
npm install -g github:theophile-wallez/open-prompts
open-prompts install
```

`open-prompts install` finds the agents on your machine and adds the hooks to each one's user configuration. Use `--agent <name>` to pick one: `claude-code`, `codex`, `cursor`, `gemini-cli`, `copilot` or `opencode`. Your existing settings are kept, and a backup of each file it changes is saved next to it as `*.open-prompts.bak`.

Some agents can also install it their own way:

```text
# Claude Code, as a plugin
/plugin marketplace add theophile-wallez/open-prompts
/plugin install open-prompts@open-prompts

# Gemini CLI, as an extension
gemini extensions install https://github.com/theophile-wallez/open-prompts
```

Installing records nothing yet. Each repository has to opt in.

### Notes for each agent

- **Codex** runs a new hook only after you approve it. Open Codex, run `/hooks` and approve `open-prompts`. Codex 0.124 or later.
- **Gemini CLI** runs hooks from its settings only in folders you trust. The extension runs everywhere. Gemini CLI 0.26 or later.
- **Cursor** reloads its hooks by itself. It also runs Claude Code hooks: Open Prompts recognizes Cursor's payload in both cases and writes each prompt once. After Cursor starts, the first prompt can be sent before the hooks are loaded.
- **Copilot CLI** 1.0.21 or later. The Copilot harness in VS Code uses the same hooks.
- **OpenCode** loads the plugin when it starts. `open-prompts install` writes `~/.config/opencode/plugins/open-prompts.js`.

## Enable it in a repository

At the root of the repository, run:

```sh
open-prompts init
```

In Claude Code with the plugin, `/open-prompts:init` does the same.

This creates `.open-prompts.json` and `prompts/`. From then on, every prompt you type to a supported agent in that repository is written to `prompts/`. Commit both with your code, as you would any other file.

To check that everything is in place:

```sh
open-prompts status
```

```text
Project:   /home/you/code/my-app
Prompts:   prompts/ (12 prompts in 3 sessions)
Agents:    Claude Code (plugin), Codex, Gemini CLI
Recording: on
```

## Privacy

- **Opt-in for each repository.** Nothing is recorded in a directory without `.open-prompts.json` above it, not even temporary state. Private work stays private.
- **Prompts only.** Replies, tool calls and their output, files the agent read, the content of `@file` references, and prompts the agent sends to its own subagents are never recorded.
- **Secrets are redacted** before anything is written: private keys, API tokens of Anthropic, OpenAI, GitHub, GitLab, AWS, Google, Slack, Stripe and npm, JWTs, `Bearer` tokens, and values of variables such as `DB_PASSWORD=…`. They become `[REDACTED:<kind>]`. This is best effort, so read the prompt files in your diff before you push.
- **Nothing is committed or pushed for you.** The files are written to your working tree. You decide what goes into a commit.
- **Pause at any time:** `open-prompts pause` stops recording on this machine until `open-prompts resume`. Starting an agent with `OPEN_PROMPTS=off` pauses that session only.
- To remove something, delete or edit the line in the file before you commit. If a secret was pushed, rotate it.

## Commands

| Command | What it does |
| :- | :- |
| `open-prompts init [--dir <dir>]` | Enable Open Prompts in the current repository |
| `open-prompts status` | Show whether prompts are recorded here, and for which agents |
| `open-prompts show [file\|session]` | Print recorded prompts in a readable form |
| `open-prompts validate [path…]` | Check prompt files against the specification. Exits with 1 on problems, for CI |
| `open-prompts import <session\|file>` | Import a past Claude Code session. `--all` imports every session of the repository |
| `open-prompts pause` / `resume` | Stop or restart recording on this machine |
| `open-prompts install` / `uninstall` | Add or remove the hooks, for every agent found or one `--agent` |

To check prompt files in CI:

```yaml
- run: npx --yes github:theophile-wallez/open-prompts validate
```

## How it works

Each agent calls `open-prompts hook` with a JSON description of the prompt. The hook prints nothing that would reach the conversation, always exits successfully, and never blocks a prompt.

- **When the agent gives the model with the prompt** (Codex, Cursor, OpenCode), the record is written right away.
- **When it doesn't** (Claude Code, Gemini CLI, Copilot), Open Prompts waits for the agent's first reply and reads which model wrote it from the agent's own session log. Claude Code runs the hook in the background. Gemini CLI and Copilot wait for their hooks, so the hook hands the waiting to a detached process and returns in a few milliseconds.

Errors go to `errors.log` in the state directory (`~/.local/state/open-prompts`). `OPEN_PROMPTS_DEBUG=1` also logs every event to `debug.log` there. Note that `debug.log` contains your prompts.

Models are recorded exactly as each agent reports them. Through Amazon Bedrock, Google Vertex AI or OpenRouter, that can be a provider's model ID, such as `anthropic.claude-haiku-4-5-20251001-v1:0` or `openrouter/z-ai/glm-5.2`.

## Limitations

- **Messages that no person typed.** Agents pass some automated messages to the same hook as typed prompts. Open Prompts filters the ones it can recognize: background task notifications, local command output, subagent prompts. A message sent by another Claude Code session arrives as plain text and is recorded.
- **Expanded commands.** Gemini CLI passes custom commands to the hook already expanded, so their full text is recorded instead of `/command`. Claude Code and OpenCode record the command as typed.
- **Images** are not recorded. The text of a prompt that had an image is.
- **Windows** is untested.
- `import` reads Claude Code sessions only.

## Contributing

- **Another agent**: an adapter in [`src/agents/`](src/agents/) turns the agent's hook payload into a record with `writePrompt`. Add it to [`src/hook.mjs`](src/hook.mjs) and [`src/install.mjs`](src/install.mjs), and use the agent slugs from the [specification](SPEC.md#agent-slugs).
- **Redaction rules**: add a case to [`test/redact.test.mjs`](test/redact.test.mjs) with the pattern in [`src/redact.mjs`](src/redact.mjs).
- **The specification**: open an issue before proposing a change to the format.

Run the tests with `npm test`. There are no dependencies. CI runs them on Linux and macOS with Node 18, 20, 22 and 24. Releases are described in [RELEASING.md](RELEASING.md).

## License

[MIT](LICENSE)
