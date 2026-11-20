import assert from 'node:assert/strict';
import test from 'node:test';
import { makeRecord, validateFileContent, validateRecord } from '../src/record.mjs';

const valid = () =>
  makeRecord({ id: 'p1', timestamp: '2026-11-20T15:48:02.123Z', agent: 'claude-code', agentVersion: '2.1.328', model: 'claude-opus-5-5', session: 's-1', prompt: 'hello' });

test('makeRecord writes fields in spec order', () => {
  assert.deepEqual(Object.keys(valid()), ['v', 'id', 'timestamp', 'agent', 'agent_version', 'model', 'session', 'prompt']);
  assert.equal(validateRecord(valid()).length, 0);
});

test('unknown agent version and model are null, not missing', () => {
  const record = makeRecord({ timestamp: '2026-11-20T15:48:02Z', agent: 'codex', session: 's', prompt: 'x' });
  assert.equal(record.agent_version, null);
  assert.equal(record.model, null);
  assert.equal('id' in record, false);
  assert.deepEqual(validateRecord(record), []);
});

test('validateRecord reports problems', () => {
  const { agent_version, ...missing } = valid();
  assert.match(validateRecord(missing).join(), /agent_version/);
  assert.match(validateRecord({ ...valid(), agent: 'Claude Code' }).join(), /slug/);
  assert.match(validateRecord({ ...valid(), timestamp: 'yesterday' }).join(), /RFC 3339/);
  assert.match(validateRecord({ ...valid(), prompt: '' }).join(), /prompt/);
  assert.match(validateRecord({ ...valid(), reply: 'no' }).join(), /unknown field "reply"/);
  assert.deepEqual(validateRecord({ ...valid(), x_branch: 'main' }), []);
  assert.deepEqual(validateRecord([1]), ['the line is not a JSON object']);
});

test('validateFileContent checks the file format', () => {
  const line = JSON.stringify(valid());
  assert.deepEqual(validateFileContent(`${line}\n`, '2026-11-20-s-1.jsonl'), []);
  const messages = (content, name) => validateFileContent(content, name).map((p) => p.message).join(' | ');
  assert.match(messages(line, '2026-11-20-s-1.jsonl'), /line feed/);
  assert.match(messages(`${line}\r\n`, '2026-11-20-s-1.jsonl'), /carriage/);
  assert.match(messages(`${line}\n\n${line}\n`, '2026-11-20-s-1.jsonl'), /blank/);
  assert.match(messages(`${line}\n`, 'notes.jsonl'), /file name/);
  assert.match(messages(`${line}\n${JSON.stringify({ ...valid(), session: 'other' })}\n`, '2026-11-20-s-1.jsonl'), /one session/);
  assert.match(messages('{oops\n', '2026-11-20-s-1.jsonl'), /not valid JSON/);
});
