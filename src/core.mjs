// What every agent adapter shares: checking that recording applies, and writing a record.

import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { findProject } from './project.mjs';
import { limitPastes } from './paste.mjs';
import { makeRecord } from './record.mjs';
import { redact } from './redact.mjs';
import { spoolRecord } from './spool.mjs';
import { appendRecord } from './store.mjs';
import { stateDir } from './state.mjs';

/** Recording is paused with OPEN_PROMPTS=off or with `open-prompts pause`. */
export function isPaused(env = process.env) {
  if (['off', '0', 'false'].includes(String(env.OPEN_PROMPTS ?? '').toLowerCase())) return true;
  return fs.existsSync(path.join(stateDir(env), 'paused'));
}

/**
 * The project that opted in above `cwd`, or a reason why nothing should be recorded.
 * Returns { project } or { reason }.
 */
export function resolveProject(cwd, env = process.env) {
  if (isPaused(env)) return { reason: 'recording is paused' };
  if (typeof cwd !== 'string' || cwd === '') return { reason: 'no working directory' };
  const project = findProject(cwd);
  if (!project) return { reason: 'this project has not opted in' };
  return { project };
}

export const ignored = (reason) => ({ action: 'ignored', reason });

/** A quoted part of a reply as a Markdown quote, followed by the person's comment on it. */
function renderQuote(text, comment) {
  const quote = String(text ?? '').trim().split('\n').map((line) => `> ${line}`.trimEnd()).join('\n');
  return [quote === '>' ? '' : quote, String(comment ?? '').trim()].filter(Boolean).join('\n\n');
}

/**
 * Replaces the JSON block T3 Code adds when a person quotes part of a reply: each `[id]`
 * becomes the quote and the comment, and the block, with its internal IDs, is removed.
 */
function renderCitationBlock(text) {
  const block = /\n*<assistant_citations>([\s\S]*?)<\/assistant_citations>\n*/;
  const match = block.exec(text);
  if (!match) return text;
  let rendered = new Map();
  try {
    const json = match[1].slice(match[1].indexOf('['), match[1].lastIndexOf(']') + 1);
    for (const { id, citation } of JSON.parse(json)) rendered.set(id, renderQuote(citation?.text, citation?.comment));
  } catch {
    rendered = new Map();
  }
  return text.replace(block, '\n').replace(/\[([A-Za-z0-9_-]+)\]/g, (token, id) => rendered.get(id) ?? token);
}

/** The other form T3 Code uses for a quote: a link whose parameters hold the quote and the comment. */
function renderCitationLink(link) {
  try {
    const params = new URL(link).searchParams;
    return renderQuote(params.get('text'), params.get('comment'));
  } catch {
    return '';
  }
}

const T3_CONTEXT_BLOCK = /\n*<t3_context version="\d+">([\s\S]*?)<\/t3_context>\n*/g;
const T3_INLINE_REF = /\[(Image|File|Thread): ([^\]\n]*?)(; ref=[^\]\s]+)?\]/g;
const T3_CONTEXT_LINK = /!?\[([^\]\n]*)\]\(t3-context:\/\/v\d+\/(image|file|thread)\/[^)\s]*\)/g;
const T3_ATTACHED = /\[Attached (image|file) "[^"\n]*" is saved at: ([^\]\n]+)\]/g;
// "files", "images", or both: "[User attached one or more images without additional text. …]".
const T3_NO_TEXT = /\[User attached one or more [^\]\n]*?without additional text\.[^\]\n]*\]/g;
const T3_ATTACHMENT_METADATA = /\n*Attachment metadata:\n(?:- [^\n]* \([^\n,()]+, \d+ bytes\)(?:\n|$))+\s*$/;

/** What T3 Code writes in place of an image, a file or another thread the person attached. */
const placeholder = (kind, name) => (kind === 'thread' ? `[thread: ${name.trim()}]` : `[${kind}]`);

/**
 * Replaces T3 Code's attachment markup with placeholders. T3 writes an attached image
 * twice: inline, as `[Image: name; ref=…]` (or as a `t3-context://` link), and at the end,
 * as `[Attached image "name" is saved at: <local path>]`. The second form is dropped when
 * the first is there, so each image leaves one `[image]` and its local path is never kept.
 */
