import type { Hooks } from '@opencode-ai/plugin';
import { existsSync, readFileSync } from 'fs';
import { basename, join } from 'path';
import { log, initLogger } from './logger.js';
import type { OpenAICompatibleModel } from './openai-compatible-plugin.js';
import {
  buildConfigModelRegistry,
  buildModelRegistry,
  buildVariantDisplayName,
  createReasoningVariants,
  fetchModels,
  getOpenCodeCacheDirectory,
  readModelCache,
  writeModelCache,
} from './openai-compatible-plugin.js';

const PLUGIN_NAME = 'opencode-openai-compatible';
const CONFIG_FILE_NAME = 'opencode-openai-compatible.json';
const CONFIG_PATH_ENV_VAR = 'OPENCODE_OPENAI_COMPATIBLE_CONFIG';
const DEFAULT_PROVIDER_NPM = '@ai-sdk/openai-compatible';
const DEFAULT_MODEL_ENDPOINT = '/models';
const DEFAULT_CONTEXT_LIMIT = 202752;
const DEFAULT_OUTPUT_LIMIT = 202752;
const DEFAULT_FAMILY = 'unknown';
const DEFAULT_FETCH_TIMEOUT_MS = 30000;

export interface OpenAICompatibleEndpointAuth {
  label?: string;
  placeholder?: string;
  message?: string;
}

export interface OpenAICompatibleEndpointOptions {
  id: string;
  name: string;
  baseURL: string;
  apiKey?: string;
  headers?: Record<string, string>;
  auth?: OpenAICompatibleEndpointAuth;
  cacheFile?: string;
  modelEndpoint?: string;
  npm?: string;
  contextLimit?: number;
  outputLimit?: number;
  family?: string;
}

export interface OpenAICompatiblePluginOptions {
  providers?: OpenAICompatibleEndpointOptions[];
  primary?: string;
  fetchTimeoutMs?: number;
}

function readPluginConfigFile(configPath: string): OpenAICompatiblePluginOptions | null {
  try {
    const rawConfig = readFileSync(configPath, 'utf8');
    return JSON.parse(rawConfig) as OpenAICompatiblePluginOptions;
  } catch (error) {
    log(
      `[${PLUGIN_NAME} Plugin] [ERROR] Failed to read plugin config from ${configPath}: ${
        error instanceof Error ? error.toString() : String(error)
      }`
    );
    return null;
  }
}

function resolvePluginConfig(
  input: any,
  options?: OpenAICompatiblePluginOptions
): OpenAICompatiblePluginOptions | null {
  const envConfigPath = process.env[CONFIG_PATH_ENV_VAR];
  if (envConfigPath) {
    const envConfig = readPluginConfigFile(envConfigPath);
    if (envConfig) {
      log(`[${PLUGIN_NAME} Plugin] Loaded endpoint config from ${envConfigPath}`);
      return envConfig;
    }
  }

  const projectConfigPath = input?.directory ? join(input.directory, CONFIG_FILE_NAME) : null;
  if (projectConfigPath && existsSync(projectConfigPath)) {
    const projectConfig = readPluginConfigFile(projectConfigPath);
    if (projectConfig) {
      log(`[${PLUGIN_NAME} Plugin] Loaded endpoint config from ${projectConfigPath}`);
      return projectConfig;
    }
  }

  if (options?.providers && options.providers.length > 0) {
    log(`[${PLUGIN_NAME} Plugin] No config file found; using plugin options`);
    return options;
  }

  return null;
}

interface ResolvedEndpoint {
  id: string;
  name: string;
  baseURL: string;
  apiKey?: string;
  headers?: Record<string, string>;
  authLabel: string;
  authPlaceholder: string;
  authPromptMessage: string;
  cachePath: string;
  npm: string;
  modelEndpoint: string;
  contextLimit: number;
  outputLimit: number;
  family: string;
  logPrefix: string;
}

// Module-scoped background refresh promises, keyed per primary provider id
const modelRefreshPromises = new Map<string, Promise<void> | null>();

// Module-scoped in-flight model fetch promises, keyed per provider id (single-flight)
const modelFetchPromises = new Map<string, Promise<OpenAICompatibleModel[]> | null>();

