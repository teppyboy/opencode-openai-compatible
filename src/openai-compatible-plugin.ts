import type { Plugin } from '@opencode-ai/plugin';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { log, initLogger } from './logger.js';

const AbortController = globalThis.AbortController;
const setTimeout = globalThis.setTimeout;
const clearTimeout = globalThis.clearTimeout;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_PROVIDER_NPM = '@ai-sdk/openai-compatible';
const DEFAULT_MODEL_ENDPOINT = '/models';
const DEFAULT_CONTEXT_LIMIT = 202752;
const DEFAULT_OUTPUT_LIMIT = 202752;
const VARIANT_SUFFIX_PATTERN = /-(lightning|precision|flash|turbo|extended|plus|pro|max|ultra)$/i;

/**
 * How long a cached model list stays usable for provider registration.
 *
 * A cache is fresh while `age < cacheTtlMs`, so a cache exactly at the TTL is already a miss.
 * An expired cache is never used for registration, but it stays available as an offline
 * fallback when discovery fails (see `readModelCacheEntry`).
 */
export const DEFAULT_CACHE_TTL_MS = 300000;

export interface OpenAICompatibleModel {
  id: string;
  name?: string;
  family?: string;
  custom_reasoning?: boolean;
  reasoning_effort?: boolean;
  modalities?: {
    input: string[];
    output: string[];
  };
  context_length?: number;
  max_completion_tokens?: number;
  pricing?: {
    prompt: string;
    completion: string;
    cache_prompt?: string;
  };
  open_weights?: boolean;
  supports_tool_calls?: boolean;
  capabilities?: {
    vision?: boolean;
    pdf?: boolean;
    audioInput?: boolean;
    videoInput?: boolean;
    imageOutput?: boolean;
    audioOutput?: boolean;
    tools?: boolean;
    reasoning?: boolean;
    thinkingFormat?: string | null;
    thinkingCanDisable?: boolean;
    thinkingRange?: {
      min: number;
      max: number;
    } | null;
    contextWindow?: number;
    maxOutput?: number;
  };
}

interface OpenAICompatiblePluginConfig {
  providerID: string;
  providerName: string;
  baseURL: string;
  authLabel: string;
  authPlaceholder: string;
  authPromptMessage: string;
  cacheFileName?: string;
  providerNpm?: string;
  modelEndpointPath?: string;
  fetchTimeoutMs?: number;
  defaultFamily?: string;
  defaultContextLimit?: number;
  defaultOutputLimit?: number;
  cacheTtlMs?: number;
  buildDisplayName?: (model: OpenAICompatibleModel) => string;
  getVariants?: (model: OpenAICompatibleModel) => ReasoningVariants | undefined;
}

type ConfigModelModality = 'text' | 'audio' | 'image' | 'video' | 'pdf';
type ReasoningVariant = Record<string, unknown>;
type ReasoningVariants = Record<string, ReasoningVariant>;
type ReasoningOption = { type: 'effort'; values: Array<string | null> };

type ConfigProviderModel = {
  id: string;
  name: string;
  family: string;
  reasoning: boolean;
  temperature: boolean;
  tool_call: boolean;
  cost: {
    input: number;
    output: number;
    cache_read?: number;
  };
  limit: {
    context: number;
    output: number;
  };
  modalities: {
    input: ConfigModelModality[];
    output: ConfigModelModality[];
  };
  provider: {
    npm: string;
    api: string;
  };
  options: Record<string, unknown>;
  headers: Record<string, string>;
  reasoning_options?: ReasoningOption[];
};

interface ModelCachePayload {
  fetchedAt: string;
  models: OpenAICompatibleModel[];
}

export interface ModelCacheEntry {
  models: OpenAICompatibleModel[];
  /** Epoch milliseconds the cached list was obtained. */
  fetchedAt: number;
  /** True when the entry is too old to register from, but still usable as an offline fallback. */
  expired: boolean;
}

interface ModelRegistryBuildOptions {
  providerID: string;
  baseURL: string;
  npm: string;
  defaultFamily: string;
  defaultContextLimit: number;
  defaultOutputLimit: number;
  buildDisplayName: (model: OpenAICompatibleModel) => string;
  getVariants: (model: OpenAICompatibleModel) => ReasoningVariants | undefined;
  logPrefix: string;
}