function renderT3Attachments(text) {
  const known = new Set();
  let out = text.replace(T3_CONTEXT_BLOCK, (_, body) => {
    for (const match of body.matchAll(/^attachmentId: (\S+)$/gm)) known.add(match[1]);
    return '\n\n';
  });
  const inline = { image: 0, file: 0 };
  const count = (kind) => (kind in inline ? inline[kind]++ : 0);
  out = out
    .replace(T3_INLINE_REF, (token, kind, name, ref) => {
      // Without a ref, only `[Image: name.png]` is T3's: `[Image: tag]` may be the person's own text.
      if (!ref && !(kind === 'Image' && /\.[A-Za-z]{2,5}$/.test(name))) return token;
      count(kind.toLowerCase());
      return placeholder(kind.toLowerCase(), name);
    })
    .replace(T3_CONTEXT_LINK, (_, name, kind) => (count(kind), placeholder(kind, name)));
  // Attached lines that repeat an inline reference: matched by attachment ID first, then by count.
  const named = (file) => [...known].some((id) => file.includes(id));
  for (const [, kind, file] of out.matchAll(T3_ATTACHED)) if (named(file)) inline[kind]--;
  return out.replace(T3_ATTACHED, (_, kind, file) => {
    if (named(file)) return '';
    if (inline[kind] > 0) {
      inline[kind]--;
      return '';
    }
    return placeholder(kind);
  });
}

/**
 * Removes the markup hosts such as T3 Code add around what a person typed, and keeps
 * what they typed. Images and files become `[image]` and `[file]`, a reference to another
 * thread becomes `[thread: <title>]`, and a quoted part of a reply becomes a Markdown
 * quote followed by the person's comment.
 */
export function cleanHostMarkup(text) {
  if (typeof text !== 'string') return '';
  // A context handoff wraps a summary of earlier activity around the new message,
  // which follows the last "User message:" line.
  if (/^Context handoff \(/.test(text.trimStart())) {
    const marker = text.lastIndexOf('\nUser message:\n');
    return marker < 0 ? '' : cleanHostMarkup(text.slice(marker + '\nUser message:\n'.length).trim());
  }
  // T3 Code sends Gemini CLI its instructions in the message, with what the person typed
  // in a <user_request> block.
  if (/^<t3_code_instructions>/.test(text.trimStart())) {
    const request = /<user_request>\n?([\s\S]*?)\n?<\/user_request>/.exec(text);
    return request ? cleanHostMarkup(request[1].trim()) : '';
  }
  const out = renderT3Attachments(renderCitationBlock(text))
    // T3 Code's thinking level, which it puts in front of the message (its own search index strips it too).
    .replace(/^\s*Ultrathink:[ \t]*/, '')
    .replace(/\[Assistant quote\]\((t3-citation:\/\/[^)\s]+)\)/g, (_, link, offset, whole) => `${offset > 0 && whole[offset - 1] !== '\n' ? '\n\n' : ''}${renderCitationLink(link)}\n\n`)
    .replace(T3_NO_TEXT, '')
    .replace(T3_ATTACHMENT_METADATA, '');
  return out
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Whether a cleaned prompt holds nothing but placeholders for attachments. */
export const onlyPlaceholders = (text) => text.replace(/\[(?:image|file|thread: [^\]\n]*)\]/g, '').trim() === '';

