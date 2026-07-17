# config

Manage server configuration and Google credential state. Does not require a
configured Google account -- works independently of the domain tools (`docs`,
and the 9 more domains landing in Task 7).

## Actions

| Action | Description |
| --- | --- |
| `status` | Returns the current credential state (`awaiting_setup` \| `configured`). |
| `setup_start` | Returns instructions to trigger the browser Google OAuth consent flow (stdio mode: restart the server). |
| `setup_reset` | Clears stored credentials and returns to `awaiting_setup`. |
| `setup_complete` | Re-checks stored credentials after an external config change. |
| `set` | No mutable runtime settings in M1 -- returns an informational no-op. |
| `cache_clear` | No client-side cache in M1 -- returns an informational no-op. |

`key` / `value` are accepted on the `config` tool schema but are currently
unused (M1 has no mutable settings).

Single-account only in M1 -- there are no `account_*` actions; those ship in
M2 alongside per-account routing for the domain tools.
