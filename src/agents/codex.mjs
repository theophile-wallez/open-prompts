// OpenAI Codex adapter (CLI, IDE extension and app share the same hooks).
// Hook: UserPromptSubmit in ~/.codex/hooks.json (https://developers.openai.com/codex/hooks)
// The payload carries the prompt, the session and the model. The version is in the
// first line of the transcript, a `session_meta` record.
//
// Import: Codex keeps each session as a "rollout" file under ~/.codex/sessions/YYYY/MM/DD/
// (and ~/.codex/archived_sessions/). Its first line is `session_meta` (id, cwd,
// cli_version), each turn has a `turn_context` with the model, and what the person typed
// is an `event_msg` of type `user_message`.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanHostMarkup, ignored, isHostAutomated, parseJsonLines, readFirstJsonLine, realModel, resolveProject, scanJsonlHead, walkFiles, writePrompt } from '../core.mjs';
import { readState, stateDir, updateState } from '../state.mjs';
import { t3Origin, withT3Note } from '../t3.mjs';

export const AGENT = 'codex';

/** Codex's home: CODEX_HOME, or ~/.codex. */
export const codexHome = (env = process.env) => env.CODEX_HOME || path.join(os.homedir(), '.codex');

function codexVersion(transcript, session, env) {
  const dir = stateDir(env);
  const cached = readState(dir, session).agent_version;
  if (cached) return cached;
  const meta = readFirstJsonLine(transcript);
  const version = meta?.type === 'session_meta' && typeof meta.payload?.cli_version === 'string' ? meta.payload.cli_version : null;
  if (version) updateState(dir, session, { agent_version: version });
  return version;
}

const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp|bmp|heic|tiff?)$/i;
const REQUEST_MARKER = '## My request for Codex:';

/**
 * Removes the context the Codex app writes around what the person typed: sections such as
 * "# In app browser:", "# Selected text:" or "# Files mentioned by the user:", followed by
 * "## My request for Codex:" and the request. Mentioned files become [image] or [file],
 * and `[Image #1]` becomes [image]. Then removes host markup, as for every agent.
 */
