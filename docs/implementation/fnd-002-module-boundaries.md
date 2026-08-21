# FND-002: 제품 모듈과 의존 방향

- 상태: Accepted
- 결정일: 2026-08-21
- 작업: FND-002
- Owner: `log0629`
- 규범 관계: ADR을 대체하지 않는 implementation decision

## 결론

Recall은 하나의 private TypeScript package 안에서 domain, application, SQLite adapter,
MCP adapter, maintenance와 composition을 물리 디렉터리와 검사 가능한 import 규칙으로
분리한다. 의존 방향은 안쪽의 정책을 향하며 adapter끼리 직접 참조하지 않는다.

```text
MCP adapter ───────┐
maintenance ───────┼──> application ──> domain
                   │          ▲            ▲
SQLite adapter ────┘──────────┘────────────┘
        ▲
        └── composition만 전체를 조립
```

package root는 현재 boundary-neutral `UseCase` type만 공개한다. concrete record/recall/revise
facade가 아직 없으므로 runtime write surface를 서둘러 노출하지 않으며, domain reducer,
outbound port, adapter와 composition도 package deep import로 공개하지 않는다.

## 경계별 책임

| 경계 | 경로 | 소유 책임 | 허용 의존 |
|---|---|---|---|
| public entry | `src/index.ts` | 검증된 application facade만 선택적으로 재노출 | application |
| domain | `src/domain/` | IO 없는 reducer와 상태 전이 primitive | domain 내부만 |
| application | `src/application/` | use case orchestration과 자신이 요구하는 outbound port | application, domain |
| SQLite adapter | `src/adapters/sqlite/` | DB/worker/transaction으로 outbound port 구현 | application port, domain, `better-sqlite3` |
| MCP adapter | `src/adapters/mcp/` | MCP request/result와 application use case 사이 변환 | application, MCP SDK |
| maintenance | `src/maintenance/` | replay·reinterpret 운영 진입점 | application |
| composition | `src/composition/` | concrete adapter와 application 조립 | 모든 경계; 정책 금지 |

규칙의 기계 판독 원본은 repository root의 `architecture.config.json`이다.
`scripts/check-module-boundaries.mjs`가 모든 production TypeScript의 static import, export,
dynamic import와 `require()`를 검사한다. 선언되지 않은 layer, 역방향 의존, 허용하지 않은
external package, `src` 밖 상대 import와 `spikes/adr-behavior` import는 실패한다.

TypeScript 7의 안정 package entry는 compiler AST API를 제공하지 않는다. guard는 exact-pin된
`typescript@7.0.2`의 exported `typescript/unstable/ast` scanner로 주석과 문자열을 구분해
module specifier를 읽는다. TypeScript upgrade PR은 architecture test를 반드시 다시 실행하며,
scanner export가 바뀌면 upgrade와 같은 PR에서 guard를 교체한다.

## 쓰기 경계

application이 사용할 수 있는 outbound write port는 다음 한 메서드뿐이다.

```typescript
interface JournalCommitPort<Intent, Receipt> {
  appendAndProject(events: NonEmptyReadonlyArray<Intent>): Promise<Receipt>;
}
```

`ProjectionWriter`, raw database handle 또는 projection-only method는 public/application
surface에 두지 않는다. 구체적인 record/revise/reinterpret 쓰기 흐름은 다음과 같다.

```text
MCP 또는 maintenance 요청
  → application service
  → JournalCommitPort.appendAndProject(non-empty batch)
  → SQLite adapter의 단일 atomic executor
       journal INSERT → 같은 reducer로 projection 적용 → COMMIT
```

application service는 빈 batch를 port 호출 전에 거부하고 adapter 실패를 별도 write로
보상하지 않는다. 실제 SQLite adapter는 ADR-001/007에 따라 journal append와 projection을
한 transaction에서 수행해야 한다. 전체 replay가 필요한 사건인지 판단하고 구체 transaction을
구현하는 일은 STO-007과 PRJ-009가 소유한다.

`better-sqlite3`의 동기 실행은 SQLite adapter 뒤에 숨기고 application port는 비동기
`Promise` 계약을 유지한다. MCP event loop에 raw connection이나 동기 query API를 노출하지
않는다. 전용 worker, connection factory와 serialized writer queue의 concrete 구현은
STO-002에서 확정한다.

## 읽기와 운영 경계

- MCP adapter는 application use case만 받아 tool transport로 변환한다. SQLite adapter나
  domain reducer를 직접 호출하지 않는다.
- maintenance도 application operation을 통해 replay와 reinterpret candidate 조회를
  요청한다. DB와 projector handle을 직접 받지 않는다.
