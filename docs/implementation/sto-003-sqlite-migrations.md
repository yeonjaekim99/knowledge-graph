# STO-003: SQLite immutable migration runner

- 상태: Accepted
- 결정일: 2026-08-21
- 작업: STO-003
- Owner: `log0629`
- 규범 근거: ADR-001
- 규범 관계: ADR을 대체하지 않는 implementation decision

## 기존 증거와 production gap

behavior spike S24와 reopen 결함 수정은 process crash 뒤 SQLite가 완전한 이전 상태 또는
commit된 새 상태로 복구된다는 baseline과 schema bootstrap에서 version·name·checksum을
검증해야 한다는 위험을 남겼다. 이 증거는 production migration API, exact-byte checksum,
startup fail-closed와 실제 Node process 재개방을 구현한 것은 아니다.

STO-003은 그 production gap만 닫는다. journal/projector crash scenario 전체와 S24 manifest의
구현 완료는 STO-007, STO-008, PRJ-009~010과 REL-004에 남긴다.

## 결론

`runSqliteMigrations`는 STO-002의 managed connection factory를 받아 동일한 전용 writer
worker와 FIFO queue에서 실행한다. 별도 SQLite connection이나 두 번째 writer path를 만들지
않는다.

```text
exact UTF-8 migration source
  → bundle 선검증·SHA-256
  → STO-002 FIFO writer queue
  → BEGIN IMMEDIATE
       schema_migrations bootstrap/history 검증
       pending version SQL 순차 실행
       history INSERT
    COMMIT
```

현재 package root는 adapter를 공개하지 않으므로 migration API도 내부 composition surface다.
MCP-001은 startup gate, connection factory, migration 성공 순서로 조립한 뒤에만 tool을
노출한다.

## bundle과 checksum 계약

각 migration은 `{ version, name, source: Uint8Array }`다. `source`는 bundled migration
파일에서 읽은 exact byte이고 runner는 이를 먼저 복사하므로 호출 뒤 입력 변경이 실행 중인
bundle을 바꾸지 못한다.

- version은 1부터 빈틈없이 증가하는 safe positive integer다. 호출 배열 순서와 무관하게
  version으로 정렬한다.
- name은 비어 있지 않고 bundle 안에서 유일하다.
- source는 strict UTF-8로 decode되며 빈 SQL은 거부한다.
- checksum은 decode된 문자열이나 정규화된 줄바꿈이 아니라 복사한 source byte의 lowercase
  SHA-256 hex다.
- `applied_at`은 ambient clock을 읽지 않고 trusted server runtime이 준 non-negative epoch
  초를 사용한다.

bundle 검증은 worker에 요청을 보내기 전에 끝난다. 잘못된 bundle은 DB에
`schema_migrations`조차 만들지 않는다.

## transaction과 history 검증

runner invocation 하나가 아직 적용되지 않은 모든 version을 하나의 `BEGIN IMMEDIATE`
transaction에서 순서대로 적용한다. migration SQL 실패 시 그 호출에서 만든 DDL, DML과
history 행이 모두 rollback된다. 이전 invocation에서 commit된 prefix는 유지되며 수정하지
않는다.

worker는 transaction 안에서 ADR-001의 규범 DDL로 `schema_migrations`를 bootstrap한 뒤
기존 행을 version 순으로 읽는다.

- DB version이 bundle의 최대 version보다 높으면 `MIGRATION_VERSION_UNSUPPORTED`
- 같은 version의 name 또는 checksum이 다르거나 history가 연속 prefix가 아니면
  `MIGRATION_HISTORY_MISMATCH`
- SQL 실행이 실패하면 `MIGRATION_APPLICATION_FAILED`
- bundle 자체가 잘못됐으면 `MIGRATION_BUNDLE_INVALID`

오류에는 database path, migration SQL, name, checksum이나 driver cause를 넣지 않는다.
기존 writer lock timeout은 STO-002의 retryable `SqliteBusyError` 의미를 유지한다.

migration source가 최상위 `BEGIN`, `COMMIT`, `END`, `ROLLBACK`, `SAVEPOINT`, `RELEASE`
문장으로 transaction 경계를 소유하는 것은 선검증에서 거부한다. SQLite trigger 정의의
`BEGIN … END` body와 그 안의 `CASE … END`는 허용해 STO-004의 FTS trigger를 막지 않는다.

## reopen 검증 경계

정상 reopen에서는 모든 version/name/checksum을 다시 확인하고 pending version이 없으면
history와 `applied_at`을 바꾸지 않는다. process test는 별도 child가 동일한 migration
transaction shape에서 DDL과 history를 쓰고 commit 전에 hard exit하도록 한 뒤, production
runner가 DB를 다시 열어 version 1을 온전히 적용하고 다음 reopen에서 no-op인지 확인한다.

이 test와 SQL 오류 rollback test를 함께 사용한다. 전자는 실제 WAL/process recovery를,
후자는 production runner가 transaction 안에서 migration과 history를 함께 다루는지를 각각
관찰한다. journal/projector의 모든 crash boundary를 검증했다고 주장하지 않는다.

## 범위 경계

- STO-004가 최초 bundled v1 migration과 journal·projection·FTS DDL을 추가한다.
- STO-005~006이 scope와 metadata 문맥을 제공한다.
- STO-007이 journal append를 같은 writer queue의 atomic transaction에 연결한다.
- STO-008이 storage 전체 recovery·reader concurrency와 migration checksum 연속성을 통합한다.
- MCP-001이 runner를 실제 server tool exposure 전 bootstrap에 연결한다.

## 대안

### 별도 migration connection

기존 writer queue와 lock 순서를 우회하고 startup 중 두 writer가 경쟁할 수 있어 선택하지
않았다.

### 적용된 SQL 문자열을 DB에서 다시 읽어 checksum 계산

SQLite가 보존한 schema text는 원본 migration file byte가 아니며 줄바꿈·주석 변경을 잡지
못한다. exact bundled byte를 checksum 원본으로 사용한다.

### migration마다 개별 commit

중간 version까지만 commit된 정상 prefix도 재개할 수 있지만, v1 초기 규모에서는 invocation
전체를 하나의 transaction으로 묶는 편이 startup 결과와 rollback 증거가 더 단순하다. 실제
migration 크기가 이 경계를 어렵게 만들면 측정과 후속 implementation decision으로 바꾼다.

## 검증

```bash
pnpm test:sto-003
pnpm verify:local
python3 docs/roadmap/validate.py
python3 -m unittest discover -s spikes/adr-behavior -p 'test_*.py'
```

target test는 실제 임시 SQLite file에서 순차 적용, metadata checksum, 정상 reopen,
name/exact-byte drift, future version, invalid bundle, trigger body 허용과 migration rollback을
검증한다. process test는 uncommitted migration transaction을 hard exit한 실제 DB file을
production runner로 재개방한다.

## ADR 영향 검토

- ADR-001: 규범 `schema_migrations`, exact-byte checksum, startup fail-closed와 transactional
  적용을 production worker에 구현한다.
- ADR-005: STO-002의 WAL connection policy, 단일 writer queue와 retryable busy 의미를
  그대로 사용한다.
- ADR-017: 물리 schema migration과 semantic replay를 섞지 않는다.

Accepted ADR의 의미를 바꾸지 않으므로 superseding ADR은 필요하지 않다.
