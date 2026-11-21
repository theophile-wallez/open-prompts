// Claude Code adapter: hook events and transcripts.
// Hooks: SessionStart, PostModelSwitch, UserPromptSubmit (https://code.claude.com/docs/en/hooks)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanHostMarkup, ignored, isHostAutomated, isHostSession, parseJsonLines, poll, readJsonlTail, realModel, resolveProject, scanJsonlHead, waitMsFrom, writePrompt } from '../core.mjs';
import { pruneState, readState, stateDir, updateState } from '../state.mjs';
import { t3Origin, withT3Note } from '../t3.mjs';

export const AGENT = 'claude-code';

// Text that Claude Code itself passes to UserPromptSubmit or writes to the transcript
// without a person typing it.
const AUTOMATED_PREFIXES = [
  '<task-notification',
  '<local-command-',
  '<bash-input',
  '<bash-stdout',
  '<bash-stderr',
  '<system-reminder',
  '[Request interrupted by user',
  'Caveat: The messages below were generated',
];

/** Whether Claude Code wrote this text itself. */
export const isClaudeAutomated = (text) => AUTOMATED_PREFIXES.some((prefix) => text.trimStart().startsWith(prefix));

const PASTE_START = /^<pasted_content(?: id="[^"]*")?>$/;
const PASTE_END = /^<\/pasted_content(?: id="[^"]*")?>$/;

/**
 * Removes the wrapper lines Claude Code puts around pasted text, and keeps the text.
 * Returns { prompt, pastes }: `pastes` lists the text of each pasted block, as it appears in
 * `prompt`, for "maxPasteLength", or is undefined when the text has no wrapper lines.
 */
export function splitPastes(text) {
  const kept = [];
  const pastes = [];
  let block = null;
  let marked = false;
  const close = () => {
    if (block?.length) pastes.push(block.join('\n'));
    block = null;
  };
  for (const line of cleanHostMarkup(text).split('\n')) {
    if (PASTE_START.test(line.trim())) {
      close();
      marked = true;
      block = [];
    } else if (PASTE_END.test(line.trim())) {
      close();
      marked = true;
    } else {
      kept.push(line);
      block?.push(line);
    }
  }
  close();
  return { prompt: kept.join('\n').trim(), pastes: marked ? pastes : undefined };
}

/** Removes the wrapper lines Claude Code puts around pasted text, and keeps the text. */
export const cleanPrompt = (text) => splitPastes(text).prompt;

/** Reads the Claude Code version from the environment Claude Code gives its hooks. */
export function detectVersion(env = process.env) {
  const agent = /^claude-code_(\d+)-(\d+)-(\d+)/.exec(env.AI_AGENT ?? '');
  if (agent) return agent.slice(1, 4).join('.');
  const exec = env.CLAUDE_CODE_EXECPATH ? path.basename(env.CLAUDE_CODE_EXECPATH) : '';
  if (/^\d+\.\d+\.\d+/.test(exec)) return exec;
  return null;
}

/** Finds the latest model and Claude Code version mentioned in transcript entries. */
export function lastSeen(entries) {
  let model = null;
  let version = null;
  for (let i = entries.length - 1; i >= 0 && (model === null || version === null); i--) {
    const entry = entries[i];
    if (model === null && entry.type === 'assistant' && !entry.isSidechain) model = realModel(entry.message?.model);
    if (version === null && typeof entry.version === 'string') version = entry.version;
  }
  return { model, version };
}

/** The model of the first reply to `promptId`, if the transcript already has one. */
export function replyModel(entries, promptId) {
  let found = false;
  for (const entry of entries) {
    if (entry.isSidechain) continue;
    if (entry.type === 'user' && entry.promptId === promptId && entry.toolUseResult === undefined) found = true;
    else if (found && entry.type === 'assistant') {
      const model = realModel(entry.message?.model);
      if (model) return model;
    }
  }
  return null;
}

/**
 * Handles one Claude Code hook event and returns what it did.
 *
 * UserPromptSubmit runs as an async hook, so it can wait for the agent's first reply
 * (up to `waitMs`) to learn which model answered. Aborting `signal` writes at once.
 */
