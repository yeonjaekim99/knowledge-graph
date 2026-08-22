# PRJ-005: entity·surface·kind 투영

- 상태: 구현 완료
- 결정일: 2026-08-22
- 작업: PRJ-005
- Owner: `log0629`
- 규범 근거: ADR-006, ADR-008
- 선행 구현: PRJ-002, PRJ-003, PRJ-004
- 구현 branch: `prj-005-entity-surface-kind`
- PR: [#25](https://github.com/yeonjaekim99/knowledge-graph/pull/25)

## 목적과 범위

PRJ-005는 PRJ-004의 scope-bound pre-scan 결과를 받아 statement의 모든 entity occurrence를
영속적인 ID anchor에 연결하고, live statement만으로 현재 entity surface와 kind를 계산하는
IO 없는 domain reducer를 제공한다. reducer는 DB, clock, network, process 상태와 LLM을 읽지
않으며 같은 입력에서 byte-equivalent한 정렬 결과를 만든다.

이번 작업은 다음을 구현한다.

- 모든 실제 statement occurrence의 entity anchor와 최종 canonical occurrence mapping
- `normalizeV1`을 공유하는 entity/surface identity
- name·agent-supplied·confirmed surface를 읽는 결정적 reference resolver
- live statement의 name/subject alias/object alias surface 기여
- live occurrence 순서에 따른 kind 선택과 ID-only 정비 후보

claim/support/cardinality, 실제 merge·alias 사건의 적용과 철회, SQLite publish와 증분 dispatcher는
각각 PRJ-006, PRJ-007, PRJ-009의 범위다. 이 모듈은 behavior spike를 import하거나 production
구조의 출발점으로 복사하지 않는다.

## pre-scan seam과 두 단계 reduce

`StatementCandidateRegistration`은 실제 statement seq에서 계산한 후보 ID와 그 후보를 만든
frozen `parsed` payload를 함께 보존한다. retracted/superseded statement도 과거에 노출된 ID를
계속 해석해야 하므로 downstream reducer가 비활성 payload의 identity anchor까지 재현할 수
있어야 한다. 반면 그 payload는 effective event stream에 없으므로 surface와 kind에는 기여하지
않는다.

`reduceEntitySurfaceKinds`는 trusted `ProjectionPreScanResult`를 두 단계로 처리한다.

1. 실제 statement seq와 저장 draft 순서로 모든 subject/object 후보를 등록한다. 같은
   `normal_name`의 가장 이른 후보가 canonical entity row를 소유하고 뒤 occurrence는
   `deduplicated` redirect가 된다.
2. PRJ-004가 정렬한 live statement만 `orderSeq`, `actualSeq`, draft 순서로 적용한다. name과
   alias surface, kind contribution은 이 단계에서만 생긴다. claim/event retraction은 이미
   pre-scan이 정한 statement 구조 효력을 바꾸지 않으므로 이 reducer가 별도 side effect를
   만들지 않는다.

`projectEntitySurfaceKinds`는 raw replay input을 PRJ-004 pre-scan에 통과시킨 뒤 같은 reducer를
호출하는 black-box 편의 경계다. 두 경로가 같은 결과라는 fixture를 유지해 후속 PRJ-006~009가
pre-scan을 한 번만 수행하고 trusted reducer를 재사용할 수 있게 한다.

## entity 해석과 ambiguity

`resolveEntityReference`는 현재 entity/surface/redirect snapshot을 읽기만 하며 다음 순서를
고정한다.

1. 입력 이름과 surface를 ADR-006 `normalizeV1`으로 정규화한다.
2. 같은 surface의 모든 entity ID를 redirect 최종 target으로 canonicalize하고 중복을 없앤다.
3. canonical 후보가 하나면 선택한다.
4. 둘 이상이면 active entity의 `normal_name` exact match가 정확히 하나일 때만 선택한다.
5. 여전히 여러 개면 ID 숫자 순으로 정렬한 `ambiguous` 결과와 후보 ID/display name을 반환한다.
6. surface 후보가 없으면 active `normal_name` exact match를 사용하고, 없으면 `not_found`다.

이 읽기 primitive는 REC-004 write preflight가 actionable ambiguity를 만들 때 재사용할 수 있다.
이미 저장된 journal replay에서 ambiguity가 발생하면 부분 투영을 만들지 않고 payload-redacted
`AMBIGUOUS_ENTITY` 오류로 fail closed한다. 배열 입력 순서, redirect source ID와 surface origin은
선택 결과의 임의 tie-break가 아니다.

anchor 단계에서 새로 canonical이 된 live occurrence의 이름은 origin=`name`이다. 이미 과거
anchor나 surface로 선택된 entity를 다시 부르는 이름은 `agent_supplied`이다. 해당 이름이 이미
더 강한 origin을 가지면 아래 우선순위가 값을 낮추지 않는다.

```text
confirmed > name > agent_supplied
```

`strongestSurfaceOrigin`이 이 순서를 단일 primitive로 제공한다. `resolveEntityReference`는 세
origin 모두에서 동일하게 canonical entity를 찾는다. 실제 alias event를 시간순으로
`confirmed` contribution으로 바꾸고 event 철회 시 이를 제외하는 조립은 PRJ-007이 담당한다.
따라서 S08/S21 전체 target은 아직 `planned`다.

## alias 방향과 최종 surface

한 draft의 subject와 entity object를 먼저 해석한 뒤 surface를 추가한다. 그 다음
`subject_aliases`는 subject canonical에만, `object_aliases`는 object canonical에만
`agent_supplied`로 추가한다. alias는 entity occurrence 위치를 소비하지 않고 같은 정규형은
한 번만 기여한다.

동일 surface가 다른 canonical entity에 이미 있어도 mapping을 삭제하거나 자동 merge하지
않는다. 이후 그 surface를 entity name으로 사용하는 statement는 위 ambiguity 규칙을 따른다.
최종 surface row는 redirect terminal에 다시 모으고 같은 `(scope, surface, entity)` 기여 중
가장 강한 origin 하나만 남긴다.

## kind 선택과 정비 신호

선택 `subject_kind`와 `object_kind`는 trim → NFKC → Unicode lowercase를 적용한 뒤 1~64
Unicode code point여야 한다. kind는 entity identity나 merge/split 판단에 사용하지 않는다.

live non-null contribution은 다음 tuple로 정렬한다.

```text
(root orderSeq, actualSeq, draftIndex, subject=0/object=1)
```

최종 canonical entity별 첫 kind를 투영한다. 뒤의 다른 값은 기존 kind를 덮지 않고
`(entityId, existingKind, observedKind, eventId)` 정비 후보가 된다. subject/object가 같은
entity를 가리키는 한 draft에서도 position tie-break가 결과를 결정적으로 만든다.

claim-level retraction은 statement의 entity 언급과 kind 근거를 유지한다. statement event
retraction과 superseded payload는 pre-scan의 live stream에서 빠지므로 kind 기여가 없다.
재해석 leaf는 실제 seq의 ID를 사용하되 root `orderSeq`를 승계해 과거 문장의 분류 우선순위를
지킨다. TTL은 구조 상태가 아니므로 이 reducer에 clock이나 만료 write가 없다.

## 출력과 실패 계약

`EntitySurfaceKindProjection`은 다음 collection을 모두 재귀적으로 freeze하고 명시적으로
정렬한다.

- `entityAnchors`: 비활성 statement를 포함한 모든 entity occurrence ID
- `entities`: canonical 표시 이름, normal name, kind와 merged target을 가진 row
- `surfaceForms`: redirect terminal별 최강 origin row
- `idRedirects`: 최종 canonical을 직접 가리키는 `deduplicated` redirect
- `occurrences`: 모든 statement draft의 최종 subject/object entity ID
- `kindMaintenance`: payload 없이 entity ID와 kind 값만 가진 불일치 항목

외부 snapshot을 읽는 resolver는 scope, canonical ID, anchor, redirect, active normal uniqueness,
surface target과 row shape를 먼저 검증한다. `EntityProjectionError`는 고정 code/message만
가지며 submitted 이름, scope, alias, kind, 내부 cause를 오류에 보관하지 않는다.

## TDD와 검증

첫 RED는 test가 import한 `EntityProjectionError`와 reducer export가 아직 없어 module
instantiation에서 실패했다. GREEN fixture는 다음 정상·경계·실패 경로를 검증한다.

- 새 entity, 반복 occurrence, inactive anchor와 숫자 ID redirect
- subject/object alias 방향, alias 중복과 surface origin 우선순위
- name·agent-supplied·confirmed 해석과 redirected surface canonicalization
- 다의 surface ambiguity, exact normal-name 단일 tie-break와 입력 배열 순서 변화
- claim 철회와 statement 철회의 surface/kind 차이
- 재해석 root order, 같은 draft subject/object kind tie와 불일치 정비 항목
- kind 64/65 code-point 경계, malformed draft/state/scope/redirect의 payload-redacted 실패
- 원본 입력 불변성, recursive freeze, wrapper/pre-scan reducer parity와 반복 실행 결정성

검증 명령은 다음과 같다.

```bash
pnpm verify:prj-005
pnpm verify:prj-004
pnpm verify:local
python3 -m unittest discover -s spikes/adr-behavior -p 'test_*.py' -v
python3 docs/roadmap/validate.py
```

S08/S21은 이번 unit fixture가 소유한 entity/surface primitive만 고정한다. 실제 alias event의
append·철회, 후속 record와 SQLite prefix/full replay parity가 남았으므로 production scenario
manifest를 `implemented`로 올리지 않는다.

완료 시점 기준 PRJ-005 target은 11/11, PRJ-004 회귀는 14/14, 빠른 전체 suite는
142/142이며 독립 behavior spike는 25/25다.

## 후속 작업 경계

- PRJ-006: occurrence mapping을 claim/support identity와 cardinality 상태 전이에 연결
- PRJ-007: merge/alias event, origin 복원, surface/claim rewrite와 undo
- PRJ-009: reducer 조립, SQLite transaction과 증분/full dispatch
- PRJ-010: S01~S24의 모든 journal prefix와 canonical projection parity
- REC-004: write-time entity ambiguity를 draft-level actionable rejection으로 변환
- REV-005/006: 사용자 확인 merge/alias 사건 생성과 scope/cycle/no-op 검증

Accepted ADR의 의미를 바꾸지 않으므로 superseding ADR은 필요하지 않다.
