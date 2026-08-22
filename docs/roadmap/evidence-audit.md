# 기존 증거와 production 잔여 gate 감사

- 감사일: 2026-08-22
- 범위: Phase 01~08의 active 제품 작업 66개와 retired stable ID 1개
- 기준: Accepted ADR-001~017, ADR 전체 리뷰, behavior spike S01~S24와 연결된 구현 PR
- 결과: **historical 제품 ID 67개의 선행 증거와 production 잔여 gate·범위 제외 분류 완료**

## 표기와 상태 의미

아래 `[x]`는 **해당 작업의 evidence-gap 대조가 끝났다는 뜻**이다. 제품 작업이 구현됐거나
`DONE`이라는 뜻이 아니다. 제품 상태와 완료 조건은 각 phase 문서의 작업 현황과
`완료 체크`만이 결정한다.

- `baseline`: 이미 `main`에 병합돼 재사용할 수 있는 결정·실행 증거다.
- `production`: 해당 작업이 실제로 닫아야 하는 구현·통합·운영 gate다.
- spike는 feasibility와 상태 의미의 oracle이다. 선택한 production adapter, 배포 환경,
  성능과 공개 MCP transport의 증거를 대신하지 않는다.
- 작업을 제안하거나 시작할 때 baseline을 새 과제로 설명하지 않고 production 열의 차이만
  범위로 잡는다.

## 증거 묶음

