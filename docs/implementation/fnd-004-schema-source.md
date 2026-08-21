# FND-004: public/domain schema 단일 출처

- 상태: Accepted
- 결정일: 2026-08-21
- 작업: FND-004
- Owner: `log0629`
- 규범 관계: ADR을 대체하지 않는 implementation decision

## 기존 증거와 production gap

ADR-013~016은 세 도구의 request/result 형태, 닫힌 object, `oneOf`,
`object`/`object_value` XOR, 크기 제한, `outputSchema`와 `structuredContent` 일치를
규범으로 확정했다. E-STACK은 `@modelcontextprotocol/server@2.0.0`이 raw Draft 2020-12
schema를 Standard Schema로 감싸 입력·출력을 검증할 수 있음을 확인했고, E-ARCH는
application과 MCP adapter 경계를 만들었다.

FND-004는 실제 `memory_record`/`memory_recall`/`memory_revise` 계약을 미리 만들지 않고
다음 production gap만 닫는다.

- JSON Schema, TypeScript type과 runtime validator 사이의 단일 source와 drift 정책
- 공통 schema 정책과 결정적 serialization
- MCP가 광고하는 schema와 structured result 검증에 같은 source를 넘기는 adapter seam
- 현재 Node 24·TypeScript 7 조합에서 선택한 도구의 실제 호환성

## 결론

**코드에 선언한 JSON Schema Draft 2020-12 literal이 규범 원본이다.** schema에서
TypeScript type을 추론하고, 같은 frozen schema 객체를 MCP SDK의 `fromJsonSchema`에
넘겨 runtime validator와 광고용 JSON Schema를 얻는다.

```text
JSON Schema literal (`as const`)
          │
          ├── defineJsonSchema ── 정책 검사·canonical clone·deep freeze
          │                              │
          │                              └── 결정적 schema serialization
          │
          ├── InferJsonSchema ────────────── TypeScript type
          │
          └── createMcpJsonSchemaContract ─ MCP Standard Schema
                                                    ├── input/output validation
                                                    └── advertised JSON Schema
```

schema가 규범이므로 TypeScript interface를 별도로 손으로 작성하지 않고, code-first
validator에서 JSON Schema를 사후 생성하지도 않는다. 이후 작업은 다음 형태를 사용한다.

```typescript
const definition = defineJsonSchema({
  $schema: JSON_SCHEMA_DIALECT_2020_12,
  type: "object",
  properties: { /* feature-owned contract */ },
  required: [/* ... */],
  additionalProperties: false,
} as const);

type Input = InferJsonSchema<typeof definition.schema>;
const contract = createMcpJsonSchemaContract(definition);
```

`src/schema/`는 schema source와 정책만 소유하는 내부 leaf layer다. application은 이
layer에서 feature-owned type을 가져올 수 있고 MCP adapter는 같은 정의를 Standard Schema로
바꿀 수 있다. package root에서는 이 foundation API를 export하지 않는다. 실제 공개 DTO와
package facade는 각 vertical 작업이 소유한다.

## schema 정의 정책

`defineJsonSchema`는 호출 시 source를 JSON 값으로 canonical clone한 뒤 다음을 fail closed로
검사한다.

- root는 object form이며 `$schema`가 정확히
  `https://json-schema.org/draft/2020-12/schema`다.
- `type: "object"`를 선언한 모든 중첩 schema는
  `additionalProperties: false`를 명시한다. `type` 배열에 `object`가 포함돼도 같다.
- `oneOf`는 최소 두 branch를 가진다.
- `minLength/maxLength`, `minItems/maxItems`, `minProperties/maxProperties`는 음수가 아닌
  safe integer이고 min이 max보다 크지 않다.
- `properties`, `$defs`, `oneOf`, `items`, 조건부 schema 등 안쪽 schema에도 같은 정책을
  재귀 적용한다.
- `undefined`, 비유한수, symbol key, accessor, class instance와 cycle처럼 JSON이 아닌 값은
  거부한다.

