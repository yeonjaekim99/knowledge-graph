# REC-002: versioned 비밀값 detector

- 상태: Accepted
- 결정일: 2026-08-22
- 작업: REC-002
- Owner: `log0629`
- 규범 근거: ADR-003, ADR-011, ADR-013
- 선행 구현: FND-003
- 규범 관계: ADR을 대체하지 않는 production implementation decision

## 기존 증거와 production gap

behavior spike S18은 대표 GitHub signature의 raw 마스킹, draft 부분 거부와 revise
fail-closed 의미가 함께 성립함을 확인했다. spike 과정에서는 `ghp_…은`처럼 ASCII token
뒤에 한국어 조사가 붙을 때 Unicode `\b`가 provider class를 놓치는 위험도 발견했다.
FND-003은 domain에서 clock, random, process, network와 Git을 직접 읽지 못하게 하는
architecture guard를 이미 제공한다.

REC-002는 이 상태 전이를 복제하지 않고 production에 남아 있던 다음 차이만 닫는다.

- provider별 명시 signature와 generic entropy를 분리한 versioned registry
- ASCII token alphabet을 기준으로 한 provider 경계와 한국어 인접 fixture
- field/context에 묶인 UUID·ULID·commit/hash/build false-positive allowlist
- 탐지값을 복사하지 않는 class·위치 result와 payload-redacted typed failure
- raw, claim/revise 의미 문자열과 actor/branch가 공유할 하나의 pure detector surface

마스킹, draft 거부, transaction과 log/MCP 연결은 이 작업의 결과를 소비하는 후속 작업이다.

## registry와 검사 순서

[`secret-detector.ts`](../../src/domain/secret-detector.ts)의
`SECRET_DETECTOR_VERSION`은 `secret-detector-v1`이다. 다음 세 registry/config를 코드
리뷰 가능한 frozen data로 공개한다.

| 원본 | 책임 | v1 내용 |
|---|---|---|
| `SECRET_SIGNATURE_REGISTRY` | 알려진 형식 | AWS access/secret, GitHub legacy/fine-grained, GitLab, Google, Slack, Stripe, JWT, PEM private key, credential URL, password/secret assignment |
| `SECRET_ENTROPY_POLICY` | 형식 없는 token | 공백을 넘지 않는 segment의 양끝 구두점만 제거하고 내부 기호는 유지, 20 Unicode code point 이상, Shannon entropy 4.0 bits/code point 이상, 대문자·소문자·숫자·기호 중 2 class 이상 |
| `SECRET_ENTROPY_ALLOWLIST_REGISTRY` | 제한된 오탐 해제 | typed UUID/event ULID, adjacent commit/SHA/checksum/hash/build ID, typed build ID, 검증된 local Git object seam |

`detectSecretPatterns`와 `detectSecretEntropy`는 서로 독립된 test surface다.
`detectSecrets`는 항상 signature를 먼저 계산하고 entropy를 합친다. 겹치는 구간에서는
signature class가 우선하며 allowlist는 signature 결과를 지울 수 없다. 따라서 build ID나
checksum 문맥에 provider 모양 값이 있어도 provider class로 거부된다.

각 signature는 Unicode `\b`를 사용하지 않는다. 시작과 끝에서 해당 provider의 실제
ASCII alphabet을 negative lookaround로 검사한다. 한글은 그 ASCII alphabet에 속하지
않으므로 한국어 조사나 문장부호가 바로 붙어도 provider class가 유지되고, ASCII 식별자
안에 포함된 부분 문자열은 provider signature로 오인하지 않는다.

일반 assignment는 quoted JSON/object key와 `DB_PASSWORD`, `dbPassword`,
`CLIENT_SECRET`, `SECRET_KEY`, `AWS_SECRET_ACCESS_KEY` 같은 separator·camelCase
namespace를 같은 key family로 판정한다. quoted value의 escape도 구간 안에 유지한다.
credential URL은 Redis처럼 username이 비어 있는 `scheme://:password@host`도 포함한다.
완전한 PEM은 matching END marker까지, END가 잘린 PEM은 입력 끝까지 `private-key` 구간으로
반환한다. REC-003이 finding interval만 치환해도 복구 가능한 key body가 남지 않게 하는
경계다.

