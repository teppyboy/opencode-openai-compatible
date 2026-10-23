import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

vi.mock('../src/logger.ts', () => ({
  log: vi.fn(),
  initLogger: vi.fn().mockResolvedValue(undefined),
}));

// `bun-types` declares the global `fetch` with a required `preconnect` member, so assigning a
// bare vitest mock to `globalThis.fetch` fails `tsc --noEmit`. Go through a widened alias
// instead of casting at every assignment site.
const testGlobal = globalThis as { fetch: typeof globalThis.fetch | Mock };

const originalFetch = testGlobal.fetch;

const mockModels = [
  {
    id: 'fake-flash',
    name: 'Fake Flash',
    capabilities: {
      vision: true,
      tools: true,
      reasoning: true,
      thinkingFormat: 'openai',
      thinkingCanDisable: true,
      contextWindow: 64000,
      maxOutput: 8000,
    },
    pricing: { prompt: '0.5', completion: '1.5', cache_prompt: '0.05' },
  },
  {
    id: 'nvidia/fake/second',
    name: 'Nested Id Model',
    context_length: 32000,
    max_completion_tokens: 4000,
    pricing: { prompt: '', completion: '' },
  },
];

describe('opencode-openai-compatible V2 plugin', () => {
  const createContext = () => {
    const testDir = mkdtempSync(join(tmpdir(), 'opencode-openai-compatible-v2-test-'));
    const cacheHome = join(testDir, 'cache-home');
    const homeDir = join(testDir, 'home');
    const globalConfigDir = join(homeDir, '.config', 'opencode');

    const envOverrides: Record<string, string | undefined> = {
      XDG_CACHE_HOME: cacheHome,
      HOME: homeDir,
      USERPROFILE: homeDir,
      XDG_CONFIG_HOME: join(homeDir, '.config'),
      APPDATA: join(homeDir, 'AppData', 'Roaming'),
      LOCALAPPDATA: join(homeDir, 'AppData', 'Local'),
      OPENCODE_CONFIG_DIR: undefined,
      OPENCODE_OPENAI_COMPATIBLE_CONFIG: undefined,
      V2_TEST_KEY: undefined,
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

    const added: Array<{ info: any; models: any[] }> = [];
    const reload = vi.fn().mockResolvedValue(undefined);
    const transform = vi.fn(async (fn: (editor: any) => void) => {
      fn({ add: (entry: { info: any; models: any[] }) => added.push(entry) });
    });

    return {
      ctx: {
        app: { log: vi.fn() },
        location: { directory: testDir, project: { canonical: testDir } },
        provider: { transform, reload },
      },
      testDir,
      added,
      reload,
      transform,
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

  const getSetup = async () => {
    const mod = await import('../src/index.ts');
    return (mod.default as any).setup;
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    testGlobal.fetch = originalFetch;
  });

  it('registers providers and models through ctx.provider.transform', async () => {
    testGlobal.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: mockModels }),
    });

    const { ctx, added, cleanup } = createContext();

    try {
      const setup = await getSetup();
      const stop = await setup({
        ...ctx,
        options: {
          providers: [
            {
              id: 'fakeoc',
              name: 'Fake OC',
              baseURL: 'http://127.0.0.1:1/v1',
              apiKey: 'test-key',
              cacheTtlMs: 0,
            },
          ],
        },
      });

      expect(stop).toBeUndefined();
      expect(added).toHaveLength(1);
      expect(added[0].info).toMatchObject({
        id: 'fakeoc',
        name: 'Fake OC',
        activation: 'enabled',
        package: '@opencode/ai/providers/openai-compatible',
        settings: { baseURL: 'http://127.0.0.1:1/v1', apiKey: 'test-key' },
      });

      const [flash, nested] = added[0].models;
      expect(flash).toMatchObject({
        id: 'fake-flash',
        modelID: 'fake-flash',
        providerID: 'fakeoc',
        name: 'Fake Flash',
        capabilities: { tools: true, input: ['text', 'image'], output: ['text'] },
        cost: [{ input: 0.5, output: 1.5, cache: { read: 0.05, write: 0 } }],
        status: 'active',
        enabled: true,
        limit: { context: 64000, output: 8000 },
      });
      // thinkingCanDisable adds the disabled level in front of the effort levels.
      expect(flash.variants.map((variant: any) => variant.id)).toEqual([
        'none',
        'low',
        'medium',
        'high',
      ]);

      // Nested ids survive, flat legacy fields win, and empty prices stay finite.
      expect(nested).toMatchObject({
        id: 'nvidia/fake/second',
        capabilities: { input: ['text'], output: ['text'] },
        cost: [{ input: 0, output: 0 }],
        limit: { context: 32000, output: 4000 },
        variants: [],
      });
    } finally {
      cleanup();
    }
  });

  it('does not transform when no providers are configured', async () => {
    testGlobal.fetch = vi.fn();

    const { ctx, transform, cleanup } = createContext();

    try {
      const setup = await getSetup();
      await setup({ ...ctx, options: {} });

      expect(transform).not.toHaveBeenCalled();
      expect(testGlobal.fetch).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('drops an unset {env:} apiKey instead of sending the placeholder', async () => {
    testGlobal.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: mockModels }),
    });

    const { ctx, added, cleanup } = createContext();

    try {
      const setup = await getSetup();
      await setup({
        ...ctx,
        options: {
          providers: [
            {
              id: 'fakeoc',
              name: 'Fake OC',
              baseURL: 'http://127.0.0.1:1/v1',
              apiKey: '{env:V2_TEST_KEY}',
              cacheTtlMs: 0,
            },
          ],
        },
      });

      expect(added[0].info.settings.apiKey).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('returns a cleanup function that clears the refresh timer', async () => {
    vi.useFakeTimers();

    testGlobal.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: mockModels }),
    });

    const { ctx, reload, cleanup } = createContext();

    try {
      const setup = await getSetup();
      const stop = await setup({
        ...ctx,
        options: {
          providers: [
            { id: 'fakeoc', name: 'Fake OC', baseURL: 'http://127.0.0.1:1/v1', cacheTtlMs: 1000 },
          ],
        },
      });

      expect(typeof stop).toBe('function');

      vi.advanceTimersByTime(60000);
      for (let tick = 0; tick < 20; tick += 1) {
        await Promise.resolve();
      }
      expect(reload).toHaveBeenCalledTimes(1);

      stop();
      vi.advanceTimersByTime(120000);
      for (let tick = 0; tick < 20; tick += 1) {
        await Promise.resolve();
      }
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      cleanup();
    }
  });
});
