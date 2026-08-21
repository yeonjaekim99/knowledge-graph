# SQLite 저장 경로와 startup 운영 계약

- 소유 작업: `STO-001`, `STO-002`, `STO-003`, `STO-004`
- 규범 근거: ADR-001, ADR-005
- 적용 범위: Recall v1 production DB path·capability gate, connection lifecycle, migration gate와
  v1 physical schema

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
8. 같은 writer queue에서 bundled migration의 version·name·checksum을 검증하고 아직 적용하지
   않은 version을 transaction으로 적용한다. 이 단계가 실패해도 tool을 노출하지 않는다.

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

## migration 운영 계약

bundled migration version은 양의 정수 1부터 빈틈없이 증가한다. runner가 입력을 version
순으로 정렬해 같은 `BEGIN IMMEDIATE` transaction에서 아직 적용되지 않은 migration을
차례로 실행하고, `schema_migrations`에 version, name, checksum과 서버가 제공한 UTC epoch
초를 기록한다. checksum은 migration source의 **정확한 UTF-8 byte**를 lowercase SHA-256으로
계산하므로 줄바꿈이나 공백만 바뀌어도 다른 migration으로 판정한다.

이미 적용된 version의 name 또는 checksum이 bundled source와 다르거나 DB가 현재 bundle보다
높은 version을 담고 있으면 startup을 중단한다. 적용된 파일을 수정하지 말고 다음 version을
추가해야 한다. migration source가 자기 transaction을 열거나 닫는 것은 금지하며, trigger의
`BEGIN … END` body는 transaction control로 보지 않는다. 실패한 migration의 DDL과 history는
함께 rollback된다.

STO-003 runner는 같은 transaction에서 `schema_migrations`를 먼저 bootstrap한다. STO-004의
`001-v1-schema.sql`은 journal, projection, redirect, projection metadata와 contentless trigram
FTS를 만든다. build는 SQL을 byte-for-byte로 `dist`에 복사하며 bundled loader는 배포 asset을
읽어 STO-003 runner에 전달한다. 최종 v1 schema와 책임 분리는
[구현 결정](../implementation/sto-004-v1-sqlite-schema.md)에 고정한다.

FTS를 복구할 때는 contentless table에 `delete-all`을 적용하고 journal의 statement만 seq
순으로 다시 넣은 뒤 `optimize`한다. FTS column에서 원문을 읽지 않으며, 철회·TTL 등 현재
상태 판정은 후속 recall query가 projection과 join해 수행한다.

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

- `STO-007`: append-only journal repository와 statement/FTS commit 경로
- Phase 03: projection reducer와 replay

user/project 설정, local/remote identity binding과 fail-closed 규칙은 별도
[scope 운영 계약](scope.md)에 고정한다.
actor, configured Git branch와 session HMAC 규칙은
[runtime metadata 운영 계약](metadata.md)에 고정한다.

v1 physical schema와 bundled runner entry는 존재하지만 실제 MCP process startup 조립은
`MCP-001`이 소유한다. schema가 있다는 사실만으로 tool을 노출하거나 projection table을
사용자 요청에서 직접 수정하지 않는다.

## 검증

```bash
pnpm test:sto-001
pnpm test:sto-002
pnpm test:sto-003
pnpm test:sto-004
pnpm verify:local
python3 docs/roadmap/validate.py
```

integration test는 실제 OS 임시 file을 사용해 정상 startup·재개방, 잘못된 경로·권한,
network filesystem, capability별 누락과 driver 오류 redaction을 검증한다. connection test는
WAL/PRAGMA, sidecar mode, FIFO commit/rollback, 중복 writer, close drain과 실제 5초 lock 중
reader/event-loop 진행 및 timeout 뒤 queue 복구를 검증한다.

migration test는 exact-byte checksum, version/name drift, future version, rollback, 정상 재개방과
열린 migration transaction에서 hard exit한 뒤의 재개방을 검증한다.

schema test는 exact source/dist byte, 최종 table·index·trigger·FK catalog, contentless FTS와
한국어 3글자/2글자 경계, rebuild, 실제 partial unique/XOR/CHECK/FK 실패와
`PRAGMA foreign_key_check`를 검증한다.