- full replay는 journal을 추가하지 않고 projection을 재생성하는 유일한 내부 경로다.
  PRJ-009가 projector-owned rebuild port를 추가하더라도 root와 MCP에는 export하지 않고
  maintenance application service를 통해서만 호출한다. 이는 사용자 요청이 projection을
  직접 고치는 경로가 아니라 기존 journal을 다시 적용하는 ADR-001의 파생 상태 관리다.
- application read service와 query port의 구체 계약은 RCL-001 이후에 추가한다. 이 작업은
  미래 public schema를 `unknown` DTO로 미리 고정하지 않는다.
- composition은 wiring만 수행한다. scope 결정, validation, transaction 정책과 상태 전이를
  넣지 않는다.

## pure reducer 경계

`src/domain/reducer.ts`의 `reduceEvents`는 초기 상태, 순서가 정해진 event 배열과 reducer
함수만 받는다. clock, random, filesystem, network, SQLite나 MCP를 import하지 않는다.
FND-002 fixture는 frozen 입력으로 두 번 실행한 결과가 같고 원본 입력이 바뀌지 않음을
adapter 없이 확인한다.

이 함수는 실제 statement/merge/retraction 의미를 아직 구현하지 않는다. 구체 event 타입,
ID/clock/scope context는 FND-003, schema source는 FND-004, projector 상태 전이와 replay
parity는 PRJ-001~010이 소유한다. behavior spike 코드를 production 출발점으로 복사하거나
import하지 않는다.

## build와 공개 surface

- `tsconfig.json`은 NodeNext ESM, ES2024, strict, exact optional property,
  unchecked index와 isolated declaration/erasable syntax 검사를 켠다.
- source의 상대 import는 emitted ESM과 같은 `.js` specifier를 쓴다.
- `package.json#exports`는 `.` 하나만 제공하며 `dist/index.js`와 declaration만 가리킨다.
- root에는 runtime export가 없고 boundary-neutral `UseCase` type만 있다. 내부
  `JournalWriteService`의 constructor와 commit port가 package API로 노출되지 않는다.
- `dist/`는 재생성 가능한 build output이라 commit하지 않는다.

FND-004가 규범 request/result schema를 정하고 실제 record/recall/revise use case가 생기면
root export를 그 application facade로 교체한다. private port와 adapter를 export하는 변경은
architecture guard가 차단한다.

## 대안

### 기능별 package를 즉시 여러 workspace로 분리

package manager가 경계를 강제한다는 장점이 있지만 아직 각 기능의 코드량과 독립 배포
필요가 없다. 단일 package의 명시적 layer와 import guard가 더 작은 시작점이며, 실제
순환이나 독립 release 필요가 생기면 workspace 분리를 후속 결정으로 다룬다.

### application에 journal port와 projection port를 따로 제공

테스트 mock은 단순하지만 application 또는 새 adapter가 projection만 갱신하는 경로를
만들 수 있다. ADR-001의 핵심 불변식을 interface 모양으로 강제하기 위해 선택하지 않았다.

### MCP adapter가 SQLite repository를 직접 호출

초기 wiring은 짧아지지만 transport가 transaction, scope와 replay 정책을 소유하게 된다.
다른 client와 maintenance가 같은 정책을 재사용할 수 없어 선택하지 않았다.

### behavior spike를 production reducer package로 승격

검증된 상태 전이를 빠르게 재사용할 수 있지만 Python reference와 production TypeScript가
결합되고 독립 oracle을 잃는다. spike는 black-box 비교 기준으로만 유지한다.

## 검증

```bash
pnpm verify:fnd-002
python3 docs/roadmap/validate.py
python3 -m unittest discover -s spikes/adr-behavior -p 'test_*.py'
```

`verify:fnd-002`는 architecture guard, strict typecheck, build와 Node test를 순서대로 실행한다.
현재 12개 test가 다음 경계를 확인한다.

- 정상: pure reducer 결정성, atomic write 위임, SQLite adapter 단일 surface, 허용 import graph
- 경계: 빈 event batch 사전 거부, package root runtime surface와 deep import 제한
- 실패: adapter transaction 오류 전파, domain의 application 역참조, spike import, private port
  re-export와 projection-only write capability 차단

이 작업은 상태 의미를 추가하지 않으므로 behavior spike와 결과 parity를 새로 복제하지 않고
기존 25개 regression을 그대로 실행해 불변식 문서와 충돌이 없는지만 확인한다.

## ADR 영향 검토

- ADR-001: projection-only public path를 제거하고 append/project atomic boundary를 둬 결정과
  일치한다.
- ADR-007: 증분과 전체 replay가 같은 reducer를 공유할 수 있는 pure domain seam을 둔다.
- ADR-016: MCP adapter가 application만 보며 public tool/schema 구현은 MCP phase에 남긴다.

Accepted ADR의 의미를 바꾸지 않으므로 superseding ADR은 필요하지 않다.
