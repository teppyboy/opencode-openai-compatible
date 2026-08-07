import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';

// Mock the logger before importing the plugin
vi.mock('../src/logger.ts', () => ({
  log: vi.fn(),
  initLogger: vi.fn().mockResolvedValue(undefined),
}));

const originalFetch = globalThis.fetch;

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
    const previousXdgCacheHome = process.env.XDG_CACHE_HOME;

    process.env.XDG_CACHE_HOME = cacheHome;

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
      cachePathFor: (id: string) => join(cacheHome, 'opencode', '.cache', `${id}-models.json`),
      cleanup: () => {
        if (previousXdgCacheHome === undefined) {
          delete process.env.XDG_CACHE_HOME;
        } else {
          process.env.XDG_CACHE_HOME = previousXdgCacheHome;
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
    globalThis.fetch = originalFetch;
  });

  it('registers multiple endpoints into config', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
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
      expect(cfg.provider.crofai.options.apiKey).toBe('{env:CROFAI_API_KEY}');
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
    globalThis.fetch = vi.fn();

    const { input, cleanup } = createPluginContext();

    try {
      const plugin = await createPlugin(input, {});
      expect(plugin).toEqual({});

      const cfg: any = {};
      await plugin.config?.(cfg);
      expect(cfg.provider).toBeUndefined();
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('skips endpoints missing baseURL', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
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
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  it('keeps the first provider when ids are duplicated', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
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
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
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

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: mockModels }),
    });

    try {
      const plugin = await createPlugin(input, { providers: [crofaiEndpoint] });

      const cfg: any = {};
      await plugin.config(cfg);

      expect(cfg.provider.crofai.models['cached-model'].name).toBe('Cached Model');
      expect(cfg.provider.crofai.models['kimi-k2.5']).toBeUndefined();
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('preserves user-provided provider config while merging discovered models', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
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
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    const { input, cleanup } = createPluginContext();

    try {
      const plugin = await createPlugin(input, { providers: [crofaiEndpoint] });

      const result = await plugin.auth.loader(mockGetAuth, {} as any);

      expect(result.apiKey).toBe('test-api-key');

      // Make a request through the fetch wrapper
      await result.fetch('https://example.com', {});
      const calledHeaders = new Headers((globalThis.fetch as any).mock.calls[0][1].headers);
      expect(calledHeaders.get('Authorization')).toBe('Bearer test-api-key');
    } finally {
      cleanup();
    }
  });

  it('registers models with correct display names via provider.models', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
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

    globalThis.fetch = vi.fn().mockResolvedValue({
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

    globalThis.fetch = vi.fn().mockResolvedValue({
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
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: mockModels }),
    });

    const { input, cleanup } = createPluginContext();

    try {
      const plugin = await createPlugin(input, { providers: [crofaiEndpoint] });

      const ctx = { auth: { type: 'api' as const, key: 'test-api-key' } };
      const models = await plugin.provider.models({} as any, ctx);

      // Reasoning-capable models have low/medium/high variants
      expect(models['kimi-k2.5'].variants).toBeDefined();
      expect(models['kimi-k2.5'].variants.low).toEqual({ reasoning_effort: 'low' });
      expect(models['kimi-k2.5'].variants.medium).toEqual({ reasoning_effort: 'medium' });
      expect(models['kimi-k2.5'].variants.high).toEqual({ reasoning_effort: 'high' });

      expect(models['kimi-k2.5-lightning'].variants).toBeDefined();
      expect(models['kimi-k2.5-lightning'].variants.low).toEqual({ reasoning_effort: 'low' });

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

    globalThis.fetch = vi.fn().mockResolvedValue({
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
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);

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
    globalThis.fetch = vi.fn().mockResolvedValue({
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

    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network down'));

    try {
      const plugin = await createPlugin(input, { providers: [crofaiEndpoint] });

      const ctx = { auth: { type: 'api' as const, key: 'test-api-key' } };
      const models = await plugin.provider.models({} as any, ctx);

      expect(models['stale-model'].name).toBe('Stale Model');
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  it('writes fetched models to cache', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
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
    globalThis.fetch = vi.fn().mockResolvedValue({
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
    globalThis.fetch = vi.fn().mockResolvedValue({
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
    globalThis.fetch = vi.fn();

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
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('skips endpoints missing an id', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
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
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  it('skips endpoints missing a name', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
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
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  it('registers other endpoints when one endpoint fails to fetch models', async () => {
    globalThis.fetch = vi
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
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    } finally {
      cleanup();
    }
  });

  it('falls back to the first provider when primary references an unknown id', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
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
    globalThis.fetch = vi.fn().mockResolvedValue({
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
    globalThis.fetch = vi.fn(
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
    globalThis.fetch = vi.fn().mockResolvedValue({
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
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
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

    globalThis.fetch = vi.fn().mockResolvedValue({
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
    globalThis.fetch = vi.fn().mockResolvedValue({
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

      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      expect(first['kimi-k2.5'].name).toBe('MoonshotAI: Kimi K2.5');
      expect(second['kimi-k2.5'].name).toBe('MoonshotAI: Kimi K2.5');
    } finally {
      cleanup();
    }
  });

  describe('config file loading', () => {
    const configFileName = 'opencode-openai-compatible.json';

    const writeProjectConfig = (dir: string, content: string) => {
      writeFileSync(join(dir, configFileName), content, 'utf8');
    };

    it('loads endpoints from the project config file', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
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
      globalThis.fetch = vi.fn().mockResolvedValue({
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
      globalThis.fetch = vi.fn().mockResolvedValue({
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
      globalThis.fetch = vi.fn().mockResolvedValue({
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
      globalThis.fetch = vi.fn();

      const { input, cleanup } = createPluginContext();

      try {
        writeProjectConfig(input.directory, '{ bad json');

        const plugin = await createPlugin(input, {});

        expect(plugin).toEqual({});

        const cfg: any = {};
        await plugin.config?.(cfg);
        expect(cfg.provider).toBeUndefined();
        expect(globalThis.fetch).not.toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });

    it('prefers the project config file over plugin options', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
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
      globalThis.fetch = vi.fn().mockResolvedValue({
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
  });
});
