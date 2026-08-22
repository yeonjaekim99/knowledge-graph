# REC-004: transaction-bound write entity resolver

- 상태: 독립 review 지적 보완·로컬 검증 완료, 재검토와 PR/main 병합 대기
- 결정일: 2026-08-23
- 작업: REC-004
- Owner: `log0629`
- 규범 근거: ADR-003, ADR-008, ADR-013
- 선행 구현: REC-001, PRJ-005, PRJ-009
- 구현 branch: `rec-004-write-entity-resolver`

## production gap과 범위

PRJ-005는 projection snapshot에서 surface 후보 전체를 redirect terminal로 해석하고 exact
`normal_name` 하나만 tie-break로 허용하는 순수 resolver를 이미 제공했다. 그러나 record
요청이 그 resolver를 writer queue와 같은 SQLite snapshot에서 실행하고, draft 하나의
ambiguity를 다른 draft와 분리하며, 동일 이름 생성 경합을 DB unique constraint 뒤 재조회로
수렴시키는 production 경로는 없었다.

REC-004는 다음 경계를 추가한다.

- 기존 atomic dispatcher transaction의 journal append 전 prepare 단계
- subject와 entity object를 처리하는 transaction-bound draft resolver
- draft별 ambiguity rollback과 구조화된 same-scope candidate 결과
- 새 entity의 `INSERT OR IGNORE`와 unique collision 뒤 canonical 재조회
- 이름·별칭 surface, occurrence redirect와 kind 보존의 임시 stage
- DB 전체 `journal.seq`/`sqlite_sequence`에서 다음 occurrence seq를 잠금 안에서 확정하는 gate
- REC-005가 고른 survivor만 compact position으로 다시 해석하는 finalization seam
- finalization의 정확한 statement body와 실제 append seq를 묶는 commit 전 parity gate
- append 전에 모든 pre-resolution projection stage를 되돌리는 outer SAVEPOINT

비밀값 탐지·마스킹, claim 의미 검증·중복 제거·input/stored index mapping, statement 생성과
`RecordResult` 조립은 REC-002/003/005/006의 범위다. 이 작업은 공개 MCP tool, application
service 또는 projection-only commit surface를 만들지 않는다.

## transaction lifecycle

기존 `SqliteProjectionDispatchSession.begin(scope, events)`는 호환성을 유지하지만 내부적으로
prepare와 append를 연속 실행한다. record 수직 경로가 사용할 세분화된 내부 흐름은 다음과
같다.

```text
managed writer FIFO
  → BEGIN IMMEDIATE
  → current scope projection snapshot 캡처
  → DB-global next journal seq 캡처·AUTOINCREMENT 정합성 검사
  → SAVEPOINT recall_record_entity_resolution
  → resolveSqliteWriteEntityDrafts(...)
       draft마다 SAVEPOINT recall_record_entity_draft
       worker provisional candidate로 resolve/stage 또는 그 draft만 rollback
  → REC-005가 resolved draft 중 stored survivor index를 선택
  → finalizeSqliteWriteEntityDrafts(..., survivor indexes, exact body)
       outer SAVEPOINT rollback 후 survivor만 compact candidate로 재해석
       stored parsed의 entity occurrence와 exact body를 final plan에 고정
  → append 시작 직전
       ROLLBACK TO recall_record_entity_resolution
       RELEASE recall_record_entity_resolution
  → non-empty journal append·actual seq/body identity 재검사
  → canonical incremental/replay projection publish
  → commit gate
  → COMMIT
```

entity/surface/redirect INSERT는 해석 중 constraint와 후속 draft visibility를 실제 SQLite로
확인하기 위한 임시 stage일 뿐이다. append 전에 outer SAVEPOINT 전체를 반드시 되돌린다.
따라서 임시 projection row는 commit에 섞이지 않는다. finalization에 전달한 exact body와
append body가 다르거나 실제 AUTOINCREMENT seq가 예상과 다르면 projection 계산 전에 전체
transaction이 실패한다. 실제 entity row는 journal event를 입력으로 PRJ-009 projector가 다시
만든다.

prepared dispatch의 `commit`은 다음 조건을 worker에서 검사한다.

