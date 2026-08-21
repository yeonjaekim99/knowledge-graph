# PRJ-001: scope replay와 canonical projection 계약

- 상태: Accepted
- 결정일: 2026-08-22
- 작업: PRJ-001
- Owner: `log0629`
- 규범 근거: ADR-001, ADR-007, ADR-017
- 규범 관계: ADR을 대체하지 않는 production implementation decision

## production gap

behavior spike의 S02와 S23은 같은 journal prefix를 반복 replay했을 때 논리 투영과
checksum이 같아야 함을 확인했다. FND-003은 고정 runtime 입력과 ambient runtime 차단을,
STO-002~004는 실제 file SQLite의 단일 writer queue, migration과 v1 projection schema를
제공한다.

이 증거만으로는 production reducer가 실제 journal을 어떤 형태로 받는지, 한 scope를
어떤 transaction에서 교체하는지, 재생 필요 여부와 canonical dump를 누가 판정하는지가
고정되지 않았다. PRJ-001은 사건별 의미를 구현하지 않고 이 실행 경계를 먼저 고정한다.

## 결정적 reducer 계약

reducer 입력은 다음 세 필드만 가진 exact data object다.

```text
ProjectionReplayInput
  scopeKey
  rulesVersion
  events[]  // scope가 같고 seq가 엄격히 증가하는 journal row snapshot
```

각 event는 `seq`, `eventId`, `scopeKey`, `kind`, 저장된 `bodyJson`, audit metadata와
`createdAt`을 포함한다. adapter는 `BEGIN IMMEDIATE`를 먼저 획득한 뒤 scope journal을
`seq` 순으로 읽고, 별도 object로 복사해 재귀적으로 freeze한 입력을 reducer에 넘긴다.
body JSON을 parse/reserialize하지 않는다.

reducer에는 clock, `rebuiltAt`, git, network, LLM이나 다른 service가 주입되지 않는다.
TTL 같은 의미 시각은 후속 reducer가 저장된 사건 시각에서 계산한다. 운영 메타데이터인
`rebuiltAt`만 호출자가 UTC epoch 초로 주입하고 commit 단계에서 `projection_meta`에 쓴다.
따라서 같은 scope journal과 rules version은 호출 시각과 무관하게 같은 snapshot을 만든다.

입력과 출력은 getter를 평가하지 않는 exact enumerable data property로 검증한다. 출력은
아래 여섯 projection 배열만 허용하고, 모든 행의 scope·enum·XOR·중복·참조 무결성을
transaction write 전에 다시 검증한다.

- `statements`
- `entities`
- `surfaceForms`
- `claims`
- `claimSupport`
- `idRedirects`

이 계약은 table shape와 격리를 고정할 뿐 normalize, occurrence ID, pre-scan, entity·claim
상태 전이의 정답을 구현하지 않는다. 그 의미는 PRJ-002~008이 같은 reducer seam 안에
추가한다.

## replay session과 원자적 publish

replay는 기존 managed writer queue에 전용 내부 session을 추가한다.

```text
queue 점유
  → worker: BEGIN IMMEDIATE
  → worker: meta + scope journal snapshot
  → main: pure reducer + snapshot validation
  → worker: scope projection delete/insert + invariant 검사 + meta upsert
  → COMMIT
```

worker가 reducer 실행 중에도 transaction과 writer lock을 보유한다. 다른 writer는 queue
뒤에서 대기하고 별도 WAL reader는 commit 전의 온전한 이전 projection을 본다. 사용자나
application service에 projection table을 직접 수정하는 API는 노출하지 않는다.

교체는 FK 의존 순서로 대상 scope의 projection과 그 scope canonical target을 향한 redirect만
삭제한 뒤 snapshot을 삽입한다. 다른 scope, journal과 journal FTS는 건드리지 않는다.
commit 직전에는 scope의 journal 최종 seq를 다시 확인하고 FK·scope·orphan·redirect target
불변식을 검사한 뒤 meta를 갱신한다. reducer 오류, snapshot 오류, trigger/constraint 오류,
worker 오류가 나면 session 전체를 rollback하므로 기존 projection과 meta가 함께 복구된다.

PRJ-001은 이 full replay primitive만 제공한다. journal append와 projection을 같은 transaction에
조립하고 사건별 증분/full replay를 선택하는 dispatcher는 PRJ-009가 소유한다.

## replay 필요 판정