interface ConfigModelRegistryBuildOptions {
  npm: string;
  baseURL: string;
  defaultFamily: string;
  defaultContextLimit: number;
  defaultOutputLimit: number;
  buildDisplayName: (model: OpenAICompatibleModel) => string;
  getVariants: (model: OpenAICompatibleModel) => ReasoningVariants | undefined;
  logPrefix: string;
}

export function getOpenCodeCacheDirectory(): string {
  const xdgCacheHome = process.env.XDG_CACHE_HOME;
  if (xdgCacheHome) {
    return join(xdgCacheHome, 'opencode');
  }

  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, 'opencode');
  }

  return join(homedir(), '.cache', 'opencode');
}

export function buildVariantDisplayName(model: OpenAICompatibleModel): string {
  const displayName = model.name ?? model.id;
  const variantMatch = model.id.match(VARIANT_SUFFIX_PATTERN);
  const variantLabel = variantMatch ? variantMatch[1].toLowerCase() : '';
  const nameAlreadyHasVariant =
    variantLabel !== '' && new RegExp(`(?:\\s|\\()${variantLabel}\\)?$`, 'i').test(displayName);

  if (!variantMatch || nameAlreadyHasVariant) {
    return displayName;
  }

  return `${displayName} ${variantMatch[1].charAt(0).toUpperCase() + variantMatch[1].slice(1)}`;
}

function modelSupportsReasoning(model: OpenAICompatibleModel): boolean {
  const hasLegacyReasoningFields =
    model.custom_reasoning !== undefined || model.reasoning_effort !== undefined;
  if (hasLegacyReasoningFields) {
    return Boolean(model.custom_reasoning || model.reasoning_effort);
  }

  return model.capabilities?.reasoning ?? false;
}

function getModelModalities(model: OpenAICompatibleModel): {
  input: ConfigModelModality[];
  output: ConfigModelModality[];
} {
  if (model.modalities) {
    return {
      input: model.modalities.input as ConfigModelModality[],
      output: model.modalities.output as ConfigModelModality[],
    };
  }

  const capabilities = model.capabilities;
  if (!capabilities) {
    return { input: ['text'], output: ['text'] };
  }

  const input: ConfigModelModality[] = ['text'];
  const output: ConfigModelModality[] = ['text'];
  if (capabilities.vision) input.push('image');
  if (capabilities.pdf) input.push('pdf');
  if (capabilities.audioInput) input.push('audio');
  if (capabilities.videoInput) input.push('video');
  if (capabilities.imageOutput) output.push('image');
  if (capabilities.audioOutput) output.push('audio');
  return { input, output };
}

/**
 * OpenCode 1.18.15 derives config-hook model variants from `reasoning_options`; its model
 * schema discards a `variants` key here. The `@ai-sdk/openai-compatible` budget mapper returns
 * undefined, so this provider can expose discrete effort levels only. The runtime provider hook
 * still uses `createReasoningVariants` for OpenCode <=1.14.30 compatibility.
 */
function getReasoningOptions(model: OpenAICompatibleModel): ReasoningOption[] | undefined {
  if (!modelSupportsReasoning(model)) {
    return undefined;
  }

  const values: Array<string | null> = ['low', 'medium', 'high'];
  if (model.capabilities?.thinkingCanDisable) values.unshift(null);
  return [{ type: 'effort', values }];
}

export function createReasoningVariants(
  model: OpenAICompatibleModel
): ReasoningVariants | undefined {
  const effortOption = getReasoningOptions(model)?.find((option) => option.type === 'effort');
  if (!effortOption || effortOption.type !== 'effort') {
    return undefined;
  }

  return Object.fromEntries(
    effortOption.values.map((effort) => {
      const variantName = effort ?? 'none';
      return [variantName, { reasoningEffort: variantName }];
    })
  );
}

/**
 * Normalizes a configured cache TTL into a usable millisecond count.
 *
 * An absent or non-numeric value falls back to `DEFAULT_CACHE_TTL_MS`. A negative value is
 * clamped to `0`, which means "never register from cache, always fetch fresh".
 */
