# ADR-009: 강화·대체 규칙

- 상태: Accepted
- 결정일: 2026-08-20
- 소유 영역: 초기 설계 4.2
- 선행 ADR: ADR-004, ADR-007, ADR-008
- Supersedes: 없음

## Context

같은 사실이 여러 statement에서 반복되면 새 claim을 계속 만들지 않고 하나의 claim에
근거를 쌓아야 한다. 반대로 같은 subject/relation에 다른 object가 왔다고 모든 관계를
자동 교체하면 “여러 DB를 사용한다” 같은 정상 다중 사실을 잃는다.

`describes`는 단일 값 슬롯이므로 대체가 필요하고, 나머지는 명시적 retraction 없이는
공존해야 한다. retraction 뒤 같은 사실이 다시 진술되는 경우와 merge로 claim identity가
겹치는 경우도 결정해야 한다.

## Decision

### claim identity

claim의 논리 identity는 다음 tuple이다.

```text
(scope_key, canonical_subject_id, relation, object_kind, canonical_object)
```

- entity object는 redirect를 모두 적용한 `object_id`다.
- literal object는 앞뒤 공백 제거와 Unicode NFKC만 적용한 `object_value`다. 내부 공백,
  대소문자와 문장부호는 값의 일부로 보존한다.
- `claims.object_value`에는 위 identity-normalized 값을 저장하고 brief 문장의 canonical
  literal로도 사용한다. 입력 그대로의 source 값은 journal draft에 남고 해당 원문의
  raw_text는 full detail에서 확인할 수 있다. 따라서 unique index, 동일성 비교와 brief
  표시가 서로 다른 값을 보지 않는다.
- object와 object_value는 정확히 하나만 존재한다.
- 같은 identity의 과거 claim이 `superseded`/`retracted`여도 새 ID를 만들지 않고 가장
  이른 기존 claim을 재사용한다.
- 각 statement는 같은 identity draft를 최대 한 번만 저장한다. 같은 호출 안 중복은
  첫 draft로 합치고 뒤 입력에는 `reinforced`와 같은 claim_id를 반환한다.

### statement 적용 순서

각 live draft는 ADR-007의 의미 event stream 순서로 적용한다. 일반 statement의
`order_seq`는 실제 journal seq이고, 재해석 leaf는 최초 root의 `order_seq`를 승계한다.
같은 `order_seq`의 재해석 후보가 생기면 실제 journal seq가 큰 live leaf 하나만 남으므로
그 leaf의 draft index가 마지막 tie-break다. 각 draft에는 다음 순서를 적용한다.

1. entity와 claim identity를 해석한다.
2. 기존 claim을 찾거나 ADR-002 후보 ID로 만든다.
3. `describes`이면 같은 `(scope, subject)`의 다른 active describes claim을 먼저
   `superseded`로 바꾼다.
4. 대상 claim을 `active`로 만든다.
5. `(claim_id, event_id, draft_index)` support를 추가한다.
6. first/last seen을 현재 유효한 구조적 support 기준으로 갱신한다.

카디널리티 검사를 활성화보다 먼저 수행한다. 이 순서로 과거 값이 다시 진술될 때 현재
값을 먼저 supersede하고 과거 claim을 안전하게 active로 되살린다.

### 강화

- 같은 identity의 active claim이면 support만 추가하고 `last_seen_at`을 갱신한다.
- retracted/superseded claim을 다시 진술하면 위 카디널리티 순서를 거쳐 active로 만든다.
- support_count, strongest provenance와 유효 last_seen은 ADR-010에서 현재 유효 support만
  집계한다.
- `relation_label`은 claims에 저장하지 않고 ADR-010이 최신 유효 support에서 계산한다.

### 대체와 철회

- `describes`만 implicit replacement를 수행한다.
- uses/rejects/contains/relates_to는 object가 달라도 모두 active로 유지한다.
- claim-level retraction은 그 시점까지 대상 claim에 연결된 support를 0으로 만들며 같은
  statement의 다른 claim에는 영향을 주지 않는다.
- 이후 같은 사실의 statement가 오면 새 support로 claim을 다시 active로 만들 수 있다.
- event-level statement retraction은 그 statement support만 제거한다.

claim state는 최종 support 집합만으로 다시 추론하지 않고 ADR-007의 의미 event stream
순 사건 전이로 정한다.

- live statement가 claim을 처음 만들거나 강화하면, 카디널리티 검사 뒤 그 claim을
  `active`로 만든다.
- 새 live `describes`가 기존 active 값을 대체하면 기존 claim을 `superseded`로 만든다.
  이 전이는 뒤에서 대체 claim 자체를 claim 단위로 철회해도 취소되지 않는다.
- claim-level retraction은 대상 claim만 `retracted`로 만들고 다른 superseded claim의
  상태를 바꾸지 않는다.
- event-level statement retraction은 replay pre-scan에서 그 statement와 side effect를
  처음부터 제외한다. 따라서 그 statement가 만들었던 describes 대체도 사라진다.
- 뒤의 live statement가 superseded/retracted claim을 다시 진술하면 카디널리티 검사 후
  `active`로 되살린다.
- merge로 흡수된 losing claim은 support를 옮긴 뒤 `superseded`와 redirect를 유지한다.

