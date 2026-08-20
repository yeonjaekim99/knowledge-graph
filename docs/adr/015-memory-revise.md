# ADR-015: memory_revise 동작 정의, 철회 범위, 병합 절차

- 상태: Accepted
- 결정일: 2026-08-20
- 소유 영역: 초기 설계 2.3, 3.3, 6.3
- 선행 ADR: ADR-007, ADR-013
- Supersedes: 초기 설계 2.3의 exact-only statement retraction, 6.3의 `correct` 입력 타입

## Context

철회, 교정, 개체 병합과 별칭 확인은 모두 현재 믿는 상태를 바꾸지만 영향 범위가 다르다.
claim 철회는 한 사실의 support만 끊고, statement 사건 철회는 그 문장에서 나온 모든
support를 끊는다. merge와 alias도 journal 사건이므로 그 사건을 철회해야 전체 재생에서
결정이 취소된다.

초기 `correct` 타입에는 replacement만 있고 새 statement의 필수 원문이 없었다. 서버는
자연어 파서도, 사용자 발화를 임의로 복원할 권한도 없으므로 이대로는 규범적인
statement body를 만들 수 없다. 또한 모호한 자연어 target, 반복 호출과 반환 형태를
명확히 해야 잘못된 대량 철회를 막을 수 있다.

## Decision

### 입력 계약

`memory_revise`는 action으로 판별되는 JSON Schema `oneOf`다. 모든 object는
`additionalProperties: false`다.

```typescript
type RetractTarget =
  | { claim_id: string }
  | { event_id: string; cascade?: boolean }
  | {
      subject: string;
      relation?: "uses" | "rejects" | "contains" | "describes" | "relates_to";
    };

type MemoryReviseInput =
  | {
      action: "retract";
      target: RetractTarget;
      note?: string;
    }
  | {
      action: "correct";
      target: RetractTarget;
      raw_text: string;
      replacement: ClaimDraft;
      provenance?: "user_stated" | "observed" | "inferred";
      ttl?: "session" | "weeks" | "permanent";
      note?: string;
    }
  | {
      action: "merge";
      merge: { keep: string; absorb: string };
      note?: string;
    }
  | {
      action: "alias";
      alias: { surface: string; entity: string };
      note?: string;
    };
```

`correct.raw_text`는 사용자의 교정 발화 또는 교정의 근거가 된 원문이며 필수다. 이
필드를 추가하는 것이 초기 타입에 대한 명시적 정정이다. correct provenance의 기본값은
명시적 정정이라는 의도에 맞게 `user_stated`다. 호출자가 단순 관찰을 교정으로 적용하는
경우 `observed`, agent 판단이면 `inferred`를 명시한다. ttl은 ADR-010에서 결정한다.

문자열과 ClaimDraft 제한은 ADR-013과 같다. note는 최대 2,048자이며 비밀값 검사를
통과해야 한다. 자연어 target subject와 ID가 아닌 merge keep/absorb/entity는 entity
이름과 같은 trim 후 1~1,024자, alias surface는 trim 후 1~256자다. ID 필드는 ADR-002
정규식을 JSON Schema pattern으로 강제한다. scope와 metadata는 입력받지 않는다.

### target 해석

JSON Schema, 크기와 비밀값처럼 DB 상태와 무관한 preflight만 writer lock 전에 수행한다.
그 뒤 process write queue를 점유하고 `BEGIN IMMEDIATE`를 시작한 상태에서 target/redirect,
현재 state, ambiguity와 no-op 여부를 해석한다. 사건 INSERT 직전에 같은 transaction에서
판정하므로 다른 client가 사이에 merge·retraction을 끼워 넣을 수 없다. merge/alias의
entity 해석과 correct replacement의 projection-dependent 검증도 이 경계를 따른다.

모든 ID는 같은 scope 안에서 `id_redirects`를 따라 canonical 대상으로 해석한다.

- `claim_id`: 정확히 그 claim. 현재 유효 support가 없어도 역사적 대상이면 찾은 것이다.
- `event_id`: 현재 사건보다 앞선 같은 scope의 statement, merge 또는 alias 사건만 허용한다.
  retraction 사건과 아직 존재하지 않는 미래 사건은 대상이 될 수 없다. cascade는
  statement에서만 허용하고 기본값은 true다.
- `subject`: surface와 normal name을 모두 사용해 entity를 해석하고 relation이 있으면
  좁힌 뒤 유효 claim 후보를 만든다.

자연어 target 후보가 0개면 `not_found`, 2개 이상이면 `ambiguous`로 반환하며 journal을
쓰지 않는다. 후보에는 canonical claim_id와 간단한 text를 넣어 caller가 claim_id로
재시도할 수 있게 한다. 첫 hit를 임의 선택하지 않는다.

event_id는 영향 범위가 큰 명시적 선택이므로 statement가 여러 claim을 만들었어도
그 사건 전체를 대상으로 한다. 응답에 영향을 받는 claim 목록을 모두 돌려준다.
`action='correct'`의 event_id는 statement 사건만 허용한다. merge/alias 결정을 바꾸려면
해당 event를 retract한 뒤 올바른 merge/alias action을 호출하며, replacement ClaimDraft로
서로 다른 사건 종류를 바꾸지 않는다.

