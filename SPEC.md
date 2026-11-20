# Open Prompts Specification

Version 1 · Draft

Open source publishes the code. Open Prompts also publishes the prompts people wrote to the coding agents that helped produce it.

A repository that follows this specification commits every prompt typed into a coding agent, along with the agent, the model and the session, as plain JSONL files next to the code.

The scope is deliberately narrow: **prompts only**. Agent replies, tool calls, tool output, files the agent read, and reasoning are out of scope.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be read as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

## 1. Terms

- **Prompt**: text a person wrote and submitted to a coding agent in one turn.
- **Agent**: the program that received the prompt, such as Claude Code.
- **Model**: the model that answered the prompt. When the producer cannot tell, the model the agent was set to use when the prompt was submitted.
- **Session**: one conversation with an agent, identified by the agent's session ID.
- **Record**: one line in a prompt file, describing one prompt.
- **Producer**: a program that writes records. **Consumer**: a program that reads them.

## 2. Opting in

A repository opts in by containing a file named `.open-prompts.json` at its root:

```json
{ "version": 1, "dir": "prompts" }
```

| Field | Type | Required | Description |
| :- | :- | :- | :- |
| `version` | integer | yes | Always `1` for this version of the specification |
| `dir` | string | no | Directory that holds the prompt files, relative to the file's location, with `/` as separator. Defaults to `prompts`. MUST NOT be absolute and MUST NOT contain a `..` segment |

Producers look for `.open-prompts.json` in the agent's working directory and then in each parent directory. The nearest one wins.

Producers MUST NOT write records for a working directory that has no `.open-prompts.json` above it. Opting in is a decision made for each repository, never a global default. People also do private work, and a producer installed once on a machine must not publish it.

## 3. Files

- Each session has its own file at `<dir>/<date>-<key>.jsonl`.
  - `<date>` is the UTC date of the session's first record, as `YYYY-MM-DD`.
  - `<key>` is the first 8 characters of the session ID, with any character outside `A-Z`, `a-z`, `0-9`, `_` and `-` replaced by `-`. If a file with that key already exists for a different session, `<key>` is the full session ID, sanitized the same way.
- A file holds the records of one session only.
- Files are UTF-8 without a byte order mark, with one record per line. Each line ends with a line feed (`\n`), carriage returns are not allowed, and blank lines are not allowed.
- Files are append-only. Producers MUST only add lines at the end and MUST NOT rewrite, reorder or delete existing lines. A person MAY edit or delete lines by hand, for example to remove something sensitive (see section 6).
- Lines SHOULD follow the order in which the prompts were submitted.

## 4. Records

Each line is one JSON object:

| Field | Type | Required | Description |
| :- | :- | :- | :- |
| `v` | integer | yes | Specification version. Always `1` |
| `id` | string | no | The agent's identifier for this prompt. Producers use it to avoid writing the same prompt twice |
| `timestamp` | string | yes | When the prompt was submitted, as an [RFC 3339](https://www.rfc-editor.org/rfc/rfc3339) date-time. UTC with a `Z` suffix is recommended |
| `agent` | string | yes | The agent, as a lowercase slug matching `^[a-z0-9][a-z0-9-]*$` (see [Agent slugs](#agent-slugs)) |
| `agent_version` | string or `null` | yes | The agent's version, or `null` when it is unknown |
| `model` | string or `null` | yes | The model identifier exactly as the agent reports it, or `null` when it is unknown |
| `session` | string | yes | The full session ID, as the agent gives it |
| `prompt` | string | yes | The prompt text after redaction (see section 6). Not empty |

```json
{"v":1,"id":"e766d02b-672b-4d86-9839-4719375e3ff5","timestamp":"2026-11-20T15:50:29.930Z","agent":"claude-code","agent_version":"2.1.328","model":"claude-opus-5-5","session":"234908e6-56a5-49e3-b055-a161f39d736f","prompt":"J'aimerais que ce soit juste les prompts, avec l'agent utilisé, le modèle, et la session"}
```

- `agent_version` and `model` are required keys even when their value is `null`, so every line has the same shape.
- Producers SHOULD record the model that wrote the agent's first reply to the prompt. They MAY wait for that reply before writing the record, as long as the record is written before the agent can act on the prompt in ways that end up in a commit (see section 7).
- `model` is recorded as reported and is not normalized. The same model can appear as `claude-opus-5-5` through one provider and as a provider-specific ID through another, and both are correct.
- Producers SHOULD write fields in the order of the table. Consumers MUST NOT depend on field order.
- Producers MUST NOT write fields that are not in the table, except extension fields whose names start with `x_`. Consumers MUST ignore fields they do not recognize.

### Agent slugs

Use the slug from this list when the agent is in it. For another agent, use its usual command or product name in lowercase, with words joined by `-`.

| Agent | Slug |
| :- | :- |
| Claude Code | `claude-code` |
| Codex CLI | `codex` |
| Cursor | `cursor` |
| Gemini CLI | `gemini-cli` |
| GitHub Copilot | `copilot` |
| OpenCode | `opencode` |
| Aider | `aider` |

## 5. What counts as a prompt

Producers MUST record:

- Text a person typed or pasted and then submitted, including the pasted part.
- Slash commands as the person typed them, such as `/review 42`, not the instructions they expand to.

Producers MUST NOT record:

- Anything the agent or another program wrote: replies, tool calls and results, prompts the agent writes to its own subagents, notifications from background tasks, and context that the agent or a hook injects.
- Binary content such as images or attachments. Producers MAY leave a placeholder such as `[image]` where it was.

Producers SHOULD NOT record messages that arrive from other programs or sessions as if a person had typed them. When the agent gives no way to tell them apart, the producer SHOULD document that limitation.

Producers SHOULD remove markup the agent adds around pasted text, such as wrapper lines, and keep the pasted text itself.

Producers MAY record the prompt of a scheduled or recurring task each time it runs.

## 6. Secrets and sensitive content

The files are committed and may be published, so producers MUST redact secrets before writing a record. A redacted value is replaced by `[REDACTED:<kind>]`, where `<kind>` is a short slug such as `github-token`.

At minimum, producers MUST detect:

- Private key blocks (`-----BEGIN … PRIVATE KEY-----`)
- API keys and tokens with well-known prefixes, for example those of Anthropic, OpenAI, GitHub, GitLab, AWS, Google, Slack, Stripe and npm
- JSON Web Tokens
- `Bearer` tokens
- Values assigned to environment-style names that contain `SECRET`, `TOKEN`, `PASSWORD`, `API_KEY` or `PRIVATE_KEY`

Redaction is best effort and does not replace a review. People SHOULD read the diff of their prompt files before pushing. A secret that was pushed must be rotated: removing it from history afterwards is not enough.

Producers MUST give people a way to pause recording without uninstalling, such as an environment variable.

## 7. Commits

- Prompt files are committed with the code they led to, in the same commits. Producers SHOULD write each record before the agent acts on the prompt, so that a commit the agent makes during that turn already includes it.
- Producers MUST NOT commit, push or otherwise publish anything themselves. Recording only writes files to the working tree, and the person decides what to commit.

## 8. Versioning

- `v` in records and `version` in `.open-prompts.json` carry the version of this specification.
- Adding fields through the `x_` prefix does not change the version. Any other change to the format increases it.
- A file SHOULD contain records of a single version.

## 9. Conformance

A producer conforms to this specification when it:

1. writes nothing outside repositories that opted in (section 2),
2. writes files and records in the format of sections 3 and 4,
3. records only what section 5 lists as prompts,
4. redacts secrets and offers a pause (section 6),
5. never commits or publishes on its own (section 7).

A JSON Schema for records is available at [`schema/record.v1.json`](schema/record.v1.json). The reference implementation checks files against this specification with `open-prompts validate`.

## Badge

Repositories that follow this specification can say so in their README:

```markdown
[![Open Prompts](https://img.shields.io/badge/prompts-open-2ea44f)](prompts/)
```
