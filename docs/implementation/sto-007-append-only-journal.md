# STO-007: append-only journal repository

- 상태: Accepted
- 결정일: 2026-08-22
- 작업: STO-007
- Owner: `log0629`
- PR: 이 작업 PR에서 확정
- 규범 근거: ADR-001, ADR-002, ADR-005
- 규범 관계: ADR을 대체하지 않는 implementation decision

## 기존 증거와 production gap

S02/S24는 Python reference DB에서 journal append와 FTS·projection rollback, 재개방 뒤 seq/ID
연속성이 함께 성립함을 확인했다. FND-003은 canonical `ev_` ULID generator와 요청당 고정
시각·scope·metadata snapshot을 제공하고, STO-002/004는 실제 Node worker의 FIFO
`BEGIN IMMEDIATE` transaction과 v1 journal/FTS schema를 제공한다.

이 baseline은 선택한 production adapter에서 event ID UNIQUE 충돌을 구분해 재시도하거나,
신뢰 snapshot과 exact body text를 append-only repository에 연결한 증거가 아니다. STO-007은
이 production gap만 닫는다. projection 의미와 증분/full replay, record/revise의 event body
검증·비밀값 처리, process crash/reopen과 MCP wiring은 후속 owner에 남긴다.

## 결론

`src/adapters/sqlite/journal-repository.ts`에 request-scoped storage primitive를 둔다.

```text
validated + sanitized event envelopes        trusted RuntimeProvider
[{ kind, bodyJson }, ...]               snapshot + nextEventId()
                 │                               │
                 └──────────────┬────────────────┘
                                ▼
                   append-only journal repository
                one candidate CTE / one INSERT statement
                                │
                                ▼
          STO-002 FIFO writer → BEGIN IMMEDIATE → COMMIT/ROLLBACK
                                │
                   statement trigger writes FTS rowid=seq
```

repository surface는 frozen `append(events)` 하나뿐이다. event ID, scope, actor, branch,
session과 created time은 intent에 존재하지 않고 trusted runtime에서만 얻는다. package root와
MCP surface에는 repository를 export하지 않는다.

## 입력 snapshot과 저장 envelope

내부 intent는 정확히 두 data property만 갖는다.

```typescript
interface JournalAppendIntent {
  kind: "statement" | "retraction" | "merge" | "alias";
  bodyJson: string;
}
```

batch는 비어 있을 수 없고 각 body는 JSON object text여야 한다. repository가 호출 시 배열과
두 string을 동기적으로 복사하므로 `RuntimeProvider.capture()`를 기다리는 동안 caller가 원본을
바꿔도 저장 값은 변하지 않는다. 알 수 없는 key를 거부해 agent가 ID·scope·metadata를
끼워 넣는 우회 경로를 만들지 않는다.

`bodyJson`은 비밀값 처리와 사건별 의미 검증이 끝난 text라는 내부 계약이다. repository는
JSON object 여부만 다시 확인하고 key 정렬, 공백 제거 또는 stringify를 하지 않는다. 따라서
DB의 `body`는 입력 UTF-8 text와 동일하고 parsed 배열 순서도 바뀌지 않는다. 실제
signature/entropy 탐지와 사건별 schema는 REC-002/003과 REC/REV application 작업이 소유한다.

한 append 호출은 runtime snapshot을 한 번 capture한다. 같은 batch의 모든 사건은 동일한
`scope_key`, actor, branch, session과 UTC epoch 초를 사용한다. event ID만 사건마다 별도로
발급한다.

## seq와 event ID

event ID는 runtime에서 받은 `^ev_[0-7][0-9A-HJKMNP-TV-Z]{25}$` 값만 허용한다. repository
receipt는 입력 index, event ID와 SQLite가 발급한 positive safe-integer seq를 반환한다.

```typescript
{ events: [{ index: 0, eventId: "ev_…", seq: 42 }, ...] }
```

INSERT source는 intent ordinal로 정렬하지만 receipt는 `RETURNING` 행 순서에 의존하지 않고
ID로 다시 매핑한다. replay와 외부 순서는 오직 `journal.seq`이며 ULID lexical/time 순서를
사용하지 않는다.

## collision과 transaction

고정 정책은 **최대 4회 시도**다. 최초 transaction 1회와 whole-batch retry 3회로 구성한다.
무한 retry는 고장 난 entropy provider에서 writer queue를 영구 점유할 수 있어 허용하지 않는다.

각 시도는 batch 전체의 새 ID를 먼저 발급한다. 같은 batch 안에서 중복 ID가 나오면 SQLite를
호출하지 않고 그 시도를 버린다. 서로 다른 후보가 준비되면 다음 단일 SQL을 managed writer에
보낸다.

```sql
WITH candidate(...) AS (VALUES ...)
INSERT INTO journal(...)
SELECT ... FROM candidate
WHERE NOT EXISTS (
  SELECT 1
  FROM journal existing
  JOIN candidate proposed ON proposed.id = existing.id
)
ORDER BY ordinal
RETURNING seq, id;
```

