// Open Prompts interface. Plain modules, no framework: the page is rebuilt from `state` on each change.

import { LOGOS } from './logos.js';

const AGENTS = {
  'claude-code': ['Claude Code', 'claudecode'],
  codex: ['Codex', 'codex'],
  cursor: ['Cursor', 'cursor'],
  'gemini-cli': ['Gemini CLI', 'geminicli'],
  copilot: ['GitHub Copilot', 'githubcopilot'],
  opencode: ['OpenCode', 'opencode'],
  'mistral-vibe': ['Mistral Vibe', 'mistral'],
};
// Model IDs are recorded as each agent reports them, so the maker is guessed from the name,
// including provider prefixes such as "anthropic.claude-…" or "openrouter/z-ai/glm-…".
const MODEL_MAKERS = [
  [/claude|anthropic|opus|sonnet|haiku/, 'claude'],
  [/gemini|gemma/, 'gemini'],
  [/gpt|openai|codex|(^|[/:.\s-])o[1-9]/, 'openai'],
  [/mistral|devstral|codestral|magistral|ministral|pixtral/, 'mistral'],
  [/grok|x-ai|xai/, 'grok'],
  [/deepseek/, 'deepseek'],
  [/qwen/, 'qwen'],
  [/glm|z-ai|zai|zhipu/, 'zai'],
  [/kimi|moonshot/, 'kimi'],
  [/llama|meta/, 'meta'],
  [/composer|cursor/, 'cursor'],
];
const NO_MODEL = '\u0000none';
const NO_AUTHOR = '\u0000nobody';
const PAGE_SIZE = 100;
const SESSION_PAGE_SIZE = 50;
const CLAMP_LINES = 10;
const CLAMP_CHARS = 900;
const REDACTED_SPLIT = /(\[REDACTED:[a-z0-9-]+\])/;
const REDACTED_TOKEN = /^\[REDACTED:[a-z0-9-]+\]$/;

const ICONS = {
  copy: '<rect x="7" y="7" width="10" height="10" rx="2"/><path d="M13 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/>',
  edit: '<path d="M12.5 4.5l3 3L7 16H4v-3z"/><path d="M11 6l3 3"/>',
  trash: '<path d="M4 6h12"/><path d="M8 6V4h4v2"/><path d="M5.5 6l1 10h7l1-10"/>',
  cpu: '<rect x="5" y="5" width="10" height="10" rx="2"/><path d="M8 2.5V5M12 2.5V5M8 15v2.5M12 15v2.5M2.5 8H5M2.5 12H5M15 8h2.5M15 12h2.5"/>',
  check: '<path d="M2.5 6.5l2.5 2.5 5-6"/>',
  moon: '<path d="M15.5 12.5A6.5 6.5 0 0 1 7.5 4.5a6.5 6.5 0 1 0 8 8z"/>',
  x: '<path d="M6 6l8 8M14 6l-8 8"/>',
  inbox: '<path d="M3 11.5l2.2-6A1.5 1.5 0 0 1 6.6 4.5h6.8a1.5 1.5 0 0 1 1.4 1l2.2 6"/><path d="M3 11.5V15a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 17 15v-3.5h-4a3 3 0 0 1-6 0z"/>',
  search: '<circle cx="9" cy="9" r="5.5"/><path d="m13.2 13.2 3.8 3.8"/>',
  sun: '<circle cx="10" cy="10" r="3.5"/><path d="M10 2v1.5M10 16.5V18M2 10h1.5M16.5 10H18M4.3 4.3l1.1 1.1M14.6 14.6l1.1 1.1M4.3 15.7l1.1-1.1M14.6 5.4l1.1-1.1"/>',
};

const state = {
  data: null,
  query: '',
  agents: new Set(),
  authors: new Set(),
  models: new Set(),
  session: null,
  day: null,
  sort: 'newest',
  limit: PAGE_SIZE,
  sessionLimit: SESSION_PAGE_SIZE,
  editing: null,
  expanded: new Set(),
  fresh: new Map(),
  pendingRefresh: false,
};

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- Helpers

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'style') for (const [prop, v] of Object.entries(value)) el.style.setProperty(prop, v);
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

// Icons and logos are parsed once, then cloned: parsing SVG markup for every row is slow.
const svgTemplates = new Map();
function svgTemplate(key, viewBox, className, markup) {
  let template = svgTemplates.get(key);
  if (!template) {
    template = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    template.setAttribute('viewBox', viewBox);
    template.setAttribute('class', className);
    template.innerHTML = markup;
    svgTemplates.set(key, template);
  }
  return template.cloneNode(true);
}

function icon(name, viewBox = '0 0 20 20') {
  const el = svgTemplate(`icon:${name}:${viewBox}`, viewBox, 'icon', ICONS[name]);
  el.setAttribute('aria-hidden', 'true');
  return el;
}

