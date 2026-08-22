# Phase 03 — 투영, 상태 전이와 재생

- 상태: `IN_PROGRESS`
- 진행률: 6/10
- 선행 phase: Phase 02 `DONE`
- 주요 근거: ADR-001, ADR-002, ADR-004, ADR-006~010, ADR-017
- 선행 증거 감사: [Phase 03 baseline과 production gap](evidence-audit.md#phase-03-projection)
- 종료 조건: 모든 사건 prefix에서 증분 적용과 scope 전체 replay의 canonical 결과가 같고,
  ID·상태·redirect·FK 불변식이 실제 SQLite에서 유지됨

> evidence audit의 `[x]`는 기존 증거 대조 완료다. 아래 작업의 `TODO/DONE`과 production
> 완료 체크를 대신하지 않는다.

## 작업 현황

| ID | 작업 | 상태 | Owner | 선행 작업 | 증거 |
|---|---|---|---|---|---|
| PRJ-001 | replay 입력·출력과 rules version 기반 | `DONE` | `log0629` | STO-003, STO-004, FND-003 | [PR #21](https://github.com/yeonjaekim99/knowledge-graph/pull/21) |
| PRJ-002 | 정규화·관계·리터럴 동일성 규칙 | `DONE` | `log0629` | PRJ-001 | [PR #22](https://github.com/yeonjaekim99/knowledge-graph/pull/22) |
| PRJ-003 | occurrence ID와 redirect registry | `DONE` | `log0629` | PRJ-001, PRJ-002 | [PR #23](https://github.com/yeonjaekim99/knowledge-graph/pull/23) |
| PRJ-004 | 사건 pre-scan과 effective statement 계산 | `DONE` | `log0629` | PRJ-001, PRJ-003 | [PR #24](https://github.com/yeonjaekim99/knowledge-graph/pull/24) |
| PRJ-005 | entity·surface·kind 투영 | `DONE` | `log0629` | PRJ-002~004 | [PR #25](https://github.com/yeonjaekim99/knowledge-graph/pull/25) |
| PRJ-006 | claim·support·카디널리티 상태 전이 | `DONE` | `log0629` | PRJ-002~005 | [PR #26](https://github.com/yeonjaekim99/knowledge-graph/pull/26) |
| PRJ-007 | merge·alias와 claim rewrite | `TODO` | `unassigned` | PRJ-005, PRJ-006 | — |
| PRJ-008 | TTL·aggregate와 조회용 유효성 source | `TODO` | `unassigned` | PRJ-004, PRJ-006 | — |
| PRJ-009 | 증분 dispatcher·전체 replay·무결성 검사 | `TODO` | `unassigned` | PRJ-003~008 | — |
| PRJ-010 | prefix oracle·metamorphic·crash parity | `TODO` | `unassigned` | PRJ-009, STO-008 | — |

## 상세 체크리스트

### PRJ-001 — replay 입력·출력과 rules version 기반

- 상태: `DONE`
- Owner: `log0629`
- Branch: `prj-001-replay-contract`
- PR: [#21](https://github.com/yeonjaekim99/knowledge-graph/pull/21)
- 근거: ADR-001, ADR-007, ADR-017
- 선행 작업: STO-003, STO-004, FND-003
- 결과물: 결정적 reducer 계약, projection_meta와 canonical dump

완료 체크:

- [x] reducer 입력은 정렬된 journal event, scope와 rules version뿐이고 운영 `rebuiltAt`은 제외한다.
- [x] full replay가 한 scope의 projection을 `BEGIN IMMEDIATE` 하나에서 교체한다.
- [x] `projection_meta.last_seq`와 rules version 불일치가 replay를 강제한다.
- [x] canonical dump가 row와 JSON key를 명시적으로 정렬하고 TEMP/물리 시각을 제외한다.
- [x] reducer가 git, network, LLM과 wall clock을 직접 호출하지 않는다.

완료 증거:

- [구현 결정](../implementation/prj-001-replay-contract.md)에 pure reducer 입력, worker-held
  replay session, meta 판정, canonical format과 후속 owner 경계를 고정했다.
- TDD RED는 target 2개 file이 아직 없는 domain/adapter export 때문에 실패했고, GREEN은
  `pnpm verify:prj-001` 8/8과 전체 `pnpm verify:local` 101/101이다.
- 실제 file DB에서 WAL reader old snapshot, 외부 writer `SQLITE_BUSY`, 다른 scope·journal·FTS
  보존, trigger/reducer 실패 rollback과 queue 재사용을 검증했다.
- production encoder와 독립 reference encoder의 `recall-projection-v1` byte/checksum parity를
  검증했으며 meta·FTS·다른 scope 변화가 dump를 바꾸지 않는다.
- S02/S24와 증분 dispatcher·사건 의미는 완료로 과장하지 않고 PRJ-002~010에 남겼다.

### PRJ-002 — 정규화·관계·리터럴 동일성 규칙

- 상태: `DONE`
- Owner: `log0629`
- Branch: `prj-002-normalization-relations`
- PR: [#22](https://github.com/yeonjaekim99/knowledge-graph/pull/22)
- 근거: ADR-004, ADR-006, ADR-009
- 선행 작업: PRJ-001
- 결과물: versioned normalize와 claim identity primitive

완료 체크:

- [x] entity/surface는 trim → NFKC → locale 비의존 lowercase → 공백·하이픈·underscore 제거 순서를 고정한다.
- [x] 한국어 조사 제거, fuzzy match와 자동 relation 승격은 구현하지 않는다.
- [x] 정규화 뒤 빈 문자열을 거부하고 locale을 바꿔도 같은 fixture 결과를 만든다.
- [x] literal은 trim+NFKC만 적용하고 내부 공백·대소문자·문장부호를 보존한다.
- [x] 정규 relation 5종과 `describes` 단일 카디널리티를 한 registry에서 제공한다.
- [x] `relates_to`의 비어 있지 않은 label 조건과 relation별 fixture가 있다.

완료 증거:

- [구현 결정](../implementation/prj-002-normalization-relations.md)에 `normalize_v1`, literal
  identity, relation registry, label 계약과 후속 reducer·schema·운영 owner 경계를 고정했다.
- TDD RED는 아직 없는 relation/normalization domain export 때문에 실패했고, GREEN은
  `pnpm verify:prj-002` 7/7과 전체 `pnpm verify:local` 108/108이다.
- C와 Turkish locale의 별도 process가 같은 fixture byte를 만들며 NFKC 순서, 한국어 조사,
  빈 값, punctuation과 256/257 Unicode code-point label 경계를 검증했다.
- replay snapshot relation validator가 같은 immutable registry source를 사용하지만 entity,
  claim과 dispatcher를 구현한 것으로 과장하지 않는다. S01/S03은 후속 PRJ-005/006/010까지
  `planned`를 유지한다.

### PRJ-003 — occurrence ID와 redirect registry

- 상태: `DONE`
- Owner: `log0629`
- Branch: `prj-003-occurrence-redirects`
- PR: [#23](https://github.com/yeonjaekim99/knowledge-graph/pull/23)
- 근거: ADR-002
- 선행 작업: PRJ-001, PRJ-002
- 결과물: 후보 ID 발급, canonical 선택과 redirect resolver

완료 체크:

- [x] 저장된 parsed index와 subject→entity object 발생 순서로 모든 후보 ID를 계산하며,
      기존 entity로 해석된 occurrence도 위치를 소비한다.
- [x] dedupe/rule change는 가장 이른 후보를, 명시적 merge는 keep을 canonical로 삼는다.
- [x] redirect를 최종 canonical로 압축하고 cycle·종류 혼합·32 hop 초과를 손상으로 거부한다.
- [x] 외부 ID 정규식과 scope를 redirect 전후 모두 검증한다.
- [x] one-to-many rules dry-run은 배포 차단 결과와 정비 후보를 만든다.

완료 증거:

- [구현 결정](../implementation/prj-003-occurrence-redirects.md)에 저장 occurrence 위치,
  숫자 canonical 선택, redirect 손상·압축과 non-mutating rules dry-run 경계를 고정했다.
- TDD RED는 아직 없는 identifier domain export 때문에 실패했고, GREEN은
  `pnpm verify:prj-003` 9/9과 전체 `pnpm verify:local` 117/117이다.
- entity/literal object, alias, 반복 subject가 위치를 소비하는 차이와 event/entity/claim
  canonical 정규식, `e9.10 < e10.2` 숫자 비교를 fixture로 검증했다.
- entity와 claim 정상 chain, source/target scope, self·dangling·duplicate·cycle·kind/scope
  손상과 32/33-hop 경계를 safe typed error로 검증했다.
- many-to-one은 입력 순서와 무관한 redirect 계획을, one-to-many는 ID-only maintenance와
  전체 배포 차단을 반환하며 journal·projection·DB를 수정하지 않는다.
- event pre-scan은 PRJ-004에서 이어 완료했고 entity/claim 상태 reducer, merge/alias event,
  DB publish와 RecordResult index mapping은 PRJ-005~009와 REC-005에 남겼다.

### PRJ-004 — 사건 pre-scan과 effective statement 계산

- 상태: `DONE`
- Owner: `log0629`
- Branch: `prj-004-effective-event-stream`
- PR: [#24](https://github.com/yeonjaekim99/knowledge-graph/pull/24)
- 근거: ADR-007, ADR-010, ADR-017
- 선행 작업: PRJ-001, PRJ-003
- 결과물: 사건 효력 pre-scan과 의미 event stream

완료 체크:

- [x] retraction은 과거의 statement/merge/alias만 가리키고 retraction·미래 event는 거부한다.
- [x] supersedes graph의 cycle·교차 scope·복수 live leaf를 검출한다.
- [x] cascade true/false와 `retracted > superseded > live` 우선순위를 적용한다.
- [x] successor payload는 실제 seq 기반 후보 ID와 root order_seq를 함께 유지한다.
- [x] effective created_at/provenance/ttl 승계와 recorded 시각 분리를 fixture로 검증한다.

완료 증거:

- [구현 결정](../implementation/prj-004-event-pre-scan.md)에 scope-bound 입력, retraction과
  supersedes pre-scan, actual/effective 순서·시각, frozen 출력과 후속 reducer 경계를 고정했다.
- 첫 TDD RED는 아직 없는 pre-scan export에서 실패했다. spike 대조 리뷰에서 중간
  `cascade:false`가 두 live leaf를 만들던 문제와 깊은 재귀 stack 소진을 각각 추가 RED로
  재현한 뒤 direct-child leaf 판정과 반복형 traversal/root registry로 수정했다.
- `pnpm verify:prj-004`는 14/14를 3회 연속 통과했고 전체 `pnpm verify:local`은 131/131이다.
  12,000단계 cycle은 safe typed error로, 같은 길이 cascade는 stack 소진 없이 전체 component로
  확장된다.
- event target의 missing/future/retraction/kind/cascade와 supersedes의 cycle·branch·metadata
  drift·cross-scope를 payload 비노출 오류로 검증했다. 동일 journal 재실행은 byte-equivalent하고
  domain pass는 clock·DB·network와 production spike import를 사용하지 않는다.
- 독립 behavior spike 25/25, dependency audit 취약점 0개, roadmap audit와 clean source gate를
  통과했다. claim/support·describes reduce와 SQLite prefix parity가 남아 S14/S15는 `planned`를
  유지하며 PRJ-005~010이 이어받는다.

### PRJ-005 — entity·surface·kind 투영

- 상태: `DONE`
- Owner: `log0629`
- Branch: `prj-005-entity-surface-kind`
- PR: [#25](https://github.com/yeonjaekim99/knowledge-graph/pull/25)
- 근거: ADR-006, ADR-008
- 선행 작업: PRJ-002~004
- 결과물: entity resolver와 surface/kind reducer

완료 체크:

- [x] surface 후보 전체를 canonicalize하고 exact normal name으로도 하나가 안 되면 모호하게 거부한다.
- [x] 새 entity와 name surface, 기존 entity occurrence redirect를 결정적으로 만든다.
- [x] subject/object alias 방향과 `confirmed > name > agent_supplied` 우선순위를 보존한다.
- [x] kind는 identity에 쓰지 않고 가장 이른 live occurrence를 택하며 불일치를 정비 신호로 남긴다.
- [x] claim 철회와 statement 철회가 surface/kind 근거에 미치는 차이를 검증한다.

완료 증거:

- [구현 결정](../implementation/prj-005-entity-surface-kind.md)에 inactive occurrence anchor와
  live structural evidence의 두 단계 reduce, surface ambiguity, origin과 kind 규칙 및 후속
  owner 경계를 고정했다.
- 첫 TDD RED는 아직 없는 `EntityProjectionError` export에서 실패했다. GREEN은
  `pnpm verify:prj-005` 11/11이며 PRJ-004 seam 회귀 14/14와 전체 `pnpm verify:local`
  142/142를 통과했다.
- name·agent-supplied·confirmed resolver, redirect terminal, exact-name tie-break와 stable
  ambiguity, alias 방향·중복, inactive anchor, claim/statement 철회 차이, root-order kind와
  64/65 code-point 경계를 정상·경계·실패 fixture로 검증했다.
- 오류는 이름·scope·alias·payload·cause를 노출하지 않고 출력과 pre-scan의 inactive parsed
  anchor는 재귀적으로 frozen이다. domain은 clock·DB·network·process와 spike import를 쓰지 않는다.
- 독립 behavior spike 25/25, roadmap audit, dependency audit 취약점 0개와 clean source gate를
  통과했다. 실제 merge/alias event와 claim rewrite·SQLite publish가 남아 S08/S21은
  `planned`를 유지하며 PRJ-006/007/009/010과 REC-004가 이어받는다.

### PRJ-006 — claim·support·카디널리티 상태 전이

- 상태: `DONE`
- Owner: `log0629`
- Branch: `prj-006-claim-support-cardinality`
- PR: [#26](https://github.com/yeonjaekim99/knowledge-graph/pull/26)
- 근거: ADR-002, ADR-007, ADR-009
- 선행 작업: PRJ-002~005
- 결과물: claim/support reducer와 상태 전이 test

완료 체크:

- [x] 동일 identity는 과거 상태와 무관하게 가장 이른 claim ID를 재사용한다.
- [x] `describes`는 기존 active 값을 먼저 supersede한 뒤 대상 claim을 활성화한다.
- [x] claim 철회는 과거 support만 끊고 event 철회는 statement의 side effect 전체를 제외한다.
- [x] claim 철회는 과거 describes를 복구하지 않고 대체 event 철회는 복구한다.
- [x] TTL만으로 구조적 claim state를 쓰기 변경하지 않는다.
- [x] first/last seen과 support live 상태가 effective statement 순서와 일치한다.

완료 증거:

- [구현 결정](../implementation/prj-006-claim-support-cardinality.md)에 모든 stored occurrence
  anchor와 numeric-earliest claim identity, structural support 출력 및 PRJ-008 expiry 경계를
  고정했다.
- TDD RED는 아직 없는 claim reducer export에서 실패했고 GREEN은 `pnpm verify:prj-006`
  13/13이다. PRJ-004 14/14, PRJ-005 11/11과 전체 `pnpm verify:local` 155/155도 통과했다.
- 강화, entity/literal identity, `describes A→B→A`, claim/event 철회 복구 차이, multi-claim
  격리, future support 재활성화와 numeric `c2<c10`을 정상·경계 fixture로 검증했다.
- backdated reinterpret의 claim cutoff·later describes 우선순위·event undo와 effective
  first/last seen을 S04/S15 spike 의미와 독립 대조했다. TTL만 바꾼 출력은 동일하다.
- stored duplicate, invalid relation/label, missing/future target와 forged PRJ-005 seam은
  payload·scope·target·cause를 노출하지 않는 typed error로 fail closed한다.
- 독립 behavior spike 25/25, roadmap audit, dependency audit 취약점 0개와 clean source gate를
  통과했다. 실제 merge/alias, expiry aggregate, SQLite dispatcher와 full prefix parity가 남아
  S03/S04/S10/S15 target은 `planned`를 유지하며 PRJ-007~010과 REC/REV/RCL owner가 이어받는다.

### PRJ-007 — merge·alias와 claim rewrite

- 상태: `TODO`
- Owner: `unassigned`
- 근거: ADR-002, ADR-007~009, ADR-015
- 선행 작업: PRJ-005, PRJ-006
- 결과물: merge/alias event reducer와 undo 가능한 rewrite

완료 체크:

- [ ] merge cycle을 거부하고 absorb surface·claim·support를 keep으로 안전하게 옮긴다.
- [ ] claim survivor를 origin_seq와 숫자 index로 선택하고 중복 support를 잃지 않는다.
- [ ] 서로 다른 describes 충돌은 의미 순서가 최신인 하나만 active로 만든다.
- [ ] alias 확인과 철회가 남은 기여의 가장 강한 origin으로 되돌아간다.
- [ ] merge/alias event 철회 replay가 사건이 없었던 현재 투영과 같고 history는 보존된다.

### PRJ-008 — TTL·aggregate와 조회용 유효성 source

- 상태: `TODO`
- Owner: `unassigned`
- 근거: ADR-010
- 선행 작업: PRJ-004, PRJ-006
- 결과물: claim_agg source template과 invariant query

완료 체크:

- [ ] provenance 기본 TTL과 session 43,200초, weeks 2,592,000초를 effective 시각에서 계산한다.
- [ ] statement/support expiry가 같고 raw-only statement도 TTL을 우회하지 않는다.
- [ ] count·strongest·last_seen·relation_label이 같은 유효 support 집합에서 나온다.
- [ ] 최신 label이 만료/철회되면 이전 유효 label로 돌아가고 permanent 하나면 expiry는 NULL이다.
- [ ] view와 scope/now parameterized TEMP query가 같은 source template에서 생성된다.

### PRJ-009 — 증분 dispatcher·전체 replay·무결성 검사

- 상태: `TODO`
- Owner: `unassigned`
- 근거: ADR-001, ADR-007, ADR-017
- 선행 작업: PRJ-003~008
- 결과물: event dispatcher, replay service와 commit gate

완료 체크:

- [ ] 일반 statement/claim retraction/새 merge·alias는 증분, 과거 의미 변경은 scope replay로 분기한다.
- [ ] journal append와 projection 적용이 같은 transaction에서 성공 또는 rollback된다.
- [ ] commit 전 active support, describes uniqueness, redirect, last_seq와 FK를 검증한다.
- [ ] 손상 감지 시 부분 수선하지 않고 명확한 오류 또는 scope replay를 선택한다.
- [ ] 성공 반환 직후 같은 connection과 새 reader에서 read-your-writes를 보장한다.

### PRJ-010 — prefix oracle·metamorphic·crash parity

- 상태: `TODO`
- Owner: `unassigned`
- 근거: ADR-001~010, ADR-017과 behavior spike
- 선행 작업: PRJ-009, STO-008
- 결과물: production reducer 회귀 suite

완료 체크:

- [ ] S01~S24를 production API 또는 reducer fixture로 재실행한다.
- [ ] 모든 operation prefix에서 증분 결과와 같은 prefix full replay 결과가 byte-equivalent다.
- [ ] event 분해, scope interleave, time shift와 merge/alias undo metamorphic case가 통과한다.
- [ ] hard process exit 뒤 이전 또는 새 완전 상태만 남고 reopen replay가 같다.
- [ ] spike와 구현 차이는 ADR에 근거해 설명하고 production에서 spike module을 import하지 않는다.

## Phase 종료 체크

- [ ] 같은 journal·rules·now가 항상 같은 canonical projection을 만든다.
- [ ] 모든 증분 prefix가 full replay oracle과 같다.
- [ ] scope·FK·ID·redirect·support·describes 불변식 위반이 0건이다.
- [ ] Phase 04와 Phase 06이 같은 projection/aggregate 계약 위에서 병렬 착수할 수 있다.