// Messages hosts send on their own, as if the person had typed them. Each pattern is narrow
// enough that a person is unlikely to type it. Under T3 Code, the hooks also ask T3's
// database who wrote the message (see t3.mjs); these rules are the fallback.
const HOST_AUTOMATED = [
  // T3 Code watching a pull request.
  /^Update on pull request #\d+ \([^)\n]*\), which T3 Code is watching/,
  // Briefs an agent sends to the sub-agents it delegates to, and their results.
  /^Act as the [\w-]+ sub-agent for this task\./,
  /^You take over a long job from a previous session\b/,
  /^Delegated task node:delegated-task:/,
  /^Note: the T3 server restarted, and this background work was cancelled/,
  // Messages one agent session sends to another.
  // The session ID follows "session", "thread" or "mcp:", or has a letter, so that
  // "From 20240101 to 20241231: …" stays a prompt.
  /^From (?:(?:(?:the session |session |thread )(?:mcp:)?|mcp:)[0-9a-f]{8}|(?=[0-9-]*[a-f])[0-9a-f]{8})(?:-[0-9a-f]{4}){0,4}[0-9a-f]*\b[^\n]{0,160}?:/,
  /^Note from another session\b/,
  /^Message d'une autre session\b/,
  /^FYI from (?:the )?[^\n]{0,80}\bsession\b/,
  /^Chrome (?:no longer shows your draft|won't show your draft|now shows my draft|ne montre plus ton brouillon|n'affiche plus ton brouillon)\b/,
  // T3 Code resuming a turn that was cut short. People type the short form too, so only
  // the long one is a rule; under T3 Code, its database tells the short one apart.
  /^Continue where you left off\. Your last turn was cut short/,
];

// The first prompt of a session that a host runs for its own needs, such as naming a git
// branch. Every later prompt of that session is the host's too.
const HOST_SESSIONS = [/^You generate concise git branch names\./, /^Generate a title that will help the user recognize this T3 Code thread\b/];

/**
 * Whether `text` is a message a host sent on its own, as if the person had typed it. The
 * rules are checked on the text as sent and once the host's markup is removed, since a host
 * can wrap a message, as T3 Code does for Gemini CLI.
 */
export function isHostAutomated(text) {
  const raw = String(text ?? '');
  return [raw, cleanHostMarkup(raw)].some((form) => {
    const start = form.trimStart();
    return HOST_AUTOMATED.some((rule) => rule.test(start)) || isHostSession(start);
  });
}

/** Whether `text` opens a session that a host runs on its own, such as T3 Code's branch namer. */
export const isHostSession = (text) => HOST_SESSIONS.some((rule) => rule.test(String(text ?? '').trimStart()));

/**
 * The reason to skip a cleaned prompt because of the project's "ignore" and
 * "ignoreCommands" options, or null when it should be recorded.
 */
export function projectIgnores(project, prompt) {
  const config = project?.config ?? {};
  const command = (config.ignoreCommands ?? []).find((name) => prompt === name || prompt.startsWith(`${name} `) || prompt.startsWith(`${name}\n`));
  if (command) return `${command} is in "ignoreCommands"`;
  const rule = (config.ignore ?? []).find((pattern) => pattern.test(prompt));
  return rule ? `matches "ignore" pattern ${rule}` : null;
}

/** Turns a model reported by an agent into a string or null. */
export const realModel = (model) => (typeof model === 'string' && model !== '' && model !== '<synthetic>' ? model : null);

/** The redaction options of a project, from the "redact" object of its `.open-prompts.json`. */
export const redactOptions = (project) => project?.config?.redact ?? {};

/**
 * The text of a record for a cleaned prompt: shortened when the project sets
 * "maxPasteLength" (see paste.mjs), then redacted with the project's options. `pastes`
 * lists the pasted blocks the agent marked, or is undefined when it marks none.
 * Returns what redact() returns, plus `shortened`, the number of blocks shortened.
 */
export function recordText(project, prompt, pastes) {
  // Shortening first: what it leaves out is never written, and the rest is redacted as usual.
  const { text, shortened } = limitPastes(prompt, pastes, project?.config?.maxPasteLength);
  return { ...redact(text, redactOptions(project)), shortened };
}

/**
 * Redacts and appends one prompt to the project's prompt files, with the project's
 * redaction options. `prompt` must already be cleaned by the adapter. Prompts the
 * project's "ignore" and "ignoreCommands" options list are skipped. `extensions` holds
 * extension fields (names starting with `x_`), written after the fields of the spec.
 * `pastes` lists the pasted blocks the agent marked in `prompt`, for "maxPasteLength".
 * With `dryRun`, nothing is written and the result says what would have happened.
 * Each record written also goes to the local spool of the repository (see spool.mjs), in the
 * state directory of `env`, unless `spool` is false, as for `import`, which reads its
 * records from sources that are still there.
 */
