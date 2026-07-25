# config

Manage server configuration, Google credential state, and the set of Google
accounts this server can act as. Does not require a configured Google account --
works independently of the domain tools.

## Actions

| Action | Description |
| --- | --- |
| `status` | Returns `{state, configured, accounts, primary}` -- the credential state (`awaiting_setup` \| `configured`), the configured account emails, and which one is primary. |
| `setup_start` | Returns instructions to trigger the browser Google OAuth consent flow (stdio mode: restart the server). |
| `setup_reset` | Clears stored credentials for **every** account and returns to `awaiting_setup`. |
| `setup_complete` | Re-checks stored credentials after an external config change. |
| `set` | No mutable runtime settings -- returns an informational no-op. |
| `cache_clear` | No client-side cache -- returns an informational no-op. |
| `account_add` | Starts a browser consent flow for one more Google account. Returns `{open, next}`; open the `open` URL to complete the consent. stdio only. |
| `account_list` | Returns `{accounts, primary}`. |
| `account_remove` | Forgets the account named in `account`. Returns `{removed, primary}`. |
| `account_set_default` | Makes the account named in `account` the primary one. Returns `{primary}`. |

## Accounts

Every domain tool takes `account="<email>"`. Omit it and the call runs against
the primary account.

- The first account stored becomes the primary automatically.
- Removing the primary promotes one of the remaining accounts -- `account_remove`
  reports which one in `primary`.
- Removing the last account clears the credential blob and puts the server back
  in `awaiting_setup`; domain tools are refused again until an account is
  configured.
- Naming an account that is not configured is an **error that names the
  account**, and lists what is configured. The call is never silently rerouted to
  the primary -- a silent fallback would act on the wrong mailbox.
- Emails are the account keys, matched case-insensitively and stored lowercased.
- `account_remove` and `account_set_default` require `account` and have no
  default: falling back to the primary would remove or reshuffle the wrong
  account. `account_set_default` on an unknown account is an error.

### account_add

- **stdio only.** The remote flow needs a fixed callback route inside the
  already-running server, and `runHttpServer` has no way to add one yet -- it
  arrives with the HTTP/remote milestone.
- Requires `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` in the
  environment.
- Returns the URL immediately rather than blocking on the consent. Open it, sign
  in as the account you want to add, then call `account_list` to confirm the
  outcome.
- Which account gets added is decided by whom you sign in as on the consent
  screen. `account_add` does **not** read the `account` parameter.
- Pass `value="primary"` to make the newly added account the primary one.
- The temporary consent server closes itself 10 minutes after the call, so an
  abandoned flow does not hold its port open. Call `account_add` again if the URL
  has gone stale.

## key / value

`key` is accepted on the schema but unused. `value` is read only by `account_add`
(`value="primary"`).

## Upgrading from the single-account layout

Credentials written before multi-account support are a single flat blob of tokens.
The first run afterwards adopts that blob into the multi-account layout, keyed by
the account's email:

- The email comes from the stored `id_token` when it is there. That needs no
  network and is the usual case.
- Otherwise the server asks Google's userinfo endpoint, which needs network
  access and a token that is still valid or refreshable.

If neither works the old blob is left untouched -- nothing is discarded -- but the
state falls back to `awaiting_setup` and the server starts the browser OAuth flow
even though the stored token may still be good. Completing that consent does not
save either: the store refuses to overwrite an unadopted single-account blob
rather than risk dropping its `refresh_token`, so startup fails with *"Refusing to
overwrite credentials stored in the older single-account layout"*.

To recover, run the server again with network access so the adoption can finish.
If the old credential is genuinely dead, move `~/.better-workspace-mcp/config.json`
aside and authorize from scratch -- `setup_reset` does the same thing, but only
while a server is running, which is not the case once startup has already failed.

After a successful adoption, `account_list` shows exactly one account and it is
the primary.