export async function handle(input, { env = process.env, now = new Date(), waitMs = waitMsFrom(env), signal } = {}) {
  const session = input?.session_id;
  if (typeof session !== 'string' || session === '') return ignored('no session id');
  const { project, reason } = resolveProject(input.cwd || env.CLAUDE_PROJECT_DIR || process.cwd(), env);
  if (!project) return ignored(reason);

  const dir = stateDir(env);
  switch (input.hook_event_name) {
    case 'SessionStart':
      pruneState(dir);
      updateState(dir, session, { model: realModel(input.model), agent_version: detectVersion(env) });
      return { action: 'state' };
    case 'PostModelSwitch':
      updateState(dir, session, { model: realModel(input.to_model) });
      return { action: 'state' };
    case 'UserPromptSubmit':
      break;
    default:
      return ignored(`event ${input.hook_event_name} is not used`);
  }

  if (input.agent_id) return ignored('prompt inside a subagent');
  const raw = typeof input.prompt === 'string' ? input.prompt : input.prompt_text;
  if (typeof raw !== 'string') return ignored('no prompt text');
  if (isClaudeAutomated(raw)) return ignored('automated message');
  // A session a host runs for its own needs, such as naming a branch: all of it is the host's.
  if (readState(dir, session).host_session) return ignored('session run by the host');
  if (isHostSession(raw)) {
    updateState(dir, session, { host_session: true });
    return ignored('session run by the host');
  }
  const { prompt, pastes } = splitPastes(raw);
  if (prompt === '') return ignored('empty prompt');
  // Under T3 Code, its database says who wrote the message. Otherwise, the text rules decide.
  const t3 = await t3Origin(prompt, { env, session });
  if (t3?.automated) return withT3Note(ignored(t3.automated), t3);
  if (!t3?.typed && isHostAutomated(raw)) return withT3Note(ignored('automated message'), t3);
  const promptId = typeof input.prompt_id === 'string' ? input.prompt_id : undefined;
  const timestamp = now.toISOString();

  // Best source: the model that wrote the reply. Then the model the session reported
  // on SessionStart or PostModelSwitch. Then the last model seen in the transcript.
  // The transcript of a new session may not exist yet when its first prompt arrives.
  const transcript = input.transcript_path;
  let model =
    promptId && typeof transcript === 'string' && transcript !== ''
      ? await poll(() => replyModel(readJsonlTail(transcript, 1 << 18), promptId), { waitMs, signal })
      : null;
  const state = readState(dir, session);
  let agentVersion = state.agent_version ?? detectVersion(env);
  model ??= state.model ?? null;
  if (model === null || agentVersion === null) {
    const seen = lastSeen(readJsonlTail(transcript));
    model ??= seen.model;
    agentVersion ??= seen.version;
  }
  return withT3Note(
    writePrompt(project, { agent: AGENT, agentVersion, model, session, id: promptId, timestamp, prompt, pastes, extensions: t3?.extensions }, { env }),
    t3,
  );
}

// ---------------------------------------------------------------------------
// Importing past sessions from transcripts

function userText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  if (content.some((block) => block?.type === 'tool_result')) return null;
  const texts = content.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text);
  return texts.length > 0 ? texts.join('\n') : null;
}

/** Turns the markup Claude Code stores for a slash command back into what the person typed. */
function typedCommand(text) {
  const name = /<command-name>([^<]*)<\/command-name>/.exec(text)?.[1]?.trim();
  if (!name) return text;
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim() ?? '';
  return `${name.startsWith('/') ? name : `/${name}`} ${args}`.trim();
}

/**
 * Extracts the prompts a person typed from the entries of a Claude Code transcript.
 *
 * The model is the one that wrote the first reply. A turn cut short has no reply, so its
 * model is the last one the session used before it, or else the first one after it.
 * With `withAutomated`, messages that only the text rules call a host's (such as a
 * message from another session) are kept with `automated` set, so that a host that knows
 * better, such as T3 Code, can decide.
 */
