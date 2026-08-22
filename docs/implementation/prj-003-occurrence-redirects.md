# PRJ-003: occurrence ID와 redirect registry

- 상태: 구현 완료
- 기준 ADR: ADR-002
- 선행 작업: PRJ-001, PRJ-002
- 구현 branch: `prj-003-occurrence-redirects`

## 목적과 범위

ADR-002는 statement 안의 발생 위치를 외부 ID의 영속적인 anchor로 삼는다. 같은 논리
대상으로 합쳐진 뒤에도 늦은 occurrence의 후보 ID를 잃지 않고 canonical ID로 해석해야
하며, 규칙 변경이 하나의 과거 대상을 여러 대상으로 가르는 경우에는 자동 배포를
중단해야 한다.

PRJ-003은 이 의미를 IO 없는 domain primitive로 구현한다. 이 작업은 journal event를
해석하거나 projection row를 쓰지 않는다. PRJ-004~009가 같은 primitive를 사건 pre-scan,
entity/claim reducer와 commit gate에 연결한다.

## 발생 위치와 후보 ID

`enumerateOccurrenceCandidates`는 journal에 실제 저장된 statement의 `seq`와 `parsed`
배열만 받는다. 저장 배열의 각 draft에 다음 후보를 배정한다.

```text
claim       c{seq}.{parsed_index}
subject     e{seq}.{entity_position}
entity obj  e{seq}.{entity_position + 1}
```

- `parsed_index`와 `entity_position`은 0부터 시작한다.
- draft마다 subject가 먼저 위치를 소비하고, `object`가 개체일 때만 다음 위치를 소비한다.
- `object_value`, `subject_aliases`와 `object_aliases`는 entity 위치를 소비하지 않는다.
- 같은 이름이 앞 occurrence의 기존 entity로 해석되더라도 위치와 후보 ID는 소비한다.
- rejected input을 제거한 뒤 저장되는 배열과 호출 input index의 매핑은 REC-005가 소유한다.
  이 primitive는 저장된 배열의 의미만 고정한다.

입력은 accessor, symbol key, sparse slot이나 임의 추가 array property가 없는 plain JSON data
record/array여야 한다. ID 계산 중 getter를 평가하거나 submitted subject/object를 오류에
포함하지 않는다. draft의 relation이나 문자열 의미 검증은 PRJ-002와 후속 statement
validator의 책임이며 여기서 중복 구현하지 않는다.

## ID 검증과 canonical 선택

외부 ID는 lookup 전에 다음 canonical 형식으로 검증한다.

```text
event   ^ev_[0-7][0-9A-HJKMNP-TV-Z]{25}$
entity  ^e[1-9][0-9]*\.[0-9]+$
claim   ^c[1-9][0-9]*\.[0-9]+$
```

entity/claim 후보 비교는 문자열 사전순이 아니라 `seq`와 위치를 `BigInt`로 분리한 숫자
순서다. 따라서 `e9.10`은 `e10.2`보다 이르고 `c12.2`는 `c12.10`보다 이르다.

`chooseCanonicalIdentifier`의 선택 규칙은 다음과 같다.

| reason | canonical | redirect |
|---|---|---|
| `deduplicated` | 숫자 발생 순서가 가장 이른 후보 | 나머지 후보 → earliest |
| `rule_change` | 숫자 발생 순서가 가장 이른 후보 | 나머지 후보 → earliest |
| `merge` | 사건이 명시한 `keepId` | 나머지 후보 → keep |

merge에서 keep이 후보 집합에 없거나, 자동 선택에서 keep을 넘기거나, 중복·다른 종류의
후보가 있으면 typed error로 중단한다.

## redirect registry와 resolver

registry 입력은 모든 occurrence anchor의 `{ id, kind, scopeKey }`와 projection redirect
행이다. 생성 시 다음을 검증한다.

- anchor ID의 canonical 형식, 중복과 exact trusted scope 형식
- redirect old/new anchor의 존재, 동일 kind와 동일 scope
- self edge, old ID의 복수 outgoing edge, cycle과 32-hop 상한
- reason이 `merge | rule_change | deduplicated` 중 하나인지

