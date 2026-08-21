# STO-006: trusted runtime metadata

- 상태: Accepted
- 결정일: 2026-08-22
- 작업: STO-006
- Owner: `log0629`
- PR: [#18](https://github.com/yeonjaekim99/knowledge-graph/pull/18)
- 규범 근거: ADR-003, ADR-011, ADR-016
- 규범 관계: ADR을 대체하지 않는 implementation decision

## 기존 증거와 production gap

FND-003은 인자 없는 async `MetadataProvider.resolveMetadata()` port, request snapshot cache와
application 경계의 actor/branch/session 형식 검증을 제공한다. ADR-003/011/016은 세 값의
신뢰 원천, nullable 실패와 비밀값 처리 의미를 확정했다.

이 baseline은 실제 client name 정리, configured worktree의 Git 상태 판정, deployment
key 기반 session HMAC과 secret detector 연결 지점을 구현한 것은 아니다. STO-006은 이
production gap만 닫는다. 실제 MCP protocol revision별 client/session 추출은 MCP-006,
secret signature·entropy detector와 masking primitive는 REC-002/003이 소유한다.

## 결론

`src/adapters/runtime/metadata-provider.ts`에 startup config와 request-bound provider를 둔다.

```text
startup config                         trusted request observation
RECALL_PROJECT_WORKTREE ─────┐         clientInfo.name
RECALL_SESSION_HMAC_KEY ─ HMAC         logical session ID
                             │                │
                             └──────┬─────────┘
                                    ▼
                    required metadata sanitizer
                     actor / branch independently
                                    │
                                    ▼
                  zero-argument MetadataProvider
                  { actor, branch, session } frozen
```

provider 생성 시 client name과 session을 request context에서 snapshot한다. session 원문은
즉시 HMAC 상관키 또는 NULL로 바뀌고 provider closure에 보관하지 않는다. branch는
`resolveMetadata()`의 첫 capture에서 configured worktree를 한 번 조회한다. 결과 Promise와
frozen metadata를 cache하므로 같은 요청 안에서 재조회하거나 branch가 흔들리지 않는다.

tool DTO, 인증 principal, scope provider와 metadata source는 섞이지 않는다. adapter는 package
root에 export되지 않으며 실제 transport가 신뢰 context를 만드는 일은 MCP-006이 담당한다.

## 배포 설정

| 환경 변수 | 필수 | 형식 | 의미 |
|---|---|---|---|
| `RECALL_PROJECT_WORKTREE` | 예 | NUL이 없는 절대 경로 | Git branch를 읽을 하나의 project 기준 경로 |
| `RECALL_SESSION_HMAC_KEY` | 아니오 | 64 lowercase hex, 32 bytes | trusted logical session의 상관키 생성 key |

worktree는 cwd나 tool input에서 추론하지 않고 startup 때 string snapshot으로 고정한다. 실제
경로가 non-Git이거나 Git 조회가 실패하면 branch만 NULL이다. 상대 경로·빈 값·NUL은
오구성이므로 startup config 생성 자체를 거부한다.

session key가 없는 배포는 정상이며 session을 항상 NULL로 둔다. key가 정의됐다면 정확한
256-bit canonical hex만 허용한다. 잘못된 key를 “key 없음”으로 낮추면 운영자가 correlation이
된다고 오인하므로 redacted non-retryable startup 오류로 처리한다. config object에는 key
원문 대신 상관 함수만 남아 JSON serialization으로 key가 노출되지 않는다.

## actor

actor는 transport가 관찰한 `clientInfo.name` string만 사용한다. principal, tool argument,
기본 client 이름이나 `unknown`으로 fallback하지 않는다.

1. C0/C1 control character를 제거한다.
2. Unicode code point 기준 앞 128자로 자른다.
3. 빈 값이면 NULL로 낮춘다.
4. 남은 값을 metadata sanitizer에 전달하고 결과를 다시 같은 형식으로 검증한다.

sanitizer가 secret 구간을 찾으면 `[REDACTED:<class>]`를 포함한 마스킹 값을 반환할 수 있다.
위치를 안전하게 특정하지 못하거나 sanitizer가 실패하면 actor만 NULL이다.

## branch

production resolver는 shell 없이 `git` executable을 직접 호출한다.

1. `git symbolic-ref --quiet --short HEAD`가 성공하면 short ref를 사용한다.
2. 실패하면 `git rev-parse --verify HEAD`를 실행한다.
3. 40자리 SHA-1 또는 64자리 SHA-256 full object ID면 `detached:<oid>`를 사용한다.
4. non-Git, unborn/invalid HEAD, timeout, 실행 오류와 여러 줄·control 출력은 NULL이다.

subprocess stderr, error object와 configured path는 log/error로 전달하지 않는다. 5초 timeout과
8 KiB stdout 상한을 두며 읽은 branch는 actor와 독립적으로 sanitizer를 거친다. branch
sanitizer가 실패해도 actor, session과 기억 body는 유지된다.

## session

transport/host가 제공한 non-empty logical session string과 deployment key가 모두 있을 때만
다음을 계산한다.

```text
hmac-sha256:<lowercase hex HMAC-SHA-256(key, raw logical session ID)>
```

raw session, bearer와 key를 sanitizer, journal, FTS, error 또는 log에 넘기지 않는다. key나
trusted session이 없으면 NULL이며 이는 scope, 인증 또는 TTL session 종료의 근거가 아니다.
key rotation 뒤에는 같은 raw session도 다른 상관키가 되므로 rotation 전후 값을 연결할 수
있다고 가정하지 않는다.

## secret gate와 실패 격리

`createRequestMetadataProvider`는 `MetadataTextSanitizer`를 필수 dependency로 요구하며 안전하지
않은 production pass-through 기본값을 제공하지 않는다. REC-002/003은 다음 계약을 구현한다.

- safe 또는 위치가 확인된 hit: 원문 또는 마스킹된 string 반환
- 위치 불명 hit: NULL 반환
- detector 내부 오류: throw; STO-006이 해당 field를 NULL로 변환

actor와 branch는 독립 호출이다. 한쪽의 hit/오류가 다른 쪽, session 또는 memory body를
유실시키지 않는다. sanitizer가 반환한 비-string, 빈 값이나 control 포함 branch도 NULL로
낮춘다. session은 secret detector 이전에 HMAC 처리하므로 sanitizer 입력이 아니다.

현재 production detector가 아직 없으므로 MCP composition을 완성할 때 REC-002/003 구현을
반드시 주입해야 한다. test용 pass-through를 production에 연결하면 안 된다.

## 오류 계약

startup/dependency 오구성은 submitted path/key와 cause를 포함하지 않는
`MetadataConfigurationError`이며 `retryable=false`다.

| code | 의미 |
|---|---|
| `PROJECT_WORKTREE_REQUIRED` / `PROJECT_WORKTREE_INVALID` | explicit 기준 경로 누락 또는 형식 오류 |
| `SESSION_HMAC_KEY_INVALID` | 정의된 key가 canonical 256-bit hex가 아님 |
| `METADATA_DEPENDENCIES_INVALID` | sanitizer 또는 branch resolver 계약 누락 |
| `DEPLOYMENT_CONFIG_INVALID` | runtime config object가 계약과 다름 |

반면 관찰 metadata가 없거나 malformed인 것, Git/sanitizer 실행 실패는 memory operation을
실패시키지 않고 해당 nullable field만 NULL로 만든다. deployment 설정 오류와 request별
best-effort metadata 실패를 같은 fallback으로 섞지 않는다.

## 대안

### actor를 authenticated principal에서 만들기

감사 client와 사용자 identity가 섞여 actor 변경이 scope를 바꾼다는 오해가 생긴다. 관찰된
client name만 사용한다.

### branch를 process cwd에서 읽기

server 실행 위치에 따라 같은 project metadata가 달라진다. explicit worktree 한 곳에
고정한다.

### raw session을 저장하거나 hash만 사용하기

원문은 bearer 누출 위험이 있고 unkeyed hash는 짧거나 예측 가능한 ID를 역추적할 수 있다.
deployment secret을 사용하는 HMAC만 저장한다.

### sanitizer가 없으면 actor/branch를 그대로 허용하기

후속 detector wiring 누락이 불변 journal의 secret 누출로 이어진다. dependency를 필수로
만들고 production 기본값을 두지 않는다.

## 범위 경계

- REC-002/003은 실제 signature·entropy 탐지와 위치 기반 masking을 구현한다.
- STO-007은 normalized metadata를 append-only journal event에 연결한다.
- MCP-006은 protocol별 observed client/session context를 요청마다 이 adapter에 연결한다.
- REL-005는 실제 log/DB/WAL/backup에서 clientInfo, branch와 raw session 비노출을 재검증한다.

따라서 S18 manifest는 body detector/write 경계가 남아 있어 아직 `planned`를 유지한다.

## 검증

```bash
pnpm test:sto-006
pnpm test:fnd-003
pnpm verify:local
python3 docs/roadmap/validate.py
python3 -m unittest discover -s spikes/adr-behavior -p 'test_*.py'
pnpm audit --prod
```

STO-006 runtime test는 실제 임시 Git repository에서 symbolic/detached/non-Git 결과,
actor control 제거·128 code-point 경계, canonical HMAC과 config snapshot, key/session 비노출,
sanitizer masking·예외 및 Git 실패의 필드별 NULL 격리, typed config 오류, zero-argument/private
surface를 검증한다.

## ADR 영향 검토

- ADR-003: actor·branch·session의 server-owned source와 nullable 형식을 구현한다.
- ADR-011: session을 detector 이전에 HMAC하고 actor/branch sanitizer 실패를 해당 metadata
  NULL로 격리하는 integration boundary를 구현한다. detector 자체는 REC-002/003에 남긴다.
- ADR-016: observed client info만 받고 tool input/public package API에는 metadata selector를
  추가하지 않는다.

Accepted ADR의 의미를 바꾸지 않으므로 superseding ADR은 필요하지 않다.
