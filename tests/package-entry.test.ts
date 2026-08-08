import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

describe('package entrypoints', () => {
  it('exports only the plugin module from the package root', async () => {
    const mod = await import('../src/index.ts');

    expect(Object.keys(mod).sort()).toEqual(['default']);
    expect(mod.default.id).toBe('@tretrauit/opencode-openai-compatible');
    expect(typeof mod.default.server).toBe('function');
  });

  it('exports reusable helpers from the factory subpath', async () => {
    const mod = await import('../src/factory.ts');

    expect(Object.keys(mod).sort()).toEqual([
      'DEFAULT_CACHE_TTL_MS',
      'buildVariantDisplayName',
      'createOpenAICompatiblePlugin',
      'createReasoningVariants',
      'normalizeCacheTtlMs',
      'readModelCacheEntry',
      'resolveModelsWithCacheFallback',
    ]);
  });

  it('does not publish broken or self-referential package metadata', () => {
    const testDir = dirname(fileURLToPath(import.meta.url));
    const packageJson = JSON.parse(readFileSync(join(testDir, '..', 'package.json'), 'utf8'));

    expect(packageJson.exports['./plugin']).toBeUndefined();
    expect(packageJson.exports['./factory'].import).toBe('./dist/factory.js');
    expect(packageJson.dependencies).toBeUndefined();
  });
});
