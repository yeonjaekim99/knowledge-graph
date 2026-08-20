# ADR-013: memory_record 인터페이스

- 상태: Accepted
- 결정일: 2026-08-20
- 소유 영역: 초기 설계 6.1, 9장 모델별 파싱 편차·session TTL 항목
- 선행 ADR: ADR-003, ADR-004, ADR-007, ADR-010, ADR-011
- Supersedes: 초기 설계 ClaimDraft의 entity kind 입력 누락

## Context

서버에는 자연어 파서가 없다. Agent가 원문과 `ClaimDraft[]`를 함께 보내야 원래 표현을
보존하면서 그래프를 만들 수 있다. 파싱을 확신하지 못할 때도 원문을 잃지 않아야 하고,
한 draft의 오류가 다른 유효 draft의 기록을 막아서도 안 된다. 반대로 scope, actor,
branch와 session을 호출자가 주장하도록 두면 격리와 provenance를 신뢰할 수 없다.

초기 설계는 기본 타입과 부분 성공을 정했지만, 검증 순서, rejected draft가 안정 ID
위치에 미치는 영향, 원문 마스킹, 중복 draft와 재해석 입력의 의미를 확정하지 않았다.

## Decision

### 입력 계약

```typescript
type MemoryRecordInput = {
  raw_text: string;
  claims: ClaimDraft[];
  provenance?: "user_stated" | "observed" | "inferred";
  ttl?: "session" | "weeks" | "permanent";
} & (
  | { supersedes?: never; reinterpret_approval?: never }
  | { supersedes: string; reinterpret_approval: string }
);

type ClaimDraft = {
  subject: string;
  subject_kind?: string;
  relation: "uses" | "rejects" | "contains" | "describes" | "relates_to";
  relation_label?: string;
  object?: string;
  object_kind?: string;
  object_value?: string;
  subject_aliases?: string[];
  object_aliases?: string[];
};
```

JSON Schema는 `additionalProperties: false`를 모든 object에 적용한다. 문자열은 Unicode
문자 수 기준으로 검사하며 제한은 다음과 같다.

| 항목 | 제한 |
|---|---|
| raw_text | trim 뒤 1~32,768자 |
| claims | 0~100개 |
| subject, object, object_value | trim 뒤 1~1,024자 |
| relation_label, alias | trim 뒤 1~256자 |
| subject_kind, object_kind | trim 뒤 1~64자 |
| 각 alias 배열 | 최대 20개 |

`object`와 `object_value`는 정확히 하나만 있어야 한다. `object_aliases`와 `object_kind`는
object가 있을 때만 허용한다. kind는 선택 참고 정보이며 trim → NFKC → Unicode lowercase
값으로 투영하고 identity에는 참여하지 않는다. 확신이 없으면 생략한다. `relates_to`는
ADR-004에 따라 비어 있지 않은 relation_label이 필요하다.
입력 문자열은 의미 보존을 위해 원문 값을 저장하되, 동일성 비교에는 각 담당 ADR의
정규화를 적용한다.

provenance 기본값은 가장 보수적인 `inferred`다. ttl을 생략하면 ADR-010 표를 적용한다.
일반 기록에서 `supersedes`는 없으며, 있으면 ADR-017의 재해석 계약을 추가로 만족해야
한다. `supersedes`와 `reinterpret_approval`은 정확히 함께 있거나 함께 없어야 한다.
전자는 ADR-002의 event ID pattern, 후자는 ADR-017의 일회성 승인 token pattern을 JSON
Schema에서 먼저 검사한다. 승인 token은 journal body나 metadata에 저장하지 않는다.

`scope_key`, actor, branch, session과 created_at은 입력에 없다. 서버가 ADR-003의
신뢰 경계와 현재 요청·git 상태로 채운다.

### 검증과 기록 순서

한 번의 `BEGIN IMMEDIATE` transaction 안에서 다음 순서를 지킨다.

1. 요청 전체의 형식과 크기를 검사한다. relation enum, object/object_value XOR,
   `relates_to` label 조건을 포함해 JSON Schema를 위반하면 사건을 만들지 않고
   protocol/tool error로 끝낸다.
