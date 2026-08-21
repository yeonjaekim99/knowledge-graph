# FND-001: production 기술 스택 결정

- 상태: Accepted
- 결정일: 2026-08-21
- 작업: FND-001
- Owner: `log0629`
- 규범 관계: ADR을 대체하지 않는 implementation decision

## 결론

Recall v1은 TypeScript ESM 애플리케이션으로 작성하고 Node.js 24 LTS에서 실행한다.
패키지는 pnpm으로 고정하며 SQLite에는 `better-sqlite3`, MCP에는 공식 TypeScript SDK v2의
server package를 사용한다.

| 영역 | 선택 | 지원 범위 |
|---|---|---|
| 언어 | TypeScript `7.0.2` | strict ESM으로 compile; 구체 compiler 설정은 FND-002/FND-004에서 고정 |
| runtime | Node.js `24.19.0` 기준, `>=24.19.0 <25` | Node 24 LTS patch만 지원 |
| package manager | pnpm `11.22.0` | `packageManager`와 lockfile로 exact pin |
| MCP SDK | `@modelcontextprotocol/server@2.0.0` | 공식 v2 stable, MCP `2026-07-28` |
| SQLite driver | `better-sqlite3@13.0.3` | bundled SQLite `3.53.4`를 검증 |

직접 dependency는 range 없이 exact version으로 선언하고 `pnpm-lock.yaml`을 commit한다.
설치와 필수 로컬 검증은 `pnpm install --frozen-lockfile`을 사용한다. lockfile 변경은
dependency upgrade PR에서만 허용한다.

## 선택 이유

- MCP의 규범 타입이 TypeScript로 제공되고 공식 SDK의 high-level `McpServer`가 input/output
  schema 검증과 `structuredContent`를 함께 처리한다.
- Node 24는 현재 LTS다. Node 26 Current나 EOL runtime을 production 지원 범위에 넣지 않는다.
- `better-sqlite3`의 동기 transaction API는 ADR-005의 프로세스 내부 단일 writer queue와
  transaction 경계를 명시적으로 표현하기 쉽다.
- driver가 SQLite를 함께 배포하므로 OS의 SQLite build option에 따라 FTS5/JSON 지원이
  달라지는 위험을 줄인다.
- v13.0.3 package에는 지원 target의 prebuilt native binary가 모두 들어 있고 lifecycle
  build는 pnpm의 `allowBuilds`에서 명시적으로 거부한다. 지원 target에서는 사용자 머신의
  compiler에 의존하지 않는다.

동기 driver가 MCP event loop를 장시간 막지 않도록 하는 connection/worker 경계는
FND-002와 STO-002가 소유한다. 이 결정은 “모든 DB 작업을 main thread에서 실행한다”는
뜻이 아니다.

## 실행 검증

다음 명령이 선택한 package의 실제 API와 binary를 검사한다.

```bash
pnpm install --frozen-lockfile
pnpm verify:fnd-001
```

2026-08-21 Linux x64/glibc 2.39에서 Node `24.19.0`으로 실행한 결과는 다음과 같다.

| 경계 | 확인 결과 |
|---|---|
| MCP revision | modern `server/discover`가 `supportedVersions=["2026-07-28"]` 반환 |
| MCP JSON Schema | `tools/list`의 input/output가 draft 2020-12 `$schema`와 `additionalProperties:false` 유지 |
| MCP result | `tools/call`이 text `content`와 동일 의미의 `structuredContent` 반환 |
| MCP entry | `createMcpHandler`, `McpServer`, `fromJsonSchema`, `serveStdio` public API 확인 |
| SQLite capability | FTS5 + trigram, JSON, `unixepoch()` 통과 |
| SQLite file mode | writer가 WAL 설정, readonly reader가 WAL과 committed row 확인 |
| transaction | intentional throw rollback과 commit, `inTransaction` 경계 확인 |
| bundled SQLite | `3.53.4` |
| production install | `pnpm install --prod --frozen-lockfile` 후 MCP server와 SQLite driver load 통과 |

SDK v2는 2025 계열 legacy와 2026 modern wire를 함께 제공한다. public
`LATEST_PROTOCOL_VERSION` 상수는 legacy 기본값을 나타내므로 modern 지원 판정에 쓰지
않는다. Recall은 실제 modern `server/discover`와 요청 envelope를 contract test한다.

