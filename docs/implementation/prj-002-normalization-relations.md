# PRJ-002: 정규화·관계·리터럴 동일성 규칙

- 상태: Accepted
- 결정일: 2026-08-22
- 작업: PRJ-002
- Owner: `log0629`
- 규범 근거: ADR-004, ADR-006, ADR-009
- 선행 구현: PRJ-001
- 규범 관계: ADR을 대체하지 않는 production implementation decision

## production gap

behavior spike의 S01과 S03은 정규형으로 surface를 찾고 중복 claim을 강화하는 상태 의미를
검증했다. PRJ-001은 같은 journal과 rules version을 pure reducer에 전달하는 production seam을
만들었다. 그러나 entity와 surface가 공유할 versioned 함수, literal identity, relation
카디널리티와 표시 문자열의 단일 코드 원본은 없었다.

PRJ-002는 DB나 사건 reducer를 추가하지 않고 이 결정적 primitive만 고정한다. 후속 reducer가
서로 다른 문자열 규칙이나 relation enum을 다시 만들지 않도록 domain module에서 공개한다.

## `normalize_v1`

`NORMALIZATION_VERSION`은 `v1`이다. entity 이름과 surface form은 반드시 같은
`normalizeV1`을 사용하며 처리 순서는 다음과 같다.

```text
trim
  → Unicode NFKC
  → locale 비의존 Unicode lowercase
  → /[\p{White_Space}_-]+/gu 제거
```

| 입력 | 결과 | 경계 |
|---|---|---|
| ` 인증_서버-API ` | `인증서버api` | 공백·ASCII hyphen·underscore 제거 |
| `ＰｏｓｔｇｒｅＳＱＬ` | `postgresql` | NFKC 뒤 lowercase |
| `I` | `i` | Turkish locale에서도 동일 |
| `서버가`, `서버를` | 서로 다름 | 조사 제거 안 함 |
| `Node.js/24` | `node.js/24` | 점·슬래시·숫자 보존 |

처리 뒤 빈 값이면 `ProjectionRuleError`의 `EMPTY_NORMALIZED_VALUE`로 거부한다. 타입 오류와
빈 값 오류는 제출 문자열을 message나 별도 property로 되돌려주지 않는다. fuzzy match,
형태소 분석, 번역, alias와 merge는 이 함수가 수행하지 않는다.

JavaScript의 `String.prototype.toLowerCase()`를 사용하고 locale 인자를 받지 않는다. 별도
process test가 `LANG`/`LC_ALL`을 `C`와 `tr_TR.UTF-8`로 바꾸어도 고정 fixture의 출력 byte가
같음을 검증한다.

## literal identity

`normalizeLiteralIdentity`는 앞뒤 trim 뒤 NFKC만 적용한다. 내부 공백, tab, 대소문자와
문장부호는 동일성의 일부로 보존한다. 처리 뒤 빈 값은 `EMPTY_LITERAL_VALUE`로 거부한다.

```text
"  Ｎｏｄｅ  ２４!  " → "Node  24!"
"PostgreSQL"          ≠ "postgresql"
```

이는 나중에 `claims.object_value`, unique identity와 brief 표시가 같은 canonical literal을
보도록 하는 primitive다. 원래 source 값은 불변 journal draft가 계속 소유한다.

## relation registry

`RELATION_REGISTRY`와 각 definition은 runtime에서도 freeze한다. replay snapshot validation도
같은 `CANONICAL_RELATIONS`를 사용하므로 domain 내부에 별도 enum 목록을 두지 않는다.

| relation | 의미 | 카디널리티 | 기본 표시 |
|---|---|---|---|
| `uses` | 의존·사용·요구 | `multiple` | 사용 |
| `rejects` | 배제·거부·탈락한 선택지 | `multiple` | 거부 |
| `contains` | 포함·위치·소속 | `multiple` | 포함 |
| `describes` | 속성 슬롯의 값 또는 상태 | `single` | = |
| `relates_to` | 다른 네 관계로 안전하게 분류할 수 없는 연결 | `multiple` | 관련 |

registry는 카디널리티의 선언 원본이다. 실제 `describes` 대체 순서와 active state 전이는
PRJ-006이 구현한다.

## `relation_label` 입력 primitive

`normalizeRelationLabel`은 다음 경계를 고정한다.

- 저장할 표현은 양끝 공백만 제거하고 NFKC·lowercase·문장부호 제거를 하지 않는다.
- 선택적으로 제공한 label은 trim 뒤 비어 있지 않아야 한다.
- `relates_to`는 비어 있지 않은 label이 반드시 있어야 한다.
- 최대 길이는 UTF-16 unit이 아니라 Unicode code point 256개다.
- 정규 다섯 값 밖 relation은 safe `INVALID_RELATION` 오류로 거부한다.

최신 유효 label을 support에서 고르는 집계와 통계용 `relation_label_metric_norm_v1`은 각각
PRJ-008과 REL-006이 소유한다. 이 primitive는 label을 claim row에 저장하거나 어휘를 자동
승격하지 않는다.

## TDD와 검증

RED에서는 target test가 아직 없는 `CANONICAL_RELATIONS` domain export를 요구해 import
단계에서 실패했다. 구현 뒤 다음을 검증한다.

- trim/NFKC/lowercase/separator의 정확한 순서와 Unicode 호환 문자
- C와 Turkish process locale에서 동일한 출력 byte
- 한국어 조사·점·슬래시·숫자 보존과 빈 정규형 거부
- literal의 내부 공백·대소문자·문장부호 보존
- 다섯 relation의 의미·카디널리티·기본 표시와 runtime immutability
- relation/label의 정상, 누락, 공백, 타입과 256/257 code-point 경계

```bash
pnpm verify:prj-002
pnpm verify:local
python3 -m unittest discover -s spikes/adr-behavior -p 'test_*.py' -v
python3 docs/roadmap/validate.py
```

PRJ-002 target은 7/7, 전체 빠른 suite는 108/108을 통과했다. 아직 entity/surface reducer가
없으므로 S01과 S03 production manifest는 `planned`를 유지한다. PRJ-005와 PRJ-006이 이
primitive를 실제 투영 상태 전이에 연결하고, PRJ-010이 모든 prefix parity를 증명한 뒤에만
해당 scenario 완료 상태를 바꾼다.

## 후속 작업 경계

- PRJ-003: occurrence ID와 redirect
- PRJ-004: 사건 pre-scan과 effective stream
- PRJ-005: entity·surface·kind resolver가 `normalizeV1`을 실제로 공유
- PRJ-006: literal claim identity와 relation cardinality 상태 전이
- PRJ-008: 유효 support 기반 최신 `relation_label` 집계
- PRJ-009~010: dispatcher, 전체 replay와 prefix parity
- REC-001: 같은 다섯 relation과 label 조건을 public JSON Schema에 연결
- REL-006~007: 어휘 지표, 규칙 dry-run과 승인된 rollout

Accepted ADR의 의미를 바꾸지 않으므로 superseding ADR은 필요하지 않다.
