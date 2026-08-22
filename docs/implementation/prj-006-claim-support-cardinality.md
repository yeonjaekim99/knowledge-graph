# PRJ-006: claim·support·카디널리티 상태 전이

- 상태: 구현 완료
- 결정일: 2026-08-22
- 작업: PRJ-006
- Owner: `log0629`
- 규범 근거: ADR-002, ADR-007, ADR-009
- 선행 구현: PRJ-002, PRJ-003, PRJ-004, PRJ-005
- 구현 branch: `prj-006-claim-support-cardinality`
- PR: [#26](https://github.com/yeonjaekim99/knowledge-graph/pull/26)

## 목적과 범위

PRJ-006은 PRJ-004의 scope-bound pre-scan과 PRJ-005의 canonical entity occurrence를 받아
claim identity, structural support와 cardinality 상태 전이를 계산하는 IO 없는 domain reducer를
제공한다. 같은 입력은 byte-equivalent하게 정렬된 frozen 결과를 만들며 DB, clock, network,
process 상태와 behavior spike 구현을 읽지 않는다.

이번 작업은 다음을 구현한다.

- 모든 실제 statement draft의 claim 후보 ID anchor와 canonical occurrence mapping
- inactive statement를 포함한 support anchor와 live statement의 구조적 support
- 동일 claim identity의 numeric-earliest ID 재사용과 `deduplicated` redirect
- 강화, `describes` 단일 cardinality, claim-level 철회 cutoff와 재활성화
- event-level statement 철회가 replacement side effect까지 제외하는 replay 의미
- effective statement 시각에 따른 구조적 first/last seen

merge·alias event에 따른 entity/claim rewrite는 PRJ-007, TTL expiry와 aggregate·relation label·
contested는 PRJ-008, SQLite publish와 증분/full dispatcher는 PRJ-009, 모든 prefix oracle parity는
PRJ-010의 범위다.

## reducer seam과 anchor 단계

`projectClaimSupportState`는 raw replay input을 한 번 pre-scan한 뒤 같은 결과로
`reduceEntitySurfaceKinds`와 `reduceClaimSupportState`를 순서대로 실행하는 black-box 편의
경계다. 조립 계층은 이미 계산한 PRJ-004/005 결과를 두 번째 함수에 직접 넘겨 중복 replay나
IO 없이 재사용할 수 있다.

anchor 단계는 `statementCandidates`를 실제 journal seq와 저장 draft index 순서로 읽는다.
statement가 retracted 또는 superseded여도 다음 항목을 보존한다.

- `c{actual_seq}.{stored_draft_index}` claim anchor
- `(event_id, draft_index)` support anchor
- 해당 occurrence가 최종 canonical claim을 가리키는 mapping

claim identity는 다음 tuple을 JSON-safe key로 고정한다.

```text
(scope_key, canonical_subject_id, relation, object_kind,
 canonical_entity_object_id | trim+NFKC object_value)
```

entity object와 literal object는 텍스트가 같아도 다른 identity다. literal은 내부 공백,
대소문자와 문장부호를 보존한다. 같은 identity 후보가 여러 개면 문자열 사전순이 아니라
ADR-002의 숫자 occurrence 순서로 가장 이른 ID를 canonical로 선택한다. 따라서 `c2.0`은
`c10.0`보다 먼저이며 늦은 후보는 최종 canonical을 직접 가리킨다.

같은 stored statement에 canonical identity가 중복되면 projection을 조용히 합치지 않고
`DUPLICATE_STATEMENT_CLAIM`으로 실패한다. ADR-009/013은 record 검증이 같은 요청의 중복을
journal append 전에 첫 draft 하나로 합쳐야 한다고 정하므로, 저장된 중복은 복구 가능한
입력이 아니라 writer/journal invariant 위반이다. PRJ-007이 merge로 서로 다른 기존
identity를 합칠 때의 support dedupe는 별도 규칙으로 처리한다.

## 의미 stream 상태 전이

모든 support는 먼저 `live=0`, claim은 `retracted`로 anchor된다. PRJ-004가 정렬한 effective
event stream의 live statement만 draft 순서대로 다음 전이를 적용한다.

1. occurrence의 canonical claim을 찾는다.
2. `describes`이면 같은 `(scope, subject)`의 다른 active claim을 먼저 `superseded`로 내린다.
3. 대상 claim을 `active`로 만든다.
4. 현재 `(event, draft)` support를 `live=1`로 만든다.

같은 identity가 이미 active면 claim row를 만들지 않고 support만 강화한다. 과거
`superseded`/`retracted` claim이 다시 진술되면 같은 ID를 위 순서로 활성화한다. 다중 관계인
`uses`, `rejects`, `contains`, `relates_to`에는 서로 다른 object가 함께 active로 남는다.
`uses`/`rejects` 상충은 구조적 대체가 아니며 PRJ-008 이후 읽기 aggregate가 판정한다.

active describes slot과 claim별 support를 map으로 색인해 statement마다 전체 claim/support를
다시 훑지 않는다. 상태 전이 scan은 입력 occurrence와 철회 대상 support 수에 비례하고,
결정적 출력 정렬에는 `O(n log n)`이 든다. 대규모 end-to-end p95는 REL-001~003의 측정
gate에 남긴다.

## 두 철회 범위와 재해석

claim retraction은 먼저 target 후보가 실제 retraction seq보다 앞서 존재했는지 검사하고,
redirect source를 포함해 canonical claim으로 해석한다. 그 claim의 support 중
`statement.order_seq < retraction.actual_seq`인 것만 `live=0`으로 바꾸고 대상 claim만
`retracted`로 만든다.

이 cutoff는 actual seq가 늦은 reinterpret successor라도 root `order_seq`가 과거이면 이미
있었던 claim 철회를 우회하지 못하게 한다. 반대로 철회 이후의 새 일반 statement는 더 큰
order seq의 support를 추가해 같은 claim ID를 다시 활성화할 수 있다.

현재 describes claim을 claim 단위로 철회하면 slot mapping만 비우고 이전 superseded 값을
복구하지 않는다. statement event retraction은 PRJ-004 pre-scan이 해당 statement를 의미
stream에서 처음부터 제외하므로 그 statement가 만들었던 implicit replacement도 사라지고
이전 값이 replay 중 다시 active가 된다.

backdated reinterpret는 root 위치에서 먼저 적용된다. 따라서 root seq 1을 실제 seq 3에서
재해석해도 독립적인 seq 2 describes 결정을 덮지 않는다. successor event를 `cascade=false`로
철회해 root가 복구되어도 seq 2 결정은 여전히 나중이므로 current 값을 유지한다.

## 구조 시각과 TTL 경계

`firstSeenAt`과 `lastSeenAt`은 현재 구조적으로 live인 support의 effective statement
`createdAt` 최소/최대다. reinterpret append 시각은 이 값을 최신처럼 만들지 않는다. live
support가 없는 anchor claim은 외부 ID의 역사적 행을 유지하기 위해 최초 occurrence의
effective createdAt을 보존한다.

PRJ-006의 structural support에는 `expiresAt`을 넣지 않는다. TTL 종류나 현재 wall clock은
claim/support의 구조 상태를 바꾸지 않으며, PRJ-008이 같은 pre-scan metadata에서 statement와
support expiry를 함께 계산해 최종 projection row와 aggregate를 만든다. 이 경계 때문에
`permanent`와 `session`만 바꾼 fixture는 동일한 PRJ-006 출력이 된다.

## 출력과 실패 계약

`ClaimSupportStateProjection`은 다음 collection을 모두 재귀적으로 freeze하고 명시적으로
정렬한다.

- `claimAnchors`: 모든 stored draft 후보 ID
- `claims`: canonical identity별 구조 상태와 effective first/last seen
- `claimSupport`: expiry 전의 structural `(claim,event,draft,live)`
- `idRedirects`: claim 종류의 최종 `deduplicated` redirect
- `occurrences`: 모든 stored draft에서 canonical claim으로의 mapping

PRJ-009는 이 claim redirect를 PRJ-005/007의 entity redirect와 결합한 뒤 SQLite에 게시한다.
`ClaimProjectionError`는 고정 code/message만 제공하고 raw text, subject/object, relation label,
scope, target ID나 내부 cause를 보관하지 않는다. 다음 오류를 fail closed로 구분한다.

- canonical stored draft가 아닌 입력
- PRJ-004/005 scope·rules·occurrence seam 불일치
- 같은 statement의 중복 canonical claim
- 존재하지 않거나 미래인 claim retraction target
- active support/cardinality invariant 위반

## TDD와 검증

첫 RED는 test가 import한 `ClaimProjectionError`와 reducer export가 아직 없어 ESM module
instantiation에서 실패했다. GREEN fixture는 다음 정상·경계·실패 경로를 검증한다.

- entity/literal object kind와 literal case·내부 공백 identity
- 반복 statement 강화, 모든 candidate anchor와 numeric `c2 < c10` redirect
- `describes A → B → A`의 선 supersede·후 activation과 과거 ID 재사용
- claim/event retraction의 이전 값 복구 차이와 multi-claim 철회 격리
- 과거 claim 철회 뒤 backdated reinterpret support cutoff와 이후 일반 statement 재활성화
- reinterpret effective first/last seen, later describes 우선순위와 event undo
- TTL 변화의 구조 상태 불변성과 다중 relation 공존
- stored duplicate, invalid relation/label, missing/future target와 forged entity seam의 안전한 실패
- 원본 입력 불변성, recursive freeze, wrapper/reducer parity와 반복 실행 결정성

검증 명령은 다음과 같다.

```bash
pnpm verify:prj-006
pnpm test:prj-004
pnpm test:prj-005
pnpm verify:local
python3 -m unittest discover -s spikes/adr-behavior -p 'test_*.py' -v
python3 docs/roadmap/validate.py
```

완료 시점 기준 PRJ-006 target은 13/13, PRJ-004 회귀는 14/14, PRJ-005 회귀는 11/11,
빠른 전체 suite는 155/155다. S03/S04/S15의 domain 상태 primitive는 고정했지만 실제
record/revise·SQLite prefix/full replay 경로가 남아 production scenario manifest는
`planned`를 유지한다. S10의 TTL aggregate·label·contested 범위는 PRJ-008이 소유한다.

## 후속 작업 경계

- PRJ-007: merge·alias event, claim survivor/support dedupe, describes merge 충돌과 undo
- PRJ-008: effective TTL, statement/support expiry, aggregate·relation label·contested
- PRJ-009: reducer 조립, SQLite transaction과 증분/full replay dispatcher
- PRJ-010: S01~S24의 모든 journal prefix와 canonical projection parity
- REC-005/006: request duplicate를 저장 전에 제거하고 RecordResult와 동기 projection 연결
- REV-003: 실제 claim/event retraction append, target preflight와 no-op 결과

Accepted ADR의 의미를 바꾸지 않으므로 superseding ADR은 필요하지 않다.
