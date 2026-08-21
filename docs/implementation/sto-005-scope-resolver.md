# STO-005: trusted scope resolver

- 상태: Accepted
- 결정일: 2026-08-21
- 작업: STO-005
- Owner: `log0629`
- PR: 이 작업 PR에서 확정
- 규범 근거: ADR-003
- 규범 관계: ADR을 대체하지 않는 implementation decision

## 기존 증거와 production gap

behavior spike S09는 서로 다른 `scope_key`의 projection과 aggregate가 섞이지 않고 다른
scope의 ID가 조회되지 않는 상태 의미를 확인했다. FND-003은 인자 없는
`ScopeProvider.resolveScope()` port와 application 경계의 exact scope 검증을 제공한다.

두 증거는 project 설정을 어디에서 고정하는지, local identity와 remote authenticated
principal을 어떻게 구분하는지, 신뢰 문맥이 없을 때 fallback 없이 실패하는 production
adapter를 구현한 것은 아니다. STO-005는 이 gap만 닫는다. 실제 transport 인증과 tool
lifecycle 연결은 MCP-001/MCP-006이 소유하고, query/repository의 scope predicate는 각 후속
작업이 소유한다.

## 결론

`src/adapters/runtime/scope-provider.ts`에 local과 remote mode를 분리한 두 단계 adapter를
둔다.

```text
startup                                      request
RECALL_PROJECT_ID ── snapshot ─┐
                               ├─ local: RECALL_USER_ID ── ScopeProvider
                               └─ remote: authenticated principal ── ScopeProvider
                                                                      │ no arguments
                                                                      ▼
                                                           FND-003 RuntimeProvider
```

project ID는 process startup 설정에서 한 번 읽어 frozen deployment config로 만든다. cwd,
repository, branch, session, display name이나 email에서 추론하지 않는다. local mode는 같은
startup 설정의 explicit user ID를 요구한다. remote mode는 startup user 설정을 금지하고
인증 경계가 검증한 요청별 principal을 요구한다.

각 provider는 입력을 다시 검사한 뒤 user/project를 복사해 frozen scope 하나를 만든다.
`resolveScope()`는 인자가 없고 같은 immutable snapshot을 반환한다. 원본 environment,
configuration 또는 principal object가 나중에 바뀌어도 이미 만들어진 scope에는 영향을
주지 않는다.

## 식별자와 exact scope

user ID와 project ID는 ADR-003의 전체 규칙인 ASCII `[A-Za-z0-9._-]{1,64}`를 동일하게
적용한다. trim, case fold, Unicode 정규화, path 해석이나 기본값은 없다. 허용된 두 값을
다음 한 방식으로만 조합한다.

```text
u:{user_id}/p:{project_id}
```

개인 기억도 암묵적인 global scope로 취급하지 않는다. 운영자가 project ID를
`personal`로 명시하면 일반 project와 같은 검증·격리 규칙을 적용한다. 한 config는 project
하나만 나타내며 multi-project routing은 v1 범위가 아니다.

## mode별 신뢰 경계

| mode | project 원천 | user 원천 | 금지되는 fallback |
|---|---|---|---|
| local | explicit `RECALL_PROJECT_ID` | explicit `RECALL_USER_ID` | OS user, email, cwd, repository |
| remote | explicit `RECALL_PROJECT_ID` | authenticated request principal | `RECALL_USER_ID`, anonymous/default user, tool argument |

`AuthenticatedUserPrincipal`은 인증 adapter가 성공한 뒤 만드는 내부 값이다. STO-005는
principal의 `userId`가 scope 식별자 규칙에 맞는지 검증하지만 bearer token, signature나
session을 인증하지 않는다. transport별 인증 성공을 이 타입에 연결하고 요청마다 remote
provider를 만드는 일은 MCP-006의 책임이다.

scope adapter와 타입은 runtime adapter 내부 index에서만 export하고 package root에는
공개하지 않는다. FND-004의 public schema와 tool DTO에도 `user_id`, `project_id`,
`scope_key` 또는 mode selector를 추가하지 않는다.

