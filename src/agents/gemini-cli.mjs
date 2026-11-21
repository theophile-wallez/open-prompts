// Google Gemini CLI adapter.
// Hook: BeforeAgent, in an extension's hooks/hooks.json or in ~/.gemini/settings.json
// (https://geminicli.com/docs/hooks). The hook blocks the prompt and carries no model,
// so it hands the record to a detached process that waits for the reply in the
// transcript, where each "gemini" message names its model.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanHostMarkup, fileSize, ignored, isHostAutomated, parseJsonLines, poll, projectIgnores, readJsonlFrom, readJsonlTail, realModel, redactOptions, resolveProject, waitMsFrom, writePrompt } from '../core.mjs';
import { redact } from '../redact.mjs';
import { t3Origin, withT3Note } from '../t3.mjs';

export const AGENT = 'gemini-cli';

const REFERENCED_FILES = /\n*--- Content from referenced files ---[\s\S]*?--- End of content ---\n*/g;
const AUTOMATED_PREFIXES = ['<session_context>', '<hook_context>'];

/** Removes the content Gemini CLI appends for @file references, its steering prefix, and host markup. */
export function cleanPrompt(text) {
  return cleanHostMarkup(
    text
      .replace(REFERENCED_FILES, '\n')
      .trim()
      .replace(/^User steering update:\s*/, '')
      .trim(),
  );
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
  const session = input.session_id || env.GEMINI_SESSION_ID;
  // Under T3 Code, its database says who wrote the message. Otherwise, the text rules decide.
  const t3 = await t3Origin(prompt, { env, session });
  if (t3?.automated) return withT3Note(ignored(t3.automated), t3);
  if (!t3?.typed && isHostAutomated(input.prompt)) return withT3Note(ignored('automated message'), t3);
  // Checked here too, so that the pending file never holds a prompt the project leaves out.
  const skip = projectIgnores(project, prompt);
  if (skip) return ignored(skip);
  return {
    action: 'deferred',
    payload: {
      cwd,
      session,
      timestamp: typeof input.timestamp === 'string' ? input.timestamp : now.toISOString(),
      prompt: redact(prompt, redactOptions(project)).text,
      transcript: input.transcript_path,
      offset: fileSize(input.transcript_path),
      extensions: t3?.extensions,
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
    extensions: payload.extensions,
  }, { env });
}

// ---------------------------------------------------------------------------
// Importing past sessions from chat files
//
// Gemini CLI keeps each session under ~/.gemini/tmp/<project>/chats/: `session-*.jsonl`
// (a metadata line with sessionId, projectHash and kind, then one line per message, and
// `$set` lines that update the metadata), or `session-*.json` in older versions (one
// object with a `messages` list). <project> is a short name, with the project's path in
// a `.project_root` file next to `chats/`, or, in older versions, the SHA-256 of the path,
// which is also `projectHash`.

/** Gemini CLI's directory: ~/.gemini, or .gemini under GEMINI_CLI_HOME. */
export const geminiDir = (env = process.env) => path.join(env.GEMINI_CLI_HOME || os.homedir(), '.gemini');

/** The SHA-256 Gemini CLI uses to name a project's directory. */
export const projectHash = (root) => crypto.createHash('sha256').update(root).digest('hex');

/** Every chat file, as { file, root }, where `root` is the project's path when Gemini CLI wrote it down. */
export function listGeminiChats(env = process.env) {
  const tmp = path.join(geminiDir(env), 'tmp');
  let named = {};
  try {
    named = JSON.parse(fs.readFileSync(path.join(geminiDir(env), 'projects.json'), 'utf8')).projects ?? {};
  } catch {
    // Older versions have no projects.json.
  }
  const roots = new Map(Object.entries(named).map(([root, name]) => [name, root]));
  let dirs;
  try {
    dirs = fs.readdirSync(tmp, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    return [];
  }
  return dirs.flatMap(({ name }) => {
    let root = roots.get(name) ?? null;
    try {
      root = fs.readFileSync(path.join(tmp, name, '.project_root'), 'utf8').trim() || root;
    } catch {
      // No .project_root: the directory name may be the hash of the path.
    }
    let files;
    try {
      files = fs.readdirSync(path.join(tmp, name, 'chats')).filter((file) => /^session-.*\.jsonl?$/.test(file));
    } catch {
      return [];
    }
    return files.map((file) => ({ file: path.join(tmp, name, 'chats', file), root, dirName: name }));
  });
}

/** Reads a chat file as { meta, messages }, whether JSON Lines or a single JSON object. */
export function readGeminiChat(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { meta: null, messages: [] };
  }
  if (file.endsWith('.json')) {
    try {
      const { messages, ...meta } = JSON.parse(text);
      return { meta, messages: Array.isArray(messages) ? messages : [] };
    } catch {
      return { meta: null, messages: [] };
    }
  }
  const lines = parseJsonLines(text);
  const meta = { ...(lines[0]?.sessionId ? lines[0] : {}) };
  const messages = new Map();
  for (const line of lines) {
    if (line?.$set && typeof line.$set === 'object') Object.assign(meta, line.$set);
    // A message written again (edited or updated) keeps its place and takes the new content.
    else if (typeof line?.type === 'string' && line.id) messages.set(line.id, line);
  }
  return { meta: meta.sessionId ? meta : null, messages: [...messages.values()] };
}

const textOf = (content) => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const texts = content.filter((part) => typeof part?.text === 'string').map((part) => part.text);
  return texts.length > 0 ? texts.join('') : null;
};

/**
 * The prompts of a chat file, as import candidates (see backfill.mjs). The model is that of
 * the first reply, else the last one the session used before the prompt.
 */
export function chatPrompts(file) {
  const { meta, messages } = readGeminiChat(file);
  if (!meta || (meta.kind && meta.kind !== 'main')) return [];
  const prompts = [];
  let lastModel = null;
  let current = null;
  // A session reloaded by its host starts again with <session_context>, and the host may
  // send the first prompt again: a prompt the session already had is not recorded twice then.
  let reloaded = false;
  for (const message of messages) {
    if (message.type === 'gemini') {
      const model = realModel(message.model);
      if (model && current && current.model === null) current.model = model;
      lastModel = model ?? lastModel;
      continue;
    }
    if (message.type !== 'user') continue;
    const raw = textOf(message.content);
    if (raw === null) continue;
    if (AUTOMATED_PREFIXES.some((prefix) => raw.trimStart().startsWith(prefix))) {
      reloaded = prompts.length > 0;
      continue;
    }
    const prompt = cleanPrompt(raw);
    if (prompt === '') continue;
    const replay = reloaded && prompts.some((earlier) => earlier.prompt === prompt);
    reloaded = false;
    if (replay) continue;
    current = {
      source: 'gemini',
      agent: AGENT,
      agentVersion: null,
      model: null,
      before: lastModel,
      session: meta.sessionId,
      id: typeof message.id === 'string' ? message.id : undefined,
      timestamp: message.timestamp,
      prompt,
      automated: isHostAutomated(raw) ? 'automated message' : null,
    };
    prompts.push(current);
  }
  return prompts.map(({ before, ...prompt }) => ({ ...prompt, model: prompt.model ?? before }));
}
