// Record format, as defined in SPEC.md section 4.

export const SPEC_VERSION = 1;

const AGENT_RE = /^[a-z0-9][a-z0-9-]*$/;
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i;
const KNOWN_FIELDS = new Set(['v', 'id', 'timestamp', 'agent', 'agent_version', 'model', 'session', 'prompt']);
export const FILE_NAME_RE = /^\d{4}-\d{2}-\d{2}-[A-Za-z0-9_-]+\.jsonl$/;

/**
 * Builds a record with fields in the order the spec recommends, then the extension
 * fields of `extensions`. Only names starting with `x_` are kept, and undefined values are left out.
 */
export function makeRecord({ id, timestamp, agent, agentVersion, model, session, prompt, extensions }) {
  const record = { v: SPEC_VERSION };
  if (id) record.id = id;
  record.timestamp = timestamp ?? new Date().toISOString();
  record.agent = agent;
  record.agent_version = agentVersion ?? null;
  record.model = model ?? null;
  record.session = session;
  record.prompt = prompt;
  for (const [key, value] of Object.entries(extensions ?? {})) {
    if (key.startsWith('x_') && value !== undefined) record[key] = value;
  }
  return record;
}

/** Returns a list of problems with a parsed record. An empty list means it is valid. */
export function validateRecord(record) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    return ['the line is not a JSON object'];
  }
  const errors = [];
  const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;
  const isStringOrNull = (value) => value === null || typeof value === 'string';

  if (record.v !== SPEC_VERSION) errors.push(`"v" must be ${SPEC_VERSION}`);
  if ('id' in record && !isNonEmptyString(record.id)) errors.push('"id" must be a non-empty string');
  if (!isNonEmptyString(record.timestamp) || !RFC3339_RE.test(record.timestamp) || Number.isNaN(Date.parse(record.timestamp))) {
    errors.push('"timestamp" must be an RFC 3339 date-time');
  }
  if (typeof record.agent !== 'string' || !AGENT_RE.test(record.agent)) {
    errors.push('"agent" must be a lowercase slug such as "claude-code"');
  }
  for (const key of ['agent_version', 'model']) {
    if (!(key in record)) errors.push(`"${key}" is required (use null when unknown)`);
    else if (!isStringOrNull(record[key])) errors.push(`"${key}" must be a string or null`);
  }
  if (!isNonEmptyString(record.session)) errors.push('"session" must be a non-empty string');
  if (!isNonEmptyString(record.prompt)) errors.push('"prompt" must be a non-empty string');
  for (const key of Object.keys(record)) {
    if (!KNOWN_FIELDS.has(key) && !key.startsWith('x_')) {
      errors.push(`unknown field "${key}" (extension fields must start with "x_")`);
    }
  }
  return errors;
}

/**
 * Checks the content of a whole prompt file against SPEC.md section 3 and 4.
 * Returns a list of { line, message } problems. Line 0 means the whole file.
 */
export function validateFileContent(content, fileName) {
  const problems = [];
  if (fileName && !FILE_NAME_RE.test(fileName)) {
    problems.push({ line: 0, message: `file name must look like YYYY-MM-DD-<key>.jsonl` });
  }
  if (content.length === 0) {
    problems.push({ line: 0, message: 'file is empty' });
    return problems;
  }
  if (content.charCodeAt(0) === 0xfeff) problems.push({ line: 0, message: 'file must not start with a byte order mark' });
  if (content.includes('\r')) problems.push({ line: 0, message: 'file must use LF line endings, without carriage returns' });
  if (!content.endsWith('\n')) problems.push({ line: 0, message: 'the last line must end with a line feed' });

  const lines = content.replace(/^\uFEFF/, '').split('\n');
  if (lines.at(-1) === '') lines.pop();
  let session;
  lines.forEach((text, index) => {
    const line = index + 1;
    if (text.trim() === '') {
      problems.push({ line, message: 'blank lines are not allowed' });
      return;
    }
    let record;
    try {
      record = JSON.parse(text);
    } catch {
      problems.push({ line, message: 'not valid JSON' });
      return;
    }
    for (const message of validateRecord(record)) problems.push({ line, message });
    if (typeof record?.session === 'string') {
      session ??= record.session;
      if (record.session !== session) problems.push({ line, message: 'a file must hold the records of one session only' });
    }
  });
  return problems;
}