## entropy와 위치 단위

entropy 후보의 길이, 빈도와 Shannon score는 `Array.from(value)`의 Unicode code point로
계산한다. surrogate pair 하나를 두 문자로 세지 않는다. 문자 class도 Unicode property를
사용하되 ADR의 네 class에 없는 uncased letter 하나만으로는 random token으로 분류하지
않는다.

후보 segmentation은 Unicode whitespace를 넘지 않는 하나의 run에서 시작한다. run 양끝의
``, ; : . ' " ` ( ) [ ] { } < >``는 문장 wrapper로 제거하지만 내부의 같은 기호는 token 일부로
유지한다. 따라서 `Aa0_Bb1-Cc:2+Dd3/Ee4=` 같은 compact credential은 중간 `:`에서
쪼개지지 않고, 공백이 있는 일반 문장을 하나의 entropy 후보로 합치지도 않는다. 길이,
문자 class, allowlist와 entropy는 wrapper를 제거한 값에 순서대로 적용하고 반환 위치도
제거된 code-unit만큼 조정한다. 다만 제거한 기호까지 포함한 원래 run이 20자·4.0 bits·2 class
경계를 만족하는데 trimmed 값만 실패하면, 기호가 실제 secret 일부일 수 있으므로 원래 run을
다시 평가해 전체 위치를 보류한다. typed/adjacent allowlist가 trimmed 값에 성립하면 이 보수적
fallback도 실행하지 않는다. 이 경계는 `SECRET_ENTROPY_POLICY`의 frozen pattern source로
고정한다.

반환 위치는 의도적으로 Unicode 문자 index가 아니라 JavaScript UTF-16 code-unit의
`startCodeUnit` inclusive, `endCodeUnit` exclusive다. REC-003이 같은 원문에
`String.prototype.slice`를 직접 적용해 마스킹할 수 있는 단위다. emoji가 token 앞이나
안에 있는 fixture가 code-point entropy와 code-unit slice 위치의 차이를 고정한다.

```typescript
interface SecretFinding {
  readonly secretClass: SecretClass;
  readonly startCodeUnit: number;
  readonly endCodeUnit: number;
}

interface SecretDetectionResult {
  readonly registryVersion: "secret-detector-v1";
  readonly findings: readonly SecretFinding[];
}
```

result와 nested finding은 runtime에서도 freeze한다. finding에는 match, value, prefix,
suffix, 주변 문맥이나 entropy token을 두지 않는다. 정렬은 위치와 registry 우선순위만
사용해 locale, clock, random과 호출 순서에 의존하지 않는다. 낮은 우선순위의 assignment나
entropy 구간이 provider 구간과 겹치면 provider class를 유지하면서 위치는 합집합으로
넓혀 일부 자격 증명 문맥이 마스킹 밖에 남지 않게 한다.

## field/context와 allowlist 경계

`STORABLE_SECRET_FIELD_CONTEXTS`는 REC-002가 같은 detector로 검사할 저장 가능 문자열을
고정한다.

```text
raw_text
claim.subject / subject_kind / object / object_kind / object_value
claim.relation_label / subject_alias / object_alias
revise.note / revise.alias_surface
metadata.actor / metadata.branch
```

배열 자체가 아니라 alias 원소 각각에 해당 context를 사용한다. session 원문은 detector
입력이 아니다. ADR-003에 따라 저장 전에 HMAC correlation key로 바뀌며 원문을 보관하지
않는다. `reinterpret_approval`도 저장 문자열이 아니라 별도 constant-time capability
경계다.

allowlist는 token 모양만 보고 전역 적용하지 않는다.

- canonical UUID/ULID는 `target.*`처럼 호출자가 아니라 application이 식별자 필드로
  확정한 context에서만 허용한다.
