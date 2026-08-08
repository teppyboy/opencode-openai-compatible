# @tretrauit/opencode-openai-compatible

OpenCode plugin that registers **one or more configurable OpenAI-compatible endpoints** as
providers. Point it at any API that speaks the OpenAI chat completions / models protocol — a
hosted service like CrofAI or Groq, a local server like LM Studio or llama.cpp, or a self-hosted
gateway.

## What it does

- registers every configured endpoint as an OpenCode provider, each with its own id, name, base
  URL, and API key
- discovers models via `GET {baseURL}/models` for each endpoint
- caches model metadata per endpoint in the OpenCode cache under `.cache/{id}-models.json`
- uses cached models while they are fresh, and refetches once the cache passes its TTL so models
  added on the endpoint show up on the next start rather than the one after
- keeps a stale cache as an offline fallback when an endpoint is unreachable
- reads either the modern `capabilities` object or the older flat model fields
- normalizes variant names like `Lightning` and `Precision` without duplicate suffixes
- exposes `low` / `medium` / `high` reasoning variants for reasoning-capable models, plus a
  disabled level for models that allow turning reasoning off

## Install

### Via OpenCode CLI

```bash
opencode plugin -g @tretrauit/opencode-openai-compatible
```

### Via `opencode.json`

Add the plugin as a bare entry — no options tuple needed:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@tretrauit/opencode-openai-compatible"]
}
```

Endpoint configuration is loaded from a **separate config file** named
`opencode-openai-compatible.json`. Put it next to your global `opencode.json` (usually
`~/.config/opencode/`) to configure endpoints for every project, or in a project directory to
configure that project only:

```json
{
  "primary": "crofai",
  "fetchTimeoutMs": 30000,
  "providers": [
    {
      "id": "crofai",
      "name": "CrofAI",
      "baseURL": "https://crof.ai/v1",
      "apiKey": "{env:CROFAI_API_KEY}"
    },
    {
      "id": "local",
      "name": "Local",
      "baseURL": "http://localhost:1234/v1"
    }
  ]
}
```

With this example you get two providers: `crofai` (with its API key read from the
`CROFAI_API_KEY` environment variable) and `local` (no key). `primary` selects which endpoint
gets the interactive `/connect` auth flow and the runtime provider hook; when omitted the first
provider is used. The config file uses the **same schema** as the plugin options documented
below.

#### Config file resolution

Every candidate below is checked as `.json` first, then `.jsonc`. The first file that exists,
is readable, and parses wins. Duplicate paths are only checked once.

1. `OPENCODE_OPENAI_COMPATIBLE_CONFIG` environment variable — an explicit path to the config
   file. The path may be absolute or relative to the current working directory; on Windows use
   the native path (e.g. `C:\Users\you\.config\opencode\opencode-openai-compatible.json`) or
   forward slashes. If the file is missing or malformed, the plugin logs `[ERROR]` and moves on
   to the next candidate.
2. `<project directory>/opencode-openai-compatible.json`
3. `<project directory>/.opencode/opencode-openai-compatible.json`
4. `<worktree>/opencode-openai-compatible.json` (when the worktree differs from the project
   directory)
5. `<worktree>/.opencode/opencode-openai-compatible.json`
6. `$OPENCODE_CONFIG_DIR/opencode-openai-compatible.json` (when the variable is set)
7. `$XDG_CONFIG_HOME/opencode/opencode-openai-compatible.json` (when the variable is set)
8. `~/.config/opencode/opencode-openai-compatible.json` — **the global config location**
9. `%APPDATA%\opencode\opencode-openai-compatible.json` (Windows, when set)
10. `%LOCALAPPDATA%\opencode\opencode-openai-compatible.json` (Windows, when set)
11. Legacy plugin options (the tuple form below) — used only after every candidate above misses.

When no config file is found, the plugin logs the full list of attempted paths, which is the
fastest way to see where it expected your file.

#### JSONC tolerance

The plugin config file is parsed leniently. `//` line comments, `/* */` block comments, and
trailing commas are all accepted in both `.json` and `.jsonc` files:

```jsonc
{
  // Primary endpoint gets the /connect auth flow
  "primary": "crofai",
  "providers": [
    {
      "id": "crofai",
      "name": "CrofAI",
      "baseURL": "https://crof.ai/v1", // URLs inside strings are never treated as comments
    },
  ],
}
```

This tolerance applies **only** to this plugin's config file. The model cache is still parsed as
strict JSON.

#### Legacy tuple options

The tuple form still works when no config file exists — the second element is passed verbatim
to the plugin as its options:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "@tretrauit/opencode-openai-compatible",
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

## Options

The plugin options object is the second element of the `plugin` tuple — or the top-level
fields of `opencode-openai-compatible.json`. Both use the same schema; a config file holds the
same fields as the options object.

