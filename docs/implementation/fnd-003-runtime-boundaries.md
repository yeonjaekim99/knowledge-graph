# FND-003: 결정적 runtime 경계

- 상태: Accepted
- 결정일: 2026-08-21
- 작업: FND-003
- Owner: `log0629`
- 규범 관계: ADR을 대체하지 않는 implementation decision

## 기존 증거와 production gap

behavior spike의 S02/S09/S14~S16/S23은 고정 clock, ID, scope와 `evaluation_now`를 사용해
재생 결정성, scope 격리, 재해석 순서와 approval 만료 의미가 함께 성립함을 확인했다.
FND-002의 E-ARCH는 adapter 없는 pure reducer와 안쪽을 향하는 의존 방향을 만들었다.

FND-003은 이 의미 검증을 반복하지 않는다. production에 남아 있던 다음 gate만 닫는다.

- application이 wall clock, random, git이나 transport 전용 문맥을 직접 조회하지 않는 port
- Node production runtime에서 사용할 clock·CSPRNG ID/token과 scope·metadata port 조립
- 같은 application 계약을 사용하는 deterministic test provider
- domain source에서 ambient runtime 접근을 막는 자동 검사

## 결론

application에는 요청마다 새로 만드는 `RuntimeProvider` 하나만 주입한다.

```typescript
interface RuntimeProvider {
  capture(): Promise<RuntimeSnapshot>;
  nextEventId(): EventId;
  nextApprovalToken(): ReinterpretApprovalToken;
}
```

`capture()`는 인자를 받지 않는다. scope와 metadata의 원천은 provider 생성 전에 이미
서버 시작 설정과 인증된 host context에 묶인다. tool request DTO가 이 인터페이스를 통해
`user_id`, `project_id`, `scope_key`, actor, branch나 session을 전달할 수 없다.

```text
STO-005 scope adapter       STO-006 metadata adapter
  deployment/principal       client/Git/session context
           │                          │
           └─────────────┬────────────┘
                         ▼
          FND-003 Node runtime composition
            clock · entropy · rules version
                         │ request-scoped RuntimeProvider
                         ▼
                   application
                         │ explicit snapshot/event
                         ▼
                 pure domain reducer
```

provider는 한 요청에서만 사용하고 요청 사이에 재사용하지 않는다. `capture()`의 Promise와
결과를 내부에 캐시하므로 동시에 여러 번 불러도 clock, scope, rules version과 metadata를
한 번만 읽는다. application use case는 시작할 때 한 번 capture한 뒤 다음 값을 사용한다.

```typescript
interface RuntimeSnapshot {
  recordedAt: number;       // UTC Unix epoch seconds
  evaluationNow: number;    // 같은 capture의 고정 시각
  rulesVersion: string;
  scope: { userId: string; projectId: string; scopeKey: string };
  metadata: { actor: string | null; branch: string | null; session: string | null };
}
```

현재 `recordedAt`과 `evaluationNow`는 같은 millisecond clock 값을 초 단위로 내림해 만든다.
write는 전자를 `journal.created_at` 후보로, recall과 replay 회귀 비교는 후자를 고정
`:now`로 사용한다. 실제 use case 연결은 각 REC/RCL/PRJ 작업이 소유한다.

## port 구성

`src/application/ports/runtime-provider.ts`가 다음 leaf contract와 합성된
`RuntimeProvider`를 정의한다.

| port | 책임 |
|---|---|
| `RuntimeClock` | UTC epoch milliseconds 한 값을 반환 |
| `RandomBytesProvider` | 요청한 길이의 CSPRNG byte 반환 |
| `EventIdProvider` | canonical `ev_` ULID 발급 |
| `ApprovalTokenProvider` | canonical 256-bit `ra_` token 발급 |
| `RulesVersionProvider` | 현재 서버 rules version 반환 |
| `ScopeProvider` | 이미 신뢰 문맥에 묶인 user/project/scope 반환 |
| `MetadataProvider` | 이미 신뢰 문맥에 묶인 nullable actor/branch/session 반환 |

