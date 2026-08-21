# Phase 02 — SQLite, scope와 사건 저널

- 상태: `IN_PROGRESS`
- 진행률: 4/8
- 선행 phase: Phase 01 `DONE`
- 주요 근거: ADR-001, ADR-002, ADR-003, ADR-005, ADR-011
- 선행 증거 감사: [Phase 02 baseline과 production gap](evidence-audit.md#phase-02-storage)
- 종료 조건: server bootstrap부터 안전한 statement event append와 FTS trigger까지 실제
  SQLite file에서 원자적으로 동작하고 재개방·동시 reader 검증을 통과함

> evidence audit의 `[x]`는 기존 증거 대조 완료다. 아래 작업의 `TODO/DONE`과 production
> 완료 체크를 대신하지 않는다.

## 작업 현황

| ID | 작업 | 상태 | Owner | 선행 작업 | 증거 |
|---|---|---|---|---|---|
| STO-001 | DB 경로·SQLite capability startup gate | `DONE` | `log0629` | FND-001, FND-003 | [운영 계약](../operations/storage.md), [PR #13](https://github.com/yeonjaekim99/knowledge-graph/pull/13) |
| STO-002 | connection factory와 writer 직렬화 | `DONE` | `log0629` | STO-001 | [구현 결정](../implementation/sto-002-sqlite-connections.md), [PR #14](https://github.com/yeonjaekim99/knowledge-graph/pull/14) |
| STO-003 | migration runner와 checksum 검증 | `DONE` | `log0629` | STO-001 | [구현 결정](../implementation/sto-003-sqlite-migrations.md), [PR #15](https://github.com/yeonjaekim99/knowledge-graph/pull/15) |
| STO-004 | v1 journal·projection·FTS schema | `DONE` | `log0629` | STO-003 | [구현 결정](../implementation/sto-004-v1-sqlite-schema.md), [PR #16](https://github.com/yeonjaekim99/knowledge-graph/pull/16) |
| STO-005 | scope resolver와 deployment config | `TODO` | `unassigned` | FND-003 | — |
| STO-006 | actor·branch·session metadata provider | `TODO` | `unassigned` | STO-005 | — |
| STO-007 | event ID와 append-only journal repository | `TODO` | `unassigned` | STO-002, STO-004~006 | — |
| STO-008 | storage recovery·concurrency integration | `TODO` | `unassigned` | STO-001~007 | — |

## 상세 체크리스트

### STO-001 — DB 경로·SQLite capability startup gate

- 상태: `DONE`
- Owner: `log0629`
- Branch: `sto-001-sqlite-startup-gate`
- 근거: ADR-005
- 선행 작업: FND-001, FND-003
- 결과물: database path validator와 capability smoke test

완료 체크:

- [x] 로컬 filesystem 경로만 지원하고 network filesystem 위험을 startup에서 안내한다.
- [x] FTS5, trigram, JSON 함수와 `unixepoch()`를 실제 query로 검증한다.
- [x] 필수 capability 하나라도 없으면 tool을 노출하기 전에 명확히 실패한다.
- [x] DB/WAL/backup 기본 권한 정책을 배포 문서와 test에 고정한다.

증거:

- 구현: [`startup-gate.ts`](../../src/adapters/sqlite/startup-gate.ts),
  [SQLite 저장 경로와 startup 운영 계약](../operations/storage.md)
- PR: [#13](https://github.com/yeonjaekim99/knowledge-graph/pull/13)
- TDD: `pnpm test:integration` 최초 0 pass / 1 file failure 후
  `pnpm test:sto-001` 9/9 통과
- 검증: `pnpm verify:local` 54/54, `python3 docs/roadmap/validate.py`, behavior spike 25/25,
  깨끗한 `git archive` frozen install·전체 gate와 `pnpm audit --prod`
- 범위 경계: S01의 capability startup만 production으로 이전했다. 영구 FTS schema/rebuild와
  normalize는 `STO-004`/`PRJ-002`, WAL·connection queue는 `STO-002`, 실제 tool startup
  연결은 `MCP-001`이 소유하므로 scenario manifest는 `planned`를 유지한다.

### STO-002 — connection factory와 writer 직렬화

- 상태: `DONE`
- Owner: `log0629`
- Branch: `sto-002-sqlite-connection-queue`
- 근거: ADR-001, ADR-005
- 선행 작업: STO-001
- 결과물: connection factory, process write queue와 transaction helper

완료 체크:

- [x] 최초 writer만 WAL을 설정하고 이후 연결은 `wal` 반환값을 검증한다.
- [x] 모든 연결에 foreign_keys, busy_timeout, cache와 temp_store 정책을 적용한다.
- [x] `BEGIN IMMEDIATE` write를 process 내부 queue로 직렬화한다.
- [x] 5초 lock 실패를 retryable typed error로 변환한다.

증거:

- 구현: [`connection-factory.ts`](../../src/adapters/sqlite/connection-factory.ts),
  [`connection-worker.ts`](../../src/adapters/sqlite/connection-worker.ts),
  [connection/queue 구현 결정](../implementation/sto-002-sqlite-connections.md)
- PR: [#14](https://github.com/yeonjaekim99/knowledge-graph/pull/14)
- TDD: `pnpm test:sto-002` 최초 missing production export로 0 test / 1 file failure 후
  실제 file-backed 정상·경계·실패 5/5 통과
- 검증: `pnpm verify:local` 59/59, `python3 docs/roadmap/validate.py`, behavior spike 25/25,
  `pnpm audit --prod` 알려진 production 취약점 0개와 깨끗한 `git archive` 전체 gate
- 범위 경계: S20의 connection/lock slice만 production으로 이전했다. migration/schema,
  journal/projector transaction과 8-client/process recovery는 STO-003/004/007/008 및
  REL-004가 소유하므로 S20 manifest는 `planned`를 유지한다.

### STO-003 — migration runner와 checksum 검증

- 상태: `DONE`
- Owner: `log0629`
- Branch: `sto-003-sqlite-migration-runner`
- PR: [#15](https://github.com/yeonjaekim99/knowledge-graph/pull/15)
- 근거: ADR-001과 spike reopen finding
- 선행 작업: STO-001
- 결과물: immutable versioned migration runner

완료 체크:

- [x] migration을 1부터 순서대로 transaction 적용하고 lowercase SHA-256을 저장한다.
- [x] 이미 적용된 version의 name/checksum 불일치와 미래 version에서 시작을 거부한다.
- [x] 정상 reopen과 process crash reopen이 idempotent하다.
- [x] 적용된 migration 수정 대신 새 version만 허용하는 검사가 있다.

증거:

- 구현: [`migration.ts`](../../src/adapters/sqlite/migration.ts),
  [`connection-worker.ts`](../../src/adapters/sqlite/connection-worker.ts),
  [migration runner 구현 결정](../implementation/sto-003-sqlite-migrations.md),
  [storage 운영 계약](../operations/storage.md)
- PR: [#15](https://github.com/yeonjaekim99/knowledge-graph/pull/15)
- TDD: `pnpm test:sto-003` 최초 missing production export로 0 test / 2 file failure 후,
  실제 file-backed integration·hard-exit 정상·경계·실패 6/6 통과
- 검증: `pnpm verify:local` 65/65, `python3 docs/roadmap/validate.py`, behavior spike 25/25,
  `pnpm audit --prod` 알려진 production 취약점 0개와 깨끗한 `git archive` 전체 gate
- 범위 경계: exact-byte migration/history와 reopen 조각만 production으로 이전했다. 최초 v1
  schema와 실제 startup wiring은 STO-004/MCP-001, journal/projector 전체 crash·concurrency는
  STO-007/008 이후가 소유하므로 S24 scenario manifest는 `planned`를 유지한다.

### STO-004 — v1 journal·projection·FTS schema

- 상태: `DONE`
- Owner: `log0629`
- Branch: `sto-004-v1-sqlite-schema`
- PR: [#16](https://github.com/yeonjaekim99/knowledge-graph/pull/16)
- 근거: ADR-001, ADR-002, ADR-005, ADR-007
- 선행 작업: STO-003
- 결과물: 규범 DDL migration

완료 체크:

- [x] journal, projection, redirects, projection_meta와 schema_migrations DDL이 ADR과 같다.
- [x] contentless trigram FTS와 statement INSERT trigger가 생성된다.
- [x] 한국어 3글자 부분 MATCH와 2글자 미지원 경계, delete-all/rebuild/optimize 결과를 고정한다.
- [x] partial unique, XOR, FK와 CHECK 제약을 실제 실패 fixture로 검증한다.
- [x] `PRAGMA foreign_key_check`가 빈 결과다.

증거:

- 구현: [`001-v1-schema.sql`](../../src/adapters/sqlite/migrations/001-v1-schema.sql),
  [`bundled-migrations.ts`](../../src/adapters/sqlite/bundled-migrations.ts),
  [v1 schema 구현 결정](../implementation/sto-004-v1-sqlite-schema.md),
  [storage 운영 계약](../operations/storage.md)
- test: [`sto-004-v1-schema.test.mjs`](../../test/integration/sqlite/sto-004-v1-schema.test.mjs)
- PR: [#16](https://github.com/yeonjaekim99/knowledge-graph/pull/16)
- TDD: `pnpm test:sto-004` 최초 missing production export로 0 test / 1 file failure 후,
  실제 file-backed schema·FTS·constraint 정상·경계·실패 4/4 통과
- 검증: `pnpm verify:local` 69/69, `python3 docs/roadmap/validate.py`, behavior spike 25/25,
  `pnpm audit --prod` 알려진 production 취약점 0개와 깨끗한 `git archive` frozen install·전체 gate
- 범위 경계: S01의 physical DDL·FTS/rebuild 조각만 production으로 이전했다. normalize,
  journal append·recovery, projector/recall query와 MCP startup wiring은 PRJ-002, STO-007~008,
  Phase 03·06과 MCP-001이 소유하므로 S01 scenario manifest는 `planned`를 유지한다.

### STO-005 — scope resolver와 deployment config

- 상태: `TODO`
- Owner: `unassigned`
- 근거: ADR-003
- 선행 작업: FND-003
- 결과물: immutable project config와 request principal scope resolver

완료 체크:

- [ ] `u:{user_id}/p:{project_id}` 형식과 길이를 검증한다.
- [ ] local은 명시적 user/project, remote는 검증된 principal로 user를 결정한다.
- [ ] scope 관련 값이 public tool input에 존재하지 않는다.
- [ ] 누락된 인증/config에서는 tool을 제공하지 않고 cross-scope fallback도 없다.

### STO-006 — actor·branch·session metadata provider

- 상태: `TODO`
- Owner: `unassigned`
- 근거: ADR-003, ADR-011, ADR-016
- 선행 작업: STO-005
- 결과물: nullable normalized metadata adapter

완료 체크:

- [ ] actor는 관찰한 client info에서만 얻고 제어문자 제거·128자 상한을 적용한다.
- [ ] branch는 설정된 작업 경로의 symbolic/detached/non-git 상태를 구분한다.
- [ ] session 원문은 저장하지 않고 key가 있을 때만 HMAC 상관키로 바꾼다.
- [ ] metadata secret hit는 마스킹/NULL 처리되고 scope나 identity에 참여하지 않는다.

### STO-007 — event ID와 append-only journal repository

- 상태: `TODO`
- Owner: `unassigned`
- 근거: ADR-001, ADR-002, ADR-005
- 선행 작업: STO-002, STO-004~006
- 결과물: validated event append API

완료 체크:

- [ ] event ID는 canonical `ev_` ULID이고 순서는 journal seq만 사용한다.
- [ ] rare ULID collision은 성공 응답 전 같은 transaction 정책으로 안전하게 재시도한다.
- [ ] production code에 journal UPDATE/DELETE API가 없다.
- [ ] statement append와 FTS trigger가 같은 transaction에서 commit/rollback된다.
- [ ] body JSON text와 epoch 초가 byte 안정적으로 보존된다.

### STO-008 — storage recovery·concurrency integration

- 상태: `TODO`
- Owner: `unassigned`
- 근거: ADR-001, ADR-005와 spike S20/S24
- 선행 작업: STO-001~007
- 결과물: file-backed process/concurrency integration suite

완료 체크:

- [ ] journal INSERT 전후와 commit 경계 process exit가 이전/새 완전 상태만 남긴다.
- [ ] 여러 WAL reader가 writer commit 전 일관된 snapshot을 읽는다.
- [ ] 8-client 혼합 부하는 Phase 08에서 재사용 가능한 fixture로 준비된다.
- [ ] 재개방 후 seq/ID, FTS rowid와 migration checksum이 일관되고 계속 쓸 수 있다.

## Phase 종료 체크

- [ ] 깨끗한 DB와 기존 DB startup이 모두 검증됐다.
- [ ] scope 없이 또는 잘못된 SQLite 환경에서 server가 fail-closed한다.
- [ ] journal append 성공/실패와 FTS가 원자적이다.
- [ ] Phase 03 reducer가 사용할 transaction·schema interface가 고정됐다.
