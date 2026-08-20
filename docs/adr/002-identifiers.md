# ADR-002: 식별자 발급 규칙과 재생 안정성

- 상태: Accepted
- 결정일: 2026-08-20
- 소유 영역: 초기 설계 2.2
- 선행 ADR: ADR-001
- Supersedes: 없음

## Context

agent는 recall로 받은 `claim_id`와 `entity_id`를 이후 철회, 병합과 별칭 확인에 다시
사용한다. 규칙 변경 후 재생했을 때 ID가 바뀌면 과거 사건의 참조와 agent가 보관한
참조가 모두 깨진다.

전역 순번은 앞선 해석 결과가 달라질 때 뒤 ID를 밀어내고, 내용 해시는 정규화나 병합
같은 흔한 변화에서 입력 자체가 바뀐다. 사건 seq와 사건 안의 위치는 저널이 불변인 한
유지된다.

초기 설계의 의사코드는 “이미 개체가 있으면 기존 ID를 반환”할 뿐, 규칙 변경으로
사라진 후보 ID의 redirect를 만들지 않았다. 이 ADR은 모든 발생 위치에 후보 ID를
부여해 그 간극을 해결한다.

## Decision

### 사건 ID

- 사건 ID는 `ev_` + 대문자 Crockford Base32 ULID다.
- DB 내부 순서는 `journal.seq`만 사용한다.
- 서버가 ID를 발급하며 agent 입력은 받지 않는다.
- 드문 journal INSERT의 UNIQUE 충돌은 아직 성공 응답을 내기 전에 새 ULID로 transaction을
  재시도하며, 노출된 event ID를 바꾸거나 ULID 순서로 seq를 추정하지 않는다.

### 발생 위치 기반 후보 ID

모든 statement의 `parsed`를 저장된 배열 순서대로 순회한다.

```text
claim candidate = "c" + seq + "." + parsed_index
entity candidate = "e" + seq + "." + entity_position
```

외부 입력 검증 정규식은 `^c[1-9][0-9]*\.[0-9]+$`,
`^e[1-9][0-9]*\.[0-9]+$`, 사건은
`^ev_[0-7][0-9A-HJKMNP-TV-Z]{25}$`다. ULID의 첫 문자를 0~7로 제한해 128 bit를 넘는
비정규 26자 값을 받아들이지 않는다. 형식이 맞지 않으면 redirect 조회 전에 입력 오류로
거부하고 DB 존재 여부를 확인하지 않는다.

`parsed_index`는 저널에 실제 저장된 `parsed` 배열의 0 기반 인덱스다.
`entity_position`은 다음 순서로 만난 **모든 개체 발생**의 0 기반 순번이다.

1. 각 ClaimDraft의 subject
2. 같은 ClaimDraft의 object가 개체일 때 object
3. 다음 ClaimDraft

리터럴 `object_value`와 aliases는 entity position을 소비하지 않는다. 이미 존재하는
개체나 사실로 해석되더라도 후보 ID는 항상 계산한다.

### canonical ID와 redirect

- 처음 등장한 논리 개체/사실의 후보 ID가 canonical ID가 된다.
- 뒤 후보가 기존 canonical과 같다고 판정되면 후보에서 canonical로 redirect를 만든다.
- 규칙 변경이나 자동 중복 제거로 둘이 합쳐지면 가장 작은 `origin_seq`, 같은 seq에서는
  가장 작은 위치의 ID가 남는다.
- 사용자가 방향을 지정한 merge 사건에서는 등장 순서와 무관하게 사건의 `keep` ID가
  canonical로 남고 `absorb`가 redirect된다.
- `id_redirects`는 투영이며 전체 재생 때 다시 만든다.

```sql
CREATE TABLE id_redirects (
  old_id TEXT PRIMARY KEY,
  new_id TEXT NOT NULL,
  kind   TEXT NOT NULL CHECK (kind IN ('entity','claim')),
  reason TEXT NOT NULL CHECK (reason IN ('merge','rule_change','deduplicated')),
  CHECK (old_id <> new_id)
);

CREATE INDEX idx_redirect_new ON id_redirects(new_id);
```

