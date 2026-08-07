# Changelog

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