# Recall 기여 가이드

이 문서는 새 checkout에서 개발을 시작해 roadmap 상태와 검증 증거를 `main`에 남길 때까지의
공통 절차다. 아키텍처 규범은 [Accepted ADR](docs/adr/README.md), 작업 순서와 현재 상태는
[구현 로드맵](docs/roadmap/README.md), coding agent 계약은 [AGENTS.md](AGENTS.md)가
소유한다. 이 문서는 그 규범을 복제하거나 변경하지 않고 실행 가능한 진입 순서만 제공한다.

## 지원 환경

- Node.js `24.19.0`: [`.node-version`](.node-version)과 `package.json#engines`에 고정
- pnpm `11.22.0`: `package.json#packageManager`와 engine에 고정
- production dependency 설치에는 지원 OS/architecture용 native prebuild가 필요하다.
  지원 범위는 [FND-001 기술 스택 결정](docs/implementation/fnd-001-production-stack.md)을
  따른다.
- Python 3.12 계열은 독립 behavior spike와 roadmap 문서 검증에 사용한다. production
  runtime이나 reducer는 Python spike를 import하지 않는다.

다른 Node major, pnpm 버전 또는 native dependency source build로 조용히 우회하지 않는다.
버전을 바꾸려면 dependency upgrade 전용 작업과 전체 검증 증거가 필요하다.

## 깨끗한 checkout 시작

저장소를 clone한 뒤 버전과 lockfile을 확인하고 로컬 gate를 실행한다.

```bash
git clone https://github.com/yeonjaekim99/knowledge-graph.git
cd knowledge-graph
node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm verify:local
python3 docs/roadmap/validate.py
```

예상 버전은 `v24.19.0`과 `11.22.0`이다. `pnpm install --frozen-lockfile`이 실패하면
lockfile을 임의로 다시 만들지 말고 runtime, package manager, OS/architecture와 오류를
기록한다. `pnpm verify:local`은 production capability probe, architecture와 type 검사,
build 및 performance를 제외한 빠른 test 전체를 실행한다.

Recall v1에는 자동 CI workflow가 없다. 위 명령의 성공 결과를 PR에 남기고 reviewer가
확인하는 것이 필수 gate다. 비어 있는 future test 계층의 `PASS (no tests assigned yet)`는
그 계층의 제품 기능이 완료됐다는 증거가 아니다.

## 로컬 DB와 상태 파일 안전 규칙

production DB 경로는 `RECALL_DB_PATH`에 **절대 file 경로**로 명시한다. 기본 경로나
in-memory/URI fallback은 없다. startup gate는 안전한 로컬 filesystem과 권한 및
FTS5·trigram·JSON·`unixepoch()`을 확인한 뒤에만 readiness를 발급한다. 자세한 운영 계약은
[SQLite 저장 경로와 startup](docs/operations/storage.md)을 따른다.
이 경계는 `STO-001`이 구현했으며 WAL 연결과 writer 직렬화는 `STO-002`에 남아 있다.

로컬에서 repository 안의 상태를 명시적으로 유지할 때는 다음처럼 준비한다.

```bash
install -d -m 700 .recall
export RECALL_DB_PATH="$PWD/.recall/recall.sqlite3"
```

- 자동 test와 일회성 SQLite 실험은 OS 임시 디렉터리에 격리하고 test 종료 시 닫는다.
- 꼭 checkout 안에 상태를 유지해야 하면 repository root의 `/.recall/` 디렉터리만 쓴다.
  이 표기는 filesystem root가 아니라 root `.gitignore`에 고정된 repository 상대 경로다.
- `.db`, `.sqlite`, `-wal`, `-shm` 확장자를 전역 ignore하지 않는다. 의도적인 migration이나
  test fixture가 조용히 숨는 것을 막기 위해서다.
- 실제 secret, 사용자 기억, 운영 DB나 운영 backup을 개발 fixture로 복사하지 않는다.
- DB와 WAL은 local filesystem에만 둔다. NFS, SMB, 동기화 드라이브 같은 network filesystem
  위에서 WAL을 공유하는 구성은 지원하지 않는다.
- 여러 reader는 가능하지만 같은 DB를 향한 다중 writer process는 Recall v1에서 지원하지
  않는다. writer 직렬화 구현은 `STO-002`가 소유한다.

지원 여부가 불명확하면 DB를 만들지 않는다. startup이 filesystem을 명확히 판별하지 못하는
배포에서는 운영자가 실제 로컬 디스크인지 확인해야 하며, NFS·SMB·동기화 드라이브나 같은
DB의 다중 writer process를 허용하는 override는 없다.

## 작업 시작과 TDD 흐름

