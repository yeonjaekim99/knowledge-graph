# RCL-004: 결정적 overview 후보

- 상태: 독립 최종 review 완료, [PR #45](https://github.com/yeonjaekim99/knowledge-graph/pull/45)로 게시·병합
- 결정일: 2026-08-23
- 작업: RCL-004
- Owner: `log0629`
- 구현 branch: `rcl-004-overview-seeds`
- Planning PR: [#42](https://github.com/yeonjaekim99/knowledge-graph/pull/42)
- 규범 근거: ADR-010, ADR-012, ADR-014
- 선행 구현: RCL-001, RCL-003
- 규범 관계: Accepted ADR을 대체하지 않는 implementation decision

## 기존 증거와 production gap

S19는 overview가 유효 incident claim 수, 최근성, 숫자 occurrence ID 순서로 개체를 고르고
raw-only scope도 반환하는 의미를, S22는 유효 graph와 같은 원문의 raw-only 복제를 억제하고
죽은 parsed history를 raw로 되살리지 않는 의미를 Python reference oracle에서 확인했다.
RCL-001은 고정 scope/now의 한 WAL read snapshot과 `temp.recall_claim_agg`를, RCL-003은
`RecallRawCandidate`와 same-raw valid-graph 판정을 production SQLite 경계에 제공했다.

이 baseline은 실제 Node reader worker가 overview seed와 raw 후보를 bounded query로 만들거나,
손상된 projection과 hostile adapter payload를 fail closed하는 증거가 아니었다. RCL-004는 이
candidate provider gap만 닫는다. seed를 따라가는 BFS는 RCL-005, claim ranking은 RCL-006,
ranked claim 뒤 남은 응답 칸에 raw를 채우고 `entry: "overview"`와 최종 `more_available`을 만드는
일은 RCL-007, public golden은 RCL-008에 남긴다.

## typed snapshot 경계

RCL-001의 request-local `RecallSnapshotSource`에 다음 facet을 추가했다.

```text
selectOverviewCandidates(limit)
  ├─ seeds: canonical entity, depth=0, deterministic seedOrder
  ├─ rawCandidates: parsed=[] source statements
  ├─ truncation: overview_seeds | overview_raw_candidates
  └─ notes: fixed payload-safe guidance
```

application은 이미 public schema에서 검증된 `limit`의 내부 경계인 정수 1~50만 받고, capability
method를 own data descriptor로 snapshot한다. accessor나 Proxy trap은 원래 예외를 재사용하지
않고 새 `INVALID_RECALL_OVERVIEW_REQUEST`로 바꾼다. adapter 밖에는 raw connection, SQL,
scope와 wall clock을 노출하지 않는다. callback이 끝난 뒤 보관된 capability는 다른 recall
facet과 마찬가지로 stale 상태에서 실패한다.

이 단계는 `RecallOverviewSeedCandidate`라는 내부 후보만 추가한다. public `Answer` 판별 union에
entity 전용 variant를 만들지 않는다. overview의 개체는 depth-0 traversal seed이고, 최종 답은
후속 ranking과 assembler가 기존 claim/raw variant로 만든다.

## entity seed 선택

entity 후보는 `temp.recall_claim_agg`의 유효 claim만 subject/object incident로 펼친 뒤 entity별로
다음 값을 계산한다.

1. distinct incident `claim_id` 수
2. 그 유효 claim support의 최대 `last_seen_at`
3. canonical entity ID

정렬은 `COUNT(DISTINCT claim_id) DESC`, `MAX(last_seen_at) DESC`, entity occurrence의 숫자
`seq ASC`, 숫자 suffix `ASC`이고 마지막에 binary ID를 안정적 fallback으로 둔다. 따라서
`e2.2`가 `e2.10`보다 먼저며 문자열 사전순서에 의존하지 않는다. adapter도 같은 숫자 comparator로
driver 결과의 전체 sentinel 순서를 다시 검증한다.

worker는 `seedCap = min(limit, 10)`으로 정하고 SQL에는 `seedCap + 1`을 named binding으로 넘긴다.
모든 bounded row를 decode한 뒤 앞 `seedCap`만 반환하므로 손상된 sentinel을 정상 절단으로 숨기지
않는다. 하나 더 있으면 `overview_seeds`와 고정 `overview_seed_limit` note를 남긴다. seed의
표시는 current-scope non-merged entity의 canonical `name`, `depth`는 0, `seedOrder`는 최종
배열 위치다. 유효 incident가 없으면 seed 배열은 비어 있다.

## raw-only 후보와 graph 우선순위

raw 후보는 같은 snapshot에서 다음 조건을 모두 만족하는 statement만 고른다.

- journal과 statement가 요청 scope에 있고 statement가 `live`
- statement expiry가 NULL이거나 고정 `now`보다 큼
- stored `parsed`가 실제 JSON array이며 처음부터 비어 있음
- 같은 scope·같은 저장 `raw_text`의 live·unexpired valid graph statement가 없음

same-raw graph 판정은 RCL-003에서 검증한 aggregate-backed predicate를 그대로 export해 재사용한다.
그래프가 유효할 때 parsed=[] 복제는 후보가 아니며 cap도 소비하지 않는다. 반대로 graph support가
만료·철회됐거나 다른 scope에만 있으면 별도의 live parsed=[] statement는 자기 유효성에 따라
raw 후보가 될 수 있다. parsed가 원래 비어 있지 않았던 graph statement 자체는 support가 죽어도
raw로 변환하지 않으므로 철회·만료 history가 우회 부활하지 않는다.

정렬은 projection의 effective `statements.created_at DESC`, 실제 journal `seq DESC`다.
`journal.created_at`은 응답 provenance용 `recordedAt`으로 보존하지만 overview 최근성 tie-break로
쓰지 않는다. worker는 `limit + 1`을 named binding으로 읽고 전체 sentinel을 검증한 뒤 앞
`limit`만 반환한다. 하나 더 있으면 `overview_raw_candidates`와 고정 note를 기록한다. 이 배열은
후속 assembler가 ranked claim 수를 안 뒤 남는 칸만 소비할 후보 pool이며, RCL-004가 claim ranking
또는 최종 응답 예산을 선점하지 않는다. graph seed가 전혀 없는 raw-only scope도 빈 seed와 정렬된
raw 후보로 성공한다.

## snapshot, SQL과 손상 경계

두 SELECT는 RCL-001이 연 `BEGIN DEFERRED` read transaction, 고정 scope/now와 이미 materialize한
TEMP aggregate 안에서 실행된다. scope, now와 probe limit은 전부 named binding이며 SQL source에는
`INSERT`, `UPDATE`, `DELETE`, `REPLACE`가 없다. 성공과 실패 뒤에도 persistent table dump와 외부
reader의 `PRAGMA data_version`은 그대로다.

adapter는 result envelope, dense array와 각 row를 exact own data descriptor로 snapshot한다.
accessor를 실행하지 않고 Proxy/descriptor 예외 및 smuggled `RecallReadError`를 새 고정
`INVALID_RECALL_OVERVIEW_CANDIDATE`로 바꿔 row, raw text, SQL, DB path와 driver cause를 노출하지
않는다. 다음을 포함한 bounded row 전체의 shape와 의미를 검사한다.

- canonical event/entity ID, positive safe statement seq와 숫자 entity 순서
- current scope, live/current non-merged entity, fixed-now 이후 expiry
- incident count와 last-seen epoch, canonical 표시 Unicode scalar와 길이
- raw text/parsed JSON type, 빈 parsed, provenance와 effective/recorded epoch
- 같은 원문의 valid graph 미존재, expected SQL order와 중복 없음

손상 row가 앞 cap 바깥의 sentinel이어도 전체 호출이 실패한다. dead·expired·cross-scope row는
정상 exclusion이고, candidate로 반환된 malformed projection만 corruption으로 판정한다.

## TDD와 로컬 검증

test-only commit `f94d06b`에서 기존 `pnpm run build`는 성공했고, 새 focused command는 아직 없는
`dist/application/recall-overview.js`를 import하다 두 test module이 0/2 RED였다. 이 commit은
숫자 entity ID tie-break, 10+1/limit+1 sentinel, raw-only scope, graph duplicate 우선,
fixed snapshot·read-only, stale capability와 hostile payload redaction을 먼저 고정했다.

제품 구현 commit `e5fe29c` 뒤 `pnpm run verify:rcl-004`는 architecture/type/build와 application
3개, file-backed SQLite 10개, 총 13/13 GREEN이다. 관련 회귀는 RCL-001 10/10, RCL-002 15/15,
RCL-003 21/21, STO-002 7/7, STO-004 4/4, PRJ-008 8/8을 통과했다.

독립 review는 application의 `selectOverviewCandidates` 호출과 adapter의
`readRawOverviewState` await가 보호 경계 밖에 있어, 동기 throw나 Promise/thenable rejection의
원 error identity·message·cause·추가 payload가 그대로 노출되는 MEDIUM 결함을 발견했다.
test-only `ea9e260`은 두 경계 각각에서 sync throw, Promise rejection, throwing `then` getter를
payload-bearing typed/ordinary error로 주입해 focused 13/15 RED를 재현했다. fix `b5c5d3f`는
호출과 await를 각 safe boundary 안으로 옮기고 application이 허용된 candidate code만 own data
descriptor로 분류한 뒤에도 항상 새 고정 오류를 만들도록 했다. hostile thenable이 `then`에서
직접 reject하는 경우까지 추가해 focused 15/15 GREEN이며 원 identity, name, message, cause와
extra field를 보존하지 않는다.

최신 `origin/main` `25eeb72` 위 semantic rebase는 REC-004 writer resolver의 connection
factory/protocol/worker/index와 REC-005 planning을 보존한 채 overview read facet만 합쳤다. rebase된
RED/GREEN/docs 흐름은 `f94d06b` → `e5fe29c` → `5085680` → `ea9e260` → `b5c5d3f` →
`3c40ccf`다. 결합 상태에서 RCL-004 focused 15/15, REC-004 focused 50/50을 포함한
`verify:rec-004` 70/70, RCL-001 10/10, RCL-002 15/15, RCL-003 21/21, STO-002 7/7,
STO-004 4/4, PRJ-008 8/8, PRJ-010 39/39를 통과했다. 최종 전체 fast suite는 48개 파일
388/388이고 behavior spike 25/25, roadmap audit 67/67, production dependency audit 0건과
diff/clean gate도 통과했다.

post-rebase 독립 최종 review는 같은 HEAD에서 HIGH/MEDIUM/LOW 0건과 focused·전체 gate를
재현했다. [PR #45](https://github.com/yeonjaekim99/knowledge-graph/pull/45)이 이 구현과
증거를 `main`에 고정해 RCL-004를 `DONE`으로 만든다. S19/S22 public scenario는 final
claim/raw Answer와 golden이 아직 없으므로 `planned`다.

최종 재현 명령은 다음과 같다.

```bash
pnpm run verify:rcl-004
pnpm run test:rcl-001
pnpm run test:rcl-002
pnpm run test:rcl-003
pnpm run test:sto-002
pnpm run test:sto-004
pnpm run test:prj-008
pnpm test
pnpm run verify:prj-010
python3 -m unittest discover -s spikes/adr-behavior -p 'test_*.py' -v
python3 docs/roadmap/validate.py
pnpm audit --prod
```

## 후속 통합 경계

- RCL-005는 `seeds`의 canonical entity와 `seedOrder`를 traversal 시작점으로 소비한다.
- RCL-006은 traversal 결과 claim을 ranking하며 overview seed 수나 raw 후보 cap을 다시 정의하지
  않는다.
- RCL-007은 ranked claim 뒤 남는 public limit에만 `rawCandidates`를 채우고 truncation ledger와
  note를 최종 `more_available`에 합친다.
- RCL-008이 `entry: "overview"`, 기존 claim/raw `Answer` union, 빈 결과와 S19/S22 public golden을
  수직 경로에서 확정한다.
- RCL-009가 overview query plan과 대표 규모 latency를 측정한다. 현재 correlated graph duplicate
  판정의 비용은 정확성 blocker가 아니라 이 성능 gate의 대상이다.

## ADR 영향 검토

- ADR-010: seed와 raw 유효성은 같은 scope/fixed-now `temp.recall_claim_agg`와 statement expiry를
  사용하고 조회 중 영속 상태를 쓰지 않는다.
- ADR-012: overview 정렬, 숫자 ID tie-break, `min(limit,10)+1`, depth-0 canonical seed와
  graph-first raw 후보를 구현하되 traversal/ranking/Answer는 후속 단계에 남긴다.
- ADR-014: public entity Answer를 추가하지 않고 overview entry와 claim/raw 응답 조립 경계를
  유지한다.
