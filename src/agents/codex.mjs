// OpenAI Codex adapter (CLI, IDE extension and app share the same hooks).
// Hook: UserPromptSubmit in ~/.codex/hooks.json (https://developers.openai.com/codex/hooks)
// The payload carries the prompt, the session and the model. The version is in the
// first line of the transcript, a `session_meta` record.

import { cleanHostMarkup, ignored, readFirstJsonLine, realModel, resolveProject, writePrompt } from '../core.mjs';
import { readState, stateDir, updateState } from '../state.mjs';

export const AGENT = 'codex';

function codexVersion(transcript, session, env) {
  const dir = stateDir(env);
  const cached = readState(dir, session).agent_version;
  if (cached) return cached;
  const meta = readFirstJsonLine(transcript);
  const version = meta?.type === 'session_meta' && typeof meta.payload?.cli_version === 'string' ? meta.payload.cli_version : null;
  if (version) updateState(dir, session, { agent_version: version });
  return version;
}

export async function handle(input, { env = process.env, now = new Date() } = {}) {
  if (input?.hook_event_name !== 'UserPromptSubmit') return ignored(`event ${input?.hook_event_name} is not used`);
  if (input.agent_id) return ignored('prompt inside a subagent');
  if (typeof input.prompt !== 'string') return ignored('no prompt text');
  const { project, reason } = resolveProject(input.cwd, env);
  if (!project) return ignored(reason);
  return writePrompt(project, {
    agent: AGENT,
    agentVersion: codexVersion(input.transcript_path, input.session_id, env),
    model: realModel(input.model),
    session: input.session_id,
    timestamp: now.toISOString(),
    prompt: cleanHostMarkup(input.prompt),
  });
}