function resolveEndpoint(endpoint: OpenAICompatibleEndpointOptions): ResolvedEndpoint {
  const cacheFile = endpoint.cacheFile
    ? basename(endpoint.cacheFile)
    : `${endpoint.id}-models.json`;
  const cachePath = join(getOpenCodeCacheDirectory(), '.cache', cacheFile);

  return {
    id: endpoint.id,
    name: endpoint.name,
    baseURL: endpoint.baseURL,
    apiKey: endpoint.apiKey,
    headers: endpoint.headers,
    authLabel: endpoint.auth?.label ?? 'API Key',
    authPlaceholder: endpoint.auth?.placeholder ?? `${endpoint.id}-api-key`,
    authPromptMessage: endpoint.auth?.message ?? `Enter your ${endpoint.name} API key`,
    cachePath,
    npm: endpoint.npm ?? DEFAULT_PROVIDER_NPM,
    modelEndpoint: endpoint.modelEndpoint ?? DEFAULT_MODEL_ENDPOINT,
    contextLimit: endpoint.contextLimit ?? DEFAULT_CONTEXT_LIMIT,
    outputLimit: endpoint.outputLimit ?? DEFAULT_OUTPUT_LIMIT,
    family: endpoint.family ?? DEFAULT_FAMILY,
    logPrefix: `[${endpoint.name} Plugin]`,
  };
}

