# ADR-006: 정규화 규칙과 강도

- 상태: Accepted
- 결정일: 2026-08-20
- 소유 영역: 초기 설계 3.2, 9장 정규화 강도 항목
- 선행 ADR: 없음
- Supersedes: 없음

## Context

정규화가 약하면 같은 개체가 여러 노드로 갈라지고, 너무 강하면 다른 개체가 합쳐져
사실이 오염된다. 한국어 조사를 단순 제거하면 실제 단어 끝을 조사로 오인할 수 있다.
정규화는 entity ID와 claim identity에 영향을 주므로 변경 전에 replay 결과를 비교해야
한다.

## Decision

`normalize_v1`을 `entities.normal_name`과 `surface_forms.surface_norm`에 똑같이 적용한다.

1. 입력의 앞뒤 공백을 제거한다.
2. Unicode NFKC를 적용한다.
3. locale에 의존하지 않는 Unicode lowercase를 적용한다.
4. 모든 Unicode White_Space, ASCII `-`, `_`를 제거한다.
5. 결과가 비면 입력을 거부한다.

개념적 정의는 다음과 같다.

```text
normalize_v1(s) = remove(/[\p{White_Space}_-]+/gu, lowercase(NFKC(trim(s))))
```

다음은 하지 않는다.

- 한국어 조사/어미 제거
- 형태소 분석 또는 stemming
- 번역과 동의어 치환
- 전각/반각 외 임의 문자 치환
- 숫자, 점, 슬래시 제거

원래 입력은 표시용 `entities.name`과 statement body에 보존한다. 처음 생성된 entity의
`name`을 canonical 표시 이름으로 유지하며 뒤 표현은 surface form으로 추가한다.
정규화가 같아도 `kind`는 identity에 참여하지 않는다.

정규화 구현에는 문자열 상수 `normalization_version = "v1"`을 두고 전체
`rules_version`에 포함한다. 구현 언어가 바뀌어도 fixture의 입력/출력 byte sequence가
같아야 한다.

### 규칙 변경 절차

조사 제거 여부는 v1에서 **제거하지 않는 것으로 확정**한다. 다음 신호가 나타나도
자동으로 규칙을 바꾸지 않고 후보를 만든다.

- 최근 1,000개 statement에서 평균 유효 support 수가 1.1 이하이고,
- 정비 리포트가 동일 개체 후보 분리의 20% 이상을 조사 차이로 분류한다.

변경 후보는 기존 journal로 dry-run replay한 뒤 다음을 현재 버전과 비교한다.

- canonical entity 수와 merge/split 수
- ID redirect 수와 one-to-many split 수
- 사실당 평균 support 수
- contested claim 수
- 20개 이상의 수동 동의/비동의 fixture

ADR-002의 one-to-many gate를 통과하고 별도 ADR이 Accepted되기 전에는 새
normalization_version을 배포하지 않는다.

## Alternatives

### 한국어 조사 제거

“서버가/서버를”을 연결할 수 있지만 사전과 형태소 분석 없이 단어 끝과 조사를 안전하게
구분할 수 없다. surface alias와 FTS가 더 보수적인 보완책이다.

### 공백만 제거

하이픈/언더스코어로 갈리는 기술 이름이 많아 초기 규칙보다 약하다.

### 임베딩 또는 LLM 기반 동일성

의미 유사성을 잡을 수 있지만 비결정적이며 재생 결과와 비용이 모델 버전에 종속된다.
후보 제안에는 쓸 수 있어도 자동 정규화에는 쓰지 않는다.

### kind를 identity에 포함

동명이인을 분리할 수 있지만 agent별 kind 편차가 곧 중복 개체가 된다. kind 불일치는
ADR-008의 정비 신호로 사용한다.

## Consequences

- `인증서버`, `인증 서버`, `인증-서버`, `인증_서버`는 같은 표면 정규형을 갖는다.
- `인증서버`와 `auth-server`, `PostgreSQL`과 `주 DB`는 자동으로 합쳐지지 않는다.
- 조사 포함 표현은 alias 확인이나 FTS fallback이 필요할 수 있다.
- 정규화 변경은 버전 증가, dry-run과 전체 재생을 요구한다.
- 구현체의 Unicode 동작을 fixture로 고정해야 한다.

## Validation

- NFKC, 대소문자, 공백, 하이픈과 언더스코어 fixture가 기대값과 같아야 한다.
- 한국어 조사 예시는 서로 다른 normal_name으로 남아야 한다.
- 빈 문자열이 되는 입력을 거부해야 한다.
- entity와 surface form 경로가 같은 normalize 함수를 사용해야 한다.
- locale을 바꿔 실행해도 fixture 결과가 달라지지 않아야 한다.
- 규칙 변경 dry-run이 journal과 현재 투영을 수정하지 않아야 한다.

## References

- 초기 설계 3.2, 9장 정규화 강도 항목
- ADR-002, ADR-008
