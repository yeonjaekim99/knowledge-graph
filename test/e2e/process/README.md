# Process end-to-end tests

별도 process의 hard exit, reopen과 동시 client 동작을 검증한다. 공통 규칙은
[`../../README.md`](../../README.md)를 따른다.

- `s20-wal-concurrent-clients.test.mjs`: 한 server writer queue를 공유하는 4 logical writer와
  4 WAL reader의 production scenario target
- `sto-008-journal-crash-reopen.test.mjs`: journal INSERT 전·후와 commit 뒤 hard exit의 storage
  범위 복구 증거. projection fault point를 포함한 S24 전체 target은 아니다.
- `fixtures/`: IPC fault barrier처럼 production API에 넣지 않는 process 전용 test harness
