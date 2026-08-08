import type { Hooks } from '@opencode-ai/plugin';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { basename, join, resolve } from 'path';
import { log, initLogger } from './logger.js';
import type { OpenAICompatibleModel } from './openai-compatible-plugin.js';
import {
  buildConfigModelRegistry,
  buildModelRegistry,
  buildVariantDisplayName,
  createReasoningVariants,
  fetchModels,
  getOpenCodeCacheDirectory,
  normalizeCacheTtlMs,
  readModelCacheEntry,
  resolveModelsWithCacheFallback,
  writeModelCache,
} from './openai-compatible-plugin.js';

const PLUGIN_NAME = 'opencode-openai-compatible';
const CONFIG_FILE_NAMES = [
  'opencode-openai-compatible.json',
  'opencode-openai-compatible.jsonc',
] as const;
const OPENCODE_CONFIG_DIR_NAME = 'opencode';
const OPENCODE_PROJECT_DIR_NAME = '.opencode';
const CONFIG_PATH_ENV_VAR = 'OPENCODE_OPENAI_COMPATIBLE_CONFIG';
const DEFAULT_PROVIDER_NPM = '@ai-sdk/openai-compatible';
const DEFAULT_MODEL_ENDPOINT = '/models';
const DEFAULT_CONTEXT_LIMIT = 202752;
const DEFAULT_OUTPUT_LIMIT = 202752;
const DEFAULT_FAMILY = 'unknown';
const DEFAULT_FETCH_TIMEOUT_MS = 30000;
const ENV_PLACEHOLDER_PATTERN = /^\{env:([^}]*)\}$/;

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
  /**
   * How long a cached model list may be used to register this endpoint, in milliseconds.
   *
   * Absent or non-numeric falls back to 5 minutes (`DEFAULT_CACHE_TTL_MS`). `0` never registers
   * from cache and always fetches fresh. Negative values are clamped to `0`. An expired cache is
   * still used as an offline fallback when discovery fails.
   */
  cacheTtlMs?: number;
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

/**
 * Expands a `{env:NAME}` placeholder into the value of that environment variable.
 *
 * Values that are not placeholders are returned untouched, so literal keys keep working.
 * A placeholder naming a missing or empty variable logs `[ERROR]` and resolves to
 * `undefined` — an unexpanded `{env:...}` string must never reach the endpoint as a key.
 */
function expandEnvPlaceholder(
  rawValue: string | undefined,
  fieldName: string,
  endpointId: string
): string | undefined {
  if (rawValue === undefined) {
    return undefined;
  }

  const placeholderMatch = rawValue.match(ENV_PLACEHOLDER_PATTERN);
  if (!placeholderMatch) {
    return rawValue;
  }

  const variableName = placeholderMatch[1].trim();
  if (variableName === '') {
    log(
      `[${PLUGIN_NAME} Plugin] [ERROR] Provider ${endpointId} ${fieldName} uses an empty {env:} placeholder`
    );
    return undefined;
  }

  const variableValue = process.env[variableName];
  if (!variableValue) {
    log(
      `[${PLUGIN_NAME} Plugin] [ERROR] Provider ${endpointId} ${fieldName} references environment variable ${variableName}, which is unset or empty`
    );
    return undefined;
  }

  return variableValue;
}

function expandEnvPlaceholdersInHeaders(
  headers: Record<string, string> | undefined,
  endpointId: string
): Record<string, string> | undefined {
  if (!headers) {
    return undefined;
  }

  const expandedHeaders: Record<string, string> = {};
  for (const [headerName, headerValue] of Object.entries(headers)) {
    const expandedValue = expandEnvPlaceholder(headerValue, `header ${headerName}`, endpointId);
    if (expandedValue === undefined) {
      continue;
    }
    expandedHeaders[headerName] = expandedValue;
  }

  return expandedHeaders;
}

function findNextMeaningfulIndex(jsonText: string, startIndex: number): number {
  let index = startIndex;
  while (index < jsonText.length && /\s/.test(jsonText[index])) {
    index += 1;
  }
  return index;
}

function stripJsonComments(rawConfig: string): string {
  let result = '';
  let index = 0;
  let insideString = false;

  while (index < rawConfig.length) {
    const char = rawConfig[index];
    const nextChar = rawConfig[index + 1];

    if (insideString) {
      result += char;
      if (char === '\\') {
        result += nextChar ?? '';
        index += 2;
        continue;
      }
      if (char === '"') {
        insideString = false;
      }
      index += 1;
      continue;
    }

    if (char === '"') {
      insideString = true;
      result += char;
      index += 1;
      continue;
    }

    if (char === '/' && nextChar === '/') {
      while (index < rawConfig.length && rawConfig[index] !== '\n') {
        index += 1;
      }
      continue;
    }

    if (char === '/' && nextChar === '*') {
      index += 2;
      while (
        index < rawConfig.length &&
        !(rawConfig[index] === '*' && rawConfig[index + 1] === '/')
      ) {
        index += 1;
      }
      index += 2;
      continue;
    }

    result += char;
    index += 1;
  }

  return result;
}

function stripTrailingCommas(jsonText: string): string {
  let result = '';
  let index = 0;
  let insideString = false;

  while (index < jsonText.length) {
    const char = jsonText[index];

    if (insideString) {
      result += char;
      if (char === '\\') {
        result += jsonText[index + 1] ?? '';
        index += 2;
        continue;
      }
      if (char === '"') {
        insideString = false;
      }
      index += 1;
      continue;
    }

    if (char === '"') {
      insideString = true;
      result += char;
      index += 1;
      continue;
    }

    if (char === ',') {
      const nextMeaningful = jsonText[findNextMeaningfulIndex(jsonText, index + 1)];
      if (nextMeaningful === '}' || nextMeaningful === ']') {
        index += 1;
        continue;
      }
    }

    result += char;
    index += 1;
  }

  return result;
}

