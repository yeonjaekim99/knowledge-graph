# RCL-003: 안전한 FTS와 raw fallback 후보

- 상태: 구현·로컬 검증 완료 후보 — PR review와 `main` 병합 전까지 roadmap `IN_PROGRESS`
- 결정일: 2026-08-23
- 작업: RCL-003
- Owner: `log0629`
- 구현 branch: `rcl-003-fts-fallback`
- 규범 근거: ADR-005, ADR-010, ADR-012, ADR-014
- 선행 구현: STO-004, PRJ-008, RCL-001
- 규범 관계: Accepted ADR을 대체하지 않는 implementation decision

## 기존 증거와 production gap

S01은 contentless trigram FTS와 한국어 3글자/2글자 경계, S11은 raw TTL과 parsed claim
부활 방지, S22는 유효 claim이 없는 surface 뒤 FTS/raw fallback 가능성을 Python reference
oracle에서 확인했다. STO-004는 같은 physical FTS를 production migration으로 옮겼고,
PRJ-008/RCL-001은 scope와 고정 now를 사용하는 `TEMP recall_claim_agg`와 한 WAL read
snapshot을 제공한다.

이 baseline은 user string을 production FTS5 문법에서 안전하게 격리하거나, 실제 Node
reader worker에서 21/20 후보를 읽고 graph/raw 진입으로 변환한 증거가 아니었다. RCL-003은
그 gap만 닫는다. query term 추출·surface resolution은 RCL-002, overview는 RCL-004,
BFS/ranking/final `RecallResult` 조합은 RCL-005~008, MCP wiring은 MCP-003에 남긴다.

## application query 계획

`prepareRecallFtsQuery`는 application 계층에서 다음 순서로만 FTS 계획을 만든다.

1. 내부 candidate collection이 dense data array·문자열·최대 10개 계약인지 값 getter를
   실행하지 않고 snapshot한다.
2. C0/C1 제어 문자를 제거하고 양끝을 trim한다.
3. 실제로 MATCH에 bind할 위 표시 문자열이 Unicode code point 3개 이상인 후보만 남긴다.
4. 표시 문자열의 `"`를 `""`로 escape하고 각각 하나의 quoted phrase literal로 감싼다.
5. literal들을 고정 ` OR `로 결합하되 전체 표현은 SQL text가 아니라 named binding으로
   worker에 전달한다.

길이 gate에 `normalizeV1`을 쓰지 않는다. `a\u0301b`는 실제 phrase가 세 code point라
MATCH 가능하지만 NFKC 뒤에는 두 code point이고, `㍿`은 실제 phrase가 한 code point라 MATCH
불가능하지만 NFKC 뒤에는 네 code point다. FTS phrase를 graph identity처럼 바꾸거나 dedupe하지
않고, normalize 결과가 같은 fullwidth/ASCII 표현도 SQLite trigram tokenizer에서는 별개일 수
있으므로 원래 입력 순서의 두 phrase를 모두 보존한다. 그래서 `RecallFtsTerm`에는 downstream이
쓰지 않는 `normalized`를 두지 않고 `display`와 `phraseLiteral`만 둔다.
모든 후보가 3 code point 미만이면 MATCH를 실행하지 않고
`fts_terms_too_short` code와 더 긴 query/terms를 요청하는 사용자용 note를 반환한다.
정상 quoted expression에서도 SQLite가 FTS syntax 오류로 판정하면 내부 장애 모양으로
숨기지 않고 `kind=unavailable`, `fts_query_unavailable` note와 빈 후보를 반환한다. 다른
schema/connection 오류는 이 경로로 낮추지 않는다.

RCL-002와 합칠 때는 그 단계가 이미 고정한 ordered `RecallQueryTerm.text`만 이 경계로 넘긴다.
semantic integration hunk는 `searchFtsCandidates(selection.terms.map((term) => term.text))`이며,
surface identity용 `surfaceNorm`은 FTS phrase로 사용하지 않는다. 이 branch는 아직 병합되지 않은
RCL-002 구현을 cherry-pick하지 않고 이 단일 값 경계만 문서로 고정한다.