export function writePrompt(project, { agent, agentVersion, model, session, id, timestamp, prompt, pastes, extensions }, { dryRun = false, spool = true, env = process.env } = {}) {
  const trimmed = typeof prompt === 'string' ? prompt.trim() : '';
  if (trimmed === '' || onlyPlaceholders(trimmed)) return ignored('empty prompt');
  if (typeof session !== 'string' || session === '') return ignored('no session id');
  const skip = projectIgnores(project, trimmed);
  if (skip) return ignored(skip);
  const { text, kinds, homePaths, shortened } = recordText(project, trimmed, pastes);
  const record = makeRecord({ id, timestamp, agent, agentVersion, model: realModel(model), session, prompt: text, extensions });
  const { file, written } = appendRecord(project.promptsDir, record, { dryRun });
  if (written && !dryRun && spool) spoolRecord(project, record, env);
  return { action: written ? 'recorded' : 'duplicate', file, record, redacted: kinds, homePaths, ...(shortened ? { shortened } : {}) };
}

/** Parses JSON lines, skipping the ones that are not JSON. */
export function parseJsonLines(text) {
  return text.split('\n').flatMap((line) => {
    if (line.trim() === '') return [];
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

/** Parses the last `maxBytes` of a JSONL file. Returns [] when it cannot be read. */
export function readJsonlTail(file, maxBytes = 1 << 20) {
  if (typeof file !== 'string' || file === '') return [];
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.toString('utf8');
    return parseJsonLines(start > 0 ? text.slice(text.indexOf('\n') + 1) : text);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Parses a JSONL file from byte `offset` to its end (at most `maxBytes`). */
export function readJsonlFrom(file, offset, maxBytes = 1 << 20) {
  if (typeof file !== 'string' || file === '') return [];
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, Math.min(offset, size));
    const length = Math.min(size - start, maxBytes);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, start);
    return parseJsonLines(buffer.toString('utf8'));
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Size of a file in bytes, or 0 when it does not exist yet. */
export function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * Reads a JSONL file from its start, at most `maxBytes`, and calls `visit` with each entry
 * until it returns true. For the first entries of files too large to read whole.
 */
export function scanJsonlHead(file, visit, maxBytes = 4 << 20) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const chunk = Buffer.alloc(64 * 1024);
    const decoder = new StringDecoder('utf8');
    let rest = '';
    for (let offset = 0; offset < maxBytes; ) {
      const bytes = fs.readSync(fd, chunk, 0, chunk.length, offset);
      if (bytes === 0) break;
      offset += bytes;
      const lines = (rest + decoder.write(chunk.subarray(0, bytes))).split('\n');
      rest = lines.pop();
      for (const entry of parseJsonLines(lines.join('\n'))) if (visit(entry)) return;
    }
    for (const entry of parseJsonLines(rest)) if (visit(entry)) return;
  } catch {
    // An unreadable file has no entries.
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Lists the files under `dir` and its subdirectories whose name passes `keep`. */
export function walkFiles(dir, keep = () => true, depth = 6) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return depth > 0 ? walkFiles(file, keep, depth - 1) : [];
    return entry.isFile() && keep(entry.name) ? [file] : [];
  });
}

/** Reads the first line of a file as JSON, or returns null. */
export function readFirstJsonLine(file) {
  if (typeof file !== 'string' || file === '') return null;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(64 * 1024);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytes).toString('utf8');
    return JSON.parse(text.split('\n', 1)[0]);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export const sleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
  });

/**
 * Calls `probe` every 300 ms until it returns a value, `waitMs` passes or `signal` aborts.
 * Returns the value or null.
 */
export async function poll(probe, { waitMs, signal }) {
  const deadline = Date.now() + Math.max(0, waitMs);
  for (;;) {
    const value = probe();
    if (value != null || signal?.aborted || Date.now() >= deadline) return value ?? null;
    await sleep(Math.min(300, deadline - Date.now()), signal);
  }
}

/** How long adapters wait for the agent's reply to learn the model. */
export function waitMsFrom(env = process.env, fallback = 120_000) {
  const value = Number(env.OPEN_PROMPTS_WAIT_MS ?? fallback);
  return Number.isFinite(value) ? value : fallback;
}
