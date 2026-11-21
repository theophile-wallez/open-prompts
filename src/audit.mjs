// `open-prompts audit`: lists what to read in prompt files before committing them.
// It is wider than redaction: it also points at things that may be fine, such as an
// email address, a long pasted log, or a random-looking string no rule knows.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { COPULAS, EMAIL, HOME_PATHS, PASSWORD_KEYWORD, averageRun, findSecrets, looksLikePassword } from './redact.mjs';
import { listFiles } from './store.mjs';

const LONG_PROMPT = 4000; // characters
const LOG_LINES = 8; // log-looking lines in one prompt
const MAX_FINDINGS = 10; // listed for one prompt; the rest are counted

/** Shannon entropy of `text`, in bits per character. */
export function entropy(text) {
  const counts = new Map();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** Whether one piece of a token looks random: long, mixed, switching class all the time. */
function looksRandom(part) {
  if (part.length < 16 || !/\d/.test(part) || !/[A-Za-z]/.test(part)) return false;
  if (/\d{4}-\d{2}-\d{2}/.test(part)) return false; // timestamped file names
  // Commit SHAs, UUIDs, hashes and IDs such as "t3-93a1c798-87b44b68": hex but for a letter or two.
  if ((part.replace(/[0-9a-f._-]/gi, '').length) <= 2) return false;
  return averageRun(part) < 2.5 && entropy(part) >= 3.5;
}

/**
 * Long random-looking strings: possible secrets that no rule recognizes. Hex strings
 * (commit SHAs, UUIDs), redaction markers, URLs, and paths and slugs made of words are
 * left out.
 */
export function highEntropyStrings(text) {
  // IDs in URLs (attachments, commits, issues, encoded search terms) are rarely secrets.
  // Query parameters named like a secret are reported by secretsInUrls instead.
  const urls = [...text.matchAll(URL)].map((url) => [url.index, url.index + url[0].length]);
  const inUrl = (index) => urls.some(([start, end]) => index >= start && index < end);
  const found = [];
  for (const match of text.matchAll(/[A-Za-z0-9+/_=-]{20,}/g)) {
    const token = match[0].replace(/=+$/, '');
    if (token.includes('REDACTED') || inUrl(match.index)) continue;
    // A path is checked one segment at a time, so that "src/Button2Group/index" is not random.
    const parts = token.includes('/') ? token.split('/') : [token];
    if (parts.some(looksRandom)) found.push({ index: match.index, length: match[0].length });
  }
  return found;
}

const URL = /(?<![\w+.-])[a-z][\w+.-]{0,30}:\/\/[^\s)\]"'<>`]+/gi;
const URL_SECRET = /[?&#](?:[\w.-]{0,40}(?:token|key|secret|sig|signature|auth|code|password|session)[\w.-]{0,40})=(?<value>[^&#\s)\]"'<>`]{12,})/gi;

/** Query parameters with a secret-looking name, as in "?access_token=…" or "&sig=…". */
function secretsInUrls(text) {
  const found = [];
  for (const url of text.matchAll(URL)) {
    for (const match of url[0].matchAll(URL_SECRET)) {
      const { value } = match.groups;
      if (value.startsWith('[REDACTED:')) continue;
      found.push({ index: url.index + match.index + match[0].length - value.length, length: value.length });
    }
  }
  return found;
}

// Keywords that name a secret, followed by a value: "password: …", "token = …", "mdp est …".
// Blanks include no-break spaces, which French puts before ":".
const SECRET_KEYWORD = new RegExp(
  String.raw`(?:${PASSWORD_KEYWORD}|(?<![\p{L}\p{N}])(?:secret|token|api[ _-]?key|access[ _-]?key|private[ _-]?key)(?![\p{L}\p{N}]))["']?(?<sep>[\t\p{Zs}]*[:=：][\t\p{Zs}]*|[\t\p{Zs}]+(?:${COPULAS.join('|')})[\t\p{Zs}]+|[\t\p{Zs}]*(?:是|は)[\t\p{Zs}]*)(?<value>"[^"\n]+"|'[^'\n]+'|«[^»\n]+»|“[^”\n]+”|[^\s"',«»“”]+)`,
  'giu',
);
// Values after a keyword that are code or prose, not a secret.
const NOT_A_VALUE = /^(?:\[REDACTED:.*|string|number|boolean|null|undefined|true|false|none|required|optional|empty|missing|wrong|invalid|incorrect|correct|\*+|<[^>]*>|\$\{?[A-Z_][A-Z0-9_]*\}?|process\.env\..*|[\w.]+\(.*)$/i;
const ORDINARY_WORD = /^["']?\p{L}[\p{Ll}'’-]*["']?[.,;:!?]*$/u;

function secretKeywords(text) {
  const found = [];
  for (const match of text.matchAll(SECRET_KEYWORD)) {
    const { sep, value } = match.groups;
    const bare = value.replace(/^(["'])(.*)\1$/, '$2').replace(/^«[\t\p{Zs}]*(.*?)[\t\p{Zs}]*»$|^“(.*)”$/u, '$1$2');
    if (NOT_A_VALUE.test(bare) || /\s/.test(bare) || /^[^\p{L}\p{N}]*$/u.test(bare) || /^[{[(]/.test(bare)) continue;
    // A plain word after "is" and its translations, or followed by more words, is prose:
    // "the password is wrong", "token: the refresh flow". A plain word alone is not.
    const prose = !/[:=：]/.test(sep) || /^[ \t]+\p{L}/u.test(text.slice(match.index + match[0].length));
    if (prose && ORDINARY_WORD.test(value)) continue;
    found.push({ index: match.index + match[0].length - value.length, length: value.length });
  }
  return found;
}

const LOG_LINE = [
  /^\s*\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/, // 2026-11-20 15:50, ISO timestamps
  /^\s*\[?\d{2}:\d{2}:\d{2}/, // 15:50:29
  /^\s*\[?(?:TRACE|DEBUG|INFO|NOTICE|WARN|WARNING|ERROR|ERR|FATAL|CRITICAL)\b/, // log levels
  /\b(?:TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\b[:\]]/,
  /^\s+at .+[:(]\d+(?::\d+)?\)?$/, // JavaScript and Java stack frames
  /^\s*File ".+", line \d+/, // Python tracebacks
  /^(?:npm|pnpm|yarn) (?:ERR!|WARN)/,
];

/** Very long prompts and pasted logs, which can hide tokens, hostnames or personal data. */
function pastedLogs(text) {
  const found = [];
  if (text.length > LONG_PROMPT) found.push({ reason: `long prompt (${text.length} characters)`, index: 0, length: 0 });
  const logLines = text.split('\n').filter((line) => LOG_LINE.some((pattern) => pattern.test(line))).length;
  if (logLines >= LOG_LINES) found.push({ reason: `pasted log (${logLines} log lines)`, index: 0, length: 0 });
  return found;
}

/** Hides most of a flagged value, so that the output of audit can be shared or logged. */
const mask = (value) => (value.length <= 4 ? '…' : `${value.slice(0, 3)}…`);
const oneLine = (text) => text.replace(/\s+/g, ' ');

/**
 * The text with every flagged value masked, and the position of each finding in it, so
 * that an excerpt never shows a value flagged elsewhere in the same prompt either.
 * `findings` are sorted and do not overlap.
 */
function maskAll(text, findings) {
  let masked = '';
  let from = 0;
  const moved = findings.map((finding) => {
    if (finding.length === 0) return finding;
    masked += text.slice(from, finding.index);
    const value = mask(text.slice(finding.index, finding.index + finding.length));
    const index = masked.length;
    masked += value;
    from = finding.index + finding.length;
    return { ...finding, index, length: value.length };
  });
  return { masked: masked + text.slice(from), moved };
}

/**
 * Masks, in an excerpt, the words around a finding that could be a password no rule
 * caught, such as the one after a flagged email: three character classes or more.
 */
const maskPasswordLike = (text) => text.replace(/[^\s…]{6,}/g, (token) => (looksLikePassword(token, { minClasses: 3 }) ? mask(token) : token));

/** A short excerpt of `text` around a finding, or its start for findings about the whole prompt. */
function excerpt(text, { index, length }) {
  if (length === 0) {
    const start = maskPasswordLike(oneLine(text.trim()));
    return start.length > 60 ? `${start.slice(0, 60)}…` : start;
  }
  const from = Math.max(0, index - 30);
  const to = Math.min(text.length, index + length + 30);
  return `${from > 0 ? '…' : ''}${maskPasswordLike(oneLine(text.slice(from, to)).trim())}${to < text.length ? '…' : ''}`;
}

const REASONS = { 'email-and-password': 'email and password', secret: 'secret assignment' };

/**
 * Lists what a person should read in one prompt before committing it. With `homePaths`
 * false (the project keeps home directories), those are not reported.
 * Returns [{ reason, excerpt }], in the order of the text.
 */
export function auditPrompt(text, { homePaths = true } = {}) {
  const findings = [];
  const add = (reason, range) => {
    const overlaps = findings.some((f) => f.length > 0 && f.index < range.index + range.length && range.index < f.index + f.length);
    if (!overlaps) findings.push({ reason, ...range });
  };
  for (const secret of findSecrets(text)) add(REASONS[secret.kind] ?? secret.kind, secret);
  for (const match of text.matchAll(new RegExp(EMAIL, 'g'))) {
    if (!/^git@/i.test(match[0])) add('email', { index: match.index, length: match[0].length });
  }
  for (const range of secretKeywords(text)) add('password or secret keyword', range);
  for (const range of secretsInUrls(text)) add('secret in a URL', range);
  for (const range of highEntropyStrings(text)) add('high-entropy string', range);
  if (homePaths) {
    // For records written before home directories were replaced with "~", or by another producer.
    for (const pattern of HOME_PATHS) {
      for (const match of text.matchAll(pattern)) {
        const name = match[0].replace(/^.*[\\/]/, ''); // the user name, which is what gets masked
        add('home directory', { index: match.index + match[0].length - name.length, length: name.length });
      }
    }
  }
  findings.push(...pastedLogs(text));
  findings.sort((a, b) => a.index - b.index);
  const { masked, moved } = maskAll(text, findings);
  const listed = moved.slice(0, MAX_FINDINGS).map((finding) => ({ reason: finding.reason, excerpt: excerpt(masked, finding) }));
  if (moved.length > MAX_FINDINGS) listed.push({ reason: `${moved.length - MAX_FINDINGS} more in this prompt`, excerpt: excerpt(masked, { index: 0, length: 0 }) });
  return listed;
}

/** The prompt of a JSONL line, or the raw line when it is not a record. */
function promptOf(line) {
  try {
    const record = JSON.parse(line);
    if (typeof record?.prompt === 'string') return record.prompt;
  } catch {
    // Not JSON: check the line as it is.
  }
  return line;
}

/** Every record of the files and directories in `targets`, as [{ file, line, text }]. */
export function recordsOf(targets) {
  const entries = [];
  for (const target of targets) {
    if (!fs.existsSync(target)) throw new Error(`${target}: not found`);
    const files = fs.statSync(target).isDirectory() ? listFiles(target) : [target];
    for (const file of files) {
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
        if (line.trim() !== '') entries.push({ file, line: index + 1, text: promptOf(line) });
      });
    }
  }
  return entries;
}

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (result.error) throw new Error(`git could not run: ${result.error.message}`);
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
  return result.stdout;
}

/**
 * The records added in the staged changes of the `.jsonl` files under `pathspecs`. They
 * are read from the staged diff (`git diff --cached`), so what is checked is what would be
 * committed, not the working tree. The files are listed first (NUL-separated, so that any
 * name works), then each one is diffed as text, even when `.gitattributes` marks it
 * binary or `-diff`. Returns [{ file, line, text }], with the line numbers of the staged file.
 */
export function stagedRecords(pathspecs, cwd = process.cwd()) {
  const top = git(['rev-parse', '--show-toplevel'], cwd).trim();
  const names = git(['-c', 'diff.relative=false', 'diff', '--cached', '--name-only', '-z', '--no-renames', '--diff-filter=AM', '--', ...pathspecs], cwd)
    .split('\0')
    .filter((name) => name.endsWith('.jsonl'));
  const entries = [];
  for (const name of names) {
    const file = path.join(top, name);
    const diff = git(['diff', '--cached', '-U0', '--no-color', '--no-ext-diff', '--no-renames', '--text', '--no-textconv', '--', `:(literal)${name}`], top);
    let line = 0;
    let inHunk = false;
    for (const text of diff.split('\n')) {
      if (text.startsWith('@@ ')) {
        inHunk = true;
        line = Number(/\+(\d+)/.exec(text)?.[1] ?? 0);
      } else if (inHunk && text.startsWith('+')) {
        if (text.slice(1).trim() !== '') entries.push({ file, line, text: promptOf(text.slice(1)) });
        line++;
      }
    }
  }
  return entries;
}

/** Audits records. Returns [{ file, line, reason, excerpt }]. */
export function auditRecords(entries, options) {
  return entries.flatMap(({ file, line, text }) => auditPrompt(text, options).map((finding) => ({ file, line, ...finding })));
}