## RCL-001 snapshot 안의 SQL 경계

기존 `RecallSnapshotService.withSnapshot` callback은 다음 두 facet을 합친
`RecallSnapshotSource`만 받는다.

```text
RecallSnapshotSource
  ├─ listValidClaimAggregates()
  └─ searchFtsCandidates(candidates)
       ├─ terms
       ├─ subject/object seeds
       ├─ depth=0 reachedClaims pins
       ├─ parsed=[] rawCandidates
       └─ truncation + typed notes
```

raw connection, SQL, factory, scope와 wall clock은 application에 노출하지 않는다. FTS
request도 RCL-001이 이미 연 `BEGIN DEFERRED` transaction과 materialize한
`temp.recall_claim_agg` 안에서 실행한다. callback 종료 뒤에는 짧은-term skip을 포함한 모든
method가 stale capability로 실패한다.

candidate SELECT는 STO-004 `journal_fts`에서 rowid와 `bm25`만 읽고 원문은 항상
`json_extract(journal.body, '$.raw_text')`로 읽는다. 다음 조건을 named binding으로 적용한다.

```text
journal_fts MATCH :fts_query
journal.scope_key = :scope_key
statements.scope_key = :scope_key
statements.state = live
statements.expires_at IS NULL OR > :now
eligible = valid graph support OR unsuppressed parsed=[] raw
ORDER BY bm25 ASC, journal.seq DESC
LIMIT 21
```

eligibility는 ORDER/LIMIT 전에 판정한다. 유효 aggregate support가 없는 non-empty parsed history와
동일 raw_text의 유효 graph가 있어 억제될 parsed=[] row는 cap을 소비하지 않는다. 따라서 오래된
valid graph가 최신 suppressed raw 20개 뒤에 있어도 사라지지 않는다. 반면 JSON type이나 row
shape가 손상된 matching row는 validation 경로에 남겨 성공 모양으로 숨기지 않고 fail closed한다.
eligible 집합의 21번째는 FTS truncation 판정에만 쓰고 앞 20개 statement만 graph/raw 후보로
변환한다.
각 statement의 첫 matching phrase는 입력 순서대로 별도 bound MATCH probe를 한다. bound
sequence는 FTS5 rowid constraint에서 정수로 명시해 다른 statement의 phrase hit를 가져오지
않으므로 path용 표시는 단순히 첫 query term을 추측하지 않는다. SQL source에는 FTS column read와
INSERT/UPDATE/DELETE/REPLACE가 없다.

## graph seed와 reached pin

앞 20개 statement 각각에서 현재 support인 행만 `temp.recall_claim_agg`와 join한다.
support는 `live=1`, unexpired, active/current-scope claim이어야 하며 subject/object entity도
현재 scope의 non-merged canonical ID인지 adapter에서 다시 검사한다.

- subject는 항상 seed다.
- entity object가 있으면 subject 다음 seed이고 literal object는 seed가 아니다.
- 같은 entity는 첫 출현만 유지한다.
- support claim은 fanout/BFS와 무관하게 `depth=0`, subject anchor, 해당 seed order로
  `reachedClaims`에 고정한다.
- 같은 claim이 여러 matching support에서 나오면 FTS rank, statement seq, stored draft
  순서상 첫 pin을 유지한다.

따라서 출력 배열의 순서는 `FTS rank ASC → statement seq DESC → draft index →
subject/object`이며 같은 snapshot·입력·now에서는 byte-equivalent다. 실제 TEMP `reached`
삽입과 fanout traversal은 RCL-005가 이 typed pin을 소비해 수행한다.

## raw-only와 duplicate 억제

