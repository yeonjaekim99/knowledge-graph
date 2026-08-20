# ADR-008: 개체 해석, kind 불일치, 경합 처리

- 상태: Accepted
- 결정일: 2026-08-20
- 소유 영역: 초기 설계 4.1
- 선행 ADR: ADR-002, ADR-003, ADR-006, ADR-007
- Supersedes: 초기 설계 4.1의 normal_name 단일 조회 의사코드

## Context

개체 해석은 같은 대상을 같은 노드로 모으되 모호한 surface를 임의로 선택하지 않아야
한다. 초기 의사코드는 active/merged 상태를 구분하지 않고 `normal_name` 한 행만
조회했다. merge 뒤 absorb의 이름은 keep을 가리켜야 하고, 한 surface가 여러 entity를
가리킬 수도 있으므로 이 방식은 충분하지 않다.

여러 MCP client가 동시에 기록해도 동일 개체가 중복 생성되지 않아야 한다. SQLite는
writer 하나만 허용하지만 요청은 동시에 도착할 수 있다.

## Decision

### statement의 entity 해석 순서

각 subject/object entity occurrence에 ADR-002 후보 ID를 먼저 계산하고 다음 순서로
해석한다.

1. 이름을 ADR-006으로 정규화한다.
2. `(scope_key, surface_norm)`의 surface_forms 후보를 조회하고 모든 entity ID를 redirect
   끝까지 해석한다.
3. 서로 다른 canonical 후보가 정확히 하나면 그 entity를 사용한다.
4. 후보가 여러 개면 active entity의 `normal_name`이 정확히 일치하는 후보가 하나인지
   확인한다.
5. 여전히 여러 개면 해당 draft를 `ambiguous entity`로 거부하고 후보 ID/이름을 note에
   제공한다. 임의 첫 행을 고르지 않는다.
6. surface 후보가 없으면 active entity의 `(scope_key, normal_name)` exact match를 찾는다.
7. 없으면 후보 ID로 새 entity와 origin=`name` surface를 만든다.

기존 entity를 선택하면 발생 후보 ID에서 canonical ID로 `deduplicated` redirect를
만든다. 이름으로 들어온 정규 surface도 origin=`agent_supplied`으로 그 canonical에
추가한다.

entity 해석이 끝난 뒤 `subject_aliases`는 subject에, `object_aliases`는 object entity에만
각각 ADR-006으로 정규화해 `origin='agent_supplied'`로 UPSERT한다. 중복 alias는 한 번만
적용한다. 이미 다른 canonical entity에 같은 surface가 있어도 homonym일 수 있으므로
그 mapping을 삭제하거나 자동 merge하지 않는다. 이후 그 surface를 이름으로 쓰는 write가
모호해지면 위 후보 규칙대로 draft를 거부하고 alias 또는 merge 확인을 요구한다.

같은 `(scope, surface, entity)`가 여러 경로에서 생기면 origin은
`confirmed > name > agent_supplied` 순으로 강한 값을 투영한다. projector는 이 우선순위로
UPSERT하며 뒤 statement가 confirmed/name을 agent_supplied로 낮추지 않는다. alias 사건을
철회하면 전체 replay에서 해당 confirmed 기여를 제외하고 남은 가장 강한 origin으로
돌아간다.

쓰기 transaction은 process write queue와 `BEGIN IMMEDIATE`로 직렬화한다. entity INSERT는
partial unique index를 최종 방어로 사용하고, constraint 충돌 시 같은 key를 재조회해
동일 canonical을 반환한다. 충돌을 새 ID 생성으로 우회하지 않는다.

### kind

- `kind`는 identity에 참여하지 않는다.
- 입력은 ClaimDraft의 선택 `subject_kind`/`object_kind`에서 오며 trim → NFKC → Unicode
  lowercase한 1~64자 값이다. agent가 확신하지 못하면 NULL로 둔다.
- 현재 live statement occurrence 중 `(order_seq, 실제 journal seq, draft_index)`가
  사전식으로 가장 이른 non-null kind를 투영한다. claim-level retraction은 사실 support만
  끊고 statement의 개체 언급·표면형·kind 근거는 유지한다. 재해석 leaf는 root order_seq를
  승계하므로 과거 문장의 분류 우선순위도 보존된다.
  ID anchor만 남기는 retracted/superseded statement의 kind는 사용하지 않는다. TTL 만료는
  statement 구조 상태를 바꾸지 않으므로 kind만 시간에 따라 쓰기 갱신하지 않는다.
- 이미 non-null kind가 있고 다른 값이 들어오면 덮어쓰지 않고
  `(entity_id, existing_kind, observed_kind, event_id)` 정비 항목을 계산한다.
