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

`@tretrauit/opencode-openai-compatible` registers every user-configured OpenAI-compatible endpoint from the
`opencode-openai-compatible.json` config file (or the legacy `opencode.json` `plugin` options
tuple). It discovers models via `GET {baseURL}/models`, caches them per endpoint, refreshes
caches in the background, and normalizes variant display names (Lightning, Precision, Flash, ...)
without duplicate suffixes.

### Configuration

Endpoints are configured in a separate `opencode-openai-compatible.json` file, either next to
the global `opencode.json` (usually `~/.config/opencode/`) or in a project directory:

```json
{
  "primary": "crofai",
  "providers": [
    {
      "id": "crofai",
      "name": "CrofAI",
      "baseURL": "https://crof.ai/v1",
      "apiKey": "{env:CROFAI_API_KEY}"
    }
  ]
}
```

Resolution order (each candidate is checked as `.json`, then `.jsonc`; first existing, readable,
parseable file wins; duplicates deduplicated):

1. `OPENCODE_OPENAI_COMPATIBLE_CONFIG` env var (explicit path)
2. `<input.directory>/opencode-openai-compatible.json`
3. `<input.directory>/.opencode/opencode-openai-compatible.json`
4. `<input.worktree>/opencode-openai-compatible.json` (if distinct)
5. `<input.worktree>/.opencode/opencode-openai-compatible.json` (if distinct)
6. `$OPENCODE_CONFIG_DIR/opencode-openai-compatible.json` (if set)
7. `$XDG_CONFIG_HOME/opencode/opencode-openai-compatible.json` (if set)
8. `homedir()/.config/opencode/opencode-openai-compatible.json`
9. `%APPDATA%\opencode\...` and `%LOCALAPPDATA%\opencode\...` (if set)
10. legacy `opencode.json` plugin options tuple (fallback)

The file schema is identical to the options object. See `README.md` for the full options
reference.

### Current Behavior

- Endpoint config loaded from `opencode-openai-compatible.json` (or `.jsonc`) found in the
  project directory, project/worktree `.opencode/` subdirectories, or the global OpenCode config
  directory, or from an explicit file path via the `OPENCODE_OPENAI_COMPATIBLE_CONFIG` env var;
  the `opencode.json` plugin options tuple remains a fallback when no config file exists
- `{env:NAME}` placeholders in `apiKey` and header values are expanded by the plugin at startup
  (NOT passed through literally). A missing or empty variable logs `[ERROR]` naming the variable
  and the provider is registered without the key; the raw placeholder is never sent as a
  credential. Literal keys are unchanged
- Config-hook model discovery uses the RESOLVED endpoint key (env-expanded) so authenticated
  model fetches do not fail with an empty key
- Empty model lists are never written to cache, and a cached file with `models: []` is treated
  as missing (refetch instead of registering an empty provider)
- Plugin config parsing is JSONC-tolerant: `//` comments, `/* */` comments, and trailing commas
  are stripped by a character scanner that preserves comment-looking text inside JSON strings
  (e.g. `https://...`). The model cache parser is strict JSON and must stay that way
- When no config file resolves, all attempted candidate paths are logged, followed by the
  existing "plugin inactive" warning
- Model list fetched from `GET {baseURL}/models` per endpoint
- Model cache stored in OpenCode cache under `.cache/{id}-models.json` by default
- All endpoints registered through the `config` hook by populating
  `outputConfig.provider[endpointId]` (works on OpenCode `1.14.31+`); models are written eagerly
  (fetched/cached before the provider entry is returned)
- `provider.models()` runtime hook runs for the PRIMARY endpoint only (backward compatibility
  for OpenCode `≤1.14.30` and catalog providers)
- `auth` hook targets the PRIMARY endpoint only; other endpoints use `apiKey` from options
- Model cache is TTL-bound (`cacheTtlMs`, default `300000`); a fresh cache registers without a
  fetch, an expired cache triggers discovery in the SAME run, and an expired cache is still used
  as an offline fallback when discovery fails. See "Model Cache TTL" below
- Cached models continue to work if the endpoint is unavailable
- Model metadata is read from either the `capabilities` object or the flat legacy fields; flat
  fields win. See "Model Metadata / capabilities" below
- Reasoning-capable models expose `low`, `medium`, and `high` levels, plus a disabled level when
  `capabilities.thinkingCanDisable` is true

### Model Cache TTL

- `cacheTtlMs` is per endpoint. Absent or non-finite falls back to `DEFAULT_CACHE_TTL_MS`
  (`300000`). `0` means never register from cache. Negative values clamp to `0`
