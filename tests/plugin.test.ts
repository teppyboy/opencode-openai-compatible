import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';

// Mock the logger before importing the plugin
vi.mock('../src/logger.ts', () => ({
  log: vi.fn(),
  initLogger: vi.fn().mockResolvedValue(undefined),
}));

// `bun-types` declares the global `fetch` with a required `preconnect` member, so assigning a
// bare vitest mock to `globalThis.fetch` fails `tsc --noEmit`. Go through a widened alias
// instead of casting at every assignment site.
const testGlobal = globalThis as { fetch: typeof globalThis.fetch | Mock };

const originalFetch = testGlobal.fetch;

const crofaiEndpoint = {
  id: 'crofai',
  name: 'CrofAI',
  baseURL: 'https://crof.ai/v1',
  apiKey: '{env:CROFAI_API_KEY}',
};

const groqEndpoint = {
  id: 'groq',
  name: 'Groq',
  baseURL: 'https://api.groq.com/openai/v1',
};

const mockModels = [
  {
    id: 'kimi-k2.5',
    name: 'MoonshotAI: Kimi K2.5',
    family: 'Moonshot AI',
    custom_reasoning: false,
    reasoning_effort: true,
    context_length: 262144,
    max_completion_tokens: 262144,
    pricing: {
      prompt: '0.35',
      completion: '1.80',
    },
  },
  {
    id: 'kimi-k2.5-lightning',
    name: 'MoonshotAI: Kimi K2.5',
    family: 'Moonshot AI',
    custom_reasoning: true,
    reasoning_effort: true,
    context_length: 131072,
    max_completion_tokens: 32768,
    pricing: {
      prompt: '2.5',
      completion: '4',
    },
  },
  {
    id: 'glm-5',
    name: 'Z.ai: GLM 5',
    family: 'Zhipu AI',
    custom_reasoning: false,
    reasoning_effort: false,
    context_length: 202752,
    max_completion_tokens: 202752,
    pricing: {
      prompt: '0.48',
      completion: '1.90',
    },
  },
  {
    id: 'glm-5.1',
    name: 'Z.ai: GLM-5.1',
    family: 'Zhipu AI',
    custom_reasoning: true,
    reasoning_effort: true,
    context_length: 202752,
    max_completion_tokens: 202752,
    pricing: {
      prompt: '0.48',
      completion: '1.90',
    },
  },
  {
    id: 'glm-5.1-precision',
    name: 'Z.ai: GLM-5.1',
    family: 'Zhipu AI',
    custom_reasoning: true,
    reasoning_effort: true,
    context_length: 202752,
    max_completion_tokens: 202752,
    pricing: {
      prompt: '0.96',
      completion: '3.80',
    },
  },
];

