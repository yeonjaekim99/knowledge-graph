# Phase 06 — memory_recall 검색·탐색·응답

- 상태: `IN_PROGRESS`
- 진행률: 3/9
- 선행 phase: Phase 03 `DONE`
- 주요 근거: ADR-003, ADR-005, ADR-010, ADR-012, ADR-014
- 선행 증거 감사: [Phase 06 baseline과 production gap](evidence-audit.md#phase-06-recall)
- 종료 조건: search/overview가 고정 snapshot·scope·now에서 유효 claim만 탐색하고 결정적
  path/ranking/응답을 만들며 영구 product state를 전혀 쓰지 않음

> evidence audit의 `[x]`는 기존 증거 대조 완료다. 아래 작업의 `TODO/DONE`과 production
> 완료 체크를 대신하지 않는다.

## 작업 현황

| ID | 작업 | 상태 | Owner | 선행 작업 | 증거 |
|---|---|---|---|---|---|
| RCL-001 | recall 계약·snapshot·유효 aggregate | `DONE` | `log0629` | FND-004, PRJ-008 | [PR #34](https://github.com/yeonjaekim99/knowledge-graph/pull/34), [구현 결정](../implementation/rcl-001-recall-contract-snapshot.md) |
| RCL-002 | query term과 surface seed | `DONE` | `log0629` | RCL-001, PRJ-005 | [PR #39](https://github.com/yeonjaekim99/knowledge-graph/pull/39), [구현 결정](../implementation/rcl-002-query-surface.md) |
| RCL-003 | 안전한 FTS와 raw fallback | `DONE` | `log0629` | RCL-001, STO-004 | [PR #41](https://github.com/yeonjaekim99/knowledge-graph/pull/41), [구현 결정](../implementation/rcl-003-safe-fts-fallback.md) |
| RCL-004 | overview seed와 raw-only 개요 | `IN_PROGRESS` | `log0629` | RCL-001, RCL-003 | [Planning PR #42](https://github.com/yeonjaekim99/knowledge-graph/pull/42), branch `rcl-004-overview-seeds` |
| RCL-005 | BFS 이동·수집·경로 복원 | `IN_PROGRESS` | `log0629` | RCL-001, RCL-002 | [Planning PR #40](https://github.com/yeonjaekim99/knowledge-graph/pull/40), branch `rcl-005-bfs-traversal` |
| RCL-006 | ranking·상충·문장 조합 | `TODO` | `unassigned` | RCL-005, PRJ-008 | — |
| RCL-007 | Answer 구성·detail·payload budget | `TODO` | `unassigned` | RCL-003, RCL-006 | — |
| RCL-008 | 결정성·scope·read-only 회귀 suite | `TODO` | `unassigned` | RCL-001~007 | — |
| RCL-009 | 대표 fixture 성능 baseline | `TODO` | `unassigned` | RCL-008, STO-008 | — |

## 상세 체크리스트

### RCL-001 — recall 계약·snapshot·유효 aggregate

- 상태: `DONE`
- Owner: `log0629`
- Branch: `rcl-001-recall-contract`
- PR: [#34](https://github.com/yeonjaekim99/knowledge-graph/pull/34)
- 근거: ADR-003, ADR-010, ADR-014
- 선행 작업: FND-004, PRJ-008
- 결과물: MemoryRecall schema, read transaction과 scope TEMP aggregate

완료 체크:

- [x] search/overview 판별 union, 기본값과 query/terms/depth/limit 조합을 엄격히 검증한다.
- [x] 호출 시작의 scope와 UTC epoch `now`를 한 번 캡처하고 같은 read transaction을 쓴다.
- [x] scope/now parameterized query로 `TEMP recall_claim_agg`를 한 번 materialize한다.
- [x] aggregate source의 column을 명시적으로 alias해 SQLite 이름 충돌 가능성을 제거한다.
- [x] 이후 진입·이동·수집·상충·detail이 이 TEMP 유효 집합만 사용한다.

완료 증거:

- [구현 결정](../implementation/rcl-001-recall-contract-snapshot.md)에 FND-004 schema/type/runtime
  단일 source, request-scoped typed read port, STO-002 reader protocol과 PRJ-008 aggregate 재사용
  경계를 고정했다.
- TDD RED는 production build 성공 뒤 새 contract/application/SQLite export 부재로 0/3
  실패했고 `pnpm verify:rcl-001` GREEN은 contract 4, application 2, SQLite 4의 10/10이다.
- search/overview 닫힌 union과 기본값, Unicode query/terms·depth/limit 경계, RecallResult
  claim/raw/detail/UTC/ID 구조 및 payload-redacted input/output 오류를 실제 MCP SDK로 검증했다.
- runtime capture 1회, parameterized scope/fixed-now TEMP materialization, explicit alias와 손상
  aggregate fail-closed를 검증했다. callback 중 concurrent WAL commit 전후 두 read가 같은
  snapshot이고 다음 호출에서만 변경·expiry가 보였다.
- 성공/실패 recall 전후 journal/projection/FTS canonical dump와 외부 reader `data_version`이
  변하지 않았다. STO-002 7/7과 PRJ-008 8/8도 회귀했다.
- 전체 fast suite 37개 파일 255/255, PRJ-010 reference parity 39/39, behavior spike 25/25,
  roadmap evidence 67/67·ADR 17/17·scenario 24/24와 production dependency 취약점 0개를
  확인했다.
- term/surface/FTS/overview/BFS/ranking/Answer assembly/MCP wiring과 성능은 구현하지 않았고
  RCL-002~009·MCP-003에 남겼다. 따라서 S09/S10/S19 public golden은 아직 `planned`다.
- 독립 review에서 발견한 합법적 4-hop 경로, MCP Standard Schema 기본값, 닫힌 reader의
  factory 강참조·close race와 advertised trim 경계 결함을 각각 RED로 재현해 별도 fix로
  닫았고, 최종 재검토에서 미해결 finding이 없음을 확인했다. [PR #34](https://github.com/yeonjaekim99/knowledge-graph/pull/34)가
  이 상태·증거 commit을 포함해 `main`에 병합되면 RCL-001의 영속적인 완료 근거가 된다.

### RCL-002 — query term과 surface seed

- 상태: `DONE`
- Owner: `log0629`
- Branch: `rcl-002-query-surface`
- PR: [#39](https://github.com/yeonjaekim99/knowledge-graph/pull/39)
- 근거: ADR-006, ADR-008, ADR-012
- 선행 작업: RCL-001, PRJ-005
- 결과물: deterministic term extractor와 surface seed resolver

완료 체크:

- [x] 명시 terms는 입력 순서를, 미지정 query는 전체+문자/숫자 run을 긴 순서로 최대 10개 쓴다.
- [x] 두 글자 미만 normalized 후보를 제외하고 형태소/LLM 의미 추출을 하지 않는다.
- [x] surface 행을 전부 canonicalize하고 term 순서·entity ID 순으로 중복 제거한다.
- [x] 최대 50개 seed를 쓰고 51번째로 surface 절단을 감지한다.
- [x] 다의 surface를 모두 seed로 쓰되 cross-scope entity는 한 건도 포함하지 않는다.

완료 증거:

- [구현 결정](../implementation/rcl-002-query-surface.md)에 PRJ-002 normalize와 PRJ-003/007
  canonical redirect 재사용, RCL-001 typed snapshot seam, read-only/손상 경계를 고정했다.
- tests-only RED commit `faf79ec`에서 기존 build 성공 뒤 application/domain 제품 관찰점 부재로
  0/3 실패했고, 최소 구현 뒤 focused target이 GREEN이었다. 독립 review RED `9fc2c54`는
  표시 후보 손실·cap 순서·ill-formed UTF-16 허용을 24개 중 8개 실패로 재현했고 fix 뒤
  `pnpm test:rcl-002`는 domain/application/SQLite 15/15 GREEN이다. 후속 RED `138c914`은
  REC-001의 모든 free-form input을 세 계약 경로에서 검사해 13개 중 1개 실패와 malformed
  acceptance 204개를 고정했고, fix `02b7d10` 뒤 REC-001은 13/13 GREEN이다.
- Unicode code-point 길이·정렬, explicit precedence/빈 배열/<2/max10, 같은 norm의 구두점·NFKC
  표시 후보와 반복 run cap-before-dedupe, 다의 surface, redirect chain/cycle/33-hop/kind/scope
  손상, 51 seed와 repeat 결정성을 검증했다.
- 실제 WAL snapshot에서 cross-scope 동명 surface가 제외되고 concurrent commit은 다음 recall에서만
  보였다. 성공/실패 뒤 persistent dump와 `data_version`은 같고 error는 payload를 echo하지 않았다.
- record/recall public input과 query·projection normalization의 Unicode scalar 경계가 일치하고
  valid astral pair는 보존되는지 advertised source, Standard Schema와 helper에서 검증했다.
- 최신 `main`의 REC-003 17/17을 포함한 전체 fast suite 42개 파일 302/302, PRJ-010 39/39,
  behavior spike 25/25, roadmap
  evidence 67/67·ADR 17/17·scenario 24/24와 production dependency 취약점 0개를 확인했다.
- FTS, BFS, ranking, Answer/note와 public S09/S21 golden은 RCL-003/RCL-005~008에 남겼다.
- 독립 review에서 HIGH/MEDIUM/LOW finding 0건을 확인했다. [PR #39](https://github.com/yeonjaekim99/knowledge-graph/pull/39)가
  구현·review remediation·최신 `main` 재베이스·전체 회귀와 이 상태 증거를 함께 게시해
  RCL-002의 영속적인 완료 근거가 된다.

### RCL-003 — 안전한 FTS와 raw fallback

- 상태: `DONE`
- Owner: `log0629`
- Branch: `rcl-003-fts-fallback`
- PR: [#41](https://github.com/yeonjaekim99/knowledge-graph/pull/41)
- 근거: ADR-005, ADR-010, ADR-012, ADR-014
- 선행 작업: RCL-001, STO-004
- 결과물: FTS candidate query와 graph/raw 진입 변환

완료 체크:

- [x] 사용자 문자열을 FTS operator가 아닌 escaped phrase literal로만 만든다.
- [x] 제어 문자 제거·trim 뒤 실제 MATCH phrase가 3자 미만인 후보뿐이면 FTS를 생략하고
  이유 있는 none note를 준비한다.
- [x] graph 또는 raw fallback에 eligible한 live·unexpired statement를 21개 읽어 20개만
  쓰고 절단을 기록한다.
- [x] 유효 support claim의 양 끝을 seed로 만들고 원 claim을 reached에 고정한다.
- [x] live·unexpired parsed=[]만 raw이며 죽은 parsed claim 원문으로 fallback하지 않는다.
- [x] 같은 raw_text의 유효 graph statement가 있으면 raw-only 복제 답을 제거한다.

완료 증거:

- [구현 결정](../implementation/rcl-003-safe-fts-fallback.md)에 query escaping, 실제 bound
  phrase 3자 gate, RCL-001 snapshot/PRJ-008 TEMP aggregate 재사용, eligibility 선별 뒤 21/20
  SQL, endpoint seed와 depth-0 reached pin, raw-only·동일 원문 graph 우선 경계를 고정했다.
- rebased test-only `6d9a84f`에서 기존 build 성공 뒤 missing production module로 새 두 test
  module이 0/2 RED였고, product `3d25722`와 단계별 hardening 뒤 첫 focused target이 10/10
  GREEN이었다. 독립 review RED `69555b7`의 eligible cap, exact phrase code-point와
  Proxy/accessor 경계는 fix `a4dfd22` 뒤 14/14 GREEN이다. 후속 review RED `1a64d00`의
  typed-error 객체 smuggling과 aggregate-backed invalid draft index는 fix `6b121b6` 뒤 17/17
  GREEN이다. 최종 review RED `5536f2b`의 used missing-support와 malformed 21번째 sentinel은
  fix `0db93ef` 뒤 bounded 21개를 전부 검증하면서 앞 20개만 사용하는 20/20 GREEN이다.
- 최신 `main` `f0b0660`으로 semantic rebase하고 test-only `8d5d304`·구현 `4924b19`에서
  RCL-002의 ordered `selection.terms[].text`를 FTS에 전달하되 `surfaceNorm`을 phrase로 쓰지 않는
  경계를 고정했다. 통합 fixture `4835796`는 실제 snapshot에 surface/FTS reader·worker facet을
  모두 보존하고 raw SQL/connection은 노출하지 않는지 확인한다.
- operator/quote/control/Korean/emoji와 NFKC-equivalent 별도 phrase, 실제 bound phrase 3자 경계,
  scope·expiry·retraction·supersede, entity/literal endpoint, raw duplicate와 저장 원문 공백
  보존, suppressed raw/dead parsed의 cap 비소비, eligible 21개 절단, 반복 결정성, 고정
  snapshot, persistent dump/data_version, fresh typed error, missing-support·invalid-index·sentinel
  fail-closed 및 payload-redacted corruption을 실제 file SQLite에서 검증했다. dead·expired·
  cross-scope support는 손상으로 오판하지 않는다.
- focused RCL-003 21/21, RCL-002 15/15, 전체 fast 44개 파일 323/323, PRJ-010 39/39,
  behavior spike 25/25, roadmap evidence
  67/67·ADR 17/17·scenario 24/24와 production dependency 취약점 0개를 확인했다.
- 최종 BFS/ranking/Answer/MCP와 overview는 포함하지 않았고 S11/S22 public manifest도
  `planned`로 유지한다. 독립 최종 review에서 HIGH/MEDIUM/LOW 0건과 2,100 support·21개
  후보 전체 검증을 재현했다. [PR #41](https://github.com/yeonjaekim99/knowledge-graph/pull/41)이
  구현·review remediation·semantic integration·전체 회귀와 상태 증거를 함께 게시해
  RCL-003의 영속적인 완료 근거가 된다.

### RCL-004 — overview seed와 raw-only 개요

- 상태: `IN_PROGRESS`
- Owner: `log0629`
- Branch: `rcl-004-overview-seeds`
- Planning PR: [#42](https://github.com/yeonjaekim99/knowledge-graph/pull/42)
- 근거: ADR-010, ADR-012, ADR-014
- 선행 작업: RCL-001, RCL-003
- 결과물: deterministic overview candidate provider

완료 체크:

- [ ] distinct 유효 incident claim 수 DESC, 최근성 DESC, entity ID ASC로 정렬한다.
- [ ] 상위 `min(limit,10)` entity를 depth 0 seed로 쓰고 하나 더 읽어 절단을 판정한다.
- [ ] claim 랭킹 뒤 남는 칸만 최근 live·unexpired parsed=[] raw로 채운다.
- [ ] raw-only scope도 overview가 되며 철회/만료 graph 원문은 우회하지 않는다.
- [ ] 별도 entity answer type을 만들지 않고 entry=overview로 구분한다.

branch-local 증거 (독립 review 대기):

- [구현 결정](../implementation/rcl-004-overview-candidates.md)에 RCL-001 snapshot 안의 typed
  overview facet, distinct incident count·aggregate 최근성·숫자 entity ID 정렬, canonical
  depth-0 seed와 `min(limit,10)+1` 절단을 고정했다.
- RCL-003의 same-raw valid-graph predicate를 재사용해 live·unexpired parsed=[]만 effective
  created_at·journal seq 순서로 `limit+1` 읽으며, raw-only scope와 죽은 graph history 비부활을
  실제 file SQLite에서 검증했다. 이 배열은 RCL-007이 ranked claim 뒤 남는 칸에만 쓰는 후보
  pool이고 RCL-004가 final Answer를 조립하지 않는다.
- test-only `c4cfb7b`은 기존 build 성공 뒤 missing overview production module로 0/2 RED였고,
  product `9c7c767` 뒤 최초 focused 13/13 GREEN이다. 독립 review가 async error payload 누출을
  발견한 뒤 test-only `12eb3bc`에서 13/15 RED를 재현했고 fix `5a28f1b`가 sync throw,
  Promise rejection과 hostile thenable의 typed/ordinary error를 fresh fixed error로 바꿔
  focused 15/15 GREEN이다. RCL-001 10/10, RCL-002 15/15,
  RCL-003 21/21, STO-002 7/7, STO-004 4/4, PRJ-008 8/8, 전체 46개 파일 338/338,
  PRJ-010 39/39와 behavior spike 25/25도 통과했다.
- 독립 재review와 PR/main merge 전이므로 상태와 완료 체크는 유지한다. claim ranking, 남는 칸
  조립, `entry: "overview"`, public S19/S22 golden은 RCL-006~008의 남은 gate다.

### RCL-005 — BFS 이동·수집·경로 복원

- 상태: `IN_PROGRESS`
- Owner: `log0629`
- Branch: `rcl-005-bfs-traversal`
- Planning PR: [#40](https://github.com/yeonjaekim99/knowledge-graph/pull/40)
- 근거: ADR-010, ADR-012
- 선행 작업: RCL-001, RCL-002
- 결과물: TEMP link/incident views, reached와 parent map

완료 체크:

- [ ] entity-object claim만 양방향 이동하고 방문 entity의 literal 포함 incident를 별도 수집한다.
- [ ] 요청 depth까지 조기 종료 없이 BFS하며 canonical entity 기준으로 한 번 방문한다.
- [ ] link와 incident를 규정된 aggregate tie-break로 31개 읽어 30개만 쓴다.
- [ ] 같은 claim은 가장 낮은 depth와 가장 이른 seed/간선 경로를 유지한다.
- [ ] 별칭·FTS·overview 표시와 entity 간 실제 hops를 구분해 path를 복원한다.
- [ ] incoming, literal, multi-seed와 cycle fixture에서 path/hops가 반복 실행마다 같다.

### RCL-006 — ranking·상충·문장 조합

- 상태: `TODO`
- Owner: `unassigned`
- 근거: ADR-004, ADR-010, ADR-012
- 선행 작업: RCL-005, PRJ-008
- 결과물: parameterized ranking query와 brief formatter

완료 체크:

- [ ] depth·provenance·support·30일 최근성·상충 가중치를 SQL 안에서 계산한다.
- [ ] score 동률은 depth/strongest/count/last_seen/origin_seq/숫자 index 순으로 푼다.
- [ ] uses/rejects 양쪽이 같은 TEMP aggregate에 있을 때만 contested다.
- [ ] relation label도 같은 aggregate에서 읽고 만료되면 이전 label로 돌아간다.
- [ ] canonical literal과 기본 predicate를 이어붙이며 한국어 조사를 임의 보정하지 않는다.

### RCL-007 — Answer 구성·detail·payload budget

- 상태: `TODO`
- Owner: `unassigned`
- 근거: ADR-012, ADR-014
- 선행 작업: RCL-003, RCL-006
- 결과물: RecallResult assembler와 truncation ledger

완료 체크:

- [ ] canonical claim_id, support 세 값과 UTC `Z` 시각을 같은 snapshot에서 만든다.
- [ ] effective created_at과 실제 append recorded_at을 재해석 fixture에서 구분한다.
- [ ] brief에는 detail이 없고 full에는 현재 유효 support만 최근 순으로 예산 내 포함한다.
- [ ] raw text와 detail raw_text의 합산 UTF-8 payload를 1 MiB, detail을 전역 100개로 제한한다.
- [ ] surface/overview/fanout/limit/FTS/raw/detail 절단 원인을 more_available과 note에 누적한다.
- [ ] 정상 빈 기억은 entry=none, 장애/손상은 tool error로 분리한다.

### RCL-008 — 결정성·scope·read-only 회귀 suite

- 상태: `TODO`
- Owner: `unassigned`
- 근거: ADR-003, ADR-010, ADR-012, ADR-014와 behavior spike
- 선행 작업: RCL-001~007
- 결과물: recall golden/negative/invariant test suite

완료 체크:

- [ ] 같은 snapshot·입력·now의 serialized result가 byte-equivalent다.
- [ ] 두 scope를 섞은 fixture에서 seed/reached/detail/answer 교차 누출이 0건이다.
- [ ] 만료/철회 claim이 이동·수집·overview·상충과 raw fallback 모두에서 사라진다.
- [ ] 51 seed, 31 link/incident, limit+1, FTS 21, 1 MiB 절단 case를 모두 검증한다.
- [ ] 호출 전후 journal/projection/FTS 내용과 `PRAGMA data_version`이 변하지 않는다.
- [ ] S19/S21/S22 및 대표 search/overview golden 결과가 통과한다.

### RCL-009 — 대표 fixture 성능 baseline

- 상태: `TODO`
- Owner: `unassigned`
- 근거: ADR-005, ADR-010, ADR-012
- 선행 작업: RCL-008, STO-008
- 결과물: 재현 가능한 recall benchmark와 query plan 기록

완료 체크:

- [ ] 소형·중형·hub·다중 support fixture를 고정 seed로 생성한다.
- [ ] surface 1-hop, graph 2-hop과 FTS 구간을 warm/cold 조건별로 분리 측정한다.
- [ ] `EXPLAIN QUERY PLAN`, SQLite/runtime/host 정보와 raw sample을 보존한다.
- [ ] 명백한 full scan이나 N+1을 release fixture 전에 제거한다.
- [ ] 최종 10만 규모 p95 판정은 REL-003 소유임을 명시해 중복 gate를 만들지 않는다.

## Phase 종료 체크

- [ ] search와 overview가 공통 유효성·랭킹·Answer 계약을 공유한다.
- [ ] traversal과 collection이 분리돼 literal과 incoming claim도 조회된다.
- [ ] 모든 절단, 빈 결과와 장애가 응답에서 구분된다.
- [ ] recall이 TEMP 외 product state를 쓰지 않고 결정적 결과를 반환한다.