외부에서 받은 모든 entity/claim ID는 사용 전에 redirect를 끝까지 따라간다. 최대 32개
hop을 허용하며 cycle이나 종류가 다른 redirect는 투영 손상 오류로 처리한다. projector는
모든 commit 전에 redirect가 최종 canonical을 바로 가리키도록 압축한다. 32-hop 제한은
손상된 입력을 방어하기 위한 것이지 정상 merge 횟수 제한이 아니다.

### 정규화 규칙 변경의 한계

여러 ID가 하나로 합쳐지는 many-to-one 변화는 redirect로 자동 처리한다. 하나의 과거
ID가 여러 개체로 갈라지는 one-to-many 변화는 단일 redirect로 의도를 보존할 수 없다.

- 약한 정규화로 바꾸는 재생 dry-run에서 split이 발견되면 규칙 배포를 중단한다.
- 과거 ID는 가장 먼저 등장한 결과 개체에 유지한다.
- 나머지 결과는 새 후보 ID를 받되, 과거 ID를 참조한 merge/alias/retraction의 의도가
  모호하다는 정비 항목을 만든다.
- 사용자가 mapping을 확인하거나 해당 statement를 재해석하기 전에는 새 규칙을
  `Accepted` rules_version으로 승격하지 않는다.

### ID 수명

- 한번 외부 응답에 노출된 ID는 다른 대상에 재사용하지 않는다.
- retracted/superseded 상태여도 ID와 redirect 해석은 유지한다.
- scope는 ID 문자열에 넣지 않는다. journal seq가 DB 전체에서 유일하며 모든 조회가
  별도로 scope를 검증한다.

## Alternatives

### UUID/ULID를 모든 개체와 사실에 저장

실시간 발급은 쉽지만 재생할 때 과거 발급 결과를 별도 원장에 보존해야 한다. 결국
저널에 anchor를 추가해야 하므로 사건 위치에서 직접 유도하는 방식을 선택했다.

### 정규화된 내용 해시

내용이 같으면 자연스럽게 중복 제거되지만 정규화, 어휘와 merge 변경이 곧 ID 변경이
된다. 재생 안정성 요구와 반대라 선택하지 않았다.

### redirect 없이 먼저 등장한 ID만 유지

현재 투영은 맞지만 agent가 가진 사라진 ID를 해석할 수 없다. 모든 후보 발생을
redirect 가능한 anchor로 취급한다.

## Consequences

- 같은 저널 배열 순서에서는 규칙 변경 뒤에도 과거 후보 ID를 계산할 수 있다.
- parsed 배열의 저장 순서가 규범의 일부가 되며 재해석 없이는 바꿀 수 없다.
- aliases를 추가해도 entity position은 바뀌지 않는다.
- ID redirect가 길어지거나 cycle이 생기는지 무결성 검사가 필요하다.
- one-to-many 규칙 변경은 자동 적용할 수 없고 사용자 결정 gate가 필요하다.

## Validation

- 같은 사건을 반복 재생해 candidate/canonical/redirect가 동일해야 한다.
- 공백 제거 규칙을 켜 두 개체를 합쳤을 때 늦은 ID가 이른 ID로 redirect돼야 한다.
- merge chain을 만든 뒤 모든 과거 ID가 같은 최종 canonical을 반환해야 한다.
- redirect cycle, 32 hop 초과와 entity/claim 종류 혼합을 거부해야 한다.
- parsed의 rejected 입력을 제거한 뒤 저장 배열 기준 index가 RecordResult와 정확히
  매핑되는지 ADR-013 시나리오로 검증해야 한다.
- 첫 문자가 8 이상인 26자 Crockford 문자열과 소문자 ULID 입력을 거부해야 한다.

## References

- 초기 설계 2.2
- ADR-001, ADR-006, ADR-008