- resolution SAVEPOINT가 이미 rollback/release됐다.
- entity resolution을 호출했다면 survivor finalization과 exact body binding이 완료됐다.
- non-empty journal batch가 실제로 append됐다.
- append 결과와 desired projection이 기존 commit gate를 통과한다.

prepare 또는 entity resolution만 실행한 transaction은 rollback만 가능하다. application의
유일 outbound writer가 `JournalCommitPort.appendAndProject`인 FND-002 계약은 바뀌지 않으며,
raw SQL, database handle, projection-only method를 package root나 application에 노출하지 않는다.

## draft 해석 순서

worker는 이미 구조·secret 검사를 통과한 내부 draft plan을 방어적으로 다시 검사한다.
각 reference는 name, nullable kind와 aliases만 가진다. candidate ID는 caller가 전달하지 않고
worker가 잠금 안의 DB-global next journal seq와 occurrence position으로 발급한다. subject를
먼저 해석하고 entity object가 있으면 다음에 해석한다.

각 이름은 PRJ-005와 같은 `normalizeV1`을 사용하며 해석은 반드시 다음 순서다.

1. `(scope_key, surface_norm)`의 모든 surface row를 읽는다.
2. entity redirect를 terminal까지 적용하고 canonical 후보를 중복 제거한다.
3. canonical 후보가 하나면 선택한다.
4. 여러 후보 중 active `normal_name` exact match가 하나면 그것만 선택한다.
5. 여전히 여러 후보면 `ambiguous_entity`로 그 draft를 거부한다.
6. surface 후보가 없으면 같은 scope의 active exact `normal_name`을 찾는다.
7. 없으면 occurrence candidate로 새 entity를 임시 stage한다.

이 순서의 단일 oracle은 PRJ-005 `resolveEntityReference`다. SQLite adapter는 현재 transaction의
entity/surface/redirect row를 매 reference마다 그 입력 snapshot으로 만들어 재사용한다. 별도
first-row tie-break 또는 fuzzy matching을 구현하지 않는다.

ambiguity 결과는 `draftIndex`, `subject|object`, numeric ID 순으로 정렬된 same-scope
`{entityId,name}` 후보와 안전한 retry note를 반환한다. 임의 후보를 선택하지 않고 다른 draft는
계속 처리한다. subject가 stage된 뒤 object가 ambiguous여도 nested draft SAVEPOINT를 되돌려
그 subject와 alias가 후속 draft 해석에 남지 않는다. 반대로 앞서 승인된 draft의 stage는 같은
요청의 후속 draft가 볼 수 있다.

첫 resolve pass에서 ambiguity가 난 draft는 nested savepoint와 함께 position도 되돌린다.
그 뒤 REC-005가 claim identity 중복을 판정해 survivor `draftIndex`의 strictly ordered subset을
넘긴다. finalizer는 provisional stage 전체를 버리고 그 subset만 다시 해석하므로 rejected와
중복 draft는 최종 `e{seq}.{position}`을 소비하지 않는다. survivor 선택 의미는 REC-005가,
compact ID와 append parity는 REC-004가 각각 소유한다.

## global seq, constraint collision과 scope

`expectedJournalSeq`는 `BEGIN IMMEDIATE` 뒤 DB 전체 `MAX(journal.seq)`와
`sqlite_sequence('journal')`가 같은지 확인해 `+1`로 계산한다. 현재 scope의 마지막 seq는
projection meta 비교에만 쓰며 occurrence ID에는 쓰지 않는다. append-only DB에서 두 값이
어긋나거나 safe integer 범위를 벗어나면 손상으로 보고 payload-redacted failure로 닫는다.

not-found reference는 다음 방어 순서를 쓴다.

```text
INSERT OR IGNORE entities(candidate_id, current_scope, ...)
  → 같은 current scope와 normalized name으로 resolver 재실행
  → canonical winner 선택
  → candidate_id != winner면 deduplicated redirect stage
```

writer가 `BEGIN IMMEDIATE`를 보유하므로 지원되는 단일 process writer에서는 다른 요청이
중간에 projection을 바꿀 수 없다. 그럼에도 unique constraint가 이긴 경우를 재조회하는 이유는
동일 request의 provisional state, 방어적 DB constraint와 향후 adapter 조립 편차에서도 새 ID로
우회하지 않기 위해서다. integration fixture는 `BEFORE INSERT` 경쟁 trigger로 이 경로를 실제로
발생시키고 두 후보가 같은 winner로 수렴함을 검증한다.

