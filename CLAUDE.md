# better-workspace-mcp

TypeScript MCP Server cho Google Workspace (Docs/Drive/Calendar/Gmail/Sheets/Slides/Tasks/Chat/People + multi-account). Kien truc: vendored-services (Apache-2.0 code tu gemini-cli-extensions/workspace duoi `src/vendored/services/`, byte-identical upstream) + mcp-core auth adapter (`@n24q02m/mcp-core`, OAuth + credential storage + relay). N+2 tools: 1 composite tool per service (docs, drive, calendar, chat, gmail, slides, sheets, tasks, people, time) + `config` + `help`.

Trang thai hien tai: SCAFFOLD ONLY (M1 Task 1) — chua co server logic, tools, hay auth wiring. `src/constants.ts` la file source duy nhat.

## Vendored boundary

`src/vendored/services/*` (khi tao o task sau) la Apache-2.0 upstream code tu gemini-cli-extensions/workspace — byte-identical, KHONG BAO GIO edit truc tiep, tru khi dang chuan bi PR-backing upstream. Xem `NOTICE`.

## Modes

stdio mode (mac dinh, single-user qua env credentials) la target M1. HTTP/multi-user la milestone sau.

## Lenh thuong dung

```bash
bun install
bun run check       # biome check . + tsc --noEmit (CI command)
bun run check:fix   # auto-fix biome + type-check
bun run test        # vitest --passWithNoTests
bun run build       # tsc -build + scripts/build-cli.js (CHUA scaffold — task sau)
```

## Cau hinh

- License: Apache-2.0 (repo nay vendor code Apache-2.0, khac voi MIT cua cac MCP server khac trong stack).
- `type-check` script TAM THOI chi chay `tsc --noEmit` (bo `-p tsconfig.worker.json`) vi `src/worker.ts` chua ton tai (`tsconfig.worker.json` co `include: ["src/worker.ts"]` → "no inputs" error). Khoi phuc `&& tsc --noEmit -p tsconfig.worker.json` khi worker.ts duoc tao.
- `bun run build` hien FAIL (`scripts/build-cli.js` + `bin/cli.mjs` chua duoc scaffold — nam ngoai scope Task 1, se tao o task CLI entrypoint).

## Dependency dac biet

`@n24q02m/mcp-core` pin qua `file:../mcp-core.wsauthparams/packages/core-ts` — link toi worktree merged-but-unpublished chua feature `authorizeParams`. Day la INTENTIONAL cho M1 dev; chuyen sang published `^1.20.x` beta truoc khi publish package nay.
