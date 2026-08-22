# RCL-005: BFS 이동·수집·경로 복원

- 상태: 로컬 구현·검증 완료, 독립 review 대기
- 결정일: 2026-08-23
- 작업: RCL-005
- Owner: `log0629`
- 규범 근거: ADR-010, ADR-012
- 선행 구현: RCL-001, RCL-002, PRJ-003, PRJ-008
- 구현 branch: `rcl-005-bfs-traversal`

## 목적과 범위

RCL-005는 RCL-001의 request-local read transaction과 유효 aggregate를 그대로 사용해
canonical entity graph를 제한적으로 확장하고, 방문 entity의 claim을 별도 수집해 결정적인
parent/path를 만든다. 이번 범위는 다음만 구현한다.

- 유효 aggregate에 뿌리를 둔 TEMP 양방향 link와 incident view
- entity-object link만 따르는 depth 1~3 BFS와 literal 포함 incident 수집
- entity별 link/incident 각각 31개 read, aggregate 순서의 앞 30개 use
- canonical entity 한 번 방문과 multi-seed 최단·seed·간선 순서 parent
- claim별 최소 depth, earliest seed/edge anchor와 alias·FTS·overview path/hops
- 같은 WAL snapshot, scope, fixed-now, read-only와 손상 fail-closed 경계

RCL-006의 score·contested·brief formatter, RCL-007의 public `Answer`/note/payload budget과
RCL-003/004의 실제 FTS·overview seed provider는 구현하지 않는다. `surface`, `fts`,
`overview` entry 입력은 후속 provider가 전달할 내부 traversal seam의 표시 의미만 고정한다.

## TEMP traversal source

reader worker는 RCL-001이 `BEGIN DEFERRED` 뒤 materialize한
`temp.recall_claim_agg`에 다음 두 TEMP view를 연결한다.

```text
recall_claim_links    = 유효 entity-object claim의 subject→object + object→subject
recall_claim_incident = 유효 claim의 subject anchor + entity object anchor
```

두 view 모두 `temp.recall_claim_agg`와 join하므로 현재 scope에서 호출 시작 시각에 유효한
support가 없는 claim은 이동과 수집 어느 쪽에도 들어오지 않는다. self-loop의 역방향 또는
두 번째 incident 행은 만들지 않아 같은 claim을 한 entity에서 중복 읽지 않는다. 리터럴
object는 link에는 없지만 subject incident에는 남는다.

entity마다 link와 incident를 독립 query로 31개까지 읽으며 정렬은 다음과 같다.

```text
support_count DESC
strongest_rank DESC
last_seen_at DESC
claim.origin_seq ASC
claim ID의 parsed_index 숫자 ASC
```

application은 각 배열의 앞 30개만 사용하고 31번째가 있으면 결과 포함 여부나 요청 최대
depth와 무관하게 해당 truncation reason을 남긴다. 전체 `COUNT`나 영구 reached table은
추가하지 않는다.

TEMP link/incident view는 aggregate보다 먼저 drop한다. 성공 시 TEMP state를 버리고 read
transaction을 commit하며, 실패·callback 예외·reader close에서는 rollback 뒤 같은 cleanup을
수행한다. permanent journal/projection/FTS에는 INSERT/UPDATE/DELETE 경로가 없다.

## typed snapshot capability와 손상 경계

`RecallValidClaimSource`에 다음 request-local method 하나를 추가했다.

```text
readTraversalNeighborhood(entity_id) -> entity + links[0..31] + incidents[0..31]
```

worker protocol과 adapter는 active snapshot ID가 일치할 때만 이 read를 허용한다. callback
종료 뒤 보관한 source는 기존 RCL-001과 같이 `RECALL_SNAPSHOT_FAILED`로 닫힌다. raw SQL,
connection, scope와 evaluation time은 application에 노출하지 않는다.

adapter는 exact projected column, canonical claim/entity ID, active state, claim·양 끝 entity의
scope, unmerged canonical endpoint와 aggregate shape를 검증한다. source claim이 current scope인데
endpoint가 다른 scope인 손상도 빈 결과로 숨기지 않는다. 잘못된 row나 순서에는 submitted
entity/name/DB path/driver cause를 보유하지 않는
`RecallReadError(INVALID_RECALL_TRAVERSAL_STATE)`를 반환한다.