2. ADR-011에 따라 raw_text와 모든 draft 문자열을 비밀값 검사한다. raw_text의 의심
   구간은 마스킹한다. 비밀값이 있는 draft만 rejected 처리하며 값 자체를 note에 넣지
   않는다.
3. 구조적으로 유효한 각 draft를 독립 검증하고 entity를 현재 projection에서 해석한다.
   모호한 surface나 비밀값처럼 DB/내용을 봐야 아는 의미 오류는 그 draft만 rejected다.
4. 유효 draft를 원래 입력 순서로 유지하되 같은 요청 안에서 claim identity가 같은 것은
   첫 draft 하나로 합친다. 뒤의 입력 index에는 첫 index와 합쳐졌다는 note를 반환한다.
5. 기본 provenance/ttl과 마스킹된 raw_text, **승인된 draft만** 담은 statement 사건을
   journal에 한 번 추가한다. 승인된 draft가 0개여도 사건을 기록한다.
6. ADR-007의 동기 projector를 실행하고 결과 claim ID와 상태를 모은 뒤 commit한다.

`supersedes`가 있는 재해석 호출은 예외적으로 draft 부분 성공을 허용하지 않는다.
입력 claims가 처음부터 빈 배열인 것은 유효하지만, 하나라도 비밀·모호성 등으로
rejected되면 successor 사건을 만들지 않고 원본을 live로 유지한 채 전체 호출을
actionable error로 반환한다. 원본 전체를 불완전한 parsed로 교체하는 것을 막기 위해서다.

rejected 또는 요청 내 중복 draft는 journal body의 `parsed` 배열에 들어가지 않으며
claim/entity ID 위치도 소비하지 않는다. ID의 `parsed_index`는 원래 요청 index가 아니라
저장된 `parsed` 배열 index다. 응답의 `index`만 원래 요청 배열 위치를 가리킨다.

서버 장애로 journal append 또는 projection 중 하나라도 실패하면 transaction 전체를
rollback한다. 사용자에게 event_id를 반환한 성공 응답은 journal과 projection이 모두
반영됐음을 뜻한다.

### 출력 계약

```typescript
type RecordResult = {
  event_id: string;
  claims: Array<{
    index: number;
    status: "created" | "reinforced" | "superseded_previous" | "rejected";
    claim_id?: string;
    note?: string;
  }>;
};
```

각 입력 draft마다 결과가 정확히 하나 있다.

- `created`: 새 claim identity가 생성됐다.
- `reinforced`: 기존 claim에 이 statement의 support가 추가됐다. 요청 안의 중복 draft도
  같은 claim_id와 이 상태를 반환하되 support는 한 번만 추가하고 note로 병합을 알린다.
- `superseded_previous`: 새 `describes`가 이전 active 값을 superseded로 만들었다.
- `rejected`: 구조는 유효하지만 비밀값·entity 모호성 같은 의미 판정을 통과하지 못해
  저장된 parsed에 포함되지 않았다. claim_id는 없고 고쳐서 재시도할 수 있는 note가 있다.
  Schema를 위반한 draft는 이 상태가 아니라 요청 전체 입력 오류다.

한 draft가 기존 claim을 되살리는 경우 새 claim이 아니므로 `reinforced`다. 여러 이전
`describes` 후보가 잘못 존재하면 projector invariant 위반으로 요청 전체를 실패시키며
임의로 하나를 고르지 않는다.

상태가 겹치면 `superseded_previous`가 우선하고, 그렇지 않으면 identity를 처음 만들었을
때 `created`, 기존 identity에 support를 붙였을 때 `reinforced`다. 따라서 과거 describes
값을 되살리며 현재 값을 내린 경우도 `superseded_previous`다.

### 원문만 기록

`claims: []`는 정상 사용이다. raw_text는 statement의 effective TTL 안에서 FTS/overview로
조회하고 이후 ADR-017의 재해석 후보가 될 수 있다. 서버가 claim을 추출하거나 빈 배열을
오류로 바꾸지 않는다.

### 재시도 의미