export function cleanCodexPrompt(text) {
  let out = String(text ?? '');
  const marker = out.lastIndexOf(REQUEST_MARKER);
  if (marker >= 0 && /^\s*# [^\n]+:\s*\n/.test(out)) {
    const context = out.slice(0, marker);
    const files = /# Files mentioned by the user:\n([\s\S]*?)(?=\n# |$)/.exec(context)?.[1] ?? '';
    const placeholders = [...files.matchAll(/^## ([^\n:]+):/gm)].map(([, name]) => (IMAGE_FILE.test(name.trim()) ? '[image]' : '[file]'));
    out = [out.slice(marker + REQUEST_MARKER.length).trim(), ...placeholders].filter(Boolean).join(' ');
  }
  const hasImage = /\[Image #\d+\]/.test(out);
  out = out.replace(/\[Image #\d+\]/g, '[image]').replace(/\[external unsupported block: image\]/g, hasImage ? '' : '[image]');
  return cleanHostMarkup(out);
}

export async function handle(input, { env = process.env, now = new Date() } = {}) {
  if (input?.hook_event_name !== 'UserPromptSubmit') return ignored(`event ${input?.hook_event_name} is not used`);
  if (input.agent_id) return ignored('prompt inside a subagent');
  if (typeof input.prompt !== 'string') return ignored('no prompt text');
  const { project, reason } = resolveProject(input.cwd, env);
  if (!project) return ignored(reason);
  const prompt = cleanCodexPrompt(input.prompt);
  // Under T3 Code, its database says who wrote the message. Otherwise, the text rules decide.
  const t3 = await t3Origin(prompt, { env, session: input.session_id });
  if (t3?.automated) return withT3Note(ignored(t3.automated), t3);
  if (!t3?.typed && isHostAutomated(input.prompt)) return withT3Note(ignored('automated message'), t3);
  const result = writePrompt(project, {
    agent: AGENT,
    agentVersion: codexVersion(input.transcript_path, input.session_id, env),
    model: realModel(input.model),
    session: input.session_id,
    timestamp: now.toISOString(),
    prompt,
    extensions: t3?.extensions,
  }, { env });
  return withT3Note(result, t3);
}

// ---------------------------------------------------------------------------
// Importing past sessions from rollout files

/** Every rollout file of Codex, active and archived. */
export function listRollouts(env = process.env) {
  const home = codexHome(env);
  const isRollout = (name) => name.startsWith('rollout-') && name.endsWith('.jsonl');
  return [...walkFiles(path.join(home, 'sessions'), isRollout), ...walkFiles(path.join(home, 'archived_sessions'), isRollout)];
}

/** The `session_meta` of a rollout file (its first line), or null. */
export function rolloutMeta(file) {
  let meta = null;
  scanJsonlHead(file, (entry) => {
    if (entry?.type === 'session_meta' && entry.payload?.id) meta = { ...entry.payload, written: entry.timestamp };
    return true;
  });
  return meta;
}

/**
 * The IDs of the sessions Codex imported from another agent, such as Claude Code. Their
 * prompts are the other agent's, and their timestamps are those of the import.
 */
export function importedSessions(env = process.env) {
  try {
    const { records } = JSON.parse(fs.readFileSync(path.join(codexHome(env), 'external_agent_session_imports.json'), 'utf8'));
    return new Set((records ?? []).map((record) => record?.imported_thread_id).filter(Boolean));
  } catch {
    return new Set();
  }
}

/** Why a whole Codex session holds no prompt a person typed, or null. */
export function skippedSession(meta, imported = new Set()) {
  if (!meta) return 'not a Codex rollout';
  if (meta.source?.subagent || meta.thread_source === 'subagent' || meta.agent_role) return "a Codex sub-agent's session";
  if (imported.has(meta.id)) return 'Codex imported it from another agent';
  return null;
}

// A fork's rollout starts with a copy of its parent's history, written at once when the
// fork is made. Prompts written that close to the start are copies.
const FORK_COPY_MS = 2000;

/**
 * The prompts of a rollout file, as import candidates (see backfill.mjs). The model is
 * that of the prompt's turn (its `turn_context`), else the last one the session used.
 */
export function rolloutPrompts(file, { imported = new Set() } = {}) {
  let entries;
  try {
    entries = parseJsonLines(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  const meta = entries.find((entry) => entry?.type === 'session_meta')?.payload;
  if (skippedSession(meta, imported)) return [];
  const forkedAt = meta.forked_from_id ? Date.parse(entries[0]?.timestamp) : NaN;
  const prompts = [];
  let lastModel = null;
  // The model of the current turn, from its turn_context, and a prompt of that turn still without one.
  let turnModel = null;
  let waiting = null;
  for (const entry of entries) {
    if (entry?.type === 'event_msg' && entry.payload?.type === 'task_started') {
      turnModel = null;
      waiting = null;
      continue;
    }
    if (entry?.type === 'turn_context') {
      turnModel = realModel(entry.payload?.model) ?? turnModel;
      lastModel = turnModel ?? lastModel;
      if (waiting && turnModel) waiting.model = turnModel;
      waiting = null;
      continue;
    }
    if (entry?.type !== 'event_msg' || entry.payload?.type !== 'user_message' || typeof entry.payload.message !== 'string') continue;
    if (Date.parse(entry.timestamp) - forkedAt < FORK_COPY_MS) continue;
    const prompt = cleanCodexPrompt(entry.payload.message);
    if (prompt === '') continue;
    const candidate = {
      source: 'codex',
      agent: AGENT,
      agentVersion: typeof meta.cli_version === 'string' ? meta.cli_version : null,
      model: turnModel,
      before: lastModel,
      session: meta.id,
      timestamp: entry.timestamp,
      prompt,
      automated: isHostAutomated(entry.payload.message) ? 'automated message' : null,
    };
    if (turnModel === null) waiting = candidate;
    prompts.push(candidate);
  }
  return prompts.map(({ before, ...prompt }) => ({ ...prompt, model: prompt.model ?? before }));
}
