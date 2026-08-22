# PRJ-008: TTL·claim aggregate 유효성 source

- 상태: 구현 완료
- 결정일: 2026-08-22
- 작업: PRJ-008
- Owner: `log0629`
- 규범 근거: ADR-010
- 선행 구현: PRJ-004, PRJ-006; 조립 seam 검증: PRJ-007
- 구현 branch: `prj-008-ttl-claim-aggregate`
- PR: [#28](https://github.com/yeonjaekim99/knowledge-graph/pull/28)

## 목적과 범위

PRJ-006/007까지의 support는 철회·대체를 반영한 구조 상태만 가진다. TTL은 wall clock이
지났다고 claim state를 쓰기로 바꾸지 않으므로, projector가 statement/support의 effective
expiry를 만들고 읽기 쿼리가 고정된 시각에 유효한 support만 골라야 한다.

이번 작업은 다음 production seam을 구현한다.

- provenance별 기본 TTL과 session/weeks/permanent 수명 계산
- 모든 statement와 structural support의 동일한 effective expiry 투영
- 하나의 valid-support SQL template에서 diagnostic view와 scope/fixed-now TEMP query 생성
- 같은 support 집합에서 count, strongest, last_seen, 최신 non-empty label과 claim expiry 집계
- 같은 aggregate를 사용하는 diagnostic/recall contested 표현식
- statement/support expiry와 scope 일치를 검사하는 projector invariant query

SQLite projection publish와 dispatcher는 PRJ-009, 전체 journal prefix parity는 PRJ-010,
실제 recall read transaction과 TEMP materialization은 RCL-001이 소유한다. traversal, ranking,
overview, raw/FTS와 공개 `RecallResult`도 Phase 06 범위다.

## effective lifetime과 기본값 경계

`resolveEffectiveStatementLifetime`은 ambient clock을 읽지 않고 다음 입력만 사용한다.

```text
effective createdAt + effective provenance + optional ttl
```

기본값은 `user_stated/observed → permanent`, `inferred → weeks`이며 명시 TTL이 우선한다.
session은 43,200초, weeks는 2,592,000초, permanent는 `NULL`이다. JS safe integer를 넘는
expiry는 자동 반올림하지 않고 `TTL_EXPIRY_OUT_OF_RANGE`로 실패한다.

저장된 canonical statement body는 PRJ-004 계약대로 provenance와 적용된 ttl을 이미
명시해야 한다. 이 작업의 optional-TTL helper는 REC-007이 요청 기본값을 journal body에
고정할 때 재사용할 규칙 원본이지, replay가 누락된 stored ttl을 추측하게 만드는 우회로가
아니다. provenance 자체의 public 기본 `inferred` 적용도 REC-007의 책임으로 남긴다.

## statement/support expiry reducer

`reduceClaimValidityState(preScan, structuralProjection)`은 PRJ-004의 effective statement
metadata와 PRJ-006/007 compatible structural claim/support 출력을 받는 IO 없는 reducer다.
각 statement에 다음 row를 만들고, 그 statement를 가리키는 support에 정확히 같은
`expiresAt`을 복사한다.

```text
statement: actual event ID/state/order + effective createdAt/provenance/expiry
support:   structural claim/event/draft/live + owning statement expiry
```

따라서 재해석 successor는 실제 successor event ID와 support anchor를 유지하지만 root의
createdAt/TTL로 만료된다. `parsed: []` statement도 statement row와 expiry를 가지므로 raw
조회에서 TTL을 우회하지 않는다. retracted/superseded statement와 inactive support도 ID
history를 위해 expiry를 가지며, 실제 유효성은 SQL이 statement/claim/support state와 now를
함께 보고 판단한다.

reducer는 구조적 claim state나 support live를 변경하지 않는다. scope/rules mismatch,
unknown claim/event, 잘못된 draft index, 중복 `(claim,event)`/`(event,draft)`, 잘못된 ID와
expiry 범위를 payload-redacted `ProjectionValidityError`로 거부한다. 출력과 모든 row/array는
freeze하며 입력과 ambient runtime을 변경하지 않는다.

## 하나의 valid-support SQL source

`CLAIM_AGGREGATE_SQL_SOURCE`는 내부 `aggregateSelect` 하나에서 두 SELECT를 생성한다.

| variant | 시각 | scope | 용도 |
|---|---|---|---|
| diagnostic | `unixepoch('now')` | 전역, caller가 claims join으로 제한 | `claim_agg` 정답 정의·운영 진단 |
| recall | bound `:now` | bound `:scope_key` | 한 recall snapshot의 TEMP aggregate |

두 variant의 차이는 now expression과 scope predicate뿐이다. 공통 CTE `valid_support`는 다음
조건을 모두 만족한 row만 한 번 만든다.

```text
claim active
support live
statement live
claim/statement/journal scope 동일
support expiry IS NULL OR support expiry > evaluation now
```

이 CTE에서 support count, provenance rank, effective createdAt의 최댓값, expiry 집계와
relation label을 모두 계산한다. label은 같은 CTE 안에서 `order_seq DESC`, 실제 journal
`seq DESC`, 마지막으로 draft index 순으로 최신 non-empty 값을 고른다. 최신 support가
만료·철회되거나 label이 비어 있으면 이전 유효 label로 돌아간다. 유효 permanent support가
하나라도 있으면 claim expiry는 `NULL`, 전부 유한하면 남은 support의 최대 expiry다.

TEMP query는 caller 문자열을 SQL에 합치지 않고 named binding만 사용한다. diagnostic view는
전역이므로 사용하는 관리 query가 반드시 claims와 join해 scope를 제한해야 한다. contested
표현식도 현재 claim과 반대 claim 모두 해당 aggregate에 있을 때만 true이며, entity와 literal
object identity를 각각 null-safe `IS`로 비교한다.

## 무결성과 read-only 의미

`projectionValidityInvariant`는 scope별로 다음 수를 한 row에 반환한다.

- journal body의 명시 TTL과 effective statement expiry 불일치
- statement expiry와 support expiry 불일치
- journal/statement 또는 statement/claim 사이의 cross-scope 연결

aggregate 자체도 scope equality를 다시 요구하므로 손상된 cross-scope support가 답 후보에
들어오지 않는다. PRJ-009는 publish 전에 이 query를 commit gate에 연결한다.

`CREATE TEMP TABLE ... AS`는 connection-local 임시 상태를 만들지만 journal과 영구 projection을
쓰지 않는다. 실제 file-backed SQLite fixture에서 TEMP materialization과 view 조회 전후 영구
table row count와 별도 reader의 `PRAGMA data_version`이 그대로임을 확인했다. 한 호출의
`:now`는 RCL-001이 request runtime snapshot에서 한 번 캡처해 전달한다.

기존 `001-v1-schema.sql`은 checksum이 고정된 migration이므로 수정하지 않았다. PRJ-008은
diagnostic view DDL과 TEMP materialization SQL을 실행하지 않고 adapter source로 제공한다.
projection lifecycle 연결은 PRJ-009, per-call 실행은 RCL-001에서 이 source를 그대로 소비한다.

## TDD와 독립 대조

첫 RED는 새 domain과 SQLite export가 없어 두 test module의 ESM import 단계에서 실패했다.
GREEN 뒤 ADR-010 Validation과 S09/S10/S11/S19/S23 의미를 독립 fixture로 다시 읽으며 다음
반례를 추가했다.

- expiry와 정확히 같은 `now`에서는 support를 제외하고 1초 전에는 포함한다.
- 만료된 강한 최신 support는 count/strongest/label/contested 어느 값도 부풀리지 않는다.
- 최신 empty label과 retracted label은 이전 유효 non-empty label을 가리지 않는다.
- merge 뒤 하나의 claim에 모인 support도 각 effective statement expiry를 유지한다.
- raw-only statement에는 support가 없어도 statement expiry가 남는다.
- cross-scope support 손상은 invariant에 잡히고 aggregate에는 들어오지 않는다.
- TEMP 생성·조회는 영구 row와 다른 reader의 data version을 바꾸지 않는다.

production test는 behavior spike module을 import하거나 Python 구현을 복사하지 않고 수동으로
계산한 expected row를 실제 SQLite 결과와 비교한다. PRJ-009/010과 RCL-001~008이 남아 있어
S09~S11/S19/S23 production scenario manifest는 아직 `planned`를 유지한다.

## 검증

```bash
pnpm verify:prj-008
pnpm test:prj-004
pnpm test:prj-006
pnpm test:prj-007
pnpm verify:local
python3 -m unittest discover -s spikes/adr-behavior -p 'test_*.py' -v
python3 docs/roadmap/validate.py
pnpm audit --prod
```

완료 시점 기준 PRJ-008 target은 8/8, PRJ-004는 14/14, PRJ-006은 15/15,
PRJ-007은 19/19이고 빠른 전체 suite는 184/184다. architecture/type/build, roadmap audit,
독립 behavior spike 25/25, clean source archive와 production dependency audit도 완료 증거에
포함한다.

## 후속 작업 경계

- PRJ-009: PRJ-004~008 reducer 조립, SQLite publish transaction과 validity commit gate
- PRJ-010: 모든 journal prefix에서 production reducer와 독립 oracle parity
- REC-007: provenance/TTL 기본을 canonical stored body에 명시하고 raw-only record 연결
- RCL-001: request scope/fixed-now/read transaction과 TEMP aggregate materialization
- RCL-003~006: raw expiry, traversal/overview/ranking과 aggregate-backed contested 소비
- REL-003/DEF-002: 측정 trigger를 충족한 뒤에만 aggregate cache를 검토

Accepted ADR 의미를 바꾸지 않으므로 superseding ADR은 필요하지 않다.