`createRuntimeProvider`는 leaf 결과를 그대로 믿지 않고 application 경계에서 다시 검증한다.
잘못된 clock, ID, approval token, rules version, scope-key 조합이나 session correlation 형식은
typed `RuntimeBoundaryError`로 fail closed한다. 반환 snapshot과 하위 scope/metadata는
freeze한다.

이 port와 factory는 package root에서 export하지 않는다. FND-004가 공개 schema와 facade를
정할 때도 tool input에는 runtime 문맥 필드를 추가하지 않는다.

## production provider

`src/adapters/runtime/`은 Node 24용 구현을 제공한다. Node 내장 API의 정확한 타입 검사를
위해 지원 runtime major와 같은 `@types/node@24.13.3`을 dev dependency로 exact pin한다.

### 시간, event ID와 approval token

- system clock은 `Date.now()`를 runtime adapter 안에서만 호출한다.
- event ID는 48-bit millisecond timestamp와 CSPRNG 80 bit를 Crockford Base32 26자로
  인코딩하고 `ev_`를 붙인다.
- ULID 첫 문자는 128-bit canonical 범위인 `0`~`7`이고 대문자 alphabet만 사용한다.
- ULID timestamp는 uniqueness 입력일 뿐 replay 순서가 아니다. DB 순서는 계속
  `journal.seq`만 사용하고 UNIQUE 충돌 재시도는 STO-007이 소유한다.
- approval token은 CSPRNG 32 byte를 padding 없는 canonical base64url 43자로 인코딩하고
  `ra_`를 붙인다. application 검증은 마지막 padding bit까지 canonical인지 확인한다.

FND-003은 approval token **생성**만 소유한다. scope/target/payload/through-seq binding,
constant-time 비교, process-memory 보관, 15분 만료, 성공 후 소비와 rollback 재시도는
ADR-017에 따라 REC-007/REL-008에서 구현한다. 이 단계에는 token을 log하거나 journal에
기록하는 경로가 없다.

### scope와 metadata 소유권 경계

FND-003은 인자 없는 `ScopeProvider.resolveScope()`와
`MetadataProvider.resolveMetadata()` 계약 및 그 결과의 application 경계 검증만 소유한다.
`createNodeRuntimeProvider`는 이미 요청 문맥에 묶인 두 provider를 필수 입력으로 받아
production clock·entropy·rules version과 합성한다. 따라서 tool DTO 값을 받는 우회 경로가
없고, 구체적인 신뢰 원천을 이 foundation 작업이 선점하지도 않는다.

- STO-005는 immutable project 설정, 인증 principal, 명시적 local fallback과 identity 부재 시
  fail-closed 동작을 구현한다.
- STO-006은 actor 정리, symbolic/detached/non-Git branch, session HMAC, metadata 조회 실패의
  nullable downgrade를 구현한다.
- MCP-006은 실제 transport의 인증·client·session context를 해당 adapter에 연결하되 tool
  arguments를 섞지 않는다.
- REC-002/MCP-005는 journal INSERT 전에 actor/branch를 포함한 비밀값 탐지와 안전한
  log/error 처리를 구현한다.

application 경계는 두 adapter의 결과를 다시 검사한다. user/project는
`[A-Za-z0-9._-]{1,64}`, `scopeKey`는 정확히 `u:{user_id}/p:{project_id}`여야 한다.
actor와 branch에는 제어문자가 없어야 하고 session은 NULL 또는
`hmac-sha256:<64 lowercase hex>`만 허용한다. 이 검증은 신뢰 원천을 구현하는 것이 아니라
나중 adapter의 오구성이나 계약 위반을 fail closed하는 방어선이다.

## deterministic test provider

`test/support/deterministic-runtime-provider.mjs`는 production과 같은
`createRuntimeProvider` factory를 사용한다. 차이는 leaf dependency뿐이다.

- 고정 millisecond clock으로 `recordedAt/evaluationNow`를 주입한다.
- canonical event ID와 approval token queue를 순서대로 소비한다.
- 고정 rules version, scope와 nullable metadata를 반환한다.
- queue가 소진되면 임의 값을 만들지 않고 즉시 실패한다.

따라서 production/test가 비슷하게 생긴 별도 facade를 갖는 것이 아니라, 동일 application
contract와 검증 경로를 실제로 공유한다. FND-005는 이 fixture를 전체 test 계층에서
재사용하거나 이동할 수 있지만 계약 의미를 복제하지 않는다.

