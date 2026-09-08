# Library development

Use the devcontainer or equivalent Docker development image for all dependency,
formatting, build and test commands. Run `npm run validate` before publishing a
change. Use Conventional Commits. Never commit generated dist, coverage,
node_modules, credentials or tokens.

Keep `src/` independent of Node globals/builtins, local files and Cloudflare
bindings. Preserve public credential-free access, fixed ESI request validation,
the manually verified safe POST allowlist, token rotation and credential-aware
cache isolation. Authentication and static-data adapters belong to consumers.
Add regression tests for behavior changes. The pinned schema is shared by all
consumers; manually review non-GET changes before extending the allowlist.

This repository is a source submodule, not a separately published npm package.
Push and validate a library commit before a consumer references it. Changes to
the consumer's behavior must also pass that consumer's integration tests.