raw traversal envelope·row·array는 bounded descriptor snapshot으로 한 번 복제한 값만
decode한다. accessor는 실행하지 않고 Proxy trap이나 payload를 덧붙인 typed error도 원본을
재사용하지 않아, 고정 code/name/message 외의 cause·임의 필드가 오류 경계를 넘지 않는다.

domain traversal contract도 exact plain data, well-formed Unicode scalar display/name,
origin-seq와 claim ID의 일치, root incident/link 방향, 최대 31개, 중복 없는 규범 정렬을 다시
검증한다. input과 neighborhood도 descriptor-only bounded snapshot을 통과하며, source가
payload-bearing `RecallGraphTraversalError`를 reject해도 fresh
`INVALID_TRAVERSAL_STATE`로 바꾼다. fake 또는 다른 adapter가 typed port를 흉내 내도
malformed neighborhood가 BFS에 들어오거나 공격자 payload가 오류에 남지 않는다.

## BFS, reached와 parent

모든 unique seed를 입력 순서대로 depth 0 방문 집합에 먼저 넣고 layer 단위 BFS를 수행한다.
각 방문 entity에서는 incident 앞 30개를 먼저 수집하고, 요청 depth보다 얕을 때만 link 앞
30개로 다음 frontier를 만든다. answer 수에 따른 조기 종료는 없고 frontier가 자연히 비는
경우만 끝난다.

- entity는 canonical ID 기준 한 번만 방문한다.
- 여러 경로가 같은 entity를 발견하면 BFS의 짧은 경로, seed input order, 정렬된 link order로
  처음 발견한 parent 하나를 남긴다.
- 같은 claim을 여러 anchor에서 수집하면 낮은 depth, 이른 seed, 이른 edge/frontier에서 처음
  정해진 anchor를 유지한다.
- 서로 다른 neighborhood가 같은 claim ID에 다른 endpoint/aggregate를 주면 손상으로 닫는다.
- cycle은 기존 방문 집합에서 멈추고 같은 entity나 claim을 중복 결과로 만들지 않는다.

내부 결과는 frozen `parents`, frozen `reached`와 독립 `{links, incidents}` truncation이다.
`reached`에는 RCL-006이 소비할 `claimId`, 최소 `depth`, `seedOrder`, `anchorId`와 RCL-005의
`path`/`hops`만 둔다. score, text, support 응답, `answers`와 최종 `more_available`은 없다.

## path와 hops

parent를 seed까지 역추적하고 anchor의 claim이 entity-object이며 반대 endpoint가 경로 끝에
없을 때만 그 이름을 한 번 붙인다. 리터럴 claim은 anchor까지만 표시한다.

- surface 표시가 canonical seed name과 다르면 `별칭 → canonical name`으로 보이지만 별칭
  연결은 hop이 아니다.
- FTS 표시는 첫 phrase에 `(FTS)`를 붙이고 overview는 canonical entity name만 쓴다.
- seed 표시는 원문을 바꾸지 않고 Unicode code point 80자를 넘을 때만 79자와 `…`로 출력한다.
- `hops`는 entity-object 간 실제 edge 수다. depth 3 frontier의 incident가 아직 path에 없는
  반대 endpoint를 가지면 합법적으로 최대 4가 된다.

## TDD와 검증

tests-only RED commit `e05743f`는 기존 production build 성공 뒤 새 application module이 없어
RCL-005의 세 test module이 import 단계에서 0/3 실패했다. 최소 GREEN commit `01b221b`은
TEMP source, snapshot protocol/adapter, domain validation과 BFS를 연결했고
`pnpm verify:rcl-005`가 9/9로 통과했다.

로컬 diff 재검토에서 parent 간선이 아닌 cycle edge의 반대 endpoint가 이미 ancestor라는
이유로 path에서 사라지는 결함을 찾았다. tests-only RED `3cb2835`는 depth 3의 `D→B`를
`A→B→C→D→B`, 4 hops로 요구해 8/9와 실제 `A→B→C→D`를 포착했다. fix `0303829`는
self-loop 또는 anchor의 정확한 parent claim만 append에서 제외해 다시 9/9로 만들었다.

