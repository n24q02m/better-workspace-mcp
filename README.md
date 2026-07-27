<p align="center">
  <img src="https://better-workspace-mcp.n24q02m.com/logo.svg" alt="better-workspace-mcp" width="120">
</p>

<h1 align="center">better-workspace-mcp</h1>

<p align="center">
  <strong>Google Workspace MCP server — Docs/Drive/Calendar/Gmail/Sheets/Slides/Tasks/Chat/People/Forms + multi-account</strong>
</p>

<p align="center">
  <a href="https://github.com/n24q02m/better-workspace-mcp/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/n24q02m/better-workspace-mcp/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/n24q02m/better-workspace-mcp/actions/workflows/cd.yml"><img alt="CD" src="https://github.com/n24q02m/better-workspace-mcp/actions/workflows/cd.yml/badge.svg"></a>
  <a href="https://codecov.io/gh/n24q02m/better-workspace-mcp"><img alt="codecov" src="https://codecov.io/gh/n24q02m/better-workspace-mcp/graph/badge.svg"></a>
  <a href="https://github.com/n24q02m/better-workspace-mcp/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/n24q02m/better-workspace-mcp?display_name=tag&sort=semver"></a>
  <a href="https://github.com/python-semantic-release/python-semantic-release"><img alt="semantic-release" src="https://img.shields.io/badge/semantic--release-e10079?logo=semantic-release&logoColor=white"></a>
  <a href="LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/github/license/n24q02m/better-workspace-mcp"></a>
</p>

<p align="center">
  <a href="https://better-workspace-mcp.n24q02m.com">Docs</a> ·
  <a href="#install">Install</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="https://github.com/n24q02m/better-workspace-mcp/discussions">Community</a>
</p>

<!-- BEGIN: AUTO-GENERATED-CROSS-PROMO -->
<!-- END: AUTO-GENERATED-CROSS-PROMO -->

## Install

(See [docs](https://better-workspace-mcp.n24q02m.com) for full install matrix.)

## Quick start

(Add example commands here.)

## Multi-account

Every domain tool takes an `account` parameter -- the email of the Google account
the call acts as. Omit it and the call runs against the primary account.

```json
{ "action": "search", "query": "is:unread", "account": "work@example.com" }
{ "action": "search", "query": "is:unread" }
```

Those two `gmail` calls read two different mailboxes: the first `work@example.com`,
the second whichever account is primary.

Accounts are managed through the `config` tool:

| Call | Effect |
| --- | --- |
| `config(action="account_add")` | Returns a URL to open; completing the Google consent there adds one more account. |
| `config(action="account_list")` | The configured accounts and which one is primary. |
| `config(action="account_remove", account="<email>")` | Forget one account. |
| `config(action="account_set_default", account="<email>")` | Make one account the primary. |

The first account authorized becomes the primary. Removing the primary promotes
one of the remaining accounts; removing the last one puts the server back to
awaiting setup. Naming an account that is not configured is an error that names
it -- the call is never rerouted to the primary, because a silent fallback would
act on the wrong mailbox.

`account_add` works in both transports and chooses the flow itself: a temporary
loopback consent server in stdio, and a fixed `/accounts/callback` on the running
server over HTTP, since a Web OAuth client's redirect URI must be registered in
advance. The HTTP link is single-use and expires in 10 minutes.

`value="primary"` is stdio only. Over HTTP that request would have to ride the
URL through Google, where anyone who obtained it could aim your default account
at one of theirs -- so remote callers change the default with
`account_set_default` instead, from inside an authenticated call.

### Coming from an earlier single-account build

Credentials stored by a build from before multi-account support are one flat blob
of tokens. The first run afterwards adopts that blob into the multi-account layout
under the account's email. The email comes from the stored `id_token` when it is
present -- no network needed, and that is the usual case. Otherwise the server asks
Google's userinfo endpoint, which needs network access and a token that is still
valid or refreshable.

If neither works, the server reports itself as awaiting setup and opens the browser
OAuth flow even though the stored token may still be fine. Completing that consent
works, and nothing is discarded: the account you just authorized is stored and
becomes the primary, while the old tokens are carried across under the key
`(unidentified)` rather than being overwritten. `config(action="account_list")` then
shows two entries:

```json
{ "accounts": ["(unidentified)", "you@example.com"], "primary": "you@example.com" }
```

Nothing routes to `(unidentified)`: it is never promoted to primary while a real
account remains, and no call reaches it unless you name it explicitly. It is there
so a credential whose owner could not be determined is not silently thrown away.
Remove it once the re-authorized account is working:

```json
{ "action": "account_remove", "account": "(unidentified)" }
```

After a successful adoption -- the usual case -- `config(action="account_list")`
shows exactly one account, and it is the primary.

### Forms scopes and re-consent

The consent screen has requested the Google Forms scopes since before the `forms`
tool existed, so it arrived without a second trip through consent for most people.
Google does not widen a token that has already been issued, though: an account
authorized *before* those scopes were added keeps the older scope set, and its first
`forms` call fails with a Google 403 (`Request had insufficient authentication
scopes`). Re-authorize that one account with `config(action="account_add")`, signing
in as the same account -- the record is replaced in place, so nothing else changes.
Accounts added after the scopes were requested need none of this.

## Documentation

Full docs at [better-workspace-mcp.n24q02m.com](https://better-workspace-mcp.n24q02m.com).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE) © n24q02m