## fail-closed 오류 계약

누락·형식 오류·mode 혼합은 redacted `ScopeResolutionError`로 실패한다. 오류는
`retryable=false`이고 submitted ID, environment 값, 인증 정보 또는 원본 cause를 포함하지
않는다.

| code | 의미 |
|---|---|
| `PROJECT_ID_REQUIRED` / `PROJECT_ID_INVALID` | 고정 project 설정 누락 또는 형식 오류 |
| `LOCAL_USER_ID_REQUIRED` / `LOCAL_USER_ID_INVALID` | local user 설정 누락 또는 형식 오류 |
| `REMOTE_LOCAL_USER_FORBIDDEN` | remote startup에 local fallback user가 존재함 |
| `REMOTE_PRINCIPAL_REQUIRED` / `REMOTE_PRINCIPAL_INVALID` | 인증 principal 누락 또는 ID 형식 오류 |
| `DEPLOYMENT_CONFIG_INVALID` | mode나 runtime config object가 계약과 다름 |

startup config 오류에서는 runtime composition과 tool 등록을 진행하면 안 된다. remote
principal 오류에서는 해당 요청에 provider를 만들지 않고 tool use case를 호출하면 안
된다. 현재 repository에는 MCP entrypoint가 없으므로 실제 no-tool lifecycle 검증은
MCP-001/MCP-006에서 이 typed failure를 연결해 완료한다.

## 대안

### tool input에서 scope를 받기

호출자는 편하지만 agent가 격리 경계를 주장하게 된다. 인자 없는 provider와 server-owned
context를 유지한다.

### remote mode가 startup user를 fallback으로 사용하기

인증 누락이 정상 사용자처럼 처리돼 다른 사용자의 기억에 접근할 수 있다. remote config에
`RECALL_USER_ID`가 정의된 것 자체를 오류로 만든다.

### cwd나 Git remote에서 project를 추론하기

실행 위치·checkout 이름이 바뀔 때 scope가 조용히 바뀌고 multi-repo project가 갈라진다.
명시적 immutable project ID만 허용한다.

### 하나의 provider가 호출 인자로 principal을 받기

application이나 tool DTO가 request context를 전달하는 우회 surface가 생긴다. 인증 뒤
요청별로 zero-argument provider를 생성한다.

## 범위 경계

- STO-006은 actor, Git branch와 session correlation metadata를 별도로 제공한다.
- STO-007은 이 scope snapshot을 journal append의 server-owned context에 연결한다.
- Phase 03과 06은 모든 projection/query에 exact `scope_key` predicate를 적용한다.
- MCP-001은 startup config 실패 전에 tool을 노출하지 않는다.
- MCP-006은 실제 authenticated request context로 remote provider를 만들고 동시 요청 격리를
  검증한다.

따라서 S09 manifest는 aggregate/query와 MCP request wiring owner가 남아 있어 아직
`planned`를 유지한다.

## 검증

```bash
pnpm test:sto-005
pnpm test:fnd-003
pnpm verify:local
python3 docs/roadmap/validate.py
python3 -m unittest discover -s spikes/adr-behavior -p 'test_*.py'
pnpm audit --prod
```

STO-005 test는 local/remote 정상 분리, immutable snapshot, 64자 ASCII 경계와 `personal`,
누락·공백·Unicode·path·email·65자 ID, remote fallback과 principal 부재, redacted typed error,
zero-argument provider와 package-root 비노출을 검증한다.

## ADR 영향 검토

- ADR-003: exact scope format, explicit project, local/remote identity source와 no-fallback을
  production adapter로 구현한다.
- ADR-001/007: journal이나 projection을 변경하지 않으며 후속 writer가 사용할 trusted
  snapshot만 제공한다.
- ADR-016: public tool schema·input·package root에는 scope selector를 추가하지 않는다.

Accepted ADR의 의미를 바꾸지 않으므로 superseding ADR은 필요하지 않다.