- Freshness is `age < ttl`. A cache exactly AT the TTL is expired. `normalizeCacheTtlMs` is the
  single normalization point; do not re-derive the clamp elsewhere
- `readModelCacheEntry` returns `{ models, fetchedAt, expired }` and applies NO policy;
  `readModelCache` is the freshness-filtered wrapper. `resolveModelsWithCacheFallback` owns the
  policy: fresh cache wins outright, otherwise fetch, and on fetch failure fall back to an
  expired cache (propagating the error only when there is no cache at all)
- STALE-FALLBACK RULE: expiry means "don't register without checking", not "discard". Never make
  an expired cache unusable on the failure path — an unreachable endpoint must keep its
  previously known models
- Why the TTL exists: without it, a model added upstream only appeared after the SECOND restart.
  The first restart registered the cached list and merely refreshed in the background
- `writeModelCache` refuses empty lists AND skips writes when the on-disk `fetchedAt` is newer
  than the incoming one, so a slow background refresh cannot clobber a fresher list

### Model Metadata / `capabilities`

Upstream `GET /models` entries carry a `capabilities` object. Observed live schema (89 models):

```json
{
  "vision": false, "pdf": false, "audioInput": false, "videoInput": false,
  "imageOutput": false, "audioOutput": false, "search": false, "tools": true,
  "reasoning": true, "thinkingFormat": "zai", "thinkingCanDisable": true,
  "thinkingRange": null, "contextWindow": 200000, "maxOutput": 128000
}
```

Mapping into the OpenCode model schema:

- `contextWindow` -> `limit.context`, `maxOutput` -> `limit.output`
- `vision`/`pdf`/`audioInput`/`videoInput` -> `modalities.input` (always starts with `text`)
- `imageOutput`/`audioOutput` -> `modalities.output` (always starts with `text`)
- `tools` -> `tool_call`; `reasoning` -> `reasoning` + `reasoning_options`
- `thinkingCanDisable: true` -> prepends `null` to the effort values (the "off" level)

PRECEDENCE: flat legacy fields beat `capabilities`. `context_length`, `max_completion_tokens`,
`modalities`, `supports_tool_calls` override their capability equivalents. `custom_reasoning` and
`reasoning_effort` are checked as a PAIR — if either is present they alone decide reasoning
support and `capabilities.reasoning` is ignored entirely.

Models with NO `capabilities` key (live: `random-bs`, `ixe-fatfuck`, `test`) must still register,
falling back to `{input:['text'],output:['text']}`, `reasoning: false`, `tool_call: true`, and the
endpoint's default limits.

Model ids containing slashes are common (live: 86 of 89, e.g.
`nvidia/deepseek-ai/deepseek-v4-flash`). They must survive verbatim as config model keys, `id`,
`api.id`, display names, and cache round-trips. Never split a model id on `/`.

`search` HAS NO SCHEMA SLOT. Upstream advertises `capabilities.search` on ~40 models
(86 of 89 carry the key), but the real OpenCode model schema has no field for it. It is
deliberately NOT parsed, NOT plumbed, and NOT kept as inert metadata. Do not add it back.

### Reasoning Options (OpenCode 1.18.15)

Real OpenCode model schema:

```
{id, name, family?, release_date, attachment, reasoning, temperature, tool_call,
 reasoning_options?, interleaved?, cost?, limit{context,input?,output}, modalities?,
 experimental?, status?, provider?}
```

- 1.18.15 derives selectable reasoning variants from `reasoning_options`. A `variants` key in a
  config-hook model is DISCARDED by that schema
- `reasoning_options` is a union: `effort{values}` | `toggle` | `budget_tokens{min?,max?}`
- The runtime `provider.models()` hook (OpenCode `≤1.14.30`) still uses `variants`, and the
  effort value MUST be camelCase `reasoningEffort`. snake_case `reasoning_effort` is actively
  broken for `@ai-sdk/openai-compatible`: the option object is spread and then overwritten with
  `undefined`, so the setting silently vanishes
- THINKING FORMAT LIMITATION: budget formats are not expressible. Live `thinkingFormat` values
  include `gemini-budget` and `claude-budget` with a `thinkingRange` (e.g. `{min:0,max:24576}`),
  but the `budget_tokens` form does not survive the `@ai-sdk/openai-compatible` mapping (the
  budget mapper returns undefined). Those models are registered with discrete effort levels only
  and the range is intentionally dropped
