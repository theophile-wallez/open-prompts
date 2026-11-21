// Local web interface: `open-prompts ui`. Serves the files in this directory and a small JSON API
// over the prompt files of one project. It listens on the loopback interface only, and every
// request needs the token printed in the link, so other sites and other users cannot read or
// change the prompts.

import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPaused, redactOptions } from '../core.mjs';
import { validateFileContent } from '../record.mjs';
import { redact } from '../redact.mjs';
import { stateDir } from '../state.mjs';
import { updateSpooled } from '../spool.mjs';
import { listFiles, readRecords, rewriteLine } from '../store.mjs';
import { createContributors } from './contributors.mjs';
import { ICON_TYPES, findProjectIcon } from './project-icon.mjs';

const ASSETS_DIR = fileURLToPath(new URL('.', import.meta.url));
const ASSETS = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/logos.js': ['logos.js', 'text/javascript; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
  '/fonts/AlloVariableFriendly.woff2': ['fonts/AlloVariableFriendly.woff2', 'font/woff2'],
};
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};
const MAX_BODY = 5 * 1024 * 1024;

const hashLine = (line) => crypto.createHash('sha256').update(line).digest('hex').slice(0, 16);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Files of the prompts directory that git reports as new or modified, by file name. */
function gitChanges(project) {
  const result = spawnSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', project.promptsDir], {
    cwd: project.root,
    encoding: 'utf8',
  });
  if (result.status !== 0 || typeof result.stdout !== 'string') return null;
  const changes = {};
  for (const entry of result.stdout.split('\0')) {
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const name = path.basename(entry.slice(3));
    if (code === '??' || code.includes('A')) changes[name] = 'new';
    else if (code.includes('M')) changes[name] = 'modified';
  }
  return changes;
}

// Recording already redacts every prompt. An edit made here is redacted again, with the
// project's settings, since its text does not go through recording.

/** The prompts, problems and session summary of one prompt file. */
function readPromptFile(file) {
  const name = path.basename(file);
  const content = fs.readFileSync(file, 'utf8');
  const problems = validateFileContent(content, name).map(({ line, message }) => ({ file: name, line, message }));
  const lines = content.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const prompts = [];
  lines.forEach((text, index) => {
    let record;
    try {
      record = JSON.parse(text);
    } catch {
      return;
    }
    if (record === null || typeof record !== 'object' || typeof record.prompt !== 'string') return;
    prompts.push({
      file: name,
      line: index,
      hash: hashLine(text),
      id: typeof record.id === 'string' ? record.id : null,
      timestamp: typeof record.timestamp === 'string' ? record.timestamp : null,
      agent: typeof record.agent === 'string' ? record.agent : 'unknown',
      agentVersion: typeof record.agent_version === 'string' ? record.agent_version : null,
      model: typeof record.model === 'string' ? record.model : null,
      session: typeof record.session === 'string' ? record.session : name,
      prompt: record.prompt,
    });
  });
  if (prompts.length === 0) return { prompts, problems, session: null };
  const times = prompts.map((p) => p.timestamp).filter(Boolean).sort();
  const session = {
    file: name,
    session: prompts[0].session,
    agent: prompts[0].agent,
    agentVersion: prompts[0].agentVersion,
    models: [...new Set(prompts.map((p) => p.model).filter(Boolean))],
    count: prompts.length,
    first: times[0] ?? null,
    last: times.at(-1) ?? null,
  };
  return { prompts, problems, session };
}

// Parsed prompt files, by path. An agent only appends to one file at a time, so a file is read
// and parsed again only when it changed.
const fileCache = new Map();

function cachedPromptFile(file) {
  const stats = fs.statSync(file, { bigint: true });
  const signature = `${stats.ino}:${stats.size}:${stats.mtimeNs}`;
  const cached = fileCache.get(file);
  if (cached?.signature === signature) return cached.parsed;
  const parsed = readPromptFile(file);
  fileCache.set(file, { signature, parsed });
  return parsed;
}

/**
 * Everything the interface shows. Only the prompt files that changed since the last call are read.
 * `contributors` (from createContributors) adds who wrote each session.
 */
