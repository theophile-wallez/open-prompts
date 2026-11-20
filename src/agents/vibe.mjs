// Mistral Vibe adapter.
// Hook: pre_agent in ~/.vibe/hooks.toml, with match = "main" so it runs for the main
// session only (https://github.com/mistralai/mistral-vibe). The hook blocks the message
// and carries no model, so it hands the record to a detached process. That process waits
// for the first reply in the session's messages.jsonl, then reads the model from the
// session's meta.json, where Vibe syncs a /model change when the message is sent.

import fs from 'node:fs';
import path from 'node:path';
import { cleanHostMarkup, fileSize, ignored, poll, readJsonlFrom, realModel, resolveProject, waitMsFrom, writePrompt } from '../core.mjs';
import { redact } from '../redact.mjs';

export const AGENT = 'mistral-vibe';

const VIBE_EVENTS = new Set(['pre_agent', 'pre_llm', 'post_llm', 'post_agent', 'pre_tool', 'post_tool', 'notification', 'session_start', 'session_end']);

export const looksLikeVibe = (input) => VIBE_EVENTS.has(input?.hook_event_name);

const messagesFile = (sessionDir) => path.join(sessionDir, 'messages.jsonl');

/** Whether an assistant message was written after byte `offset`. */
export function replied(sessionDir, offset) {
  return readJsonlFrom(messagesFile(sessionDir), offset).some((message) => message?.role === 'assistant') || null;
}

/** The session's model: the provider's name for it, or Vibe's alias. */
export function sessionModel(sessionDir) {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(sessionDir, 'meta.json'), 'utf8')).config ?? {};
    return realModel(config.model_name) ?? realModel(config.active_model);
  } catch {
    return null;
  }
}

/**
 * Finds the installed Vibe version through the `vibe` command on PATH. uv and pipx
 * install it in a virtual environment whose site-packages holds mistral_vibe-<version>.dist-info.
 */
export function vibeVersion(env = process.env) {
  for (const dir of String(env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    let real;
    try {
      real = fs.realpathSync(path.join(dir, 'vibe'));
    } catch {
      continue;
    }
    for (let current = path.dirname(real), i = 0; i < 4; i++, current = path.dirname(current)) {
      const lib = path.join(current, 'lib');
      let pythons = [];
      try {
        pythons = fs.readdirSync(lib).filter((name) => name.startsWith('python'));
      } catch {
        continue;
      }
      for (const python of pythons) {
        try {
          for (const name of fs.readdirSync(path.join(lib, python, 'site-packages'))) {
            const match = /^mistral_vibe-(.+)\.dist-info$/.exec(name);
            if (match) return match[1];
          }
        } catch {
          // No site-packages here.
        }
      }
    }
    return null;
  }
  return null;
}

export async function handle(input, { env = process.env, now = new Date() } = {}) {
  if (input?.hook_event_name !== 'pre_agent') return ignored(`event ${input?.hook_event_name} is not used`);
  if (input.parent_session_id) return ignored('prompt inside a subagent');
  if (typeof input.prompt !== 'string') return ignored('no prompt text');
  const prompt = cleanHostMarkup(input.prompt).trim();
  if (prompt === '') return ignored('empty prompt');
  const cwd = input.cwd || env.VIBE_CWD;
  const { project, reason } = resolveProject(cwd, env);
  if (!project) return ignored(reason);
  const sessionDir = typeof input.transcript_path === 'string' ? input.transcript_path : '';
  return {
    action: 'deferred',
    payload: {
      cwd,
      session: input.session_id,
      timestamp: now.toISOString(),
      prompt: redact(prompt).text,
      sessionDir,
      offset: sessionDir ? fileSize(messagesFile(sessionDir)) : 0,
    },
  };
}

export async function complete(payload, { env = process.env, waitMs = waitMsFrom(env), signal } = {}) {
  const { project, reason } = resolveProject(payload.cwd, env);
  if (!project) return ignored(reason);
  if (payload.sessionDir) await poll(() => replied(payload.sessionDir, payload.offset), { waitMs, signal });
  return writePrompt(project, {
    agent: AGENT,
    agentVersion: vibeVersion(env),
    model: payload.sessionDir ? sessionModel(payload.sessionDir) : null,
    session: payload.session,
    timestamp: payload.timestamp,
    prompt: payload.prompt,
  });
}
