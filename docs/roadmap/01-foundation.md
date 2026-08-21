# Phase 01 — 개발 기반과 구현 결정

- 상태: `TODO`
- 진행률: 0/7
- 선행 phase: Phase 00 `DONE`
- 주요 근거: 전체 ADR, 특히 ADR-001, ADR-003, ADR-005, ADR-016
- 선행 증거 감사: [Phase 01 baseline과 production gap](evidence-audit.md#phase-01-foundation)
- 종료 조건: 선택한 production stack에서 빈 server·DB bootstrap·CI가 재현 가능하고
  spike를 import하지 않는 제품 모듈 경계가 확정됨

> evidence audit의 `[x]`는 기존 증거 대조 완료다. 아래 작업의 `TODO/DONE`과 production
> 완료 체크를 대신하지 않는다.

## 작업 현황

| ID | 작업 | 상태 | Owner | 선행 작업 | 증거 |
|---|---|---|---|---|---|
| FND-001 | production 기술 스택 결정 | `TODO` | `unassigned` | RDY-007 | — |
| FND-002 | 제품 모듈과 의존 방향 설계 | `TODO` | `unassigned` | FND-001 | — |
| FND-003 | 결정적 runtime 경계 추상화 | `TODO` | `unassigned` | FND-002 | — |
| FND-004 | public/domain schema 단일 출처 결정 | `TODO` | `unassigned` | FND-001, FND-002 | — |
| FND-005 | 테스트 계층과 oracle 전략 구축 | `TODO` | `unassigned` | FND-002 | — |
| FND-006 | CI와 repository 품질 gate 구축 | `TODO` | `unassigned` | FND-001, FND-005 | — |
| FND-007 | 개발자 bootstrap과 기여 문서 | `TODO` | `unassigned` | FND-001~006 | — |

## 상세 체크리스트

### FND-001 — production 기술 스택 결정

- 상태: `TODO`
- Owner: `unassigned`
- 근거: ADR-005, ADR-016과 spike의 implementation decision
- 선행 작업: RDY-007
- 결과물: runtime, package manager, SQLite driver, MCP SDK와 지원 버전을 기록한 결정 문서

완료 체크:

- [ ] 선택한 production MCP SDK의 실제 API에서 MCP `2026-07-28`, JSON Schema 2020-12와
      structuredContent 지원 여부를 확인했다.
- [ ] 선택한 production SQLite driver/runtime 조합에서 FTS5 trigram, JSON 함수,
      `unixepoch()`, WAL과 transaction 제어를 확인했다.
- [ ] native dependency 배포 방식과 지원 OS/runtime 범위를 명시했다.
- [ ] 대안, 선택 이유, upgrade 책임과 lockfile 정책을 팀이 리뷰했다.
- [ ] 선택이 Accepted ADR 의미를 바꾸면 별도 ADR을 먼저 작성했다.

### FND-002 — 제품 모듈과 의존 방향 설계

- 상태: `TODO`
- Owner: `unassigned`
- 근거: ADR-001, ADR-007, ADR-016
- 선행 작업: FND-001
- 결과물: source/package 구조와 dependency rule

완료 체크:

- [ ] domain reducer, application service, SQLite adapter, MCP adapter와 maintenance 경계를 분리했다.
- [ ] journal을 쓰지 않고 projection을 변경할 수 있는 public 경로가 없다.
- [ ] `spikes/adr-behavior`를 production source에서 import하지 않는 검사가 있다.
- [ ] adapter 없이 pure reducer를 fixture로 실행할 수 있다.

### FND-003 — 결정적 runtime 경계 추상화

- 상태: `TODO`
- Owner: `unassigned`
- 근거: ADR-001, ADR-002, ADR-003, ADR-010, ADR-017
- 선행 작업: FND-002
- 결과물: clock, ULID/CSPRNG, rules version, scope와 metadata provider interface

완료 체크:

- [ ] reducer 안에서 wall clock, network, LLM과 git 조회를 호출하지 않는다.
- [ ] 테스트가 clock, event ID, approval token과 `evaluation_now`를 주입할 수 있다.
- [ ] scope와 actor/branch/session 입력 경계가 tool argument와 분리됐다.
- [ ] production provider와 deterministic test provider 계약이 같다.

### FND-004 — public/domain schema 단일 출처 결정

- 상태: `TODO`
- Owner: `unassigned`
- 근거: ADR-013~016
- 선행 작업: FND-001, FND-002
- 결과물: 타입과 JSON Schema 생성·검증 정책

완료 체크:

- [ ] JSON Schema가 규범이며 runtime type과 drift를 검사한다.
- [ ] 모든 object의 `additionalProperties:false`, union `oneOf`와 min/max를 표현할 수 있다.
- [ ] outputSchema와 structured result를 같은 source에서 검증할 수 있다.
- [ ] schema serialization이 결정적이다.

### FND-005 — 테스트 계층과 oracle 전략 구축

- 상태: `TODO`
- Owner: `unassigned`
- 근거: ADR 전체 Validation, [spike report](../spikes/adr-behavior-report.md)
- 선행 작업: FND-002
- 결과물: unit/integration/contract/e2e/performance test 구조

완료 체크:

- [ ] S01~S24를 production black-box fixture로 옮기는 방법을 문서화했다.
- [ ] incremental prefix와 full replay oracle의 canonical dump 비교 helper가 있다.
- [ ] 실제 SQLite file, process crash와 MCP contract test를 별도 계층으로 구분했다.
- [ ] 고정 seed·clock·locale로 실패를 재현할 수 있다.

### FND-006 — CI와 repository 품질 gate 구축

- 상태: `TODO`
- Owner: `unassigned`
- 근거: ADR review release gate
- 선행 작업: FND-001, FND-005
- 결과물: PR 필수 CI workflow

완료 체크:

- [ ] format, lint, typecheck, unit와 SQLite integration test가 PR에서 실행된다.
- [ ] 선택한 최소/현재 runtime과 SQLite capability smoke test를 실행한다.
- [ ] schema·roadmap·문서 링크 drift 검사가 실패를 차단한다.
- [ ] 실제 secret이나 DB artifact가 commit되지 않도록 검사한다.

### FND-007 — 개발자 bootstrap과 기여 문서

- 상태: `TODO`
- Owner: `unassigned`
- 근거: 협업 운영 요구
- 선행 작업: FND-001~006
- 결과물: setup, test, branch/PR, roadmap 갱신 가이드

완료 체크:

- [ ] 깨끗한 checkout에서 설치와 전체 빠른 test가 한 문서대로 성공한다.
- [ ] local DB가 repository 밖 또는 ignore된 안전한 경로에 생성된다.
- [ ] task owner/status/evidence 갱신 예시가 있다.
- [ ] 지원하지 않는 network filesystem·다중 writer 구성을 명시한다.

## Phase 종료 체크

- [ ] 기술 선택 문서가 병합됐다.
- [ ] 빈 production package와 CI가 깨끗한 환경에서 통과한다.
- [ ] 제품 코드가 spike 구현을 import하지 않는다.
- [ ] Phase 02 작업자가 DB·scope·writer interface를 구현할 수 있다.