export function readProjectData(project, env = process.env, contributors = null) {
  const prompts = [];
  const sessions = [];
  const problems = [];
  const git = gitChanges(project);
  const files = listFiles(project.promptsDir);
  const current = new Set(files);
  for (const file of fileCache.keys()) if (path.dirname(file) === project.promptsDir && !current.has(file)) fileCache.delete(file);
  for (const file of files) {
    let parsed;
    try {
      parsed = cachedPromptFile(file);
    } catch {
      continue; // Removed between the listing and the read.
    }
    for (const problem of parsed.problems) problems.push(problem);
    if (!parsed.session) continue;
    for (const prompt of parsed.prompts) prompts.push(prompt);
    sessions.push({ ...parsed.session, git: git ? (git[parsed.session.file] ?? 'committed') : null });
  }
  const icon = findProjectIcon(project.root);
  return {
    contributors: contributors ? contributors.sessionAuthors(sessions, git) : {},
    project: {
      // The version in the address makes the browser fetch the icon again when the file changes.
      icon: icon ? `/project-icon?v=${Math.round(fs.statSync(icon).mtimeMs)}` : null,
      name: path.basename(project.root),
      root: project.root,
      displayRoot: project.root.startsWith(os.homedir() + path.sep) ? `~${project.root.slice(os.homedir().length)}` : project.root,
      dir: project.config.dir,
    },
    recording: !isPaused(env),
    pausedByEnv: ['off', '0', 'false'].includes(String(env.OPEN_PROMPTS ?? '').toLowerCase()),
    sessions,
    prompts,
    problems,
  };
}

/** Resolves a file name sent by the interface to a prompt file of the project, or throws. */
function promptFile(project, name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9_.-]+\.jsonl$/.test(name)) throw new HttpError(400, 'Unknown prompt file.');
  const file = path.join(project.promptsDir, name);
  if (!fs.existsSync(file)) throw new HttpError(404, `${name} no longer exists.`);
  return file;
}

/** The line a { file, line, hash } reference points to, checked against the hash. */
function referencedLine(project, ref) {
  const file = promptFile(project, ref.file);
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const text = Number.isInteger(ref.line) ? lines[ref.line] : undefined;
  if (text === undefined || text === '' || hashLine(text) !== ref.hash) {
    throw new HttpError(409, 'This prompt changed on disk since the page loaded. The list has been refreshed, try again.');
  }
  return { file, text };
}

// Edits and deletions also change the copy in the local spool, so that "open-prompts collect"
// does not bring back what a person removed.

function editPrompt(project, body, env) {
  const { file, text } = referencedLine(project, body);
  if (typeof body.prompt !== 'string' || body.prompt.trim() === '') throw new HttpError(400, 'A prompt cannot be empty. Delete it instead.');
  const { text: prompt, kinds } = redact(body.prompt.replace(/\r\n?/g, '\n'), redactOptions(project));
  const record = JSON.parse(text);
  record.prompt = prompt;
  if (!rewriteLine(file, body.line, text, JSON.stringify(record))) throw new HttpError(409, 'This prompt changed on disk. Try again.');
  updateSpooled(project, record, record, env);
  return { redacted: [...new Set(kinds)] };
}

function deletePrompt(project, body, env) {
  const { file, text } = referencedLine(project, body);
  if (!rewriteLine(file, body.line, text, null)) throw new HttpError(409, 'This prompt changed on disk. Try again.');
  try {
    updateSpooled(project, JSON.parse(text), null, env);
  } catch {
    // A line that is not JSON has no copy in the spool.
  }
  return { removedFile: !fs.existsSync(file) };
}

function deleteSession(project, body, env) {
  const file = promptFile(project, body.file);
  const records = readRecords(file);
  fs.rmSync(file);
  for (const record of records) updateSpooled(project, record, null, env);
  return {};
}

function setRecording(env, body) {
  const marker = path.join(stateDir(env), 'paused');
  if (body.recording) fs.rmSync(marker, { force: true });
  else {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, '');
  }
  return { recording: !isPaused(env) };
}

async function readJsonBody(req) {
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'Expected JSON.');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Request too large.');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (body === null || typeof body !== 'object') throw new Error();
    return body;
  } catch {
    throw new HttpError(400, 'Invalid JSON.');
  }
}

const parseCookies = (header = '') =>
  Object.fromEntries(
    header
      .split(';')
      .map((part) => part.trim().split('='))
      .filter(([key, value]) => key && value !== undefined)
      .map(([key, ...rest]) => [key, rest.join('=')]),
  );

const sameToken = (a, b) => typeof a === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Starts the interface for `project`. Resolves to { server, url, port, token, close }.
 * `url` contains the token and is the link to open.
 */