| 코드 | 완료 증거 | 재사용 범위 | 한계 |
|---|---|---|---|
| `E-ADR` | [PR #1](https://github.com/yeonjaekim99/knowledge-graph/pull/1), [Accepted ADR](../adr/README.md) | 17개 결정과 Validation, 교차 리뷰 | production API·성능·배포를 실행한 것은 아님 |
| `E-SQL` | [ADR 전체 리뷰](../adr/review.md) | Python 3.12/SQLite 3.45.1의 통합 DDL·FTS·제약 query | 선택할 production driver 증거는 아님 |
| `E-SPIKE` | [PR #2](https://github.com/yeonjaekim99/knowledge-graph/pull/2), [spike report](../spikes/adr-behavior-report.md) | S01~S24, 25 tests, 288 prefix, 8 crash case | MCP transport·증분 projector·10만 규모는 제외 |
| `E-ROADMAP` | [PR #3](https://github.com/yeonjaekim99/knowledge-graph/pull/3) | stable task, 의존성, 추적성, validator | 제품 구현과 작업별 로컬 검증 증거는 아님 |
| `E-AGENT` | [PR #4](https://github.com/yeonjaekim99/knowledge-graph/pull/4) | 공통 agent 작업 계약과 Claude import | 규칙 준수 여부는 각 작업에서 계속 리뷰 |
| `E-STACK` | [PR #6](https://github.com/yeonjaekim99/knowledge-graph/pull/6), [production 기술 스택](../implementation/fnd-001-production-stack.md) | Node/pnpm/TypeScript/MCP SDK/SQLite driver pin과 실제 MCP·SQLite·native 배포 probe | 제품 모듈 경계·schema source·전체 로컬 test 계층과 지원 target별 release 검증은 후속 작업 |
| `E-ARCH` | [PR #7](https://github.com/yeonjaekim99/knowledge-graph/pull/7), [제품 모듈과 의존 방향](../implementation/fnd-002-module-boundaries.md) | 실제 TypeScript layer, atomic write port, package export 제한, import guard와 pure reducer fixture | runtime provider·규범 schema·실제 SQLite/projector 구현과 전체 test 계층은 후속 작업 |
| `E-RUNTIME` | [PR #8](https://github.com/yeonjaekim99/knowledge-graph/pull/8), [결정적 runtime 경계](../implementation/fnd-003-runtime-boundaries.md) | request-scoped runtime port, Node clock/CSPRNG·canonical ULID/token, 고정 evaluation time, deterministic provider와 domain ambient-runtime guard | concrete scope/metadata와 journal 연결은 별도 evidence, public schema 연결은 후속 작업 |
| `E-SCHEMA` | [PR #9](https://github.com/yeonjaekim99/knowledge-graph/pull/9), [public/domain schema 단일 출처](../implementation/fnd-004-schema-source.md) | Draft 2020-12 규범 source, type 추론, MCP runtime validator, 닫힌 object/oneOf/XOR/min-max fixture와 canonical serialization | 실제 세 tool schema·application 의미 검증·catalog/structuredContent wiring과 전체 로컬 drift 검증은 후속 작업 |
| `E-TEST` | [PR #11](https://github.com/yeonjaekim99/knowledge-graph/pull/11), [로컬 TDD 테스트 전략](../implementation/fnd-005-test-strategy.md), [테스트 계층](../../test/README.md) | 7개 계층, 고정 실행 문맥, S01~S24 production 이전 manifest와 증분/full replay canonical parity harness | 실제 SQLite/projector/MCP/process 동작과 10만 규모 test는 각 후속 owner 작업이 구현 |
| `E-BOOTSTRAP` | [PR #12](https://github.com/yeonjaekim99/knowledge-graph/pull/12), [기여 가이드](../../CONTRIBUTING.md), [README 빠른 시작](../../README.md#빠른-시작) | exact runtime과 frozen install, 로컬 TDD·검증·PR 흐름, 안전한 scratch DB 경계와 clean source 재현 | DB startup과 scope config는 별도 production evidence가 소유하고 지원 target packaging은 REL-009가 구현 |
| `E-SQLITE-STARTUP` | [PR #13](https://github.com/yeonjaekim99/knowledge-graph/pull/13), [storage 운영 계약](../operations/storage.md), [integration test](../../test/integration/sqlite/sto-001-startup-gate.test.mjs) | 실제 file DB의 절대 경로·local filesystem·권한 gate와 FTS5/trigram/JSON/unixepoch fail-closed readiness | WAL/queue, migration, 영구 schema, scope와 MCP tool 조립은 후속 작업 |
| `E-SQLITE-CONNECTION` | [PR #14](https://github.com/yeonjaekim99/knowledge-graph/pull/14), [connection/queue 구현 결정](../implementation/sto-002-sqlite-connections.md), [integration test](../../test/integration/sqlite/sto-002-connection-factory.test.mjs) | worker-backed writer/readers, WAL·PRAGMA 검증, FIFO `BEGIN IMMEDIATE`, 실제 5초 busy·reader/event-loop 진행과 safe typed error | append는 `E-JOURNAL-APPEND`, WAL 8-client/recovery는 `E-STORAGE-RECOVERY`; projector transaction과 실제 MCP load는 후속 작업 |
| `E-SQLITE-MIGRATION` | [PR #15](https://github.com/yeonjaekim99/knowledge-graph/pull/15), [migration runner 구현 결정](../implementation/sto-003-sqlite-migrations.md), [integration test](../../test/integration/sqlite/sto-003-migration-runner.test.mjs), [process test](../../test/e2e/process/sto-003-migration-crash-reopen.test.mjs) | exact-byte checksum, version/name history, 단일 writer transaction, 정상·hard-exit reopen과 safe typed error | journal/FTS recovery는 `E-STORAGE-RECOVERY`; MCP startup wiring과 journal+projection 전체 crash는 후속 작업 |
| `E-SQLITE-SCHEMA` | [PR #16](https://github.com/yeonjaekim99/knowledge-graph/pull/16), [v1 schema 구현 결정](../implementation/sto-004-v1-sqlite-schema.md), [migration SQL](../../src/adapters/sqlite/migrations/001-v1-schema.sql), [integration test](../../test/integration/sqlite/sto-004-v1-schema.test.mjs) | exact-byte bundled v1 DDL, contentless trigram FTS·rebuild, 한국어 경계, partial unique/XOR/CHECK/FK 실패와 `foreign_key_check` | append는 `E-JOURNAL-APPEND`, recovery는 `E-STORAGE-RECOVERY`; projector/recall query와 MCP startup 조립은 후속 작업 |
| `E-TRUSTED-SCOPE` | [PR #17](https://github.com/yeonjaekim99/knowledge-graph/pull/17), [scope 구현 결정](../implementation/sto-005-scope-resolver.md), [scope 운영 계약](../operations/scope.md), [foundation test](../../test/foundation/sto-005-scope-provider.test.mjs) | immutable project, explicit local user, authenticated remote principal, exact key·ASCII boundary와 fail-closed/no-fallback provider | journal append 연결은 `E-JOURNAL-APPEND`, actual authentication/tool lifecycle·query predicate와 concurrent request isolation은 후속 작업 |
| `E-TRUSTED-METADATA` | [PR #18](https://github.com/yeonjaekim99/knowledge-graph/pull/18), [metadata 구현 결정](../implementation/sto-006-runtime-metadata.md), [metadata 운영 계약](../operations/metadata.md), [foundation test](../../test/foundation/sto-006-metadata-provider.test.mjs) | observed actor 정리, symbolic/detached/non-Git branch, optional keyed session correlation과 sanitizer/Git field-local failure | journal append 연결은 `E-JOURNAL-APPEND`; detector/masking, actual MCP request context와 log/DB leak 검증은 후속 작업 |
| `E-JOURNAL-APPEND` | [PR #19](https://github.com/yeonjaekim99/knowledge-graph/pull/19), [append 구현 결정](../implementation/sto-007-append-only-journal.md), [integration test](../../test/integration/sqlite/sto-007-journal-repository.test.mjs) | canonical event ID 검증, exact envelope 보존, guarded whole-batch INSERT와 UNIQUE retry, statement/FTS rollback, private append-only API | process/WAL recovery는 `E-STORAGE-RECOVERY`; projection 의미·journal+projection 성공 원자성, detector와 public MCP wiring은 후속 작업 |
| `E-STORAGE-RECOVERY` | [PR #20](https://github.com/yeonjaekim99/knowledge-graph/pull/20), [recovery/concurrency 결정](../implementation/sto-008-storage-recovery-concurrency.md), [S20 target](../../test/e2e/process/s20-wal-concurrent-clients.test.mjs), [crash/reopen test](../../test/e2e/process/sto-008-journal-crash-reopen.test.mjs) | IPC hard exit의 old/complete-new journal·FTS, migration/FK/seq/ID reopen, 4 logical writer+4 WAL reader와 재사용 fixture | projection/correct/full replay crash parity, actual MCP load·다중 writer process와 10만 규모는 후속 작업 |
| `E-PROJECTION-REPLAY` | [PR #21](https://github.com/yeonjaekim99/knowledge-graph/pull/21), [scope replay 결정](../implementation/prj-001-replay-contract.md), [domain test](../../test/unit/domain/prj-001-replay-contract.test.mjs), [integration test](../../test/integration/projection/prj-001-scope-replay.test.mjs) | clock-free scope/rules/journal reducer 입력, worker-held 원자 교체와 meta 판정, rollback·WAL reader·scope isolation, 독립 canonical dump parity | normalize·ID·pre-scan은 후속 evidence에서 완료; entity/claim 의미는 PRJ-005~008, append/project dispatcher와 S02/S24 parity는 PRJ-009/010 |
| `E-PROJECTION-RULES` | [PR #22](https://github.com/yeonjaekim99/knowledge-graph/pull/22), [rules 구현 결정](../implementation/prj-002-normalization-relations.md), [domain test](../../test/unit/domain/prj-002-normalization-relations.test.mjs), [locale process test](../../test/e2e/process/prj-002-normalization-locale.test.mjs) | versioned normalize와 literal identity, immutable relation registry·label 검증, C/Turkish locale 결정성과 safe typed error | entity/surface·claim reducer는 PRJ-005/006, aggregate label은 PRJ-008, rules 조립·S01/S03 parity는 PRJ-009/010 |
| `E-PROJECTION-IDENTIFIERS` | [PR #23](https://github.com/yeonjaekim99/knowledge-graph/pull/23), [ID 구현 결정](../implementation/prj-003-occurrence-redirects.md), [domain test](../../test/unit/domain/prj-003-occurrence-redirects.test.mjs) | 저장 occurrence 후보, numeric canonical/merge keep, scope·kind redirect 압축·손상 방어와 one-to-many rules 배포 차단 | event pre-scan은 `E-PROJECTION-PRE-SCAN`; entity/claim reducer와 DB publish는 PRJ-005~009, input/stored index mapping은 REC-005, 전체 S03/S07/S23/S24 parity는 PRJ-010 |
| `E-PROJECTION-PRE-SCAN` | [PR #24](https://github.com/yeonjaekim99/knowledge-graph/pull/24), [pre-scan 구현 결정](../implementation/prj-004-event-pre-scan.md), [domain test](../../test/unit/domain/prj-004-event-pre-scan.test.mjs) | scope-bound retraction/supersedes 검증, cascade와 live-leaf 상태, 실제 occurrence ID·recorded 시각을 보존한 root-order effective stream, deep-chain stack 방어와 safe typed error | entity/surface·claim/support·merge/alias reducer는 PRJ-005~008, SQLite dispatcher/prefix parity와 S14/S15 완결은 PRJ-009/010 |

상세 scenario-to-task 연결은 [ADR·spike 추적성](traceability.md)이 소유한다. 이 문서는
그 연결을 작업 시작 관점에서 다시 읽어 “무엇을 재사용하고 무엇이 남았는가”를 고정한다.

## Phase 01 Foundation

- [x] `FND-001` | baseline: `E-ADR`이 MCP 계약 요구를 확정했고 `E-SQL`과 S01/S20이 Python/SQLite feasibility를 확인했다. | production: `E-STACK`에서 runtime·package manager·SQLite driver·MCP SDK 선택과 실제 API·배포 probe를 완료했다.
- [x] `FND-002` | baseline: `E-ADR`과 `E-SPIKE`가 journal/projection 분리와 pure deterministic oracle의 성립을 확인했다. | production: `E-ARCH`에서 실제 package/module 경계, atomic write port와 dependency/import guard를 완료했다.
- [x] `FND-003` | baseline: 고정 clock·ID·scope를 사용한 S02/S09/S14~S16/S23과 `E-ARCH`의 pure reducer seam이 결정성 요구를 확인했다. | production: `E-RUNTIME`에서 동일 계약의 request-scoped provider, Node clock/CSPRNG·canonical ID/token, deterministic provider와 ambient-runtime guard를 완료했다.
- [x] `FND-004` | baseline: ADR-013~016이 public/domain schema 규범과 union/XOR를 확정했고 `E-ARCH`가 schema를 둘 application/package 경계를 제공한다. | production: `E-SCHEMA`에서 선택한 stack의 단일 schema source, runtime validation과 drift 검사를 완료했다.
- [x] `FND-005` | baseline: `E-SPIKE`가 S01~S24 reference oracle을, `E-ARCH`·`E-RUNTIME`·`E-SCHEMA`가 targeted Node test, deterministic provider, schema fixture와 architecture guard를 제공한다. | production: `E-TEST`에서 unit/integration/contract/e2e/performance 계층, 기계 판독 scenario 이전 계획과 black-box parity helper를 완료했다.
- [x] `FND-006` | baseline: `E-ROADMAP` validator가 문서·의존성·추적성을 로컬에서 검사한다. | production: 2026-08-21 maintainer 결정으로 Recall v1 active 범위에서 제외했다. 안정적 ID는 [결정](../implementation/fnd-006-ci-retirement.md)과 registry에 남기고 로컬 검증 책임은 FND-005/FND-007이 소유한다.
- [x] `FND-007` | baseline: `E-ROADMAP`과 `E-AGENT`가 branch·PR·상태·증거 운영 규칙을 제공한다. | production: `E-BOOTSTRAP`에서 깨끗한 checkout 설치·실행, DB 안전 경로와 기계 검증되는 기여 흐름을 완료했다.

## Phase 02 Storage

- [x] `STO-001` | baseline: S01과 `E-SQL`이 FTS5 trigram·JSON·`unixepoch()` capability를 확인했다. | production: `E-SQLITE-STARTUP`에서 선택한 driver와 실제 DB 경로의 startup fail-closed·권한 정책을 완료했다.
- [x] `STO-002` | baseline: S20이 직렬 writer와 동시 WAL reader의 성립을 확인했다. | production: `E-SQLITE-CONNECTION`에서 connection factory·worker write queue·PRAGMA·5초 busy error를 실제 file DB로 완료했다.
- [x] `STO-003` | baseline: S24와 spike reopen 결함 수정이 version/name/checksum 검증 필요성을 확인했다. | production: `E-SQLITE-MIGRATION`에서 immutable runner, exact-byte checksum과 정상·hard-exit reopen을 완료했다.
- [x] `STO-004` | baseline: `E-SQL`과 S01이 규범 DDL, contentless FTS, 제약과 rebuild를 실행했다. | production: `E-SQLITE-SCHEMA`에서 selected driver용 bundled migration, exact-byte 배포와 실제 실패 fixture를 완료했다.
- [x] `STO-005` | baseline: S09가 두 scope 격리와 cross-scope ID 차단을 확인했고 `E-RUNTIME`이 tool 인자 없는 scope port와 출력 검증을 제공한다. | production: `E-TRUSTED-SCOPE`에서 인증 principal·immutable project config 기반 concrete resolver, explicit local identity와 identity 부재 fail-closed를 완료했다.
- [x] `STO-006` | baseline: ADR-003/011/016이 actor·branch·session 출처와 마스킹 경계를 확정했고 `E-RUNTIME`이 metadata port와 출력 검증을 제공한다. | production: `E-TRUSTED-METADATA`에서 client 정리, symbolic/detached/non-Git branch, session HMAC과 nullable secret-gate integration을 완료했다.
- [x] `STO-007` | baseline: S02/S24가 append rollback·seq/ID 연속성과 FTS 원자성을 확인했고 `E-RUNTIME`이 canonical ULID generator를 제공한다. | production: `E-JOURNAL-APPEND`에서 UNIQUE 충돌 whole-batch retry와 append-only journal repository를 실제 transaction으로 완료했다.
- [x] `STO-008` | baseline: S20/S24가 소규모 동시성·process crash·재개방 oracle을 제공한다. | production: `E-STORAGE-RECOVERY`에서 file-backed journal/FTS recovery, S20 WAL target과 Phase 08 재사용 8-client fixture를 완료했다.

## Phase 03 Projection

- [x] `PRJ-001` | baseline: S02/S23이 반복 replay와 canonical checksum 결정성을 확인했고 `E-RUNTIME`이 결정적 runtime seam을 제공한다. | production: `E-PROJECTION-REPLAY`에서 scope/rules/journal 전용 reducer 입력, projection meta 판정, 원자 scope 교체·rollback과 canonical dump를 완료했다.
- [x] `PRJ-002` | baseline: S01/S03과 ADR-004/006/009가 normalize·relation·literal identity를 확인했다. | production: `E-PROJECTION-RULES`에서 versioned primitive, immutable registry와 locale/relation fixture를 완료했다.
- [x] `PRJ-003` | baseline: S03/S07/S23/S24가 occurrence 위치·redirect·stable ID 불변식을 확인했다. | production: `E-PROJECTION-IDENTIFIERS`에서 후보 ID, canonical 선택, redirect registry·손상 방어와 rules dry-run을 완료했다.
- [x] `PRJ-004` | baseline: S14~S16이 effective metadata/order·cascade·approval 경계를 확인했다. | production: `E-PROJECTION-PRE-SCAN`에서 사건 효력, actual/root 순서와 metadata를 분리한 effective stream을 완료했다.
- [x] `PRJ-005` | baseline: S08/S21이 entity·surface origin과 confirmed alias 후속 해석을 확인했다. | production: entity/surface/kind reducer와 모호성·철회 fixture를 구현한다.
- [x] `PRJ-006` | baseline: S03/S04/S10/S15가 강화·describes·TTL 비구조화·복원 차이를 확인했다. | production: claim/support/cardinality reducer와 의미 순서 test를 구현한다.
- [x] `PRJ-007` | baseline: S07/S08/S17/S21이 merge·alias·support dedupe·undo를 확인했다. | production: collision-safe rewrite와 history-preserving undo reducer를 구현한다.
- [x] `PRJ-008` | baseline: S09~S11/S19/S23이 scope/now 기반 aggregate·label fallback·read-only를 확인했다. | production: 공통 aggregate source template과 invariant query를 구현한다.
- [x] `PRJ-009` | baseline: S02/S23/S24가 prefix replay·metamorphic·crash 원자성 oracle을 제공한다. | production: 증분 dispatcher와 전체 replay를 각각 구현하고 publish transaction을 보호한다.
- [x] `PRJ-010` | baseline: `E-SPIKE`의 S01~S24·288 prefix·8 crash case가 reference 결과를 제공한다. | production: 모든 prefix에서 별도 production reducer와 oracle의 black-box parity를 증명한다.

## Phase 04 Record

- [x] `REC-001` | baseline: ADR-013과 S03/S11/S14/S16/S18이 record 입력·결과 의미를 확인했고 `E-SCHEMA`가 규범 source·type/runtime seam을 제공한다. | production: 실제 Record JSON Schema와 domain 의미 검증 계약을 구현한다.
- [x] `REC-002` | baseline: S18이 대표 signature·entropy와 한국어 인접 token 위험을 확인했다. | production: provider registry·ASCII 경계·entropy corpus와 안전한 탐지 결과를 구현한다.
- [x] `REC-003` | baseline: S18이 journal 전 raw masking과 의미 draft 부분 거부를 확인했다. | production: 필드별 sanitation과 fail-closed transaction 경계를 구현한다.
- [x] `REC-004` | baseline: S21과 S08이 confirmed alias 기반 entity 해석을 확인했다. | production: write-time 다의 surface 해석과 actionable ambiguity를 구현한다.
- [x] `REC-005` | baseline: S03/S18이 duplicate draft·occurrence index·부분 성공 의미를 확인했다. | production: 의미 검증·dedupe·입력/저장 index mapping을 구현한다.
- [x] `REC-006` | baseline: S02/S06/S24가 append/project와 다중 사건 rollback 원자성을 확인했다. | production: statement append·증분 projection·RecordResult를 한 transaction에 구현한다.
- [x] `REC-007` | baseline: S11/S14~S16이 raw-only TTL·기본값·승인된 reinterpret 의미를 확인했고 `E-RUNTIME`이 canonical approval-token generator를 제공한다. | production: defaulting, request retry 의미와 scope/target/payload/through-seq에 묶인 approval record 경로를 구현한다.
- [x] `REC-008` | baseline: 관련 S03/S11/S14/S16/S18과 전체 spike suite가 회귀 oracle을 제공한다. | production: 보안 corpus·agent parsing fixture·application integration suite를 통과한다.

## Phase 05 Revise

- [x] `REV-001` | baseline: ADR-015와 S18이 action별 결과·fail-closed 의미를 확정했고 `E-SCHEMA`가 판별 union·typed result seam을 제공한다. | production: 실제 Revise 판별 union schema, preflight와 typed result를 구현한다.
- [x] `REV-002` | baseline: S09와 ADR review가 scope/redirect 및 lock 안 재판정 요구를 확인했다. | production: lock 전 순수 preflight와 lock 안 target 재해석을 구현한다.
- [x] `REV-003` | baseline: S04/S05/S15가 claim/event 범위·cascade·describes 복원 차이를 확인했다. | production: 실제 retraction event와 no-op/철회 cutoff를 구현한다.
- [x] `REV-004` | baseline: S06/S24가 correct 두 사건의 연속 seq와 batch rollback을 확인했다. | production: raw_text를 포함한 correct transaction과 결과를 구현한다.
- [x] `REV-005` | baseline: S07/S17이 merge dedupe·describes winner·event undo를 확인했다. | production: scope/cycle/no-op 검증과 merge event application을 구현한다.
- [x] `REV-006` | baseline: S08/S21이 alias origin 승격·후속 해석·철회 복원을 확인했다. | production: alias ambiguity·중복·event undo 경로를 구현한다.
- [x] `REV-007` | baseline: S04~S09/S15/S17/S18/S21과 crash oracle이 revise 회귀 기준을 제공한다. | production: 경합·retry·typed response·journal/projection parity suite를 통과한다.

## Phase 06 Recall

- [x] `RCL-001` | baseline: S09/S10/S19가 scope/now snapshot aggregate와 read-only 의미를 확인했고 `E-RUNTIME`이 고정 `evaluationNow`, `E-SCHEMA`가 output 계약 seam을 제공한다. | production: 같은 snapshot을 사용하는 TEMP aggregate와 실제 RecallResult 계약을 구현한다.
- [x] `RCL-002` | baseline: S01/S09/S21이 normalize·surface·alias seed 의미를 확인했다. | production: query term 후보와 surface seed cap·결정적 dedupe를 구현한다.
- [x] `RCL-003` | baseline: S01/S11/S22가 safe FTS·TTL·raw 부활 방지 fallback을 확인했다. | production: quoted query, 3글자 경계, FTS 21개와 raw-only 반환을 구현한다.
- [x] `RCL-004` | baseline: S19/S22가 overview 결정성·raw-only fallback을 확인했다. | production: overview seed cap·정렬·빈 결과 계약을 구현한다.
- [x] `RCL-005` | baseline: S12/S13이 양방향 BFS·literal 수집·최단 path·fanout 신호를 확인했다. | production: TEMP reached와 bounded traversal/collection을 구현한다.
- [x] `RCL-006` | baseline: S10/S12가 support·상충·ranking·문장 조합을 확인했다. | production: explicit aggregate alias와 결정적 SQL ranking/Answer 조합을 구현한다.
- [x] `RCL-007` | baseline: S13과 ADR-012/014가 절단 신호와 payload budget 계약을 확정했다. | production: detail 100개·1 MiB 예산과 모든 more_available 원인을 구현한다.
- [x] `RCL-008` | baseline: S09~S13/S19/S21/S22가 결정성·scope·TTL·read-only golden을 제공한다. | production: production recall의 negative/invariant/golden suite를 통과한다.
- [x] `RCL-009` | baseline: `E-SPIKE`는 기능 fixture를 제공하지만 production latency를 측정하지 않았다. | production: 대표 규모·warm/cold benchmark와 query plan을 기록한다.

## Phase 07 MCP

- [x] `MCP-001` | baseline: ADR-003/005/016이 lifecycle·context·startup 계약만 확정했고 MCP transport는 spike에서 제외했다. | production: 선택한 SDK로 entrypoint·transport adapter·graceful shutdown을 구현한다.
- [x] `MCP-002` | baseline: ADR-016이 세 tool 이름·순서·annotation 값을 확정했다. | production: 실제 tools/list catalog와 canonical serialization을 구현한다.
- [x] `MCP-003` | baseline: ADR-013~016이 input/output schema와 structuredContent 의미를 확정했고 `E-SCHEMA`가 같은 source의 advertised/runtime input-output 검증을 확인했다. | production: 실제 세 tool schema를 SDK catalog와 response serializer에 연결한다.
- [x] `MCP-004` | baseline: ADR-016이 호출/미호출·relation·alias·instruction 경계 문구를 확정했다. | production: versioned description과 필수 문구 lint를 구현한다.
- [x] `MCP-005` | baseline: S18과 ADR-011/013~016이 안전한 거부·redaction 의미를 확인했다. | production: application error를 MCP error/typed result로 매핑하고 log/trace를 검증한다.
- [x] `MCP-006` | baseline: S09와 ADR-003/010/016이 scope·metadata·TTL 경계를 확인했고 `E-RUNTIME`이 tool 인자 없는 bound provider 계약을 제공한다. | production: 실제 request metadata와 authenticated context를 STO-005/006 adapter에 연결하고 동시 요청 격리를 검증한다.
- [x] `MCP-007` | baseline: ADR-016 Validation이 Inspector/client gate를 정의했지만 실행형 MCP 증거는 없다. | production: Inspector와 지원 client의 initialize/list/call/error/shutdown을 검증한다.
- [x] `MCP-008` | baseline: ADR-013/016/017이 agent 품질 기준을 정했지만 실제 20/30개 fixture는 실행하지 않았다. | production: 지원 agent parsing·호출 판단 release gate를 실행한다.

## Phase 08 Release

- [x] `REL-001` | baseline: S23의 고정 seed 적대적 fixture가 소규모 결정성을 확인했다. | production: 10만 event/claim generator와 manifest checksum을 만든다.
- [x] `REL-002` | baseline: S02/S23/S24가 replay 정확성과 crash 복구를 확인했지만 성능은 측정하지 않았다. | production: 10만 event replay/startup p95와 3회 trigger를 측정한다.
- [x] `REL-003` | baseline: S12/S13이 recall 정확성과 hub 절단을 확인했지만 10만 claim 성능은 측정하지 않았다. | production: 세 recall 구간 p95·plan·golden을 측정한다.
- [x] `REL-004` | baseline: S20/S24가 4 writer+4 reader와 process crash를 확인했다. | production: 실제 MCP 8-client mixed load·busy·kill/restart를 검증한다.
- [x] `REL-005` | baseline: S18이 대표 secret mask/rejection을 확인했다. | production: 확장 corpus·DB/WAL/backup/log 권한·offline incident rehearsal을 수행한다.
- [x] `REL-006` | baseline: ADR-004/006/008/010/012/017이 지표 정의와 trigger를 확정했다. | production: 읽기 전용 maintenance query·metric dictionary·privacy 경계를 구현한다.
- [x] `REL-007` | baseline: S02/S23/S24가 replay checksum·rollback oracle을 제공한다. | production: dry-run diff·approval gate·rules rollout/rollback runbook을 구현한다.
- [x] `REL-008` | baseline: S14~S16이 reinterpret metadata/order·approval·undo 의미를 확인했고 `E-RUNTIME`이 canonical token generator를 제공한다. | production: candidate report·payload-bound process-memory token store·constant-time 비교·만료/소비·batch 운영과 실패 보상을 구현한다.
- [x] `REL-009` | baseline: S24가 DB reopen 원자성만 확인했고 backup/restore/upgrade는 실행하지 않았다. | production: packaging과 실제 backup·restore·upgrade·incident runbook을 rehearsal한다.
- [x] `REL-010` | baseline: `E-ADR`, `E-SPIKE`, `E-ROADMAP`이 설계·scenario·작업 추적성의 출발점을 제공한다. | production: active 제품 작업 66개, retired stable ID 결정 1개와 모든 release gate를 release commit에서 양방향 감사한다.

## 감사 결론

- active 제품 작업 완료 수는 현재 18/66이다. `FND-001`~`FND-005`, `FND-007`, `STO-001`~`008`과
  `PRJ-001`~`004`가 production artifact와 검증·PR 증거를 갖춰 `DONE`이며 나머지 active 작업은 각
  production gate를 유지한다.
- `FND-006`은 구현 완료가 아니라 [범위 제외 결정](../implementation/fnd-006-ci-retirement.md)에
  따라 retired된 stable ID다. historical evidence row에는 남지만 완료율에는 포함하지 않는다.
- 기존 검증을 그대로 반복할 작업도 0개다. 각 작업은 위 baseline을 fixture·oracle·결정으로
  재사용하고 production 열에 적힌 차이만 구현한다.
- Phase 01은 6/6, Phase 02는 8/8로 종료됐고 Phase 03은 4/10이다. 다음 dependency-ready
  작업은 entity·surface·kind 투영인 `PRJ-005`다.
- 새 증거가 생기거나 작업 의미가 바뀌면 구현 PR에서 이 문서의 해당 행과 phase 완료
  체크를 함께 갱신한다.
