# STO-008: storage recovery와 concurrency 검증

- 상태: Accepted
- 결정일: 2026-08-22
- 작업: STO-008
- Owner: `log0629`
- PR: 이 작업 PR에서 확정
- 규범 근거: ADR-001, ADR-005
- 규범 관계: ADR을 대체하지 않는 production validation decision

## 기존 증거와 production gap

S20은 Python reference DB에서 직렬 writer와 WAL reader가 함께 동작함을, S24는 hard exit 뒤
SQLite가 commit 전 상태 또는 완전한 commit 상태로 복구됨을 확인했다. STO-002는 Node worker의
단일 FIFO writer와 독립 reader connection을, STO-003/004는 exact migration history와 v1
journal/FTS schema를, STO-007은 managed transaction을 사용하는 append-only repository를
구현했다.

이 baseline은 선택한 production stack을 여러 logical client가 동시에 사용하거나 process를
transaction 경계에서 강제 종료한 뒤 production startup·migration·repository로 다시 여는
증거가 아니다. STO-008은 새 저장 의미를 만들지 않고 이 integration gap을 닫는다.

## 결론

기존 production seam은 변경하지 않는다. 다음 두 file-backed process suite와 재사용 fixture를
검증 원본으로 둔다.

```text
S20 canonical target
  4 logical append clients ─┐
                            ├─ one managed FIFO writer → BEGIN IMMEDIATE
  4 independent WAL readers┘

STO-008 crash target
  seed through production adapter
      → IPC fault barrier
      → hard process exit
      → production startup + migration + repository reopen
```

- `test/e2e/process/s20-wal-concurrent-clients.test.mjs`
- `test/e2e/process/sto-008-journal-crash-reopen.test.mjs`
- `test/support/sqlite-mixed-client-fixture.mjs`

`runEightClientStorageFixture`는 Phase 08 `REL-004`가 MCP transport 뒤에서 event 수를 늘려
재사용할 수 있다. fixture는 production 코드에 포함하거나 runtime package에서 export하지
않는다.

## crash fault matrix

각 case는 별도 실제 SQLite file에서 시작한다. baseline schema와 statement는 production
startup gate, bundled migration과 journal repository로 만든다. child fixture는 fault 위치를
IPC로 알리고 기다리며 parent가 `SIGKILL`로 종료한다. 시간 지연이나 WAL file 크기를 fault
위치의 근거로 사용하지 않는다.

| fault 위치 | child가 확인한 local 상태 | 재개방 뒤 기대 상태 |
|---|---|---|
| `before-journal-insert` | transaction open, baseline journal/FTS 1개 | baseline 1개 |
| `after-journal-insert` | 새 journal과 trigger FTS를 포함해 2개, 미commit | baseline 1개 |
| `after-commit` | journal과 FTS 2개 commit 완료 | 두 사건 모두 보존 |

재개방은 raw driver가 아니라 production 경계를 사용한다. bundled migration은 새 version을
적용하지 않고 기존 version/name/checksum/applied_at을 그대로 확인해야 한다. journal ID와
seq, FTS rowid, `foreign_key_check`가 일치해야 하며 새 canonical event를 append하면 rollback된
seq는 재사용되고 commit된 seq 다음 번호는 연속해서 발급돼야 한다.

child fixture가 raw driver를 사용하는 이유는 production API에 fault hook이나 transaction
pause를 추가하지 않고 INSERT 후·COMMIT 전을 정확히 멈추기 위해서다. fixture는 규범 schema의
INSERT trigger만 실행하고, 복구와 후속 write 판정은 모두 production adapter가 수행한다. 이
방식은 test hook이 public/storage API에 남는 것보다 경계를 좁게 유지한다.

## WAL snapshot과 8-client 의미

WAL snapshot case는 production writer transaction의 journal INSERT 뒤에 유한 recursive query를
두어 commit을 지연한다. 별도 probe가 `BEGIN IMMEDIATE`에서 `SQLITE_BUSY`를 받아 writer lock
획득을 확인한 다음 네 production reader가 조회한다. 네 reader는 모두 baseline journal/FTS만
보고, writer commit 뒤에는 새 journal/FTS를 함께 본다.

8-client는 네 writer **process**가 아니다. ADR-005가 지원하는 구성은 한 서버 process의
writer queue 하나다.

- 4 logical writer request: 서로 다른 trusted scope/runtime을 가진 repository가 같은 factory에
  append하며 queue가 transaction을 직렬화한다.
- 4 reader client: 서로 다른 worker connection이 쓰기 중 반복 snapshot을 읽는다.
- 매 snapshot은 journal/FTS count, 네 scope count 합과 FK violation을 한 SQL statement에서
  읽는다. count는 감소하지 않고 journal/FTS는 같으며 scope 합은 전체와 같아야 한다.
- 최종 journal seq는 1부터 연속이고 ID는 유일하며 FTS rowid 배열은 journal seq 배열과 같다.

이 fixture는 손상·scope predicate 누락·torn FTS를 찾는 기능 integration이다. 처리량이나 p95
목표를 주장하지 않으며 실제 MCP 8-client, kill/restart와 성능 판정은 `REL-004`가 소유한다.

## scenario 상태와 후속 경계

S20의 production target은 serialized server writer, concurrent WAL readers와 FK integrity를
모두 검증하므로 `implemented`로 전환한다.

S24 canonical target은 `planned`를 유지한다. 이번 test는 journal/FTS와 storage reopen 부분만
닫는다. S24에는 projector 중간, projection meta, correct 다중 사건과 full replay fault point가
포함되며 PRJ-009/010과 REL-004가 남아 있다. STO-008 test를 S24 전체 parity 증거로 표현하지
않는다.

## 범위 경계

- projection table을 test fixture나 사용자 경로에서 직접 수정하지 않는다.
- journal+projection application commit과 replay recovery는 PRJ-009/010과 REC-006이 구현한다.
- 실제 MCP client와 request context, 여러 client의 transport lifecycle은 MCP-001/006과
  REL-004가 구현한다.
- 다른 writer process가 같은 DB에 쓰는 구성을 지원하거나 시험하지 않는다.
- 10만 event 성능과 snapshot trigger는 REL-001/002가 측정한다.
- 자동 CI는 추가하지 않으며 canonical local gate를 사용한다.

## 검증

```bash
pnpm test:sto-008
pnpm test:foundation
pnpm verify:local
python3 docs/roadmap/validate.py
python3 -m unittest discover -s spikes/adr-behavior -p 'test_*.py'
pnpm audit --prod
```

TDD RED는 S20 manifest를 `implemented`로 전환했을 때 canonical target file이 없어 foundation
contract가 거부한 결과다. target과 fixture를 추가한 뒤 STO-008은 6/6이며 세 번 연속 반복해
같은 결과를 확인한다.

## ADR 영향 검토

- ADR-001: hard exit 뒤 append-only journal이 old 또는 complete-new 상태만 남고 계속 쓸 수
  있음을 확인한다. projection crash parity가 아직 미완료임을 분리한다.
- ADR-005: 한 server writer queue, 여러 WAL reader, journal/FTS 동일 snapshot과 8 logical
  client의 무결성을 실제 file DB에서 확인한다.

Accepted ADR의 의미를 바꾸지 않으므로 superseding ADR은 필요하지 않다.