raw 후보는 journal body의 `parsed`가 실제 JSON array이고 길이가 처음부터 0인 statement만
가능하다. parsed가 하나 이상인데 현재 support가 없으면 claim/statement 철회, supersede,
expiry 이유를 구분하지 않고 후보에서 끝나며 raw로 변환하지 않는다.

parsed=[] candidate와 byte-for-byte 같은 저장 `raw_text`를 가진 다른 statement가 다음을
모두 만족하면 raw 후보도 억제한다.

- 같은 scope의 live·unexpired statement
- non-empty parsed array와 범위 안의 stored draft index
- live·unexpired support
- 같은 snapshot `temp.recall_claim_agg`에 존재하는 valid claim

valid graph가 나중에 철회돼도 graph statement 자체는 raw로 부활하지 않는다. 별도로 처음부터
parsed=[]였던 duplicate statement는 자기 TTL과 state가 유효하면 다시 raw 후보가 될 수 있다.
RCL-004가 재사용할 `RecallRawCandidate`에는 effective `createdAt`, actual journal
`recordedAt`, provenance, stored masked text와 statement seq를 두고, RCL-007이 FTS 순서를
조립할 `RecallFtsRawCandidate`가 matched term/rank만 추가한다.

## 절단·손상·읽기 전용성

`RecallTruncationLedger.reasons`에는 이 단계가 실제로 21번째 statement를 관찰했을 때만
`fts_candidates`를 넣는다. 같은 경우 `fts_candidate_limit` code와 더 구체적인 검색을
요청하는 note도 함께 반환한다. 최종 `more_available`과 여러 단계 note 합성은 RCL-007이
이 ledger를 누적해 수행한다.

adapter는 candidate collection/result envelope/row를 own data descriptor로 먼저 snapshot한다.
accessor는 실행하지 않고, Proxy의 `ownKeys`·descriptor trap을 포함한 검사 예외는 원 payload나
driver cause 없이 typed error로 바꾼다. 그 뒤 candidate/support의 exact column set과 다음을
전부 검증한다.

- canonical event/claim/entity ID와 positive seq/origin
- current scope·live/active state·non-merged endpoint
- JSON raw text/parsed type, trim 후 1~32,768 code point와 stored draft index 범위
- fixed-now 이후 expiry와 statement/support expiry 일치
- provenance, effective/recorded epoch, finite FTS rank
- rank/seq/draft/endpoint 정렬과 row 중복 없음

손상이 하나라도 있으면 `INVALID_RECALL_FTS_CANDIDATE`로 전체 호출을 닫고 row 값, raw text,
SQL, DB path와 driver cause를 error에 넣지 않는다. 성공·실패·skip 모두 TEMP 외 product
state를 쓰지 않으며 외부 reader의 canonical dump와 `PRAGMA data_version`은 그대로다.

## TDD와 검증

기존 production build가 성공한 뒤 rebased test-only commit `4b33cb7`에서 focused command는 아직
없는 `dist/application/recall-fts-query.js` import 때문에 새 unit/SQLite 두 모듈이 0/2 RED였다.
제품 구현 commit `f707c86` 뒤 `pnpm verify:rcl-003`은 unit 3개와 file-backed SQLite 7개,
총 10/10 GREEN이다. downstream raw base type, depth-0 pin과 full 4,096-code-point query
candidate guard는 hardening commit `7d088a6`에, stored raw text 보존은 `fb2aef5`에 분리했다.

자체 diff review에서는 모든 candidate가 3자 미만이면 worker call을 하지 않아 callback 종료
뒤 stale source가 성공 응답을 만들 수 있는 lifecycle 결함을 발견했다. 보관한 source의 짧은
검색 fixture가 9/10 RED인 것을 확인한 뒤 snapshot active guard를 query 계획보다 앞에 두어
10/10으로 닫았다. 이어 stored `raw_text`의 앞뒤 공백은 record 계약상 보존 대상인데 decoder가
손상으로 오인하는 경계를 발견했다. 기존 SQLite fixture에 exact text assertion을 먼저 넣어
9/10 RED를 재현하고, trim은 code-point bound 검증에만 사용하며 반환 text는 바꾸지 않도록
고쳐 다시 10/10 GREEN을 확인했다.

