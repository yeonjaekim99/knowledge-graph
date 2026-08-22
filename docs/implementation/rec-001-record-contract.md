# REC-001: record schema와 domain 결과 계약

- 상태: 구현·로컬 검증 완료, PR/main 병합 대기
- 결정일: 2026-08-22
- 작업: REC-001
- Owner: `log0629`
- 규범 근거: ADR-002, ADR-004, ADR-013
- 선행 구현: FND-004, PRJ-009
- 구현 branch: `rec-001-record-contract`

## production gap과 범위

ADR-013은 `MemoryRecordInput`, `ClaimDraft`, `RecordResult`의 의미와 구조 오류/부분 성공
경계를 확정했고, FND-004는 Draft 2020-12 literal에서 type과 MCP runtime validator를 만드는
단일 source를 제공했다. 그러나 실제 record DTO, trim 후 Unicode 길이, 재해석 입력 pair와
응답 index 불변식을 production 경계에서 검증하는 계약은 없었다.

REC-001은 다음만 구현한다.

- record 입력, 독립 ClaimDraft와 typed 결과의 규범 JSON Schema source
- 같은 source에서 추론한 TypeScript DTO와 기존 MCP Standard Schema validator 조합
- schema 오류와 정상적인 draft별 `rejected` 결과의 타입 경계
- 입력 draft마다 정확히 하나인 result index와 accepted status 우선순위

비밀값 탐지·마스킹, entity 해석, draft dedupe와 저장 index mapping, journal append/project,
application service와 MCP catalog/handler wiring은 각각 REC-002~006과 MCP 단계에 남긴다.

## source와 layer 경계

기능 소유 계약은 `src/application/memory-record-contract.ts`에 둔다. 이 파일은 FND-004의
`defineJsonSchema`와 `InferJsonSchema`만 사용하며 별도 interface나 validator engine을 만들지
않는다.

```text
record Draft 2020-12 source
  ├─ defineJsonSchema → frozen/canonical definition
  ├─ InferJsonSchema  → ClaimDraft/MemoryRecordInput/RecordResult
  └─ private MCP adapter contract
       ├─ createMcpJsonSchemaContract (FND-004 SDK validator 재사용)
       └─ trim code-point 방어 검증과 result index cross-check
```

package root는 DTO type만 공개한다. frozen schema definition과 validator는 application/MCP
내부 barrel에 남아 이후 REC/REV와 MCP wiring이 재사용하되 외부 package deep import는 계속
허용하지 않는다. MCP adapter 변경은 schema contract 조합뿐이며 tool catalog, description,
transport와 handler를 등록하지 않는다.

## ClaimDraft schema

비판별 XOR를 조건문으로 흩뜨리지 않고 다음 네 closed branch로 표현한다.

| 목적어 | relation | 필수 필드 | 허용되는 목적어 보조 필드 |
|---|---|---|---|
| entity | `uses/rejects/contains/describes` | `subject`, `relation`, `object` | `object_kind`, `object_aliases` |
| entity | `relates_to` | 위 필드 + `relation_label` | `object_kind`, `object_aliases` |
| literal | 정규 네 관계 | `subject`, `relation`, `object_value` | 없음 |
| literal | `relates_to` | 위 필드 + `relation_label` | 없음 |

모든 branch에 `additionalProperties:false`가 있으므로 `object`/`object_value` 동시 존재·동시
부재, literal의 `object_kind/object_aliases`, enum 밖 relation과 `relates_to` label 누락은
개별 `rejected`가 아니라 입력 전체 schema contract 오류다. subject 쪽 kind/aliases는 네
branch에서 공통이고 alias 배열은 빈 배열부터 최대 20개까지 허용한다.

## trim 후 Unicode 길이

