# ADR-003: scope_key 구성과 결정 경로

- 상태: Accepted
- 결정일: 2026-08-20
- 소유 영역: 초기 설계 2.4, 9장 다중 프로젝트 항목
- 선행 ADR: ADR-001
- Supersedes: 없음

## Context

다른 사용자나 프로젝트의 기억이 섞이는 것은 Recall의 가장 큰 격리 실패다. 반대로
branch나 대화 session을 scope에 넣으면 다음 대화나 다른 branch에서 기억을 찾지 못한다.

초기 설계는 `user/project` 두 요소만 경계로 삼고 agent가 scope를 넘기지 못하게 한다.
이 저장소의 “어떤 agent든 기억을 공유한다”는 목표는 **같은 사용자와 프로젝트로
인증·설정된 agent들 사이의 공유**로 해석한다. 프로젝트를 넘는 전역 개인 기억은 v1
범위가 아니다.

최신 MCP 프로토콜은 연결 단위 session을 보장하지 않으며 client 정보도 요청
메타데이터로 전달할 수 있다. 그러므로 권한이나 TTL을 프로토콜 session 존재 여부에
의존시키면 안 된다.

## Decision

### scope 형식

```text
scope_key = "u:" + user_id + "/p:" + project_id
```

- `user_id`와 `project_id`는 각각 `[A-Za-z0-9._-]{1,64}`를 만족하는 불변 식별자다.
- 표시 이름, 이메일, 저장소 경로나 branch 이름을 식별자로 사용하지 않는다.
- 저장, 수정과 조회는 항상 완전히 같은 `scope_key`를 사용한다.
- 계층이나 접두어 조회를 제공하지 않는다.
- 모든 ID 조회 뒤에도 대상 행의 `scope_key`가 현재 요청 scope와 같은지 검사한다.

### 결정 주체

- 원격 배포의 `user_id`는 요청마다 검증한 인증 principal에서 얻는다.
- 로컬/stdio 배포처럼 인증 계층이 없으면 서버 시작 설정의 명시적 `user_id`를 쓴다.
- `project_id`는 서버 시작 설정에 명시하며, 작업 경로에서 매번 추론하지 않는다.
- tool input에는 `user_id`, `project_id`나 `scope_key`가 존재하지 않는다.
- 인증 또는 project 설정이 없으면 서버는 쓰기와 읽기 도구를 제공하지 않는다.

v1 프로세스는 정확히 하나의 `project_id`에 묶인다. 원격 서버는 여러 인증 사용자를
같은 project에 서비스할 수 있지만 요청마다 별도 `scope_key`를 계산한다. 여러 project를
한 프로세스에서 라우팅하는 기능은 제공하지 않으며 각 project가 별도 서버 설정을
사용한다. 프로젝트 공통이 아닌 개인 기억이 필요하면 사용자가 명시적으로
`project_id=personal`인 별도 서버를 구성한다. 자동 fallback이나 cross-scope 검색은 없다.

### 메타데이터

- `actor`: 요청 시점의 MCP client info `name`. 제어문자를 제거한 128자 상한이며 없으면
  `unknown`이 아니라 NULL이다. 인증 principal로 사용하지 않는다.
- `branch`: 서버가 설정된 project 작업 경로에서 git을 직접 조회한다. symbolic branch면
  short ref 이름, detached HEAD면 `detached:<full-object-id>`, git 저장소가 아니면 NULL이다.
  멀티 repo project에서도 기준은 서버에 설정한 한 작업 경로이며 tool input으로 바꾸지
  않는다.
- `session`: transport/host가 신뢰할 수 있는 논리 session ID를 제공할 때만
  deployment metadata key의 `HMAC-SHA-256`으로 계산한
  `hmac-sha256:<lowercase-hex>` 상관키로 기록한다. key가 없으면 NULL로 두며 원문
  session/bearer 값을 journal에 넣지 않는다. 최신 stateless MCP 또는 stdio에서 값이
  없으면 NULL이다.
- 세 값은 감사용일 뿐 인증, scope 또는 사실 동일성에 사용하지 않는다.

actor와 branch도 ADR-011 비밀 검사를 거치며 hit 구간은 journal INSERT 전에 마스킹한다.
metadata 검사 실패가 기억 body를 유실시키지는 않도록 해당 metadata를 NULL로 낮춘다.

MCP 버전별 client info 위치 차이는 transport adapter가 흡수한다. 2026-07-28 계열은
요청 `_meta`, 이전 stateful 규격은 초기화 컨텍스트에서 읽되 projector에는 정규화된
nullable metadata만 전달한다.

### 다중 프로젝트 재검토 조건

한 사용자가 세 개 이상의 project 서버를 상시 실행해 설정 중복이나 메모리 사용이
운영 문제로 기록되거나, 단일 authenticated endpoint에서 project 전환 요구가 실제로
발생하면 ADR-003 후속 ADR을 작성한다. 그 전에는 agent가 project를 인자로 고르는
인터페이스를 추가하지 않는다.

## Alternatives

### user 전역 scope를 자동 포함

개인 선호를 쉽게 공유하지만 project 기밀이 다른 project 질문에 노출될 수 있다.
명시적인 `personal` project로 같은 목적을 달성할 수 있어 자동 전역 검색을 제외했다.

### repo, branch 또는 session을 scope에 포함

격리는 강해지지만 멀티 repo project, branch 전환과 다음 대화에서 기억이 사라진다.
이 값들은 감사 메타데이터로만 남긴다.

### agent가 scope를 전달

구현은 유연하지만 잘못되거나 조작된 agent 입력이 보안 경계를 결정한다. 서버 설정과
인증만 신뢰한다.

### 한 서버가 모든 project를 동적 라우팅

운영은 편하지만 project 선택을 어떤 신뢰 경계에서 받을지 추가 설계가 필요하다.
v1은 서버 프로세스를 project에 고정한다.

## Consequences

- 같은 project에 연결된 Claude, OpenCode 등은 actor가 달라도 기억을 공유한다.
- project 간 자동 기억 공유는 없다.
- MCP protocol session이 없어도 scope와 TTL 정책이 동작한다.
- project 이동이나 이름 변경 시 설정된 불변 project_id를 보존해야 한다.
- 모든 쿼리는 scope 조건을 포함해야 하며 ID만으로 행을 반환해서는 안 된다.

## Validation

- 동일 entity/표면형을 두 scope에 기록하고 각각의 recall이 자기 행만 반환해야 한다.
- 다른 scope에서 얻은 claim/entity/event ID로 revise를 시도하면 not found로 처리해야 한다.
- tool JSON Schema에 scope 관련 입력이 없어야 한다.
- clientInfo와 session이 없는 요청도 설정된 user/project로 정상 동작해야 한다.
- branch 전환 뒤에도 같은 기억이 조회되고 새 사건의 branch 메타데이터만 달라져야 한다.

## References

- 초기 설계 2.4
- ADR-001
- [MCP 2026-07-28 Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