const plural = (n, one, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const keyOf = (p) => `${p.file}:${p.line}:${p.hash}`;
const agentName = (slug) => AGENTS[slug]?.[0] ?? slug;
const modelMaker = (model) => MODEL_MAKERS.find(([re]) => re.test(String(model).toLowerCase()))?.[1] ?? null;

/** An agent or model logo, or a neutral glyph when the agent or model maker is unknown. */
let logoCount = 0;
function logo(name, label) {
  const known = LOGOS[name];
  const el = known
    ? svgTemplate(`logo:${name}`, known[0], known[2] ? 'logo logo-color' : 'logo', known[1])
    : svgTemplate('logo:unknown', '0 0 20 20', 'logo logo-unknown', ICONS.cpu);
  if (label) {
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', label);
  } else el.setAttribute('aria-hidden', 'true');
  // Gradients are referenced by id: give each copy its own, or hiding one copy breaks the others.
  const ids = el.querySelectorAll('[id]');
  if (ids.length > 0) {
    const suffix = `-l${++logoCount}`;
    for (const node of ids) node.id += suffix;
    for (const node of el.querySelectorAll('[fill^="url(#"], [stroke^="url(#"]')) {
      for (const attribute of ['fill', 'stroke']) {
        const value = node.getAttribute(attribute);
        if (value?.startsWith('url(#')) node.setAttribute(attribute, value.replace(/\)$/, `${suffix})`));
      }
    }
  }
  return el;
}

const agentLogo = (slug) => logo(AGENTS[slug]?.[1]);
const modelLogo = (model) => logo(model === NO_MODEL ? null : modelMaker(model));

// Contributors come from git: who added each session's prompt file, matched to a forge account.
const contributorOf = (key) => state.data?.contributors?.[key] ?? null;
const authorName = (key) => (key === NO_AUTHOR ? 'Unknown author' : (contributorOf(key)?.name ?? key.replace(/^email:/, '')));
const FORGES = { 'github.com': 'GitHub', 'gitlab.com': 'GitLab' };
const accountLabel = (contributor) => (contributor?.login ? `@${contributor.login}${FORGES[contributor.host] ? ` on ${FORGES[contributor.host]}` : ''}` : null);
const manyAuthors = () => Object.keys(state.data?.contributors ?? {}).length > 1;

/** The avatar of a contributor, or the first letter of their name until or unless it loads. */
function avatar(key) {
  const box = h('span', { class: 'avatar', 'aria-hidden': 'true' });
  const monogram = () => box.replaceChildren((authorName(key).match(/[\p{L}\p{N}]/u)?.[0] ?? '?').toUpperCase());
  const src = contributorOf(key)?.avatar;
  if (!src) {
    monogram();
    return box;
  }
  const img = h('img', { src, alt: '', decoding: 'async', loading: 'lazy' });
  img.addEventListener('error', monogram, { once: true });
  box.append(img);
  return box;
}

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const parseDay = (key) => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const fmtDate = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const fmtShortDate = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const fmtTime = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const fmtFull = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'medium' });

let parsedQuery = { query: '', words: [] };
function terms() {
  if (parsedQuery.query !== state.query) {
    parsedQuery = { query: state.query, words: state.query.toLowerCase().split(/\s+/).filter(Boolean) };
  }
  return parsedQuery.words;
}

// ---------------------------------------------------------------- Data

