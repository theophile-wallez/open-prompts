// Google Gemini CLI adapter.
// Hook: BeforeAgent, in an extension's hooks/hooks.json or in ~/.gemini/settings.json
// (https://geminicli.com/docs/hooks). The hook blocks the prompt and carries no model,
// so it hands the record to a detached process that waits for the reply in the
// transcript, where each "gemini" message names its model.

import fs from 'node:fs';
import path from 'node:path';
import { fileSize, ignored, poll, readJsonlFrom, readJsonlTail, realModel, resolveProject, waitMsFrom, writePrompt } from '../core.mjs';
import { redact } from '../redact.mjs';

export const AGENT = 'gemini-cli';

const REFERENCED_FILES = /\n*--- Content from referenced files ---[\s\S]*?--- End of content ---\n*/g;
const AUTOMATED_PREFIXES = ['<session_context>', '<hook_context>'];

/** Removes the content Gemini CLI appends for @file references, and its steering prefix. */
export function cleanPrompt(text) {
  return text
    .replace(REFERENCED_FILES, '\n')
    .trim()
    .replace(/^User steering update:\s*/, '')
    .trim();
}

/** The model of the first reply written to the transcript after byte `offset`. */
export function replyModelAfter(transcript, offset) {
  for (const record of readJsonlFrom(transcript, offset)) {
    if (record?.type === 'gemini') {
      const model = realModel(record.model);
      if (model) return model;
    }
  }
  return null;
}

function lastModel(transcript) {
  const records = readJsonlTail(transcript);
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i]?.type === 'gemini' && realModel(records[i].model)) return records[i].model;
  }
  return null;
}

/** Finds the installed Gemini CLI version through the `gemini` command on PATH. */
export function geminiVersion(env = process.env) {
  for (const dir of String(env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    let real;
    try {
      real = fs.realpathSync(path.join(dir, 'gemini'));
    } catch {
      continue;
    }
    for (let current = path.dirname(real), i = 0; i < 6; i++, current = path.dirname(current)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(current, 'package.json'), 'utf8'));
        if (pkg.name === '@google/gemini-cli' && typeof pkg.version === 'string') return pkg.version;
      } catch {
        // Keep walking up.
      }
    }
    return null;
  }
  return null;
}

export async function handle(input, { env = process.env, now = new Date() } = {}) {
  if (input?.hook_event_name !== 'BeforeAgent') return ignored(`event ${input?.hook_event_name} is not used`);
  if (typeof input.prompt !== 'string') return ignored('no prompt text');
  if (AUTOMATED_PREFIXES.some((prefix) => input.prompt.trimStart().startsWith(prefix))) return ignored('automated message');
  const prompt = cleanPrompt(input.prompt);
  if (prompt === '') return ignored('empty prompt');
  const cwd = input.cwd || env.GEMINI_PROJECT_DIR;
  const { project, reason } = resolveProject(cwd, env);
  if (!project) return ignored(reason);
  return {
    action: 'deferred',
    payload: {
      cwd,
      session: input.session_id || env.GEMINI_SESSION_ID,
      timestamp: typeof input.timestamp === 'string' ? input.timestamp : now.toISOString(),
      prompt: redact(prompt).text,
      transcript: input.transcript_path,
      offset: fileSize(input.transcript_path),
    },
  };
}

export async function complete(payload, { env = process.env, waitMs = waitMsFrom(env), signal } = {}) {
  const { project, reason } = resolveProject(payload.cwd, env);
  if (!project) return ignored(reason);
  const model = (await poll(() => replyModelAfter(payload.transcript, payload.offset), { waitMs, signal })) ?? lastModel(payload.transcript);
  return writePrompt(project, {
    agent: AGENT,
    agentVersion: geminiVersion(env),
    model,
    session: payload.session,
    timestamp: payload.timestamp,
    prompt: payload.prompt,
  });
}
