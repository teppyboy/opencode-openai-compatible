# Changelog

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