async function api(method, url, body) {
  const response = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error ?? `The server answered ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function load({ markFresh = false } = {}) {
  const previous = state.data ? new Set(state.data.prompts.map((p) => p.id ?? keyOf(p))) : null;
  const data = await api('GET', '/api/data');
  const positions = new Map();
  for (const p of data.prompts) {
    positions.set(p.file, (positions.get(p.file) ?? 0) + 1);
    p.position = positions.get(p.file);
    p.date = p.timestamp ? new Date(p.timestamp) : null;
    if (p.date && Number.isNaN(p.date.getTime())) p.date = null;
    p.day = p.date ? dayKey(p.date) : null;
  }
  // Prompts that arrived while the page was open are highlighted for a moment. A file change can
  // send several events, so the highlight lasts a little longer than one refresh.
  const now = Date.now();
  for (const [key, until] of state.fresh) if (until < now) state.fresh.delete(key);
  if (markFresh && previous) {
    for (const p of data.prompts) if (!previous.has(p.id ?? keyOf(p))) state.fresh.set(keyOf(p), now + 1500);
  }
  data.sessionsByFile = new Map(data.sessions.map((s) => [s.file, s]));
  for (const p of data.prompts) {
    const s = data.sessionsByFile.get(p.file);
    if (s && s.preview === undefined) s.preview = p.prompt.slice(0, 160);
    p.author = s?.author ?? null;
  }
  for (const s of data.sessions) s.preview ??= s.session;
  state.data = data;
  // Drop filters that point to things that no longer exist.
  if (state.session && !data.sessions.some((s) => s.file === state.session)) state.session = null;
  // An author's key changes once their account is found: keep the filter on the same person.
  for (const key of state.authors) {
    if (key === NO_AUTHOR || data.contributors[key]) continue;
    state.authors.delete(key);
    const moved = Object.keys(data.contributors).find((k) => data.contributors[k].aliases.includes(key));
    if (moved) state.authors.add(moved);
  }
  render();
}

async function refresh(options) {
  if (state.editing) {
    state.pendingRefresh = true;
    return;
  }
  try {
    await load(options);
  } catch (error) {
    toast(error.message, 'error');
  }
}

// ---------------------------------------------------------------- Filtering

function matches(p, { ignore } = {}) {
  if (ignore !== 'author' && state.authors.size && !state.authors.has(p.author ?? NO_AUTHOR)) return false;
  if (ignore !== 'agent' && state.agents.size && !state.agents.has(p.agent)) return false;
  if (ignore !== 'model' && state.models.size && !state.models.has(p.model ?? NO_MODEL)) return false;
  if (ignore !== 'session' && state.session && p.file !== state.session) return false;
  if (ignore !== 'day' && state.day && p.day !== state.day) return false;
  return matchesQuery(p);
}

/** Whether `p` contains every searched word. Remembered per prompt until the search changes. */
function matchesQuery(p) {
  const words = terms();
  if (words.length === 0) return true;
  if (p.matchedQuery === state.query) return p.queryMatch;
  // Built on the first search only: it is a lowercase copy of every prompt.
  const author = p.author ? `${authorName(p.author)}\n${contributorOf(p.author)?.login ?? ''}` : '';
  p.haystack ??= `${p.prompt}\n${p.model ?? ''}\n${p.session}\n${agentName(p.agent)}\n${p.agent}\n${author}`.toLowerCase();
  p.matchedQuery = state.query;
  p.queryMatch = words.every((term) => p.haystack.includes(term));
  return p.queryMatch;
}

const hasFilters = () => Boolean(state.query || state.authors.size || state.agents.size || state.models.size || state.session || state.day);

function clearFilters() {
  state.query = '';
  $('search').value = '';
  state.authors.clear();
  state.agents.clear();
  state.models.clear();
  state.session = null;
  state.day = null;
  state.limit = PAGE_SIZE;
  render();
}

// The filters live in the address, so a reload keeps them.
function saveHash() {
  const params = new URLSearchParams();
  if (state.query) params.set('q', state.query);
  for (const author of state.authors) params.append('author', author === NO_AUTHOR ? '' : author);
  for (const agent of state.agents) params.append('agent', agent);
  for (const model of state.models) params.append('model', model === NO_MODEL ? '' : model);
  if (state.session) params.set('session', state.session);
  if (state.day) params.set('day', state.day);
  if (state.sort !== 'newest') params.set('sort', state.sort);
  const hash = params.toString();
  history.replaceState(null, '', `${location.pathname}${location.search}${hash ? `#${hash}` : ''}`);
}

function readHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  state.query = params.get('q') ?? '';
  state.authors = new Set(params.getAll('author').map((a) => (a === '' ? NO_AUTHOR : a)));
  state.agents = new Set(params.getAll('agent'));
  state.models = new Set(params.getAll('model').map((m) => (m === '' ? NO_MODEL : m)));
  state.session = params.get('session');
  state.day = /^\d{4}-\d{2}-\d{2}$/.test(params.get('day') ?? '') ? params.get('day') : null;
  state.sort = params.get('sort') === 'oldest' ? 'oldest' : 'newest';
  $('search').value = state.query;
}

function renderSort() {
  for (const button of $('sort').querySelectorAll('button')) {
    const checked = button.dataset.value === state.sort;
    button.setAttribute('aria-checked', String(checked));
    button.tabIndex = checked ? 0 : -1;
  }
  placeSortIndicator();
}

/** Moves the pill under the chosen order. It slides once the first position is set. */
function placeSortIndicator() {
  const group = $('sort');
  const checked = group.querySelector('[aria-checked="true"]');
  if (!checked) return;
  const indicator = group.querySelector('.segmented-indicator');
  indicator.style.setProperty('--x', `${checked.offsetLeft}px`);
  indicator.style.setProperty('--w', `${checked.offsetWidth}px`);
  if (!group.hasAttribute('data-ready')) requestAnimationFrame(() => group.setAttribute('data-ready', ''));
}

// ---------------------------------------------------------------- Rendering

function render() {
  const { data } = state;
  if (!data) return;
  saveHash();
  document.title = `${data.project.name} · Open Prompts`;
  $('project-name').textContent = data.project.name;
  $('project-path').textContent = data.project.displayRoot;
  $('project-path').title = data.project.root;
  renderProjectIcon(data.project);

  renderRecording();
  renderSort();
  // Contributors are listed when there is more than one, or a filter on one is set.
  const authorsShown = manyAuthors() || state.authors.size > 0;
  $('authors-group').hidden = !authorsShown;
  if (authorsShown) renderFacet('authors', 'author', (p) => p.author ?? NO_AUTHOR, authorName, avatar);
  renderFacet('agents', 'agent', (p) => p.agent, agentName, agentLogo);
  renderFacet('models', 'model', (p) => p.model ?? NO_MODEL, (model) => (model === NO_MODEL ? 'Unknown model' : model), modelLogo);
  renderSessions();
  renderProblems();
  renderList();
}

/** The project's own icon, found like T3 Code finds it, or the first letter of its name. */
function renderProjectIcon(project) {
  const box = $('project-icon');
  if (box.dataset.src === String(project.icon)) return;
  box.dataset.src = String(project.icon);
  const monogram = () => {
    box.removeAttribute('data-image');
    box.replaceChildren(h('span', { class: 'workspace-monogram' }, (project.name.match(/[\p{L}\p{N}]/u)?.[0] ?? '?').toUpperCase()));
  };
  // The tab shows the project's icon too, which tells several open projects apart.
  const tabIcon = document.querySelector('link[rel="icon"]');
  tabIcon.removeAttribute('type');
  tabIcon.href = project.icon ?? '/favicon.svg';
  if (!project.icon) return monogram();
  const img = h('img', { src: project.icon, alt: '', width: 32, height: 32, decoding: 'async' });
  img.addEventListener('error', monogram, { once: true });
  box.setAttribute('data-image', '');
  box.replaceChildren(img);
}

function renderRecording() {
  const button = $('recording');
  const { recording, pausedByEnv } = state.data;
  button.setAttribute('aria-pressed', String(recording));
  $('recording-label').textContent = recording ? 'Recording' : 'Paused';
  button.disabled = pausedByEnv;
  button.title = pausedByEnv
    ? 'Paused by OPEN_PROMPTS=off in the environment of "open-prompts ui"'
    : recording
      ? 'Prompts are recorded on this machine. Click to pause.'
      : 'Recording is paused on this machine. Click to resume.';
}

function renderFacet(listId, kind, valueOf, labelOf, logoOf) {
  const set = { agent: state.agents, model: state.models, author: state.authors }[kind];
  const counts = new Map();
  for (const p of state.data.prompts) {
    const value = valueOf(p);
    if (!counts.has(value)) counts.set(value, 0);
    if (matches(p, { ignore: kind })) counts.set(value, counts.get(value) + 1);
  }
  for (const value of set) if (!counts.has(value)) counts.set(value, 0);
  const entries = [...counts].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
  const list = $(listId);
  list.replaceChildren(
    ...entries.map(([value, count]) =>
      h(
        'li',
        {},
        h(
          'button',
          {
            class: 'nav-item',
            type: 'button',
            'aria-pressed': String(set.has(value)),
            'data-zero': count === 0,
            onclick: () => {
              if (set.has(value)) set.delete(value);
              else set.add(value);
              state.limit = PAGE_SIZE;
              render();
            },
          },
          h('span', { class: 'check' }, icon('check', '0 0 12 12')),
          logoOf(value),
          h('span', { class: 'nav-text' }, labelOf(value)),
          h('span', { class: 'count' }, count.toLocaleString()),
        ),
      ),
    ),
  );
  if (entries.length === 0) list.replaceChildren(h('li', { class: 'nav-empty' }, 'None yet'));
}

function sessionsInOrder() {
  const sessions = [...state.data.sessions];
  sessions.sort((a, b) => String(a.first ?? a.file).localeCompare(String(b.first ?? b.file)));
  if (state.sort === 'newest') sessions.reverse();
  return sessions;
}

function renderSessions() {
  const byFile = new Map();
  for (const p of state.data.prompts) {
    if (!matches(p, { ignore: 'session' })) continue;
    if (!byFile.has(p.file)) byFile.set(p.file, []);
    byFile.get(p.file).push(p);
  }
  const matching = sessionsInOrder().filter((s) => byFile.has(s.file) || s.file === state.session);
  // A long history only shows its most recent sessions, plus the chosen one wherever it is.
  const chosen = matching.findIndex((s) => s.file === state.session);
  if (chosen >= state.sessionLimit) state.sessionLimit = Math.ceil((chosen + 1) / SESSION_PAGE_SIZE) * SESSION_PAGE_SIZE;
  const items = matching
    .slice(0, state.sessionLimit)
    .map((s) => {
      const prompts = byFile.get(s.file) ?? [];
      const date = s.first ? new Date(s.first) : null;
      return h(
        'li',
        {},
        h(
          'button',
          {
            class: 'nav-item session-item',
            type: 'button',
            'aria-pressed': String(state.session === s.file),
            onclick: () => {
              state.session = state.session === s.file ? null : s.file;
              state.limit = PAGE_SIZE;
              render();
              $('results').focus({ preventScroll: true });
              window.scrollTo({ top: 0 });
            },
          },
          h(
            'span',
            { class: 'session-item-top' },
            manyAuthors() && s.author ? avatar(s.author) : null,
            logo(AGENTS[s.agent]?.[1], agentName(s.agent)),
            h('span', {}, date ? fmtShortDate.format(date) : s.file),
            h('span', { class: 'grow' }),
            gitBadge(s.git),
            h('span', { class: 'count' }, hasFilters() && prompts.length !== s.count ? `${prompts.length}/${s.count}` : s.count),
          ),
          h('span', { class: 'session-item-text' }, s.preview),
        ),
      );
    });
  const hidden = matching.length - items.length;
  if (hidden > 0) {
    items.push(
      h(
        'li',
        {},
        h(
          'button',
          {
            class: 'nav-more',
            type: 'button',
            onclick: () => {
              const first = state.sessionLimit;
              state.sessionLimit += SESSION_PAGE_SIZE;
              renderSessions();
              $('sessions').children[first]?.querySelector('button')?.focus();
            },
          },
          hidden > SESSION_PAGE_SIZE ? `Show ${SESSION_PAGE_SIZE} more of ${hidden.toLocaleString()}` : `Show ${hidden.toLocaleString()} more`,
        ),
      ),
    );
  }
  $('sessions').replaceChildren(...(items.length ? items : [h('li', { class: 'nav-empty' }, 'No sessions')]));
}

function gitBadge(git) {
  if (git === 'new') return h('span', { class: 'badge', 'data-state': 'new', title: 'Not committed yet' }, 'New');
  if (git === 'modified') return h('span', { class: 'badge', 'data-state': 'modified', title: 'Changed since the last commit' }, 'Changed');
  return null;
}

const SPARK_DAYS = 14;

/** One quiet line: totals for the filtered prompts, and bars for the last two weeks. */
function renderOverview(visible, sessionCount) {
  const stat = (value, one, many, extra) =>
    h('p', { class: 'overview-stat' }, h('strong', {}, value.toLocaleString()), ` ${value === 1 ? one : many}`, extra && h('span', {}, ` ${extra}`));
  const files = new Set(visible.map((p) => p.file));
  const tracked = state.data.sessions.some((s) => s.git !== null);
  const uncommitted = state.data.sessions.filter((s) => files.has(s.file) && (s.git === 'new' || s.git === 'modified')).length;

  // The bars count the prompts that match every filter but the day, so a day can be picked from them.
  const counts = new Map();
  let lastDay = null;
  for (const p of state.data.prompts) {
    if (!p.day) continue;
    if (!lastDay || p.day > lastDay) lastDay = p.day;
    if (matches(p, { ignore: 'day' })) counts.set(p.day, (counts.get(p.day) ?? 0) + 1);
  }
  const days = [];
  if (lastDay) {
    const today = dayKey(new Date());
    const end = parseDay(lastDay > today ? lastDay : today);
    for (let i = SPARK_DAYS - 1; i >= 0; i--) {
      const date = new Date(end);
      date.setDate(end.getDate() - i);
      const day = dayKey(date);
      const count = counts.get(day) ?? 0;
      days.push({ day, count, label: `${fmtDate.format(date)}: ${plural(count, 'prompt')}` });
    }
  }
  const max = Math.max(1, ...days.map((d) => d.count));
  // One bar carries the accent: the chosen day, or else the latest day with prompts.
  const highlight = state.day ?? [...days].reverse().find((d) => d.count)?.day;

  $('overview').replaceChildren(
    h(
      'div',
      { class: 'overview-stats', 'aria-live': 'polite' },
      stat(visible.length, 'prompt', 'prompts', hasFilters() ? `of ${state.data.prompts.length.toLocaleString()}` : null),
      stat(sessionCount, 'session', 'sessions'),
      tracked && stat(uncommitted, 'not committed', 'not committed'),
    ),
    days.length > 0 &&
      h(
        'div',
        { class: 'overview-chart' },
        h('span', { class: 'overview-chart-label' }, `Last ${SPARK_DAYS} days`),
        h(
          'div',
          { class: 'spark', role: 'group', 'aria-label': `Prompts per day over the last ${SPARK_DAYS} days. Choose a day to show only its prompts.` },
          days.map((d) =>
            h('button', {
              class: 'spark-day',
              type: 'button',
              style: { '--h': `${(d.count / max) * 100}%` },
              'data-empty': d.count === 0,
              'data-highlight': d.day === highlight,
              'aria-pressed': String(state.day === d.day),
              'aria-label': d.label,
              'data-tip': d.label,
              disabled: d.count === 0 && state.day !== d.day,
              onclick: () => {
                state.day = state.day === d.day ? null : d.day;
                state.limit = PAGE_SIZE;
                render();
              },
            }),
          ),
        ),
      ),
  );
}

function renderProblems() {
  const { problems } = state.data;
  const box = $('problems');
  if (problems.length === 0) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.replaceChildren(
    h(
      'details',
      {},
      h('summary', {}, `${plural(problems.length, 'problem')} in the prompt files. Lines that are not valid JSON are not shown.`),
      h('ul', {}, problems.slice(0, 50).map((p) => h('li', {}, `${p.file}${p.line ? `:${p.line}` : ''}: ${p.message}`))),
    ),
  );
}

function renderList() {
  const list = $('list');
  const visible = state.data.prompts.filter((p) => matches(p));
  const sessionCount = new Set(visible.map((p) => p.file)).size;

  renderOverview(visible, sessionCount);
  renderActiveFilters();

  if (state.data.prompts.length === 0) {
    list.replaceChildren(
      h(
        'div',
        { class: 'empty' },
        h('span', { class: 'empty-icon' }, icon('inbox')),
        h('h2', {}, 'No prompts yet'),
        h(
          'p',
          {},
          'Prompts you type to a coding agent in this repository appear here as soon as they are recorded. If nothing shows up after your next prompt, run ',
          h('code', {}, 'open-prompts status'),
          '.',
        ),
      ),
    );
    return;
  }
  if (visible.length === 0) {
    list.replaceChildren(
      h(
        'div',
        { class: 'empty' },
        h('span', { class: 'empty-icon' }, icon('search')),
        h('h2', {}, 'No prompts match these filters'),
        h('p', {}, 'Try other words, or remove a filter.'),
        h('button', { class: 'button', type: 'button', onclick: clearFilters }, 'Clear filters'),
      ),
    );
    return;
  }

  const byFile = new Map();
  for (const p of visible) {
    if (!byFile.has(p.file)) byFile.set(p.file, []);
    byFile.get(p.file).push(p);
  }
  let remaining = state.limit;
  const groups = [];
  for (const session of sessionsInOrder()) {
    const prompts = byFile.get(session.file);
    if (!prompts || remaining <= 0) continue;
    const shown = prompts.slice(0, remaining);
    remaining -= shown.length;
    groups.push(renderSession(session, shown));
  }
  if (remaining <= 0 && visible.length > state.limit) {
    groups.push(
      h(
        'button',
        {
          class: 'button load-more',
          type: 'button',
          onclick: () => {
            state.limit += PAGE_SIZE;
            render();
          },
        },
        `Show ${Math.min(PAGE_SIZE, visible.length - state.limit).toLocaleString()} more prompts`,
      ),
    );
  }
  list.replaceChildren(...groups);
  loadMoreObserver.disconnect();
  const more = list.querySelector('.load-more');
  if (more) loadMoreObserver.observe(more);
}

// The next prompts load on their own a little before the end of the list comes into view. Not
// while a prompt is being edited: rendering again would drop the text being typed.
const loadMoreObserver = new IntersectionObserver(
  (entries) => {
    if (entries.some((entry) => entry.isIntersecting && entry.target.isConnected) && !state.editing) {
      loadMoreObserver.disconnect();
      entries[0].target.click();
    }
  },
  { rootMargin: '0px 0px 800px 0px' },
);

/** The filters in use, as chips that remove them. */
function renderActiveFilters() {
  const chips = [];
  const chip = (label, remove) =>
    chips.push(
      h(
        'button',
        {
          class: 'filter-chip',
          type: 'button',
          'aria-label': `Remove filter: ${label}`,
          onclick: () => {
            remove();
            state.limit = PAGE_SIZE;
            render();
          },
        },
        h('span', {}, label),
        icon('x'),
      ),
    );
  if (state.query) {
    chip(`“${state.query}”`, () => {
      state.query = '';
      $('search').value = '';
    });
  }
  for (const author of state.authors) chip(authorName(author), () => state.authors.delete(author));
  for (const agent of state.agents) chip(agentName(agent), () => state.agents.delete(agent));
  for (const model of state.models) chip(model === NO_MODEL ? 'Unknown model' : model, () => state.models.delete(model));
  if (state.session) {
    const session = state.data.sessions.find((s) => s.file === state.session);
    chip(`Session ${session?.first ? fmtShortDate.format(new Date(session.first)) : state.session}`, () => (state.session = null));
  }
  if (state.day) chip(fmtShortDate.format(parseDay(state.day)), () => (state.day = null));
  const box = $('active-filters');
  box.hidden = chips.length === 0;
  if (chips.length > 1) chips.push(h('button', { class: 'text-button', type: 'button', onclick: clearFilters }, 'Clear all'));
  box.replaceChildren(...chips);
}

function renderSession(session, prompts) {
  const first = session.first ? new Date(session.first) : null;
  const last = session.last ? new Date(session.last) : null;
  const sameDay = first && last && dayKey(first) === dayKey(last);
  const span = first ? `${fmtTime.format(first)}${last && +last !== +first ? ` to ${sameDay ? fmtTime.format(last) : fmtDate.format(last)}` : ''}` : '';
  const agent = [agentName(session.agent), session.agentVersion].filter(Boolean).join(' ');

  return h(
    'section',
    { class: 'session', 'aria-label': `Session of ${first ? fmtDate.format(first) : session.file}` },
    h(
      'header',
      { class: 'session-head' },
      h('h3', { class: 'session-title' }, first ? fmtDate.format(first) : session.file),
      h(
        'div',
        { class: 'session-meta' },
        span && h('span', { class: 'meta' }, span),
        session.author && authorChip(session.author),
        h('span', { class: 'chip', title: `Session ${session.session}` }, agentLogo(session.agent), agent),
        session.models.map((model) => h('span', { class: 'chip' }, modelLogo(model), model)),
        h('span', { class: 'meta' }, plural(session.count, 'prompt')),
        gitBadge(session.git),
      ),
      h(
        'div',
        { class: 'session-actions' },
        h(
          'button',
          { class: 'action', type: 'button', title: session.session, onclick: () => copy(session.session, 'Session ID copied') },
          icon('copy'),
          'Copy session ID',
        ),
        h(
          'button',
          { class: 'action action-danger', type: 'button', onclick: () => removeSession(session) },
          icon('trash'),
          'Delete session',
        ),
      ),
    ),
    h('div', { class: 'session-card' }, prompts.map(renderPrompt)),
  );
}

/** Who wrote a session: a link to their profile when their account is known. */
function authorChip(key) {
  const contributor = contributorOf(key);
  const label = accountLabel(contributor);
  const title = [label, contributor?.you && 'You'].filter(Boolean).join(' · ') || undefined;
  const content = [avatar(key), h('span', { class: 'chip-text' }, authorName(key))];
  if (!contributor?.url) return h('span', { class: 'chip chip-author', title }, content);
  return h('a', { class: 'chip chip-author', href: contributor.url, target: '_blank', rel: 'noopener noreferrer', title }, content);
}

function renderText(text) {
  const words = terms();
  const pattern = words.length ? new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi') : null;
  const nodes = [];
  for (const part of text.split(REDACTED_SPLIT)) {
    if (!part) continue;
    if (REDACTED_TOKEN.test(part)) {
      nodes.push(h('span', { class: 'redacted', title: 'Redacted secret' }, part));
      continue;
    }
    if (!pattern) {
      nodes.push(part);
      continue;
    }
    part.split(pattern).forEach((piece, i) => {
      if (piece) nodes.push(i % 2 === 1 ? h('mark', {}, piece) : piece);
    });
  }
  return nodes;
}

/** Whether a search match only appears in the part of a long prompt that is folded away. */
function matchIsHidden(text) {
  const words = terms();
  if (words.length === 0) return false;
  const visible = text.split('\n').slice(0, CLAMP_LINES - 2).join('\n').slice(0, CLAMP_CHARS - 200).toLowerCase();
  return !words.some((word) => visible.includes(word));
}

// Prompts are numbered by their place in the whole session, not in the filtered list.
function renderPrompt(p) {
  const position = p.position;
  const key = keyOf(p);
  const editing = state.editing === key;
  const long = p.prompt.split('\n').length > CLAMP_LINES || p.prompt.length > CLAMP_CHARS;
  const clamped = long && !state.expanded.has(key) && !matchIsHidden(p.prompt);

  const body = editing
    ? renderEditor(p)
    : [
        h('div', { class: 'prompt-text', 'data-clamped': clamped }, renderText(p.prompt)),
        h(
          'div',
          { class: 'prompt-footer' },
          long &&
            (clamped || state.expanded.has(key)) &&
            h(
              'button',
              {
                class: 'more',
                type: 'button',
                'aria-expanded': String(!clamped),
                onclick: () => {
                  if (clamped) state.expanded.add(key);
                  else state.expanded.delete(key);
                  render();
                },
              },
              clamped ? 'Show more' : 'Show less',
            ),
          p.model && state.data.sessionsByFile.get(p.file)?.models.length > 1 && h('span', { class: 'meta' }, p.model),
        ),
        h(
            'div',
            { class: 'prompt-actions' },
            h('button', { class: 'action', type: 'button', onclick: () => copy(p.prompt, 'Prompt copied') }, icon('copy'), 'Copy'),
            h(
              'button',
              {
                class: 'action',
                type: 'button',
                onclick: () => {
                  state.editing = key;
                  render();
                },
              },
              icon('edit'),
              'Edit',
            ),
            h('button', { class: 'action action-danger', type: 'button', onclick: () => removePrompt(p) }, icon('trash'), 'Delete'),
        ),
      ];

  return h(
    'article',
    { class: 'prompt', 'data-key': key, 'data-flash': (state.fresh.get(key) ?? 0) > Date.now() },
    h(
      'div',
      { class: 'prompt-rail' },
      h('span', { class: 'prompt-number', title: `Prompt ${position} of the session` }, position),
      p.date && h('time', { class: 'prompt-time meta', datetime: p.timestamp, title: fmtFull.format(p.date) }, fmtTime.format(p.date)),
    ),
    h('div', { class: 'prompt-body' }, body),
  );
}

function renderEditor(p) {
  const textarea = h('textarea', { 'aria-label': 'Prompt text', spellcheck: 'false' });
  textarea.value = p.prompt;
  const saveButton = h('button', { class: 'button button-primary', type: 'button', onclick: () => save(p, textarea.value, 'Prompt saved') }, 'Save changes');
  const cancel = () => {
    state.editing = null;
    finishEditing();
  };
  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') cancel();
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) saveButton.click();
  });
  const redactSelection = () => {
    const { selectionStart: start, selectionEnd: end, value } = textarea;
    if (start === end) {
      toast('Select the text to redact first.');
      textarea.focus();
      return;
    }
    const token = '[REDACTED:manual]';
    textarea.value = value.slice(0, start) + token + value.slice(end);
    textarea.focus();
    textarea.setSelectionRange(start + token.length, start + token.length);
  };
  requestAnimationFrame(() => {
    textarea.style.height = `${Math.min(textarea.scrollHeight + 4, window.innerHeight * 0.6)}px`;
    textarea.focus();
  });
  return h(
    'div',
    { class: 'editor' },
    textarea,
    h(
      'div',
      { class: 'editor-bar' },
      h('p', { class: 'editor-hint' }, 'Known secrets are redacted when you save. Ctrl+Enter saves, Esc cancels.'),
      h('button', { class: 'button', type: 'button', onclick: redactSelection }, 'Redact selection'),
      h('button', { class: 'button', type: 'button', onclick: cancel }, 'Cancel'),
      saveButton,
    ),
  );
}

// ---------------------------------------------------------------- Actions

function finishEditing() {
  if (state.pendingRefresh) {
    state.pendingRefresh = false;
    refresh();
  } else render();
}

async function save(p, text, message) {
  if (text.trim() === '') {
    toast('A prompt cannot be empty. Delete it instead.', 'error');
    return;
  }
  try {
    const { redacted } = await api('PATCH', '/api/prompt', { file: p.file, line: p.line, hash: p.hash, prompt: text });
    state.editing = null;
    state.pendingRefresh = false;
    toast(redacted.length && message === 'Prompt saved' ? `Prompt saved. Redacted: ${redacted.join(', ')}.` : message);
    await load();
  } catch (error) {
    toast(error.message, 'error');
    if (error.status === 409) {
      state.editing = null;
      await refresh();
    }
  }
}

async function removePrompt(p) {
  const ok = await confirmDialog({
    title: 'Delete this prompt?',
    body: `It is removed from ${state.data.project.dir}/${p.file}. If that file was already committed, git keeps the prompt in its history.`,
    action: 'Delete prompt',
  });
  if (!ok) return;
  try {
    await api('DELETE', '/api/prompt', { file: p.file, line: p.line, hash: p.hash });
    toast('Prompt deleted');
    await load();
  } catch (error) {
    toast(error.message, 'error');
    if (error.status === 409 || error.status === 404) await refresh();
  }
}

async function removeSession(session) {
  const ok = await confirmDialog({
    title: 'Delete this session?',
    body: `This deletes ${state.data.project.dir}/${session.file} and its ${plural(session.count, 'prompt')}. If that file was already committed, git keeps it in its history.`,
    action: 'Delete session',
  });
  if (!ok) return;
  try {
    await api('DELETE', '/api/session', { file: session.file });
    if (state.session === session.file) state.session = null;
    toast('Session deleted');
    await load();
  } catch (error) {
    toast(error.message, 'error');
    await refresh();
  }
}

async function toggleRecording() {
  try {
    const { recording } = await api('PUT', '/api/recording', { recording: !state.data.recording });
    state.data.recording = recording;
    renderRecording();
    toast(recording ? 'Recording resumed' : 'Recording paused on this machine');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function copy(text, message) {
  try {
    await navigator.clipboard.writeText(text);
    toast(message);
  } catch {
    toast('The browser did not allow copying.', 'error');
  }
}

function confirmDialog({ title, body, action }) {
  const dialog = $('confirm');
  $('confirm-title').textContent = title;
  $('confirm-body').textContent = body;
  $('confirm-ok').textContent = action;
  dialog.returnValue = '';
  dialog.showModal();
  $('confirm-ok').focus();
  return new Promise((resolve) => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true }));
}

function toast(message, kind = 'info') {
  const el = h('div', { class: 'toast', 'data-kind': kind }, message);
  $('toasts').append(el);
  setTimeout(() => {
    el.setAttribute('data-leaving', '');
    setTimeout(() => el.remove(), 200);
  }, kind === 'error' ? 6000 : 2600);
}

// ---------------------------------------------------------------- Theme and tooltip

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const button = $('theme');
  button.replaceChildren(icon(theme === 'dark' ? 'sun' : 'moon'));
  button.setAttribute('aria-label', theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
}

function setupTooltip() {
  const tip = h('div', { class: 'tooltip', role: 'presentation', hidden: true });
  document.body.append(tip);
  const show = (event) => {
    const target = event.target.closest?.('[data-tip]');
    if (!target) return;
    const rect = target.getBoundingClientRect();
    tip.textContent = target.dataset.tip;
    tip.hidden = false;
    const half = tip.offsetWidth / 2 + 8;
    tip.style.left = `${Math.min(Math.max(rect.left + rect.width / 2, half), window.innerWidth - half)}px`;
    tip.style.top = `${rect.top}px`;
  };
  const hide = () => (tip.hidden = true);
  const host = $('overview');
  host.addEventListener('pointerover', show);
  host.addEventListener('focusin', show);
  host.addEventListener('pointerout', hide);
  host.addEventListener('focusout', hide);
  window.addEventListener('scroll', hide, { passive: true });
}

// ---------------------------------------------------------------- Start

function start() {
  readHash();
  const stored = localStorage.getItem('open-prompts-theme');
  applyTheme(stored ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  $('theme').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('open-prompts-theme', next);
    applyTheme(next);
  });

  let timer;
  $('search').addEventListener('input', (event) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.query = event.target.value.trim();
      state.limit = PAGE_SIZE;
      render();
    }, 80);
  });
  $('search').addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && event.target.value) {
      event.target.value = '';
      state.query = '';
      render();
    }
  });
  $('sort').addEventListener('click', (event) => {
    const value = event.target.closest('button')?.dataset.value;
    if (!value || value === state.sort) return;
    state.sort = value;
    render();
  });
  $('sort').addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    state.sort = state.sort === 'newest' ? 'oldest' : 'newest';
    render();
    $('sort').querySelector('[aria-checked="true"]').focus();
  });
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  $('search-hint').textContent = mac ? '⌘K' : 'Ctrl K';
  $('recording').addEventListener('click', toggleRecording);
  $('filters-toggle').addEventListener('click', (event) => {
    const open = event.currentTarget.getAttribute('aria-expanded') !== 'true';
    event.currentTarget.setAttribute('aria-expanded', String(open));
    $('filters').toggleAttribute('data-open', open);
  });
  window.addEventListener('hashchange', () => {
    readHash();
    render();
  });
  document.addEventListener('keydown', (event) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '');
    const shortcut = event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey);
    if (shortcut || (event.key === '/' && !typing && !event.metaKey && !event.ctrlKey)) {
      event.preventDefault();
      $('search').focus();
      $('search').select();
    }
  });
  setupTooltip();
  // The buttons change width when the font loads or the page is resized.
  new ResizeObserver(placeSortIndicator).observe($('sort'));
  document.fonts?.ready.then(placeSortIndicator);

  // New prompts appear while the page is open: the server sends an event when a prompt file changes.
  const events = new EventSource('/api/events');
  events.addEventListener('change', () => refresh({ markFresh: true }));

  load().catch((error) => {
    $('list').replaceChildren(h('div', { class: 'empty' }, h('h2', {}, 'The prompts could not be loaded'), h('p', {}, error.message)));
  });
}

start();
