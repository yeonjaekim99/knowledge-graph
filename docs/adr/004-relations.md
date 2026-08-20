# ADR-004: 관계 어휘, 카디널리티, 승격 절차

- 상태: Accepted
- 결정일: 2026-08-20
- 소유 영역: 초기 설계 2.5, 9장 관계 어휘 항목
- 선행 ADR: 없음
- Supersedes: 없음

## Context

관계를 자유 문자열로 받으면 `uses`, `use`, `사용`, `utilizes`가 서로 다른 간선이 되어
그래프가 조각난다. 반대로 큰 고정 목록은 agent가 적절한 항목을 찾지 못해 잘못
분류하거나 기록을 포기하게 한다.

Recall에는 안정된 탐색·상충·카디널리티 규칙을 위한 작은 정규 어휘와, 실제 표현 및
새 용례를 잃지 않을 열린 라벨이 동시에 필요하다.

## Decision

### v1 정규 관계

| relation | 의미 | 카디널리티 | 기본 표시 |
|---|---|---|---|
| `uses` | 의존, 사용, 요구 | 다중 | 사용 |
| `rejects` | 배제, 거부, 탈락한 선택지 | 다중 | 거부 |
| `contains` | 포함, 위치, 소속 | 다중 | 포함 |
| `describes` | 속성 슬롯의 값 또는 상태 | 단일 | = |
| `relates_to` | 다른 네 관계로 안전하게 분류할 수 없는 연결 | 다중 | 관련 |

`ClaimDraft.relation`은 위 다섯 값만 허용한다. `relation_label`은 agent가 실제로 사용한
표현을 보존하는 선택 문자열이며 앞뒤 공백을 제거한 뒤 최대 256자다.
`relates_to`를 선택할 때는 승격 데이터를 남기기 위해 비어 있지 않은
`relation_label`을 필수로 한다.

`object`와 `object_value`는 모든 관계에서 정확히 하나만 존재한다. 다만 다음 작성
관례를 tool description과 평가 fixture에 포함한다.

- 다시 탐색할 대상이면 `object` 개체를 사용한다.
- 명령, 숫자, 경로, 설정값처럼 그 자체가 종착 값이면 `object_value`를 사용한다.
- `describes`의 subject는 일반 개체 전체가 아니라 **하나의 값만 갖는 속성 슬롯**으로
  모델링한다. 예: `테스트 명령 → "pnpm test"`.
- 한 개체에 여러 속성이 필요하면 `테스트 명령`, `런타임 버전`처럼 별도 슬롯 개체를
  만들고 `contains` 또는 적절한 관계로 상위 개체와 연결한다.

이 관례 때문에 `describes`의 단일 제약은 `(scope_key, subject_id)`에 적용된다.
서로 다른 값의 `describes`가 들어오면 ADR-009의 순서로 기존 값을 supersede한다.

### 별칭과 동일성

`same_as`, `alias_of` 같은 관계는 정규 어휘에 넣지 않는다.

- 개체를 가리키는 다른 말은 `surface_forms`와 alias 사건이 소유한다.
- 두 개체가 같다는 결정은 merge 사건이 소유한다.
- 그래프 탐색 결과에는 별칭 자체를 간선으로 노출하지 않는다.

### relation_label

같은 사실에 여러 support가 있으면 ADR-010의 `claim_agg.relation_label`은 현재 유효
support 중 가장 큰 statement order_seq, 같은 order_seq에서는 실제 journal seq가 큰
non-empty label이다. 최신 support에 label이 없으면
그보다 앞선 유효 label을 사용하고, 하나도 없으면 NULL이다. 철회나 만료로 최신
support가 무효화되면 조회 집계가 이전 label로 되돌린다.

relation_label은 support에서 완전히 도출되므로 `claims`에는 저장하지 않는다. 특히 TTL
만료에는 write가 없어서 저장 컬럼을 정확히 되돌릴 수 없다. 표시와 어휘 통계는
statement body와 `claim_agg`를 단일 출처로 사용한다.

