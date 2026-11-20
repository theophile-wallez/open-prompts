// Claude Code adapter: hook events and transcripts.
// Hooks: SessionStart, PostModelSwitch, UserPromptSubmit (https://code.claude.com/docs/en/hooks)

import fs from 'node:fs';
import path from 'node:path';
import { cleanHostMarkup, ignored, isHostAutomated, parseJsonLines, poll, readJsonlTail, realModel, resolveProject, waitMsFrom, writePrompt } from '../core.mjs';
import { pruneState, readState, stateDir, updateState } from '../state.mjs';

export const AGENT = 'claude-code';

// Text that reaches UserPromptSubmit or the transcript without a person typing it.
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

export function isAutomated(text) {
  const start = text.trimStart();
  return AUTOMATED_PREFIXES.some((prefix) => start.startsWith(prefix)) || isHostAutomated(start);
}

/** Removes the wrapper lines Claude Code puts around pasted text, and keeps the text. */
export function cleanPrompt(text) {
  return cleanHostMarkup(text)
    .split('\n')
    .filter((line) => !/^<\/?pasted_content(?: id="[^"]*")?>$/.test(line.trim()))
    .join('\n')
    .trim();
}

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
  if (isAutomated(raw)) return ignored('automated message');
  const prompt = cleanPrompt(raw);
  if (prompt === '') return ignored('empty prompt');
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
  return writePrompt(project, { agent: AGENT, agentVersion, model, session, id: promptId, timestamp, prompt });
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

/** Extracts the prompts a person typed from the entries of a Claude Code transcript. */
export function extractPrompts(entries) {
  const prompts = [];
  let current = null;
  for (const entry of entries) {
    if (entry.isSidechain) continue;
    if (entry.type === 'assistant') {
      if (current && current.model === null) current.model = realModel(entry.message?.model);
      continue;
    }
    // A message typed while the agent was working is stored as a queued command.
    const queued = entry.type === 'attachment' && entry.attachment?.type === 'queued_command';
    if (queued && entry.attachment.commandMode !== 'prompt') continue;
    if (!queued && (entry.type !== 'user' || entry.isMeta || entry.isCompactSummary || entry.isVisibleInTranscriptOnly)) continue;
    if (entry.toolUseResult !== undefined) continue;
    // Turns Claude Code started on its own, such as background task notifications.
    if (entry.promptSource === 'system' || (entry.origin && entry.origin.kind !== 'human')) continue;
    const text = queued ? (typeof entry.attachment.prompt === 'string' ? entry.attachment.prompt : null) : userText(entry.message?.content);
    if (text === null || isAutomated(text)) continue;
    const prompt = cleanPrompt(typedCommand(text));
    if (prompt === '' || typeof entry.sessionId !== 'string') continue;
    current = {
      id: queued ? (entry.attachment.source_uuid ?? entry.uuid) : (entry.promptId ?? entry.uuid),
      timestamp: entry.timestamp,
      session: entry.sessionId,
      agentVersion: typeof entry.version === 'string' ? entry.version : null,
      model: null,
      prompt,
    };
    prompts.push(current);
  }
  return prompts;
}

/** Imports a transcript file into a project. With `dryRun`, writes nothing. Returns counts and records. */
export function importTranscript(transcriptPath, project, { dryRun = false } = {}) {
  const entries = parseJsonLines(fs.readFileSync(transcriptPath, 'utf8'));
  let written = 0;
  let skipped = 0;
  const files = new Set();
  const records = [];
  for (const prompt of extractPrompts(entries)) {
    const result = writePrompt(project, { ...prompt, agent: AGENT }, { dryRun });
    if (result.file) files.add(result.file);
    if (result.action === 'recorded') {
      written++;
      records.push(result.record);
    } else skipped++;
  }
  return { written, skipped, files: [...files], records };
}
