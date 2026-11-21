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

The file MAY hold other fields: options of a producer, such as which redactions to apply (see section 6), which prompts to leave out or how long a pasted text may be (see section 5). Producers MUST ignore fields they do not know, and the options one producer reads may mean nothing to another. Options never change the format of records.

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
- The directory may not exist yet, since git does not keep empty directories. A repository that opted in and has no prompt files is valid, and has no records.

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
- A producer that reads past sessions from several places, such as an agent's transcript and the database of a program that ran the agent, SHOULD write each prompt once, even when the places give it different IDs.
- `model` is recorded as reported and is not normalized. The same model can appear as `claude-opus-5-5` through one provider and as a provider-specific ID through another, and both are correct.
- Producers SHOULD write fields in the order of the table. Consumers MUST NOT depend on field order.
- Producers MUST NOT write fields that are not in the table, except extension fields whose names start with `x_`. Consumers MUST ignore fields they do not recognize.
- Extension fields come after the fields of the table. For example, the reference implementation adds `"x_host":"t3"` and `"x_thread":"<thread ID>"` to the prompts typed in T3 Code, a program that runs coding agents for a person, because one T3 Code thread can span several agent sessions:

```json
{"v":1,"timestamp":"2026-11-20T16:02:11.402Z","agent":"claude-code","agent_version":"2.1.328","model":"claude-opus-5-5","session":"5f0c2a7e-1b9d-4e3a-8c6f-2d4b7a9e1c30","prompt":"Add a login page [image]","x_host":"t3","x_thread":"c41d8e92-7a3b-4f05-9e6d-0b2a5c8f7e14"}
```

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
| Mistral Vibe | `mistral-vibe` |
| Aider | `aider` |

## 5. What counts as a prompt

Producers MUST record:

- Text a person typed or pasted and then submitted, including the pasted part.
- Slash commands as the person typed them, such as `/review 42`, not the instructions they expand to.

A repository MAY ask its producer to leave out prompts it lists, such as slash commands like `/clear` or `/compact`, or prompts that match a pattern, through options in `.open-prompts.json` (section 2). Producers MAY then skip those prompts although the rules above say to record them. Nothing is left out unless the repository asks.

A repository MAY also ask its producer to shorten very long pasted text, such as a log of thousands of lines, through an option in `.open-prompts.json` that sets a limit. Producers MAY then keep the first and last lines of a pasted block longer than the limit and replace the lines in between with a marker that says what was left out, such as `[… 412 lines omitted …]`. When the agent does not mark where pasted text starts and ends, producers MAY shorten the whole prompt in the same way, only when it is longer than the limit. This is a departure from recording the pasted part whole that only a repository can opt into: without the option, pasted text is recorded whole. What is kept is redacted as usual (section 6).

Producers MUST NOT record:

- Anything the agent or another program wrote: replies, tool calls and results, prompts the agent writes to its own subagents, notifications from background tasks, and context that the agent or a hook injects.
- Binary content such as images or attachments, and the local paths where the agent's host saved them. Producers MAY leave a placeholder such as `[image]` where it was. A prompt left with nothing but placeholders is not recorded.

Producers SHOULD NOT record messages that arrive from other programs or sessions as if a person had typed them, such as briefs an agent sends to the agents it delegates to, messages between agent sessions, or prompts a host program sends to name a branch. When the program that runs the agent records who wrote each message, producers SHOULD ask it rather than guess from the text. When nothing tells them apart, the producer SHOULD document that limitation.

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

Producers SHOULD also detect:

- Cookies: the values of `Cookie` and `Set-Cookie` headers, cookies given to command-line tools (such as `--cookie=…` or curl's `-b`), and session parameters such as `sessionId=`, `sid=`, `connect.sid=` or `PHPSESSID=` when their value is long enough to be a secret.
- Passwords next to a credential: a password-like word that follows an email address, on the same line or alone on the next one, as in `jane@example.com Tr0ub4dor&3`, in which case the email address is redacted too, and the password in a URL (`scheme://user:password@host`). An email address on the same line as a password introduced by a keyword is part of the credentials too.
- Passwords introduced by a keyword, in the languages people write their prompts in: `password: …`, `mot de passe : …`, `la contraseña es …`, `das Passwort ist …`, `пароль: …`, `密码是…`. A sentence about a password, such as "the password is required", is not one.
- A prompt that is nothing but a password or an email address.

Rules that guess SHOULD prefer leaving a value over destroying ordinary text, and producers SHOULD offer a way to check what they left (the reference implementation has `open-prompts audit`).

Producers SHOULD replace the home directory in paths, such as `/Users/<name>`, `/home/<name>`, `C:\Users\<name>` or, under WSL, `/mnt/c/Users/<name>`, with `~`, because it carries the name of the person's account. This is not a secret, so it gets no `[REDACTED:…]` marker. Producers MAY let a repository turn on redactions beyond those of this section, such as every email address, or turn off the ones this section says SHOULD, such as home directories, through options in `.open-prompts.json` (section 2). The redactions this section says MUST cannot be turned off.

Redaction is best effort and does not replace a review. People SHOULD read the diff of their prompt files before pushing. A secret that was pushed must be rotated: removing it from history afterwards is not enough.

Producers MUST give people a way to pause recording without uninstalling, such as an environment variable.

## 7. Commits

- Prompt files are committed with the code they led to, in the same commits. Producers SHOULD write each record before the agent acts on the prompt, so that a commit the agent makes during that turn already includes it.
- Producers MUST NOT commit, push or otherwise publish anything themselves. Recording only writes files to the working tree, and the person decides what to commit.
- Producers MAY keep a copy of the records they write outside the repository, on the person's machine, for example to restore the records of a checkout that was deleted before they were committed. Such a copy holds only records of repositories that opted in, redacted as in the prompt files, and is never published. A record restored from it is added under the rules of section 3, once.

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
