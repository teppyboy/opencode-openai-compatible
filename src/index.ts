import { createOpenAICompatibleEndpointsPlugin } from './plugin.js';

export default {
  id: '@tretrauit/opencode-openai-compatible',
  server: createOpenAICompatibleEndpointsPlugin,
};
