import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock the logger before importing the plugin
vi.mock('../src/logger.ts', () => ({
  log: vi.fn(),
  initLogger: vi.fn().mockResolvedValue(undefined),
}));

const originalFetch = globalThis.fetch;

const nineRouterEndpoint = {
  id: '9router',
  name: '9Router',
  baseURL: 'https://9router.example/v1',
};

/**
 * Verbatim entries from a live `GET {baseURL}/models` response of a 9router-style gateway
 * (89 models). Only the `capabilities` object shape matters here: the upstream advertises no
 * flat legacy fields at all, so these exercise the capabilities-only code path.
 *
 * `search` is present on the live payload (86 of 89 models, `true` on 40) and is deliberately
 * kept in these fixtures even though the plugin ignores it — the OpenCode model schema has no
 * slot for it. Keeping it here proves an unknown capability key never breaks registration.
 */
const liveModels = [
  {
    id: 'ocg/glm-5.2',
    object: 'model',
    owned_by: 'ocg',
    capabilities: {
      vision: false,
      pdf: false,
      audioInput: false,
      videoInput: false,
      imageOutput: false,
      audioOutput: false,
      search: false,
      tools: true,
      reasoning: true,
      thinkingFormat: 'zai',
      thinkingCanDisable: true,
      thinkingRange: null,
      contextWindow: 200000,
      maxOutput: 128000,
    },
  },
  {
    id: 'ocg/kimi-k2.7-code',
    object: 'model',
    owned_by: 'ocg',
    capabilities: {
      vision: true,
      pdf: false,
      audioInput: false,
      videoInput: true,
      imageOutput: false,
      audioOutput: false,
      search: false,
      tools: true,
      reasoning: true,
      thinkingFormat: 'kimi',
      thinkingCanDisable: false,
      thinkingRange: null,
      contextWindow: 262144,
      maxOutput: 65536,
    },
  },
  {
    id: 'gc/gemini-2.5-pro',
    object: 'model',
    owned_by: 'gc',
    capabilities: {
      vision: true,
      pdf: false,
      audioInput: true,
      videoInput: true,
      imageOutput: false,
      audioOutput: false,
      search: true,
      tools: true,
      reasoning: true,
      thinkingFormat: 'gemini-budget',
      thinkingCanDisable: true,
      thinkingRange: { min: 0, max: 24576 },
      contextWindow: 1048576,
      maxOutput: 65536,
    },
  },
  {
    id: 'gc/gemini-3.1-pro-preview',
    object: 'model',
    owned_by: 'gc',
    capabilities: {
      vision: true,
      pdf: false,
      audioInput: true,
      videoInput: true,
      imageOutput: false,
      audioOutput: false,
      search: true,
      tools: true,
      reasoning: true,
      thinkingFormat: 'gemini-level',
      thinkingCanDisable: false,
      thinkingRange: null,
      contextWindow: 1048576,
      maxOutput: 65535,
    },
  },
  {
    id: 'gh/claude-sonnet-4.5',
    object: 'model',
    owned_by: 'gh',
    capabilities: {
      vision: true,
      pdf: false,
      audioInput: false,
      videoInput: false,
      imageOutput: false,
      audioOutput: false,
      search: true,
      tools: true,
      reasoning: true,
      thinkingFormat: 'claude-budget',
      thinkingCanDisable: true,
      thinkingRange: null,
      contextWindow: 200000,
      maxOutput: 64000,
    },
  },
  {
    id: 'ocg/mimo-v2.5',
    object: 'model',
    owned_by: 'ocg',
    capabilities: {
      vision: true,
      pdf: false,
      audioInput: true,
      videoInput: true,
      imageOutput: false,
      audioOutput: false,
      search: false,
      tools: true,
      reasoning: false,
      thinkingFormat: null,
      thinkingCanDisable: true,
      thinkingRange: null,
      contextWindow: 1048576,
      maxOutput: 131072,
    },
  },
  {
    id: 'nvidia/deepseek-ai/deepseek-v4-flash',
    object: 'model',
    owned_by: 'nvidia',
    capabilities: {
      vision: false,
      pdf: false,
      audioInput: false,
      videoInput: false,
      imageOutput: false,
      audioOutput: false,
      search: false,
      tools: true,
      reasoning: true,
      thinkingFormat: 'openai',
      thinkingCanDisable: true,
      thinkingRange: null,
      contextWindow: 1000000,
      maxOutput: 65536,
    },
  },
  {
    id: 'new-slop-api-000/moonshotai/kimi-k3-free',
    object: 'model',
    owned_by: 'new-slop-api-000',
    capabilities: {
      vision: true,
      pdf: false,
      audioInput: false,
      videoInput: true,
      imageOutput: false,
      audioOutput: false,
      search: false,
      tools: true,
      reasoning: true,
      thinkingFormat: 'kimi',
      thinkingCanDisable: false,
      thinkingRange: null,
      contextWindow: 1048576,
      maxOutput: 131072,
    },
  },
  { id: 'random-bs', object: 'model', owned_by: 'combo' },
  { id: 'ixe-fatfuck', object: 'model', owned_by: 'combo' },
  { id: 'test', object: 'model', owned_by: 'combo' },
];