export async function createOpenAICompatibleEndpointsPlugin(
  input: any,
  options?: OpenAICompatiblePluginOptions
): Promise<Hooks> {
  await initLogger(input.client);
  log(`[${PLUGIN_NAME} Plugin] Plugin initializing...`);

  const resolvedOptions = resolvePluginConfig(input, options);
  const providedProviders = resolvedOptions?.providers ?? [];
  if (providedProviders.length === 0) {
    log(
      `[${PLUGIN_NAME} Plugin] No providers configured; plugin inactive. Configure endpoints via the opencode-openai-compatible.json config file or plugin options in opencode.json`
    );
    return {};
  }

  const seenIds = new Set<string>();
  const providers: ResolvedEndpoint[] = [];

  for (const endpoint of providedProviders) {
    if (typeof endpoint.id !== 'string' || endpoint.id.trim() === '') {
      log(`[${PLUGIN_NAME} Plugin] [ERROR] Skipping provider with missing id`);
      continue;
    }
    if (endpoint.id === '__proto__' || endpoint.id === 'constructor') {
      log(`[${PLUGIN_NAME} Plugin] [ERROR] Skipping provider with reserved id ${endpoint.id}`);
      continue;
    }
    if (typeof endpoint.name !== 'string' || endpoint.name.trim() === '') {
      log(`[${PLUGIN_NAME} Plugin] [ERROR] Skipping provider ${endpoint.id}: missing name`);
      continue;
    }
    if (typeof endpoint.baseURL !== 'string' || endpoint.baseURL.trim() === '') {
      log(`[${PLUGIN_NAME} Plugin] [ERROR] Skipping provider ${endpoint.id}: missing baseURL`);
      continue;
    }
    if (seenIds.has(endpoint.id)) {
      log(`[${PLUGIN_NAME} Plugin] [ERROR] Skipping duplicate provider id ${endpoint.id}`);
      continue;
    }

    seenIds.add(endpoint.id);
    providers.push(resolveEndpoint(endpoint));
  }

  if (providers.length === 0) {
    log(`[${PLUGIN_NAME} Plugin] No valid providers configured; plugin inactive`);
    return {};
  }

  const primaryId = resolvedOptions?.primary ?? providers[0]?.id;
  const primary = providers.find((endpoint) => endpoint.id === primaryId) ?? providers[0];
  if (primary.id !== primaryId) {
    log(
      `[${PLUGIN_NAME} Plugin] [ERROR] Primary provider ${primaryId} is not configured; falling back to ${primary.id}`
    );
  }

  const fetchTimeoutMs = resolvedOptions?.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;

  return {
    config: async (outputConfig: any) => {
      for (const endpoint of providers) {
        let models: OpenAICompatibleModel[] = [];
        try {
          const cachedModels = readModelCache(endpoint.cachePath, endpoint.logPrefix);
          models =
            cachedModels ??
            (await fetchModels(
              endpoint.baseURL,
              '',
              endpoint.modelEndpoint,
              fetchTimeoutMs,
              endpoint.name
            ));

          if (!cachedModels) {
            writeModelCache(endpoint.cachePath, models, endpoint.logPrefix);
          }
        } catch (error) {
          log(
            `${endpoint.logPrefix} [ERROR] ${endpoint.name} failed: ${
              error instanceof Error ? error.toString() : String(error)
            }`
          );
        }

        outputConfig.provider = outputConfig.provider || {};
        const existing = outputConfig.provider[endpoint.id] ?? {};
        const registry = buildConfigModelRegistry(models, {
          npm: endpoint.npm,
          baseURL: endpoint.baseURL,
          defaultFamily: endpoint.family,
          defaultContextLimit: endpoint.contextLimit,
          defaultOutputLimit: endpoint.outputLimit,
          buildDisplayName: buildVariantDisplayName,
          getVariants: createReasoningVariants,
          logPrefix: endpoint.logPrefix,
        });

        outputConfig.provider[endpoint.id] = {
          ...existing,
          npm: endpoint.npm,
          name: endpoint.name,
          options: {
            ...(existing.options ?? {}),
            baseURL: endpoint.baseURL,
            ...(endpoint.apiKey ? { apiKey: endpoint.apiKey } : {}),
            ...(endpoint.headers && Object.keys(endpoint.headers).length > 0
              ? { headers: endpoint.headers }
              : {}),
          },
          models: {
            ...registry,
            ...(existing.models ?? {}),
          },
        };
        log(
          `${endpoint.logPrefix} Provider ${endpoint.id} registered in config with ${Object.keys(registry).length} discovered models`
        );
      }
    },

    provider: {
      id: primary.id,
      async models(_provider: any, ctx: any) {
        log(`${primary.logPrefix} Provider hook - models() called`);

        const apiKey = ctx.auth?.key ?? '';
        if (!apiKey) {
          log(`${primary.logPrefix} No auth found, skipping model registration`);
        }

        const fetchAndCacheModels = async () => {
          const fetchedModels = await fetchModels(
            primary.baseURL,
            apiKey,
            primary.modelEndpoint,
            fetchTimeoutMs,
            primary.name
          );
          writeModelCache(primary.cachePath, fetchedModels, primary.logPrefix);
          return fetchedModels;
        };

        const fetchAndCacheModelsSingleFlight = () => {
          const pendingFetch = modelFetchPromises.get(primary.id) ?? null;
          if (pendingFetch) {
            return pendingFetch;
          }

          const fetchPromise = fetchAndCacheModels().finally(() => {
            modelFetchPromises.set(primary.id, null);
          });
          modelFetchPromises.set(primary.id, fetchPromise);
          return fetchPromise;
        };

        const refreshModelsInBackground = () => {
          const pendingRefresh = modelRefreshPromises.get(primary.id) ?? null;
          if (pendingRefresh) {
            return;
          }

          const refreshPromise = fetchAndCacheModels()
            .then((fetchedModels) => {
              log(
                `${primary.logPrefix} Refreshed cached model list (${fetchedModels.length} models)`
              );
            })
            .catch((error) => {
              log(
                `${primary.logPrefix} Background model refresh failed: ${
                  error instanceof Error ? error.toString() : String(error)
                }`
              );
            })
            .finally(() => {
              modelRefreshPromises.set(primary.id, null);
            });

          modelRefreshPromises.set(primary.id, refreshPromise);
        };

        const cachedModels = readModelCache(primary.cachePath, primary.logPrefix);
        const models = cachedModels
          ? (() => {
              log(`${primary.logPrefix} Using cached model list (${cachedModels.length} models)`);
              refreshModelsInBackground();
              return cachedModels;
            })()
          : await fetchAndCacheModelsSingleFlight();

        log(`${primary.logPrefix} Retrieved ${models.length} available ${primary.name} models`);
        const modelRegistry = buildModelRegistry(models, {
          providerID: primary.id,
          baseURL: primary.baseURL,
          npm: primary.npm,
          defaultFamily: primary.family,
          defaultContextLimit: primary.contextLimit,
          defaultOutputLimit: primary.outputLimit,
          buildDisplayName: buildVariantDisplayName,
          getVariants: createReasoningVariants,
          logPrefix: primary.logPrefix,
        });
        log(
          `${primary.logPrefix} Model registry created with ${Object.keys(modelRegistry).length} models`
        );
        return modelRegistry;
      },
    },

    auth: {
      provider: primary.id,
      methods: [
        {
          type: 'api',
          label: primary.authLabel,
          prompts: [
            {
              type: 'text',
              key: 'key',
              message: primary.authPromptMessage,
              placeholder: primary.authPlaceholder,
            },
          ],
        },
      ],
      async loader(getAuth, _provider) {
        log(`${primary.logPrefix} Auth loader called`);
        const auth = await getAuth();
        log(`${primary.logPrefix} Auth type:`, auth.type);
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
}