승격 빈도를 셀 때만 label에 NFKC → Unicode lowercase → 양끝 trim → 연속 Unicode
White_Space를 ASCII 공백 하나로 축약한 `relation_label_metric_norm_v1`을 적용한다.
문장부호, 하이픈과 조사는 제거하지 않는다. 이 값은 저장하거나 표시에 사용하지 않고
리포트 안에서만 계산한다. 지표 정규화 규칙이 바뀌면 과거·신규 리포트를 같은 버전으로
다시 계산해 비교한다.

### 어휘 승격

v1에서는 다섯 관계를 확정한다. 다음 중 하나가 충족되면 자동 변경 없이 어휘 검토
리포트를 만든다.

- 최근 200개 이상의 유효 claim draft에서 `relates_to` 비율이 20%를 넘는다.
- 정규화한 동일 `relation_label`이 서로 다른 statement 40개 이상에서 나타난다.

승격은 사용자 검토와 후속 ADR을 요구한다. 새 관계를 채택할 때는 다음을 함께 정한다.

1. 의미와 반례
2. 단일/다중 카디널리티
3. 기본 표시 문자열
4. 기존 `(relation='relates_to', relation_label=...)`을 새 관계로 매핑하는 규칙
5. claims CHECK 변경 마이그레이션과 rules_version 증가
6. 재생 전후 claim 수, 상충 수와 redirect 변화

빈도만으로 자동 승격하거나 과거 journal body를 UPDATE하지 않는다.

## Alternatives

### 완전 자유 관계 문자열

agent 표현력은 높지만 탐색과 집계가 동일 의미를 묶지 못한다. relation_label로 표현을
보존하면서 정규 관계는 닫힌 집합으로 유지한다.

### 큰 온톨로지를 처음부터 도입

실사용 데이터 없이 구분이 어려운 관계가 늘어나 agent 선택 오류가 커진다. 작은 집합과
탈출구로 시작한다.

### describes를 다중 관계로 변경

모델링은 자유로워지지만 설정값 교체라는 흔한 패턴을 자동 처리할 수 없다. subject를
속성 슬롯으로 모델링하는 제약을 받아들이고 단일 관계를 유지한다.

### alias를 그래프 간선으로 저장

동일한 대상을 탐색 경로에 중복 노출하고 경로 설명을 오염시킨다. 진입 색인과
동일성 사건으로 분리한다.

## Consequences

- 관계 기반 탐색과 상충 판정이 안정된 enum 위에서 동작한다.
- agent는 애매할 때 기록을 포기하지 않고 `relates_to`를 사용할 수 있다.
- `describes` subject를 속성 슬롯으로 만드는 tool 설명과 평가가 중요하다.
- 새 정규 관계를 추가할 때 의미 재생뿐 아니라 CHECK 마이그레이션도 필요하다.
- relation_label은 표시뿐 아니라 어휘 개선을 위한 관측 데이터가 된다.

## Validation

- 다섯 값 외 relation은 JSON Schema 입력 오류로 거부하되 허용 값과 재시도 방법을
  안내해야 한다.
- `relates_to`에 label이 없으면 JSON Schema 입력 오류로 거부하고 수정 방법을 안내해야 한다.
- 같은 subject의 서로 다른 describes 값이 동시에 active가 될 수 없어야 한다.
- uses/contains 등 다중 관계는 목적어가 달라도 함께 active여야 한다.
- same_as 입력 예시는 merge 또는 alias 사용 안내로 이어져야 한다.
- 승격 dry-run은 journal을 수정하지 않고 전후 지표를 산출해야 한다.
- 공백·대소문자·호환 문자만 다른 label은 승격 지표에서 같은 값이고 문장부호가 다른
  label은 별도 값이어야 한다.

## References

- 초기 설계 2.5, 9장 관계 어휘 항목
- ADR-009, ADR-012, ADR-016
