# docs

Google Docs operations, dispatched by `action` to the vendored `DocsService`.

## account (M1)

`account` is accepted in the input but IGNORED in M1 (single-account mode). Every
call runs against the one Google account configured via
`config(action="setup_start")`. M2 adds per-account routing.

## Actions

| Action | Required params | Optional params | Description |
| --- | --- | --- | --- |
| `getText` | `documentId` | `tabId` | Read the document's text. Returns plain text for a single-tab document, or JSON with all tabs when the doc has more than one tab. |
| `create` | `title` | `content` | Create a new Google Doc, optionally seeded with initial text content. |
| `writeText` | `documentId`, `text` | `position` (default `"end"`), `tabId` | Insert text at `"beginning"`, `"end"`, or a positive integer character index. |
| `getSuggestions` | `documentId` | -- | List pending suggested edits (insertions, deletions, style and paragraph-style changes). |
| `replaceText` | `documentId`, `findText`, `replaceText` | `tabId` | Find-and-replace all occurrences of `findText` with `replaceText`, across all tabs unless `tabId` is given. |
| `formatText` | `documentId`, `formats` | `tabId` | Apply one or more formatting operations. Each entry in `formats` is `{startIndex, endIndex, style, url?}`; `style` is a heading level (`heading1`..`heading6`, `normalText`), a text style (`bold`, `italic`, `underline`, `strikethrough`), `"code"`, or `"link"` (requires `url`). |

## Result shape

Every action returns the MCP `CallTool` result shape directly from
`DocsService` (`{content: [{type: "text", text}], isError?: true}`) -- the
`docs` tool does not re-wrap or transform it.

## Examples

```json
{ "action": "getText", "documentId": "1AbCdEf..." }
{ "action": "writeText", "documentId": "1AbCdEf...", "text": "Hello", "position": "end" }
{ "action": "formatText", "documentId": "1AbCdEf...", "formats": [{ "startIndex": 1, "endIndex": 6, "style": "bold" }] }
```