export function normalizeCacheTtlMs(cacheTtlMs: number | undefined): number {
  if (cacheTtlMs === undefined || typeof cacheTtlMs !== 'number' || !Number.isFinite(cacheTtlMs)) {
    return DEFAULT_CACHE_TTL_MS;
  }

  return Math.max(0, cacheTtlMs);
}

/**
 * Reads and validates the cache file without applying any freshness policy.
 *
 * Returns `null` for every unusable cache — missing file, unreadable file, malformed payload,
 * unparseable timestamp, or an empty model list — so callers only ever see a trusted payload.
 */
function parseModelCacheFile(
  cacheFile: string,
  logPrefix: string
): { models: OpenAICompatibleModel[]; fetchedAt: number } | null {
  if (!existsSync(cacheFile)) {
    return null;
  }

  try {
    const rawCache = readFileSync(cacheFile, 'utf8');
    const parsedCache = JSON.parse(rawCache) as Partial<ModelCachePayload>;

    if (!parsedCache.fetchedAt || !Array.isArray(parsedCache.models)) {
      return null;
    }

    if (parsedCache.models.length === 0) {
      log(`${logPrefix} Skipping model cache with an empty model list`);
      return null;
    }

    const fetchedAt = Date.parse(parsedCache.fetchedAt);
    if (Number.isNaN(fetchedAt)) {
      return null;
    }

    return { models: parsedCache.models, fetchedAt };
  } catch (error) {
    log(
      `${logPrefix} Failed to read model cache: ${
        error instanceof Error ? error.toString() : String(error)
      }`
    );
    return null;
  }
}

/**
 * Reads the model cache along with its freshness verdict.
 *
 * `expired: true` means the entry is too old to register models from, but callers may still use
 * `models` as an offline fallback when discovery fails. Returns `null` when there is no usable
 * cache at all.
 */
export function readModelCacheEntry(
  cacheFile: string,
  logPrefix: string,
  cacheTtlMs?: number
): ModelCacheEntry | null {
  const parsedCache = parseModelCacheFile(cacheFile, logPrefix);
  if (!parsedCache) {
    log(`${logPrefix} No usable model cache found`);
    return null;
  }

  const ttlMs = normalizeCacheTtlMs(cacheTtlMs);
  const ageMs = Math.max(0, Date.now() - parsedCache.fetchedAt);
  const expired = ageMs >= ttlMs;

  log(
    `${logPrefix} Model cache ${expired ? 'expired' : 'fresh'} (age=${ageMs}ms, ttl=${ttlMs}ms, ${parsedCache.models.length} models)`
  );

  return { models: parsedCache.models, fetchedAt: parsedCache.fetchedAt, expired };
}

/**
 * Returns cached models only while they are fresh enough to register.
 *
 * Use `readModelCacheEntry` when a stale list is still useful as an offline fallback.
 */
export function readModelCache(
  cacheFile: string,
  logPrefix: string,
  cacheTtlMs?: number
): OpenAICompatibleModel[] | null {
  const cacheEntry = readModelCacheEntry(cacheFile, logPrefix, cacheTtlMs);
  if (!cacheEntry || cacheEntry.expired) {
    return null;
  }

  return cacheEntry.models;
}

/**
 * Persists a model list, stamped with the time the data was obtained.
 *
 * Empty lists are refused so a transient "no models" answer can never poison the cache, and a
 * payload older than what is already on disk is skipped so a slow background refresh cannot
 * overwrite a newer list.
 */
export function writeModelCache(
  cacheFile: string,
  models: OpenAICompatibleModel[],
  logPrefix: string,
  fetchedAtMs: number = Date.now()
): void {
  if (models.length === 0) {
    log(`${logPrefix} Refusing to write an empty model cache`);
    return;
  }

  const existingCache = parseModelCacheFile(cacheFile, logPrefix);
  if (existingCache && existingCache.fetchedAt > fetchedAtMs) {
    log(
      `${logPrefix} Skipping model cache write: on-disk list is newer (disk=${new Date(
        existingCache.fetchedAt
      ).toISOString()}, incoming=${new Date(fetchedAtMs).toISOString()})`
    );
    return;
  }

  try {
    mkdirSync(dirname(cacheFile), { recursive: true });
    writeFileSync(
      cacheFile,
      JSON.stringify({ fetchedAt: new Date(fetchedAtMs).toISOString(), models }, null, 2),
      'utf8'
    );
  } catch (error) {
    log(
      `${logPrefix} Failed to write model cache: ${
        error instanceof Error ? error.toString() : String(error)
      }`
    );
  }
}