scope journal의 마지막 seq와 `projection_meta`를 writer transaction 안에서 비교한다.

| 상태 | 결과 | reducer 호출 |
|---|---|---|
| meta 없음 | `missing_meta` | 호출 |
| rules version 다름 | `rules_version_changed` | 호출 |
| meta last_seq와 journal 마지막 seq 다름 | `journal_sequence_changed` | 호출 |
| 둘 다 일치 | `current` | 호출하지 않음 |

빈 scope도 meta가 없으면 빈 snapshot을 한 번 publish해 `last_seq=0`을 기록한다. `current`
경로는 열린 transaction을 rollback해 쓰기 없이 종료한다. startup catch-up과 public tool
readiness 연결은 PRJ-009와 MCP-001이 수행한다.

## canonical dump

`canonicalDump(scopeKey)`는 독립 reader의 한 SQL snapshot에서 대상 scope만 읽는다.
format은 `recall-projection-v1`이며 table 이름, PK 목록, 행과 object key를 UTF-8 byte 기준
type-tagged/length-prefixed 형식으로 정렬한 뒤 lowercase SHA-256을 계산한다.

| table | canonical PK |
|---|---|
| `statements` | `event_id` |
| `entities` | `id` |
| `surface_forms` | `scope_key`, `surface_norm`, `entity_id` |
| `claims` | `id` |
| `claim_support` | `claim_id`, `event_id` |
| `id_redirects` | `old_id` |

`projection_meta`, `rebuilt_at`, `schema_migrations`, TEMP와 FTS는 dump에 포함하지 않는다.
다른 scope의 journal·projection·meta 변경도 checksum에 영향을 주지 않는다. integration test는
production encoder를 재사용하지 않는 reference encoder와 byte-for-byte 결과를 비교한다.

## 오류와 보안 경계

domain 위반은 값이나 payload를 echo하지 않는 `ProjectionReplayContractError`의 safe code로
반환한다. SQLite 실패는 기존 redacted `SqliteConnectionError` 계약을 유지한다. scope 원문,
DB path, SQL, binding, journal body와 reducer output을 오류에 넣지 않는다.

replay adapter는 SQLite adapter 내부 export일 뿐 package root나 application port에 공개하지
않는다. reducer는 production에서 spike module을 import하지 않고, domain architecture guard는
git/network/LLM/process clock 의존을 계속 거부한다.

## TDD와 검증

RED에서는 unit/integration target이 아직 없는 `ProjectionReplayContractError`와
`createSqliteProjectionReplayService` export를 요구해 2개 test file 모두 실패했다. 구현 뒤
다음을 확인한다.

- scope·seq·rules 입력과 immutable reducer snapshot, cross-scope/invalid reference 거부
- writer lock 중 WAL reader의 이전 snapshot과 외부 writer의 `SQLITE_BUSY`
- 대상 scope만 교체되고 다른 scope·journal·FTS가 보존됨
- meta missing/seq/rules mismatch와 exact-current 분기
- scope delete 뒤 주입한 trigger 실패와 invalid reducer output의 완전 rollback·queue 재사용
- 독립 canonical encoder parity와 meta/FTS/다른 scope 무관성

```bash
pnpm verify:prj-001
pnpm verify:local
python3 -m unittest discover -s spikes/adr-behavior -p 'test_*.py' -v
python3 docs/roadmap/validate.py
pnpm audit --prod
```

PRJ-001 target은 8/8, 전체 빠른 suite는 101/101, behavior spike는 25/25를 통과했다.
S02와 S24 manifest는 `planned`를 유지한다. append/project 통합, 전체 사건 의미와 모든 prefix,
hard-exit projector parity는 PRJ-009/010에서만 `implemented`로 전환한다.

## ADR 영향 검토

- ADR-001: scope 전체 교체, meta catch-up 판정과 WAL reader 원자성을 production SQLite에서
  고정한다. 동기 append/project 조립은 PRJ-009에 남긴다.
- ADR-007: 두 단계 reducer가 들어갈 결정적 seam과 full replay transaction을 만든다. pre-scan과
  사건별 상태 전이는 PRJ-004~008에 남긴다.
- ADR-017: reducer 입력에서 ambient runtime을 제거하고 canonical dump·rollback을 실제
  adapter에서 검증한다. journal checksum·회귀 승인 지표와 운영 rollout은 REL-007이 소유한다.

Accepted ADR의 의미를 바꾸지 않으므로 superseding ADR은 필요하지 않다.