### retract

해석한 대상을 담은 retraction 사건 하나를 추가하고 ADR-007 projector를 같은
transaction에서 실행한다.

retract는 현재 recall과 이후 replay에서 믿지 않게 하는 **논리 삭제**다. append-only
journal 원문을 물리 삭제하지 않는다. 비밀값이나 법적 삭제처럼 저장 매체에서 제거해야
하는 경우는 일반 revise가 아니라 ADR-011의 승인된 offline 보안 복구 절차를 사용한다.

```typescript
{
  target: { claim_id: string } | { event_id: string; cascade?: boolean },
  note?: string
}
```

statement event target의 body에는 기본값을 적용한 `cascade: true|false`를 항상 명시해
향후 서버 기본값이 바뀌어도 replay 의미가 변하지 않게 한다. merge/alias event target과
claim target에는 cascade를 저장하지 않는다.

- claim target은 retraction seq보다 앞선 해당 claim의 live support를 모두 끊는다.
  같은 statement의 다른 claim과 statement 자체는 유지된다. 이후 새 statement가 같은
  claim을 강화하면 새 support로 다시 active가 될 수 있다.
- statement event target은 기본적으로 해당 사건이 속한 supersedes chain의 조상과
  현재까지의 후손을 모두 retracted로 하고 모든 support를 끊는다. 이 기본값은 재해석
  이전 원문이 삭제 뒤 되살아나는 일을 막는다.
- `{event_id, cascade:false}`는 정확히 그 statement 사건만 철회한다. 재해석 successor를
  이 방식으로 철회하면 이전 해석이 live로 복원될 수 있으므로 일반 삭제가 아니라
  “이 재해석만 되돌리기”에만 쓴다.
- merge event target은 해당 병합을 replay 입력에서 무효화해 entity를 다시 가른다.
- alias event target은 해당 confirmed surface 등록만 무효화한다.

claim target은 TTL 만료 여부와 무관하게 아직 `live=1`인 구조적 support가 하나라도
있으면 retraction을 기록한다. 현재 조회에 안 보인다는 이유로 생략하면 향후 TTL 규칙
변경에서 되살아날 수 있기 때문이다. 이미 앞선 retraction으로 대상 support/event
결정이 모두 무효라서 journal 의미가 전혀 달라지지 않을 때만 새 사건 없이
`unchanged`로 반환한다.

### correct

preflight가 성공하면 위 `BEGIN IMMEDIATE` 안에서 target 해석과 replacement의 DB 의존
검증을 완료한 뒤 다음 두 사건을 연속 seq로 추가한다.

1. target을 가리키는 `retraction`
2. raw_text와 replacement 하나를 담은 `statement`

둘 사이에 다른 writer 사건이 끼어들 수 없으며 projection까지 성공해야 commit한다.
두 event id를 순서대로 반환한다. correct는 재해석이 아니므로 replacement statement에
`supersedes`를 넣지 않고 현재 교정 시각·provenance를 사용한다.

event_id statement를 교정하면 기본 cascade 범위의 모든 claim이 철회되고 replacement
하나만 추가된다. 한 사실만 바꾸려면 claim_id를 써야 한다. tool description과 응답
note에서 이 차이를 명시한다.

### merge

keep과 absorb는 entity_id 또는 surface다. 각각 정확히 한 canonical entity로 해석돼야
하고 같은 scope여야 한다. 같은 entity이거나 absorb에서 keep으로 이미 redirect된 경우
`unchanged`다. 반대 방향 redirect 또는 cycle을 만들면 `rejected`다.

성공 시 event body에는 문자열 입력이 아니라 해석 완료한 entity ID를 저장한다.

```typescript
{ keep: string, absorb: string, note?: string }
```

명시적 사용자 선택이므로 자동 dedup과 달리 `keep` ID가 살아남는다. claim 중복,
surface 이동, redirect와 병합 취소는 ADR-007~009의 replay 규칙을 따른다. 서버는
유사성만으로 merge를 자동 실행하지 않는다.

### alias

entity는 entity_id 또는 surface로 정확히 하나에 해석해야 한다. event body에는 입력
surface 원문, canonical entity_id와 선택 note를 저장한다.

```typescript
{ surface: string, entity_id: string, note?: string }
```

projection은 ADR-006으로 정규화해 `origin='confirmed'`로 추가한다. correct의 note는
retraction 사건에 저장하고 replacement statement는 raw_text 자체를 근거로 삼는다.

같은 mapping을 확인하는 live alias 사건이 이미 있으면 `unchanged`다. mapping이 name
또는 agent_supplied로만 존재하면 새 alias 사건을 추가하고 ADR-008의 origin 우선순위로
`confirmed`로 올린다. 동일 surface가 다른 entity에도 매핑된 경우 기존 mapping을
삭제하지 않는다. 명시적 homonym일 수 있으므로 함께 두고 recall은 모두 seed로 사용한다.
기존 mapping을 잘못된 것으로 취소하려면 그 alias event_id를 retract하거나 entity를
merge한다.