- 7~64자리 hex는 인접한 `commit`, `sha`, `checksum`, `hash`, `build id` marker가 있거나
  해당 typed reference context일 때만 entropy에서 제외한다.
- 인접 marker는 Unicode letter/number identifier의 suffix가 아니어야 하고, hex 앞에 최소
  하나의 whitespace 또는 `:`, `=`, `#` delimiter가 있어야 한다. delimiter 다음의 괄호,
  backtick 같은 표시 wrapper는 허용한다. `uncommit <hex>`, `commit<hex>`는 allowlist가 아니다.
- `reference.build_id`는 문서화된 `bld_`/`build-` + ULID/hex 모양만 허용한다.
- `trusted.local_git_object`는 detector가 Git을 조회한다는 뜻이 아니다. STO-006/후속
  adapter가 configured local repository에서 object를 확인한 뒤 그 OID 값 일부에만 선택할
  수 있는 seam이다. `metadata.branch` 자체는 이 allowlist에 속하지 않으므로 임의 symbolic
  64-hex branch는 high-entropy hit다. STO-006이 마련한 `MetadataTextSanitizer` seam의 후속
  구현은 trusted resolver의 `detached:<oid>` 결과를 구분하고 검증된 `<oid>` substring에만
  `trusted.local_git_object` context를 적용해야 한다. detector는 Git IO나 그 검증을 하지 않는다.
- `metadata.actor`와 `metadata.branch`에는 adjacent marker allowlist도 적용하지 않는다.
  `commit.<hex>` 같은 symbolic branch가 검증된 detached OID로 승격되는 우회가 없어야 한다.
- production에서 활성인 provider signature는 어떤 context와 allowlist로도 통과하지 않는다.

이 선택은 정상 build/hash 오탐을 제한하면서 임의 random 문자열에 대한 전역 예외를 만들지
않는다. v1 signature 목록은 REC-002가 고정한 대표 provider family이며 공식 provider prefix의
완전한 최신 corpus를 주장하지 않는다. 공식 prefix 확장·갱신과 그 corpus fixture, registry
version 전환은 REL-005가 소유한다. 새로운 allowlist도 registry version과 synthetic regression
fixture를 같은 PR에서 검토한다.

## fail-closed 오류와 순수 경계

입력 타입, field context와 detector dependency가 잘못되면 `SecretDetectorError`의 고정
code/message로 거부한다. pattern compile, 후보 처리나 entropy evaluator가 예상 밖 예외를
던지면 원 cause를 연결하지 않고 `DETECTION_FAILED`로 바꾼다. 오류에는 제출 문자열,
field 값, 일부 prefix/suffix, regex match와 cause가 없다.

`createSecretDetector`의 entropy evaluator seam은 detector 내부 실패를 결정적으로 주입해
fail-closed를 검증하기 위한 pure dependency다. 기본 detector는 module 내부 Shannon
함수만 사용한다. domain source는 wall clock, process/env, filesystem/Git, network, log,
random과 database를 읽거나 쓰지 않는다. application이 typed detector 오류를 받으면 어떤
write도 시작하지 않는 연결은 REC-003이 소유한다.

## TDD와 검증

첫 RED는 production export가 없는 상태에서 target test를 실행해 다음처럼 실패했다.

```text
SyntaxError: dist/domain/index.js does not provide an export named
'SECRET_DETECTOR_VERSION'
tests 1, pass 0, fail 1
```

독립 리뷰 보강 RED는 internal punctuation 후보와 `metadata.branch`의 임의 64-hex를 먼저
fixture로 추가한 뒤 실행했다. 기존 구현은 두 경우 모두 finding을 0개 반환해 target
10개 중 8 pass, 2 fail이었다. production 수정은 공백 단위 deterministic segmentation과
`trusted.local_git_object` 전용 context 축소에만 한정했다.

root·독립 review는 다음 보안 경계를 tests-only RED로 추가했다.

