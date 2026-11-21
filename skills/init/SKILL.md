---
name: init
description: Enable Open Prompts in the current repository, so that every prompt typed to a coding agent here is recorded as JSONL under prompts/ and can be committed with the code.
disable-model-invocation: true
---

Enable Open Prompts in the current repository.

1. Run `open-prompts init $ARGUMENTS` in a shell. The `open-prompts` command comes with this plugin and is on the `PATH` in Claude Code. In Gemini CLI, run `node "${extensionPath}/bin/open-prompts" init` instead.
2. Report what the command printed, in a few words. Skip any note about installing hooks: this plugin provides them.
3. Tell the user that from now on, every prompt they type to a coding agent in this repository is written to the prompts directory, with the agent, model and session, and that they commit `.open-prompts.json` and that directory with their code. Mention that secrets are redacted on a best-effort basis, so they should read the prompt files in their diff before pushing, and that `open-prompts audit --staged` lists what to read (it also works as a pre-commit hook).

Do not commit anything.
