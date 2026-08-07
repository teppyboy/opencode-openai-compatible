# Changelog

## [0.1.1] - 2026-08-08

- feat: load endpoint configuration from opencode-openai-compatible.json config file
  (OPENCODE_OPENAI_COMPATIBLE_CONFIG override; plugin options remain supported as fallback)

## [0.1.0] - 2026-08-07

- feat: support multiple configurable OpenAI-compatible endpoints via plugin options
- This package replaces `@tretrauit/opencode-crofai`, which was hardcoded to the CrofAI
  endpoint. Use the `providers` option to configure any OpenAI-compatible endpoint.