| Option | Type | Default | Description |
| ------ | ---- | ------- | ----------- |
| `providers` | `OpenAICompatibleEndpointOptions[]` | `[]` | Endpoints to register. If empty, the plugin is inactive. |
| `primary` | `string` | first provider's `id` | Provider id that receives the runtime `provider.models()` hook and the `/connect` auth hook. |
| `fetchTimeoutMs` | `number` | `30000` | Timeout for each `GET {baseURL}/models` request. |

### `providers[]` endpoint options

| Option | Type | Default | Description |
| ------ | ---- | ------- | ----------- |
| `id` | `string` | — (required) | Provider id, e.g. `crofai`. Must be unique across endpoints. |
| `name` | `string` | — (required) | Display name, e.g. `CrofAI`. |
| `baseURL` | `string` | — (required) | Base URL of the OpenAI-compatible API, e.g. `https://crof.ai/v1`. |
| `apiKey` | `string` | — | API key injected into the provider's `options.apiKey`. A `{env:MY_API_KEY}` placeholder is expanded from the environment when the plugin starts; if the variable is unset or empty the plugin logs `[ERROR]` and registers the provider without the key (it never sends the raw placeholder as a credential). A literal value is used as-is. |
| `headers` | `Record<string, string>` | — | Extra headers injected into the provider's `options.headers`. |
| `auth` | `OpenAICompatibleEndpointAuth` | — | Overrides for the primary endpoint's `/connect` auth method (`label`, `placeholder`, `message`). |
| `cacheFile` | `string` | `{id}-models.json` | Cache file name under `.cache/`. |
| `cacheTtlMs` | `number` | `300000` (5 min) | How long a cached model list may be used to register this endpoint. See [Model cache TTL](#model-cache-ttl). |
| `modelEndpoint` | `string` | `/models` | Path appended to `baseURL` for model discovery. |
| `npm` | `string` | `@ai-sdk/openai-compatible` | Provider npm package reported to OpenCode. |
| `contextLimit` | `number` | `202752` | Default context limit when a model doesn't report one. |
| `outputLimit` | `number` | `202752` | Default output limit when a model doesn't report one. |
| `family` | `string` | `unknown` | Default model family. |

## Auth

- The **primary** endpoint gets the interactive `/connect` API-key auth flow (`type: 'api'`,
  key `key`). The returned key is injected as `Authorization: Bearer <key>` on requests.
- **Other** endpoints use `apiKey` from the endpoint config (plugin options or the config
  file) instead — either an environment placeholder (`{env:...}`) or a literal value. They
  don't need `/connect`.
- `{env:...}` placeholders are expanded by this plugin at startup, before any model request is
  made. A missing or empty variable is reported with `[ERROR]` and the provider is registered
  without a key rather than sending the literal placeholder.

## Model cache TTL

Each endpoint's discovered model list is cached under the OpenCode cache directory. The cache has
a time-to-live, controlled per endpoint by `cacheTtlMs`:

| `cacheTtlMs` | Behavior |
| ------------ | -------- |
| absent / not a finite number | Defaults to `300000` (5 minutes). |
| `> 0` | The cache registers models while `age < cacheTtlMs`. |
| `0` | Never register from the cache — always fetch fresh. |
| negative | Clamped to `0`, i.e. always fetch fresh. |

A cache whose age is **exactly** the TTL counts as expired: freshness requires `age < ttl`.

**Why this matters:** without a TTL, a model added on your endpoint only appeared after the
*second* restart — the first restart registered the old cached list, and only refreshed it in the
background for next time. With the TTL, an expired cache triggers discovery during the same
startup, so a newly added model is selectable immediately.

**Stale cache is still an offline fallback.** Expiry only means "don't register from this without
checking". If discovery then fails (endpoint down, network gone, bad key), the expired list is
used anyway so your provider keeps its previously known models instead of collapsing to zero. If
there is no cache at all, the discovery error propagates.

Two further guarantees:

- an empty model list is never written to the cache, and a cache file containing `models: []` is
  treated as missing, so a transient "no models" answer can't poison the cache
- a cache write is skipped when the on-disk list is *newer* than the list being written, so a slow
  background refresh can't overwrite a fresher result

## Model metadata

Model metadata is read from `GET {baseURL}/models`. Two shapes are supported, and **flat fields
always win over the `capabilities` object** when both are present.

### `capabilities` object

```json
{
  "id": "gc/gemini-2.5-pro",
  "capabilities": {
    "vision": true,
    "pdf": false,
    "audioInput": true,
    "videoInput": true,
    "imageOutput": false,
    "audioOutput": false,
    "tools": true,
    "reasoning": true,
    "thinkingFormat": "gemini-budget",
    "thinkingCanDisable": true,
    "thinkingRange": { "min": 0, "max": 24576 },
    "contextWindow": 1048576,
    "maxOutput": 65536
  }
}
```

| Capability | Maps to |
| ---------- | ------- |
| `contextWindow` | `limit.context` |
| `maxOutput` | `limit.output` |
| `vision` | `modalities.input` += `image` |
| `pdf` | `modalities.input` += `pdf` |
| `audioInput` | `modalities.input` += `audio` |
| `videoInput` | `modalities.input` += `video` |
| `imageOutput` | `modalities.output` += `image` |
| `audioOutput` | `modalities.output` += `audio` |
| `tools` | `tool_call` |
| `reasoning` | `reasoning` + `reasoning_options` |
| `thinkingCanDisable` | adds the "reasoning off" level |

`modalities.input` and `modalities.output` always start with `text`.

### Flat fields (take precedence)

`context_length`, `max_completion_tokens`, `modalities`, `custom_reasoning`, `reasoning_effort`,
`supports_tool_calls`, `family`, `name`, and `pricing` are read directly and override the
equivalent capability. `custom_reasoning` / `reasoning_effort` are checked as a pair: if either is
present, they alone decide reasoning support and `capabilities.reasoning` is ignored.

### Models with no metadata

A model that reports neither `capabilities` nor flat fields still registers. It falls back to
`{ input: ['text'], output: ['text'] }`, `reasoning: false`, `tool_call: true`, and the
endpoint's `contextLimit` / `outputLimit` defaults.

### Unsupported: `search`

Some endpoints advertise a `capabilities.search` flag (on the reference endpoint: 86 of 89 models
carry the key, 40 with `true`). The OpenCode model schema has **no field for it**, so the plugin
ignores it entirely rather than inventing a slot. Unknown capability keys never block
registration.

## Reasoning

Reasoning-capable models are registered with `reasoning_options`, which is what OpenCode 1.18.15
uses to build selectable reasoning levels:

```json
{ "reasoning_options": [{ "type": "effort", "values": ["low", "medium", "high"] }] }
```

- models with `thinkingCanDisable: true` get `null` prepended, giving a "reasoning off" level
- the runtime `provider.models()` hook (for OpenCode ≤ 1.14.30) exposes the same levels as
  `variants`, using the **camelCase** `reasoningEffort` key — `@ai-sdk/openai-compatible`
  serializes that into the `reasoning_effort` request field. A snake_case key there is silently
  dropped

**Budget-style thinking is not expressible.** Endpoints that report `thinkingFormat` values like
`gemini-budget` or `claude-budget` with a `thinkingRange` are still registered with discrete
effort levels only. OpenCode's `budget_tokens` form of `reasoning_options` does not survive the
`@ai-sdk/openai-compatible` mapping, so the range is intentionally dropped.

## Behavior notes

- **OpenCode 1.14.31+**: all endpoints are registered by mutating `outputConfig.provider[id]`
  in the `config` hook, eagerly (models are fetched/cached before the provider entry is
  written). This is the only reliable registration path for providers that aren't in OpenCode's
  built-in models database.
- **OpenCode ≤ 1.14.30 / catalog providers**: the primary endpoint also exposes a runtime
  `provider.models()` hook that returns the same model registry, cache-first with background
  refresh.
- Each endpoint's model cache is written under the OpenCode cache directory:
  `~/.cache/opencode/.cache/{cacheFile}` (or `$LOCALAPPDATA/opencode` on Windows, or
  `$XDG_CACHE_HOME/opencode` when set).
- Empty model lists are never cached. A stale cache file containing zero models is ignored
  and treated as missing, so the plugin refetches instead of registering an empty provider.
- **OpenCode 1.18.15 plugin loading**: the package default export remains the classic
  `{ id, server }` module. OpenCode 1.18 keeps loading that shape for entries in the `plugin`
  array (the loader accepts `{ id, server }` objects, plain default functions, and named
  `server` exports). OpenCode also probes the newer `{ id, effect }` / `{ id, setup }`
  config-plugin schema for the same entries; a `SchemaError` logged against a plugin while
  both schemas are tried is benign — the legacy loader that actually registers this plugin's
  `config`/`provider`/`auth` hooks still runs it. The extra keys are not needed for 1.18.15.
- The config hook merges discovered models with any models you defined yourself for the same
  provider id — your explicit config models win.
- User-provided provider fields (e.g. `env`, `blacklist`, `whitelist`) are preserved.
- Reasoning-capable models (via `capabilities.reasoning`, or the flat `custom_reasoning` /
  `reasoning_effort` fields) get `low`, `medium`, and `high` levels, plus a disabled level when
  the endpoint reports `thinkingCanDisable`. See [Reasoning](#reasoning).

## Local development

```bash
git clone <your-fork-url>
cd opencode-openai-compatible
bun install
bun run build
```

Point OpenCode at the built plugin:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["./dist/index.js"]
}
```

## Development

```bash
bun run build
bun test
bun run lint
bun run format
```

## Links

- OpenCode plugin docs: https://opencode.ai/docs/plugins/
- OpenCode config docs: https://opencode.ai/docs/config/

## License

See the [LICENSE](LICENSE) file for details.
