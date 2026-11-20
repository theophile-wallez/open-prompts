// GitHub Copilot CLI adapter (also used by the Copilot harness in VS Code).
// Hook: userPromptSubmitted in ~/.copilot/hooks/*.json
// (https://docs.github.com/en/copilot/reference/hooks-reference). The payload has no
// model or version, so a detached process reads them from the session's events.jsonl:
// the model from the reply's `assistant.usage` event, the version from `session.start`.

import os from 'node:os';
import path from 'node:path';
import { fileSize, ignored, poll, readFirstJsonLine, readJsonlFrom, readJsonlTail, realModel, resolveProject, waitMsFrom, writePrompt } from '../core.mjs';
import { redact } from '../redact.mjs';

export const AGENT = 'copilot';

const PROMPT_EVENTS = new Set(['userPromptSubmitted', 'UserPromptSubmit']);

export const copilotHome = (env = process.env) => env.COPILOT_HOME || path.join(os.homedir(), '.copilot');

export function looksLikeCopilot(input) {
  if ('sessionId' in input || input.hook_event_name === 'userPromptSubmitted') return true;
  // Copilot's Claude-compatible payload: snake_case, an ISO timestamp, and none of the
  // fields Claude Code always sends.
  return typeof input.timestamp === 'string' && !('transcript_path' in input) && !('permission_mode' in input);
}

export function eventsFile(session, env = process.env) {
  return path.join(copilotHome(env), 'session-state', session.replace(/[^A-Za-z0-9_.-]/g, '-'), 'events.jsonl');
}

export function replyModelAfter(events, offset) {
  for (const event of readJsonlFrom(events, offset)) {
    if (event?.type === 'assistant.usage') {
      const model = realModel(event.data?.model);
      if (model) return model;
    }
  }
  return null;
}

function sessionModel(events) {
  const records = readJsonlTail(events);
  for (let i = records.length - 1; i >= 0; i--) {
    const { type, data } = records[i] ?? {};
    if (type === 'session.model_change' && realModel(data?.newModel)) return data.newModel;
    if (type === 'assistant.usage' && realModel(data?.model)) return data.model;
  }
  const start = readFirstJsonLine(events);
  return start?.type === 'session.start' ? realModel(start.data?.selectedModel) : null;
}

function copilotVersion(events) {
  const start = readFirstJsonLine(events);
  return start?.type === 'session.start' && typeof start.data?.copilotVersion === 'string' ? start.data.copilotVersion : null;
}

export async function handle(input, { env = process.env, now = new Date() } = {}) {
  if (!PROMPT_EVENTS.has(input?.hook_event_name ?? 'userPromptSubmitted') || typeof input.prompt !== 'string') {
    return ignored(`event ${input?.hook_event_name} is not used`);
  }
  if (input.agentId || input.agent_id) return ignored('prompt inside a subagent');
  const session = input.sessionId ?? input.session_id;
  if (typeof session !== 'string' || session === '') return ignored('no session id');
  const { project, reason } = resolveProject(input.cwd, env);
  if (!project) return ignored(reason);
  const timestamp =
    typeof input.timestamp === 'number' ? new Date(input.timestamp).toISOString() : typeof input.timestamp === 'string' ? input.timestamp : now.toISOString();
  const events = eventsFile(session, env);
  return {
    action: 'deferred',
    payload: { cwd: input.cwd, session, timestamp, prompt: redact(input.prompt.trim()).text, events, offset: fileSize(events) },
  };
}

export async function complete(payload, { env = process.env, waitMs = waitMsFrom(env), signal } = {}) {
  const { project, reason } = resolveProject(payload.cwd, env);
  if (!project) return ignored(reason);
  const model = (await poll(() => replyModelAfter(payload.events, payload.offset), { waitMs, signal })) ?? sessionModel(payload.events);
  return writePrompt(project, {
    agent: AGENT,
    agentVersion: copilotVersion(payload.events),
    model,
    session: payload.session,
    timestamp: payload.timestamp,
    prompt: payload.prompt,
  });
}
