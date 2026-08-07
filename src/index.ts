import { createOpenAICompatibleEndpointsPlugin } from './plugin.js';

export default {
  id: 'opencode-openai-compatible',
  server: createOpenAICompatibleEndpointsPlugin,
};
