# better-workspace-mcp

TypeScript MCP Server cho Google Workspace (Docs/Drive/Calendar/Gmail/Sheets/Slides/Tasks/Chat/People + multi-account). Kien truc: vendored-services (Apache-2.0 code tu gemini-cli-extensions/workspace duoi `src/vendored/services/`, byte-identical upstream) + mcp-core auth adapter (`@n24q02m/mcp-core`, OAuth + credential storage + relay). N+2 tools: 1 composite tool per service (docs, drive, calendar, chat, gmail, slides, sheets, tasks, people, time) + `config` + `help`.

Trang thai: M1 COMPLETE — stdio single-account server voi 10 domain (docs/drive/calendar/chat/gmail/slides/sheets/tasks/people/time) + `config` + `help`, mcp-core Desktop OAuth (redirect + access_type=offline -> refresh_token), N+2 registry derive tu `src/tools/domains/index.ts` (DOMAINS list) + `makeDomainRun` factory. 114 tests, coverage gate 95/95/90/95 (src/vendored/** excluded). Validated live real Google (docs create+read + 6 domain read). Milestone sau: M2 multi-account (account param + add-account sub-flow), M3 HTTP/CF, M4 Forms.

## Vendored boundary

`src/vendored/services/*` + pure-logic utils (`IdUtils/validation/GaxiosConfig/DriveQueryBuilder/MimeHelper/constants`) la Apache-2.0 upstream code tu gemini-cli-extensions/workspace — byte-identical, KHONG BAO GIO edit truc tiep, tru khi dang chuan bi PR-backing upstream. `paths.ts`/`logger.ts`/`auth/AuthManager.ts` la SHIM cua minh (infra decoupled khoi gemini-cli). biome + tsc-strict deu handle qua override (`biome.json` bo lint `src/vendored/{services,utils}/**`). Xem `NOTICE`.

## Modes

stdio mode (mac dinh, single-user qua env credentials) la target M1. HTTP/multi-user la milestone sau.

## Lenh thuong dung

```bash
bun install
bun run check       # biome check . + tsc --noEmit (CI command)
bun run check:fix   # auto-fix biome + type-check
bun run test        # vitest
bun run test:coverage  # vitest --coverage (enforce threshold 95/95/90/95)
bun run build       # tsc -build + scripts/build-cli.js -> bin/cli.mjs
```

## Cau hinh

- License: Apache-2.0 (repo nay vendor code Apache-2.0, khac voi MIT cua cac MCP server khac trong stack).
- `type-check` script chi chay `tsc --noEmit` (bo `-p tsconfig.worker.json`) vi `src/worker.ts` chua ton tai (M3 HTTP/CF). Khoi phuc `&& tsc --noEmit -p tsconfig.worker.json` khi worker.ts duoc tao o M3.
- Test surface: 107 unit/component + hermetic protocol E2E (`tests/protocol/m1-stdio.test.ts`, stdio_client spawn bin/cli.mjs, seeded token, no real network). Real-Google smoke = thu cong (xem `.private` ledger).

## Dependency dac biet

`@n24q02m/mcp-core` pin qua `file:../mcp-core.wsauthparams/packages/core-ts` — link toi worktree merged-but-unpublished chua feature `authorizeParams`. Day la INTENTIONAL cho M1 dev; chuyen sang published `^1.20.x` beta truoc khi publish package nay.
