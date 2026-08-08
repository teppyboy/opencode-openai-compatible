# Changelog

## [0.1.5] - 2026-08-09

- feat: derive reasoning levels per `thinkingFormat` instead of using one shared level set —
  `openai` gets `low`/`medium`/`high`/`xhigh`, `claude-budget` and `claude-adaptive` get
  `low`/`medium`/`high`/`max`, and `gemini-level`, `gemini-budget`, `zai`, `kimi`, `deepseek`,
  `minimax`, and `qwen` get `low`/`medium`/`high`. An unknown or absent format falls back to the
  default levels, and `thinkingCanDisable` still prepends the "reasoning off" level
- note: the `xhigh` (`openai`) and `max` (`claude-*`) levels are an ACCEPTED **UNVERIFIED**
  assumption. They were not probed against upstream, so a provider that rejects them would only
  surface at request time

## [0.1.4] - 2026-08-08

- fix: bound the model cache with a TTL (`cacheTtlMs`, default `300000`). An expired cache now
  triggers discovery during the same startup, so a model added on the endpoint is selectable on
  the next start instead of the one after it
- feat: `cacheTtlMs` is configurable per endpoint — `0` always fetches fresh, negative values
  clamp to `0`, and an absent or non-finite value falls back to the 5 minute default
- fix: an expired cache is still used as an offline fallback when discovery fails, so an
  unreachable endpoint keeps its previously known models
- fix: skip a cache write when the on-disk list is newer than the incoming one, so a slow
  background refresh cannot overwrite a fresher result
- feat: read model metadata from the upstream `capabilities` object (`contextWindow`,
  `maxOutput`, `vision`, `pdf`, `audioInput`, `videoInput`, `imageOutput`, `audioOutput`,
  `tools`, `reasoning`, `thinkingCanDisable`). Flat legacy fields still take precedence
- feat: register reasoning levels via `reasoning_options`, which is what OpenCode `1.18.15` uses
  to build selectable reasoning variants; models reporting `thinkingCanDisable` also get a
  "reasoning off" level
- fix: models that report no `capabilities` at all still register with text-only modalities and
  the endpoint's default limits
- feat: export `DEFAULT_CACHE_TTL_MS`, `normalizeCacheTtlMs`, `readModelCacheEntry`,
  `resolveModelsWithCacheFallback`, and the `ModelCacheEntry` type from the factory subpath
- docs: document cache TTL semantics, `capabilities` support and its precedence rules, reasoning
  level behavior, and the budget-format limitation (`gemini-budget` / `claude-budget` models are
  registered with discrete effort levels only)
- note: upstream advertises a `capabilities.search` flag, but the OpenCode model schema has no
  field for it, so it is deliberately ignored

## [0.1.3] - 2026-08-08

- fix: expand `{env:NAME}` placeholders in endpoint `apiKey` and header values instead of
  passing the literal placeholder through to the provider. A missing or empty variable is
  reported with `[ERROR]` naming the variable and the provider is registered without a key
- fix: the `config` hook now discovers models with the resolved endpoint key instead of an
  empty string, so authenticated `/models` endpoints no longer fail with `401`
- fix: `provider.models()` falls back to the configured endpoint key when the runtime auth
  context has no key
- fix: never write a model cache with an empty model list, and treat an existing cache file
  containing zero models as missing so the plugin refetches
- docs: document `{env:}` expansion semantics and OpenCode `1.18.15` plugin loading (the
  `{ id, server }` default export is still the supported server contract; the `effect`/`setup`
  `SchemaError` warning from OpenCode's config-plugin schema is benign)

## [0.1.2] - 2026-08-08

- fix: discover the config file in the global OpenCode config directory
  (`~/.config/opencode/`, `OPENCODE_CONFIG_DIR`, `XDG_CONFIG_HOME/opencode`, and the Windows
  `APPDATA`/`LOCALAPPDATA` `opencode` directories) instead of only the project directory
- feat: also search `.opencode/` subdirectories of the project directory and worktree
- feat: accept a `.jsonc` config file alongside `.json`
- feat: tolerate `//` and `/* */` comments and trailing commas in the plugin config file
  (URLs inside JSON strings are preserved); the model cache parser is unchanged
- fix: log every attempted candidate path when no config file is found

## [0.1.1] - 2026-08-08

- feat: load endpoint configuration from opencode-openai-compatible.json config file
  (OPENCODE_OPENAI_COMPATIBLE_CONFIG override; plugin options remain supported as fallback)

## [0.1.0] - 2026-08-07

- feat: support multiple configurable OpenAI-compatible endpoints via plugin options
- This package replaces `@tretrauit/opencode-crofai`, which was hardcoded to the CrofAI
  endpoint. Use the `providers` option to configure any OpenAI-compatible endpoint.