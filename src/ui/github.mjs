// Reads the prompts of a GitHub repository from the browser, for the copy of the interface that
// is published on GitHub Pages. It gives the same data as the local server's /api/data, read-only.
//
// Public repositories need no token: a few API requests list the files, and their content comes
// from raw.githubusercontent.com, which has no hourly limit. Private repositories need a token of
// someone who can read them. It is only ever sent to api.github.com.

import { parsePromptFile } from './prompt-file.mjs';

const API = 'https://api.github.com';
const RAW = 'https://raw.githubusercontent.com';
const CONFIG_FILE = '.open-prompts.json';
const DEFAULT_DIR = 'prompts';
const CONCURRENCY = 8;
const HISTORY_BATCH = 40;

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

export class GitHubError extends Error {
  /** `kind` is one of: not-found, unauthorized, forbidden, rate-limited, no-prompts, network, failed. */
  constructor(kind, message, { status = null, resetAt = null } = {}) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.resetAt = resetAt;
  }
}

/**
 * The repository a link or name points to: { owner, repo, ref }, or null. Accepts "owner/repo",
 * github.com links (with /tree/<branch>), and git remotes. `ref` is null for the default branch.
 */
export function parseRepo(input) {
  const value = String(input ?? '')
    .trim()
    .replace(/^git@github\.com:/i, '')
    .replace(/^(?:git\+)?(?:https?|ssh|git):\/\/(?:[^@/]+@)?(?:www\.)?github\.com\//i, '')
    .replace(/^(?:www\.)?github\.com\//i, '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '');
  const [owner, name, kind, ...rest] = value.split('/');
  const repo = name?.replace(/\.git$/i, '');
  if (!OWNER_RE.test(owner ?? '') || !REPO_RE.test(repo ?? '') || repo === '.' || repo === '..') return null;
  let ref = null;
  if (kind === 'tree' && rest.length) {
    try {
      ref = decodeURIComponent(rest.join('/'));
    } catch {
      return null;
    }
  }
  return { owner, repo, ref };
}

/** The prompts directory a `.open-prompts.json` names, or the default one if it names none or a bad one. */
export function promptsDirOf(configText) {
  let config;
  try {
    config = JSON.parse(configText);
  } catch {
    return DEFAULT_DIR;
  }
  const dir = config?.dir;
  if (typeof dir !== 'string' || dir.trim() === '' || /^[\\/]|^[A-Za-z]:/.test(dir)) return DEFAULT_DIR;
  const parts = dir.split(/[\\/]/).filter((part) => part !== '' && part !== '.');
  return parts.length && !parts.includes('..') ? parts.join('/') : DEFAULT_DIR;
}

const encodePath = (path) => path.split('/').map(encodeURIComponent).join('/');

function rateLimitError(res, token) {
  const reset = Number(res.headers.get('x-ratelimit-reset'));
  const resetAt = Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000) : null;
  const message = token ? 'This token has reached its hourly limit of GitHub requests.' : 'GitHub allows only a few requests an hour without a token, and they are used up.';
  return new GitHubError('rate-limited', message, { status: res.status, resetAt });
}

/** A request to the GitHub API. JSON by default; `raw` gives the body as text. */
async function api(endpoint, { token, fetchImpl, accept = 'application/vnd.github+json', raw = false, method = 'GET', body }) {
  let res;
  try {
    res = await fetchImpl(`${API}${endpoint}`, {
      method,
      headers: { Accept: accept, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new GitHubError('network', 'GitHub could not be reached. Check your connection and try again.');
  }
  if (res.ok) return raw ? res.text() : res.json();
  const status = res.status;
  if ((status === 403 || status === 429) && res.headers.get('x-ratelimit-remaining') === '0') throw rateLimitError(res, token);
  if (status === 401) throw new GitHubError('unauthorized', 'GitHub did not accept the token. It may have expired or been revoked.', { status });
  if (status === 403) throw new GitHubError('forbidden', 'The token cannot read this repository.', { status });
  if (status === 404) throw new GitHubError('not-found', 'Not found.', { status });
  throw new GitHubError('failed', `GitHub answered ${status}. Try again in a moment.`, { status });
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Who added each prompt file, by file name, from the oldest commit of its history: one GraphQL
 * request for many files. GraphQL needs a token, so this is only done with one. Also gives the
 * login of the token's owner. Returns null when it fails: authors are a nice-to-have.
 */
async function fileAuthors(fullName, commit, paths, options) {
  const [owner, name] = fullName.split('/');
  const authors = new Map();
  let viewer = null;
  try {
    for (let i = 0; i < paths.length; i += HISTORY_BATCH) {
      const batch = paths.slice(i, i + HISTORY_BATCH);
      const fields = batch
        .map((_, n) => `f${n}: history(first: 100, path: $p${n}) { nodes { author { name email user { login name avatarUrl(size: 96) } } } }`)
        .join('\n');
      const query = `query($owner: String!, $name: String!, $oid: GitObjectID!${batch.map((_, n) => `, $p${n}: String!`).join('')}) {
        viewer { login }
        repository(owner: $owner, name: $name) { object(oid: $oid) { ... on Commit { ${fields} } } }
      }`;
      const variables = { owner, name, oid: commit, ...Object.fromEntries(batch.map((path, n) => [`p${n}`, path])) };
      const result = await api('/graphql', { ...options, method: 'POST', body: { query, variables } });
      if (!result?.data?.repository?.object) return null;
      viewer = result.data.viewer?.login ?? viewer;
      batch.forEach((path, n) => {
        // History runs from the newest commit: the last one is the commit that added the file.
        const author = result.data.repository.object[`f${n}`]?.nodes?.at(-1)?.author;
        if (author) authors.set(path.slice(path.lastIndexOf('/') + 1), author);
      });
    }
  } catch (error) {
    if (error.kind === 'unauthorized') throw error;
    return null;
  }
  return { authors, viewer };
}

/** Contributors in the shape the interface expects, and the author of each session. */
function contributorsOf(sessions, found) {
  const contributors = {};
  if (!found) return contributors;
  for (const session of sessions) {
    const author = found.authors.get(session.file);
    if (!author) continue;
    const user = author.user;
    const email = String(author.email ?? '').toLowerCase();
    const key = user?.login ? `github.com:${user.login.toLowerCase()}` : email ? `email:${email}` : null;
    if (!key) continue;
    session.author = key;
    contributors[key] ??= {
      name: user?.name || author.name || user?.login || email,
      login: user?.login ?? null,
      host: user?.login ? 'github.com' : null,
      url: user?.login ? `https://github.com/${user.login}` : null,
      avatar: user?.avatarUrl ?? null,
      you: Boolean(user?.login && found.viewer && user.login.toLowerCase() === found.viewer.toLowerCase()),
      aliases: [],
    };
  }
  return contributors;
}

/**
 * Everything the interface shows for `{ owner, repo, ref }`, read from GitHub at the latest
 * commit of `ref` (the default branch when null). Throws a GitHubError.
 */
export async function loadRepository({ owner, repo, ref = null }, { token = null, fetchImpl = (...args) => globalThis.fetch(...args) } = {}) {
  const options = { token, fetchImpl };
  const info = await api(`/repos/${owner}/${repo}`, options).catch((error) => {
    if (error.kind === 'not-found') {
      throw new GitHubError(
        'not-found',
        token
          ? `${owner}/${repo} does not exist, or the token cannot read it.`
          : `${owner}/${repo} does not exist, or it is private. To open a private repository, add a token that can read it.`,
        { status: 404 },
      );
    }
    throw error;
  });
  const fullName = info.full_name;
  const base = `/repos/${fullName}`;
  const branch = ref ?? info.default_branch;
  const commit = (
    await api(`${base}/commits/${encodePath(branch)}`, { ...options, accept: 'application/vnd.github.sha', raw: true }).catch((error) => {
      if (error.kind === 'not-found' || error.status === 422) throw new GitHubError('not-found', `${fullName} has no branch, tag or commit named "${branch}".`, { status: 404 });
      throw error;
    })
  ).trim();

  // Public files come from raw.githubusercontent.com, at the commit, so the hourly API limit
  // only counts a handful of requests. Private ones can only come from the API.
  const readBlob = async (entry, path) => {
    if (!info.private) {
      const res = await fetchImpl(`${RAW}/${fullName}/${commit}/${encodePath(path)}`).catch(() => null);
      if (res?.ok) return res.text();
    }
    return api(`${base}/git/blobs/${entry.sha}`, { ...options, accept: 'application/vnd.github.raw+json', raw: true });
  };
  const tree = async (sha) => (await api(`${base}/git/trees/${sha}`, options)).tree ?? [];

  const root = await tree(commit);
  const configEntry = root.find((entry) => entry.path === CONFIG_FILE && entry.type === 'blob');
  const dir = configEntry ? promptsDirOf(await readBlob(configEntry, CONFIG_FILE)) : DEFAULT_DIR;
  let entries = root;
  for (const part of dir.split('/')) {
    const sub = entries.find((entry) => entry.path === part && entry.type === 'tree');
    entries = sub ? await tree(sub.sha) : null;
    if (!entries) break;
  }
  if (!configEntry && !entries) {
    throw new GitHubError('no-prompts', `${fullName} does not record its prompts with Open Prompts yet: it has no ${CONFIG_FILE}.`);
  }
  const files = (entries ?? []).filter((entry) => entry.type === 'blob' && entry.path.endsWith('.jsonl')).sort((a, b) => (a.path < b.path ? -1 : 1));

  const parsed = await mapLimit(files, CONCURRENCY, async (entry) => parsePromptFile(entry.path, await readBlob(entry, `${dir}/${entry.path}`)));
  const prompts = [];
  const sessions = [];
  for (const { prompts: filePrompts, session } of parsed) {
    if (!session) continue;
    prompts.push(...filePrompts);
    sessions.push({ ...session, git: null });
  }
  const found = token && sessions.length ? await fileAuthors(fullName, commit, sessions.map((s) => `${dir}/${s.file}`), options) : null;

  return {
    contributors: contributorsOf(sessions, found),
    project: {
      icon: info.owner?.avatar_url ? `${info.owner.avatar_url}${info.owner.avatar_url.includes('?') ? '&' : '?'}s=64` : null,
      name: info.name,
      fullName,
      root: info.html_url,
      displayRoot: `${fullName} · ${branch}`,
      dir,
      url: info.html_url,
      ref: branch,
      commit,
      private: Boolean(info.private),
    },
    recording: true,
    pausedByEnv: false,
    sessions,
    prompts,
    problems: [],
  };
}
