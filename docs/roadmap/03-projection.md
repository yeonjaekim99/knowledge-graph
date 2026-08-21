# Phase 03 — 투영, 상태 전이와 재생

- 상태: `TODO`
- 진행률: 0/10
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
| PRJ-001 | replay 입력·출력과 rules version 기반 | `TODO` | `unassigned` | STO-003, STO-004, FND-003 | — |
| PRJ-002 | 정규화·관계·리터럴 동일성 규칙 | `TODO` | `unassigned` | PRJ-001 | — |
| PRJ-003 | occurrence ID와 redirect registry | `TODO` | `unassigned` | PRJ-001, PRJ-002 | — |
| PRJ-004 | 사건 pre-scan과 effective statement 계산 | `TODO` | `unassigned` | PRJ-001, PRJ-003 | — |
| PRJ-005 | entity·surface·kind 투영 | `TODO` | `unassigned` | PRJ-002~004 | — |
| PRJ-006 | claim·support·카디널리티 상태 전이 | `TODO` | `unassigned` | PRJ-002~005 | — |
| PRJ-007 | merge·alias와 claim rewrite | `TODO` | `unassigned` | PRJ-005, PRJ-006 | — |
| PRJ-008 | TTL·aggregate와 조회용 유효성 source | `TODO` | `unassigned` | PRJ-004, PRJ-006 | — |
| PRJ-009 | 증분 dispatcher·전체 replay·무결성 검사 | `TODO` | `unassigned` | PRJ-003~008 | — |
| PRJ-010 | prefix oracle·metamorphic·crash parity | `TODO` | `unassigned` | PRJ-009, STO-008 | — |

## 상세 체크리스트

### PRJ-001 — replay 입력·출력과 rules version 기반

- 상태: `TODO`
- Owner: `unassigned`
- 근거: ADR-001, ADR-007, ADR-017
- 선행 작업: STO-003, STO-004, FND-003
- 결과물: 결정적 reducer 계약, projection_meta와 canonical dump

완료 체크:

- [ ] reducer 입력은 정렬된 journal event, scope, rules version과 주입된 clock뿐이다.
- [ ] full replay가 한 scope의 projection을 `BEGIN IMMEDIATE` 하나에서 교체한다.
- [ ] `projection_meta.last_seq`와 rules version 불일치가 replay를 강제한다.
- [ ] canonical dump가 row와 JSON key를 명시적으로 정렬하고 TEMP/물리 시각을 제외한다.
- [ ] reducer가 git, network, LLM과 wall clock을 직접 호출하지 않는다.

### PRJ-002 — 정규화·관계·리터럴 동일성 규칙

- 상태: `TODO`
- Owner: `unassigned`
- 근거: ADR-004, ADR-006, ADR-009
- 선행 작업: PRJ-001
- 결과물: versioned normalize와 claim identity primitive

완료 체크:

- [ ] entity/surface는 lowercase → NFKC → 공백·하이픈·underscore 제거 순서를 고정한다.
- [ ] 한국어 조사 제거, fuzzy match와 자동 relation 승격은 구현하지 않는다.
- [ ] 정규화 뒤 빈 문자열을 거부하고 locale을 바꿔도 같은 fixture 결과를 만든다.
- [ ] literal은 trim+NFKC만 적용하고 내부 공백·대소문자·문장부호를 보존한다.
- [ ] 정규 relation 5종과 `describes` 단일 카디널리티를 한 registry에서 제공한다.
- [ ] `relates_to`의 비어 있지 않은 label 조건과 relation별 fixture가 있다.

### PRJ-003 — occurrence ID와 redirect registry

- 상태: `TODO`
- Owner: `unassigned`
- 근거: ADR-002
- 선행 작업: PRJ-001, PRJ-002
- 결과물: 후보 ID 발급, canonical 선택과 redirect resolver

완료 체크:

- [ ] 저장된 parsed index와 subject→entity object 발생 순서로 모든 후보 ID를 계산하며,
      기존 entity로 해석된 occurrence도 위치를 소비한다.
- [ ] dedupe/rule change는 가장 이른 후보를, 명시적 merge는 keep을 canonical로 삼는다.
- [ ] redirect를 최종 canonical로 압축하고 cycle·종류 혼합·32 hop 초과를 손상으로 거부한다.
- [ ] 외부 ID 정규식과 scope를 redirect 전후 모두 검증한다.
- [ ] one-to-many rules dry-run은 배포 차단 결과와 정비 후보를 만든다.

### PRJ-004 — 사건 pre-scan과 effective statement 계산

- 상태: `TODO`
- Owner: `unassigned`
- 근거: ADR-007, ADR-010, ADR-017
- 선행 작업: PRJ-001, PRJ-003
- 결과물: 사건 효력 pre-scan과 의미 event stream

완료 체크:

- [ ] retraction은 과거의 statement/merge/alias만 가리키고 retraction·미래 event는 거부한다.
- [ ] supersedes graph의 cycle·교차 scope·복수 live leaf를 검출한다.
- [ ] cascade true/false와 `retracted > superseded > live` 우선순위를 적용한다.
- [ ] successor payload는 실제 seq 기반 후보 ID와 root order_seq를 함께 유지한다.
- [ ] effective created_at/provenance/ttl 승계와 recorded 시각 분리를 fixture로 검증한다.

### PRJ-005 — entity·surface·kind 투영

- 상태: `TODO`
- Owner: `unassigned`
- 근거: ADR-006, ADR-008
- 선행 작업: PRJ-002~004
- 결과물: entity resolver와 surface/kind reducer

완료 체크:

- [ ] surface 후보 전체를 canonicalize하고 exact normal name으로도 하나가 안 되면 모호하게 거부한다.
- [ ] 새 entity와 name surface, 기존 entity occurrence redirect를 결정적으로 만든다.
- [ ] subject/object alias 방향과 `confirmed > name > agent_supplied` 우선순위를 보존한다.
- [ ] kind는 identity에 쓰지 않고 가장 이른 live occurrence를 택하며 불일치를 정비 신호로 남긴다.
- [ ] claim 철회와 statement 철회가 surface/kind 근거에 미치는 차이를 검증한다.

### PRJ-006 — claim·support·카디널리티 상태 전이

- 상태: `TODO`
- Owner: `unassigned`
- 근거: ADR-002, ADR-007, ADR-009
- 선행 작업: PRJ-002~005
- 결과물: claim/support reducer와 상태 전이 test

완료 체크:

- [ ] 동일 identity는 과거 상태와 무관하게 가장 이른 claim ID를 재사용한다.
- [ ] `describes`는 기존 active 값을 먼저 supersede한 뒤 대상 claim을 활성화한다.
- [ ] claim 철회는 과거 support만 끊고 event 철회는 statement의 side effect 전체를 제외한다.
- [ ] claim 철회는 과거 describes를 복구하지 않고 대체 event 철회는 복구한다.
- [ ] TTL만으로 구조적 claim state를 쓰기 변경하지 않는다.
- [ ] first/last seen과 support live 상태가 effective statement 순서와 일치한다.

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
