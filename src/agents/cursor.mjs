// Cursor adapter (editor agent and the `agent` CLI share the same hooks).
// Hook: beforeSubmitPrompt in ~/.cursor/hooks.json (https://cursor.com/docs/hooks)
// Cursor also runs Claude Code hooks from ~/.claude/settings.json, with its own payload,
// so the dispatcher sends any payload that looks like Cursor's here, whichever file it
// came from. The generation id then keeps the prompt from being written twice.

import { ignored, resolveProject, writePrompt } from '../core.mjs';

export const AGENT = 'cursor';

const PROMPT_EVENTS = new Set(['beforeSubmitPrompt', 'UserPromptSubmit']);

export function looksLikeCursor(input) {
  return 'cursor_version' in input || 'conversation_id' in input || 'generation_id' in input;
}

/** The first workspace root that opted in, so multi-root workspaces work. */
function projectFor(input, env) {
  const candidates = [env.CURSOR_PROJECT_DIR, ...(Array.isArray(input.workspace_roots) ? input.workspace_roots : []), input.cwd];
  let firstReason = 'no working directory';
  for (const cwd of candidates) {
    const { project, reason } = resolveProject(cwd, env);
    if (project) return { project };
    if (reason === 'recording is paused') return { reason };
    if (typeof cwd === 'string' && cwd) firstReason = reason;
  }
  return { reason: firstReason };
}

export async function handle(input, { env = process.env, now = new Date() } = {}) {
  if (!PROMPT_EVENTS.has(input?.hook_event_name) || typeof input.prompt !== 'string') {
    return ignored(`event ${input?.hook_event_name} is not used`);
  }
  const { project, reason } = projectFor(input, env);
  if (!project) return ignored(reason);
  return writePrompt(project, {
    agent: AGENT,
    agentVersion: input.cursor_version ?? env.CURSOR_VERSION ?? null,
    model: input.model_id ?? input.model ?? null,
    session: input.conversation_id ?? input.session_id,
    id: input.generation_id,
    timestamp: now.toISOString(),
    prompt: input.prompt,
  });
}

/** beforeSubmitPrompt expects an answer. Saying nothing would count as a failed hook. */
export function stdout(input) {
  return PROMPT_EVENTS.has(input?.hook_event_name) ? '{"continue":true}' : '';
}
