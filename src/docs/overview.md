# better-workspace-mcp tools

One composite tool per Google Workspace service, plus two infra tools.

- **docs** -- Google Docs (get/write text, create, suggestions, replace, format).
- **drive** -- files and folders (find, create, search, trash, rename, move, comments, download).
- **calendar** -- calendars and events (list, create, update, delete, respond, find free time).
- **gmail** -- mail (search, read, send, drafts, labels, modify messages and threads).
- **sheets** -- spreadsheets (text, ranges, metadata).
- **slides** -- presentations (text, slides, shapes, images, tables, speaker notes).
- **tasks** -- task lists and tasks (list, create, update, complete, delete).
- **chat** -- Google Chat spaces, messages and DMs.
- **people** -- contacts and profiles (own profile, user profile, relations).
- **time** -- local date/time/timezone helpers. Needs no Google account.
- **config** -- server configuration, credential state, and the Google accounts this server can act as.
- **help** -- full documentation for a topic.

`help(topic="<name>")` returns the full document for any domain tool above, for
`config`, or for `overview`. The same documents are exposed as MCP resources
under `workspace://docs/<name>`.

## Multi-account

Every domain tool takes `account="<email>"`, choosing which Google account the
call acts as. Omit it and the call runs against the primary account. Manage the
set of accounts with `config`: `account_add`, `account_list`, `account_remove`,
`account_set_default` -- see `help(topic="config")`.

Naming an account that is not configured is an error that names it; the call is
never silently rerouted to the primary. `time` accepts `account` for signature
parity only -- it needs no Google account.
