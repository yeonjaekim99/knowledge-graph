# Recall 저장소 작업 규칙

이 파일은 이 저장소에서 작업하는 모든 coding agent의 공통 작업 계약이다. 특정 도구에
종속된 지침은 공통 규칙을 복제하지 말고 해당 도구의 얇은 진입 파일에서 이 문서를
참조한다. 하위 디렉터리에 더 구체적인 `AGENTS.md`가 생기면 그 범위에서만 가까운
지침이 우선한다.

## 단일 진실 원천

- 아키텍처의 규범은 [Accepted ADR 목록](docs/adr/README.md)과 연결된 ADR 본문이다.
- 실행 순서와 현재 상태의 규범은 [구현 로드맵](docs/roadmap/README.md)과 phase별 작업
  체크리스트다.
- [초기 설계](docs/init-design.md)는 역사적 출발점이다. Accepted ADR과 충돌하면 ADR이
  우선한다.
- [behavior spike](spikes/adr-behavior/README.md)는 상태 전이의 executable oracle이다.
  production 코드에 import하거나 production 구조의 출발점으로 복사하지 않는다.
- [evidence-gap audit](docs/roadmap/evidence-audit.md)는 각 제품 작업에서 이미 검증된
  baseline과 production에 남은 gate를 구분한다. `[x]`는 감사 완료이지 제품 구현 완료가
  아니다.
- 현재 작업 상태나 다음 작업 ID를 이 파일에 고정하지 않는다. 항상 roadmap에서 읽는다.

## 모든 작업을 시작할 때

1. `git status --short --branch`로 branch와 기존 변경을 확인하고, 사용자나 다른 작업자의
   변경을 보존한다.
2. [구현 로드맵](docs/roadmap/README.md)에서 현재 phase와 안정적인 작업 ID를 찾는다.
3. 해당 phase 문서에서 작업의 상태, 단일 owner, 선행 작업, 결과물, 완료 체크와 증거를
   읽는다.
4. 작업에 연결된 Accepted ADR의 Decision과 Validation, evidence-gap audit의 해당 행,
   traceability와 관련 spike scenario를 확인한다.
5. 완료 조건마다 `이미 증거가 있는 baseline`, `production에서 새로 닫을 gate`, `증거가
   불명확한 항목`으로 분류한다. baseline을 신규 작업으로 제안하거나 반복하지 않는다.
6. 제품 구현 작업은 선행 항목이 모두 `DONE`이고 해당 작업이 owner와 branch를 가진
   `IN_PROGRESS` 상태일 때만 시작한다.

작업 ID가 없거나 선행 작업이 끝나지 않았다면 제품 코드를 먼저 만들지 않는다. 새 범위는
기존 ID에 조용히 합치지 말고 roadmap 작업으로 추가하며, 진행 불가능한 경우 원인·필요한
결정·해제 책임자를 적어 `BLOCKED`로 남긴다.

spike나 ADR review의 `[x]`를 근거로 production 작업을 `DONE` 처리하지 않는다. 반대로 이미
확인한 feasibility나 상태 의미를 production 선택처럼 다시 조사하지도 않는다. 기존 증거의
적용 범위가 불명확하면 구현보다 roadmap evidence audit 정정을 먼저 한다.

## 구현 불변식

- journal은 append-only인 유일한 진실 원천이며 `UPDATE`와 `DELETE` 경로를 만들지 않는다.
- projection과 FTS는 파생 상태다. 사용자 요청이 projection을 직접 바꾸게 하지 않는다.
- MCP server만 writer이며 `scope_key`, actor, branch, session은 신뢰할 수 있는 서버
  문맥에서 결정한다.
- 사건과 occurrence에 고정된 ID 및 redirect 규칙을 지켜 replay 전후 외부 참조가
  안정적이어야 한다.
- 비밀값 검사는 불변 journal에 기록하기 전에 끝낸다. 부분 실패와 transaction 경계를
  ADR이 정한 단위보다 느슨하게 만들지 않는다.
- 구현 편의를 위한 다른 의미가 필요하면 기존 ADR을 우회하지 않는다. superseding ADR이
  Accepted될 때까지 관련 작업을 `BLOCKED`로 둔다.

이 목록은 요약일 뿐이다. 정확한 schema, 순서, 경계 조건은 연결된 ADR이 우선한다.

## 작업과 검증

- 기본 branch인 `main`에서 직접 작업하지 않는다. 작업 ID를 연결한 별도 branch와 PR을
  사용한다.
- 다른 변경을 함께 정리하거나 stage하지 않는다. 변경한 경로만 명시적으로 stage한다.
- 정상·경계·실패 경로를 검증하고, 상태 의미를 바꾸면 behavior spike 또는 독립 reference
  query와 parity를 확인한다.
- 문서나 roadmap을 바꾼 경우 다음 검사를 실행한다.

```bash
python3 docs/roadmap/validate.py
```

- 관련 phase의 추가 명령과 공통 Definition of Done도 실행한다. 실행하지 못한 검사는
  성공으로 기록하지 말고 이유를 PR에 남긴다.
- 같은 PR에서 작업 체크박스, 상세 상태, 증거, phase 진행률과 master roll-up을 함께
  갱신한다.
- 허용 상태는 `TODO`, `IN_PROGRESS`, `BLOCKED`, `DONE`뿐이다. `DONE`은 체크, 리뷰,
  검증, `main` 병합과 영속적인 증거가 모두 있을 때만 사용한다.

## 리뷰와 인계

- 제출 전 diff 전체를 읽어 ADR 위반, scope 누출, 비밀값 노출, journal/projection 부분
  commit 가능성과 문서-코드 불일치를 확인한다.
- commit은 한 가지 검토 가능한 의도를 담고, 본문에 이유·핵심 변경·검증을 남긴다.
- PR에는 작업 ID, 범위, ADR, 검증 결과, roadmap 변경과 남은 위험을 적는다.
- PR을 올린 뒤 CI와 unresolved review thread를 확인한다. 해결하지 못한 지적은 숨기지
  말고 blocker 또는 후속 작업으로 기록한다.
- merge까지 요청된 작업은 PR을 review 가능한 상태로 전환하고 merge한 뒤 `main`으로
  이동해 `git pull --ff-only origin main`으로 동기화한다.
- 다른 agent가 이어받을 때는 작업 ID, 현재 branch/PR, 마지막 정상 검증, 변경 경로와
  blocker를 전달한다.

## 문서 변경 원칙

- ADR은 Context / Decision / Alternatives / Consequences / Validation 구조와 상태를
  유지한다. Accepted 결정을 바꿀 때는 기존 문서를 몰래 고치지 말고 대체 절차를 따른다.
- roadmap의 stable ID 의미를 재사용하거나 삭제하지 않는다. 후속 범위에는 다음 번호를
  부여한다.
- 일시적인 대화나 로컬 상태가 아니라 팀원이 `main`에서 재현할 수 있는 결정과 증거만
  저장소 문서에 남긴다.
