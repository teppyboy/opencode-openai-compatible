export {
  buildVariantDisplayName,
  createOpenAICompatiblePlugin,
  createReasoningVariants,
  DEFAULT_CACHE_TTL_MS,
  normalizeCacheTtlMs,
  readModelCacheEntry,
  resolveModelsWithCacheFallback,
} from './openai-compatible-plugin.js';
export type { ModelCacheEntry, OpenAICompatibleModel } from './openai-compatible-plugin.js';
export type {
  OpenAICompatibleEndpointAuth,
  OpenAICompatibleEndpointOptions,
  OpenAICompatiblePluginOptions,
} from './plugin.js';
