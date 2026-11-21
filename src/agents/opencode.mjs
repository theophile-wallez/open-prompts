// OpenCode adapter: an OpenCode plugin (https://opencode.ai/docs/plugins).
// OpenCode awaits plugin hooks before it sends the prompt, so the hook only copies what
// it needs and writes the record on a later tick. Errors are swallowed: a plugin that
// throws in "chat.message" would break the prompt.

import { ignored, resolveProject, writePrompt } from '../core.mjs';
import { logError, stateDir } from '../state.mjs';

export const AGENT = 'opencode';

/** The text a person typed: text parts that OpenCode did not generate. */
export function typedText(parts) {
  return (Array.isArray(parts) ? parts : [])
    .filter((part) => part?.type === 'text' && typeof part.text === 'string' && !part.synthetic && !part.ignored)
    .map((part) => part.text)
    .join('\n')
    .trim();
}

/**
 * Builds the plugin hooks. `client` is OpenCode's SDK client, used to find out whether a
 * session is a subagent's (it has a parent) and which OpenCode version created it.
 */
export function createHooks({ client, directory, env = process.env, now = () => new Date() }) {
  const sessions = new Map(); // id -> { child, version, directory }
  const commands = new Map(); // session id -> "/name args", set just before chat.message

  const remember = (info) => {
    if (info?.id) sessions.set(info.id, { child: Boolean(info.parentID), version: info.version ?? null, directory: info.directory });
  };

  async function sessionInfo(id) {
    if (!sessions.has(id)) {
      const response = await client?.session?.get?.({ path: { id } });
      remember(response?.data ?? { id, parentID: undefined });
    }
    return sessions.get(id);
  }

  async function record({ sessionID, message, prompt }) {
    const session = await sessionInfo(sessionID);
    if (session.child) return ignored('prompt inside a subagent');
    const { project, reason } = resolveProject(session.directory || directory, env);
    if (!project) return ignored(reason);
    const { providerID, modelID } = message?.model ?? {};
    const created = message?.time?.created;
    return writePrompt(project, {
      agent: AGENT,
      agentVersion: session.version,
      model: providerID && modelID ? `${providerID}/${modelID}` : modelID ?? null,
      session: sessionID,
      id: message?.id,
      timestamp: (typeof created === 'number' ? new Date(created) : now()).toISOString(),
      prompt,
    }, { env });
  }

  const fail = (error) => logError(stateDir(env), error);

  return {
    event: async ({ event } = {}) => {
      try {
        if (event?.type === 'session.created' || event?.type === 'session.updated') remember(event.properties?.info);
      } catch (error) {
        fail(error);
      }
    },
    'command.execute.before': async (input) => {
      try {
        commands.set(input.sessionID, `/${input.command} ${input.arguments ?? ''}`.trim());
      } catch (error) {
        fail(error);
      }
    },
    'chat.message': async (input, output) => {
      try {
        const sessionID = input?.sessionID ?? output?.message?.sessionID;
        const command = commands.get(sessionID);
        commands.delete(sessionID);
        const prompt = command ?? typedText(output?.parts);
        if (!sessionID || !prompt) return;
        const message = structuredClone({ id: output.message?.id, model: output.message?.model, time: output.message?.time });
        setTimeout(() => record({ sessionID, message, prompt }).catch(fail), 0);
      } catch (error) {
        fail(error);
      }
    },
  };
}
