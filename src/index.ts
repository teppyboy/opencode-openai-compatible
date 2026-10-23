import {
  createOpenAICompatibleEndpointsPlugin,
  createOpenAICompatibleEndpointsPluginV2,
} from './plugin.js';
import type { OpenAICompatiblePluginOptions } from './plugin.js';

// V2 reads `id` and `setup()`; V1 calls `server()`. Each keeps its own API.
export default {
  ...createOpenAICompatibleEndpointsPluginV2(),
  server: (input: any, options?: OpenAICompatiblePluginOptions) =>
    createOpenAICompatibleEndpointsPlugin(input, options),
};
