# AGENTS.md

## Build & Test Commands

- **Build**: `bun run build` or `bun build src/index.ts src/factory.ts --outdir dist --target bun`
- **Test**: `bun test` or `bun test tests`
- **Single Test**: `bun test tests/plugin.test.ts` (use file glob pattern)
- **Watch Mode**: `bun test --watch`
- **Lint**: `bun run lint` (eslint)
- **Format**: `bun run format` (prettier)

## Code Style Guidelines

### Imports & Module System

- Use ES6 `import`/`export` syntax (module: "ESNext", type: "module")
- Group imports: external libraries first, then internal modules
- Use explicit file extensions (`.ts`) for internal imports

### Formatting (Prettier)

- **Single quotes** (`singleQuote: true`)
- **Line width**: 100 characters
- **Tab width**: 2 spaces
- **Trailing commas**: ES5 (no trailing commas in function parameters)
- **Semicolons**: enabled

### TypeScript & Naming

- **NeverNesters**: avoid deeply nested structures. Always exit early.
- **Strict mode**: enforced (`"strict": true`)
- **Classes**: PascalCase (e.g., `OpenAICompatibleEndpointOptions`)
- **Methods/properties**: camelCase
- **Status strings**: use union types (e.g., `'active' | 'paused'`)
- **Explicit types**: prefer explicit type annotations over inference
- **Return types**: optional (not required but recommended for public functions)

### Error Handling

- Check error type before accessing error properties: `error instanceof Error ? error.toString() : String(error)`
- Log errors with `[ERROR]` prefix for consistency
- Always provide error context when recording output

### Linting Rules

- `@typescript-eslint/no-explicit-any`: warn (avoid `any` type)
- `no-console`: error (minimize console logs)
- `prettier/prettier`: error (formatting violations are errors)

## Testing

- Framework: **vitest** (with `bun test`) using `describe` & `it` blocks
- Style: Descriptive nested test cases with clear expectations
- Assertion library: `expect()` (vitest)

## Memory

- Store temporary data in OpenCode cache under `.cache/`

## Project Context

- **Type**: ES Module package for Bun modules
- **Target**: Bun runtime, ES2021+
- **Purpose**: OpenCode plugin registering one or more configurable OpenAI-compatible endpoints
  as providers, with a reusable single-provider factory for forks

## Multi-Endpoint Plugin

### Overview

`opencode-openai-compatible` registers every user-configured OpenAI-compatible endpoint from the
`opencode.json` `plugin` options tuple. It discovers models via `GET {baseURL}/models`, caches
them per endpoint, refreshes caches in the background, and normalizes variant display names
(Lightning, Precision, Flash, ...) without duplicate suffixes.

### Configuration

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "opencode-openai-compatible",
      {
        "providers": [
          {
            "id": "crofai",
            "name": "CrofAI",
            "baseURL": "https://crof.ai/v1",
            "apiKey": "{env:CROFAI_API_KEY}"
          }
        ]
      }
    ]
  ]
}
```

The tuple form passes the second element verbatim as the plugin's options. See `README.md` for
the full options reference.

### Current Behavior

- Model list fetched from `GET {baseURL}/models` per endpoint
- Model cache stored in OpenCode cache under `.cache/{id}-models.json` by default
- All endpoints registered through the `config` hook by populating
  `outputConfig.provider[endpointId]` (works on OpenCode `1.14.31+`); models are written eagerly
  (fetched/cached before the provider entry is returned)
- `provider.models()` runtime hook runs for the PRIMARY endpoint only (backward compatibility
  for OpenCode `≤1.14.30` and catalog providers)
- `auth` hook targets the PRIMARY endpoint only; other endpoints use `apiKey` from options
- Cached models used immediately on startup when available
- Cache refreshed in background when the primary provider model hook runs
- Cached models continue to work if the endpoint is unavailable
- Reasoning-capable models expose `low`, `medium`, and `high` variants

### Architecture

- `src/plugin.ts` - multi-endpoint plugin server (`createOpenAICompatibleEndpointsPlugin`) and
  endpoint/plugin option types
- `src/openai-compatible-plugin.ts` - shared single-provider factory
  (`createOpenAICompatiblePlugin`) plus reusable module-level helpers
  (`readModelCache`/`writeModelCache`/`fetchModels`/`buildModelRegistry`/
  `buildConfigModelRegistry`/`buildVariantDisplayName`/`createReasoningVariants`)
- `src/index.ts` - package root entrypoint; exports ONLY the `{ id, server }` plugin module
- `src/factory.ts` - public factory subpath entrypoint for reusable helper exports
- `src/logger.ts` - optional debug logger
- The factory (`src/openai-compatible-plugin.ts`) intentionally retains a log-only `chat.params`
  hook for fork back-compat; the multi-endpoint plugin (`src/plugin.ts`) omits it.

Package exports:

- `opencode-openai-compatible` - root plugin entrypoint, module default export only
- `opencode-openai-compatible/server` - OpenCode server entrypoint, same dist file as root
- `opencode-openai-compatible/factory` - reusable factory/helper entrypoint

Factory exports available from `opencode-openai-compatible/factory`:

- `createOpenAICompatiblePlugin`
- `buildVariantDisplayName`
- `createReasoningVariants`
- `OpenAICompatibleModel` type
- `OpenAICompatibleEndpointOptions` / `OpenAICompatibleEndpointAuth` / `OpenAICompatiblePluginOptions` types

Forking a single provider means using `createOpenAICompatiblePlugin` from
`src/openai-compatible-plugin.ts` (or the factory subpath) with a fixed
`providerID`/`providerName`/`baseURL`/auth prompt/cache file.

Do not re-export helpers from `src/index.ts`; OpenCode legacy plugin loading enumerates root
function exports and may treat helpers as plugins, and the module form (`{ id, server }`)
supersedes legacy enumeration.

### OpenCode Compatibility Note

OpenCode `1.14.31` loads plugin auth hooks but runs plugin `provider.models()` before
config-defined custom providers are added to its provider database. Because configured
endpoints are not in OpenCode's built-in models database, the plugin must populate
`outputConfig.provider[id].models` directly in the `config` hook for EVERY endpoint.
Keep package-entry tests and config-model tests when changing exports or provider registration.

### Development

Run `bun test` for the test suite located in `tests/`. Build with `bun run build`.

### References

- OpenCode plugin docs: https://opencode.ai/docs/plugins/
