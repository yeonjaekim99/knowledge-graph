# PRJ-009: 증분 dispatcher와 원자적 projection publish

- 상태: 구현 완료
- 결정일: 2026-08-22
- 작업: PRJ-009
- Owner: `log0629`
- 규범 근거: ADR-001, ADR-007, ADR-017
- 선행 구현: PRJ-003~008
- 구현 branch: `prj-009-projection-dispatcher`
- PR: [#29](https://github.com/yeonjaekim99/knowledge-graph/pull/29)

## 목적과 범위

PRJ-004~008은 pre-scan, entity/claim/decision 상태 전이와 TTL 유효성을 각각 순수 reducer로
검증했지만 실제 write 경로에서 하나의 projection으로 조립되지는 않았다. journal append와
projection publish도 별도 transaction이라 write 성공 뒤 이전 projection을 읽거나 둘 중 하나만
남을 수 있었다.

이번 작업은 다음 production seam을 닫는다.

- PRJ-004 pre-scan → PRJ-007 structural reduce → PRJ-008 validity reduce를 조립한 canonical
  `ProjectionSnapshot` reducer
- 일반 statement, claim retraction, 새 merge·alias를 현재 snapshot에 적용하는 증분 reducer
- supersedes statement, event retraction, rules/meta drift와 projection 손상을 scope replay로 보내는
  dispatcher
- journal·FTS·projection·`projection_meta`를 하나의 worker-owned `BEGIN IMMEDIATE` transaction에서
  성공 또는 rollback하는 내부 adapter
- active support, `describes` 단일성, expiry, redirect terminal/cycle/depth, scope/FK와 final
  `last_seq` commit gate

전체 S01~S24 production parity와 process hard-exit prefix 검증은 PRJ-010, 공개 record/revise
application 입력과 결과 조립은 Phase 04/05가 소유한다. 이번 adapter는 public package root로
노출하지 않고 기존 `appendAndProject` application port 뒤의 내부 SQLite capability로 유지한다.

## reducer 조립과 dispatch 경계

`projectProjectionSnapshot`은 journal 전체를 다음 고정 순서로 조립한다.

```text
createProjectionReplayInput
  → preScanProjectionEvents
  → reduceMergeAliasState
  → reduceClaimValidityState
  → canonical ProjectionSnapshot validation/freeze
```

증분 경로는 현재 canonical snapshot과 새 journal suffix를 입력으로 받아 같은 normalize,
occurrence ID, body parser, identity, surface origin, lifetime 규칙을 재사용한다. 새 statement의
모든 occurrence를 먼저 anchor한 뒤 실제 suffix 순서로 statement/claim retraction/merge/alias를
적용한다. merge는 claim/support dedupe, `describes` 승자, redirect 압축과 earliest live kind를
다시 정합화한다. 모든 안전 사건 prefix에서 증분 결과를 위 전체 reducer 결과와 deep equality로
대조한다.

dispatcher의 분기는 다음과 같다.

| 조건 | 경로 | 이유 코드 |
|---|---|---|
| 정상 meta + 일반 statement/claim retraction/새 merge·alias | incremental | `safe_suffix` |
| supersedes statement 또는 event retraction | replay | `historical_event` |
| meta 없음 | replay | `missing_meta` |
| rules version 변경 | replay | `rules_version_changed` |
| meta와 직전 journal seq 불일치 | replay | `journal_sequence_changed` |
| 현재 projection invariant 또는 snapshot 계약 위반 | replay | `projection_invariant_failed` |

증분 reducer가 현재 projection 손상을 추가로 발견해도 부분 수선하지 않는다. 열린 transaction의
같은 journal snapshot으로 scope 전체를 다시 계산한다. 새 journal 자체가 유효하지 않으면 replay도
실패하고 transaction 전체가 rollback된다.

## 단일 transaction과 collision 재시도

dispatcher는 요청 경계에서 trusted runtime snapshot을 한 번만 캡처한다. scope, rules version,
recorded time과 actor/branch/session은 tool payload가 아니라 이 snapshot에서만 온다. event ID는 기존
journal repository와 같은 canonical gate 및 4회 full-batch collision 정책을 공유한다.

worker session은 다음 순서를 소유한다.

1. FIFO write queue에서 `BEGIN IMMEDIATE`를 시작하고 기존 meta, projection, journal seq를 읽는다.
2. batch 안의 어느 ID든 기존 journal과 충돌하면 한 행도 넣지 않고 rollback한다.
3. 충돌이 없으면 journal batch를 삽입한다. statement FTS trigger도 같은 transaction 안에서 실행된다.
4. process memory에서 dispatch 경로와 desired canonical snapshot을 계산한다.
5. incremental이면 바뀐 row만 upsert/delete하고, replay면 해당 scope projection만 FK 순서로 교체한다.
6. commit gate와 `MAX(journal.seq) == projection_meta.last_seq`를 확인하고 meta를 갱신한 뒤 commit한다.

projection publish나 gate가 실패하면 worker가 journal insert와 FTS trigger 결과를 포함해 rollback한다.
session finally는 오류 뒤 writer queue를 재사용할 수 있게 남은 transaction도 닫는다. 성공 응답은
commit 뒤에만 만들어지므로 이미 열려 있던 reader connection의 다음 query와 새 reader가 모두 새
완전 상태를 읽는다. 다른 scope의 projection row는 replay에서도 유지된다.

## commit gate

commit 직전 다음을 실제 SQLite에서 검사한다.

- `PRAGMA foreign_key_check`가 비어 있다.
- statement가 같은 scope의 statement journal event를 가리킨다.
- entity/surface/claim/support 참조가 같은 scope이고 orphan이 없다.
- 모든 active claim에 live statement의 live support가 하나 이상 있다.
- statement와 support expiry가 null-safe equality를 만족한다.
- active `describes`가 `(scope, subject)`마다 최대 하나다.
- redirect의 terminal이 같은 kind의 실제 row이며 cycle이 없고 최대 32 hop이다.
- transaction 안의 최종 scope journal seq가 계산에 사용한 seq 및 새 meta와 같다.

현재 projection이 이 gate의 scope-local 부분을 위반하면 replay로 복구한다. replay 뒤에도 전역 FK,
다른 scope 손상 또는 새 desired snapshot 자체가 gate를 통과하지 못하면 명확한 typed SQLite 오류로
rollback하며 성공으로 가장하지 않는다.

## TDD와 리뷰 반례

첫 RED는 production reducer, dispatch planner와 SQLite dispatcher export가 없어 module import에서
실패했다. 최소 조립 뒤 안전 prefix parity를 먼저 GREEN으로 만들고, 실제 file-backed SQLite
transaction fixture를 추가했다. 자체 리뷰에서 다음 반례를 확인했다.

- confirmed alias를 다음 statement가 사용한 뒤 merge해도 full replay와 같은 entity/claim이 남는다.
- explicit merge keep과 무관하게 earliest live kind가 유지된다.
- claim retraction은 해당 support만 끊고, supersedes/event retraction은 replay로 간다.
- missing/rules/last-seq/invariant meta 상태는 성공 응답 전에 scope replay된다.
- batch projection trigger 실패는 journal, FTS, projection과 meta를 모두 0행 상태로 되돌린다.
- 기존 event ID 충돌은 batch를 노출하지 않고 새 ID로 재시도하며 seq hole을 만들지 않는다.
- 이미 열린 reader와 새 reader 모두 commit 직후 상태를 읽고 다른 scope sentinel은 보존된다.
- 오류 객체와 메시지에 submitted body나 SQLite trigger 원문이 포함되지 않는다.

production source는 behavior spike를 import하거나 복사하지 않는다. PRJ-009 unit fixture는 독립 full
production reducer를 reference로 사용하고, 광범위한 spike S01~S24/metamorphic/crash 대조는 다음
PRJ-010에서 수행한다.

## 검증

```bash
pnpm verify:prj-009
pnpm test
python3 docs/roadmap/validate.py
pnpm verify:local
python3 -m unittest discover -s spikes/adr-behavior -p 'test_*.py' -v
pnpm audit --prod
```

완료 시점 기준 PRJ-009 target은 9/9이고 빠른 전체 suite는 193/193이다. architecture/type/build,
roadmap audit, 독립 behavior spike 25/25, clean source archive와 production dependency audit 결과도
완료 증거에 포함한다.

## 후속 작업 경계

- PRJ-010: S01~S24 전체 production prefix, metamorphic, crash/reopen parity
- REC-001~008: public `memory_record` 입력, secret preflight, partial result와 dispatcher 연결
- REV-001~007: public correction/retraction/merge/alias application flow와 ambiguity/approval
- RCL-001~009: fixed-now read transaction, FTS/traversal/ranking/overview와 성능
- REL-002/004/007: 10만 replay, multi-client kill/restart와 rules rollout 운영 gate

Accepted ADR 의미를 바꾸지 않으므로 superseding ADR은 필요하지 않다.
