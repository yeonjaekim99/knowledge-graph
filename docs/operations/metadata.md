# Runtime metadata 배포와 실패 계약

- 소유 작업: `STO-006`
- 규범 근거: ADR-003, ADR-011, ADR-016
- 적용 범위: Recall v1의 actor, configured Git branch와 optional session correlation

## 필수 worktree 설정

`RECALL_PROJECT_WORKTREE`에 project branch를 관찰할 기준 절대 경로를 명시한다.

```bash
export RECALL_PROJECT_WORKTREE=/srv/recall/project
```

cwd, tool argument나 현재 shell의 repository를 fallback으로 사용하지 않는다. 경로가
non-Git이면 정상적으로 `branch=NULL`이고, 상대 경로·빈 값·NUL은 startup 오구성이다.
멀티-repo project에서도 배포가 정한 이 한 경로만 기준으로 사용한다.

Git 상태는 다음처럼 기록된다.

| 상태 | branch metadata |
|---|---|
| symbolic branch | short ref, 예: `feature/metadata` |
| detached HEAD | `detached:<40-or-64-char full object ID>` |
| non-Git/unavailable/invalid HEAD | NULL |

Git 실패의 stderr, configured path와 driver cause를 application log에 남기지 않는다.

## optional session HMAC key

논리 session 상관관계가 필요한 배포만 32-byte random key를 64 lowercase hex로 설정한다.

```bash
export RECALL_SESSION_HMAC_KEY="$(openssl rand -hex 32)"
```

key가 없으면 session metadata는 항상 NULL이며 정상 구성이다. key가 정의됐지만 형식이
잘못되면 startup을 중단한다. raw session ID와 key를 log, metric, error, journal, FTS 또는
backup 이름에 넣지 않는다.

key rotation 뒤에는 기존 상관키와 새 상관키를 연결할 수 없다. rotation은 scope나 memory
내용을 바꾸지 않지만 감사 session 연속성을 끊으므로 운영 변경 기록에 시점을 남긴다.

## client actor

actor는 MCP/host가 관찰한 client info name만 사용한다. 값이 없으면 NULL이며 user principal,
Git author, process 이름 또는 `unknown`으로 채우지 않는다. control character는 제거하고
Unicode code point 기준 128자로 제한한다. actor는 감사 metadata일 뿐 인증과 scope에
참여하지 않는다.

protocol별 client info와 trusted logical session 위치는 MCP-006 adapter가 정규화한다.
tool JSON input으로 actor, branch, session이나 worktree를 받지 않는다.

## secret sanitizer 필수 연결

metadata provider 생성에는 actor/branch용 sanitizer가 반드시 필요하다. production에서
pass-through sanitizer를 쓰지 않는다. REC-002/003 detector가 준비되면 다음 결과를 연결한다.

- 안전한 값: 그대로 반환
- 위치가 확인된 secret hit: `[REDACTED:<class>]`로 구간 마스킹
- 위치 불명 hit 또는 detector 오류: 해당 field를 NULL

actor와 branch 중 하나가 실패해도 나머지 metadata와 memory body는 유지한다. raw session은
sanitizer에 보내기 전에 HMAC 또는 NULL로 바뀐다.

## startup과 request 실패 구분

| 상황 | 동작 |
|---|---|
| worktree 누락·잘못된 경로 형식 | startup 중단 |
| 잘못된 session key | startup 중단 |
| sanitizer dependency 누락 | composition 중단 |
| client info/session 부재 | 해당 값 NULL, 요청 계속 |
| non-Git/Git timeout·오류 | branch NULL, 요청 계속 |
| actor/branch secret gate 오류 | 해당 field NULL, 요청 계속 |

오류 메시지는 submitted path/key, raw session, client/branch 원문과 subprocess cause를
포함하지 않는다.

## 아직 연결되지 않은 것

현재 adapter와 Git/HMAC 동작은 구현됐지만 production secret detector와 MCP process는 아직
없다. REC-002/003이 sanitizer를 제공하고, STO-007이 journal append에 metadata를 연결하며,
MCP-006이 실제 request observation을 provider 생성에 전달한다.

## 검증

```bash
pnpm test:sto-006
pnpm test:fnd-003
pnpm verify:local
```

테스트 fixture에는 실제 credential이나 운영 session/key를 사용하지 않는다.
