# Scope 배포 설정과 실패 계약

- 소유 작업: `STO-005`
- 규범 근거: ADR-003
- 적용 범위: Recall v1의 단일 project process와 local/remote user binding

## 공통 project 설정

모든 mode에서 `RECALL_PROJECT_ID`를 명시한다. 값은 ASCII
`[A-Za-z0-9._-]{1,64}`여야 하며 기본값, trim, cwd/Git 추론이 없다.

```bash
export RECALL_PROJECT_ID=recall-project
```

한 process는 이 project 하나에만 묶인다. 여러 repository를 같은 project로 취급하려면
동일한 명시 project ID로 배포한다. 개인 기억도 `RECALL_PROJECT_ID=personal`처럼 명시하며
global scope는 만들지 않는다.

## local mode

stdio/local 실행은 user와 project를 startup 설정으로 모두 명시한다.

```bash
export RECALL_PROJECT_ID=recall-project
export RECALL_USER_ID=log0629
```

`RECALL_USER_ID`도 같은 ASCII 1~64자 규칙을 따른다. OS login, Git author, email이나 홈
디렉터리에서 user를 추론하지 않는다. 둘 중 하나가 없거나 잘못되면 startup을 중단하고
tool을 등록하지 않아야 한다.

## remote mode

remote deployment에는 project만 설정한다.

```bash
export RECALL_PROJECT_ID=shared-project
unset RECALL_USER_ID
```

`RECALL_USER_ID`가 빈 문자열을 포함해 정의돼 있으면 local fallback 오구성으로 보고
startup을 중단한다. user는 인증이 성공한 **현재 요청의 principal**에서만 얻는다.
인증 누락·실패 또는 principal user ID 형식 오류에서는 해당 요청의 application/tool 호출을
시작하지 않는다. anonymous, default, 이전 요청의 principal로 fallback하지 않는다.

STO-005는 인증 프로토콜을 구현하지 않는다. 실제 MCP transport는 MCP-006에서 인증 결과를
`AuthenticatedUserPrincipal`에 연결하고 요청마다 scope provider를 새로 만들어야 한다.

## 결과와 관찰 가능한 실패

유효한 값은 정확히 다음 key가 된다.

```text
RECALL_USER_ID=alice
RECALL_PROJECT_ID=shared-project
→ u:alice/p:shared-project
```

설정·principal 오류는 `ScopeResolutionError`와 안정적인 code로 보고되지만 오류 메시지와
log에 제출된 ID, environment 값, token이나 원본 cause를 남기지 않는다. 이 오류는 배포
또는 인증 문맥 수정이 필요하므로 자동 retry 대상이 아니다.

운영 점검 시 다음을 확인한다.

1. mode에 맞는 environment 변수만 정의됐는가.
2. project ID가 배포 간 의도대로 동일하고 cwd/repository 이름에 의존하지 않는가.
3. remote 인증 성공 결과가 요청별 provider 생성 전에 존재하는가.
4. tool JSON input과 public package API에 scope selector가 없는가.
5. 실패한 startup/request가 다른 user/project로 fallback하지 않는가.

## 아직 연결되지 않은 것

현재 adapter는 trusted scope snapshot을 제공하지만 MCP process/tool은 아직 구현되지 않았다.
MCP-001이 startup error를 tool registration 전 gate에 연결하고, MCP-006이 remote 인증 문맥과
동시 요청 격리를 연결한다. STO-007과 Phase 03·06은 이 snapshot을 journal, projection과
query의 exact scope predicate에 사용한다.

## 검증

```bash
pnpm test:sto-005
pnpm test:fnd-003
pnpm verify:local
```

테스트는 local/remote mode, immutable configuration/principal snapshot, identifier 경계,
mode 혼합·누락·잘못된 값의 fail-closed/redaction과 public input 비노출을 검증한다.