- kind 불일치만으로 자동 split/merge하지 않는다.

### 명시적 merge

merge 입력의 keep/absorb를 각각 surface 또는 entity ID로 해석한다. 둘 다 현재 scope에서
하나의 canonical로 해석돼야 하며 서로 달라야 한다.

1. absorb가 keep 또는 그 하위 merge chain을 포함하면 cycle로 거부한다.
2. `absorb.merged_into = keep`을 설정한다.
3. absorb의 surface를 keep에 위 origin 우선순위로 UPSERT한 뒤 absorb mapping을 현재
   투영에서 제거한다.
4. absorb를 참조하는 claim을 keep으로 치환했을 때의 identity와 describes cardinality를
   실제 UPDATE 전에 계산한다.
5. 같은 identity의 losing claim과 같은 subject에 충돌하는 describes loser를 먼저
   `superseded`로 내려 partial unique index 충돌을 피한다. survivor 규칙은 ADR-009다.
6. subject/object를 keep으로 치환하고 중복 claim support를 합친다.
7. entity redirect `absorb → keep`을 reason=`merge`로 기록한다.

명시적 merge에서는 등장 순서보다 사용자가 지정한 `keep`이 우선한다. merge event가
retract되면 ADR-007 전체 재생이 그 event를 처음부터 건너뛰므로 개체가 다시 갈라진다.

### 자동 동일성

정규화 또는 사실 identity로 자동 합쳐질 때는 ADR-002의 가장 이른 후보 ID가
canonical이다. 규칙 변경 dry-run에서 one-to-many split이 생기면 자동 배포하지 않는다.

### redirect와 scope

redirect를 따라간 뒤에도 entity scope를 다시 확인한다. 다른 scope entity 간 merge는
항상 not found로 처리해 존재 여부도 노출하지 않는다.

## Alternatives

### normal_name 첫 행을 사용

merged row와 다중 surface에서 결과가 비결정적이다. surface 후보 전체를 canonical화하고
모호성을 명시적으로 반환한다.

### kind가 다르면 새 entity 생성

agent별 분류 편차가 곧 그래프 분할이 된다. kind는 정비 신호로만 사용한다.

### fuzzy matching으로 자동 merge

오탐 merge는 사실을 섞는 고비용 오류다. fuzzy 결과는 정비 후보로만 보고 사용자가
merge를 확정한다.

### merge 때 absorb 행과 과거 claim 삭제

현재 투영은 단순해지지만 과거 ID 해석과 undo 근거를 잃는다. merged row와 losing claim을
비활성 상태로 보존하고 redirect한다.

## Consequences

- merge 뒤 absorb의 모든 이름이 keep으로 해석된다.
- 한 surface가 여러 개체를 가리키면 recall은 모두 seed로 쓸 수 있지만 write는 사용자
  확인 없이는 진행하지 않는다.
- kind 품질 문제를 데이터 손실 없이 관측할 수 있다.
- claim rewrite/dedup이 merge 비용의 대부분을 차지한다.
- 명시적 merge 방향과 자동 canonical 선택 규칙이 서로 구분된다.

## Validation

- name, agent_supplied, confirmed surface 각각으로 같은 entity를 해석해야 한다.
- agent_supplied mapping을 alias로 확인하면 confirmed로 올라가고 그 alias event 철회 뒤
  agent_supplied로 돌아가야 한다.
- merge 중 같은 surface가 충돌하면 더 강한 origin이 보존돼야 한다.
- 같은 surface가 두 canonical에 매핑된 write가 ambiguous 결과를 반환해야 한다.
- subject_aliases와 object_aliases가 서로 바뀌어 등록되지 않고 기존 동명 mapping도
  삭제하지 않아야 한다.
- 동시 동일 이름 기록에서 active entity가 하나만 남아야 한다.
- A→B, B→C merge 뒤 A/B/C가 C로 해석되고 cycle merge가 거부돼야 한다.
- merge event 철회 후 전체 재생에서 surface와 claims가 원래 entity로 복구돼야 한다.
- 서로 다른 active describes 값을 가진 subject 둘을 merge해도 unique 위반 없이 최근
  활성값 하나만 active여야 한다.
- 과거 statement의 재해석 leaf가 뒤늦게 append돼도 kind 선택은 root order_seq 기준으로
  같아야 한다.
- claim 하나만 철회해도 live statement가 제공한 kind는 남고, statement event를 철회하면
  그 사건의 kind 기여도 사라져야 한다.
- 다른 scope ID를 merge/alias에 사용하면 정보 노출 없는 not found여야 한다.

## References

- 초기 설계 4.1
- ADR-002, ADR-003, ADR-006, ADR-007, ADR-009