probe는 compatibility 증거일 뿐 production MCP tool이나 storage 구현이 아니다. JSON
Schema의 단일 source와 TypeScript type 생성 정책은 FND-004, 실제 transport lifecycle은
MCP-001이 결정한다.

## native dependency 배포

지원 matrix는 package에 포함된 다음 prebuild와 Node 24 LTS의 교집합이다.

| OS | architecture | libc | 지원 |
|---|---|---|---|
| Linux | x64, arm64 | glibc | 지원 |
| Linux | x64, arm64 | musl | 지원 |
| macOS | x64, arm64 | system | 지원 |
| Windows | x64, arm64 | system | 지원 |

release artifact는 각 target runner에서 `pnpm install --prod --frozen-lockfile`로 만들고 다른
OS에서 만든 `node_modules`를 복사하지 않는다. `better-sqlite3/prebuilds`의 대상 binary를
그대로 포함하며 `allowBuilds: false`로 source build를 실행하지 않고 단일 JavaScript
bundle 안에 native addon을 넣지 않는다. x86 32-bit,
FreeBSD와 표에 없는 target은 v1 지원 밖이며 source compile로 조용히 우회하지 않고 설치
또는 startup을 실패시킨다. DB 파일은 ADR-005에 따라 local filesystem에만 둔다.

FND-005의 로컬 foundation suite는 최소 Linux x64에서 stack probe를 재현하고, release
packaging을 다루는 REL-009는 지원 OS/architecture별 설치·기동을 다시 검증한다.

## 대안

### Node 내장 `node:sqlite`

Node 24.19.0의 실제 API에서 SQLite 3.53.3, FTS5 trigram, JSON, `unixepoch()`, WAL과
transaction 제어가 모두 동작했다. 그러나 Node 24 문서에서 module 상태가 아직 release
candidate이고 synchronous API만 제공하므로 v1 production driver로 선택하지 않았다.
stable 전환 뒤 같은 probe와 성능 비교를 통과하면 native dependency 제거 후보로
재검토한다.

### Python과 표준 `sqlite3`

behavior spike의 실행 수단으로 이미 유효하지만 system SQLite build에 따라 capability가
달라지고, 공식 MCP 계약과 domain type을 별도 언어 경계 없이 공유한다는 장점이
TypeScript 조합보다 작다. spike가 Python인 사실은 production 선택 근거로 사용하지 않았다.

### Go와 공식 MCP Go SDK

단일 binary 배포는 장점이지만 JSON Schema/domain type 생성과 SQLite binding 선택을 위한
추가 경계가 필요하다. v1의 MCP SDK·schema 중심 작업량에는 TypeScript 조합이 더 작다.

### `sqlite3` 계열 비동기 Node driver

event loop 비차단은 장점이지만 callback/connection affinity와 여러 SQL을 묶는 transaction
경계가 더 복잡하다. Recall은 단일 writer와 명시적 transaction을 우선하고, 긴 DB 작업은
adapter/worker 경계에서 격리한다.

## upgrade 책임과 정책

- dependency/runtime upgrade의 현재 책임자는 repository maintainer `log0629`다.
- Node patch와 보안 release는 전용 PR에서 `.node-version`, engine 범위와 실행 증거를 함께
  갱신한다. Node major는 지원 matrix와 전체 검증을 다시 리뷰한다.
- MCP SDK 변경은 modern discover/list/call probe, ADR-016 schema/annotation 계약과 향후
  MCP contract suite를 통과해야 한다. protocol 의미가 바뀌면 먼저 superseding ADR을 쓴다.
- `better-sqlite3` 변경은 bundled SQLite version, prebuild matrix, capability/WAL/transaction
  probe와 behavior spike를 다시 실행한다.
- pnpm, TypeScript와 모든 direct dependency는 exact version을 유지한다. 자동 range
  update를 허용하지 않고 lockfile diff와 release note를 사람이 리뷰한다.

## ADR 영향 검토

선택한 stack은 ADR-005의 SQLite capability·WAL·단일 writer 요구와 ADR-016의 MCP
`2026-07-28`·JSON Schema 2020-12·structured result 계약을 그대로 구현할 수 있다. Accepted
ADR의 의미를 바꾸는 항목은 없어 새 ADR이 필요하지 않다.

## 참고

- [Node.js release status](https://nodejs.org/en/about/previous-releases)
- [Node.js 24 SQLite API](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html)
- [MCP 2026-07-28 Tools specification](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
- [Official MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3)
- [pnpm](https://pnpm.io/)