interface ModelResolutionOptions {
  cacheEntry: ModelCacheEntry | null;
  fetchModels: () => Promise<OpenAICompatibleModel[]>;
  logPrefix: string;
}

/**
 * Resolves the model list used to register a provider.
 *
 * A fresh cache wins outright. Otherwise discovery runs so models added on the endpoint appear
 * in this session rather than the next one. If discovery fails, an expired cache is used as an
 * offline fallback so an unreachable endpoint keeps its previously known models; with no cache
 * at all the discovery error propagates.
 */
export async function resolveModelsWithCacheFallback(
  opts: ModelResolutionOptions
): Promise<OpenAICompatibleModel[]> {
  if (opts.cacheEntry && !opts.cacheEntry.expired) {
    log(`${opts.logPrefix} Using cached model list (${opts.cacheEntry.models.length} models)`);
    return opts.cacheEntry.models;
  }

  try {
    return await opts.fetchModels();
  } catch (error) {
    if (!opts.cacheEntry) {
      throw error;
    }

    log(
      `${opts.logPrefix} Discovery failed, falling back to stale cached models (${
        opts.cacheEntry.models.length
      } models): ${error instanceof Error ? error.toString() : String(error)}`
    );
    return opts.cacheEntry.models;
  }
}

export async function fetchModels(
  baseURL: string,
  apiKey: string,
  modelEndpointPath: string,
  fetchTimeoutMs: number,
  providerName: string
): Promise<OpenAICompatibleModel[]> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), fetchTimeoutMs);

  try {
    const response = await globalThis.fetch(`${baseURL}${modelEndpointPath}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(
        `Failed to fetch ${providerName} models: ${response.status} ${response.statusText}`
      );
    }

    const data = (await response.json()) as { data: OpenAICompatibleModel[] };
    if (!data?.data || !Array.isArray(data.data)) {
      throw new Error("Invalid response format: missing 'data' array");
    }

    return data.data;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`${providerName} API request timed out`);
    }

    throw new Error(
      `Error fetching ${providerName} models: ${
        error instanceof Error ? error.toString() : String(error)
      }`
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

export function buildModelRegistry(
  models: OpenAICompatibleModel[],
  opts: ModelRegistryBuildOptions
): Record<string, any> {
  const modelRegistry: Record<string, any> = {};

  for (const model of models) {
    if (model.id === '__proto__' || model.id === 'constructor') {
      log(`${opts.logPrefix} [ERROR] Skipping model with reserved id ${model.id}`);
      continue;
    }

    log(`${opts.logPrefix} Processing model: ${model.id}`);

    const { input: inputMods, output: outputMods } = getModelModalities(model);
    const supportsReasoning = modelSupportsReasoning(model);
    const variants = opts.getVariants(model);

    log(
      `${opts.logPrefix} Model ${model.id}: supportsReasoning=${supportsReasoning}, variants=${JSON.stringify(variants)}`
    );

    modelRegistry[model.id] = {
      id: model.id,
      providerID: opts.providerID,
      api: {
        id: model.id,
        url: opts.baseURL,
        npm: opts.npm,
      },
      name: opts.buildDisplayName(model),
      family: model.family ?? opts.defaultFamily,
      capabilities: {
        temperature: true,
        reasoning: supportsReasoning,
        attachment: inputMods.includes('image') || inputMods.includes('pdf'),
        toolcall: model.supports_tool_calls ?? model.capabilities?.tools ?? true,
        input: {
          text: inputMods.includes('text'),
          audio: inputMods.includes('audio'),
          image: inputMods.includes('image'),
          video: inputMods.includes('video'),
          pdf: inputMods.includes('pdf'),
        },
        output: {
          text: outputMods.includes('text'),
          audio: outputMods.includes('audio'),
          image: outputMods.includes('image'),
          video: outputMods.includes('video'),
          pdf: outputMods.includes('pdf'),
        },
        interleaved: false,
      },
      cost: {
        input: model.pricing ? parseFloat(model.pricing.prompt) : 0,
        output: model.pricing ? parseFloat(model.pricing.completion) : 0,
        cache: {
          read: model.pricing?.cache_prompt ? parseFloat(model.pricing.cache_prompt) : 0,
          write: 0,
        },
      },
      limit: {
        context:
          model.context_length ?? model.capabilities?.contextWindow ?? opts.defaultContextLimit,
        output:
          model.max_completion_tokens ?? model.capabilities?.maxOutput ?? opts.defaultOutputLimit,
      },
      status: 'active' as const,
      options: {},
      headers: {},
      release_date: new Date().toISOString(),
      ...(variants ? { variants } : {}),
    };
  }

  return modelRegistry;
}

export function buildConfigModelRegistry(
  models: OpenAICompatibleModel[],
  opts: ConfigModelRegistryBuildOptions
): Record<string, ConfigProviderModel> {
  const modelRegistry: Record<string, ConfigProviderModel> = {};

  for (const model of models) {
    if (model.id === '__proto__' || model.id === 'constructor') {
      log(`${opts.logPrefix} [ERROR] Skipping model with reserved id ${model.id}`);
      continue;
    }

    const { input: inputMods, output: outputMods } = getModelModalities(model);
    const supportsReasoning = modelSupportsReasoning(model);
    const reasoningOptions = getReasoningOptions(model);

    modelRegistry[model.id] = {
      id: model.id,
      name: opts.buildDisplayName(model),
      family: model.family ?? opts.defaultFamily,
      reasoning: supportsReasoning,
      temperature: true,
      tool_call: model.supports_tool_calls ?? model.capabilities?.tools ?? true,
      cost: {
        input: model.pricing ? parseFloat(model.pricing.prompt) : 0,
        output: model.pricing ? parseFloat(model.pricing.completion) : 0,
        ...(model.pricing?.cache_prompt
          ? { cache_read: parseFloat(model.pricing.cache_prompt) }
          : {}),
      },
      limit: {
        context:
          model.context_length ?? model.capabilities?.contextWindow ?? opts.defaultContextLimit,
        output:
          model.max_completion_tokens ?? model.capabilities?.maxOutput ?? opts.defaultOutputLimit,
      },
      modalities: {
        input: inputMods,
        output: outputMods,
      },
      provider: {
        npm: opts.npm,
        api: opts.baseURL,
      },
      options: {},
      headers: {},
      ...(reasoningOptions ? { reasoning_options: reasoningOptions } : {}),
    };
  }

  return modelRegistry;
}

export function createOpenAICompatiblePlugin(config: OpenAICompatiblePluginConfig): Plugin {
  const providerNpm = config.providerNpm ?? DEFAULT_PROVIDER_NPM;
  const cacheFileName = config.cacheFileName ?? `${config.providerID}-models.json`;
  const fetchTimeoutMs = config.fetchTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const modelEndpointPath = config.modelEndpointPath ?? DEFAULT_MODEL_ENDPOINT;
  const defaultFamily = config.defaultFamily ?? 'unknown';
  const defaultContextLimit = config.defaultContextLimit ?? DEFAULT_CONTEXT_LIMIT;
  const defaultOutputLimit = config.defaultOutputLimit ?? DEFAULT_OUTPUT_LIMIT;
  const cacheTtlMs = normalizeCacheTtlMs(config.cacheTtlMs);
  const buildDisplayName = config.buildDisplayName ?? buildVariantDisplayName;
  const getVariants = config.getVariants ?? createReasoningVariants;
  const logPrefix = `[${config.providerName} Plugin]`;

  return async (input: any) => {
    await initLogger(input.client);
    log(`${logPrefix} Plugin initializing...`);

    const cacheFile = join(getOpenCodeCacheDirectory(), '.cache', cacheFileName);
    let modelRefreshPromise: Promise<void> | null = null;

    const fetchAndCacheModels = async (apiKey: string) => {
      const fetchedModels = await fetchModels(
        config.baseURL,
        apiKey,
        modelEndpointPath,
        fetchTimeoutMs,
        config.providerName
      );
      writeModelCache(cacheFile, fetchedModels, logPrefix, Date.now());
      return fetchedModels;
    };

    return {
      config: async (outputConfig: any) => {
        log(`${logPrefix} Config hook called - registering provider`);
        const cacheEntry = readModelCacheEntry(cacheFile, logPrefix, cacheTtlMs);
        const models = await resolveModelsWithCacheFallback({
          cacheEntry,
          fetchModels: () => fetchAndCacheModels(''),
          logPrefix,
        });

        outputConfig.provider = outputConfig.provider || {};
        outputConfig.provider[config.providerID] = {
          npm: providerNpm,
          name: config.providerName,
          options: {
            baseURL: config.baseURL,
          },
          models: buildConfigModelRegistry(models, {
            npm: providerNpm,
            baseURL: config.baseURL,
            defaultFamily,
            defaultContextLimit,
            defaultOutputLimit,
            buildDisplayName,
            getVariants,
            logPrefix,
          }),
        };
        log(`${logPrefix} Provider registered in config with ${models.length} models`);
      },

      provider: {
        id: config.providerID,
        async models(_provider: any, ctx: any) {
          log(`${logPrefix} Provider hook - models() called`);

          const apiKey = ctx.auth?.key ?? '';
          if (!apiKey) {
            log(`${logPrefix} No auth found, skipping model registration`);
          }

          const refreshModelsInBackground = () => {
            if (modelRefreshPromise) {
              return;
            }

            modelRefreshPromise = fetchAndCacheModels(apiKey)
              .then((fetchedModels) => {
                log(`${logPrefix} Refreshed cached model list (${fetchedModels.length} models)`);
              })
              .catch((error) => {
                log(
                  `${logPrefix} Background model refresh failed: ${
                    error instanceof Error ? error.toString() : String(error)
                  }`
                );
              })
              .finally(() => {
                modelRefreshPromise = null;
              });
          };

          const cacheEntry = readModelCacheEntry(cacheFile, logPrefix, cacheTtlMs);
          if (cacheEntry && !cacheEntry.expired) {
            refreshModelsInBackground();
          }

          const models = await resolveModelsWithCacheFallback({
            cacheEntry,
            fetchModels: () => fetchAndCacheModels(apiKey),
            logPrefix,
          });

          log(`${logPrefix} Retrieved ${models.length} available ${config.providerName} models`);
          const modelRegistry = buildModelRegistry(models, {
            providerID: config.providerID,
            baseURL: config.baseURL,
            npm: providerNpm,
            defaultFamily,
            defaultContextLimit,
            defaultOutputLimit,
            buildDisplayName,
            getVariants,
            logPrefix,
          });
          log(
            `${logPrefix} Model registry created with ${Object.keys(modelRegistry).length} models`
          );
          return modelRegistry;
        },
      },

      'chat.params': async (chatInput: any, output: any) => {
        log(`${logPrefix} chat.params called`);
        log(
          `${logPrefix} chat.params input: model=${chatInput.model?.id}, providerID=${chatInput.model?.providerID}`
        );
        log(
          `${logPrefix} chat.params message variant: ${JSON.stringify(chatInput.message?.variant)}`
        );
        log(
          `${logPrefix} chat.params model variants: ${JSON.stringify(chatInput.model?.variants)}`
        );
        log(`${logPrefix} chat.params output.options (before): ${JSON.stringify(output.options)}`);
      },

      auth: {
        provider: config.providerID,
        methods: [
          {
            type: 'api',
            label: config.authLabel,
            prompts: [
              {
                type: 'text',
                key: 'key',
                message: config.authPromptMessage,
                placeholder: config.authPlaceholder,
              },
            ],
          },
        ],
        async loader(getAuth, _provider) {
          log(`${logPrefix} Auth loader called`);
          const auth = await getAuth();
          log(`${logPrefix} Auth type:`, auth.type);
          const apiKey = auth.type === 'api' ? auth.key : '';

          return {
            apiKey,
            async fetch(fetchInput: any, init: any) {
              const headers = new Headers(init?.headers ?? {});
              headers.set('Authorization', `Bearer ${apiKey}`);
              return globalThis.fetch(fetchInput, { ...init, headers });
            },
          };
        },
      },
    };
  };
}
