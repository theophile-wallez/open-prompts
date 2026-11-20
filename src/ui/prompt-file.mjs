// Reads one prompt file into what the interface shows. Shared by the local server and the page
// itself when it reads a repository from GitHub, so it uses nothing from Node.

/**
 * The prompts and session summary of the content of prompt file `name`. Lines that are not
 * records are skipped. `hash(line)` identifies a line for edits, and is null when there are none.
 */
export function parsePromptFile(name, content, { hash = () => null } = {}) {
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
      hash: hash(text),
      id: typeof record.id === 'string' ? record.id : null,
      timestamp: typeof record.timestamp === 'string' ? record.timestamp : null,
      agent: typeof record.agent === 'string' ? record.agent : 'unknown',
      agentVersion: typeof record.agent_version === 'string' ? record.agent_version : null,
      model: typeof record.model === 'string' ? record.model : null,
      session: typeof record.session === 'string' ? record.session : name,
      prompt: record.prompt,
    });
  });
  if (prompts.length === 0) return { prompts, session: null };
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
  return { prompts, session };
}
