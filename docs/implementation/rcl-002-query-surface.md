# RCL-002: query term과 surface seed

- 상태: 로컬 구현·검증 완료, PR review와 `main` 병합 전 `IN_PROGRESS`
- 결정일: 2026-08-23
- 작업: RCL-002
- Owner: `log0629`
- 규범 근거: ADR-006, ADR-008, ADR-012
- 선행 구현: PRJ-002, PRJ-003, PRJ-005, PRJ-007, RCL-001
- 구현 branch: `rcl-002-query-surface`

## 목적과 범위

RCL-002는 search 입력을 결정적 surface lookup term으로 바꾸고, 같은 recall snapshot에서
일치 surface의 모든 entity를 canonical seed로 해석하는 application/storage seam을 제공한다.
이번 범위는 다음만 구현한다.

- 명시 `terms` 우선 또는 query 전체+Unicode 문자/숫자 run 기반 term 추출
- PRJ-002 `normalizeV1`을 그대로 쓰는 길이 필터·중복 제거
- scope-bound surface exact lookup과 PRJ-003/007 redirect canonicalization
- term 순서·canonical entity ID 순서·첫 등장 dedupe
- canonical seed 50+1 절단과 `truncated` 신호
- RCL-001의 고정 read transaction 안에서만 쓸 수 있는 typed capability

FTS, surface hit의 유효 incident 판정, overview, BFS, reached/parent map, ranking, Answer/note
조합과 MCP wiring은 각각 RCL-003~008과 MCP-003의 소유로 남긴다. 이 모듈은 surface가
유효 claim 답을 만들 수 있는지 판정하지 않는다.

## 결정적 term 추출

`extractRecallQueryTerms`는 public search schema가 검증한 `query`/`terms`를 다시 안전한 내부
값으로 읽고 재귀적으로 frozen인 `{ text, surfaceNorm }` 배열을 만든다.

- `terms` property가 있으면 빈 배열을 포함해 query를 전혀 파생하지 않고 입력 순서를 쓴다.
- `terms`가 없으면 trim한 query 전체와 `/[\p{L}\p{N}]+/gu` run을 후보로 만든다.
- 모든 후보는 별도 규칙이 아니라 PRJ-002의 `normalizeV1`을 통과한다.
- normalized Unicode code point가 2개 미만인 후보와 이미 본 normalized 값은 제외한다.
- query 파생 후보는 normalized code-point 길이 DESC, 원문 등장 순서 ASC로 정렬한 뒤 최대
  10개만 쓴다. 전체 query는 appearance order 0이라 같은 길이에서는 run보다 앞선다.
- 형태소 분석, stemming, 조사 제거, 번역, 동의어 확장과 LLM 호출은 없다.

표시용 `text`는 양끝만 trim한 실제 후보를 유지한다. 따라서 RCL-005가 별칭 진입 path를
복원할 때 normalized lookup key가 아니라 처음 매칭된 사용자 표현을 사용할 수 있다.

## surface와 canonical seed

SQLite adapter는 최대 10개 normalized term을 parameter binding한 `requested` CTE로 만들고
`(scope_key, surface_norm)` index에서 일치 surface 행을 모두 읽는다. raw 행을 51개에서 먼저
자르지 않는다. 여러 surface row가 같은 terminal로 모일 수 있기 때문에 모든 후보를
canonicalize한 뒤에만 50+1을 적용해야 하기 때문이다.

각 후보에서 `entities.merged_into`와 `id_redirects`로 도달할 수 있는 closure만 같은 reader
worker에서 읽는다. application에 row, SQL, connection이나 factory를 노출하지 않는다.
순수 `resolveRecallSurfaceSeeds`는 다음처럼 기존 규칙을 재사용한다.

1. PRJ-003 `createIdentifierRedirectRegistry`로 entity ID redirect의 kind/scope/dangling/cycle/
   32-hop 규칙을 검증하고 terminal로 압축한다.
2. `merged_into` edge도 같은 registry primitive로 검증해 ID redirect terminal과 일치하는지
   확인한다. merge, rule-change, deduplicated reason을 새 의미로 재분류하지 않는다.
3. terminal entity가 현재 trusted scope의 unmerged row인지 다시 확인한다.
4. term별 canonical ID를 SQLite BINARY/ASCII 순으로 정렬하고, 앞 term에서 이미 본 entity는
   제거한다.
5. 51번째 unique canonical seed가 있으면 앞 50개만 반환하고 `truncated=true`로 둔다.

한 surface가 여러 canonical entity를 가리키면 모두 seed다. 다른 scope의 같은 surface는
SQL 입력 집합에 들어오지 않으며, 손상 redirect가 scope를 건너면 빈 결과로 숨기지 않고
전체 lookup을 fail closed한다.