surface, exact-name과 terminal entity 조회는 항상 current `scope_key`를 포함한다. candidate ID가
다른 scope의 entity PK와 충돌해 INSERT가 무시돼도 그 행을 반환하거나 이름을 note에 넣지 않는다.
current scope exact 재조회가 실패하므로 payload-redacted typed transaction failure가 되고 queue는
rollback 뒤 재사용된다.

## kind와 alias

- kind는 trim → NFKC → lowercase한 nullable 참고값이며 identity에 참여하지 않는다.
- 새 provisional entity에만 kind를 넣는다.
- 기존 entity의 kind가 다르더라도 UPDATE, split 또는 merge하지 않는다.
- input name은 기존 entity를 선택했으면 `agent_supplied`, 새 candidate면 `name` surface로 stage한다.
- subject aliases는 subject canonical에, object aliases는 object canonical에만 적용한다.
- 같은 normalized alias는 한 reference에서 한 번만 적용한다.
- 같은 surface가 다른 canonical에 이미 있어도 그 mapping을 삭제하지 않는다.
- 동일 `(scope,surface,entity)`의 origin은 `confirmed > name > agent_supplied` 순서로만 강화된다.

따라서 homonym alias 두 개를 저장한 뒤 같은 surface로 쓰기를 시도하면 두 candidate가 그대로
남아 다음 draft가 deterministic ambiguity로 거부된다.

## 오류와 불변성

`WriteEntityResolutionError`는 invalid input/result 두 code와 고정 메시지만 가진다. submitted
name, alias, scope, SQL, database path와 내부 cause를 보관하지 않는다. worker 내부의 state,
redirect, constraint 또는 query 손상은 기존 `SqliteConnectionError`의 고정
`SQLITE_TRANSACTION_FAILED`로 낮춘다.

input wrapper는 accessor·symbol·extra property와 sparse array를 거부하고 own data descriptor만
읽는 bounded exact snapshot을 호출 전에 만든다. reflection trap과 이미 오염된 typed error도
원본 객체를 재사용하지 않고 새 고정 input error로 낮춘다. worker도 길이와 strictly increasing
draft index를 다시 확인한다. result wrapper는 session Promise를 native `then`으로 소비하고 같은
descriptor snapshot으로 각 input draft와 동일한 순서/index, canonical entity ID와 ambiguity
candidate의 중복·numeric ordering·shape를 검증한 뒤 결과 전체를 재귀적으로 freeze한다. session
call/rejection/result/thenable의 알 수 없는 실패는 새 고정 result error가 된다. rejected 오류의
own data descriptor에서 허용된 SQLite connection code와 retry shape를 확인하고 canonical own
descriptor와 일치할 때만 `connectionErrorFromCode`로 새 오류를 만든다. 원본 identity·prototype·
Proxy는 절대 통과시키지 않으며 `SQLITE_BUSY`는 새 `SqliteBusyError`의 `retryable=true`와
`timeoutMs=5000`으로 복원한다.
kind는 entity `normalizeV1`과 분리해 trim → NFKC → Unicode lowercase만 적용하므로 `-`, `_`,
`＿`도 유효하다.

## TDD와 검증

production 변경 전 첫 RED는 새 target이 import한
`dist/adapters/sqlite/write-entity-resolver.js`가 없어 module load에서 실패했다.

```text
ERR_MODULE_NOT_FOUND: dist/adapters/sqlite/write-entity-resolver.js
tests 1, pass 0, fail 1
```

독립 review에서 scope-local seq와 caller candidate, rejected/duplicate position, kind validator와
ambiguity result boundary가 발견됐다. 보완 fixture는 production 변경 전에 새 finalizer export가
없어 module instantiate 단계에서 RED가 됐다.

```text
missing export: finalizeSqliteWriteEntityDrafts
tests 1, pass 0, fail 1
```