## reducer purity guard

기존 layer import 제한에 더해 `architecture.config.json` version 2가 domain의 ambient
runtime identifier를 금지한다.

- clock/timer: `Date`, `Temporal`, `performance`, `setTimeout`, `setInterval`
- network/host: `fetch`, `WebSocket`, `EventSource`, `navigator`, `globalThis`
- process/runtime: `process`, `Bun`, `Deno`
- random: `crypto`, `Math.random`

domain은 원래부터 external package를 import할 수 없으므로 LLM SDK, Node Git/process와
network package도 허용되지 않는다. reducer 입력은 계속 state와 event뿐이다. 검사기는
주석과 string literal을 identifier로 오인하지 않으며 실제 production source와 실패
fixture를 함께 검사한다.

## 대안

### application service가 `Date.now()`와 `randomBytes()`를 직접 호출

파일 수는 줄지만 테스트가 wall clock과 entropy에 의존하고 replay/report 입력 경계가
흐려진다. leaf port와 request snapshot을 선택했다.

### tool input에 scope와 metadata를 포함

transport mapping은 단순하지만 agent가 격리와 감사 문맥을 주장하게 된다. provider를
server configuration과 authenticated host context에 미리 묶고 application method에서
인자를 제거했다.

### UUID를 event ID로 사용하거나 ULID로 replay 순서를 정함

첫 선택은 ADR-002의 공개 형식과 다르고, 두 번째는 `journal.seq` 단일 순서 규칙을
위반한다. canonical ULID를 발급하되 순서 의미는 부여하지 않는다.

### 후속 metadata adapter가 raw session ID를 반환

bearer나 transport secret이 불변 journal에 남을 수 있다. 그래서 FND-003 계약은 raw 값을
거부하고 HMAC correlation 형식만 허용하며, 구체 변환과 key 관리는 STO-006이 맡는다.

### production provider를 test에서 monkey-patch

전역 clock/random과 Git process를 오염시키고 병렬 test가 비결정적이 된다. 같은 factory에
명시적인 deterministic leaf를 주입한다.

## 검증

```bash
pnpm verify:fnd-003
pnpm verify:fnd-001
python3 docs/roadmap/validate.py
python3 -m unittest discover -s spikes/adr-behavior -p 'test_*.py'
```

`verify:fnd-003`은 architecture, strict typecheck, production build, FND-002 회귀 13개와
FND-003 정상·경계·실패 test 9개를 실행한다. 새 test는 다음을 확인한다.

- deterministic clock/ID/token/rules/scope/metadata 주입과 frozen snapshot
- production/test provider의 동일한 인자 없는 surface
- 미리 묶인 scope/metadata provider와 production clock/CSPRNG의 request-scoped 합성
- ULID timestamp와 approval token canonical encoding
- 동시 capture에서도 한 번만 읽는 clock과 고정 `evaluationNow`
- 잘못된 clock/ID/token/scope/session/rules와 entropy 길이의 fail-closed 처리
- domain의 ambient clock/random/network/process/global 접근 차단과 주석·문자열 비오탐

상태 전이 의미는 바꾸지 않으므로 새 Python reducer를 만들지 않는다. 기존 behavior spike
25개를 회귀로 실행해 같은 불변식과 충돌이 없는지만 확인한다.

## ADR 영향 검토

- ADR-001/017: reducer 밖에서 clock/rules를 공급하고 한 요청의 시각을 고정하므로 replay와
  recall이 ambient runtime에 의존하지 않는다.
- ADR-002: canonical `ev_` ULID를 서버 adapter가 발급하며 seq 순서와 분리한다.
- ADR-003: scope/metadata를 tool argument 없는 provider 결과로 받고 계약을 검증한다. 구체적인
  principal/project와 actor/Git/HMAC 원천은 STO-005/006에 남긴다.
- ADR-010: `evaluationNow`를 한 번 캡처해 호출 전체 aggregate가 같은 시각을 사용할 수 있다.

Accepted ADR 의미를 변경하지 않으므로 superseding ADR은 필요하지 않다.
