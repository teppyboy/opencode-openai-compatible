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
- uses cached models immediately on startup
- refreshes the cache in the background
- falls back to cached models if an endpoint is unavailable
- normalizes variant names like `Lightning` and `Precision` without duplicate suffixes
- exposes `low` / `medium` / `high` reasoning variants for reasoning-capable models

## Install

### Via OpenCode CLI

```bash
opencode plugin -g @tretrauit/opencode-openai-compatible
```

### Via `opencode.json`

Add the plugin with its endpoint configuration using the **tuple form** — the second element of
the tuple is passed verbatim to the plugin as its options:

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
          },
          {
            "id": "local",
            "name": "Local",
            "baseURL": "http://localhost:1234/v1"
          }
        ],
        "primary": "crofai"
      }
    ]
  ]
}
```

With this example you get two providers: `crofai` (with its API key read from the
`CROFAI_API_KEY` environment variable) and `local` (no key). `primary` selects which endpoint
gets the interactive `/connect` auth flow and the runtime provider hook; when omitted the first
provider is used.

## Options

The plugin options object is the second element of the `plugin` tuple.

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
| `apiKey` | `string` | — | API key injected into the provider's `options.apiKey`. Use an env placeholder like `{env:MY_API_KEY}` or a literal. |
| `headers` | `Record<string, string>` | — | Extra headers injected into the provider's `options.headers`. |
| `auth` | `OpenAICompatibleEndpointAuth` | — | Overrides for the primary endpoint's `/connect` auth method (`label`, `placeholder`, `message`). |
| `cacheFile` | `string` | `{id}-models.json` | Cache file name under `.cache/`. |
| `modelEndpoint` | `string` | `/models` | Path appended to `baseURL` for model discovery. |
| `npm` | `string` | `@ai-sdk/openai-compatible` | Provider npm package reported to OpenCode. |
| `contextLimit` | `number` | `202752` | Default context limit when a model doesn't report one. |
| `outputLimit` | `number` | `202752` | Default output limit when a model doesn't report one. |
| `family` | `string` | `unknown` | Default model family. |

## Auth

- The **primary** endpoint gets the interactive `/connect` API-key auth flow (`type: 'api'`,
  key `key`). The returned key is injected as `Authorization: Bearer <key>` on requests.
- **Other** endpoints use `apiKey` from the plugin options instead — either an environment
  placeholder (`{env:...}`) or a literal value. They don't need `/connect`.

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
- The config hook merges discovered models with any models you defined yourself for the same
  provider id — your explicit config models win.
- User-provided provider fields (e.g. `env`, `blacklist`, `whitelist`) are preserved.
- Reasoning-capable models (reported via `custom_reasoning` / `reasoning_effort`) get `low`,
  `medium`, and `high` variants with `reasoning_effort` set.

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