독립 review remediation의 tests-only RED `71ca202`는 payload-bearing source/proxy 오류,
SQLite raw envelope·row·array/accessor와 canonical name과 byte-identical한 81-code-point
surface 표시를 추가해 13개 중 4개 실패를 포착했다. fix `6a59954`는 raw 경계를 bounded
descriptor snapshot으로 고정하고 typed 오류를 fresh fixed error로 교체하며, truncation 전에
raw surface와 canonical name을 비교해 진짜 별칭만 prepend한다. focused target은 13/13이다.

fixture는 다음을 고정한다.

- incoming 방향 시작, literal collection, 별칭·FTS·overview path와 실제 hops
- depth 3 무조기종료, frontier literal과 합법적인 4-hop entity-object incident
- multi-seed 최단/earliest-seed/숫자 claim suffix edge order, cycle과 byte 결정성
- link/incident 각각 31→30과 독립 truncation reason
- 실제 file SQLite의 scope·expiry 제외, callback capability 종료와 repeat 결과
- 같은 WAL snapshot 중 concurrent commit 비가시성, 다음 호출 가시성
- cross-scope endpoint 손상의 payload-redacted fail-closed와 실패 뒤 snapshot 재사용
- domain/SQLite의 envelope·row·array/accessor trap과 source typed-error payload 비보존
- 81-code-point surface가 canonical name과 같을 때 truncation으로 중복 표시되지 않음
- 성공/실패 전후 permanent dump와 외부 reader `data_version` 불변

S12/S13 production target 파일이 생겼으므로 scenario manifest는 `implemented`로 전환한다.
이는 두 target이 RCL-005의 traversal/fanout seam을 실행한다는 뜻이며, S12의 ranking·public
recall과 S13의 note/Answer·성능까지 완료했다는 뜻은 아니다. 그 잔여 owner는 manifest의
RCL-006~008·REL-003과 roadmap에 그대로 남는다.

재현 명령은 다음과 같다.

```bash
pnpm verify:rcl-005
pnpm test:rcl-001
pnpm test:rcl-002
pnpm test:prj-003
pnpm test:prj-008
pnpm test
pnpm run verify:prj-010
python3 -m unittest discover -s spikes/adr-behavior -p 'test_*.py' -v
python3 docs/roadmap/validate.py
pnpm audit --prod
```

최신 `main` `3e2eedb` 위 semantic rebase에서 RCL-003의 FTS protocol/factory/worker/read-port
facet과 RCL-004의 `IN_PROGRESS` 계획을 보존했다. 현재 branch의 로컬 통합 검증은 RCL-005
13/13, RCL-001 10/10, RCL-002 15/15, RCL-003 21/21,
PRJ-002 7/7, PRJ-003 9/9, PRJ-005 11/11, PRJ-007 19/19, PRJ-008 8/8,
REC-001 13/13, REC-002 13/13과 REC-003 17/17이다. 빠른 전체 suite는 47개 파일
336/336, PRJ-010 reference parity는 39/39, 독립 behavior spike는 25/25다. roadmap
validator는 evidence 67/67·ADR 17/17·scenario 24/24와 기존 Phase/master 집계를 통과했고
production dependency 알려진 취약점은 0개다.

PR link, 독립 review 결과와 `main` merge 증거는 root 작업자가 붙인다. 그 전까지 task는
`IN_PROGRESS`이고 Phase 06/master 완료 수는 바꾸지 않는다.

## 후속 작업 경계

- RCL-003: safe FTS phrase, raw fallback과 FTS seed/reached 고정
- RCL-004: overview entity/raw-only seed provider
- RCL-006: reached를 사용하는 SQL score·contested·문장 조합
- RCL-007: public Answer/detail와 모든 truncation의 more_available/note ledger
- RCL-008: 완성된 vertical의 S09/S19/S21/S22 scope/read-only golden
- RCL-009/REL-003: 대표 규모 query plan과 p95

Accepted ADR 의미를 변경하지 않으므로 superseding ADR은 필요하지 않다.