JSON Schema `minLength/maxLength`만 쓰면 제출 원문의 앞뒤 공백도 길이에 포함되어 ADR-013의
trim 후 제한과 달라진다. 입력값을 trim해 반환하면 원문 보존도 깨진다. 따라서 각 문자열은
Unicode-aware ECMAScript whitespace와 code-point quantifier를 사용하는 anchored `pattern`으로
trim 후 1~상한을 표현하고, 상한을 명시하는 `x-recall-trimmedCodePoint*` annotation을 함께 둔다.

현재 고정 MCP SDK가 이 pattern을 Unicode code point로 실행하는 것은 boundary fixture로
검증한다. SDK 구현 편차에 대비해 private runtime contract가 반환값을 바꾸지 않은 채
`Array.from(value.trim()).length`로 같은 상한을 한 번 더 확인한다. 이 방어 검증도 submitted
문자열이나 issue payload를 보관하지 않는 `JsonSchemaValidationError`로 바뀐다.

모든 free-form input은 well-formed Unicode scalar 문자열이어야 한다. 공용 schema pattern은
unpaired surrogate를 거부하고 input structural helper는 `String.prototype.isWellFormed()`로
같은 조건을 반복한다. 따라서 `raw_text`, subject/object/object_value, 양쪽 kind와 alias,
`relation_label`의 lone high/lone low/high-high/low-high surrogate는 advertised source,
MCP Standard Schema와 validate helper에서 모두 payload-redacted 오류가 되며 valid astral pair는
한 code point로 계속 허용된다. 이 보강은 output note 계약을 바꾸지 않는다.

| 필드 | trim 후 code point | 배열 |
|---|---:|---:|
| `raw_text` | 1~32,768 | — |
| `subject`, `object`, `object_value` | 1~1,024 | — |
| `relation_label`, 각 alias | 1~256 | alias별 0~20개 |
| `subject_kind`, `object_kind` | 1~64 | — |
| `claims` | — | 0~100개 |

앞뒤 공백을 포함한 exact-bound astral-plane emoji 입력을 받아 원문 그대로 돌려주고, 한 code
point 초과와 Unicode whitespace-only 입력을 contract error로 거부한다. 일반 JSON Schema
keyword가 정확히 표현하는 enum, 배열과 고정 ID/token 길이는 그대로 사용한다.

## 일반 기록과 재해석 입력

`MemoryRecordInput`은 두 closed branch다.

- 일반 기록은 `raw_text`, `claims`, 선택 `provenance/ttl`만 받는다.
- 재해석은 위 필드와 canonical `supersedes`, `reinterpret_approval`을 둘 다 요구한다.

event ID는 `^ev_[0-7][0-9A-HJKMNP-TV-Z]{25}$`, approval token은
`^ra_[A-Za-z0-9_-]{43}$`를 먼저 검사한다. token decode/canonical padding bit, 만료,
scope/target/payload/through-seq binding과 소비는 REC-007/REL-008의 의미 검증이다.

`scope_key`, actor, branch, session, created_at과 event_id는 어느 input branch에도 없다.
모든 root가 closed이므로 caller가 이 신뢰 문맥을 주장하는 우회 입력은 형식 오류다.

## RecordResult와 의미 경계

결과 item은 두 closed branch다.

- `created`, `reinforced`, `superseded_previous`: canonical `claim_id` 필수, note 선택
- `rejected`: actionable non-empty note 필수, `claim_id` 금지

note는 오류/응답 payload의 무제한 성장을 막기 위해 trim 후 최대 2,048 code point로 고정한다.
실제 note가 비밀값이나 내부 정보를 echo하지 않는 정책은 REC-003/MCP-005가 소유한다.

Schema를 통과한 결과도 독립 output schema만으로 입력 배열과 길이를 비교할 수 없다.
`assertRecordResultIndexCoverage`는 result 수가 입력 claims 수와 같고, 각 index가
`0..claims.length-1`에 정확히 한 번 나타나는지 확인한다. 순서 자체는 강제하지 않아
application이 원래 index를 명시적으로 보존하게 한다. 이 불변식 실패는 정상적인 draft
거부가 아니라 server output contract 손상인 `RecordContractError`다.