동일한 호출을 다시 보내면 별도 statement 사건과 support가 추가된다. 이는 반복 관찰과
강화를 보존하려는 의도된 동작이며 요청 자체는 멱등하지 않다. 네트워크 재시도 중복을
구별할 호출자 제공 idempotency key는 v1에 넣지 않는다. client는 성공 응답을 받은
요청을 자동 재전송하지 않아야 하며, 필요성이 확인되면 별도 ADR로 event-level key를
추가한다.

### 파싱 편차 평가

Claude, OpenCode 등 공식 지원 client마다 같은 한국어·영어 fixture 20개 이상을
`ClaimDraft[]`로 만들게 한다. 정규화한 claim identity 집합의 pairwise Jaccard 평균을
기록하고 다음을 release gate로 둔다.

- 평균 Jaccard가 0.80 미만이면 tool description과 예시를 보강한 뒤 다시 측정한다.
- 비밀값, 부정(`rejects`) 또는 object/object_value 구분을 뒤집는 사례가 하나라도 있으면
  평균과 관계없이 차단 결함으로 취급한다.
- 보강 뒤에도 모호한 문장은 agent가 추측 draft를 만들기보다 `claims: []`로 기록하도록
  안내한다. 자동으로 과거 원문을 재해석하지 않는다.

session ttl은 ADR-010의 12시간 근사를 사용하며 이 인터페이스에 종료 callback을
추가하지 않는다.

## Alternatives

### raw_text를 선택으로 둔다

저장은 간단해지지만 파싱 오류를 복구하거나 FTS로 찾을 근거가 사라진다. 항상
요구한다.

### 하나의 의미 오류로 요청 전체 거부

원자성은 단순하지만 기억할 수 있었던 사실까지 유실된다. Schema로 표현되는 구조
오류만 전체 실패시키고 비밀·모호성 같은 내용별 검증은 부분 성공시킨다.

### 서버가 자연어를 파싱

Agent별 언어 모델과 서버 파서가 중복되고 replay가 비결정적·고비용이 된다. 파싱은
agent, 규칙 적용은 서버가 담당한다.

### memory_record를 멱등하다고 선언

같은 claim row를 만들지 않는다는 뜻에서는 비슷해 보여도 새 statement와 support가
추가되어 count와 last_seen이 바뀐다. 프로토콜 의미상 멱등이 아니라고 선언한다.

## Consequences

- 원문만이라도 남기는 안전한 하향 경로가 있다.
- 부분 성공 결과와 journal의 parsed index 사이 차이를 구현에서 명시적으로 매핑해야 한다.
- raw_text의 비밀값은 불변 저널에 들어가기 전에 마스킹된다.
- 반복 호출은 증거 수와 최근성을 바꾸므로 caller가 재시도를 관리해야 한다.
- 모델별 파싱 편차를 감으로 판단하지 않고 고정 fixture로 관찰한다.

## Validation

- `claims: []`가 statement와 FTS row를 만들고 claim은 만들지 않으며 statement TTL 뒤
  raw recall에서 사라져야 한다.
- 세 draft 중 하나가 비밀값이면 원문은 마스킹되고 나머지 두 개만 projection돼야 한다.
- 같은 입력에 supersedes가 있으면 draft 하나의 거부도 사건을 만들지 않아야 한다.
- supersedes와 reinterpret_approval 중 하나만 있거나 승인 token이 만료·불일치하면
  사건 없이 요청 전체가 거부돼야 한다.
- rejected 첫 draft 뒤 승인된 draft의 claim ID가 `c{seq}.0`이어야 한다.
- 같은 요청의 중복 두 draft가 결과 두 개, support 한 개를 만들어야 한다.
- object와 object_value가 둘 다 있거나 모두 없으면 사건 없이 요청 전체가 입력 오류여야 한다.
- projection 실패를 주입하면 journal INSERT도 rollback돼야 한다.
- 동일 성공 요청을 두 번 호출하면 statement/support가 두 개이고 claim은 하나여야 한다.
- 지원 client의 20개 fixture 파싱 편차 gate를 통과해야 한다.

## References

- 초기 설계 2.3, 3.3~3.4, 6.1, 9장 파싱 편차·session TTL 항목
- ADR-003, ADR-004, ADR-007, ADR-009, ADR-010, ADR-011, ADR-016, ADR-017
