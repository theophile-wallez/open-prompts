// Who wrote each session, from git: the author of the commit that added its prompt file, or the
// local git identity for a file that is not committed yet. Authors are then matched to their
// account on the forge the repository is hosted on (GitHub, GitLab, or Gravatar elsewhere), in
// the background, and the avatars are downloaded once and served by the local server.

import crypto from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const LOOKUP_TTL = 7 * 24 * 3600 * 1000; // An unknown author is looked up again after a week.
const AVATAR_TTL = 7 * 24 * 3600 * 1000;
const MAX_AVATAR_BYTES = 1024 * 1024;
const AVATAR_TYPES = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };
const USER_AGENT = 'open-prompts';

const git = (cwd, args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return result.status === 0 && typeof result.stdout === 'string' ? result.stdout : null;
};

/** { host, path } of a git remote URL, such as { host: 'github.com', path: 'owner/repo' }. */
export function parseRemote(url) {
  if (typeof url !== 'string') return null;
  const value = url.trim();
  const match =
    value.match(/^[a-z+]+:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/i) ?? // https://, ssh://
    value.match(/^(?:[^@/]+@)?([^/:]+):(?!\/)(.+?)(?:\.git)?\/?$/); // git@host:owner/repo
  if (!match || !match[2].includes('/')) return null;
  return { host: match[1].toLowerCase(), path: match[2] };
}

/** The forge account an email address names by itself: the private "noreply" addresses. */
export function accountFromEmail(email) {
  const value = String(email).toLowerCase();
  let match = value.match(/^(\d+)\+([a-z0-9-]+)@users\.noreply\.github\.com$/);
  if (match) return { host: 'github.com', login: match[2], id: Number(match[1]) };
  match = value.match(/^([a-z0-9-]+)@users\.noreply\.github\.com$/);
  if (match) return { host: 'github.com', login: match[1], id: null };
  match = value.match(/^(\d+)-([a-z0-9._-]+)@users\.noreply\.gitlab\.com$/);
  if (match) return { host: 'gitlab.com', login: match[2], id: Number(match[1]) };
  return null;
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** What a noreply address tells before any lookup, including the GitHub avatar of a numbered one. */
function noreplyAccount(email) {
  const account = accountFromEmail(email);
  if (!account) return null;
  const avatarUrl = account.host === 'github.com' && account.id ? `https://avatars.githubusercontent.com/u/${account.id}?v=4` : null;
  return { ...account, name: null, avatarUrl };
}

const isGitLab = (host) => host === 'gitlab.com' || host.startsWith('gitlab.');

/**
 * The author of each committed prompt file, by file name: { name, email, commit }.
 * One `git log` for the whole folder; .mailmap is applied.
 */
export function committedAuthors(root, promptsDir) {
  const out = git(root, ['-c', 'core.quotepath=off', 'log', '--diff-filter=A', '--use-mailmap', '--format=%x1e%H%x1f%aN%x1f%aE', '--name-only', '--', promptsDir]);
  const authors = new Map();
  if (!out) return authors;
  for (const entry of out.split('\x1e')) {
    const [header, ...names] = entry.split('\n');
    const [commit, name, email] = header.split('\x1f');
    if (!commit || email === undefined) continue;
    for (const file of names) {
      // The log runs from the newest commit, so the first addition seen is the file as it is now.
      if (file && !authors.has(path.basename(file))) authors.set(path.basename(file), { name, email, commit });
    }
  }
  return authors;
}

/** The identity git uses for new commits here, or null. */
export function localIdentity(root) {
  const match = git(root, ['var', 'GIT_AUTHOR_IDENT'])?.match(/^(.*?) <([^>]*)>/);
  return match ? { name: match[1], email: match[2] } : null;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value));
  fs.renameSync(temp, file);
}

function hasGh() {
  return spawnSync('gh', ['--version'], { stdio: 'ignore' }).status === 0;
}

/** GET on the GitHub API: through the gh CLI when it is signed in (private repositories), else anonymously. */
function githubApi(endpoint, { useGh, fetchImpl }) {
  if (useGh) {
    return new Promise((resolve) => {
      execFile('gh', ['api', endpoint], { timeout: 15000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
        if (!error) {
          try {
            return resolve(JSON.parse(stdout));
          } catch {
            // Fall through to an anonymous request.
          }
        }
        resolve(githubApi(endpoint, { useGh: false, fetchImpl }));
      });
    });
  }
  return fetchImpl(`https://api.github.com/${endpoint}`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(15000) })
    .then((res) => (res.ok ? res.json() : null))
    .catch(() => null);
}