검사가 끝난 schema와 모든 자식은 freeze한다. source 객체 key 순서와 무관하게 key를
사전순으로 직렬화하고 배열 순서는 보존한다. 이는 같은 source의 byte drift를 찾기 위한
결정적 표현이지, `oneOf` branch 순서까지 의미적으로 재배열하는 JSON Schema 정규화는 아니다.

generic 정책은 keyword가 **존재할 때의 형식과 공통 불변식**을 검사한다. 특정 field에 어떤
min/max가 필수인지, `action`/`mode`별 금지 field가 무엇인지는 ADR에 따라 REC-001,
RCL-001과 REV-001의 실제 schema가 소유한다.

## type과 runtime validation

`json-schema-to-ts@3.1.1`의 type-only `FromSchema`를 `InferJsonSchema`로 감싼다. package는
exact dev dependency이고 production runtime import에는 남지 않는다. 공식 문서가 요구하는
strict TypeScript 조건과 현재 고정 조합인 Node `24.19.0`, TypeScript `7.0.2`를 별도
compile fixture로 확인했다.

JSON Schema의 모든 의미를 TypeScript 구조 타입이 완전히 표현하는 것은 아니다. 특히
비판별 `oneOf`의 배타성은 정적 union에서 근사될 수 있다. 따라서 추론 type은 중복 선언과
일반적인 drift를 없애는 개발 도구이고 **신뢰 경계의 최종 판정은 runtime JSON Schema**다.
판별 branch의 잘못된 field와 닫힌 result field는 compile fixture에서도 실패시키며,
`object`/`object_value` 동시·동시 부재를 포함한 XOR는 runtime fixture에서 반드시 거부한다.

`createMcpJsonSchemaContract`는 이미 고정된 MCP SDK의 공개 `fromJsonSchema` API를 사용한다.
SDK가 제공하는 Draft 2020-12 validator를 재사용하므로 AJV를 직접 dependency로 추가하거나
별도 옵션으로 의미를 갈라놓지 않는다. 반환 contract의 `standardSchema`가 광고와 runtime
검증의 단일 객체다. output contract로 검증한 값을 이후 handler가 `structuredContent`에
넣는 wiring은 MCP-003이 맡는다.

validator 실패는 `JsonSchemaValidationError`로 바꾸며 boundary, 고정 code와 issue 개수만
남긴다. submitted value와 SDK issue payload를 error에 보관하지 않아 secret이 error/log로
되비치는 경로를 만들지 않는다. 실제 secret 탐지·마스킹과 MCP error mapping은 각각
REC-002/003과 MCP-005에 남아 있다.

## dependency와 compatibility 결정

| 역할 | 선택 | 정책과 확인 |
|---|---|---|
| 규범 schema | JSON Schema Draft 2020-12 literal | root dialect와 공통 정책을 runtime 검사 |
| type 추론 | `json-schema-to-ts@3.1.1` | exact dev dependency, `FromSchema`, strict TS 7 compile probe |
| runtime 검증 | `@modelcontextprotocol/server@2.0.0`의 `fromJsonSchema` | 기존 exact runtime dependency, SDK 내장 Draft 2020-12 validator |
| serialization | repository의 canonical serializer | object key 정렬, array 순서 보존, frozen source |

직접 dependency는 exact version으로 고정하고 transitive integrity는 `pnpm-lock.yaml`에
남긴다. upgrade할 때는 type fixture, runtime 정상·경계·실패 matrix, advertised schema
identity와 canonical serialization golden을 함께 통과해야 한다.

## 대안

### TypeScript interface를 원본으로 두고 schema를 생성

타입 사용은 편하지만 JSON Schema가 규범이라는 ADR-016의 우선순위가 뒤집히고 generator가
표현하지 못한 keyword가 조용히 약해질 수 있다. 선택하지 않았다.

### JSON Schema와 TypeScript type을 각각 작성

도구가 적지만 두 계약이 독립적으로 바뀐다. compile drift를 자동 차단할 수 없어
`FromSchema` 추론을 선택했다.

### Zod·TypeBox 같은 code-first validator

runtime 작성 경험은 좋지만 생성된 JSON Schema가 2차 산출물이 된다. raw JSON Schema를
직접 받는 현재 MCP SDK seam이 더 작고 규범 방향과 일치한다.