마지막으로 NFKC가 같은 fullwidth/ASCII phrase를 dedupe하면 실제 trigram token 하나를 놓치고,
숫자 binding을 그대로 쓴 FTS5 rowid probe가 행 제약을 적용하지 않는 것을 실제 SQLite fixture로
발견했다. compatibility-equivalent 두 원문과 matched-term assertion을 먼저 추가해 8/10 RED를
확인한 뒤 phrase 순서 보존과 integer rowid constraint를 `3a023f2`에서 고쳐 10/10 GREEN으로
닫았다.

내부 typed seam도 sparse/accessor-backed array를 평범한 문자열 배열처럼 처리하면 untyped
예외 또는 getter 실행이 생길 수 있었다. 두 malformed fixture가 unit target을 2/3 RED로
만드는 것을 먼저 확인하고, bounded code-point 순회와 data descriptor snapshot을 `e1bebb1`에
적용해 accessor를 한 번도 읽지 않은 3/3, focused 10/10 GREEN으로 닫았다.

독립 review는 candidate eligibility보다 앞선 SQL `LIMIT 21`, normalize 결과로 측정한 trigram
길이와 candidate container/row Proxy 예외 누출을 추가로 발견했다. test-only `f8a186f`는 valid
graph seq 1 뒤의 suppressed raw 20개와 dead parsed 20개, `a\u0301b`/`㍿`, accessor/Proxy trap을
각각 RED로 고정했다. fix `ca21753`은 eligibility를 SQL cap 앞으로 옮기고 actual display phrase를
측정하며 exact descriptor snapshot으로 외부 payload를 닫아 focused 14/14를 통과했다. 기존
eligible raw 21개 fixture도 그대로 20개와 정확한 truncation을 반환해 순서·절단 회귀가 없다.

최종 local gate는 architecture/type/build, RCL-003 14/14, RCL-001 10/10, STO-002 7/7,
STO-004 4/4와 PRJ-008 8/8이다. 전체 fast suite는 40개 파일 282/282, PRJ-010 독립
reference parity는 39/39, behavior spike는 25/25다. roadmap validator는 phase 9,
active task 73, historical task 74, retired 1, evidence 67/67, ADR 17/17과 scenario 24/24를
통과했고 production dependency 알려진 취약점은 0개였다.

최종 재현 명령은 다음과 같다.

```bash
pnpm run verify:rcl-003
pnpm run test:rcl-001
pnpm run test:sto-002
pnpm run test:sto-004
pnpm run test:prj-008
pnpm test
pnpm run verify:prj-010
python3 -m unittest discover -s spikes/adr-behavior -p 'test_*.py' -v
python3 docs/roadmap/validate.py
pnpm audit --prod
```

S11/S22 manifest는 final public Answer와 overview까지 완결됐다는 뜻이 아니므로 `planned`를
유지한다. RCL-003의 branch-local 완료 체크와 PR/main merge 증거 반영은 root reviewer가
수행하며 그 전까지 task/phase/master 상태와 진행률은 바꾸지 않는다.

## ADR 영향 검토

- ADR-005: contentless FTS의 rowid/rank만 쓰고 user string을 bound phrase literal로 격리한다.
- ADR-010: graph support는 RCL-001의 scope/fixed-now valid aggregate에서만 가져온다.
- ADR-012: FTS 21/20, endpoint seed, originating claim pin, raw 부활 방지와 graph duplicate
  우선순위를 typed candidate 단계에 구현한다.
- ADR-014: actionable none/truncation note seam과 정상 empty/corruption 구분을 제공하되 final
  RecallResult를 선점하지 않는다.

Accepted ADR의 의미를 바꾸지 않으므로 superseding ADR은 필요하지 않다.
