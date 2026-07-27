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
<details>
  <summary><strong>Sister projects from n24q02m</strong> (click to expand)</summary>

| Project | Tagline | Tag |
|---|---|---|
| [agent-chat-plugin](https://github.com/n24q02m/agent-chat-plugin) | Peer AI agents chat in a shared folder — no human relay, no orchestrator, wor... | Tooling |
| [better-code-review-graph](https://github.com/n24q02m/better-code-review-graph) | Knowledge graph for token-efficient code reviews -- semantic search and call-... | MCP |
| [better-drive](https://github.com/n24q02m/better-drive) | 2-way Google Drive sync with .driveignore filter — rclone engine, Windows tray | Tooling |
| [better-email-mcp](https://github.com/n24q02m/better-email-mcp) | IMAP/SMTP email for AI agents -- read, send, organize folders, and manage att... | MCP |
| [better-godot-mcp](https://github.com/n24q02m/better-godot-mcp) | Composite MCP server for Godot Engine -- 17 composite tools for AI-assisted g... | MCP |
| [better-notion-mcp](https://github.com/n24q02m/better-notion-mcp) | Markdown-first Notion for AI agents -- pages, databases, blocks, and comments... | MCP |
| [better-semantic-release](https://github.com/n24q02m/better-semantic-release) | Drop-in python-semantic-release fork with built-in release-safety guards (orp... | Tooling |
| [better-telegram-mcp](https://github.com/n24q02m/better-telegram-mcp) | Telegram for AI agents -- messages, chats, media, and contacts across both bo... | MCP |
| [better-workspace-mcp](https://github.com/n24q02m/better-workspace-mcp) | Google Workspace MCP server (Docs/Drive/Calendar/Gmail/Sheets/Slides/Tasks/Ch... | MCP |
| [claude-plugins](https://github.com/n24q02m/claude-plugins) | Claude Code plugin marketplace for the n24q02m MCP servers -- install web sea... | Marketplace |
| [imagine-mcp](https://github.com/n24q02m/imagine-mcp) | Image and video understanding + generation for AI agents -- across Gemini, Op... | MCP |
| [jules-task-archiver](https://github.com/n24q02m/jules-task-archiver) | Chrome Extension for bulk operations on Jules tasks via batchexecute API -- a... | Tooling |
| [mcp-core](https://github.com/n24q02m/mcp-core) | Shared foundation for building MCP servers -- Streamable HTTP transport, OAut... | MCP |
| [mnemo-mcp](https://github.com/n24q02m/mnemo-mcp) | Persistent AI memory with hybrid search and embedded sync. Open, free, unlimi... | MCP |
| [qwen3-embed](https://github.com/n24q02m/qwen3-embed) | Lightweight Qwen3 text embedding and reranking via ONNX Runtime and GGUF | Library |
| [skret](https://github.com/n24q02m/skret) | Secrets without the server. | CLI |
| [tacet](https://github.com/n24q02m/tacet) | A self-distilling neuro-symbolic cascade that amortises LLM cost across knowl... | Tooling |
| [web-core](https://github.com/n24q02m/web-core) | Shared web infrastructure package for search, scraping, HTTP security, and st... | Library |
| [wet-mcp](https://github.com/n24q02m/wet-mcp) | Open-source MCP server for AI agents: web search, content extraction, and lib... | MCP |

</details>
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
tool existed, so it arrived without a second trip through consent.

Accounts authorized *before* those scopes were added are covered too, but by a
different route: Google accepts `https://www.googleapis.com/auth/drive` in place of
the Forms scopes for every Forms method this server calls, and full `drive` has
been on the consent screen since the first release. Google never widens a token it
has already issued, so if a grant covers neither -- a user may withhold individual
restricted scopes at the consent screen -- the first `forms` call returns a 403
(`Request had insufficient authentication scopes`). Re-authorize just that account
with `config(action="account_add")`, signing in as the same account; the record is
replaced in place, so nothing else changes.

## Documentation

Full docs at [better-workspace-mcp.n24q02m.com](https://better-workspace-mcp.n24q02m.com).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE) © n24q02m
