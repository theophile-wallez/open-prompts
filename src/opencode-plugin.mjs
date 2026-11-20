// OpenCode loads this module as a plugin. It must export plugin functions only.
import { createHooks } from './agents/opencode.mjs';

export const OpenPrompts = async ({ client, directory }) => createHooks({ client, directory });
