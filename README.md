# @tretrauit/opencode-openai-compatible

Registers one or more OpenAI-compatible endpoints as OpenCode providers. Any API that speaks the
OpenAI chat completions and models protocol works: CrofAI, Groq, a local LM Studio or llama.cpp
server, a self-hosted gateway.

## What it does

- registers every configured endpoint as an OpenCode provider with its own id, name, base URL and
  API key
- works on OpenCode v1 (config, provider and auth hooks) and v2 (`setup()` with
  `ctx.provider.transform`)
- discovers models from `GET {baseURL}/models` for each endpoint
- caches model metadata per endpoint in the OpenCode cache at `.cache/{id}-models.json`
- registers cached models while they are fresh and refetches once the cache passes its TTL, so a
  model added on the endpoint shows up on the next start
- falls back to a stale cache when an endpoint is unreachable
- reads either the `capabilities` object or the older flat model fields
- normalizes variant names such as `Lightning` and `Precision` without duplicate suffixes
- exposes `low`, `medium` and `high` reasoning variants for reasoning-capable models, and a
  disabled level for models that allow turning reasoning off

## Install

### Via OpenCode CLI

```bash
opencode plugin -g @tretrauit/opencode-openai-compatible
```

### Via `opencode.json`

OpenCode v1 reads the `plugin` key. A bare entry is enough:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@tretrauit/opencode-openai-compatible"]
}
```

OpenCode v2 reads the plural `plugins` key and calls the plugin's `setup()`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@tretrauit/opencode-openai-compatible"]
}
```