reduce 종료 시 active claim에 구조적으로 live인 support가 하나도 없으면 projector
오류이거나 철회 적용 누락이므로 `retracted`로 정합화한다. 반대로 live support가 있다는
이유만으로 `superseded`를 active로 올리지 않는다.

TTL 만료만으로 `claims.state`를 변경하지 않는다. 시간 유효성은 ADR-010이 계산한다.

claim-level retraction으로 현재 describes 값을 지워도 과거 superseded 값은 자동 복구하지
않는다. 사용자가 현재 값을 명시적으로 지운 것이지 과거 값으로 되돌린 것은 아니기
때문이다. 반면 **event-level** retraction으로 대체 statement 자체를 무효화하면 전체
재생에서 그 implicit replacement도 없었던 것이 되어 이전 값이 active로 복구된다.

### merge에 따른 claim 합치기

entity merge로 두 claim identity가 같아지면 `origin_seq`, 같은 seq에서는 claim ID
suffix의 parsed index를 **숫자로** 비교해 이른 claim을 survivor로 선택한다.
`first_seen_at`은 재해석에서 과거 effective 시각을 승계할 수 있으므로 ID 생존 순서에
사용하지 않는다. 문자열 사전순도 `c10`과 `c2`를 잘못 정렬하므로 사용하지 않는다.

- losing claim의 support를 survivor로 옮긴다.
- 같은 event support가 겹치면 더 작은 draft_index 하나만 남겨 statement당 support
  하나를 유지한다.
- losing claim은 `superseded`로 두고 claim redirect를 만든다.
- survivor의 state와 last_seen을 다시 계산한다.
- describes unique 제약을 위반하기 전에 losing/기존 claim을 먼저 비활성화한다.

subject entity merge 때문에 같은 canonical subject에 **서로 다른** active describes 값이
모이면 동일 claim 합치기가 아니라 카디널리티 충돌이다. merge event 직전까지 각 claim을
마지막으로 active로 만든 구조적 live statement의 `(order_seq, 실제 journal seq,
draft_index)`가 사전식으로 가장 큰 값을 survivor로 삼는다. 나머지는 merge 적용 중
`superseded`로 만든다. 이 선택은 effective created_at이나 TTL에 의존하지 않는다.
재해석의 실제 append seq만으로 승자를 고르면 오래된 문장 재파싱이 그 뒤에 내려진
결정을 최신 값처럼 덮으므로 금지한다.
승자 claim을 나중에 claim 철회해도 loser를 자동 복원하지 않으며, merge event 자체를
철회한 전체 replay에서는 원래 subject가 갈라져 각 값이 다시 active가 된다.

### 상충

상충은 대체가 아니다. 같은 subject/object에 `uses`와 `rejects`가 모두 현재 유효하면
둘 다 유지하며 ADR-010이 `contested=true`를 계산한다. 서버가 자동 승자를 선택하지
않는다.

## Alternatives

### relation이 같으면 모두 last-write-wins

uses/contains 같은 다중 관계의 정상 정보를 잃는다. 단일 cardinality로 선언한
describes에만 적용한다.

### 모든 정정을 새 claim으로 생성

과거 ID로 revise하기 어렵고 support가 분산된다. 동일 identity는 기존 claim을
재활성화한다.

### 현재 describes 철회 시 이전 값을 자동 복구

삭제가 의도치 않은 과거 설정 부활로 이어질 수 있다. event 자체를 무효화한 경우에만
재생 의미상 이전 값을 복구한다.

### 상충에서 최신 사실만 유지

사용자 정정인지 별개의 관측인지 서버가 알 수 없다. 양쪽과 근거를 노출한다.

## Consequences

- 반복 statement가 claim을 강화하며 새 claim을 불필요하게 만들지 않는다.
- describes 모델링은 속성 슬롯 subject 관례에 의존한다.
- claim retraction과 event retraction의 이전 값 복구 의미가 다르다.
- merge는 entity뿐 아니라 claim support와 redirect를 함께 정합화해야 한다.
- 시간 만료와 구조 상태가 분리돼 읽기 쿼리는 claim_agg를 반드시 사용해야 한다.

## Validation

- 같은 사실을 세 statement에서 기록해 claim 하나와 support 세 개가 생겨야 한다.
- describes A→B→A 순서에서 각 단계 active describes가 정확히 하나여야 한다.
- 현재 describes를 claim retract했을 때 이전 값이 자동 active가 되지 않아야 한다.
- 대체 statement를 event retract했을 때 이전 값이 복구돼야 한다.
- 위 두 fixture는 전체 replay와 증분 적용 결과가 각각 같아야 한다.
- uses A와 uses B가 공존하고 uses A/rejects A도 둘 다 남아야 한다.
- merge 뒤 동일 claim의 support가 유실 없이 survivor로 모여야 한다.
- 서로 다른 subject의 describes 충돌 merge에서 최근 활성값 하나만 active이고 merge
  event 철회 뒤 둘 다 각 원래 subject에서 복원돼야 한다.
- describes A(root seq 1) 뒤 B(seq 2)를 기록하고 A를 seq 3에서 재해석해도, 의미
  `order_seq`가 1인 재해석 값이 B를 덮지 않아야 한다.
- backdated reinterpret와 c2/c10 fixture에서도 더 작은 origin_seq/숫자 index ID가
  survivor여야 한다.

## References

- 초기 설계 4.2
- ADR-004, ADR-007, ADR-008, ADR-010