/**
 * The contributors of one project. `sessionAuthors(sessions)` gives the author of each session
 * at once, from what is known; accounts that are not known yet are looked up in the background,
 * and `onChange` is called when they are.
 */
export function createContributors({ project, cacheDir, offline = false, onChange = () => {}, fetchImpl = globalThis.fetch, useGh: ghChoice }) {
  const root = project.root;
  const cacheFile = path.join(cacheDir, 'contributors.json');
  const avatarDir = path.join(cacheDir, 'avatars');
  // "<forge host> <email>" → { checkedAt, account: { host, login, id, name, avatarUrl } | null }
  const known = readJson(cacheFile)?.accounts ?? {};
  const remote = parseRemote(git(root, ['remote', 'get-url', 'origin']));
  // One address can be on different accounts on different forges.
  const cacheKey = (email) => `${remote?.host ?? ''} ${email}`;
  const avatars = new Map(); // avatar id → source URL
  const pending = new Set();
  let useGh = ghChoice;
  let headCache = { head: null, authors: new Map() };

  const save = () => {
    try {
      writeJsonAtomic(cacheFile, { version: 1, accounts: known });
    } catch {
      // The cache only saves requests.
    }
  };

  async function lookup(email, commit) {
    const host = remote?.host;
    const fromEmail = accountFromEmail(email);
    let account = null;
    if (host === 'github.com' || fromEmail?.host === 'github.com') {
      useGh ??= hasGh();
      const options = { useGh, fetchImpl };
      let login = fromEmail?.host === 'github.com' ? fromEmail.login : null;
      let id = fromEmail?.id ?? null;
      let avatarUrl = null;
      // A session that is not committed yet: any commit of the same author here will do.
      commit ??= git(root, ['log', '-1', '-i', '--format=%H', `--author=<${escapeRegExp(email)}>`])?.trim() || null;
      if (!login && commit && host === 'github.com') {
        const author = (await githubApi(`repos/${remote.path}/commits/${commit}`, options))?.author;
        if (author?.login) ({ login, id, avatar_url: avatarUrl } = author);
      }
      if (login) {
        const user = await githubApi(`users/${encodeURIComponent(login)}`, options);
        account = {
          host: 'github.com',
          login,
          id: user?.id ?? id,
          name: user?.name || null,
          avatarUrl: user?.avatar_url ?? avatarUrl ?? (id ? `https://avatars.githubusercontent.com/u/${id}?v=4` : `https://github.com/${login}.png`),
        };
      }
    } else if ((host && isGitLab(host)) || fromEmail?.host === 'gitlab.com') {
      const gitlab = host && isGitLab(host) ? host : 'gitlab.com';
      const res = await fetchImpl(`https://${gitlab}/api/v4/avatar?email=${encodeURIComponent(email)}&size=96`, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(15000) }).catch(() => null);
      const avatarUrl = res?.ok ? (await res.json().catch(() => null))?.avatar_url : null;
      // GitLab answers with a generated pattern for unknown addresses: ask Gravatar for nothing instead.
      account = {
        host: gitlab,
        login: fromEmail?.host === 'gitlab.com' ? fromEmail.login : null,
        id: fromEmail?.id ?? null,
        name: null,
        avatarUrl: avatarUrl ? avatarUrl.replace(/([?&]d=)identicon/, '$1404') : null,
      };
    } else {
      const hash = crypto.createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
      account = { host: 'gravatar.com', login: null, id: null, name: null, avatarUrl: `https://gravatar.com/avatar/${hash}?s=96&d=404` };
    }
    return account;
  }

  function schedule(identities) {
    if (offline) return;
    const todo = [];
    const now = Date.now();
    for (const [email, commit] of identities) {
      const entry = known[cacheKey(email)];
      const fresh = entry && (entry.account || now - entry.checkedAt < LOOKUP_TTL);
      if (!fresh && !pending.has(email)) todo.push([email, commit]);
    }
    if (todo.length === 0) return;
    for (const [email] of todo) pending.add(email);
    (async () => {
      let changed = false;
      // A few at a time: anonymous GitHub requests are limited to 60 an hour.
      for (let i = 0; i < todo.length; i += 4) {
        await Promise.all(
          todo.slice(i, i + 4).map(async ([email, commit]) => {
            try {
              const account = await lookup(email, commit);
              known[cacheKey(email)] = { checkedAt: Date.now(), account };
              changed ||= Boolean(account);
            } catch {
              known[cacheKey(email)] = { checkedAt: Date.now(), account: null };
            } finally {
              pending.delete(email);
            }
          }),
        );
      }
      save();
      if (changed) onChange();
    })();
  }

  function authorsByFile() {
    const head = git(root, ['rev-parse', '--verify', '-q', 'HEAD'])?.trim() ?? '';
    if (head !== headCache.head) headCache = { head, authors: committedAuthors(root, project.promptsDir) };
    return headCache.authors;
  }

  const avatarId = (url) => crypto.createHash('sha256').update(url).digest('hex').slice(0, 20);

  /**
   * Adds `author` (a contributor key) to each session, and returns the contributors by key:
   * { name, login, host, url, avatar, you }. `git` is the status of each file, from `git status`.
   */
  function sessionAuthors(sessions, gitStatus) {
    if (!gitStatus) return {};
    const committed = authorsByFile();
    const local = localIdentity(root);
    const contributors = {};
    const names = new Map(); // key → Map(name → count)
    const identities = new Map();
    for (const session of sessions) {
      const identity = committed.get(session.file) ?? (session.git === 'new' ? local && { ...local, commit: null } : null);
      if (!identity?.email) continue;
      const email = identity.email.toLowerCase();
      if (identity.commit || !identities.has(email)) identities.set(email, identity.commit ?? identities.get(email) ?? null);
      // The commit of another session by the same address finds the account of a local session too.
      const account = known[cacheKey(email)]?.account ?? noreplyAccount(email);
      const key = account?.login ? `${account.host}:${account.login.toLowerCase()}` : `email:${email}`;
      session.author = key;
      const counts = names.get(key) ?? new Map();
      counts.set(identity.name, (counts.get(identity.name) ?? 0) + 1);
      names.set(key, counts);
      const contributor = (contributors[key] ??= { name: null, login: account?.login ?? null, host: account?.host ?? null, url: null, avatar: null, you: false, aliases: [] });
      // The keys this person had before their account was found, so a filter on them carries over.
      if (!contributor.aliases.includes(`email:${email}`) && key !== `email:${email}`) contributor.aliases.push(`email:${email}`);
      if (account?.name) contributor.name = account.name;
      if (account?.login) contributor.url = `https://${account.host}/${account.login}`;
      if (account?.avatarUrl && !offline) {
        const id = avatarId(account.avatarUrl);
        avatars.set(id, account.avatarUrl);
        contributor.avatar = `/avatar/${id}`;
      }
      if (local && email === local.email.toLowerCase()) contributor.you = true;
    }
    // Several git names can point to one account: show the profile name, else the most used one.
    for (const [key, counts] of names) {
      contributors[key].name ??= [...counts].sort((a, b) => b[1] - a[1])[0][0] || contributors[key].login || key.replace(/^email:/, '');
    }
    schedule(identities);
    return contributors;
  }

  /** The cached avatar `id` as { body, type }, downloading it first if needed, or null. */
  async function avatar(id) {
    const url = avatars.get(id);
    if (!url || offline) return null;
    const base = path.join(avatarDir, id);
    for (const [type, ext] of Object.entries(AVATAR_TYPES)) {
      try {
        const stats = fs.statSync(base + ext);
        if (Date.now() - stats.mtimeMs < AVATAR_TTL) return { body: fs.readFileSync(base + ext), type };
      } catch {
        // Not downloaded in this format.
      }
    }
    const res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT }, redirect: 'follow', signal: AbortSignal.timeout(15000) }).catch(() => null);
    const type = res?.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    if (!res?.ok || !AVATAR_TYPES[type] || Number(res.headers.get('content-length') ?? 0) > MAX_AVATAR_BYTES) return null;
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length === 0 || body.length > MAX_AVATAR_BYTES) return null;
    try {
      fs.mkdirSync(avatarDir, { recursive: true });
      for (const ext of Object.values(AVATAR_TYPES)) fs.rmSync(base + ext, { force: true });
      fs.writeFileSync(base + AVATAR_TYPES[type], body);
    } catch {
      // Served without caching.
    }
    return { body, type };
  }

  return { sessionAuthors, avatar };
}