`rejected`는 content/DB 판정 이후의 별도 branch라 accepted 상태 우선순위와 섞지 않는다.
승인 draft에는 `resolveAcceptedRecordClaimStatus`가 ADR-013 순서대로 다음을 적용한다.

```text
superseded_previous → identity가 처음 생성됐으면 created → 그 밖에는 reinforced
```

실제 projection 상태에서 두 boolean을 산출하고 duplicate 입력을 같은 claim ID에 매핑하는
책임은 REC-005/006에 남아 있다.

## type과 runtime 의미

`ClaimDraft`, `MemoryRecordInput`, `RecordClaimResult`, `RecordResult`는 각 schema source에서
`InferJsonSchema`로만 추론한다. compile fixture는 닫힌 trusted input, relation enum과
accepted/rejected result branch drift를 거부한다.

FND-004가 문서화했듯 비판별 `oneOf`의 모든 배타성을 TypeScript 구조 타입이 완전히 표현하지
못할 수 있다. 특히 supersedes pair와 목적어 XOR의 최종 신뢰 판정은 runtime schema다. 이는
손으로 쓴 보조 DTO로 type을 더 강하게 보이게 만들 이유가 아니며, runtime fixture가 pair,
XOR와 금지 필드를 모두 거부한다.

## TDD와 검증

첫 RED는 production 변경 전 `RecordContractError`와 record schema contract export를 요구했다.
build는 정상 완료되고 target test module load가 아직 없는 export에서 실패했다.

```text
SyntaxError: dist/application/index.js does not provide an export named
'RecordContractError'
tests 0, pass 0, fail 1
```

task target은 frozen/canonical source, advertised schema identity, 정상·Unicode 경계·실패
matrix, 네 ClaimDraft branch, input pair/ID, trusted metadata 금지, typed result branch,
schema/rejected 분리, index coverage와 status precedence를 검증한다.

```bash
pnpm verify:rec-001
pnpm test
python3 docs/roadmap/validate.py
python3 -m unittest discover -s spikes/adr-behavior -p 'test_*.py' -v
pnpm audit --prod
```

최종 로컬 검증은 FND-004 7/7, REC-001 11/11, 전체 빠른 suite 243/243과 독립 behavior
spike 25/25를 통과했다. roadmap audit는 active 73개/historical 74개, ADR 17/17,
scenario 24/24와 dependency cycle 0을 확인했고 production dependency audit는 알려진
취약점 0개를 반환했다.

RCL-002 독립 review 후속 tests-only RED `73645f6`은 9개 free-form input 위치의 malformed
UTF-16을 세 계약 경로가 받아 REC-001 13개 중 1개 실패, acceptance 204개임을 재현했다.
fix `2e2b22c` 뒤 REC-001 13/13, FND-004 7/7과 전체 빠른 suite 285/285를 다시 통과했다.
최초 REC-001 완료 당시의 11/11·243/243 증거는 위 역사적 수치로 보존한다.

## ADR 영향과 후속 owner

- ADR-002: canonical event/claim ID pattern을 schema에서 거부하지만 발급과 occurrence mapping은
  기존 PRJ/후속 REC 경계를 유지한다.
- ADR-004: 다섯 relation과 `relates_to` label을 closed branch로 표현한다. relation 승격이나
  의미 정규화는 하지 않는다.
- ADR-013: trim 후 bounds, 목적어 XOR, 일반/재해석 pair, 부분 성공 결과 모양과 accepted status
  우선순위를 실제 type/runtime 계약으로 닫는다.
- ADR-011: 오류가 제출값을 보관하지 않는 FND-004 경계를 유지한다. 탐지·마스킹은 구현하지
  않는다.
- ADR-016: 같은 frozen source를 Standard Schema가 광고·검증하도록 준비하지만 실제 tool
  catalog/structuredContent wiring은 MCP-003에 남긴다.

Accepted ADR 의미를 바꾸지 않으므로 superseding ADR은 필요하지 않다.