/**
 * The live endpoint currently ships no model with `pdf`, `imageOutput`, or `audioOutput` set,
 * and none with `tools: false`. These synthesize those flags on the live capability shape so the
 * remaining modality/tool mappings are still covered.
 */
const syntheticCapabilityModels = [
  {
    id: 'synthetic/omni-out',
    object: 'model',
    owned_by: 'synthetic',
    capabilities: {
      vision: true,
      pdf: true,
      audioInput: true,
      videoInput: true,
      imageOutput: true,
      audioOutput: true,
      search: true,
      tools: true,
      reasoning: false,
      thinkingFormat: null,
      thinkingCanDisable: false,
      thinkingRange: null,
      contextWindow: 32768,
      maxOutput: 4096,
    },
  },
  {
    id: 'synthetic/no-tools',
    object: 'model',
    owned_by: 'synthetic',
    capabilities: {
      vision: false,
      pdf: false,
      audioInput: false,
      videoInput: false,
      imageOutput: false,
      audioOutput: false,
      search: false,
      tools: false,
      reasoning: false,
      thinkingFormat: null,
      thinkingCanDisable: false,
      thinkingRange: null,
      contextWindow: 8192,
      maxOutput: 1024,
    },
  },
];

const findModel = (id: string) => {
  const model = liveModels.find((candidate) => candidate.id === id);
  if (!model) {
    throw new Error(`fixture is missing ${id}`);
  }
  return model;
};

