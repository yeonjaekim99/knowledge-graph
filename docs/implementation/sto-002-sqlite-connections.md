# STO-002: SQLite connection factory와 writer 직렬화

- 상태: Accepted
- 결정일: 2026-08-21
- 작업: STO-002
- Owner: `log0629`
- PR: [#14](https://github.com/yeonjaekim99/knowledge-graph/pull/14)
- 규범 근거: ADR-001, ADR-005
- 규범 관계: ADR을 대체하지 않는 implementation decision

## 결론

STO-001이 발급한 immutable `SqliteStartupReadiness` 뒤에 worker-backed connection
factory를 둔다. factory 하나가 전용 writer worker 하나와 FIFO Promise queue 하나를
소유한다. reader는 각각 별도 readonly worker connection으로 열어 writer가 SQLite lock을
기다리는 동안에도 main MCP event loop와 WAL reader가 진행할 수 있게 한다.

```text
main MCP event loop
  ├─ FIFO write queue ─→ writer worker ─→ BEGIN IMMEDIATE ... COMMIT
  ├─ reader handle ────→ reader worker ─→ readonly WAL query
  └─ reader handle ────→ reader worker ─→ readonly WAL query
```

`better-sqlite3` handle과 동기 query API는 worker 밖으로 나오지 않는다. adapter의 모든
호출은 `Promise`이고 package root는 factory, SQL command나 connection을 export하지 않는다.
STO-007은 이 private transaction seam을 `JournalCommitPort.appendAndProject` 뒤에 연결한다.

## 연결 순서와 정책

writer worker는 현재 `journal_mode`를 먼저 읽는다. 아직 `wal`이 아니면 이 최초 writer만
`journal_mode=WAL`을 실행하고 반환값을 검증한다. 이미 `wal`인 재개방 writer와 모든
reader는 mode를 바꾸지 않고 현재 값만 검증한다. WAL bootstrap 전 reader는
`WAL_MODE_REQUIRED`로 fail-closed한다.

모든 writer/reader connection은 다음 실제 값을 적용하고 다시 읽어 검증한다.

| 정책 | 설정 | 검증값 |
|---|---|---:|
| journal mode | `WAL` 또는 현재 mode 검증 | `wal` |
| durability | `synchronous=NORMAL` | `1` |
| lock wait | `busy_timeout=5000` | `5000` ms |
| page cache | `cache_size=-20000` | `-20000` KiB |
| temp storage | `temp_store=MEMORY` | `2` |
| FK enforcement | `foreign_keys=ON` | `1` |

같은 canonical DB path의 active writer factory는 process 안에서 하나만 허용한다. 중복
factory는 worker를 열기 전에 `WRITER_ALREADY_ACTIVE`로 거부한다. factory를 정상 종료한
뒤 재개방할 수 있으며 이때는 이미 저장된 `wal`을 검증한다. 다른 process의 writer는 이
registry로 막을 수 없으므로 ADR-005대로 v1 지원 밖이다.

POSIX에서는 worker가 DB를 열기 전과 WAL/SHM 생성 뒤 sidecar가 regular file,
non-symlink, `0600`인지 검사한다. unsafe sidecar는 경로를 노출하지 않는
`SQLITE_SIDECAR_UNSAFE`로 거부한다. Windows ACL 실물 검증은 REL-005/REL-009가 소유한다.

## transaction queue

`enqueueWriteTransaction`은 호출 시 command와 binding을 복사해 immutable snapshot으로
만든 뒤 FIFO tail에 연결한다. 이전 작업의 성공/실패와 관계없이 다음 작업이 이어지므로
한 transaction 실패가 queue를 중독시키지 않는다.

writer worker는 각 program을 다음 경계로 실행한다.

```text
BEGIN IMMEDIATE
  → command 1
  → command 2
  → ...
COMMIT
```

빈 program과 잘못된 binding은 worker에 보내기 전에 거부한다. command 하나는 SQLite
statement 하나만 실행하며, program 안의 `BEGIN`, `COMMIT`, `ROLLBACK`, `SAVEPOINT`와
`RELEASE`는 거부한다. transaction 시작이나 어느 command라도 실패하면 가능한 경우 즉시
`ROLLBACK`하고 전체 호출을 실패시킨다. 이 helper가 제공한다고 해서 journal/projection
원자성이 완성된 것은 아니다. 실제 append와 projector를 같은 program으로 만드는 책임은
STO-007 이후에 남아 있다.

## 오류와 lifecycle

SQLite의 `SQLITE_BUSY` 계열은 `SqliteBusyError`로 변환한다.

- `code = "SQLITE_BUSY"`
- `retryable = true`
- `timeoutMs = 5000`
- message에는 DB path, SQL, binding, driver message와 `cause`를 넣지 않는다.

다른 connection/query/transaction/worker 실패도 고정된 `SqliteConnectionError` code와
문구로 바꾼다. driver 예외를 main thread나 응답 경계로 structured-clone하지 않는다.

`close()`가 시작되면 새 write와 reader를 거부하고 이미 받은 write queue를 비운다. 열리는
중이던 reader를 정리하고 모든 reader worker와 writer worker를 닫은 뒤 active writer
등록을 해제한다. 반복 close는 같은 Promise를 반환한다.

## 대안 검토

### main thread의 Promise queue

API 모양은 비동기여도 `better-sqlite3`의 5초 busy wait가 main event loop를 막는다. 실제
lock test 중 interval과 reader가 계속 진행해야 한다는 조건을 만족하지 못해 선택하지 않았다.

### 여러 writer worker

각 worker에 queue가 생기면 process 안에서도 SQLite lock 경쟁이 재발한다. 하나의 writer
worker와 queue만 두고 reader만 별도 worker로 분리했다.

### reader pool 선구현

고정 pool은 아직 실제 recall 동시성과 query 시간을 모르는 상태에서 수명·크기를 먼저
결정한다. STO-002는 독립 reader handle만 제공하고 pooling은 RCL-009/REL-004 측정으로
필요성이 확인될 때 후속 결정한다.

## 범위 경계

- migration version/checksum과 schema DDL은 STO-003/STO-004가 소유한다.
- journal append, event ID, projection 적용은 STO-007과 Phase 03이 소유한다.
- 8-client 혼합 부하와 process crash/reopen은 STO-008/REL-004가 소유한다.
- MCP startup 조립과 graceful shutdown 연결은 MCP-001이 소유한다.
- 따라서 S20 manifest 전체는 아직 `planned`다. 이번 test는 S20 baseline 중 connection과
  lock 경계만 production으로 옮긴다.

## 검증

```bash
pnpm test:sto-002
pnpm verify:local
python3 docs/roadmap/validate.py
python3 -m unittest discover -s spikes/adr-behavior -p 'test_*.py'
pnpm audit --prod
```

file-backed integration test는 writer WAL bootstrap, bootstrap 전 reader 거부, 후속
writer/reader mode 검증, 모든 PRAGMA, POSIX WAL/SHM `0600`, 중복 writer 거부, FIFO commit,
constraint/manual-commit rollback, 실패 후 queue 복구와 close drain을 확인한다. 별도
connection이 `BEGIN IMMEDIATE`를 잡은 실제 5초 동안 main event-loop interval과 reader
snapshot이 계속 진행하고, timeout 뒤 typed busy error와 다음 write 성공까지 검증한다.

## ADR 영향 검토

- ADR-001: transaction helper만 제공하며 journal/projection 원자 경계를 쪼개는 public
  capability를 추가하지 않는다.
- ADR-005: 최초 writer WAL 설정, 후속 검증, connection-local PRAGMA, 여러 reader와 단일
  process writer queue, 5초 retryable busy를 그대로 구현한다.
- FND-002: synchronous driver와 handle은 SQLite worker 안에 있고 application port는
  Promise-only다.

Accepted ADR의 의미를 바꾸지 않으므로 superseding ADR은 필요하지 않다.
