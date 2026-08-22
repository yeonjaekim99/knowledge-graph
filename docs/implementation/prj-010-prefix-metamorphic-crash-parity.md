# PRJ-010: prefix oracle·metamorphic·crash parity

- 상태: 구현 완료
- 결정일: 2026-08-22
- 작업: PRJ-010
- Owner: `log0629`
- 규범 근거: ADR-001~010, ADR-017
- 선행 구현: PRJ-009, STO-008
- 구현 branch: `prj-010-prefix-parity`
- PR: [#30](https://github.com/yeonjaekim99/knowledge-graph/pull/30)

## 목적과 범위

PRJ-009는 production incremental dispatcher와 scope full replay, journal·FTS·projection·meta
원자 publish를 조립했지만 안전한 소수 prefix만 검증했다. PRJ-010은 새 상태
의미나 공개 API를 만드는 작업이 아니라, 완성된 Phase 03 projection 계약을 독립
production 회귀 suite로 닫는 작업이다.

이번 작업은 다음을 추가했다.

- S01~S24 각각의 journal로 표현 가능한 projection 이력 98 operation prefix
- 서로 다른 8개 고정 trace × 36 operation의 S23 288-prefix 적대적 회귀
- correct 2-event batch 분해, scope interleave, TTL time shift, merge/alias undo
- production worker transaction을 연 별도 Node process를 8개 시점에서 `SIGKILL`하는 S24
- 매 prefix의 scope·FK·FTS·support·`describes`·expiry·redirect·meta 불변식 검사

production `src/` 의미는 변경하지 않았다. 유효한 production fixture로 확대한 뒤
PRJ-009의 dispatcher/reducer가 모든 새 gate를 통과했기 때문이다.

## S01~S24 projection 경계

[`prj-010-projection-scenarios.mjs`](../../test/support/prj-010-projection-scenarios.mjs)는
Python spike를 import하지 않고 Accepted ADR과 production stored-event 계약으로 시나리오를
다시 작성한다. 각 operation은 다음만 가진 JSON-safe fixture다.

```text
scope + fixed created_at + one-or-more journal intents
```

S01~S24 모두를 실행하지만 각 scenario의 **projection으로 환원 가능한 부분**만
PRJ-010 증거로 주장한다. 예를 들어 S12는 그래프 간선과 리터럴이 올바르게 투영되는지,
S18은 이미 masking·preflight를 통과한 입력의 투영만 검증한다. traversal 응답,
secret 탐지, public correct/alias UX는 RCL/REC/REV owner가 각 target을 추가할 때까지
manifest의 `planned`를 유지한다.

PRJ-010이 그 자체로 완결한 production target은 다음 두 개다.

- S23: seeded prefix·metamorphic projection 불변식
- S24: process crash·reopen·full replay 원자성

따라서 scenario manifest에서 S23/S24만 `implemented`로 전환했고 S01~S22의 나머지
vertical target 상태는 변경하지 않았다.

## 모든 prefix의 byte parity

[`prj-010-sqlite-parity.mjs`](../../test/support/prj-010-sqlite-parity.mjs)는 두 경로를
독립적으로 만든다.

1. **누적 production 경로**: 실제 임시 SQLite file에 operation을 하나씩
   `SqliteProjectionDispatcher` 요청으로 commit한다.
2. **prefix full replay 경로**: 같은 operation prefix를 stored event envelope로 변환하고
   scope별로 `projectProjectionSnapshot` 전체 reducer를 새로 실행한다.
3. 두 결과를 서로 독립적인 table mapping으로 `recall-projection-v1` byte와
   SHA-256 둘 다 비교한다.

공통 parity harness도 checksum뿐 아니라 canonical byte 자체가 다르면 즉시
`REPLAY_PARITY_MISMATCH`로 실패하도록 강화했다. 오류에는 scenario ID, seed, prefix,
clock, locale과 두 checksum만 남고 event body나 DB 경로를 남기지 않는다.

매 actual prefix에서 다음 독립 SQL 검사도 실행한다.

- `PRAGMA foreign_key_check` 0건
- statement journal 수와 contentless FTS row 수 일치
- statement/entity/surface/claim/support의 scope 교차 참조 0건
- active claim의 live statement/live support 누락 0건
- active `(scope, subject, describes)` 중복 0건
- statement/support expiry 불일치 0건
- `projection_meta.last_seq` drift 0건
- self/dangling/cycle/32-hop 초과 redirect 0건

## S23 metamorphic 회귀

[`s23-seeded-state-machine.test.mjs`](../../test/integration/projection/s23-seeded-state-machine.test.mjs)는
고정 trace 8개에 statement, claim retraction, two-event correct, merge, alias, event retraction,
reinterpret과 두 scope를 조합한다. 각 trace는 36 operation이고 빈 상태를 제외한
288 operation prefix 전체가 production/full replay byte parity를 통과한다.

메타모픽 관계는 다음과 같다.

- correct를 하나의 two-event batch로 commit한 결과와 같은 두 사건을 분해한
  journal/projection이 정확히 같다.
- scope별 상대 순서를 보존한 global interleave는 ID/seq가 달라질 수 있으므로,
  ID를 제거한 scope semantic projection이 같다.
- 모든 event 시각을 같은 delta로 이동하면 created/first/last/expiry만 같은 delta로
  이동하고 나머지 byte는 같다.
- merge와 alias를 event retraction으로 취소한 최종 projection은 두 decision이 없던
  baseline의 canonical byte와 같다.

## S24 hard process crash

[`s24-crash-reopen.test.mjs`](../../test/e2e/process/s24-crash-reopen.test.mjs)는 별도
Node child process에서 production worker-backed projection dispatch session을 연다. child는 아래
8개 barrier에서 IPC로 준비를 알리고 parent에게 `SIGKILL`당한다.

```text
before journal insert
after journal insert
after full snapshot calculation / before publish
commit request race at 0ms, 1ms, 8ms
after commit
correct batch journal insert after both events
```

commit request 중에서 worker를 종료하는 정확한 instruction은 스케줄러에 따라 달라지므로
경합 3개는 old/new 둘 다 허용한다. 그러나 다음 조합 외에는 성공할 수 없다.

- old journal + old FTS + old projection + old meta
- complete-new journal + complete-new FTS + complete-new projection + complete-new meta

재개방 후 migration history, `integrity_check`, FK, seq, FTS, active describes, meta를 검사하고
저장 journal로 독립 full replay한 canonical byte와 비교한다. 마지막으로 새 alias
사건을 commit해 recovery 후 writer가 계속 사용 가능함도 확인한다.

## Spike와 production의 차이

- spike는 모든 write에서 full replay만 수행하지만 이 suite는 실제 dispatcher의
  incremental/replay 선택 결과를 독립 full reducer와 비교한다.
- spike의 Python `reference.py`, test module, crash worker를 import하거나 복사하지 않았다.
- spike의 public-like record/revise/recall assertion은 해당 application owner에 남고 PRJ-010은
  stored journal→projection 경계만 주장한다.
- spike의 scope interleave는 semantic snapshot을 비교했으며 production도 global seq에 따른
  occurrence ID 차이를 정상으로 보고 같은 비교를 사용한다.
- spike는 reducer 내부 fault hook를 쓰지만 production에 test hook을 추가하지 않고,
  IPC barrier와 commit request race로 실제 process 종료를 검증한다.

## TDD와 리뷰 결과

첫 scenario 실행은 S14/S15/S16/S23 fixture가 production stored-event 계약을 위반해
실패했다. supersedes successor의 raw_text/provenance/ttl 승계와 `relates_to` label 필수
계약을 fixture에 반영했다. 이는 준비되지 않은 fixture의 실패이지 product RED가
아니므로 production 수정 근거로 가장하지 않는다.

유효한 fixture로 다시 실행한 최초 상태에서 production parity·metamorphic·crash gate가
모두 GREEN이었다. PRJ-010은 새 제품 동작을 요구하는 구현 task가 아니라 PRJ-009에서
의도적으로 남긴 검증 task이므로, 인위적인 product 변경을 만들지 않았다.

자체 리뷰에서 다음을 확인했다.

- source/module boundary guard가 production의 spike import를 거부한다.
- parity mismatch error는 body, secret, SQL, DB path를 보유하지 않는다.
- 각 actual prefix는 file-backed SQLite와 worker transaction을 사용한다.
- S23/S24만 manifest `implemented`이며 나머지 vertical target을 과장하지 않는다.
- process fixture는 test 계층에만 있고 production protocol에 fault hook을 추가하지 않는다.

## 검증

```bash
pnpm verify:prj-010
pnpm test
python3 docs/roadmap/validate.py
pnpm verify:local
python3 -m unittest discover -s spikes/adr-behavior -p 'test_*.py' -v
pnpm audit --prod
```

완료 시점의 결과는 다음과 같다.

- `pnpm run verify:prj-010`: 39/39
- `pnpm test`와 `pnpm run verify:local`: 각각 232/232
- `pnpm test:foundation`: 57/57
- 독립 behavior spike: 25/25
- production dependency audit: 알려진 취약점 0개
- clean source archive: `pnpm 11.22.0` frozen lockfile 설치, 전체 local gate 232/232와
  roadmap audit 재현

roadmap validator, `git diff --check`와 PR diff 자체 리뷰도 통과했다. clean archive는
커밋된 source만 `git archive`로 풀어 검증했으므로 작업 tree나 상위 `node_modules`에
의존하지 않는다.

## 후속 경계

- REC-001~008: public `memory_record` validation, secret preflight, result와 dispatcher 연결
- REV-001~007: public retraction/correct/merge/alias application flow
- RCL-001~009: fixed-now aggregate, FTS/traversal/ranking/overview
- REL-002/004/007: 10만 replay, 실제 MCP mixed load kill/restart, rules rollout

Phase 03은 이 suite로 종료할 수 있으며 Phase 04와 Phase 06은 같은 projection/aggregate
계약에서 병렬 착수할 수 있다.