describe('opencode-openai-compatible plugin', () => {
  let mockGetAuth: ReturnType<typeof vi.fn>;
  let mockClient: any;

  const createPluginContext = () => {
    const testDir = mkdtempSync(join(tmpdir(), 'opencode-openai-compatible-test-'));
    const cacheHome = join(testDir, 'cache-home');
    const homeDir = join(testDir, 'home');
    const globalConfigDir = join(homeDir, '.config', 'opencode');

    // Sandbox every directory the config resolver probes so a real user config on the
    // machine running the suite can never leak into a test.
    const envOverrides: Record<string, string | undefined> = {
      XDG_CACHE_HOME: cacheHome,
      HOME: homeDir,
      USERPROFILE: homeDir,
      XDG_CONFIG_HOME: join(homeDir, '.config'),
      APPDATA: join(homeDir, 'AppData', 'Roaming'),
      LOCALAPPDATA: join(homeDir, 'AppData', 'Local'),
      OPENCODE_CONFIG_DIR: undefined,
      OPENCODE_OPENAI_COMPATIBLE_CONFIG: undefined,
    };

    const previousEnv: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(envOverrides)) {
      previousEnv[key] = process.env[key];
      if (value === undefined) {
        delete process.env[key];
        continue;
      }
      process.env[key] = value;
    }

    mkdirSync(globalConfigDir, { recursive: true });

    return {
      input: {
        project: { name: 'test-project' },
        client: mockClient,
        $: {} as any,
        directory: testDir,
        worktree: testDir,
      },
      testDir,
      cacheHome,
      homeDir,
      globalConfigDir,
      cachePathFor: (id: string) => join(cacheHome, 'opencode', '.cache', `${id}-models.json`),
      cleanup: () => {
        for (const [key, value] of Object.entries(previousEnv)) {
          if (value === undefined) {
            delete process.env[key];
            continue;
          }
          process.env[key] = value;
        }

        rmSync(testDir, { recursive: true, force: true });
      },
    };
  };

  const createPlugin = async (input: any, options: any) => {
    const mod = await import('../src/index.ts');
    return (mod.default as any).server(input, options);
  };

  beforeEach(() => {
    mockGetAuth = vi.fn().mockResolvedValue({
      type: 'api' as const,
      key: 'test-api-key',
    });

    mockClient = {
      app: {
        log: vi.fn(),
      },
    };

    vi.clearAllMocks();
  });

  afterEach(() => {
    testGlobal.fetch = originalFetch;
  });

  it('registers multiple endpoints into config', async () => {
    testGlobal.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: mockModels }),
    });

    const { input, cleanup, cachePathFor } = createPluginContext();

    try {
      const plugin = await createPlugin(input, { providers: [crofaiEndpoint, groqEndpoint] });

      const cfg: any = {};
      await plugin.config(cfg);

      // Both endpoints registered
      expect(cfg.provider.crofai).toBeDefined();
      expect(cfg.provider.groq).toBeDefined();

      // CrofAI endpoint
      expect(cfg.provider.crofai.npm).toBe('@ai-sdk/openai-compatible');
      expect(cfg.provider.crofai.name).toBe('CrofAI');
      expect(cfg.provider.crofai.options.baseURL).toBe('https://crof.ai/v1');
      // {env:CROFAI_API_KEY} is unset here, so the placeholder is dropped rather than
      // leaked to the provider as a literal key.
      expect(cfg.provider.crofai.options.apiKey).toBeUndefined();
      expect(cfg.provider.crofai.models['kimi-k2.5']).toMatchObject({
        id: 'kimi-k2.5',
        name: 'MoonshotAI: Kimi K2.5',
        reasoning: true,
        provider: {
          npm: '@ai-sdk/openai-compatible',
          api: 'https://crof.ai/v1',
        },
      });

      // Groq endpoint
      expect(cfg.provider.groq.npm).toBe('@ai-sdk/openai-compatible');
      expect(cfg.provider.groq.name).toBe('Groq');
      expect(cfg.provider.groq.options.baseURL).toBe('https://api.groq.com/openai/v1');
      expect(cfg.provider.groq.options.apiKey).toBeUndefined();
      expect(cfg.provider.groq.models['kimi-k2.5']).toBeDefined();
      expect(cfg.provider.groq.models['kimi-k2.5'].provider.api).toBe(
        'https://api.groq.com/openai/v1'
      );

      // Distinct cache files written per endpoint
      expect(existsSync(cachePathFor('crofai'))).toBe(true);
      expect(existsSync(cachePathFor('groq'))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('does nothing when no providers are configured', async () => {
    testGlobal.fetch = vi.fn();

    const { input, cleanup } = createPluginContext();

    try {
      const plugin = await createPlugin(input, {});
      expect(plugin).toEqual({});

      const cfg: any = {};
      await plugin.config?.(cfg);
      expect(cfg.provider).toBeUndefined();
      expect(testGlobal.fetch).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('skips endpoints missing baseURL', async () => {
    testGlobal.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: mockModels }),
    });

    const { input, cleanup } = createPluginContext();

    try {
      const plugin = await createPlugin(input, {
        providers: [{ id: 'broken', name: 'Broken' }, groqEndpoint],
      });

      const cfg: any = {};
      await plugin.config(cfg);

      expect(cfg.provider.broken).toBeUndefined();
      expect(cfg.provider.groq).toBeDefined();
      expect(testGlobal.fetch).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  it('keeps the first provider when ids are duplicated', async () => {
    testGlobal.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: mockModels }),
    });

    const { input, cleanup } = createPluginContext();

    try {
      const plugin = await createPlugin(input, {
        providers: [
          { id: 'dup', name: 'First', baseURL: 'https://first.example/v1' },
          { id: 'dup', name: 'Second', baseURL: 'https://second.example/v1' },
        ],
      });

      const cfg: any = {};
      await plugin.config(cfg);

      expect(cfg.provider.dup).toBeDefined();
      expect(cfg.provider.dup.name).toBe('First');
      expect(cfg.provider.dup.options.baseURL).toBe('https://first.example/v1');
      expect(testGlobal.fetch).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  it('uses cached models in the config hook without fetching', async () => {
    const { input, cleanup, cachePathFor } = createPluginContext();

    mkdirSync(dirname(cachePathFor('crofai')), { recursive: true });
    writeFileSync(
      cachePathFor('crofai'),
      JSON.stringify(
        {
          fetchedAt: new Date().toISOString(),
          models: [
            {
              id: 'cached-model',
              name: 'Cached Model',
              context_length: 1024,
              max_completion_tokens: 512,
            },
          ],
        },
        null,
        2
      ),
      'utf8'
    );

    testGlobal.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: mockModels }),
    });

    try {
      const plugin = await createPlugin(input, { providers: [crofaiEndpoint] });

      const cfg: any = {};
      await plugin.config(cfg);

      expect(cfg.provider.crofai.models['cached-model'].name).toBe('Cached Model');
      expect(cfg.provider.crofai.models['kimi-k2.5']).toBeUndefined();
      expect(testGlobal.fetch).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('preserves user-provided provider config while merging discovered models', async () => {
    testGlobal.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: mockModels }),
    });

    const { input, cleanup } = createPluginContext();

    try {
      const plugin = await createPlugin(input, { providers: [crofaiEndpoint] });

      const cfg: any = {
        provider: {
          crofai: {
            name: 'Custom Name',
            env: 'custom-env',
            models: {
              'explicit-model': { id: 'explicit-model' },
              'kimi-k2.5': { name: 'User Override' },
            },
          },
        },
      };
      await plugin.config(cfg);

      // Overridden by endpoint metadata
      expect(cfg.provider.crofai.name).toBe('CrofAI');
      expect(cfg.provider.crofai.npm).toBe('@ai-sdk/openai-compatible');
      expect(cfg.provider.crofai.options.baseURL).toBe('https://crof.ai/v1');

      // Preserved user fields
      expect(cfg.provider.crofai.env).toBe('custom-env');
      expect(cfg.provider.crofai.models['explicit-model']).toBeDefined();

      // User models win over discovered same-id models
      expect(cfg.provider.crofai.models['kimi-k2.5'].name).toBe('User Override');

      // Non-colliding discovered models still merged in
      expect(cfg.provider.crofai.models['glm-5']).toBeDefined();
      expect(cfg.provider.crofai.models['glm-5'].name).toBe('Z.ai: GLM 5');
    } finally {
      cleanup();
    }
  });

  it('provides API key auth for the primary provider', async () => {
    const { input, cleanup } = createPluginContext();

    try {
      const plugin = await createPlugin(input, { providers: [crofaiEndpoint, groqEndpoint] });

      expect(plugin.auth).toBeDefined();
      expect(plugin.auth.provider).toBe('crofai');
      expect(plugin.auth.methods).toHaveLength(1);
      expect(plugin.auth.methods[0].type).toBe('api');
      expect(plugin.auth.methods[0].label).toBe('API Key');
      expect(plugin.auth.methods[0].prompts[0].message).toBe('Enter your CrofAI API key');
      expect(plugin.auth.methods[0].prompts[0].placeholder).toBe('crofai-api-key');
    } finally {
      cleanup();
    }
  });

  it('respects custom auth options per endpoint', async () => {
    const { input, cleanup } = createPluginContext();

    try {
      const plugin = await createPlugin(input, {
        providers: [
          {
            id: 'custom',
            name: 'CustomAI',
            baseURL: 'https://custom.example/v1',
            auth: {
              label: 'Custom Label',
              placeholder: 'custom-...',
              message: 'Enter your CustomAI key',
            },
          },
        ],
      });

      expect(plugin.auth.provider).toBe('custom');
      expect(plugin.auth.methods[0].label).toBe('Custom Label');
      expect(plugin.auth.methods[0].prompts[0].message).toBe('Enter your CustomAI key');
      expect(plugin.auth.methods[0].prompts[0].placeholder).toBe('custom-...');
    } finally {
      cleanup();
    }
  });

  it('injects Authorization header in auth loader', async () => {
    testGlobal.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    const { input, cleanup } = createPluginContext();

    try {
      const plugin = await createPlugin(input, { providers: [crofaiEndpoint] });

      const result = await plugin.auth.loader(mockGetAuth, {} as any);

      expect(result.apiKey).toBe('test-api-key');

      // Make a request through the fetch wrapper
      await result.fetch('https://example.com', {});
      const calledHeaders = new Headers((testGlobal.fetch as any).mock.calls[0][1].headers);
      expect(calledHeaders.get('Authorization')).toBe('Bearer test-api-key');
    } finally {
      cleanup();
    }
  });

  it('registers models with correct display names via provider.models', async () => {
    testGlobal.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: mockModels }),
    });

    const { input, cleanup } = createPluginContext();

    try {
      const plugin = await createPlugin(input, { providers: [crofaiEndpoint, groqEndpoint] });
      expect(plugin.provider.id).toBe('crofai');

      const ctx = { auth: { type: 'api' as const, key: 'test-api-key' } };
      const models = await plugin.provider.models({} as any, ctx);

      // Correct display names
      expect(models['kimi-k2.5-lightning'].name).toBe('MoonshotAI: Kimi K2.5 Lightning');
      expect(models['kimi-k2.5'].name).toBe('MoonshotAI: Kimi K2.5');
      expect(models['glm-5'].name).toBe('Z.ai: GLM 5');
      expect(models['glm-5.1'].name).toBe('Z.ai: GLM-5.1');
      expect(models['glm-5.1-precision'].name).toBe('Z.ai: GLM-5.1 Precision');

      // Capabilities
      expect(models['kimi-k2.5-lightning'].capabilities.reasoning).toBe(true);
      expect(models['kimi-k2.5'].capabilities.reasoning).toBe(true);
      expect(models['glm-5'].capabilities.reasoning).toBe(false);

      // API config points at the primary endpoint
      expect(models['kimi-k2.5'].api.id).toBe('kimi-k2.5');
      expect(models['kimi-k2.5'].api.url).toBe('https://crof.ai/v1');
      expect(models['kimi-k2.5'].api.npm).toBe('@ai-sdk/openai-compatible');
      expect(models['kimi-k2.5'].providerID).toBe('crofai');

      // Limits
      expect(models['kimi-k2.5'].limit.context).toBe(262144);
      expect(models['kimi-k2.5'].limit.output).toBe(262144);

      // Cost
      expect(models['kimi-k2.5'].cost.input).toBe(0.35);
      expect(models['kimi-k2.5'].cost.output).toBeCloseTo(1.8, 10);
    } finally {
      cleanup();
    }
  });

  it('should not duplicate variant suffix already present in model name', async () => {
    const mockFlashModels = [
      {
        id: 'glm-4.7',
        name: 'Z.AI: GLM 4.7',
        custom_reasoning: false,
        reasoning_effort: false,
        context_length: 202752,
        max_completion_tokens: 202752,
      },
      {
        id: 'glm-4.7-flash',
        name: 'Z.AI: GLM 4.7 Flash',
        custom_reasoning: false,
        reasoning_effort: false,
        context_length: 131072,
        max_completion_tokens: 65536,
      },
    ];

    testGlobal.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: mockFlashModels }),
    });

    const { input, cleanup } = createPluginContext();

    try {
      const plugin = await createPlugin(input, { providers: [crofaiEndpoint] });

      const ctx = { auth: { type: 'api' as const, key: 'test-api-key' } };
      const models = await plugin.provider.models({} as any, ctx);

      // Variant suffix not duplicated when already in name
      expect(models['glm-4.7-flash'].name).toBe('Z.AI: GLM 4.7 Flash');
      expect(models['glm-4.7'].name).toBe('Z.AI: GLM 4.7');
    } finally {
      cleanup();
    }
  });

  it('should not duplicate parenthesized variant suffixes already present in model name', async () => {
    const mockParenthesizedModels = [
      {
        id: 'kimi-k2.5-lightning',
        name: 'MoonshotAI: Kimi K2.5 (Lightning)',
        custom_reasoning: true,
        reasoning_effort: true,
        context_length: 131072,
        max_completion_tokens: 32768,
      },
      {
        id: 'glm-5.1-precision',
        name: 'Z.ai: GLM 5.1 (Precision)',
        custom_reasoning: true,
        reasoning_effort: true,
        context_length: 202752,
        max_completion_tokens: 202752,
      },
    ];

    testGlobal.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: mockParenthesizedModels }),
    });

    const { input, cleanup } = createPluginContext();

    try {
      const plugin = await createPlugin(input, { providers: [crofaiEndpoint] });

      const ctx = { auth: { type: 'api' as const, key: 'test-api-key' } };
      const models = await plugin.provider.models({} as any, ctx);

      expect(models['kimi-k2.5-lightning'].name).toBe('MoonshotAI: Kimi K2.5 (Lightning)');
      expect(models['glm-5.1-precision'].name).toBe('Z.ai: GLM 5.1 (Precision)');
    } finally {
      cleanup();
    }
  });

  it('exposes reasoning variants for models that support reasoning', async () => {
    testGlobal.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: mockModels }),
    });

    const { input, cleanup } = createPluginContext();

    try {
      const plugin = await createPlugin(input, { providers: [crofaiEndpoint] });

      const ctx = { auth: { type: 'api' as const, key: 'test-api-key' } };
      const models = await plugin.provider.models({} as any, ctx);

      // Reasoning-capable models have low/medium/high variants. OpenCode maps an effort level
      // for `@ai-sdk/openai-compatible` to `{ reasoningEffort }`, and the AI SDK serializes that
      // camelCase option into the `reasoning_effort` request body field.
      expect(models['kimi-k2.5'].variants).toBeDefined();
      expect(models['kimi-k2.5'].variants.low).toEqual({ reasoningEffort: 'low' });
      expect(models['kimi-k2.5'].variants.medium).toEqual({ reasoningEffort: 'medium' });
      expect(models['kimi-k2.5'].variants.high).toEqual({ reasoningEffort: 'high' });

      expect(models['kimi-k2.5-lightning'].variants).toBeDefined();
      expect(models['kimi-k2.5-lightning'].variants.low).toEqual({ reasoningEffort: 'low' });

      // Non-reasoning model has no variants
      expect(models['glm-5'].variants).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('uses cached models and refreshes them in the background', async () => {
    const { input, cleanup, cachePathFor } = createPluginContext();

    mkdirSync(dirname(cachePathFor('crofai')), { recursive: true });
    writeFileSync(
      cachePathFor('crofai'),
      JSON.stringify(
        {
          fetchedAt: new Date().toISOString(),
          models: [
            {
              id: 'cached-model',
              name: 'Cached Model',
              context_length: 1024,
              max_completion_tokens: 512,
            },
          ],
        },
        null,
        2
      ),
      'utf8'
    );

    testGlobal.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            id: 'updated-model',
            name: 'Updated Model',
            context_length: 2048,
            max_completion_tokens: 1024,
          },
        ],
      }),
    });

    try {
      const plugin = await createPlugin(input, { providers: [crofaiEndpoint] });

      const ctx = { auth: { type: 'api' as const, key: 'test-api-key' } };
      const models = await plugin.provider.models({} as any, ctx);

      expect(models['cached-model'].name).toBe('Cached Model');
      expect(testGlobal.fetch).toHaveBeenCalledTimes(1);

      for (let attempt = 0; attempt < 10; attempt++) {
        const cachedPayload = JSON.parse(readFileSync(cachePathFor('crofai'), 'utf8')) as {
          models: Array<{ id: string }>;
        };

        if (cachedPayload.models[0].id === 'updated-model') {
          break;
        }

        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      const cachedPayload = JSON.parse(readFileSync(cachePathFor('crofai'), 'utf8')) as {
        models: Array<{ id: string }>;
      };

      expect(cachedPayload.models[0].id).toBe('updated-model');
    } finally {
      cleanup();
    }
  });

  it('rejects when fetching models for the primary provider fails', async () => {
    testGlobal.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    });

    const { input, cleanup } = createPluginContext();

    try {
      const plugin = await createPlugin(input, { providers: [crofaiEndpoint] });

      const ctx = { auth: { type: 'api' as const, key: 'test-api-key' } };
      await expect(plugin.provider.models({} as any, ctx)).rejects.toThrow(
        'Failed to fetch CrofAI models: 401 Unauthorized'
      );
    } finally {
      cleanup();
    }
  });

  it('falls back to stale cached models when fetch fails', async () => {
    const { input, cleanup, cachePathFor } = createPluginContext();

    mkdirSync(dirname(cachePathFor('crofai')), { recursive: true });
    writeFileSync(
      cachePathFor('crofai'),
      JSON.stringify(
        {
          fetchedAt: '2000-01-01T00:00:00.000Z',
          models: [
            {
              id: 'stale-model',
              name: 'Stale Model',
              context_length: 2048,
              max_completion_tokens: 1024,
            },
          ],
        },
        null,
        2
      ),
      'utf8'
    );

    testGlobal.fetch = vi.fn().mockRejectedValue(new Error('network down'));

    try {
      const plugin = await createPlugin(input, { providers: [crofaiEndpoint] });

      const ctx = { auth: { type: 'api' as const, key: 'test-api-key' } };
      const models = await plugin.provider.models({} as any, ctx);

      expect(models['stale-model'].name).toBe('Stale Model');
      expect(testGlobal.fetch).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  it('writes fetched models to cache', async () => {
    testGlobal.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: mockModels }),
    });

    const { input, cleanup, cachePathFor } = createPluginContext();

    try {
      const plugin = await createPlugin(input, { providers: [crofaiEndpoint] });

      const ctx = { auth: { type: 'api' as const, key: 'test-api-key' } };
      await plugin.provider.models({} as any, ctx);

      expect(existsSync(cachePathFor('crofai'))).toBe(true);

      const cachedPayload = JSON.parse(readFileSync(cachePathFor('crofai'), 'utf8')) as {
        fetchedAt: string;
        models: Array<{ id: string }>;
      };

      expect(cachedPayload.fetchedAt).toBeTruthy();
      expect(cachedPayload.models[0].id).toBe('kimi-k2.5');
    } finally {
      cleanup();
    }
  });

  it('respects a custom cacheFile per endpoint', async () => {
    testGlobal.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: mockModels }),
    });

    const { input, cleanup, cacheHome, cachePathFor } = createPluginContext();

    try {
      const plugin = await createPlugin(input, {
        providers: [
          {
            id: 'local',
            name: 'Local',
            baseURL: 'http://localhost:1234/v1',
            cacheFile: 'custom-local-models.json',
          },
        ],
      });

      const cfg: any = {};
      await plugin.config(cfg);

      expect(cfg.provider.local).toBeDefined();
      expect(existsSync(join(cacheHome, 'opencode', '.cache', 'custom-local-models.json'))).toBe(
        true
      );
      expect(existsSync(cachePathFor('local'))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('uses the primary option to pick a non-first endpoint for hooks', async () => {
    testGlobal.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: mockModels }),
    });

    const { input, cleanup, cachePathFor } = createPluginContext();

    try {
      const plugin = await createPlugin(input, {
        providers: [groqEndpoint, crofaiEndpoint],
        primary: 'crofai',
      });

      expect(plugin.provider.id).toBe('crofai');
      expect(plugin.auth.provider).toBe('crofai');

      const ctx = { auth: { type: 'api' as const, key: 'test-api-key' } };
      const models = await plugin.provider.models({} as any, ctx);

      expect(models['kimi-k2.5'].api.url).toBe('https://crof.ai/v1');
      expect(models['kimi-k2.5'].providerID).toBe('crofai');
      expect(existsSync(cachePathFor('crofai'))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('does nothing when all providers are invalid', async () => {
    testGlobal.fetch = vi.fn();

    const { input, cleanup } = createPluginContext();

    try {
      const plugin = await createPlugin(input, {
        providers: [
          { name: 'NoId', baseURL: 'https://noid.example/v1' },
          { id: 'nobase', name: 'NoBase' },
        ],
      });

      expect(plugin).toEqual({});

      const cfg: any = {};
      await plugin.config?.(cfg);
      expect(cfg.provider).toBeUndefined();
      expect(testGlobal.fetch).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('skips endpoints missing an id', async () => {
    testGlobal.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: mockModels }),
    });

    const { input, cleanup } = createPluginContext();

    try {
      const plugin = await createPlugin(input, {
        providers: [{ name: 'NoId', baseURL: 'https://noid.example/v1' }, groqEndpoint],
      });

      const cfg: any = {};
      await plugin.config(cfg);

      expect(cfg.provider.groq).toBeDefined();
      expect(testGlobal.fetch).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  it('skips endpoints missing a name', async () => {
    testGlobal.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: mockModels }),
    });

    const { input, cleanup } = createPluginContext();

    try {
      const plugin = await createPlugin(input, {
        providers: [{ id: 'noname', baseURL: 'https://noname.example/v1' }, groqEndpoint],
      });

      const cfg: any = {};
      await plugin.config(cfg);

      expect(cfg.provider.noname).toBeUndefined();
      expect(cfg.provider.groq).toBeDefined();
      expect(testGlobal.fetch).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  it('registers other endpoints when one endpoint fails to fetch models', async () => {
    testGlobal.fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: mockModels }),
      });

    const { input, cleanup } = createPluginContext();

    try {
      const plugin = await createPlugin(input, {
        providers: [{ id: 'down', name: 'Down', baseURL: 'https://down.example/v1' }, groqEndpoint],
      });

      const cfg: any = {};
      await plugin.config(cfg);

      // Failed endpoint still registered with empty models, does not block the next one
      expect(cfg.provider.down).toBeDefined();
      expect(cfg.provider.down.models).toEqual({});
      expect(cfg.provider.groq).toBeDefined();
      expect(cfg.provider.groq.models['kimi-k2.5']).toBeDefined();
      expect(testGlobal.fetch).toHaveBeenCalledTimes(2);
    } finally {
      cleanup();
    }
  });

  it('falls back to the first provider when primary references an unknown id', async () => {
    testGlobal.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: mockModels }),
    });

    const { input, cleanup } = createPluginContext();

    try {
      const plugin = await createPlugin(input, {
        providers: [groqEndpoint, crofaiEndpoint],
        primary: 'ghost',
      });

      expect(plugin.provider.id).toBe('groq');
      expect(plugin.auth.provider).toBe('groq');

      const ctx = { auth: { type: 'api' as const, key: 'test-api-key' } };
      const models = await plugin.provider.models({} as any, ctx);

      expect(models['kimi-k2.5'].api.url).toBe('https://api.groq.com/openai/v1');
      expect(models['kimi-k2.5'].providerID).toBe('groq');
    } finally {
      cleanup();
    }
  });

  it('injects endpoint headers into provider options', async () => {
    testGlobal.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: mockModels }),
    });

    const { input, cleanup } = createPluginContext();

    try {
      const plugin = await createPlugin(input, {
        providers: [
          {
            id: 'hdr',
            name: 'HDR',
            baseURL: 'https://hdr.example/v1',
            headers: { 'X-Custom': 'yes' },
          },
        ],
      });

      const cfg: any = {};
      await plugin.config(cfg);

      expect(cfg.provider.hdr.options.headers).toEqual({ 'X-Custom': 'yes' });
    } finally {
      cleanup();
    }
  });

  it('rejects when the model fetch exceeds fetchTimeoutMs', async () => {
    testGlobal.fetch = vi.fn(
      (
        _url: string,
        init: { signal?: { addEventListener: (type: 'abort', cb: () => void) => void } } | undefined
      ) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const abortError = new Error('The operation was aborted.');
            abortError.name = 'AbortError';
            reject(abortError);
          });
        });
      }
    );

    const { input, cleanup } = createPluginContext();

    try {
      const plugin = await createPlugin(input, {
        providers: [crofaiEndpoint],
        fetchTimeoutMs: 60,
      });

      const ctx = { auth: { type: 'api' as const, key: 'test-api-key' } };
      await expect(plugin.provider.models({} as any, ctx)).rejects.toThrow(
        'CrofAI API request timed out'
      );
    } finally {
      cleanup();
    }
  });

  it('skips endpoints with reserved ids', async () => {
    testGlobal.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: mockModels }),
    });

    const { input, cleanup } = createPluginContext();

    try {
      const plugin = await createPlugin(input, {
        providers: [
          { id: '__proto__', name: 'Evil', baseURL: 'https://evil.example/v1' },
          { id: 'constructor', name: 'Evil', baseURL: 'https://evil.example/v1' },
          groqEndpoint,
        ],
      });

      const cfg: any = {};
      await plugin.config(cfg);

      expect(Object.prototype.hasOwnProperty.call(cfg.provider, '__proto__')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(cfg.provider, 'constructor')).toBe(false);
      expect(cfg.provider.groq).toBeDefined();
      expect(testGlobal.fetch).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  it('skips reserved model ids returned by the models endpoint', async () => {
    const modelsWithReserved = [
      ...mockModels,
      { id: '__proto__', name: 'Evil' },
      { id: 'constructor', name: 'Evil' },
    ];

    testGlobal.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: modelsWithReserved }),
    });

    const { input, cleanup } = createPluginContext();

    try {
      const plugin = await createPlugin(input, { providers: [crofaiEndpoint] });

      const cfg: any = {};
      await plugin.config(cfg);

      expect(Object.prototype.hasOwnProperty.call(cfg.provider.crofai.models, '__proto__')).toBe(
        false
      );
      expect(Object.prototype.hasOwnProperty.call(cfg.provider.crofai.models, 'constructor')).toBe(
        false
      );
      expect(cfg.provider.crofai.models['kimi-k2.5']).toBeDefined();
    } finally {
      cleanup();
    }
  });

  it('single-flights concurrent provider.models calls without a cache', async () => {
    testGlobal.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: mockModels }),
    });

    const { input, cleanup } = createPluginContext();

    try {
      const plugin = await createPlugin(input, { providers: [crofaiEndpoint] });

      const ctx = { auth: { type: 'api' as const, key: 'test-api-key' } };
      const [first, second] = await Promise.all([
        plugin.provider.models({} as any, ctx),
        plugin.provider.models({} as any, ctx),
      ]);

      expect(testGlobal.fetch).toHaveBeenCalledTimes(1);
      expect(first['kimi-k2.5'].name).toBe('MoonshotAI: Kimi K2.5');
      expect(second['kimi-k2.5'].name).toBe('MoonshotAI: Kimi K2.5');
    } finally {
      cleanup();
    }
  });

  describe('{env:VAR} expansion', () => {
    const setEnv = (name: string, value: string | undefined) => {
      const previous = process.env[name];
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
      return () => {
        if (previous === undefined) {
          delete process.env[name];
          return;
        }
        process.env[name] = previous;
      };
    };

    it('expands {env:VAR} into the resolved apiKey', async () => {
      testGlobal.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: mockModels }),
      });

      const { input, cleanup } = createPluginContext();
      const restoreEnv = setEnv('CROFAI_API_KEY', 'resolved-secret');

      try {
        const plugin = await createPlugin(input, { providers: [crofaiEndpoint] });

        const cfg: any = {};
        await plugin.config(cfg);

        expect(cfg.provider.crofai.options.apiKey).toBe('resolved-secret');
      } finally {
        restoreEnv();
        cleanup();
      }
    });

    it('logs an [ERROR] and omits the key when the variable is unset', async () => {
      testGlobal.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: mockModels }),
      });

      const { input, cleanup } = createPluginContext();
      const restoreEnv = setEnv('CROFAI_API_KEY', undefined);

      try {
        const plugin = await createPlugin(input, { providers: [crofaiEndpoint] });

        const cfg: any = {};
        await plugin.config(cfg);

        // Never leak the raw placeholder as if it were a real credential.
        expect(cfg.provider.crofai.options.apiKey).toBeUndefined();

        const { log } = await import('../src/logger.ts');
        expect(log).toHaveBeenCalledWith(
          expect.stringContaining(
            'references environment variable CROFAI_API_KEY, which is unset or empty'
          )
        );
      } finally {
        restoreEnv();
        cleanup();
      }
    });

    it('treats an empty environment variable as missing', async () => {
      testGlobal.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: mockModels }),
      });

      const { input, cleanup } = createPluginContext();
      const restoreEnv = setEnv('CROFAI_API_KEY', '');

      try {
        const plugin = await createPlugin(input, { providers: [crofaiEndpoint] });

        const cfg: any = {};
        await plugin.config(cfg);

        expect(cfg.provider.crofai.options.apiKey).toBeUndefined();
      } finally {
        restoreEnv();
        cleanup();
      }
    });

    it('leaves literal keys untouched', async () => {
      testGlobal.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: mockModels }),
      });

      const { input, cleanup } = createPluginContext();

      try {
        const plugin = await createPlugin(input, {
          providers: [{ ...crofaiEndpoint, apiKey: 'sk-literal-value' }],
        });

        const cfg: any = {};
        await plugin.config(cfg);

        expect(cfg.provider.crofai.options.apiKey).toBe('sk-literal-value');
      } finally {
        cleanup();
      }
    });

    it('expands {env:VAR} inside endpoint headers', async () => {
      testGlobal.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: mockModels }),
      });

      const { input, cleanup } = createPluginContext();
      const restoreEnv = setEnv('CROFAI_TENANT', 'tenant-42');

      try {
        const plugin = await createPlugin(input, {
          providers: [
            {
              id: 'hdrenv',
              name: 'HdrEnv',
              baseURL: 'https://hdrenv.example/v1',
              headers: { 'X-Tenant': '{env:CROFAI_TENANT}', 'X-Static': 'plain' },
            },
          ],
        });

        const cfg: any = {};
        await plugin.config(cfg);

        expect(cfg.provider.hdrenv.options.headers).toEqual({
          'X-Tenant': 'tenant-42',
          'X-Static': 'plain',
        });
      } finally {
        restoreEnv();
        cleanup();
      }
    });

    it('sends the resolved key on the config-hook model fetch', async () => {
      testGlobal.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: mockModels }),
      });

      const { input, cleanup } = createPluginContext();
      const restoreEnv = setEnv('CROFAI_API_KEY', 'resolved-secret');

      try {
        const plugin = await createPlugin(input, { providers: [crofaiEndpoint] });

        const cfg: any = {};
        await plugin.config(cfg);

        const requestInit = (testGlobal.fetch as any).mock.calls[0][1];
        expect(requestInit.headers.Authorization).toBe('Bearer resolved-secret');
      } finally {
        restoreEnv();
        cleanup();
      }
    });

    it('falls back to the endpoint key in provider.models when auth is empty', async () => {
      testGlobal.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: mockModels }),
      });

      const { input, cleanup } = createPluginContext();
      const restoreEnv = setEnv('CROFAI_API_KEY', 'resolved-secret');

      try {
        const plugin = await createPlugin(input, { providers: [crofaiEndpoint] });

        await plugin.provider.models({} as any, { auth: { type: 'api', key: '' } });

        const requestInit = (testGlobal.fetch as any).mock.calls[0][1];
        expect(requestInit.headers.Authorization).toBe('Bearer resolved-secret');
      } finally {
        restoreEnv();
        cleanup();
      }
    });
  });

  describe('empty model cache guard', () => {
    it('never writes a cache file when discovery returns no models', async () => {
      testGlobal.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [] }),
      });

      const { input, cleanup, cachePathFor } = createPluginContext();

      try {
        const plugin = await createPlugin(input, { providers: [crofaiEndpoint] });

        const cfg: any = {};
        await plugin.config(cfg);

        expect(cfg.provider.crofai).toBeDefined();
        expect(cfg.provider.crofai.models).toEqual({});
        expect(existsSync(cachePathFor('crofai'))).toBe(false);
      } finally {
        cleanup();
      }
    });

    it('ignores a stale 0-model cache and refetches', async () => {
      const { input, cleanup, cachePathFor } = createPluginContext();

      mkdirSync(dirname(cachePathFor('crofai')), { recursive: true });
      writeFileSync(
        cachePathFor('crofai'),
        JSON.stringify({ fetchedAt: new Date().toISOString(), models: [] }, null, 2),
        'utf8'
      );

      testGlobal.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: mockModels }),
      });

      try {
        const plugin = await createPlugin(input, { providers: [crofaiEndpoint] });

        const cfg: any = {};
        await plugin.config(cfg);

        // The empty cache must not win over a real fetch.
        expect(testGlobal.fetch).toHaveBeenCalledTimes(1);
        expect(cfg.provider.crofai.models['kimi-k2.5']).toBeDefined();

        const cachedPayload = JSON.parse(readFileSync(cachePathFor('crofai'), 'utf8')) as {
          models: Array<{ id: string }>;
        };
        expect(cachedPayload.models.length).toBeGreaterThan(0);
      } finally {
        cleanup();
      }
    });
  });

  describe('model cache TTL', () => {
    const writeCache = (path: string, fetchedAt: string, models: any[]) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({ fetchedAt, models }, null, 2), 'utf8');
    };

    const cachedOnlyModel = [
      {
        id: 'cached-model',
        name: 'Cached Model',
        context_length: 1024,
        max_completion_tokens: 512,
      },
    ];

    const serverModelsWithAddition = [
      ...cachedOnlyModel,
      {
        id: 'newly-added-model',
        name: 'Newly Added Model',
        context_length: 4096,
        max_completion_tokens: 2048,
      },
    ];

    const respondWith = (models: any[]) =>
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: models }) });

    it('registers from a fresh cache without fetching', async () => {
      const { input, cleanup, cachePathFor } = createPluginContext();

      writeCache(cachePathFor('crofai'), new Date().toISOString(), cachedOnlyModel);
      testGlobal.fetch = respondWith(serverModelsWithAddition);

      try {
        const plugin = await createPlugin(input, { providers: [crofaiEndpoint] });

        const cfg: any = {};
        await plugin.config(cfg);

        expect(testGlobal.fetch).not.toHaveBeenCalled();
        expect(cfg.provider.crofai.models['cached-model']).toBeDefined();
        expect(cfg.provider.crofai.models['newly-added-model']).toBeUndefined();
      } finally {
        cleanup();
      }
    });

    // The user-reported bug: a model added on the endpoint used to appear only after the
    // SECOND restart because an unexpired-forever cache short-circuited discovery.
    it('refetches an expired cache and registers newly added models in the same run', async () => {
      const { input, cleanup, cachePathFor } = createPluginContext();

      const sixMinutesAgo = new Date(Date.now() - 6 * 60 * 1000).toISOString();
      writeCache(cachePathFor('crofai'), sixMinutesAgo, cachedOnlyModel);
      testGlobal.fetch = respondWith(serverModelsWithAddition);

      try {
        const plugin = await createPlugin(input, { providers: [crofaiEndpoint] });

        const cfg: any = {};
        await plugin.config(cfg);

        expect(testGlobal.fetch).toHaveBeenCalledTimes(1);
        expect(cfg.provider.crofai.models['newly-added-model']).toBeDefined();
        expect(cfg.provider.crofai.models['newly-added-model'].name).toBe('Newly Added Model');

        const cachedPayload = JSON.parse(readFileSync(cachePathFor('crofai'), 'utf8')) as {
          models: Array<{ id: string }>;
        };
        expect(cachedPayload.models.map((model) => model.id)).toContain('newly-added-model');
      } finally {
        cleanup();
      }
    });

    it('treats a cache exactly at the TTL boundary as expired', async () => {
      const { input, cleanup, cachePathFor } = createPluginContext();

      // age === ttl is a miss; freshness requires age < ttl.
      writeCache(
        cachePathFor('crofai'),
        new Date(Date.now() - 1000).toISOString(),
        cachedOnlyModel
      );
      testGlobal.fetch = respondWith(serverModelsWithAddition);

      try {
        const plugin = await createPlugin(input, {
          providers: [{ ...crofaiEndpoint, cacheTtlMs: 1000 }],
        });

        const cfg: any = {};
        await plugin.config(cfg);

        expect(testGlobal.fetch).toHaveBeenCalledTimes(1);
        expect(cfg.provider.crofai.models['newly-added-model']).toBeDefined();
      } finally {
        cleanup();
      }
    });

    it('keeps a cache younger than a custom TTL', async () => {
      const { input, cleanup, cachePathFor } = createPluginContext();

      writeCache(
        cachePathFor('crofai'),
        new Date(Date.now() - 30 * 60 * 1000).toISOString(),
        cachedOnlyModel
      );
      testGlobal.fetch = respondWith(serverModelsWithAddition);

      try {
        const plugin = await createPlugin(input, {
          providers: [{ ...crofaiEndpoint, cacheTtlMs: 60 * 60 * 1000 }],
        });

        const cfg: any = {};
        await plugin.config(cfg);

        expect(testGlobal.fetch).not.toHaveBeenCalled();
        expect(cfg.provider.crofai.models['cached-model']).toBeDefined();
      } finally {
        cleanup();
      }
    });

    it('always fetches when cacheTtlMs is 0, even with a cache written this instant', async () => {
      const { input, cleanup, cachePathFor } = createPluginContext();

      writeCache(cachePathFor('crofai'), new Date().toISOString(), cachedOnlyModel);
      testGlobal.fetch = respondWith(serverModelsWithAddition);

      try {
        const plugin = await createPlugin(input, {
          providers: [{ ...crofaiEndpoint, cacheTtlMs: 0 }],
        });

        const cfg: any = {};
        await plugin.config(cfg);

        expect(testGlobal.fetch).toHaveBeenCalledTimes(1);
        expect(cfg.provider.crofai.models['newly-added-model']).toBeDefined();
      } finally {
        cleanup();
      }
    });

    it('clamps a negative cacheTtlMs to 0 rather than caching forever', async () => {
      const { input, cleanup, cachePathFor } = createPluginContext();

      writeCache(cachePathFor('crofai'), new Date().toISOString(), cachedOnlyModel);
      testGlobal.fetch = respondWith(serverModelsWithAddition);

      try {
        const plugin = await createPlugin(input, {
          providers: [{ ...crofaiEndpoint, cacheTtlMs: -1 }],
        });

        const cfg: any = {};
        await plugin.config(cfg);

        expect(testGlobal.fetch).toHaveBeenCalledTimes(1);
        expect(cfg.provider.crofai.models['newly-added-model']).toBeDefined();
      } finally {
        cleanup();
      }
    });

    it('falls back to an expired cache in the config hook when discovery fails', async () => {
      const { input, cleanup, cachePathFor } = createPluginContext();

      writeCache(cachePathFor('crofai'), '2000-01-01T00:00:00.000Z', cachedOnlyModel);
      testGlobal.fetch = vi.fn().mockRejectedValue(new Error('network down'));

      try {
        const plugin = await createPlugin(input, { providers: [crofaiEndpoint] });

        const cfg: any = {};
        await plugin.config(cfg);

        expect(testGlobal.fetch).toHaveBeenCalledTimes(1);
        // Offline resilience: the endpoint is unreachable, so the stale list still registers
        // instead of leaving the provider with zero models.
        expect(cfg.provider.crofai.models['cached-model']).toBeDefined();
      } finally {
        cleanup();
      }
    });

    it('does not overwrite a newer cached list with an older discovery result', async () => {
      const { input, cleanup, cachePathFor } = createPluginContext();

      const newerTimestamp = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      writeCache(cachePathFor('crofai'), newerTimestamp, [
        { id: 'newer-model', name: 'Newer Model' },
      ]);
      testGlobal.fetch = respondWith(serverModelsWithAddition);

      try {
        const plugin = await createPlugin(input, {
          providers: [{ ...crofaiEndpoint, cacheTtlMs: 0 }],
        });

        const cfg: any = {};
        await plugin.config(cfg);

        expect(testGlobal.fetch).toHaveBeenCalledTimes(1);
        // The fetched list is registered for this session...
        expect(cfg.provider.crofai.models['newly-added-model']).toBeDefined();

        // ...but the newer on-disk list is left alone.
        const cachedPayload = JSON.parse(readFileSync(cachePathFor('crofai'), 'utf8')) as {
          fetchedAt: string;
          models: Array<{ id: string }>;
        };
        expect(cachedPayload.fetchedAt).toBe(newerTimestamp);
        expect(cachedPayload.models.map((model) => model.id)).toEqual(['newer-model']);
      } finally {
        cleanup();
      }
    });

    it('refetches an expired cache in the primary provider.models hook', async () => {
      const { input, cleanup, cachePathFor } = createPluginContext();

      writeCache(cachePathFor('crofai'), '2000-01-01T00:00:00.000Z', cachedOnlyModel);
      testGlobal.fetch = respondWith(serverModelsWithAddition);

      try {
        const plugin = await createPlugin(input, { providers: [crofaiEndpoint] });

        const ctx = { auth: { type: 'api' as const, key: 'test-api-key' } };
        const models = await plugin.provider.models({} as any, ctx);

        expect(testGlobal.fetch).toHaveBeenCalledTimes(1);
        expect(models['newly-added-model']).toBeDefined();
      } finally {
        cleanup();
      }
    });
  });

  describe('config file loading', () => {
    const configFileName = 'opencode-openai-compatible.json';

    const writeProjectConfig = (dir: string, content: string) => {
      writeFileSync(join(dir, configFileName), content, 'utf8');
    };

    it('loads endpoints from the project config file', async () => {
      testGlobal.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: mockModels }),
      });

      const { input, cleanup, cachePathFor } = createPluginContext();

      try {
        writeProjectConfig(
          input.directory,
          JSON.stringify({
            primary: 'crofai',
            providers: [crofaiEndpoint, groqEndpoint],
          })
        );

        const plugin = await createPlugin(input, {});
        expect(plugin.provider.id).toBe('crofai');

        const cfg: any = {};
        await plugin.config(cfg);

        // Both endpoints from the file are registered
        expect(cfg.provider.crofai).toBeDefined();
        expect(cfg.provider.groq).toBeDefined();
        expect(cfg.provider.crofai.options.baseURL).toBe('https://crof.ai/v1');
        expect(cfg.provider.groq.options.baseURL).toBe('https://api.groq.com/openai/v1');
        expect(cfg.provider.crofai.models['kimi-k2.5']).toBeDefined();
        expect(cfg.provider.groq.models['kimi-k2.5']).toBeDefined();

        // Cache files written per endpoint from the file
        expect(existsSync(cachePathFor('crofai'))).toBe(true);
        expect(existsSync(cachePathFor('groq'))).toBe(true);

        const { log } = await import('../src/logger.ts');
        expect(log).toHaveBeenCalledWith(
          expect.stringContaining(
            `Loaded endpoint config from ${join(input.directory, configFileName)}`
          )
        );
      } finally {
        cleanup();
      }
    });

    it('uses the OPENCODE_OPENAI_COMPATIBLE_CONFIG env var file over the project file', async () => {
      testGlobal.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: mockModels }),
      });

      const { input, cleanup, testDir } = createPluginContext();
      const previousEnv = process.env.OPENCODE_OPENAI_COMPATIBLE_CONFIG;

      try {
        const envConfigPath = join(testDir, 'custom-config.json');
        writeFileSync(envConfigPath, JSON.stringify({ providers: [crofaiEndpoint] }), 'utf8');
        process.env.OPENCODE_OPENAI_COMPATIBLE_CONFIG = envConfigPath;

        // An unrelated config file in the project dir is ignored
        writeProjectConfig(input.directory, JSON.stringify({ providers: [groqEndpoint] }));

        const plugin = await createPlugin(input, {});

        const cfg: any = {};
        await plugin.config(cfg);

        expect(cfg.provider.crofai).toBeDefined();
        expect(cfg.provider.crofai.options.baseURL).toBe('https://crof.ai/v1');
        expect(cfg.provider.groq).toBeUndefined();

        const { log } = await import('../src/logger.ts');
        expect(log).toHaveBeenCalledWith(
          expect.stringContaining(`Loaded endpoint config from ${envConfigPath}`)
        );
      } finally {
        if (previousEnv === undefined) {
          delete process.env.OPENCODE_OPENAI_COMPATIBLE_CONFIG;
        } else {
          process.env.OPENCODE_OPENAI_COMPATIBLE_CONFIG = previousEnv;
        }
        cleanup();
      }
    });

    it('falls back to plugin options when no config file exists', async () => {
      testGlobal.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: mockModels }),
      });

      const { input, cleanup } = createPluginContext();

      try {
        const plugin = await createPlugin(input, { providers: [crofaiEndpoint, groqEndpoint] });

        const cfg: any = {};
        await plugin.config(cfg);

        expect(cfg.provider.crofai).toBeDefined();
        expect(cfg.provider.groq).toBeDefined();
        expect(cfg.provider.crofai.options.baseURL).toBe('https://crof.ai/v1');
        expect(cfg.provider.groq.options.baseURL).toBe('https://api.groq.com/openai/v1');

        const { log } = await import('../src/logger.ts');
        expect(log).toHaveBeenCalledWith(
          expect.stringContaining('No config file found; using plugin options')
        );
      } finally {
        cleanup();
      }
    });

    it('falls back to options when the project config file is malformed', async () => {
      testGlobal.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: mockModels }),
      });

      const { input, cleanup } = createPluginContext();

      try {
        writeProjectConfig(input.directory, '{ bad json');

        const plugin = await createPlugin(input, { providers: [groqEndpoint] });

        const cfg: any = {};
        await plugin.config(cfg);

        expect(cfg.provider.groq).toBeDefined();
        expect(cfg.provider.groq.options.baseURL).toBe('https://api.groq.com/openai/v1');

        const { log } = await import('../src/logger.ts');
        expect(log).toHaveBeenCalledWith(
          expect.stringContaining('[ERROR] Failed to read plugin config from')
        );
      } finally {
        cleanup();
      }
    });

    it('stays inactive when the project config file is malformed and no options are given', async () => {
      testGlobal.fetch = vi.fn();

      const { input, cleanup } = createPluginContext();

      try {
        writeProjectConfig(input.directory, '{ bad json');

        const plugin = await createPlugin(input, {});

        expect(plugin).toEqual({});

        const cfg: any = {};
        await plugin.config?.(cfg);
        expect(cfg.provider).toBeUndefined();
        expect(testGlobal.fetch).not.toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });

    it('prefers the project config file over plugin options', async () => {
      testGlobal.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: mockModels }),
      });

      const { input, cleanup } = createPluginContext();

      try {
        writeProjectConfig(
          input.directory,
          JSON.stringify({
            primary: 'crofai',
            providers: [crofaiEndpoint],
          })
        );

        const plugin = await createPlugin(input, { providers: [groqEndpoint] });

        expect(plugin.provider.id).toBe('crofai');

        const cfg: any = {};
        await plugin.config(cfg);

        expect(cfg.provider.crofai).toBeDefined();
        expect(cfg.provider.groq).toBeUndefined();
      } finally {
        cleanup();
      }
    });

    it('falls back to options when the env var config path does not exist', async () => {
      testGlobal.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: mockModels }),
      });

      const { input, cleanup } = createPluginContext();
      const previousEnv = process.env.OPENCODE_OPENAI_COMPATIBLE_CONFIG;

      try {
        process.env.OPENCODE_OPENAI_COMPATIBLE_CONFIG = join(input.directory, 'missing.json');

        const plugin = await createPlugin(input, { providers: [groqEndpoint] });

        const cfg: any = {};
        await plugin.config(cfg);

        expect(cfg.provider.groq).toBeDefined();
        expect(cfg.provider.groq.options.baseURL).toBe('https://api.groq.com/openai/v1');

        const { log } = await import('../src/logger.ts');
        expect(log).toHaveBeenCalledWith(
          expect.stringContaining('No config file found; using plugin options')
        );
      } finally {
        if (previousEnv === undefined) {
          delete process.env.OPENCODE_OPENAI_COMPATIBLE_CONFIG;
        } else {
          process.env.OPENCODE_OPENAI_COMPATIBLE_CONFIG = previousEnv;
        }
        cleanup();
      }
    });

    it('loads endpoints from the global opencode config directory', async () => {
      testGlobal.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: mockModels }),
      });

      const { input, cleanup, globalConfigDir } = createPluginContext();

      try {
        const globalConfigPath = join(globalConfigDir, configFileName);
        writeFileSync(globalConfigPath, JSON.stringify({ providers: [crofaiEndpoint] }), 'utf8');

        const plugin = await createPlugin(input, {});

        const cfg: any = {};
        await plugin.config(cfg);

        expect(cfg.provider.crofai).toBeDefined();
        expect(cfg.provider.crofai.options.baseURL).toBe('https://crof.ai/v1');

        const { log } = await import('../src/logger.ts');
        expect(log).toHaveBeenCalledWith(
          expect.stringContaining(`Loaded endpoint config from ${globalConfigPath}`)
        );
      } finally {
        cleanup();
      }
    });

    it('loads endpoints from OPENCODE_CONFIG_DIR', async () => {
      testGlobal.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: mockModels }),
      });

      const { input, cleanup, testDir } = createPluginContext();

      try {
        const configDir = join(testDir, 'opencode-config-dir');
        mkdirSync(configDir, { recursive: true });
        process.env.OPENCODE_CONFIG_DIR = configDir;

        const configPath = join(configDir, configFileName);
        writeFileSync(configPath, JSON.stringify({ providers: [crofaiEndpoint] }), 'utf8');

        const plugin = await createPlugin(input, {});

        const cfg: any = {};
        await plugin.config(cfg);

        expect(cfg.provider.crofai).toBeDefined();

        const { log } = await import('../src/logger.ts');
        expect(log).toHaveBeenCalledWith(
          expect.stringContaining(`Loaded endpoint config from ${configPath}`)
        );
      } finally {
        cleanup();
      }
    });

    it('loads endpoints from the .opencode subdirectory of the project', async () => {
      testGlobal.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: mockModels }),
      });

      const { input, cleanup } = createPluginContext();

      try {
        const dotOpencodeDir = join(input.directory, '.opencode');
        mkdirSync(dotOpencodeDir, { recursive: true });
        const configPath = join(dotOpencodeDir, configFileName);
        writeFileSync(configPath, JSON.stringify({ providers: [crofaiEndpoint] }), 'utf8');

        const plugin = await createPlugin(input, {});

        const cfg: any = {};
        await plugin.config(cfg);

        expect(cfg.provider.crofai).toBeDefined();

        const { log } = await import('../src/logger.ts');
        expect(log).toHaveBeenCalledWith(
          expect.stringContaining(`Loaded endpoint config from ${configPath}`)
        );
      } finally {
        cleanup();
      }
    });

    it('loads endpoints from a .jsonc config file', async () => {
      testGlobal.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: mockModels }),
      });

      const { input, cleanup } = createPluginContext();

      try {
        const configPath = join(input.directory, 'opencode-openai-compatible.jsonc');
        writeFileSync(configPath, JSON.stringify({ providers: [crofaiEndpoint] }), 'utf8');

        const plugin = await createPlugin(input, {});

        const cfg: any = {};
        await plugin.config(cfg);

        expect(cfg.provider.crofai).toBeDefined();

        const { log } = await import('../src/logger.ts');
        expect(log).toHaveBeenCalledWith(
          expect.stringContaining(`Loaded endpoint config from ${configPath}`)
        );
      } finally {
        cleanup();
      }
    });

    it('prefers .json over .jsonc in the same directory', async () => {
      testGlobal.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: mockModels }),
      });

      const { input, cleanup } = createPluginContext();

      try {
        writeProjectConfig(input.directory, JSON.stringify({ providers: [crofaiEndpoint] }));
        writeFileSync(
          join(input.directory, 'opencode-openai-compatible.jsonc'),
          JSON.stringify({ providers: [groqEndpoint] }),
          'utf8'
        );

        const plugin = await createPlugin(input, {});

        const cfg: any = {};
        await plugin.config(cfg);

        expect(cfg.provider.crofai).toBeDefined();
        expect(cfg.provider.groq).toBeUndefined();
      } finally {
        cleanup();
      }
    });

    it('parses comments and trailing commas while preserving URLs', async () => {
      testGlobal.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: mockModels }),
      });

      const { input, cleanup } = createPluginContext();

      try {
        writeProjectConfig(
          input.directory,
          `{
  // Primary endpoint used for /connect auth
  "primary": "crofai",
  /* Block comment
     spanning lines, with a URL inside: https://example.com/v1 */
  "providers": [
    {
      "id": "crofai",
      "name": "CrofAI",
      // Double slashes inside this string must survive
      "baseURL": "https://crof.ai/v1",
      "headers": { "X-Note": "http://not-a-comment.example/v1 // still text" },
    },
  ],
}
`
        );

        const plugin = await createPlugin(input, {});
        expect(plugin.provider.id).toBe('crofai');

        const cfg: any = {};
        await plugin.config(cfg);

        expect(cfg.provider.crofai).toBeDefined();
        expect(cfg.provider.crofai.options.baseURL).toBe('https://crof.ai/v1');
        expect(cfg.provider.crofai.options.headers).toEqual({
          'X-Note': 'http://not-a-comment.example/v1 // still text',
        });
      } finally {
        cleanup();
      }
    });

    it('prefers the env var, then the project file, then the global file', async () => {
      testGlobal.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: mockModels }),
      });

      const { input, cleanup, testDir, globalConfigDir } = createPluginContext();

      try {
        const globalEndpoint = {
          id: 'globalep',
          name: 'GlobalEP',
          baseURL: 'https://global.dev/v1',
        };
        const envEndpoint = { id: 'envep', name: 'EnvEP', baseURL: 'https://env.dev/v1' };

        writeFileSync(
          join(globalConfigDir, configFileName),
          JSON.stringify({ providers: [globalEndpoint] }),
          'utf8'
        );

        // Global only: global file wins over the (empty) options
        const globalOnly: any = {};
        await (await createPlugin(input, {})).config(globalOnly);
        expect(globalOnly.provider.globalep).toBeDefined();

        // Project file beats the global file
        writeProjectConfig(input.directory, JSON.stringify({ providers: [crofaiEndpoint] }));
        const projectWins: any = {};
        await (await createPlugin(input, {})).config(projectWins);
        expect(projectWins.provider.crofai).toBeDefined();
        expect(projectWins.provider.globalep).toBeUndefined();

        // Env var beats the project file
        const envConfigPath = join(testDir, 'env-config.json');
        writeFileSync(envConfigPath, JSON.stringify({ providers: [envEndpoint] }), 'utf8');
        process.env.OPENCODE_OPENAI_COMPATIBLE_CONFIG = envConfigPath;

        const envWins: any = {};
        await (await createPlugin(input, {})).config(envWins);
        expect(envWins.provider.envep).toBeDefined();
        expect(envWins.provider.crofai).toBeUndefined();
        expect(envWins.provider.globalep).toBeUndefined();
      } finally {
        cleanup();
      }
    });

    it('prefers plugin options only after every config candidate misses', async () => {
      testGlobal.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: mockModels }),
      });

      const { input, cleanup, globalConfigDir } = createPluginContext();

      try {
        writeFileSync(
          join(globalConfigDir, configFileName),
          JSON.stringify({ providers: [crofaiEndpoint] }),
          'utf8'
        );

        const plugin = await createPlugin(input, { providers: [groqEndpoint] });

        const cfg: any = {};
        await plugin.config(cfg);

        expect(cfg.provider.crofai).toBeDefined();
        expect(cfg.provider.groq).toBeUndefined();
      } finally {
        cleanup();
      }
    });

    it('logs every attempted path when no config file exists', async () => {
      testGlobal.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: mockModels }),
      });

      const { input, cleanup, globalConfigDir } = createPluginContext();

      try {
        const plugin = await createPlugin(input, { providers: [groqEndpoint] });

        const cfg: any = {};
        await plugin.config(cfg);

        const { log } = await import('../src/logger.ts');
        const attemptedLog = (log as any).mock.calls
          .map((call: any[]) => String(call[0]))
          .find((message: string) => message.includes('No usable config file found'));

        expect(attemptedLog).toBeDefined();
        expect(attemptedLog).toContain(join(input.directory, configFileName));
        expect(attemptedLog).toContain(join(input.directory, '.opencode', configFileName));
        expect(attemptedLog).toContain(join(globalConfigDir, configFileName));
        expect(attemptedLog).toContain('opencode-openai-compatible.jsonc');

        expect(log).toHaveBeenCalledWith(
          expect.stringContaining('No config file found; using plugin options')
        );
      } finally {
        cleanup();
      }
    });

    it('reports an [ERROR] and continues when an explicit env config file is malformed', async () => {
      testGlobal.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: mockModels }),
      });

      const { input, cleanup, testDir, globalConfigDir } = createPluginContext();

      try {
        const envConfigPath = join(testDir, 'broken-config.json');
        writeFileSync(envConfigPath, '{ bad json', 'utf8');
        process.env.OPENCODE_OPENAI_COMPATIBLE_CONFIG = envConfigPath;

        writeFileSync(
          join(globalConfigDir, configFileName),
          JSON.stringify({ providers: [crofaiEndpoint] }),
          'utf8'
        );

        const plugin = await createPlugin(input, {});

        const cfg: any = {};
        await plugin.config(cfg);

        // Falls through to the next candidate instead of going inactive
        expect(cfg.provider.crofai).toBeDefined();

        const { log } = await import('../src/logger.ts');
        expect(log).toHaveBeenCalledWith(
          expect.stringContaining(`[ERROR] Failed to read plugin config from ${envConfigPath}`)
        );
      } finally {
        cleanup();
      }
    });
  });
});