다음 순서를 바꾸지 않는다.

1. 현재 변경과 branch부터 확인한다.

   ```bash
   git status --short --branch
   ```

2. roadmap에서 선행 작업이 모두 `DONE`인 안정적 작업 ID를 고른다. 새 branch를 만든 뒤
   해당 작업을 단일 owner와 branch가 있는 `IN_PROGRESS`로 먼저 갱신한다. 허용 상태는
   `TODO`, `IN_PROGRESS`, `BLOCKED`, `DONE`뿐이며 retired ID는 재사용하지 않는다.
3. 연결된 Accepted ADR의 Decision/Validation, evidence-gap audit과 관련 spike scenario를
   읽는다. 이미 있는 baseline을 새 구현처럼 반복하지 않고 production gap만 범위로 잡는다.
4. 아직 없는 관찰 가능한 제품 동작 때문에 실패하는 test를 먼저 작성하고 기대한 `RED`를
   확인한다. 잘못된 import나 fixture 준비 실패는 RED 증거가 아니다.
5. 그 test를 통과시키는 최소 변경으로 target 계층을 `GREEN`으로 만든 뒤 빠른 전체 회귀를
   실행한다. 실제 scenario target을 구현한 작업만 같은 PR에서 manifest 상태를
   `planned`에서 `implemented`로 바꾼다.
6. diff 전체와 상태 경계를 리뷰한다. journal/projection 부분 commit, scope 누출, secret
   echo, spike import, 문서와 코드의 불일치를 확인한다.
7. 자신이 바꾼 경로만 명시적으로 stage한다. 아래 `<paths>`는 실제 경로 목록으로 바꾼다.

   ```bash
   git add -- <paths>
   ```

8. 한 가지 검토 가능한 의도로 commit하고 본문에 이유, 핵심 변경과 검증 명령·결과를
   기록한다. 다른 사람의 변경을 함께 정리하거나 stage하지 않는다.
9. branch를 push하고 작업 ID가 포함된 Draft PR을 만든다. PR 본문에는 범위, 관련 ADR,
   RED/GREEN, 전체 회귀, roadmap 변경과 남은 위험을 적는다.
10. 제출 전 로컬 gate와 authoritative unresolved review thread를 확인한다. 지적을 숨기거나
    임의로 resolve하지 말고 수정, blocker 또는 후속 작업으로 기록한 뒤 Draft를 해제한다.
11. 승인된 head를 merge한 다음 로컬을 기본 branch로 되돌려 동기화한다.

    ```bash
    git switch main
    git pull --ff-only origin main
    ```

12. 병합된 `main`에서 필수 검증을 다시 실행한다. 작업의 완료 체크, 증거와 상위 roll-up이
    모두 병합된 뒤에만 `DONE`으로 인계한다.

작업이 ADR과 충돌하면 편의상 우회하지 않는다. 원인, 필요한 결정과 해제 책임자를 적어
`BLOCKED`로 두고, 의미를 바꾸는 superseding ADR이 Accepted된 후 재개한다.

## 검증 선택표

| 변경 | 필수 로컬 검증 |
|---|---|
| 모든 production/test 변경 | `pnpm verify:local` |
| 문서 또는 roadmap 변경 | `python3 docs/roadmap/validate.py` |
| 상태 의미·spike 연관 변경 | `python3 -m unittest discover -s spikes/adr-behavior -p 'test_*.py' -v` |
| dependency 또는 lockfile 변경 | frozen install, `pnpm audit --prod`, `pnpm list --depth 0` |
| 성능 소유 작업 | `pnpm test:performance`와 해당 phase의 대표 fixture |

추가로 `git diff --check`를 실행하고, 실행하지 못한 검사는 성공으로 적지 말고 이유를 PR에
남긴다. 개별 작업의 더 구체적인 명령과 공통 Definition of Done은 phase 문서가 우선한다.

## clean source 재현

작업 완료 전에는 commit된 파일만 담은 임시 archive에서 설치와 빠른 검증을 한 번 더
재현한다. 다음은 POSIX 환경의 예시다.

```bash
RECALL_CLEAN_CHECKOUT_DIR=$(mktemp -d)
git archive HEAD | tar -x -C "$RECALL_CLEAN_CHECKOUT_DIR"
cd "$RECALL_CLEAN_CHECKOUT_DIR"
pnpm install --frozen-lockfile
pnpm verify:local
python3 docs/roadmap/validate.py
```

임시 경로에는 실제 secret이나 운영 DB를 넣지 않는다. 지원 OS별 packaging과 native
dependency 최종 검증은 `REL-009`의 release gate이며 이 로컬 확인이 대신하지 않는다.