One package serves both. The default export has `server` for v1 and `setup` for v2; what differs
on v2 is under [Behavior notes](#behavior-notes).

Endpoint configuration lives in a separate file, `opencode-openai-compatible.json`. Put it next
to your global `opencode.json` (usually `~/.config/opencode/`) to share endpoints across projects,
or in a project directory to configure that project alone:

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

This example registers two providers: `crofai`, whose key comes from the `CROFAI_API_KEY`
environment variable, and `local`, which has no key. On v1, `primary` picks the endpoint that gets
the interactive `/connect` flow and the runtime provider hook; without it the first provider is
used. On v2 there is no `/connect` and `primary` does nothing, since every endpoint is registered,
so give each endpoint an `apiKey` (literal or `{env:...}`) in this file. The file accepts the same
schema as the plugin options below.

#### Config file resolution

Each candidate is checked as `.json` first, then `.jsonc`. The first file that exists, is readable
and parses wins. Paths are deduplicated.

1. The `OPENCODE_OPENAI_COMPATIBLE_CONFIG` environment variable, an explicit path to the config
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
8. `~/.config/opencode/opencode-openai-compatible.json`, the global config location
9. `%APPDATA%\opencode\opencode-openai-compatible.json` (Windows, when set)
10. `%LOCALAPPDATA%\opencode\opencode-openai-compatible.json` (Windows, when set)
11. Legacy plugin options (the tuple form below), used only after every candidate above misses.

If nothing is found, the plugin logs every path it tried. That list is the quickest way to see
where the file was expected.

#### JSONC tolerance

Line comments (`//`), block comments (`/* */`) and trailing commas are accepted in both `.json`
and `.jsonc` files:

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

Only this plugin's config file is lenient. The model cache is still parsed as strict JSON.

#### Legacy tuple options

The tuple form still works when no config file exists. The second element is passed to the plugin
as its options:

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

The options object is the second element of the `plugin` tuple, or the top level of
`opencode-openai-compatible.json`. Both use the same schema.

| Option | Type | Default | Description |
| ------ | ---- | ------- | ----------- |
| `providers` | `OpenAICompatibleEndpointOptions[]` | `[]` | Endpoints to register. If empty, the plugin is inactive. |
| `primary` | `string` | first provider's `id` | v1 only. Provider id that receives the runtime `provider.models()` hook and the `/connect` auth hook. Ignored on v2, where every endpoint is registered. |
| `fetchTimeoutMs` | `number` | `30000` | Timeout for each `GET {baseURL}/models` request. |

### `providers[]` endpoint options

| Option | Type | Default | Description |
| ------ | ---- | ------- | ----------- |
| `id` | `string` | required | Provider id, e.g. `crofai`. Must be unique across endpoints. |
| `name` | `string` | required | Display name, e.g. `CrofAI`. |
| `baseURL` | `string` | required | Base URL of the OpenAI-compatible API, e.g. `https://crof.ai/v1`. |
| `apiKey` | `string` | none | API key injected into the provider's `options.apiKey` (v2: `settings.apiKey`). A `{env:MY_API_KEY}` placeholder is expanded from the environment when the plugin starts; if the variable is unset or empty the plugin logs `[ERROR]` and registers the provider without the key (it never sends the raw placeholder as a credential). A literal value is used as-is. |
| `headers` | `Record<string, string>` | none | Extra headers injected into the provider's `options.headers`. |
| `auth` | `OpenAICompatibleEndpointAuth` | none | v1 only. Overrides for the primary endpoint's `/connect` auth method (`label`, `placeholder`, `message`). |
| `cacheFile` | `string` | `{id}-models.json` | Cache file name under `.cache/`. |
| `cacheTtlMs` | `number` | `300000` (5 min) | How long a cached model list may be used to register this endpoint. See [Model cache TTL](#model-cache-ttl). |
| `modelEndpoint` | `string` | `/models` | Path appended to `baseURL` for model discovery. |
| `npm` | `string` | `@ai-sdk/openai-compatible` | Provider npm package reported to OpenCode. |
| `contextLimit` | `number` | `202752` | Default context limit when a model doesn't report one. |
| `outputLimit` | `number` | `202752` | Default output limit when a model doesn't report one. |
| `family` | `string` | `unknown` | Default model family. |

## Auth

- On v1 the primary endpoint gets the interactive `/connect` API-key flow (`type: 'api'`, key
  `key`). The key is sent as `Authorization: Bearer <key>` on requests.
- The other endpoints take their key from `apiKey` in the endpoint config, either an `{env:...}`
  placeholder or a literal value. They don't use `/connect`.
- Placeholders are expanded when the plugin starts, before any model request. If the variable is
  missing or empty, the plugin logs `[ERROR]` and registers the provider without a key rather than
  sending the raw placeholder.
- v2 has no interactive auth. Every endpoint's key comes from `apiKey` or `headers` and becomes
  the provider's `settings.apiKey`, sent as `Authorization: Bearer <key>`.

## Model cache TTL

Each endpoint's model list is cached under the OpenCode cache directory, with a per-endpoint TTL
from `cacheTtlMs`:

| `cacheTtlMs` | Behavior |
| ------------ | -------- |
| absent / not a finite number | Defaults to `300000` (5 minutes). |
| `> 0` | The cache registers models while `age < cacheTtlMs`. |
| `0` | Never register from the cache, always fetch fresh. |
| negative | Clamped to `0`, i.e. always fetch fresh. |

A cache at exactly the TTL is expired: freshness needs `age < ttl`.

The TTL exists because a model added on your endpoint used to appear only after the second
restart. The first restart registered the old cached list and refreshed it in the background for
next time. With a TTL, an expired cache triggers discovery during the same startup, so a new model
is selectable immediately.

Expiry only means the cache is not used without checking. If discovery fails because the endpoint
is down, the network is gone or the key is wrong, the expired list is used anyway, so the provider
keeps its known models instead of collapsing to zero. With no cache at all, the discovery error
propagates.

Two more rules: an empty model list is never written, and a cache file containing `models: []` is
treated as missing, so a transient "no models" answer can't poison the cache. A write is skipped
when the on-disk list is newer than the list being written, so a slow background refresh can't
overwrite a fresher result.

## Model metadata

Metadata comes from `GET {baseURL}/models`. Both shapes are supported, and flat fields win over
the `capabilities` object when both are present.

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
`supports_tool_calls`, `family`, `name` and `pricing` are read directly and override the
equivalent capability. `custom_reasoning` and `reasoning_effort` are read as a pair: if either is
present, they alone decide reasoning support and `capabilities.reasoning` is ignored.

### Models with no metadata

A model with neither `capabilities` nor flat fields still registers. It falls back to
`{ input: ['text'], output: ['text'] }`, `reasoning: false`, `tool_call: true`, and the endpoint's
`contextLimit` / `outputLimit` defaults.

### Unsupported: `search`

Some endpoints advertise `capabilities.search` (86 of 89 models on the reference endpoint carry
the key, 40 of them `true`). The OpenCode model schema has no field for it, so the plugin ignores
it instead of inventing a slot. Unknown capability keys never block registration.

## Reasoning

Reasoning-capable models are registered with `reasoning_options`, which OpenCode 1.18.15 turns into
selectable reasoning levels:

```json
{ "reasoning_options": [{ "type": "effort", "values": ["low", "medium", "high"] }] }
```

Models with `thinkingCanDisable: true` get `null` prepended for an off level. The runtime
`provider.models()` hook (OpenCode ≤ 1.14.30) exposes the same levels as `variants` with the
camelCase `reasoningEffort` key, which `@ai-sdk/openai-compatible` serializes to
`reasoning_effort`. A snake_case key is silently dropped there.

Budget-style thinking cannot be expressed. Endpoints reporting a `thinkingFormat` such as
`gemini-budget` or `claude-budget` with a `thinkingRange` still register with discrete effort
levels only, and the range is dropped, because OpenCode's `budget_tokens` form of
`reasoning_options` does not survive the `@ai-sdk/openai-compatible` mapping.

## Behavior notes

- On v2 the plugin registers providers and models through `ctx.provider.transform(...)` inside
  `setup()`. There is no `config`, `provider.models()` or `auth` hook; the transform replays the
  model list captured at setup. Discovery runs during `setup()`, and the cleanup function returned
  from it stops the refresh timer. The timer uses the smallest `cacheTtlMs` among endpoints, with
  a 60s floor, and calls `ctx.provider.reload()` after each refresh. Provider ids and model ids,
  including ids with `/`, are passed through unchanged.
- On v2 the `npm` option defaults to OpenCode's bundled
  `@opencode/ai/providers/openai-compatible`. Any other `@ai-sdk/*` package is reported as
  `aisdk:<package>`.
- On OpenCode 1.14.31 and later, every endpoint is registered by writing
  `outputConfig.provider[id]` in the `config` hook, with models fetched or cached first. That is
  the only registration path that works for providers outside OpenCode's built-in models
  database.
- On OpenCode 1.14.30 and earlier, and for catalog providers, the primary endpoint also exposes a
  `provider.models()` hook that returns the same registry, cache-first with a background refresh.
- Model caches live under the OpenCode cache directory: `~/.cache/opencode/.cache/{cacheFile}`, or
  `$LOCALAPPDATA/opencode` on Windows, or `$XDG_CACHE_HOME/opencode` when set.
- Empty model lists are never cached. A cache file with zero models is treated as missing, so the
  plugin refetches instead of registering an empty provider.
- OpenCode 1.18.15 loads the default export shape with `id` and `server`, and the same object now
  also carries `setup` for v2. The 1.18 loader accepts `{ id, server }` objects, plain default
  functions and named `server` exports. OpenCode also probes the newer `{ id, effect }` and
  `{ id, setup }` config-plugin schema for the same entries and logs a `SchemaError` while the two
  schemas are tried. That message is benign, because the legacy loader that installs this plugin's
  `config`, `provider` and `auth` hooks still runs.
- The config hook merges discovered models with the models you defined for the same provider id,
  and your entries win.
- User-provided provider fields such as `env`, `blacklist` and `whitelist` are preserved.
- Reasoning-capable models, recognized through `capabilities.reasoning` or the flat
  `custom_reasoning` / `reasoning_effort` pair, get `low`, `medium` and `high`, plus a disabled
  level when the endpoint reports `thinkingCanDisable`. See [Reasoning](#reasoning).

## Local development

```bash
git clone <your-fork-url>
cd opencode-openai-compatible
bun install
bun run build
```

v1 accepts the built file under `plugin`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["./dist/index.js"]
}
```

v2 needs a directory under `plugins`, because a file path is rejected with
`configured plugin path must be a directory`. Point it at `dist`, which holds `index.js`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["F:/path/to/opencode-openai-compatible/dist"]
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