function parseTolerantJson(rawConfig: string): unknown {
  return JSON.parse(stripTrailingCommas(stripJsonComments(rawConfig)));
}

function readPluginConfigFile(configPath: string): OpenAICompatiblePluginOptions | null {
  try {
    const rawConfig = readFileSync(configPath, 'utf8');
    const parsedConfig = parseTolerantJson(rawConfig);

    if (parsedConfig === null || typeof parsedConfig !== 'object' || Array.isArray(parsedConfig)) {
      log(
        `[${PLUGIN_NAME} Plugin] [ERROR] Failed to read plugin config from ${configPath}: expected a JSON object`
      );
      return null;
    }

    return parsedConfig as OpenAICompatiblePluginOptions;
  } catch (error) {
    log(
      `[${PLUGIN_NAME} Plugin] [ERROR] Failed to read plugin config from ${configPath}: ${
        error instanceof Error ? error.toString() : String(error)
      }`
    );
    return null;
  }
}

function buildConfigSearchDirectories(input: any): string[] {
  const directories: (string | undefined)[] = [
    input?.directory,
    input?.directory ? join(input.directory, OPENCODE_PROJECT_DIR_NAME) : undefined,
    input?.worktree,
    input?.worktree ? join(input.worktree, OPENCODE_PROJECT_DIR_NAME) : undefined,
    process.env.OPENCODE_CONFIG_DIR,
    process.env.XDG_CONFIG_HOME
      ? join(process.env.XDG_CONFIG_HOME, OPENCODE_CONFIG_DIR_NAME)
      : undefined,
    join(homedir(), '.config', OPENCODE_CONFIG_DIR_NAME),
    process.env.APPDATA ? join(process.env.APPDATA, OPENCODE_CONFIG_DIR_NAME) : undefined,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, OPENCODE_CONFIG_DIR_NAME) : undefined,
  ];

  return directories.filter(
    (directory): directory is string => typeof directory === 'string' && directory.trim() !== ''
  );
}

function buildConfigCandidatePaths(input: any): string[] {
  const candidatePaths: string[] = [];
  const seenPaths = new Set<string>();

  for (const directory of buildConfigSearchDirectories(input)) {
    for (const fileName of CONFIG_FILE_NAMES) {
      const candidatePath = resolve(join(directory, fileName));
      const dedupeKey = process.platform === 'win32' ? candidatePath.toLowerCase() : candidatePath;

      if (seenPaths.has(dedupeKey)) {
        continue;
      }

      seenPaths.add(dedupeKey);
      candidatePaths.push(candidatePath);
    }
  }

  return candidatePaths;
}

function resolvePluginConfig(
  input: any,
  options?: OpenAICompatiblePluginOptions
): OpenAICompatiblePluginOptions | null {
  const envConfigPath = process.env[CONFIG_PATH_ENV_VAR];
  if (envConfigPath) {
    const envConfig = readPluginConfigFile(resolve(envConfigPath));
    if (envConfig) {
      log(`[${PLUGIN_NAME} Plugin] Loaded endpoint config from ${resolve(envConfigPath)}`);
      return envConfig;
    }
  }

  const candidatePaths = buildConfigCandidatePaths(input);
  for (const candidatePath of candidatePaths) {
    if (!existsSync(candidatePath)) {
      continue;
    }

    const fileConfig = readPluginConfigFile(candidatePath);
    if (fileConfig) {
      log(`[${PLUGIN_NAME} Plugin] Loaded endpoint config from ${candidatePath}`);
      return fileConfig;
    }
  }

  log(
    `[${PLUGIN_NAME} Plugin] No usable config file found. Attempted paths: ${candidatePaths.join(', ')}`
  );

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
  cacheTtlMs: number;
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
    apiKey: expandEnvPlaceholder(endpoint.apiKey, 'apiKey', endpoint.id),
    headers: expandEnvPlaceholdersInHeaders(endpoint.headers, endpoint.id),
    authLabel: endpoint.auth?.label ?? 'API Key',
    authPlaceholder: endpoint.auth?.placeholder ?? `${endpoint.id}-api-key`,
    authPromptMessage: endpoint.auth?.message ?? `Enter your ${endpoint.name} API key`,
    cachePath,
    cacheTtlMs: normalizeCacheTtlMs(endpoint.cacheTtlMs),
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
          const cacheEntry = readModelCacheEntry(
            endpoint.cachePath,
            endpoint.logPrefix,
            endpoint.cacheTtlMs
          );

          models = await resolveModelsWithCacheFallback({
            cacheEntry,
            logPrefix: endpoint.logPrefix,
            fetchModels: async () => {
              const fetchedModels = await fetchModels(
                endpoint.baseURL,
                endpoint.apiKey ?? '',
                endpoint.modelEndpoint,
                fetchTimeoutMs,
                endpoint.name
              );
              writeModelCache(endpoint.cachePath, fetchedModels, endpoint.logPrefix, Date.now());
              return fetchedModels;
            },
          });
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

        const apiKey = ctx.auth?.key || primary.apiKey || '';
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
          writeModelCache(primary.cachePath, fetchedModels, primary.logPrefix, Date.now());
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

        const cacheEntry = readModelCacheEntry(
          primary.cachePath,
          primary.logPrefix,
          primary.cacheTtlMs
        );
        if (cacheEntry && !cacheEntry.expired) {
          refreshModelsInBackground();
        }

        const models = await resolveModelsWithCacheFallback({
          cacheEntry,
          fetchModels: fetchAndCacheModelsSingleFlight,
          logPrefix: primary.logPrefix,
        });

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