export function startServer(project, { port = 0, host = '127.0.0.1', env = process.env, offline = false, fetchImpl, useGh, token = crypto.randomBytes(24).toString('base64url') } = {}) {
  const clients = new Set();
  let watcher;
  let debounce;
  const broadcast = () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      for (const res of clients) res.write('event: change\ndata: {}\n\n');
    }, 120);
  };
  // Accounts and avatars of the authors are looked up on the forge, unless `offline`.
  const contributors = createContributors({ project, cacheDir: path.join(stateDir(env), 'ui'), offline, onChange: broadcast, useGh, ...(fetchImpl ? { fetchImpl } : {}) });

  const server = http.createServer(async (req, res) => {
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
      res.end(body);
    };
    const json = (status, value) => send(status, JSON.stringify(value), { 'Content-Type': 'application/json; charset=utf-8' });
    try {
      const actualPort = server.address().port;
      // Only answer requests addressed to this server by name, against DNS rebinding.
      if (![`127.0.0.1:${actualPort}`, `localhost:${actualPort}`, `[::1]:${actualPort}`].includes(req.headers.host)) {
        throw new HttpError(403, 'Unexpected host.');
      }
      const url = new URL(req.url, `http://${req.headers.host}`);
      const cookieName = `open_prompts_${actualPort}`;

      // The link printed in the terminal carries the token once; it is then kept in a cookie.
      if (url.searchParams.has('token')) {
        if (!sameToken(url.searchParams.get('token'), token)) throw new HttpError(403, 'This link has expired. Use the one printed by "open-prompts ui".');
        return send(303, '', {
          Location: '/',
          'Set-Cookie': `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/`,
        });
      }
      if (!sameToken(parseCookies(req.headers.cookie)[cookieName], token)) {
        throw new HttpError(403, 'Open this page with the link printed by "open-prompts ui".');
      }
      if (req.method !== 'GET' && req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) {
        throw new HttpError(403, 'Cross-origin requests are not allowed.');
      }

      const asset = ASSETS[url.pathname];
      if (asset && req.method === 'GET') {
        const cache = asset[1] === 'font/woff2' ? { 'Cache-Control': 'max-age=604800, immutable' } : {};
        return send(200, fs.readFileSync(path.join(ASSETS_DIR, asset[0])), { 'Content-Type': asset[1], ...cache });
      }
      if (req.method === 'GET' && /^\/avatar\/[a-f0-9]{20}$/.test(url.pathname)) {
        const image = await contributors.avatar(url.pathname.slice('/avatar/'.length));
        if (!image) throw new HttpError(404, 'No avatar.');
        return send(200, image.body, { 'Content-Type': image.type, 'Cache-Control': 'private, max-age=86400' });
      }
      const route = `${req.method} ${url.pathname}`;
      switch (route) {
        case 'GET /api/data':
          return json(200, readProjectData(project, env, contributors));
        case 'GET /project-icon': {
          const icon = findProjectIcon(project.root);
          if (!icon) throw new HttpError(404, 'This project has no icon.');
          return send(200, fs.readFileSync(icon), { 'Content-Type': ICON_TYPES[path.extname(icon).toLowerCase()], 'Cache-Control': 'max-age=3600' });
        }
        case 'GET /api/events':
          res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
          res.write('retry: 2000\n\n');
          clients.add(res);
          req.on('close', () => clients.delete(res));
          return;
        case 'PATCH /api/prompt':
          return json(200, editPrompt(project, await readJsonBody(req), env));
        case 'DELETE /api/prompt':
          return json(200, deletePrompt(project, await readJsonBody(req), env));
        case 'DELETE /api/session':
          return json(200, deleteSession(project, await readJsonBody(req), env));
        case 'PUT /api/recording':
          return json(200, setRecording(env, await readJsonBody(req)));
        default:
          throw new HttpError(404, 'Not found.');
      }
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (req.url.startsWith('/api/')) json(status, { error: error.message });
      else send(status, error.message, { 'Content-Type': 'text/plain; charset=utf-8' });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      try {
        fs.mkdirSync(project.promptsDir, { recursive: true });
        watcher = fs.watch(project.promptsDir, broadcast);
        watcher.on('error', () => {});
      } catch {
        // Live updates are a convenience; the interface works without them.
      }
      const actualPort = server.address().port;
      const close = () =>
        new Promise((done) => {
          watcher?.close();
          clearTimeout(debounce);
          for (const res of clients) res.end();
          server.close(() => done());
          server.closeAllConnections?.();
        });
      resolve({ server, port: actualPort, token, url: `http://127.0.0.1:${actualPort}/?token=${token}`, close });
    });
  });
}