### AJV를 직접 설치하고 adapter를 구성

세부 옵션 통제는 늘지만 SDK validator와 중복 dependency·dialect 설정이 생긴다. 현재
공개 API가 필요한 Draft 2020-12와 format 경로를 제공하므로 직접 의존하지 않는다. SDK
경계가 부족하다는 실제 fixture가 생길 때만 재검토한다.

### build-time code generation과 생성 파일 commit

생성 결과를 다른 언어에서도 쓸 수 있지만 이 단계에서는 generated artifact와 drift
검사 순서가 늘어난다. TypeScript type-space 추론과 runtime raw schema 공유가 더 작다.

## 범위 경계

- REC-001: `ClaimDraft`, `MemoryRecordInput`, `RecordResult` 실제 schema와 의미 validation
- RCL-001: mode별 `MemoryRecallInput`, `RecallResult` 실제 schema
- REV-001: action별 `MemoryReviseInput`, `ReviseResult` 실제 판별 union
- MCP-003: 세 tool의 catalog `inputSchema`/`outputSchema`, response serializer와 실제
  `structuredContent` wiring
- FND-005: 전체 로컬 test 계층과 schema·문서 drift 검증

FND-004 capability fixture는 foundation 선택을 검증할 뿐 제품 DTO가 아니며, production
코드에서 import하지 않는다.

## 검증

```bash
pnpm verify:fnd-004
pnpm verify:fnd-001
python3 docs/roadmap/validate.py
python3 -m unittest discover -s spikes/adr-behavior -p 'test_*.py'
```

`verify:fnd-004`는 architecture, production typecheck/build, 별도 schema type fixture,
FND-002 13개, FND-003 9개와 FND-004 7개 test를 실행한다. 새 test는 다음을 확인한다.

- source key 순서와 무관한 canonical serialization, recursive freeze와 mutation 차단
- 잘못된/missing dialect, boolean root, 열린 중첩 object, malformed `oneOf`, 역전된 bound,
  non-JSON 값과 cycle의 fail-closed 처리
- 같은 Standard Schema 객체의 advertised input/output와 runtime validation
- 닫힌 branch, `oneOf`/XOR, 문자열·배열·숫자 min/max
- output schema로 structured result를 검증하고 extra scope field를 거부
- validation error가 submitted secret이나 SDK issue payload를 보유하지 않음
- `FromSchema`가 현재 TypeScript 7에서 판별 input과 structured output을 추론하고 잘못된
  branch/result field를 compile error로 만듦

상태 전이 의미는 바꾸지 않으므로 새 behavior reducer를 만들지 않는다. 기존 25개 spike를
회귀로 실행해 Accepted ADR 의미와 충돌하지 않는지만 확인한다.

## ADR 영향 검토

- ADR-013: 닫힌 object, XOR, min/max와 typed result를 표현·검증할 foundation을 제공하되
  실제 record schema와 부분 성공 의미는 REC-001에 남긴다.
- ADR-014: input/output를 같은 source로 만들 수 있지만 recall mode/result 계약은
  RCL-001에 남긴다.
- ADR-015: 판별 `oneOf`를 지원하지만 action별 target과 결과 의미는 REV-001에 남긴다.
- ADR-016: Draft 2020-12 raw schema를 규범으로 두고 SDK가 광고·검증하는 객체를 공유한다.
  catalog 순서, description, annotation과 handler serialization은 MCP-002~004에 남긴다.
- ADR-011: validator error에 submitted value를 보관하지 않는다. journal 전 탐지·마스킹은
  아직 REC-002/003의 책임이다.

Accepted ADR 의미를 변경하지 않으므로 superseding ADR은 필요하지 않다.

## 참고

- [JSON Schema Draft 2020-12](https://json-schema.org/draft/2020-12)
- [`json-schema-to-ts` repository와 `FromSchema` 사용법](https://github.com/ThomasAribart/json-schema-to-ts)
- [MCP TypeScript SDK releases](https://github.com/modelcontextprotocol/typescript-sdk/releases)
