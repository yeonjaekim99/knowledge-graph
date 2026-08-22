# RCL-006: aggregate 기반 ranking·brief 조합

- 상태: 로컬 구현·self-review 완료, roadmap `IN_PROGRESS`
- 결정일: 2026-08-23
- 작업: RCL-006
- Owner: `log0629`
- 구현 branch: `rcl-006-ranking-format`
- Planning PR: [#47](https://github.com/yeonjaekim99/knowledge-graph/pull/47)
- 규범 근거: ADR-004, ADR-010, ADR-012
- 선행 구현: PRJ-002, PRJ-003, PRJ-008, RCL-001, RCL-005
- 규범 관계: Accepted ADR을 대체하지 않는 implementation decision

## 기존 증거와 production gap

S10 reference oracle은 유효 support만으로 count·strongest·last-seen·label을 집계하고 최신
support 만료 뒤 이전 label로 돌아가며, 반대 uses/rejects가 만료되면 contested가 풀리는 의미를
검증했다. S12는 양방향 traversal에서 entity-object와 literal claim을 reached로 모으는 의미를
검증했다. production의 PRJ-008은 같은 의미의 scope/fixed-now aggregate source와 null-safe
contested 식을, RCL-001은 한 read transaction의 `temp.recall_claim_agg`를, RCL-005는
canonical path/hops를 가진 reached claim을 제공했다.

이 baseline은 RCL-005 reached 전체를 실제 SQLite에서 점수화·정렬하거나 canonical brief로
바꾸는 production 경로가 아니었다. RCL-006은 이 gap만 닫는다. public `RecallResult`와
`Answer`, detail, raw 후보 조립, 1 MiB payload, `more_available`와 note는 RCL-007에 남고,
완성 public golden과 전체 invariant suite는 RCL-008에 남는다.

## typed ranking capability

RCL-001의 request-local `RecallSnapshotSource`에 다음 facet을 추가했다.

```text
selectRankedClaims([{ claimId, depth }], limit + 1)
  → aggregate-backed ranked state[0..limit+1]
```

application `rankRecallClaims`는 RCL-005의 reached row 전체를 exact own data descriptor로 한 번
snapshot한다. canonical claim/anchor ID, depth 0~3, seed order 0~49, path와 hops 0~4를 검사하고
중복 claim ID를 거부한다. adapter에는 display path나 anchor를 넘기지 않고 SQL에 필요한
`claimId`와 `depth`만 전달한다. SQL 결과를 claim ID로 원 reached row와 다시 결합해 다음 내부
candidate를 만든다.

```text
claimId, score, depth, seedOrder, anchorId,
text, path, hops, contested,
supportCount, strongestRank, lastSeenAt
```

결과는 public Answer가 아니며 `answers`, detail, `moreAvailable` 또는 note를 갖지 않는다.
application은 public limit의 sentinel만 필요한 RCL-007을 위해 최대 `limit + 1`개를 유지한다.
SQL의 `COUNT(*) OVER()`로 pre-limit total을 함께 읽어 fake source나 손상 때문에 reached가
조용히 누락되는 것도 거부한다.

## bound SQL ranking

worker는 검증한 reached 배열을 JSON으로 직렬화해 `:reached_json` 하나에 bind한다. query
구조와 사용자/DB 값은 섞이지 않으며 `:scope_key`, 고정 `:now`, `:probe_limit`도 named
binding이다. `json_each(:reached_json)` CTE는 다음 source에만 join한다.

```text
requested reached
  → temp.recall_claim_agg
  → current-scope claims
  → canonical subject/object entities
```

따라서 active-only나 ambient wall clock으로 PRJ-008 유효성을 우회하지 않는다. score는 SQL
안에서 정확히 다음처럼 계산한다.

```text
-2 * depth
+ strongest_rank 3/2/1 → 6/4/1
+ min(support_count, 4)
+ last_seen_at ∈ [now - 2,592,000, now] → 2
- contested → 3
```

30일 lower boundary와 fixed-now upper boundary를 모두 포함한다. 미래 last-seen은 단순 old row로
취급하지 않고 adapter corruption으로 fail closed한다. 정렬은 score DESC 뒤
`depth ASC`, `strongest_rank DESC`, `support_count DESC`, `last_seen_at DESC`,
`origin_seq ASC`, claim suffix의 숫자 parsed index ASC이고 binary claim ID를 유일한 안정 fallback으로
둔다. application과 adapter가 같은 comparator로 전체 sentinel 순서를 다시 검증한다.

SQL source는 모든 column을 `recall_ranking_*`로 명시 alias한다. persistent table을 쓰는
`INSERT`, `UPDATE`, `DELETE`, `REPLACE` 경로와 application raw SQL capability는 없다.

## contested·label·brief

contested는 current claim이 uses/rejects이고 반대 relation claim도 같은
`temp.recall_claim_agg`에 있을 때만 true다. subject ID가 같고 다음 두 object field를 각각
SQLite `IS`로 비교한다.

```text
opposite.object_id    IS current.object_id
opposite.object_value IS current.object_value
```

따라서 entity와 literal identity가 모두 null-safe하며 다른 literal이나 다른 scope는 contest가
아니다. 한쪽 support가 exact expiry, 철회 또는 supersede로 aggregate에서 사라지면 별도 write 없이
false가 된다.

predicate는 SQL row의 aggregate `relation_label`을 우선하고 NULL이면 PRJ-002의 immutable
ADR-004 registry에서 `사용/거부/포함/=/관련`을 가져온다. subject와 entity object는 current
non-merged entity의 canonical `name`, literal은 canonical `claims.object_value`를 사용한다.

```text
subject.name + " " + predicate + " " + (object.name | object_value)
```

relation label을 그대로 쓰므로 한국어 조사, 문장부호나 공백을 추측해 고치지 않는다. 최신 label
support 만료·철회 시 PRJ-008 aggregate가 이전 valid non-empty label을 골라 formatter 입력도
자동 fallback한다.

## snapshot, read-only와 손상 경계

ranking request는 RCL-001이 이미 materialize한 aggregate와 같은 worker transaction에서 실행된다.
한 callback 안에서 concurrent writer가 새 support를 commit해도 두 ranking 결과는 byte-equivalent고,
다음 callback에서만 새 label·score·순서를 본다. 성공·실패 전후 permanent journal/projection/FTS
dump와 observer `PRAGMA data_version`은 변하지 않는다.

domain, application과 adapter는 input, output array, envelope와 row를 exact own data descriptor로
snapshot한다. accessor는 실행하지 않으며 symbol, extra field, sparse array, Proxy trap,
malformed ID/relation/object XOR/scope/state/entity merge, 미래 시각, score/total/order drift를
전체 호출 실패로 바꾼다. source method는 한 번 lookup해 receiver와 묶고 lookup·apply·Promise
rejection·hostile thenable settlement 어느 단계에서도 원 error를 재사용하지 않는다. payload를
붙인 `RecallRankingError`/`RecallReadError`도 새 고정 오류로 재구성해 identity, name, message,
cause와 임의 field를 보존하지 않는다.

## TDD와 self-review

tests-only `d958335` 전에 기존 production build는 성공했다. 그 commit의 새 application/S10
module 두 개는 아직 없는 `dist/application/recall-ranking.js` 때문에 정확히 0/2 RED였고,
type fixture도 missing application/domain module과 port facet으로 실패했다. 최소 product
`80a8a93` 뒤 focused target은 5/5 GREEN이었다.

self-review test-only `0660373`은 fixed WAL·limit+1·retracted label과 malformed scope/time/raw
row, source lookup/apply/Promise/thenable 및 descriptor boundary를 추가했다. 기존 구현은 9/11이고
정확히 두 failure가 남았다. application output array index accessor가 실행됐고 adapter request
accessor가 던진 payload-bearing typed error identity가 그대로 나왔다. fix `40aa429`는 두 배열을
descriptor-only exact snapshot으로 바꿔 11/11 GREEN으로 닫았다. 기존 real SQLite capability
assertion도 integration-only `98bea8c`에서 새 ranking facet을 고정해 RCL-002를 14/15에서
15/15로 복원했다.

최종 로컬 검증은 다음을 재현한다.

```bash
pnpm run verify:rcl-006
pnpm run test:rcl-001
pnpm run test:rcl-002
pnpm run test:rcl-003
pnpm run test:rcl-004
pnpm run test:rcl-005
pnpm run test:prj-002
pnpm run test:prj-003
pnpm run test:prj-005
pnpm run test:prj-007
pnpm run test:prj-008
pnpm run test:rec-001
pnpm run test:rec-002
pnpm run test:rec-003
pnpm run verify:rec-004
pnpm test
pnpm run verify:prj-010
python3 -m unittest discover -s spikes/adr-behavior -p 'test_*.py' -v
python3 docs/roadmap/validate.py
pnpm audit --prod
```

focused RCL-006은 11/11이고 RCL-001~005는 10/10, 15/15, 21/21, 15/15,
21/21이다. PRJ-002/003/005/007/008은 7/7, 9/9, 11/11, 19/19, 8/8이고
REC-001/002/003은 13/13, 13/13, 17/17, REC-004 통합 gate는 70/70이다. 전체 fast suite는
53개 파일 420/420, PRJ-010은 39/39, behavior spike는 25/25다. roadmap validator와
production dependency audit도 통과한다.

## 후속 통합 경계

- RCL-007은 반환 배열의 앞 `limit`만 claim candidate로 쓰고 sentinel 여부를 최종
  `more_available` ledger에 합친다. 남는 칸의 raw, support detail, UTC 표시와 payload/note도
  RCL-007 소유다.
- RCL-008은 S10 internal target을 public RecallResult golden, 두 scope 전체 비누출과 모든
  truncation/invariant에 연결한다.
- RCL-009/REL-003은 representative fixture query plan과 p95를 측정한다. 성능 증거 없이
  aggregate cache나 별도 ranking cache를 추가하지 않는다.

모든 로컬 구현 체크를 닫았어도 독립 reviewer 확인, PR 게시와 `main` 병합 전이므로 roadmap
상태는 `IN_PROGRESS`를 유지한다.