describe('capabilities-based model metadata', () => {
  let mockClient: any;

  const createPluginContext = () => {
    const testDir = mkdtempSync(join(tmpdir(), 'opencode-openai-compatible-caps-'));
    const cacheHome = join(testDir, 'cache-home');
    const homeDir = join(testDir, 'home');

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

    mkdirSync(join(homeDir, '.config', 'opencode'), { recursive: true });

    return {
      input: {
        project: { name: 'test-project' },
        client: mockClient,
        $: {} as any,
        directory: testDir,
        worktree: testDir,
      },
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

  const respondWith = (models: any[]) =>
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: models }) });

  const registerConfigModels = async (models: any[], endpointOverrides: any = {}) => {
    globalThis.fetch = respondWith(models);
    const context = createPluginContext();
    const plugin = await createPlugin(context.input, {
      providers: [{ ...nineRouterEndpoint, ...endpointOverrides }],
    });

    const cfg: any = {};
    await plugin.config(cfg);
    return { cfg, plugin, context };
  };

  beforeEach(() => {
    mockClient = { app: { log: vi.fn() } };
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('capabilities mapping', () => {
    it('maps contextWindow and maxOutput onto limit.context and limit.output', async () => {
      const { cfg, context } = await registerConfigModels(liveModels);

      try {
        expect(cfg.provider['9router'].models['ocg/glm-5.2'].limit).toEqual({
          context: 200000,
          output: 128000,
        });
        expect(cfg.provider['9router'].models['gc/gemini-2.5-pro'].limit).toEqual({
          context: 1048576,
          output: 65536,
        });
        expect(cfg.provider['9router'].models['gh/claude-sonnet-4.5'].limit).toEqual({
          context: 200000,
          output: 64000,
        });
      } finally {
        context.cleanup();
      }
    });

    it('maps vision, pdf, audioInput, and videoInput onto modalities.input', async () => {
      const { cfg, context } = await registerConfigModels([
        ...liveModels,
        ...syntheticCapabilityModels,
      ]);

      try {
        const models = cfg.provider['9router'].models;

        // text-only: every input flag false
        expect(models['ocg/glm-5.2'].modalities.input).toEqual(['text']);

        // vision + videoInput
        expect(models['ocg/kimi-k2.7-code'].modalities.input).toEqual(['text', 'image', 'video']);

        // vision + audioInput + videoInput
        expect(models['gc/gemini-2.5-pro'].modalities.input).toEqual([
          'text',
          'image',
          'audio',
          'video',
        ]);

        // every input flag, including pdf
        expect(models['synthetic/omni-out'].modalities.input).toEqual([
          'text',
          'image',
          'pdf',
          'audio',
          'video',
        ]);
      } finally {
        context.cleanup();
      }
    });

    it('maps imageOutput and audioOutput onto modalities.output', async () => {
      const { cfg, context } = await registerConfigModels([
        ...liveModels,
        ...syntheticCapabilityModels,
      ]);

      try {
        const models = cfg.provider['9router'].models;

        // The live payload ships no output modality beyond text.
        expect(models['gc/gemini-2.5-pro'].modalities.output).toEqual(['text']);
        expect(models['synthetic/omni-out'].modalities.output).toEqual(['text', 'image', 'audio']);
      } finally {
        context.cleanup();
      }
    });

    it('maps tools onto tool_call', async () => {
      const { cfg, context } = await registerConfigModels([
        ...liveModels,
        ...syntheticCapabilityModels,
      ]);

      try {
        const models = cfg.provider['9router'].models;

        expect(models['ocg/glm-5.2'].tool_call).toBe(true);
        expect(models['synthetic/no-tools'].tool_call).toBe(false);
      } finally {
        context.cleanup();
      }
    });

    it('maps reasoning onto the reasoning flag and reasoning_options', async () => {
      const { cfg, context } = await registerConfigModels(liveModels);

      try {
        const models = cfg.provider['9router'].models;

        expect(models['ocg/glm-5.2'].reasoning).toBe(true);
        expect(models['ocg/glm-5.2'].reasoning_options).toBeDefined();

        // reasoning: false gets no reasoning_options at all
        expect(models['ocg/mimo-v2.5'].reasoning).toBe(false);
        expect(models['ocg/mimo-v2.5'].reasoning_options).toBeUndefined();
      } finally {
        context.cleanup();
      }
    });

    it('ignores the advertised search capability, which has no OpenCode schema slot', async () => {
      const { cfg, context } = await registerConfigModels(liveModels);

      try {
        // `gc/gemini-2.5-pro` advertises `search: true` upstream. It must not leak into the
        // registered model in any form, and must not prevent registration.
        const searchModel = cfg.provider['9router'].models['gc/gemini-2.5-pro'];

        expect(searchModel).toBeDefined();
        expect('search' in searchModel).toBe(false);
        expect(JSON.stringify(searchModel)).not.toContain('search');
      } finally {
        context.cleanup();
      }
    });
  });

  describe('flat legacy fields take precedence over capabilities', () => {
    it('prefers context_length and max_completion_tokens over contextWindow and maxOutput', async () => {
      const legacyOverride = {
        ...findModel('ocg/glm-5.2'),
        context_length: 4096,
        max_completion_tokens: 2048,
      };

      const { cfg, context } = await registerConfigModels([legacyOverride]);

      try {
        expect(cfg.provider['9router'].models['ocg/glm-5.2'].limit).toEqual({
          context: 4096,
          output: 2048,
        });
      } finally {
        context.cleanup();
      }
    });

    it('prefers a flat modalities object over the capability flags', async () => {
      const legacyOverride = {
        ...findModel('gc/gemini-2.5-pro'),
        modalities: { input: ['text'], output: ['text'] },
      };

      const { cfg, context } = await registerConfigModels([legacyOverride]);

      try {
        // capabilities advertise vision/audio/video, the flat field says text-only and wins
        expect(cfg.provider['9router'].models['gc/gemini-2.5-pro'].modalities).toEqual({
          input: ['text'],
          output: ['text'],
        });
      } finally {
        context.cleanup();
      }
    });

    it('lets custom_reasoning: false override capabilities.reasoning: true', async () => {
      const legacyOverride = {
        ...findModel('ocg/glm-5.2'),
        custom_reasoning: false,
        reasoning_effort: false,
      };

      const { cfg, context } = await registerConfigModels([legacyOverride]);

      try {
        const model = cfg.provider['9router'].models['ocg/glm-5.2'];

        expect(model.reasoning).toBe(false);
        expect(model.reasoning_options).toBeUndefined();
      } finally {
        context.cleanup();
      }
    });

    it('lets reasoning_effort: true override capabilities.reasoning: false', async () => {
      const legacyOverride = {
        ...findModel('ocg/mimo-v2.5'),
        reasoning_effort: true,
      };

      const { cfg, context } = await registerConfigModels([legacyOverride]);

      try {
        const model = cfg.provider['9router'].models['ocg/mimo-v2.5'];

        expect(model.reasoning).toBe(true);
        expect(model.reasoning_options).toBeDefined();
      } finally {
        context.cleanup();
      }
    });
  });

  describe('models without a capabilities key', () => {
    it('registers them with text-only modality defaults', async () => {
      const { cfg, context } = await registerConfigModels(liveModels);

      try {
        const models = cfg.provider['9router'].models;

        for (const id of ['random-bs', 'ixe-fatfuck', 'test']) {
          expect(models[id]).toBeDefined();
          expect(models[id].modalities).toEqual({ input: ['text'], output: ['text'] });
          expect(models[id].reasoning).toBe(false);
          expect(models[id].reasoning_options).toBeUndefined();
          // No capability data at all, so tool support falls back to permissive.
          expect(models[id].tool_call).toBe(true);
        }
      } finally {
        context.cleanup();
      }
    });

    it('falls back to the endpoint default limits', async () => {
      const { cfg, context } = await registerConfigModels(liveModels, {
        contextLimit: 12345,
        outputLimit: 6789,
      });

      try {
        expect(cfg.provider['9router'].models['random-bs'].limit).toEqual({
          context: 12345,
          output: 6789,
        });
      } finally {
        context.cleanup();
      }
    });

    it('registers them through the runtime provider.models hook as well', async () => {
      globalThis.fetch = respondWith(liveModels);
      const context = createPluginContext();

      try {
        const plugin = await createPlugin(context.input, { providers: [nineRouterEndpoint] });
        const models = await plugin.provider.models({} as any, {
          auth: { type: 'api' as const, key: 'test-api-key' },
        });

        expect(models['random-bs']).toBeDefined();
        expect(models['random-bs'].capabilities.input).toEqual({
          text: true,
          audio: false,
          image: false,
          video: false,
          pdf: false,
        });
        expect(models['ixe-fatfuck'].capabilities.reasoning).toBe(false);
        expect(models['test'].capabilities.attachment).toBe(false);
      } finally {
        context.cleanup();
      }
    });
  });

  describe('slash-containing model ids', () => {
    const slashIds = [
      'nvidia/deepseek-ai/deepseek-v4-flash',
      'new-slop-api-000/moonshotai/kimi-k3-free',
    ];

    it('keeps slash ids intact as config model keys and ids', async () => {
      const { cfg, context } = await registerConfigModels(liveModels);

      try {
        const models = cfg.provider['9router'].models;

        for (const id of slashIds) {
          expect(models[id]).toBeDefined();
          expect(models[id].id).toBe(id);
        }

        // The provider key itself is untouched by any model id
        expect(Object.keys(cfg.provider)).toEqual(['9router']);
      } finally {
        context.cleanup();
      }
    });

    it('derives display names from slash ids without splitting them', async () => {
      const { cfg, context } = await registerConfigModels(liveModels);

      try {
        const models = cfg.provider['9router'].models;

        // No upstream `name`, so the full id becomes the display name. The trailing `-flash`
        // is a known variant suffix and gets title-cased onto the end.
        expect(models['nvidia/deepseek-ai/deepseek-v4-flash'].name).toBe(
          'nvidia/deepseek-ai/deepseek-v4-flash Flash'
        );
        expect(models['new-slop-api-000/moonshotai/kimi-k3-free'].name).toBe(
          'new-slop-api-000/moonshotai/kimi-k3-free'
        );
      } finally {
        context.cleanup();
      }
    });

    it('keeps slash ids and their metadata across a cache round-trip', async () => {
      globalThis.fetch = respondWith(liveModels);
      const context = createPluginContext();

      try {
        const firstPlugin = await createPlugin(context.input, { providers: [nineRouterEndpoint] });
        const firstConfig: any = {};
        await firstPlugin.config(firstConfig);

        const cachePath = context.cachePathFor('9router');
        const cachedPayload = JSON.parse(readFileSync(cachePath, 'utf8')) as {
          models: Array<{ id: string }>;
        };
        expect(cachedPayload.models.map((model) => model.id)).toEqual(
          expect.arrayContaining(slashIds)
        );

        // Second run reads the fresh cache instead of the network...
        globalThis.fetch = vi.fn();
        const secondPlugin = await createPlugin(context.input, { providers: [nineRouterEndpoint] });
        const secondConfig: any = {};
        await secondPlugin.config(secondConfig);

        expect(globalThis.fetch).not.toHaveBeenCalled();

        // ...and the slash-id models survive it byte for byte.
        for (const id of slashIds) {
          expect(secondConfig.provider['9router'].models[id]).toEqual(
            firstConfig.provider['9router'].models[id]
          );
        }
      } finally {
        context.cleanup();
      }
    });

    it('keeps slash ids intact in the runtime provider.models registry', async () => {
      globalThis.fetch = respondWith(liveModels);
      const context = createPluginContext();

      try {
        const plugin = await createPlugin(context.input, { providers: [nineRouterEndpoint] });
        const models = await plugin.provider.models({} as any, {
          auth: { type: 'api' as const, key: 'test-api-key' },
        });

        for (const id of slashIds) {
          expect(models[id]).toBeDefined();
          expect(models[id].id).toBe(id);
          expect(models[id].api.id).toBe(id);
          expect(models[id].providerID).toBe('9router');
        }

        expect(models['nvidia/deepseek-ai/deepseek-v4-flash'].limit).toEqual({
          context: 1000000,
          output: 65536,
        });
      } finally {
        context.cleanup();
      }
    });
  });

  describe('thinking controls', () => {
    it('adds a disabled level for thinkingCanDisable: true', async () => {
      const { cfg, context } = await registerConfigModels(liveModels);

      try {
        // `null` is OpenCode's "reasoning off" effort value and must come first.
        expect(cfg.provider['9router'].models['ocg/glm-5.2'].reasoning_options).toEqual([
          { type: 'effort', values: [null, 'low', 'medium', 'high'] },
        ]);
      } finally {
        context.cleanup();
      }
    });

    it('omits the disabled level for thinkingCanDisable: false', async () => {
      const { cfg, context } = await registerConfigModels(liveModels);

      try {
        expect(cfg.provider['9router'].models['ocg/kimi-k2.7-code'].reasoning_options).toEqual([
          { type: 'effort', values: ['low', 'medium', 'high'] },
        ]);
        expect(
          cfg.provider['9router'].models['gc/gemini-3.1-pro-preview'].reasoning_options
        ).toEqual([{ type: 'effort', values: ['low', 'medium', 'high'] }]);
      } finally {
        context.cleanup();
      }
    });

    it('exposes a none variant for thinkingCanDisable: true in the runtime hook', async () => {
      globalThis.fetch = respondWith(liveModels);
      const context = createPluginContext();

      try {
        const plugin = await createPlugin(context.input, { providers: [nineRouterEndpoint] });
        const models = await plugin.provider.models({} as any, {
          auth: { type: 'api' as const, key: 'test-api-key' },
        });

        // camelCase `reasoningEffort` is what `@ai-sdk/openai-compatible` serializes into the
        // `reasoning_effort` request field; a snake_case key here is dropped.
        expect(models['ocg/glm-5.2'].variants).toEqual({
          none: { reasoningEffort: 'none' },
          low: { reasoningEffort: 'low' },
          medium: { reasoningEffort: 'medium' },
          high: { reasoningEffort: 'high' },
        });

        expect(models['ocg/kimi-k2.7-code'].variants).toEqual({
          low: { reasoningEffort: 'low' },
          medium: { reasoningEffort: 'medium' },
          high: { reasoningEffort: 'high' },
        });
      } finally {
        context.cleanup();
      }
    });

    it('reduces thinkingRange budget models to discrete effort levels', async () => {
      const { cfg, context } = await registerConfigModels(liveModels);

      try {
        const budgetModel = cfg.provider['9router'].models['gc/gemini-2.5-pro'];

        // Upstream advertises thinkingFormat: 'gemini-budget' with thinkingRange 0..24576.
        // OpenCode's reasoning_options budget_tokens form is not usable through
        // `@ai-sdk/openai-compatible`, so the range is intentionally dropped and the model is
        // registered with effort levels only (plus the disabled level it allows).
        expect(budgetModel.reasoning).toBe(true);
        expect(budgetModel.reasoning_options).toEqual([
          { type: 'effort', values: [null, 'low', 'medium', 'high'] },
        ]);
        expect(JSON.stringify(budgetModel)).not.toContain('budget_tokens');
        expect(JSON.stringify(budgetModel)).not.toContain('thinkingRange');
      } finally {
        context.cleanup();
      }
    });

    it('treats claude-budget the same way as any other effort-only model', async () => {
      const { cfg, context } = await registerConfigModels(liveModels);

      try {
        expect(cfg.provider['9router'].models['gh/claude-sonnet-4.5'].reasoning_options).toEqual([
          { type: 'effort', values: [null, 'low', 'medium', 'high'] },
        ]);
      } finally {
        context.cleanup();
      }
    });

    it('never exposes reasoning levels for a non-reasoning model that can disable thinking', async () => {
      const { cfg, context } = await registerConfigModels(liveModels);

      try {
        // `ocg/mimo-v2.5` reports thinkingCanDisable: true alongside reasoning: false.
        // Reasoning support gates everything, so no levels are advertised.
        const model = cfg.provider['9router'].models['ocg/mimo-v2.5'];

        expect(model.reasoning).toBe(false);
        expect(model.reasoning_options).toBeUndefined();
      } finally {
        context.cleanup();
      }
    });
  });
});
