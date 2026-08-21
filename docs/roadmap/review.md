# 구현 로드맵 자체 리뷰

- 리뷰일: 2026-08-21
- 대상: `docs/roadmap/`, evidence-gap audit, root README, contributor guide와 agent instruction 진입 파일
- 기준: Accepted ADR-001~017, ADR 전체 리뷰, behavior spike S01~S24
- 성격: 작성자 자체 교차 검토, PR #3~#17 누적 게시·로컬 검증과 2026-08-21 scope 재검토
- 결과: **Phase 01 종료 · Phase 02 5/8 진행 · 차단 결함 0개**

## 검토 결과

| 검토 축 | 결과 | 근거 |
|---|---|---|
| 작업 구조 | 통과 | 준비 7개 + active 제품 66개, retired stable ID 1개, active heading과 현황 행 1:1 |
| 의존성 | 통과 | 00→01→02→03 이후 record/recall 병렬, revise와 MCP/release gate 순서 일치 |
| ADR coverage | 통과 | ADR-001~017 모두 구현 작업과 production 검증 작업에 연결 |
| spike coverage | 통과 | S01~S24 모두 production 회귀 소유 작업에 연결 |
| 협업 상태 모델 | 통과 | stable ID, 단일 owner, 네 상태, blocker와 PR evidence 규칙 명시 |
| 에이전트 진입 계약 | 통과 | root `AGENTS.md` 단일 원본, `CLAUDE.md` import, roadmap 선확인 규칙 |
| evidence-gap | 통과 | historical 제품 ID 67개 각각 baseline, production gate 또는 범위 제외를 1회 대조 |
| 범위 통제 | 통과 | snapshot/cache/어휘/정규화 등 측정 전 결정은 Deferred로 격리 |
| 현재 상태 정확성 | 통과 | active 제품 구현 11/66, Phase 01 `DONE`, Phase 02 5/8, FND-006은 registry에 retired |

## 중점 검토와 반영 사항

1. 초기 설계 문구가 아니라 Accepted ADR을 기준으로 task를 만들었다. 특히 record는 반복 시
   support가 늘어 `idempotentHint:false`이고, relation_label은 claim column이 아니라 유효
   aggregate에서 계산하며, replay는 pre-scan+reduce 두 단계다.
2. claim 철회와 statement event 철회의 `describes` 복구 차이, 재해석 root order/effective
   metadata, cascade=false undo와 payload-bound approval을 별도 완료 체크로 고정했다.
3. spike에서 나온 네 production 위험을 [추적성 표](traceability.md)에 독립 귀속했다.
   aggregate SQL alias, ASCII token 경계, occurrence index, migration reopen checksum이 구현
   중 사라지지 않는다.
4. 성능 숫자는 구현 초반의 직감으로 닫지 않는다. 대표 baseline과 10만 규모 release
   fixture를 분리하고, 3회 연속 trigger 전 snapshot/cache 도입을 금지했다.
5. 공동 작업에서는 phase별 planning PR로 ready 작업을 배정하고, 구현 PR이 체크·증거·
   roll-up을 함께 갱신하도록 해 owner 중복과 문서 후행을 줄였다.
6. root `AGENTS.md`를 공통 규칙의 단일 원본으로 두고 Claude Code는 `CLAUDE.md`의
   `@AGENTS.md` import로 같은 계약을 읽게 했다. 현재 task를 규칙 파일에 고정하지 않고
   roadmap에서 조회하게 해 진행 상태의 이중 원본을 만들지 않았다.
7. 기존 roadmap은 spike 증거가 traceability에 있어도 task 시작 관점의 잔여 gap을 바로
   보여주지 못했다. historical 제품 ID 67개를 다시 대조해 baseline 감사 `[x]`와 production
   `TODO/DONE`을 분리했고, FND-001은 선택한 driver/SDK 조합의 검증만 요구하도록 고쳤다.
8. maintainer 결정으로 FND-006 자동 CI 작업을 active 범위에서 제외했다. ID는 registry와
   evidence audit에 보존하고, 로컬 test/기여 절차는 FND-005와 FND-007이 소유하도록 했다.
9. FND-005는 자동 CI 없이도 같은 TDD 경계를 공유하도록 7개 로컬 계층, 고정 실행 문맥,
   S01~S24 이전 manifest와 canonical replay parity harness를 추가했다. 24개 target은 실제
   제품 의미를 선점하지 않도록 모두 `planned`로 남기고 후속 owner를 고정했다.
