# better-workspace-mcp

TypeScript MCP Server cho Google Workspace (Docs/Drive/Calendar/Gmail/Sheets/Slides/Tasks/Chat/People/Forms + multi-account). Kien truc: vendored-services (Apache-2.0 code tu gemini-cli-extensions/workspace duoi `src/vendored/services/`, gan byte-identical upstream — 2 file da fork co chu dich, xem `NOTICE`) + service CUA MINH duoi `src/services/` (upstream khong co) + mcp-core auth adapter (`@n24q02m/mcp-core`, OAuth + credential storage + relay). N+2 tools: 1 composite tool per service (docs, drive, calendar, chat, gmail, slides, sheets, tasks, people, time, forms) + `config` + `help`.

Trang thai: M2 multi-account COMPLETE (Task 9 smoke that voi 2 Google account da PASS 2026-07-25 — xem `.private/superpower/better-workspace-mcp/m2-task9-live-smoke-2026-07-25.md`). M3 Task 1 (sub-keying) da tren main. Stdio server voi 11 domain (docs/drive/calendar/chat/gmail/slides/sheets/tasks/people/time/forms) + `config` + `help`, mcp-core Desktop OAuth (redirect + access_type=offline -> refresh_token), N+2 registry derive tu `src/tools/domains/index.ts` (DOMAINS list) + `makeDomainRun` factory. Moi domain tool nhan `account="<email>"` (khong truyen = primary); `config` them 4 action `account_add`/`account_list`/`account_remove`/`account_set_default`. 378 tests (25 file), coverage 98.32 stmts / 95.24 branches / 98.7 funcs / 98.7 lines vs gate 95/95/90/95 (thu tu gate = lines/functions/branches/statements; src/vendored/** excluded — nen test cho file vendored da fork KHONG lam doi con so coverage, con `src/services/**` thi CO tinh day du). M1 da validated live real Google (docs create+read + 6 domain read). Milestone sau: M5 packaging + release + sync-upstream script.

## Vendored boundary

`src/vendored/services/*` + pure-logic utils (`IdUtils/validation/GaxiosConfig/DriveQueryBuilder/MimeHelper/constants`) la Apache-2.0 upstream code tu gemini-cli-extensions/workspace. Giu GIONG upstream de con SYNC duoc cap nhat cua Google ve — do la ly do duy nhat, khong phai muc tieu tu than. Gap bug o day thi SUA NGAY tai repo nay, roi ghi file da fork vao `NOTICE` de lan sync sau bao conflict thay vi ghi de im lang; PR-back len upstream KHONG phai viec cua repo nay. Da fork co chu dich: `MimeHelper.ts` (boundary suy bien), `SheetsService.ts` (N call -> batchGet + fallback). `paths.ts`/`logger.ts`/`auth/AuthManager.ts` la SHIM cua minh (infra decoupled khoi gemini-cli). **Service ma upstream KHONG co thi dat `src/services/`, KHONG dat trong `src/vendored/`** (`FormsService.ts` la case dau tien): nhet code minh vao vung vendored se lam lan sync sau bao conflict o mot file upstream chua tung co. Viet theo hinh dang service vendored (constructor nhan AuthManager, private client getter, arrow-fn property) nhung theo style adapter — biome KHONG bo qua `src/services/**`, va coverage gate CO tinh no. biome + tsc-strict deu handle qua override (`biome.json` bo lint VA format `src/vendored/{services,utils}/**` — nen file trong do khong duoc biome kiem, phai tu khop style cua chinh file do: vendored dung dau `;`, khac code adapter). Xem `NOTICE`.

## Modes

stdio mode (mac dinh, single-user qua env credentials) la target M1-M2. HTTP/multi-user la M3. `account_add` chay duoc o CA HAI mode va tu chon duong di theo `currentSubject()`: co subject scope (= remote, `authScope` mo tu Bearer JWT) thi tra URL toi `/accounts/callback` co dinh; khong co (= stdio) thi dung server tam tren loopback. Xem Multi-account.

## Multi-account

- Nhieu account nam trong MOT blob ma hoa cua `PerPluginStore` — shape v2 `{version: 2, accounts: {<email>: record}, primary: <email>}` (`src/auth/account-store.ts`). KHONG phai key-per-account: `PerPluginStore` chi co DUNG MOT credKey moi cap (plugin, sub) (`per-plugin-store.ts:74-82`), nen layout `subs/<sub>/accounts/<email>/token` ma spec §4.2 ve khong dung duoc. Ke thua uu diem: ghi mot blob la atomic, `accounts` va `primary` khong bao gio lech nhau.
- Account cua tung request di qua `AsyncLocalStorage` (`src/auth/account-context.ts`), KHONG qua tham so: service vendored la singleton khoi tao luc module-load (`src/tools/domains/factory.ts`) va chu ky upstream `getAuthenticatedClient()` khong nhan tham so — giu nguyen chu ky do chinh la giu vendored boundary. Shim `src/vendored/auth/AuthManager.ts` doc `currentAccount()` roi chuyen xuong `WorkspaceAuth`.
- `getAuthenticatedClient(account?)` dung `OAuth2Client` MOI moi lan goi. KHONG cache client: closure cua listener `'tokens'` giu snapshot record cu, va cache dung chung giua cac account = loi isolation credential. Giu merge order `{...record, ...t}` (google-auth-library khong kem refresh_token khi refresh).
- Goi tool voi account la = LOI co ten account do + liet ke account da cau hinh. KHONG am tham roi ve primary (se hanh dong tren sai mailbox).
- `account_add` co HAI duong, chon theo `currentSubject()`:
  - **stdio** (`src/auth/add-account.ts`): one-shot `runHttpServer` tren loopback, tra URL ngay, TTL 10 phut. Nhan `value="primary"`.
  - **remote** (`src/auth/add-account-remote.ts`): route co dinh `/accounts/callback` dang ky qua `extraRoutes` (mcp-core >= 1.22), vi redirect URI cua Web OAuth client phai dang ky truoc nen khong the la port loopback ngau nhien. `sub` cua nguoi goi di theo mot **state ky bang HMAC** (khoa HKDF rieng tu `CREDENTIAL_SECRET`, KHONG phai `JWTIssuer` — token do se la Bearer dung duoc cho `/mcp`). State la single-use (nonce claim qua KV) va **KHONG mang co make-primary**: state di qua browser + Google, ai cam duoc no se doat duoc default account. Remote doi default bang `account_set_default`.
- Ghi credential o callback remote duoc **serialize theo subject**: `AccountStore.put` la read-modify-write tren mot blob (write-then-rename), ma remote khong co flow object de giu guard mot-consent nhu stdio.
- Nang tu M1 (blob phang): server tu nhan ve (adopt) khi suy duoc email tu `id_token` — offline, la case thuong gap vi M1 xin `openid`+`email` va luu ca token response. Neu khong suy duoc thi hoi Google userinfo (CAN MANG). Ca hai that bai: state ve `awaiting_setup`, server mo OAuth, va lan consent DO GHI DUOC — `put(..., {absorbLegacy: true})` mang blob cu sang key `UNIDENTIFIED_ACCOUNT = '(unidentified)'` thay vi de len no. Account vua consent thanh primary; `(unidentified)` hien o `account_list`, xoa duoc bang `account_remove`, va `remove()` KHONG de no len primary khi con account thuc. Da viet ro trong README + `src/docs/config.md`.
- Guard cua `put()` VAN nguyen tac dung cho duong goi truc tiep khong kem `absorbLegacy` (test khang dinh ca hai chieu). Chi `WorkspaceAuth.saveTokens` truyen co do — moi caller ngoai cua no (`runOAuthSetup`, `startAddAccount`) dung sau mot lan consent nguoi dung vua hoan tat. **Ly do co nay ton tai**: khong co no thi guard chan chinh lan ghi cua consent → startup fail, ma `setup_reset` lai can server dang chay = trang thai khong thoat duoc bang cong cu trong san pham (chi con xoa tay `~/.better-workspace-mcp/config.json`). Them guard thi phai hoi: duong PHUC HOI co di qua chinh cai vua chan khong?
- Scope Forms (`forms.body`, `forms.responses.readonly`) da xin san o M2 nen M4 KHONG them scope nao. Nhung Google KHONG noi quyen cho token da phat: account cap quyen TRUOC thay doi do, lan goi `forms` dau tien se dinh 403 `Request had insufficient authentication scopes`; chua bang `config(action="account_add")` dang nhap DUNG account do (`prompt=consent` nen consent screen luon hien, va `AccountStore.put` ghi de record cu tai cho — khong can `account_remove` truoc). Account them sau thi khong dinh. Da viet trong README + `src/docs/forms.md`.

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
- `type-check` chay CA HAI pass: `tsc --noEmit` (server, types node) va `tsc --noEmit -p tsconfig.worker.json` (`src/worker.ts`, types `@cloudflare/workers-types`). `tsconfig.json` `exclude` worker.ts khoi pass dau. Luu y: `exclude` KHONG chan mot file bi check khi file trong `include` import no — nen test cua worker phai nam o `tests/worker.test.ts`, KHONG phai `src/worker.test.ts` (dat trong `src/` se keo worker.ts nguoc vao pass node-typed va fail o `cloudflare:workers`).
- Test surface: 378 test / 25 file = unit + component + 2 hermetic protocol E2E (`tests/protocol/m1-stdio.test.ts`, `tests/protocol/m2-multi-account.test.ts` — stdio_client spawn bin/cli.mjs, seeded token, no real network). Real-Google smoke = thu cong (manual, ngoai CI — can OAuth client + consent). Smoke 2 account cua M2 DA CHAY 2026-07-25, 6/6 buoc PASS: M1 flat blob -> v2 adopt offline giu nguyen `refresh_token`; account thu 2 them qua `account_add`; `getMe` tra 2 danh tinh khac nhau; `drive.search` tra data khac nhau theo account; account la truyen vao bi tu choi DUNG TEN (khong am tham fallback ve primary); force-expire refresh chi cap nhat account B, token account A byte-identical. Chi tiet + cach tai hien: `.private/superpower/better-workspace-mcp/m2-task9-live-smoke-2026-07-25.md`.

## Dependency dac biet

`@n24q02m/mcp-core` pin `1.22.0-beta.1` (exact, khong caret — de moi lan doi mcp-core deu di qua mot Renovate PR + CI). Day la BETA co chu dich: `dist-tags.latest` van la `1.21.0`, nhung M3 can hai thu chi co tu `1.22.0-beta.1`:
- `extraRoutes: HttpRoute[]` — duong DUY NHAT de consumer so huu mot endpoint trong process cua `runHttpServer`. `/mcp` + `/health` duoc thu TRUOC (khong shadow duoc), OAuth app la catch-all cho phan con lai, nen route dang ky o day nam giua. Dung cho `/accounts/callback`.
- `openBrowser?: boolean` — tat tab tu-mo cua mcp-core khi consumer da tu dua URL cho nguoi dung. Dat `false` o `add-account.ts`. **KHONG** dat o `oauth-setup.ts`: do la duong setup lan dau, tat tab se giet trai nghiem cua nguoi khong doc stderr.

Cai nay KHONG thay the grace window cua `consent-server.ts` — no bo mot NGUON tab (mcp-core), con tab muon do nguoi dung tu bam lai thi van can cho dap xuong.
