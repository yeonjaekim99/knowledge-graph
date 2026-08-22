# RCL-001: recall 계약·snapshot·유효 aggregate

- 상태: 완료 — [PR #34](https://github.com/yeonjaekim99/knowledge-graph/pull/34)
- 결정일: 2026-08-22
- 작업: RCL-001
- Owner: `log0629`
- 규범 근거: ADR-003, ADR-010, ADR-014; 경계: ADR-012
- 선행 구현: FND-003, FND-004, STO-002, PRJ-008
- 구현 branch: `rcl-001-recall-contract`

## 목적과 범위

RCL-001은 검색 알고리즘을 구현하지 않고 이후 모든 recall 단계가 공유할 두 경계를 만든다.

1. `MemoryRecallInput`과 `RecallResult`의 실제 Draft 2020-12 schema, schema에서 추론한
   TypeScript type과 같은 MCP SDK runtime validator
2. 요청의 trusted scope와 UTC epoch `evaluationNow`를 한 번 캡처해 readonly WAL connection
   하나의 고정 snapshot에서 scope 전용 `TEMP recall_claim_agg`를 소비하는 application port

term 추출, surface/FTS/overview seed, BFS, ranking, 문장·detail/Answer 조합, MCP catalog wiring과
성능 baseline은 각각 RCL-002~009와 MCP-003의 소유로 남겼다.

## schema 단일 source와 기본값

application의 schema literal을 `defineJsonSchema`로 canonical clone·freeze하고 같은 definition을
MCP adapter의 `createMcpJsonSchemaContract`에 넘긴다. 별도 DTO interface나 validator를 쓰지
않는다.

- search는 `mode` 생략 또는 `search`와 필수 query만 허용한다. overview는 명시한
  `mode=overview`만 받고 query/terms/depth를 닫힌 branch가 거부한다.
- query는 양끝 whitespace를 제거한 뒤 Unicode 문자 기준 1~4,096자이고 terms는 최대
  10개·각 1~256자, depth는 1~3, limit은 1~50이다. advertised query schema 자체가 anchored
  trim-aware pattern과 `x-recall-trimmedCodePoint*` annotation으로 padding을 한도에서 제외한다.
  adapter는 반환 전에 trim하고 private exact code-point guard로 SDK regex drift도 닫는다.
- schema의 default annotation과 runtime 반환은 `mode=search`, `depth=2`, `limit=10`,
  `detail=brief`로 일치한다. MCP SDK가 직접 소비하는 Standard Schema validate와 helper가
  같은 canonical default 함수를 통과하며 overview에는 depth 기본을 만들지 않는다.
- `RecallResult`는 claim/raw answer를 닫힌 union으로 두고 canonical ID, UTC 초 단위 `Z` 시각,
  provenance/support/detail 구조, 0~4 hops와 answer 50개·detail statement 100개 상한을
  검증한다.
- Standard Schema validation 실패 result는 issue와 path를 바꾸지 않고 그대로 반환한다.
  application helper 경계는 FND-004의 `JsonSchemaValidationError` code/boundary/issue count만
  남기며 submitted value나 SDK issue payload를 보관하지 않는다.

`json-schema-to-ts`는 default annotation이 있는 optional property를 기본 설정에서 required로
추론한다. public input type은 같은 schema type에서 **type-space로 default annotation key만
제거한 뒤** `InferJsonSchema`를 적용한다. runtime schema와 advertised schema는 default를
그대로 유지하고 DTO를 손으로 중복 선언하지 않는다. 별도 compile fixture가 search mode 생략,
overview 금지 field와 raw/claim branch drift를 검사한다.

ADR-012의 depth는 seed에서 incident anchor entity까지의 거리다. depth 3 frontier에서 수집한
entity-object claim은 path 끝에 아직 없는 반대 entity를 한 번 덧붙일 수 있으므로 합법적
최대 `hops`는 4다. 5 이상은 depth 경계를 넘으므로 output schema가 거부한다.

## application capability 경계

`RecallSnapshotService.withSnapshot`은 request-scoped `RuntimeProvider.capture()`를 정확히 한 번
호출한다. 그 결과에서만 `scopeKey`와 `evaluationNow`를 만들고 scope format과 non-negative
safe integer epoch를 다시 검사한다. tool input에는 scope, actor, branch와 session field가 없다.

application callback이 받는 capability는 다음 하나뿐이다.

```text
RecallValidClaimSource
  └─ listValidClaimAggregates()
```

raw SQLite connection, SQL string, factory와 persistent-table query method를 application에
노출하지 않는다. 후속 RCL seam은 이 port에 TEMP valid set에서 시작하는 typed method만
추가해야 하므로 active-only나 wall clock query로 유효성 정의를 우회할 수 없다.

## 한 read transaction과 TEMP lifecycle

STO-002의 reader worker protocol을 다음 lifecycle로 확장했다.

```text
readonly WAL reader open
  → stale TEMP cleanup
  → BEGIN DEFERRED
  → CREATE TEMP TABLE recall_claim_agg AS scope/fixed-now aggregate
  → typed TEMP-rooted reads (같은 worker transaction)
  → success: TEMP drop → COMMIT
     failure: ROLLBACK → TEMP cleanup
  → reader close
```

reader worker 안에서만 sync driver와 transaction을 소유하며 application callback의 성공·실패
모두 cleanup을 `finally` 경계로 통과한다. callback이 보관한 capability는 종료 후 fail closed한다.
TEMP DDL은 connection-local 상태만 쓰며 main schema의 journal/projection/FTS에는 write를
발행하지 않는다. factory가 연 reader는 반복 close가 같은 Promise를 반환하고 worker close가
완료된 뒤에만 factory ownership에서 빠진다. 따라서 요청마다 닫힌 reader를 강참조하지 않고,
개별 close와 factory close 경합에서도 factory 종료가 in-flight worker보다 먼저 끝나지 않는다.

PRJ-008의 `CLAIM_AGGREGATE_SQL_SOURCE.recallSelect`를 wrapper SELECT 안에서 그대로 사용한다.
유효 support predicate를 복제하지 않고 `:scope_key`와 `:now` named binding을 유지한다.
wrapper는 `claim_id`, count, strength, recency, label과 expiry 여섯 column을 모두 명시적으로
alias한다. 소비 SELECT도 TEMP aggregate와 claims의 동명 column을 서로 다른 이름으로 alias해
SQLite row lookup 충돌을 제거하고 반드시 `FROM temp.recall_claim_agg`에서 시작한다.

## 손상과 읽기 전용성

adapter는 TEMP 결과의 exact column set, canonical claim ID, positive safe support count,
1~3 strength, non-negative epoch, non-empty trimmed label, active state, 요청 scope equality와
finite expiry가 fixed now보다 뒤인지 검사한다. 하나라도 어긋나면
`RecallReadError(INVALID_RECALL_AGGREGATE)`로 전체 호출을 닫고 row 값, SQL, DB path와 driver
cause를 error에 넣지 않는다. 잘못된 scope/now도 reader를 열기 전에
`INVALID_RECALL_CONTEXT`로 거부한다.

실제 file SQLite fixture는 다음을 확인한다.

- 두 scope 중 현재 scope의 유효 claim만 TEMP에 존재하고 exact expiry에서는 제외된다.
- persistent `claims.last_seen_at`과 aggregate `last_seen_at`이 달라도 explicit alias가 aggregate
  값을 반환한다.
- callback 중 writer가 claim을 철회해도 같은 transaction의 두 read는 이전 snapshot과 같고
  다음 recall에서만 철회가 보인다.
- 성공과 callback 실패 전후 journal, statements, entities, surfaces, claims, supports,
  redirects, projection meta와 FTS canonical dump가 byte-equivalent다.
- 별도 observer connection의 `PRAGMA data_version`이 TEMP 생성·정리 뒤 바뀌지 않는다.
- 손상된 aggregate row와 공격자 모양 scope가 payload-redacted error로 실패한다.

## TDD와 검증

첫 RED는 기존 production build가 통과한 뒤 세 새 test module이 각각 아직 없는
`memoryRecallInputContract`, `RecallReadError`, `RECALL_SNAPSHOT_SQL_SOURCE` export 때문에 import
단계에서 0/3으로 실패했다. 최소 구현 뒤 target은 10/10이다. 최종 diff review에서 추가한
trimmed Unicode 4,096자와 hops 상한 fixture도 기존 동작에 대해 8/10 RED를 만든 뒤 계약의
최소 수정으로 다시 10/10 GREEN이 됐다. MCP가 직접 소비하는 Standard Schema validate 경로의
동일 trim 보장과 UTC calendar date 유효성은 각각 3/4 focused RED 뒤 4/4로 닫았다.
독립 리뷰에서 발견한 frontier path 상한은 `hops=4` 허용·`hops=5` 거부 fixture가 기존
schema에 대해 3/4 RED인 것을 확인한 뒤 maximum을 4로 바로잡아 4/4 GREEN으로 닫았다.
MCP-003이 직접 소비할 Standard Schema 성공값의 default 누락도 padded search와 overview
fixture가 3/4 RED로 재현했다. Standard Schema와 helper를 한 canonical default 경로로 합치고
실패 result는 무변형 반환해 focused 4/4 GREEN으로 닫았다.
개별 reader가 닫힌 뒤에도 factory가 다시 close하는 lifecycle fixture는 STO-002 5/6 RED로
강참조 누적을 재현했다. deregistration을 worker close 완료 뒤로 옮기고 반복·factory close가
같은 in-flight Promise를 기다리는 경합 fixture까지 추가해 7/7 GREEN으로 닫았다.
독립 SDK contract로 advertised definition을 compile한 fixture는 padded emoji 4,096 query를
raw `maxLength`가 거부해 focused 3/4 RED였다. source schema를 trim-aware Unicode pattern과
명시 annotation으로 정정하고 exact guard를 유지해 wrapper 없이도 4/4 GREEN으로 닫았다.

재현 명령은 다음과 같다.

```bash
pnpm verify:rcl-001
pnpm test:sto-002
pnpm test:prj-008
pnpm test
pnpm run verify:prj-010
python3 docs/roadmap/validate.py
python3 -m unittest discover -s spikes/adr-behavior -p 'test_*.py' -v
pnpm audit --prod
```

최종 검증은 RCL-001 10/10, STO-002 7/7, PRJ-008 8/8, 전체 fast 37개 파일 255/255,
PRJ-010 reference parity 39/39와 behavior spike 25/25다. roadmap validator는 phase 9,
active task 73, historical task 74, retired 1, evidence 67/67, ADR 17/17과 scenario 24/24를
통과했고 production dependency 알려진 취약점은 0개였다.

## 후속 작업 경계

- RCL-002: deterministic query term과 surface seed resolution
- RCL-003/004: FTS/raw와 overview 후보 provider
- RCL-005/006: TEMP-rooted traversal, collection, ranking, contested와 brief 조합
- RCL-007: actual `RecallResult` answer/detail assembly와 1 MiB budget
- RCL-008: S09/S10/S19를 포함한 공개 recall golden·scope·read-only 회귀
- RCL-009/REL-003: 대표 규모 측정과 trigger 뒤 최적화 검토
- MCP-003: 같은 schema contract를 catalog와 structuredContent에 wiring

Accepted ADR 의미를 변경하지 않으므로 superseding ADR은 필요하지 않다.