statement의 `subject_aliases`/`object_aliases`로 생긴 agent_supplied mapping에는 별도
alias event_id가 없다. v1에서 그 mapping 하나만 음수 사건으로 제거하는 기능은 두지
않는다. 잘못된 mapping의 원 statement를 event 단위로 철회하고 필요한 사실을 다시
record한다. 이 제한을 숨기지 않고 정비 report에 원 statement event_id를 제공한다.

### 결과 계약

```typescript
type ReviseCandidate = { claim_id: string; text: string };

type ReviseResult = {
  status: "applied" | "unchanged" | "ambiguous" | "not_found" | "rejected";
  event_ids: string[];             // 이번 호출이 새로 추가한 사건
  affected_event_ids: string[];    // 기존 상태가 바뀐 statement/merge/alias 사건
  affected_claim_ids: string[];
  replacement_claim_id?: string;
  candidates?: ReviseCandidate[];
  note?: string;
};
```

`applied`만 event_ids가 비어 있지 않다. correct는 정확히 두 개, 나머지는 하나다.
ambiguous는 candidates를 필수로 제공한다. unchanged/not_found/rejected는 journal과
projection을 수정하지 않고 재시도 가능한 note를 제공한다. ID 목록은 첫 등장 seq,
ID 순으로 안정 정렬한다. claim 철회는 statement 자체를 바꾸지 않으므로
affected_event_ids가 비어 있고, statement cascade 철회는 chain 구성원을 모두 담는다.

## Alternatives

### action마다 MCP tool 분리

타입은 작아지지만 agent가 “믿음을 바꾼다”는 한 의도에서 도구를 고르는 부담이 커진다.
판별 union 하나를 사용한다.

### correct 원문을 replacement에서 합성

원래 발화가 아니며 FTS와 재해석의 복구 근거를 오염시킨다. raw_text를 필수 입력으로
추가한다.

### 자연어 target의 첫 후보를 수정

조용히 다른 사실을 삭제할 위험이 있다. 여러 후보는 실행하지 않고 ID 재호출을
요구한다.

### merge를 projection에 직접 적용

빠르지만 replay에서 사라지고 취소할 수 없다. merge와 그 retraction을 journal 사건으로
남긴다.

## Consequences

- claim 철회와 statement 철회의 영향 범위가 API에서 보인다.
- correct가 완전한 statement 사건을 만들 수 있고 두 사건은 원자적으로 적용된다.
- 자연어 편의 target은 모호할 때 추가 round trip을 요구한다.
- event target 교정은 여러 claim을 없앨 수 있어 설명과 destructive hint가 중요하다.
- merge와 alias의 반복 no-op은 journal을 불필요하게 늘리지 않는다.
- merge 취소는 전체 replay 비용을 낸다.
- agent_supplied surface 하나만 분리 철회하는 기능은 v1에 없고 원 statement 재기록이
  필요하다.
- merge 이후 쌓인 statement/retraction은 merge 취소 replay에서 원래 표현에 따라 다른
  entity로 다시 해석될 수 있으므로 취소 전 diff를 보여준다.
- retract는 audit journal의 물리 삭제가 아니다.

## Validation

- 두 claim을 만든 statement에서 claim_id 하나를 retract해 다른 claim/support가 남아야 한다.
- 같은 statement event_id를 retract하면 둘 다 사라져야 한다.
- correct의 두 사건 seq가 연속이고 projection 실패 시 둘 다 rollback돼야 한다.
- correct statement event target의 전체 영향 목록이 응답에 있어야 한다.
- 재해석 successor를 기본 event target으로 retract하면 chain 전체가 사라지고,
  cascade=false일 때만 predecessor가 복원돼야 한다.
- 자연어 target 후보가 두 개면 사건 없이 ambiguous와 candidate ID를 반환해야 한다.
- target preflight 뒤 다른 client의 merge/retraction을 경합시켜도 writer transaction에서
  다시 해석한 canonical 대상만 바뀌거나 안전하게 unchanged/not_found가 돼야 한다.
- merge 후 canonical ID, support와 surface가 보존되고 merge event 철회 뒤 replay에서
  원래 entity가 복원돼야 한다.
- 기존 alias를 다시 확인하면 unchanged이며 다른 entity의 동명 surface는 삭제되지 않아야 한다.
- agent_supplied mapping을 처음 확인하면 alias 사건이 생기고 confirmed로 승격돼야 한다.
- TTL만 만료된 claim 철회도 사건을 남겨 rules 변경 후 부활을 막아야 한다.
- retraction event를 target으로 주면 rejected여야 한다.
- correct가 merge/alias event를 target으로 받으면 해당 action 재시도 안내와 함께
  rejected여야 한다.

## References

- 초기 설계 2.3, 3.3, 6.3
- ADR-002, ADR-003, ADR-007, ADR-008, ADR-009, ADR-010, ADR-013, ADR-016