10. FND-007은 exact runtime·frozen install부터 roadmap/TDD/PR 인계까지 한 기여 문서로
    연결했다. test와 실험 DB는 OS 임시 경로 또는 ignore된 `/.recall/`에 격리하고,
    network filesystem·다중 writer process 및 production 경로 구현은 후속 작업과 분리했다.
11. STO-001은 실제 file DB 경로에서 local filesystem·권한을 먼저 검사하고 readonly TEMP
    query로 FTS5·trigram·JSON·`unixepoch()` readiness를 발급한다. S01 전체를 완료로
    오인하지 않도록 영구 FTS/rebuild·normalize와 WAL/connection 경계는 후속 owner에 남겼다.
12. STO-002는 synchronous driver를 writer/reader worker에 격리하고 process당 writer
    factory 하나와 FIFO `BEGIN IMMEDIATE` queue를 구현했다. 실제 5초 lock 중에도 reader와
    main event loop가 진행하며 오류에는 path·SQL·binding·driver cause가 남지 않는다.
    migration/schema와 journal/projector atomicity, S20의 8-client 범위는 후속 owner에 남겼다.
13. STO-003은 exact-byte checksum과 immutable version history를 같은 managed writer
    transaction에 두고 정상·hard-exit reopen을 검증했다. 최초 schema, 실제 MCP startup과
    journal/projector recovery는 STO-004, MCP-001과 STO-007~008에 남겼다.
14. STO-004는 규범 v1 DDL을 별도 SQL asset으로 bundle하고 contentless trigram FTS, 한국어
    3글자/2글자 경계, rebuild와 partial unique/XOR/CHECK/FK를 실제 file DB에서 검증했다.
    normalize, append/recovery, projector/recall 의미와 startup 조립은 후속 owner에 남겼다.
15. STO-005는 project를 immutable deployment config로 고정하고 local explicit user와 remote
    authenticated principal을 분리한 zero-argument scope provider를 구현했다. ID 누락·형식
    오류·mode 혼합은 값이나 cause를 노출하지 않고 실패하며, 실제 authentication과 tool
    lifecycle 조립은 MCP-001/006에 남겼다.

## 의도적으로 남은 상태

- [PR #3](https://github.com/yeonjaekim99/knowledge-graph/pull/3)으로 roadmap을 `main`에
  게시했고 [PR #4](https://github.com/yeonjaekim99/knowledge-graph/pull/4)에서 agent
  instruction 계약과 기계 검증을 추가했다. [PR #5](https://github.com/yeonjaekim99/knowledge-graph/pull/5)는
  그 계약이 선행 증거를 실제로 재사용하도록 roadmap 표현과 검증기를 보강해 Phase 00을
  7/7로 종료했다.
- FND-001의 production 언어/runtime/SQLite driver/MCP SDK 선택은 구현 결정이다. 이
  로드맵 리뷰가 특정 stack을 선결정하지 않는다.
- 미착수 제품 task owner는 실제 planning 전까지 `unassigned`다. 시작·완료된 작업만
  planning/구현 PR에서 확정한 owner를 기록한다.
- Phase 01은 6/6으로 종료됐고 Phase 02는 5/8이다. trusted scope seam인 `STO-005`가
  완료되어 다음 dependency-ready 작업은 actor·branch·session을 제공하는 `STO-006`이다.
- 후속 peer review에서 새 문제가 발견되면 기존 ID 의미를 바꾸지 않고 roadmap 수정 PR로
  반영한다.

## 이번 자체 검증 결과

| 검증 | 결과 |
|---|---|
| `python3 docs/roadmap/validate.py` | PASS — phase 9, active task 73, historical task 74, retired 1, evidence audit 67/67, cycle 0 |
| 추적성 검사 | PASS — ADR 17/17, spike scenario 24/24 |
| Markdown link·공백·conflict marker 검사 | PASS — 오류 0 |
| STO-001~005 로컬 gate | PASS — scope 6/6, schema 4/4, migration 6/6, architecture/type/build와 Node test 75/75 |
| 깨끗한 source archive | PASS — frozen lockfile 설치, 전체 local gate 75/75와 roadmap audit 재현 |
| dependency audit | PASS — production 알려진 취약점 0개 |
| behavior spike 전체 회귀 | PASS — 25/25 |
| 변경 범위 | PASS — immutable local/remote scope adapter·test·운영 문서만 추가, metadata/journal/query/MCP wiring·자동 CI 추가 없음 |

## 게시 전 재현 검사

다음 검사를 roadmap PR에서 다시 실행한다.

```bash
git diff --check origin/main...HEAD
python3 docs/roadmap/validate.py
```

두 번째 검사는 모든 roadmap 변경 PR에서 필수 로컬 gate로 실행하고 결과를 PR에 남긴다.