export function extractPrompts(entries, { withAutomated = false } = {}) {
  const prompts = [];
  const models = [];
  let current = null;
  let lastModel = null;
  let started = false;
  entries.forEach((entry, index) => {
    if (entry.isSidechain) return;
    if (entry.type === 'assistant') {
      const model = realModel(entry.message?.model);
      if (!model) return;
      if (current && current.model === null) current.model = model;
      lastModel = model;
      models.push({ index, model });
      return;
    }
    // A message typed while the agent was working is stored as a queued command.
    const queued = entry.type === 'attachment' && entry.attachment?.type === 'queued_command';
    if (queued && entry.attachment.commandMode !== 'prompt') return;
    if (!queued && (entry.type !== 'user' || entry.isMeta || entry.isCompactSummary || entry.isVisibleInTranscriptOnly)) return;
    if (entry.toolUseResult !== undefined) return;
    // Turns Claude Code started on its own, such as background task notifications.
    if (entry.promptSource === 'system' || (entry.origin && entry.origin.kind !== 'human')) return;
    const text = queued ? (typeof entry.attachment.prompt === 'string' ? entry.attachment.prompt : null) : userText(entry.message?.content);
    if (text === null || isClaudeAutomated(text)) return;
    // A session a host runs for its own needs, such as naming a branch, is skipped whole.
    if (!started && isHostSession(text)) {
      started = null;
      return;
    }
    if (started === null) return;
    started = true;
    const automated = isHostAutomated(text) ? 'automated message' : null;
    if (automated && !withAutomated) return;
    const { prompt, pastes } = splitPastes(typedCommand(text));
    if (prompt === '' || typeof entry.sessionId !== 'string') return;
    current = {
      id: queued ? (entry.attachment.source_uuid ?? entry.uuid) : (entry.promptId ?? entry.uuid),
      timestamp: entry.timestamp,
      session: entry.sessionId,
      agentVersion: typeof entry.version === 'string' ? entry.version : null,
      model: null,
      prompt,
      ...(pastes ? { pastes } : {}),
      ...(withAutomated ? { automated } : {}),
      before: lastModel,
      index,
    };
    prompts.push(current);
  });
  return prompts.map(({ before, index, ...prompt }) => ({
    ...prompt,
    model: prompt.model ?? before ?? models.find((seen) => seen.index > index)?.model ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Finding transcripts

/** Claude Code's configuration directory: CLAUDE_CONFIG_DIR, or ~/.claude. */
export const claudeConfigDir = (env = process.env) => env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

/** Where Claude Code keeps transcripts: one folder per working directory, one file per session. */
export const claudeProjectsDir = (env = process.env) => path.join(claudeConfigDir(env), 'projects');

/** Every transcript file, as { folder, file, session }. The session is the file name. */
export function listTranscripts(env = process.env) {
  const base = claudeProjectsDir(env);
  let folders;
  try {
    folders = fs.readdirSync(base, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    return [];
  }
  return folders.flatMap(({ name: folder }) => {
    try {
      return fs
        .readdirSync(path.join(base, folder))
        .filter((name) => name.endsWith('.jsonl'))
        .map((name) => ({ folder, file: path.join(base, folder, name), session: name.slice(0, -'.jsonl'.length) }));
    } catch {
      return [];
    }
  });
}

/**
 * Reads the start of a transcript until an entry has a working directory, which the first
 * entries do. Returns { cwd, version, branch }, with null for what it did not find.
 */
export function transcriptHead(file) {
  const head = { cwd: null, version: null, branch: null };
  scanJsonlHead(file, (entry) => {
    head.version ??= typeof entry.version === 'string' ? entry.version : null;
    head.branch ??= typeof entry.gitBranch === 'string' && entry.gitBranch !== '' ? entry.gitBranch : null;
    if (typeof entry.cwd === 'string' && entry.cwd !== '') head.cwd = entry.cwd;
    return head.cwd !== null;
  });
  return head;
}

/**
 * Parses the entries of a transcript that can hold a prompt or a model. Transcripts are
 * mostly tool output, so lines are first checked as text: keys are written unescaped, and
 * the same characters inside a value are escaped, so these checks never skip a prompt.
 */
export function promptEntries(text) {
  const lines = text.split('\n');
  const wanted = lines.filter(
    (line) => !line.includes(',"toolUseResult":') && (line.includes('"type":"user"') || line.includes('"type":"assistant"') || line.includes('"queued_command"')),
  );
  // A transcript written with spaces after colons would match nothing: parse all of it then.
  return parseJsonLines((wanted.length > 0 ? wanted : lines).join('\n'));
}

/** The prompts of a transcript file, as import candidates (see backfill.mjs). */
export function transcriptPrompts(file) {
  let entries;
  try {
    entries = promptEntries(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  return extractPrompts(entries, { withAutomated: true }).map((prompt) => ({ ...prompt, source: 'claude', agent: AGENT }));
}