STO-002 worker가 SQL을 `BEGIN IMMEDIATE` 안에서 실행하므로 collision 확인과 INSERT 사이에 다른
writer가 끼어들지 않는다. 후보 하나라도 기존 ID와 충돌하면 INSERT 전체가 0건이고 seq와 FTS도
소비하지 않는다. repository는 아직 노출하지 않은 batch ID 전부를 버리고 다음 transaction에서
전부 새로 발급한다. 일부 ID만 재사용하거나 부분 INSERT를 성공으로 취급하지 않는다.

constraint나 trigger가 첫 행 뒤 실패해도 하나의 INSERT statement와 outer transaction이 함께
rollback되므로 journal과 FTS가 모두 이전 상태로 돌아간다. 4회 모두 collision이면
`EVENT_ID_COLLISION_EXHAUSTED`, `retryable=true`를 반환한다. JSON/trigger/connection 같은 다른
실패를 collision으로 오인해 반복하지 않는다.

## append-only와 application 경계

repository에는 update, delete, projection write와 raw identity selector가 없다. journal 변경은
INSERT뿐이고 statement FTS는 STO-004의 INSERT trigger가 같은 transaction에서 만든다.

ADR-001의 사용자 write 성공 조건은 journal과 projection의 동시 commit이다. STO-007은 아직
projection reducer가 없는 storage primitive이므로 `JournalCommitPort.appendAndProject`에 직접
연결하거나 tool handler에서 호출하지 않는다. PRJ-009와 REC-006이 projector를 같은 managed
writer transaction에 결합한 뒤에만 application 성공 경로로 조립한다. 이 단계에서 repository
단독 append를 공개 use case로 오인하지 않는 것이 핵심 범위 경계다.

## 오류 계약

| code | retryable | 의미 |
|---|---:|---|
| `INVALID_REPOSITORY_DEPENDENCIES` | false | managed factory/runtime 계약 누락 |
| `INVALID_EVENT_BATCH` | false | 빈 batch, 알 수 없는 key/kind 또는 JSON object가 아닌 body |
| `INVALID_EVENT_ID` | false | runtime이 non-canonical ID를 반환 |
| `EVENT_ID_COLLISION_EXHAUSTED` | true | 4회 whole-batch collision |
| `APPEND_RESULT_INVALID` | false | SQLite receipt가 batch와 일치하지 않는 내부 불변식 위반 |

오류에는 body, ID, scope, path, SQL, binding 또는 driver cause를 넣지 않는다. managed writer의
busy/transaction 오류는 STO-002의 redacted `SqliteBusyError`/`SqliteConnectionError`를 그대로
전파한다.

## 대안

### 사건별 INSERT 후 collision 확인

두 번째 사건에서 충돌하면 첫 사건과 FTS가 이미 실행돼 rollback 판정용 분기 또는 별도 worker
protocol이 필요하다. 한 SQL에서 batch 전체의 collision을 먼저 판정한다.

### 사건별 `INSERT OR IGNORE`

충돌한 사건만 빠진 partial batch를 정상 commit할 수 있어 선택하지 않았다.

### 모든 transaction 실패를 collision로 retry

잘못된 JSON, schema drift와 trigger 실패를 entropy 문제처럼 숨기고 같은 작업을 반복한다.
0-row guarded INSERT만 collision 신호로 사용한다.

### ULID 순서로 replay

같은 millisecond와 retry에서 시간/lexical 순서가 journal 적용 순서와 달라질 수 있다. ADR-001/002
대로 SQLite seq만 사용한다.

## 범위 경계

- PRJ-001~009는 projection metadata, reducer, 증분 적용과 full replay를 구현한다.
- REC-002/003과 REC/REV 작업은 secret gate와 사건별 body 의미 검증을 끝낸 뒤 intent를 만든다.
- REC-006은 statement append·projection·RecordResult를 실제 atomic application transaction에
  결합한다.
- STO-008은 hard exit/reopen과 concurrent WAL reader를 실제 process fixture로 검증한다.
- MCP-001/006은 startup과 trusted request context를 최종 composition에 연결한다.

따라서 S02/S24 manifest는 projector와 process recovery owner가 남아 있어 `planned`를 유지한다.

## 검증

```bash
pnpm test:sto-007
pnpm test:sto-002
pnpm test:sto-004
pnpm test:fnd-003
pnpm verify:local
python3 docs/roadmap/validate.py
python3 -m unittest discover -s spikes/adr-behavior -p 'test_*.py'
pnpm audit --prod
```

STO-007 integration test는 실제 임시 SQLite file에서 exact body/scope/metadata/epoch, ULID와
반대인 seq 순서, statement FTS, one-conflict whole-batch retry와 seq 비소비, trigger 장애 뒤
journal/FTS rollback·재사용, input preflight, bounded collision exhaustion과 append-only/private
surface를 검증한다.

## ADR 영향 검토

- ADR-001: journal INSERT의 단일 writer transaction과 append-only private surface를 구현하되
  projection 없는 repository를 application 성공 경로로 노출하지 않는다.
- ADR-002: canonical event ID를 persistence 경계에서 재검증하고, UNIQUE collision 전 batch의
  미노출 ID를 안전하게 재발급하며 replay 순서를 seq에만 둔다.
- ADR-005: statement INSERT와 contentless FTS trigger가 같은 transaction에서 commit/rollback됨을
  실제 file DB로 확인한다.

Accepted ADR의 의미를 바꾸지 않으므로 superseding ADR은 필요하지 않다.