- Reasoning levels are per format via `REASONING_LEVELS_BY_FORMAT` in
  `src/openai-compatible-plugin.ts`: `openai` -> low/medium/high/xhigh; `claude-budget` and
  `claude-adaptive` -> low/medium/high/max; `gemini-level`, `gemini-budget`, `zai`, `kimi`,
  `deepseek`, `minimax`, `qwen` -> low/medium/high; unknown or null -> `DEFAULT_LEVELS`
- The `xhigh` and `max` levels are an ACCEPTED, UNVERIFIED assumption: they were never probed
  against upstream, and the risk was explicitly accepted — do not re-litigate or probe to confirm

### Duplicate `/connect` Entry: DISPROVEN

A reported duplicate provider entry in `/connect` was NOT caused by this plugin registering
itself twice. Evidence: `GET /provider/auth` lists `9router` exactly ONCE. The second entry was
the user's own hand-written `self-hosted` provider in `opencode.json` pointing at the same
backend. OpenCode additionally dedupes by `Object.hasOwn(D.existingProviders,E)`, so a plugin
auth entry cannot double-register. The speculative conditional-auth change made to "fix" this was
REVERTED and must stay reverted.

### Architecture

- `src/plugin.ts` - multi-endpoint plugin server (`createOpenAICompatibleEndpointsPlugin`) and
  endpoint/plugin option types
- `src/openai-compatible-plugin.ts` - shared single-provider factory
  (`createOpenAICompatiblePlugin`) plus reusable module-level helpers
  (`readModelCacheEntry`/`readModelCache`/`writeModelCache`/`resolveModelsWithCacheFallback`/
  `normalizeCacheTtlMs`/`fetchModels`/`buildModelRegistry`/`buildConfigModelRegistry`/
  `buildVariantDisplayName`/`createReasoningVariants`)
- `src/index.ts` - package root entrypoint; exports ONLY the `{ id, server }` plugin module
- `src/factory.ts` - public factory subpath entrypoint for reusable helper exports
- `src/logger.ts` - optional debug logger
- The factory (`src/openai-compatible-plugin.ts`) intentionally retains a log-only `chat.params`
  hook for fork back-compat; the multi-endpoint plugin (`src/plugin.ts`) omits it.

Package exports:

- `@tretrauit/opencode-openai-compatible` - root plugin entrypoint, module default export only
- `@tretrauit/opencode-openai-compatible/server` - OpenCode server entrypoint, same dist file as root
- `@tretrauit/opencode-openai-compatible/factory` - reusable factory/helper entrypoint

Factory exports available from `@tretrauit/opencode-openai-compatible/factory`:

- `createOpenAICompatiblePlugin`
- `buildVariantDisplayName`
- `createReasoningVariants`
- `DEFAULT_CACHE_TTL_MS` / `normalizeCacheTtlMs`
- `readModelCacheEntry` / `resolveModelsWithCacheFallback`
- `ModelCacheEntry` type
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

OpenCode `1.18.15` still loads this plugin from the `{ id, server }` default export. Its
server-side loader (`kind: "server"`) accepts three shapes, in this order: a default export
object with a `server()` function, a plain default-exported function, and named function
exports. Verified against the shipped 1.18.15 binary:

```js
function rQ(q,$,J,Q="strict"){let W=q.default;
  if(!b(W)){if(Q==="detect")return; throw TypeError(`Plugin ${$} must default export an object with ${J}()`)}
  if(Q==="detect"&&!("id"in W)&&!("server"in W)&&!("tui"in W))return;
  ...
  if(J==="server"&&Z===void 0)throw TypeError(`Plugin ${$} must default export an object with server()`)}
```

Separately, OpenCode also decodes `plugin` entries against the newer config-plugin schema:

```js
var gs=t.Struct({default:t.Union([
  t.Struct({id:t.String,effect:t.declare((o)=>typeof o==="function")}),
  t.Struct({id:t.String,setup:t.declare((o)=>typeof o==="function")})])});
```

A `SchemaError(Missing key at ["default"]["effect"] / ["default"]["setup"])` WARN logged for a
plugin is emitted by that second path and is NOT fatal — plugins that only export
`{ id, server }` (including `opencode-pty` and this one) still load and run. Do NOT add
`effect`/`setup` keys to satisfy that warning: `setup`-only modules are rejected by the server
loader with "must default export an object with server()". This was confirmed by probing the
real 1.18.15 binary with four module shapes; `{id,server}`, plain function, and named `server`
all loaded, while `{id,setup}` failed.

### Development

Run `bun test` for the test suite located in `tests/`. Build with `bun run build`.

### References

- OpenCode plugin docs: https://opencode.ai/docs/plugins/