## RCL-001 typed snapshot seam

`RecallValidClaimSource`에는 다음 typed method 하나를 추가했다.

```text
resolveSurfaceSeeds(RecallQueryTerm[]) -> RecallQuerySurfaceSelection
```

`resolveRecallQuerySurface`는 RCL-001 `RecallSnapshotService.withSnapshot` callback 안에서 term을
추출하고 이 method를 호출한다. RCL-005는 같은 callback/source를 계속 사용해 반환 seed를
`seed_order`와 BFS 입력으로 연결할 수 있다. surface lookup 전후에도 고정 scope, fixed now,
한 deferred WAL snapshot과 TEMP aggregate lifecycle은 바뀌지 않는다.

worker protocol은 active recall snapshot ID가 맞을 때만 surface read를 허용한다. callback이
끝난 뒤 보관한 capability는 기존과 같이 `RECALL_SNAPSHOT_FAILED`로 닫힌다. 실행 SQL은 SELECT와
기존 TEMP aggregate lifecycle뿐이며 journal, projection, FTS에 INSERT/UPDATE/DELETE를 하지
않는다.

## 손상과 실패 계약

term 입력 실패는 payload를 보관하지 않는 `RecallQuerySurfaceError`로 닫는다. SQLite row의
exact column set, term order, scope, entity/redirect shape와 canonical graph가 어긋나면 adapter가
고정 code/message의 `RecallReadError(INVALID_RECALL_SURFACE_STATE)`로 변환한다. submitted query,
surface, ID, SQL, DB path와 driver cause는 error property/message에 넣지 않는다.

정상 surface miss와 normalized 2자 미만으로 term이 0개가 된 경우는 오류가 아니라 frozen
empty seed selection이다. FTS 불가 note와 최종 `entry='none'`은 RCL-003/RCL-007에서 조합한다.

## TDD와 검증

tests-only RED commit `48b1fdd`는 기존 production build 성공 뒤 두 test가 요구한 새
application module과 domain export가 없어 세 test module이 import 단계에서 0/3 실패했다.
제품 코드를 넣은 뒤 focused target은 11/11 GREEN이다.

fixture는 다음을 고정한다.

- explicit precedence와 빈 explicit 배열, normalized duplicate, 1/2 code-point 경계
- query 전체+문자/숫자 run의 code-point 길이/등장 순서와 최대 10개
- 다의 surface, term 간 canonical entity 첫 등장 dedupe와 BINARY ID 순서
- merge/ID redirect chain, cycle, 33-hop, kind/scope/dangling/terminal 불일치
- 실제 file SQLite의 cross-scope 동명 surface 제외와 51→50+truncation
- 한 snapshot 중 concurrent WAL commit 비가시성, 다음 호출 가시성, 반복 byte 결정성
- 성공/실패 전후 persistent canonical dump와 observer `data_version` 불변
- callback 종료 capability와 손상 payload를 echo하지 않는 typed failure

재현 명령은 다음과 같다.

```bash
pnpm verify:rcl-002
pnpm test:rcl-001
pnpm test:prj-002
pnpm test:prj-003
pnpm test:prj-005
pnpm test:prj-007
pnpm test
pnpm run verify:prj-010
python3 -m unittest discover -s spikes/adr-behavior -p 'test_*.py' -v
python3 docs/roadmap/validate.py
pnpm audit --prod
```

최종 로컬 검증은 RCL-002 11/11, RCL-001 10/10, PRJ-002 7/7, PRJ-003 9/9,
PRJ-005 11/11과 PRJ-007 19/19다. 빠른 전체 suite는 40개 파일 266/266,
PRJ-010 reference parity는 39/39, 독립 behavior spike는 25/25다. roadmap validator는
evidence 67/67·ADR 17/17·scenario 24/24와 기존 Phase/master 집계를 통과했고 production
dependency 알려진 취약점은 0개다.

PR link, review 결과와 `main` merge 증거는 root 작업자가 붙인다. 그 전까지 roadmap task,
Phase 06과 master roll-up 상태/완료 수는 변경하지 않는다.

## 후속 작업 경계

- RCL-003: 이 term의 safe FTS phrase와 surface-no-answer fallback
- RCL-005: canonical seed의 BFS order, reached와 parent/path
- RCL-007: surface truncation을 `more_available`/note ledger에 조합
- RCL-008: 완성된 recall vertical의 S09/S21 golden과 전체 scope/read-only 회귀
- RCL-009/REL-003: 대표 규모에서 candidate closure/query plan과 p95 측정

Accepted ADR 의미를 변경하지 않으므로 superseding ADR은 필요하지 않다.
