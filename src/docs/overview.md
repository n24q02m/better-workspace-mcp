# better-workspace-mcp tools

- **docs** -- Google Docs operations (get/write text, create, suggestions, replace, format text). See `help(topic="docs")`.
- **config** -- server configuration and Google credential state (status, setup, reset). See `help(topic="config")`.
- **help** -- full documentation for a topic (`docs`, `config`, `overview`).

M1 is single-account: the `account` param on domain tools is accepted but
ignored. M2 adds multi-account routing plus 9 more domains (drive, calendar,
gmail, sheets, slides, tasks, chat, people, time).
