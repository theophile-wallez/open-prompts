// `open-prompts stats`: how many prompts a repository holds, per day, model, session and agent.

export const STATS_GROUPS = ['day', 'model', 'session', 'agent'];

/** The UTC day of a timestamp, as YYYY-MM-DD, or null when it is not a date. */
function dayOf(timestamp) {
  const time = Date.parse(timestamp);
  return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : null;
}

/** Orders values alphabetically, with null (unknown) last. */
const byValue = (a, b) => (a === b ? 0 : a === null ? 1 : b === null ? -1 : String(a).localeCompare(String(b)));

/** Counts `records` by `key`, as [value, count] pairs, most frequent first, then by value. */
function countBy(records, key) {
  const counts = new Map();
  for (const record of records) {
    const value = key(record);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || byValue(a[0], b[0]));
}

/** Every session, in order of its first prompt, with its agent and its number of prompts. */
function sessions(records) {
  const byId = new Map();
  for (const record of records) {
    const id = typeof record.session === 'string' ? record.session : null;
    const time = Date.parse(record.timestamp);
    const session = byId.get(id) ?? { session: id, first: null, agent: null, prompts: 0, at: Infinity };
    session.prompts++;
    if (Number.isFinite(time) && time < session.at) {
      session.at = time;
      session.first = new Date(time).toISOString();
    }
    session.agent ??= typeof record.agent === 'string' ? record.agent : null;
    byId.set(id, session);
  }
  return [...byId.values()].sort((a, b) => a.at - b.at || String(a.session).localeCompare(String(b.session))).map(({ at, ...session }) => session);
}

/**
 * Prompt counts of `records`, the records of a project's prompt files. `by` picks the
 * groups, among STATS_GROUPS. Unknown values (no model, a timestamp that is not a date)
 * are counted under null. Days are UTC days.
 */
export function promptStats(records, { by = STATS_GROUPS } = {}) {
  const days = records.map((record) => dayOf(record.timestamp)).filter(Boolean).sort();
  const groups = {
    // In order of time, with prompts whose timestamp is not a date last.
    day: () =>
      countBy(records, (record) => dayOf(record.timestamp))
        .sort(([a], [b]) => byValue(a, b))
        .map(([day, prompts]) => ({ day, prompts })),
    model: () => countBy(records, (record) => (typeof record.model === 'string' ? record.model : null)).map(([model, prompts]) => ({ model, prompts })),
    session: () => sessions(records),
    agent: () => countBy(records, (record) => (typeof record.agent === 'string' ? record.agent : null)).map(([agent, prompts]) => ({ agent, prompts })),
  };
  return {
    prompts: records.length,
    sessions: new Set(records.map((record) => record.session)).size,
    first: days[0] ?? null,
    last: days.at(-1) ?? null,
    by: Object.fromEntries(STATS_GROUPS.filter((group) => by.includes(group)).map((group) => [group, groups[group]()])),
  };
}

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** Lays out rows of cells in columns. `align` has one letter per column: "l" for left, "r" for right. */
function table(rows, align) {
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
  const cell = (text, column) => (align[column] === 'r' ? text.padStart(widths[column]) : text.padEnd(widths[column]));
  return rows.map((row) => `  ${row.map(cell).join('  ').trimEnd()}`);
}

const share = (count, total) => `${Math.round((count / total) * 100)}%`;

const SECTIONS = {
  day: { title: 'By day', head: ['day', 'prompts'], align: 'lr', row: ({ day, prompts }) => [day ?? 'unknown date', String(prompts)] },
  model: { title: 'By model', head: ['model', 'prompts', 'share'], align: 'lrr', row: ({ model, prompts }, total) => [model ?? 'unknown model', String(prompts), share(prompts, total)] },
  session: {
    title: 'By session',
    head: ['first day', 'session', 'agent', 'prompts'],
    align: 'lllr',
    row: ({ session, first, agent, prompts }) => [first ? first.slice(0, 10) : 'unknown date', session ?? 'no session', agent ?? 'unknown agent', String(prompts)],
  },
  agent: { title: 'By agent', head: ['agent', 'prompts', 'share'], align: 'lrr', row: ({ agent, prompts }, total) => [agent ?? 'unknown agent', String(prompts), share(prompts, total)] },
};

/** The stats as aligned text: one section per group, each with a header row. */
export function formatStats(stats) {
  if (stats.prompts === 0) return 'No prompts recorded yet.';
  const span = stats.first && stats.last ? (stats.first === stats.last ? `, on ${stats.first}` : `, from ${stats.first} to ${stats.last}`) : '';
  const out = [`${plural(stats.prompts, 'prompt')} in ${plural(stats.sessions, 'session')}${span}.`];
  for (const [group, rows] of Object.entries(stats.by)) {
    const section = SECTIONS[group];
    out.push('', section.title, ...table([section.head, ...rows.map((row) => section.row(row, stats.prompts))], section.align));
  }
  return out.join('\n');
}