독립 재검토는 input/result Proxy의 reflection trap과 fake session의 call·rejection·thenable이
synthetic message/cause/prefix/suffix를 원본 오류 객체로 내보내는 경계를 추가로 찾았다. 첫
tests-only RED는 finalization target 19개 중 6개만 통과했고 13개가 실패했다. Promise Proxy와
변조된 SQLite 오류 구분까지 확장한 중간 RED는 21개 중 18개 통과·3개 실패였으며, descriptor
snapshot과 fresh error translation 뒤 21/21 GREEN으로 닫았다.

최종 독립 review는 own shape가 canonical이어도 poisoned prototype 또는 transparent Proxy를 원본
identity로 다시 던지는 문제와 runtime-invalid connection code를 찾았다. 기존 semantic 보존과
poisoned prototype·Proxy getter·invalid code·`SQLITE_BUSY` retry fixture는 tests-only 33개 중
28 pass/5 fail RED였고, allowed code와 exact own descriptor만 snapshot해 fresh canonical error로
재구성한 뒤 33/33 GREEN으로 닫았다.

file-backed SQLite target은 다음 정상·경계·실패 경로를 검증한다.

- confirmed/redirect surface와 새 object 해석, 기존 kind 보존
- 여러 surface 후보의 exact normal-name 단일 tie-break
- stable candidate ambiguity와 다른 draft 계속 처리
- object ambiguity 뒤 draft-local subject rollback, 앞선 승인 draft alias 유지
- subject/object alias homonym 보존과 후속 ambiguity
- 실제 unique constraint collision 뒤 reread·canonical convergence
- 다른 scope name 무시, cross-scope candidate-ID collision redaction과 queue 회복
- malformed input의 payload-redacted failure
- append 없는 commit 차단
- 다른 scope의 앞선 journal이 있어도 DB-global 다음 seq로 candidate 발급
- ambiguity와 REC-005 survivor 선택 뒤 rejected/duplicate position compact 재발급
- finalization body와 append body가 한 byte라도 다르거나 actual seq가 다르면 전체 rollback
- `sqlite_sequence`/`MAX(seq)` drift fail-closed
- `-`, `_`, fullwidth underscore kind와 ambiguity candidate 결과 경계
- input/result Proxy·accessor, session call/rejection/thenable의 fresh payload-redacted 오류와
  allowed code/retry 의미만 보존한 fresh canonical `SqliteConnectionError` 재구성

검증 명령은 다음과 같다.

```bash
pnpm verify:rec-004
pnpm test
python3 docs/roadmap/validate.py
python3 -m unittest discover -s spikes/adr-behavior -p 'test_*.py' -v
pnpm audit --prod
```

독립 재검토 보완 뒤 REC-004 SQLite target은 33/33, 관련 PRJ-005/009 포함 target은 53/53다.
REC-003·RCL-002 완료와 RCL-005 planning이 반영된 최신 main 결합 상태의 전체 fast
44 files·335/335, RCL-001 10/10, RCL-002 15/15, STO-002 7/7, PRJ-010 39/39,
behavior spike 25/25, roadmap audit 67/67과 production audit 0건을 통과했고
미해결 HIGH/MEDIUM finding은 없다. PR/main 영속 증거 전까지 작업 상태는 `IN_PROGRESS`다.
S21의 write-time resolver 부분은 production으로 옮겼지만 public `memory_record`와 실제
alias/revise 수직 경로는 REC-006/008과 REV-006/007이 소유하므로 scenario manifest 상태는
바꾸지 않는다.

## ADR 영향과 후속 owner

- ADR-003: scope predicate를 모든 surface/exact/terminal query에 적용하고 cross-scope PK 충돌도
  존재 정보 없이 실패한다.
- ADR-008: PRJ-005 resolver 순서, draft ambiguity, collision reread, kind와 alias homonym 정책을
  같은 writer transaction의 production path로 연결한다.
- ADR-013: ambiguity를 whole-request error가 아니라 draft별 actionable rejection으로 반환한다.
  secret과 final RecordResult는 후속 REC owner에 남긴다. REC-005가 dedupe survivor와 input/stored
  index mapping을 결정한 뒤 이 seam에 ordered indexes를 전달한다.
- ADR-001/007: provisional projection stage는 append 전에 rollback되며 commit은 journal과 canonical
  projection publish를 함께 요구한다.

Accepted ADR 의미를 바꾸지 않으므로 superseding ADR은 필요하지 않다.