- 양끝 `: ;` 또는 괄호가 secret의 기호 class인 exact-20 token: 10/11
- namespaced assignment, empty-user credential URL, complete PEM 범위와 delimiter 없는 marker:
  9/13
- escaped quoted assignment와 truncated PEM 범위: 11/13
- `SECRET_KEY`/`SECRET_ACCESS_KEY` family: 12/13

wrapper trim 뒤 18자가 되는 token은 trimmed allowlist를 먼저 존중한 뒤 원래 run을 보수적으로
재평가한다. marker는 독립 Unicode 경계와 필수 delimiter를 요구하고 actor/branch를 adjacent
allowlist에서 제외한다. assignment·URL·PEM은 masking consumer가 finding interval만으로도
전체 credential을 제거할 수 있게 범위를 넓혔다.

GREEN fixture는 다음을 확인한다.

- provider별 explicit synthetic signature family와 frozen registry
- GitHub token의 한국어 조사·emoji·문장부호 인접, ASCII identifier 내부 비매치
- entropy의 19/20 code-point, 정확히 4.0 bits, 1/2 class와 surrogate-pair 경계
- 내부 ``: , ; . ` ( ) [ ] { } < >``를 유지하고 양끝 wrapper를 제외하는 공백 단위 segmentation,
  공백 포함 일반 prose 비결합과 exact-boundary edge-symbol fallback
- 문맥 없는 high-entropy hex 거부, standalone marker+delimiter를 요구하는
  commit/SHA/checksum/hash/build·typed ID allowlist
- 임의/marker-shaped 64-hex actor·branch 거부와 검증된 OID substring 전용 trusted context seam
- quoted/namespaced/camel assignment, escaped value, empty-user credential URL과
  complete/truncated PEM의 전체 masking 범위
- raw, note, alias, kind, relation label, actor/branch를 포함한 13개 저장 context 공유
- explicit signature 우선순위, assignment/entropy overlap의 안전 구간 합집합,
  non-overlap·결정적 frozen result와 payload 부재
- invalid input/context/config 및 주입한 내부 예외의 typed·redacted fail-closed 결과

재현 명령은 다음과 같다.

```bash
pnpm verify:rec-002
pnpm test
python3 docs/roadmap/validate.py
python3 -m unittest discover -s spikes/adr-behavior -p 'test_*.py' -v
git diff --check
```

REC-002 target 13/13, 전체 빠른 suite 38개 파일 268/268과 독립 behavior oracle 25/25를
통과했다.
roadmap validator는 active 73·historical 74·evidence 67/67·ADR 17/17·scenario 24/24와
acyclic dependency를 확인했고 production dependency audit은 알려진 취약점 0개다.
독립 review의 32,768자 near-miss·unmatched PEM·다중 assignment probe는 catastrophic
backtracking을 보이지 않았다. 다만 입력 하나에 수천 개의 독립 assignment가 있으면 finding
생성과 병합 비용도 결과 수에 비례한다. schema의 입력 상한 안에서 허용하는 LOW 성능 위험이며,
REC-008 부하 fixture에서 관찰해 필요하면 request-level finding cap을 fail-closed로 추가한다.

## 후속 작업 경계

- REC-003: finding 위치를 사용한 raw 마스킹, secret draft 전체 거부와 detector 실패 시
  transaction 시작 전 호출 전체 중단
- REC-005/006: 승인 draft mapping, journal append·동기 projection과 결과 원자성
- REV-001/007: revise 의미 문자열의 전체 실패와 S18 수직 회귀
- MCP-005/REC-008: error/log/response/DB/FTS 전체 누출 scan
- REL-005: 확장 공식 provider prefix corpus와 registry 갱신, backup·권한 및 offline incident rehearsal

REC-002는 raw_text를 바꾸거나 draft를 판정하지 않고 schema, journal, logging, MCP와
Phase 08 corpus를 추가하지 않는다. Accepted ADR의 의미를 변경하지 않으므로 superseding
ADR은 필요하지 않다.