정상 registry는 모든 redirect를 최종 canonical에 직접 닿도록 압축하고 ID 순서로
정렬한 뒤 재귀적으로 변경할 수 없는 data를 반환한다. chain 중간 reason은 각 old ID의
발생 이유로 유지한다. 32개 edge는 허용하고 33번째 edge는 손상으로 거부한다.

`resolveCanonicalIdentifier`는 요청 ID 형식을 registry 조회보다 먼저 확인한다. 그 뒤
source anchor와 최종 target 양쪽에서 expected kind와 trusted scope를 확인한다. 오류는
고정된 code/message만 가지며 ID, scope, payload와 내부 cause를 echo하지 않는다.

현재 registry는 pure validation/normalization 경계다. 실제 `id_redirects` row 생성,
projection snapshot 반영과 commit 직전 재검사는 PRJ-005~009가 담당하며 사용자 요청에서
projection만 수정하는 API는 만들지 않는다.

## rules 변경 dry-run

`dryRunIdentityRuleChange`는 현재 canonical에 귀속된 모든 occurrence와 새 rules로 계산한
identity key를 받지만 journal, projection이나 SQLite를 변경하지 않는다.

- 한 새 identity에 여러 **현재 canonical ID**가 합쳐지는 many-to-one이면 그 current
  canonical 집합 중 숫자상 가장 이른 ID를 유지하는 `rule_change` redirect 계획을 낸다.
  이미 명시적 merge로 흡수된 raw occurrence를 다시 canonical로 승격하지 않는다.
- 한 current canonical의 occurrence가 여러 새 identity로 갈리는 one-to-many이면
  `status: blocked`, 빈 redirect와 결정적인 maintenance candidate를 반환한다. 각 결과
  집합의 가장 이른 occurrence를 대표로 삼고, 전체에서 가장 이른 대표에 과거 ID를
  유지하도록 안내한다.
- one-to-many가 하나라도 있으면 같은 dry-run의 safe redirect도 게시하지 않는다.
- 결과에는 identity key나 원문을 넣지 않고 occurrence/canonical ID, kind와 scope만 둔다.

규칙의 version 승격, 승인 UX, 실제 replay와 rollback은 PRJ-009/010과 REL-006/007의
책임이다. blocked 결과를 부분 적용하는 운영 경로는 허용하지 않는다.

## 실패 계약

모든 실패는 `ProjectionIdentifierError`와 고정 code로 반환된다. 주요 code는 canonical
입력, occurrence shape, canonical selection, registry structure, self/dangling/kind/scope,
cycle/depth, not-found와 dry-run baseline 오류를 구분한다. submitted 값이나 getter 결과를
오류 객체에 보관하지 않는다.

## TDD와 검증

RED는 `ProjectionIdentifierError`와 PRJ-003 public seam이 아직 export되지 않아 target
unit test가 load 단계에서 실패했다. GREEN은 다음을 고정한다.

- 저장 draft 순서, 반복 subject, entity/literal object와 alias 위치 소비
- canonical event/entity/claim 형식과 숫자 사전순 함정
- dedupe/rule-change earliest와 명시적 merge keep
- entity/claim 정상 chain 압축과 source/target scope 검증
- self, dangling, duplicate, cycle, kind/scope 혼합과 32/33-hop 경계
- many-to-one 결정성, one-to-many 차단, 입력 불변성과 payload 비노출
- plain data accessor를 평가하지 않는 fail-closed 경계

재현 명령은 다음과 같다.

```bash
pnpm verify:prj-003
pnpm verify:local
```

PRJ-003 완료 시점 기준 결과는 target 9/9, 빠른 전체 suite 117/117이다. behavior spike는
독립 oracle로 남고 production code에서 import하거나 복사하지 않았다.

## 후속 작업 경계

- PRJ-004: retraction/supersedes pre-scan과 effective statement stream
- PRJ-005: entity resolution, surface/kind와 occurrence redirect 생성
- PRJ-006: claim identity, support와 상태 reducer
- PRJ-007: merge/alias event 및 claim rewrite
- PRJ-009: incremental/full dispatcher, registry·DB invariant와 atomic publish
- PRJ-010: 모든 prefix에서 online/replay ID와 redirect parity
- REC-005: 부분 성공 뒤 input index와 저장 `parsed_index`/RecordResult 매핑
