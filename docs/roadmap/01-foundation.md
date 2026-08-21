# Phase 01 — 개발 기반과 구현 결정

- 상태: `IN_PROGRESS`
- 진행률: 5/6
- 선행 phase: Phase 00 `DONE`
- 주요 근거: 전체 ADR, 특히 ADR-001, ADR-003, ADR-005, ADR-016
- 선행 증거 감사: [Phase 01 baseline과 production gap](evidence-audit.md#phase-01-foundation)
- 종료 조건: 선택한 production stack에서 빈 server·DB bootstrap과 필수 로컬 검증이
  재현 가능하고 spike를 import하지 않는 제품 모듈 경계가 확정됨

> evidence audit의 `[x]`는 기존 증거 대조 완료다. 아래 작업의 `TODO/DONE`과 production
> 완료 체크를 대신하지 않는다.

## 작업 현황

| ID | 작업 | 상태 | Owner | 선행 작업 | 증거 |
|---|---|---|---|---|---|
| FND-001 | production 기술 스택 결정 | `DONE` | `log0629` | RDY-007 | [결정·검증](../implementation/fnd-001-production-stack.md), [PR #6](https://github.com/yeonjaekim99/knowledge-graph/pull/6) |
| FND-002 | 제품 모듈과 의존 방향 설계 | `DONE` | `log0629` | FND-001 | [결정·검증](../implementation/fnd-002-module-boundaries.md), [PR #7](https://github.com/yeonjaekim99/knowledge-graph/pull/7) |
| FND-003 | 결정적 runtime 경계 추상화 | `DONE` | `log0629` | FND-002 | [결정·검증](../implementation/fnd-003-runtime-boundaries.md), [PR #8](https://github.com/yeonjaekim99/knowledge-graph/pull/8) |
| FND-004 | public/domain schema 단일 출처 결정 | `DONE` | `log0629` | FND-001, FND-002 | [결정·검증](../implementation/fnd-004-schema-source.md), [PR #9](https://github.com/yeonjaekim99/knowledge-graph/pull/9) |
| FND-005 | 테스트 계층과 oracle 전략 구축 | `DONE` | `log0629` | FND-002 | [결정·검증](../implementation/fnd-005-test-strategy.md), [PR #11](https://github.com/yeonjaekim99/knowledge-graph/pull/11) |
| FND-007 | 개발자 bootstrap과 기여 문서 | `IN_PROGRESS` | `log0629` | FND-001~005 | branch `fnd-007-developer-bootstrap` |

## 상세 체크리스트

### FND-001 — production 기술 스택 결정

- 상태: `DONE`
- Owner: `log0629`
- 근거: ADR-005, ADR-016과 spike의 implementation decision
- 선행 작업: RDY-007
- 결과물: runtime, package manager, SQLite driver, MCP SDK와 지원 버전을 기록한 결정 문서

완료 체크:

- [x] 선택한 production MCP SDK의 실제 API에서 MCP `2026-07-28`, JSON Schema 2020-12와
      structuredContent 지원 여부를 확인했다.
- [x] 선택한 production SQLite driver/runtime 조합에서 FTS5 trigram, JSON 함수,
      `unixepoch()`, WAL과 transaction 제어를 확인했다.
- [x] native dependency 배포 방식과 지원 OS/runtime 범위를 명시했다.
- [x] 대안, 선택 이유, upgrade 책임과 lockfile 정책을 팀이 리뷰했다.
- [x] Accepted ADR 의미 변경이 없음을 확인해 별도 ADR이 필요하지 않다고 판정했다.

증거:

- 결정: [production 기술 스택](../implementation/fnd-001-production-stack.md)
- PR: [#6](https://github.com/yeonjaekim99/knowledge-graph/pull/6)
- 검증: `pnpm install --prod --frozen-lockfile`, `pnpm verify:fnd-001`,
  `python3 docs/roadmap/validate.py`, behavior spike 25 tests

### FND-002 — 제품 모듈과 의존 방향 설계

- 상태: `DONE`
- Owner: `log0629`
- 근거: ADR-001, ADR-007, ADR-016
- 선행 작업: FND-001
- 결과물: source/package 구조와 dependency rule

완료 체크:

- [x] domain reducer, application service, SQLite adapter, MCP adapter와 maintenance 경계를 분리했다.
- [x] journal을 쓰지 않고 projection을 변경할 수 있는 public 경로가 없다.
- [x] `spikes/adr-behavior`를 production source에서 import하지 않는 검사가 있다.
- [x] adapter 없이 pure reducer를 fixture로 실행할 수 있다.

증거:

- 결정: [제품 모듈과 의존 방향](../implementation/fnd-002-module-boundaries.md)
- PR: [#7](https://github.com/yeonjaekim99/knowledge-graph/pull/7)
- 검증: `pnpm verify:fnd-002`, `pnpm verify:fnd-001`,
  `python3 docs/roadmap/validate.py`, behavior spike 25 tests

### FND-003 — 결정적 runtime 경계 추상화

- 상태: `DONE`
- Owner: `log0629`
- 근거: ADR-001, ADR-002, ADR-003, ADR-010, ADR-017
- 선행 작업: FND-002
- 결과물: clock, ULID/CSPRNG, rules version, scope와 metadata provider interface

완료 체크:

- [x] reducer 안에서 wall clock, network, LLM과 git 조회를 호출하지 않는다.
- [x] 테스트가 clock, event ID, approval token과 `evaluation_now`를 주입할 수 있다.
- [x] scope와 actor/branch/session 입력 경계가 tool argument와 분리됐다.
- [x] production provider와 deterministic test provider 계약이 같다.

증거:

- 결정: [결정적 runtime 경계](../implementation/fnd-003-runtime-boundaries.md)
- PR: [#8](https://github.com/yeonjaekim99/knowledge-graph/pull/8)
- 검증: `pnpm verify:fnd-003`, `pnpm verify:fnd-002`, `pnpm verify:fnd-001`,
  `python3 docs/roadmap/validate.py`, behavior spike 25 tests
- 범위 경계: concrete scope resolver는 STO-005, actor/Git/session metadata adapter는 STO-006,
  journal ID 충돌 재시도는 STO-007이 소유한다.

### FND-004 — public/domain schema 단일 출처 결정

- 상태: `DONE`
- Owner: `log0629`
- Branch: `fnd-004-schema-source`
- 근거: ADR-013~016
- 선행 작업: FND-001, FND-002
- 결과물: 타입과 JSON Schema 생성·검증 정책

완료 체크:

- [x] JSON Schema가 규범이며 runtime type과 drift를 검사한다.
- [x] 모든 object의 `additionalProperties:false`, union `oneOf`와 min/max를 표현할 수 있다.
- [x] outputSchema와 structured result를 같은 source에서 검증할 수 있다.
- [x] schema serialization이 결정적이다.

증거:

- 결정: [public/domain schema 단일 출처](../implementation/fnd-004-schema-source.md)
- PR: [#9](https://github.com/yeonjaekim99/knowledge-graph/pull/9)
- 검증: `pnpm verify:fnd-004`, `pnpm verify:fnd-001`,
  `python3 docs/roadmap/validate.py`, behavior spike 25 tests
- 범위 경계: 실제 record/recall/revise schema는 REC-001/RCL-001/REV-001, catalog와
  structuredContent wiring은 MCP-003, 전체 로컬 test 구조와 drift 검증은 FND-005가
  소유한다.

### FND-005 — 테스트 계층과 oracle 전략 구축

- 상태: `DONE`
- Owner: `log0629`
- Branch: `fnd-005-local-tdd`
- 근거: ADR 전체 Validation, [spike report](../spikes/adr-behavior-report.md)
- 선행 작업: FND-002
- 결과물: unit/integration/contract/e2e/performance test 구조

완료 체크:

- [x] S01~S24를 production black-box fixture로 옮기는 방법을 문서화했다.
- [x] incremental prefix와 full replay oracle의 canonical dump 비교 helper가 있다.
- [x] 실제 SQLite file, process crash와 MCP contract test를 별도 계층으로 구분했다.
- [x] 고정 seed·clock·locale로 실패를 재현할 수 있다.

증거:

- 결정: [로컬 TDD 테스트 계층과 oracle 전략](../implementation/fnd-005-test-strategy.md)
- PR: [#11](https://github.com/yeonjaekim99/knowledge-graph/pull/11)
- 검증: `pnpm verify:fnd-005` 42 tests, `python3 docs/roadmap/validate.py`, behavior
  spike 25 tests, 깨끗한 `git archive` 설치·검증, `pnpm audit --prod`
- 범위 경계: S01~S24 target은 모두 `planned`다. 실제 SQLite·projector·MCP·process·성능
  동작과 test는 manifest에 지정된 후속 제품 작업이 소유한다.

### FND-007 — 개발자 bootstrap과 기여 문서

- 상태: `IN_PROGRESS`
- Owner: `log0629`
- Branch: `fnd-007-developer-bootstrap`
- 근거: 협업 운영 요구
- 선행 작업: FND-001~005
- 결과물: setup, test, branch/PR, roadmap 갱신 가이드

완료 체크:

- [ ] 깨끗한 checkout에서 설치와 전체 빠른 test가 한 문서대로 성공한다.
- [ ] local DB가 repository 밖 또는 ignore된 안전한 경로에 생성된다.
- [ ] task owner/status/evidence 갱신 예시가 있다.
- [ ] 지원하지 않는 network filesystem·다중 writer 구성을 명시한다.

## 범위에서 제외된 안정적 작업 ID

- `FND-006` — **CI와 repository 품질 gate 구축**은 2026-08-21 maintainer 결정으로
  Recall v1 active 범위와 완료율에서 제외했다. ID는 재사용하지 않으며 로컬 검증 책임은
  FND-005와 FND-007이 나누어 소유한다. 근거는 [CI 작업 범위 제외 결정](../implementation/fnd-006-ci-retirement.md)과
  [retired task registry](retired-tasks.json)에 남긴다.

## Phase 종료 체크

- [ ] 기술 선택 문서가 병합됐다.
- [ ] 빈 production package와 필수 로컬 검증이 깨끗한 환경에서 통과한다.
- [ ] 제품 코드가 spike 구현을 import하지 않는다.
- [ ] Phase 02 작업자가 DB·scope·writer interface를 구현할 수 있다.
