# SQLite 저장 경로와 startup 운영 계약

- 소유 작업: `STO-001`, `STO-002`
- 규범 근거: ADR-005
- 적용 범위: Recall v1 production DB path·capability gate와 connection lifecycle

## 필수 설정

`RECALL_DB_PATH`에 SQLite database **절대 경로**를 명시한다. 기본값은 없으며 값 누락,
상대 경로, `:memory:`, `file:` URI, NUL, UNC/network 경로와 디렉터리 자체는 fail-closed한다.
오류에는 설정 원문이나 절대 경로, driver 오류와 SQL을 포함하지 않는다.

```bash
install -d -m 700 /var/lib/recall
export RECALL_DB_PATH=/var/lib/recall/recall.sqlite3
```

state directory는 startup 전에 존재해야 한다. gate가 임의 위치를 만들거나 기존 권한을
조용히 바꾸지 않는다. 개발 checkout 안에서만 사용할 경우 root `.gitignore`에 등록된
`/.recall/`을 사용할 수 있다.

## startup 순서

1. 설정값이 명시적인 절대 file 경로인지 확인한다.
2. state directory가 접근 가능한 실제 디렉터리이고 POSIX에서 `0700`인지 확인한다.
3. 실제 parent mount와 filesystem type을 검사해 알려진 network filesystem을 거부한다.
4. DB가 없으면 배타적으로 `0600`으로 만들고, 기존 DB는 regular file·비-symlink·`0600`을
   요구한다.
5. 해당 file을 readonly로 열어 SQLite version, FTS5, trigram 한국어 3글자 MATCH, JSON
   함수와 `unixepoch()`을 실제 query로 검사한다. probe의 virtual table은 TEMP라 영구
   schema를 만들지 않는다.
6. 네 capability가 모두 성공한 경우에만 immutable readiness를 반환한다. 하나라도 없거나
   query가 실패하면 `SqliteStartupError`로 종료한다.
7. readiness로 writer connection factory를 하나 만들고 WAL mode와 connection policy를
   검증한다. 이 단계가 실패하면 tool을 노출하지 않는다.

현재 MCP tool은 아직 구현되지 않았다. `MCP-001`은 이 readiness를 받은 뒤에만 tool을
노출해야 하며, startup error를 우회하는 fallback을 만들 수 없다.

## filesystem 지원 경계

DB, WAL과 SHM은 실제 local filesystem에 함께 둔다. NFS, SMB/CIFS, 9P, Ceph, SSHFS 및
동기화 드라이브 같은 network filesystem에서 WAL을 공유하는 구성은 지원하지 않는다.
UNC와 알려진 mount/filesystem type은 startup에서 거부한다. OS가 network mount를 로컬처럼
보고하는 경우까지 완전하게 탐지할 수는 없으므로, 알 수 없는 mount나 Windows mapped drive는
운영자가 로컬 디스크임을 확인해야 한다. 이를 허용하는 override는 제공하지 않는다.

여러 reader는 허용하지만 같은 DB를 향한 다중 writer process는 Recall v1에서 지원하지
않는다. process 안에서는 canonical DB path당 active writer factory 하나만 허용하고 write를
FIFO queue와 `BEGIN IMMEDIATE`로 직렬화한다. writer와 reader는 별도 worker connection을
사용하므로 5초 lock wait가 MCP event loop를 막지 않는다. 최초 writer만 WAL을 설정하며
재개방 writer와 reader는 현재 `wal`을 검증한다.

모든 connection은 `synchronous=NORMAL`, `busy_timeout=5000`, `cache_size=-20000`,
`temp_store=MEMORY`, `foreign_keys=ON`을 적용하고 실제 값을 검증한다. 5초 안에 writer
lock을 얻지 못하면 `retryable=true`, `timeoutMs=5000`인 `SqliteBusyError`를 반환한다.
오류에는 DB path, SQL, binding이나 driver cause가 포함되지 않는다.

## 권한 정책

| 대상 | POSIX 기본값 | 책임 |
|---|---:|---|
| state directory | `0700` | 배포 시 미리 생성하고 startup에서 검증 |
| DB | `0600` | 없으면 gate가 이 mode로 생성, 기존 file은 검증 |
| WAL (`-wal`) | `0600` | `STO-002` connection factory가 생성·검증 |
| SHM (`-shm`) | `0600` | `STO-002` connection factory가 생성·검증 |
| backup directory | `0700` | backup 배포 위치의 기본 정책 |
| backup | `0600` | `REL-009` backup 구현이 생성·검증 |

Windows에서는 POSIX mode bit가 ACL을 대신하지 않는다. 지원 target별 ACL과 DB/WAL/backup
실물 검증은 `REL-005`와 `REL-009`의 release gate에서 수행한다. 실제 secret, 사용자 기억,
운영 DB나 운영 backup을 test fixture로 사용하지 않는다.

## 아직 포함하지 않은 것

- `STO-003`: migration version/name/checksum runner
- `STO-004`: journal·projection·contentless FTS 영구 schema
- `STO-005`: user/project scope deployment config

startup/connection 단계는 위 작업을 대신하지 않고 DB에 영구 table이나 migration
metadata를 남기지 않는다. generic transaction helper가 실제 journal append나 projection을
구현한 것도 아니다.

## 검증

```bash
pnpm test:sto-001
pnpm test:sto-002
pnpm verify:local
python3 docs/roadmap/validate.py
```

integration test는 실제 OS 임시 file을 사용해 정상 startup·재개방, 잘못된 경로·권한,
network filesystem, capability별 누락과 driver 오류 redaction을 검증한다. connection test는
WAL/PRAGMA, sidecar mode, FIFO commit/rollback, 중복 writer, close drain과 실제 5초 lock 중
reader/event-loop 진행 및 timeout 뒤 queue 복구를 검증한다.
