# ADR-001: 저널/투영 2층 구조, 불변식, 재생·재해석 경계

- 상태: Accepted
- 결정일: 2026-08-20
- 소유 영역: 초기 설계 1장, 8.3~8.4, 9장 스냅샷 항목
- 선행 ADR: 없음
- Supersedes: 없음

## Context

Recall은 사용자가 말한 사실뿐 아니라 철회, 정정, 개체 병합과 별칭 확인을 장기간
보존해야 한다. 현재 상태만 저장하면 규칙 변경이나 유지보수 후 투영을 다시 만들 때
과거의 정정이 사라져 이미 지운 기억이 되살아날 수 있다.

서버에는 자연어 파서가 없다. agent가 원문을 `ClaimDraft[]`로 해석하고, 서버는 그
결과를 검증하고 저장한다. 따라서 서버가 규칙 변경 후 자동으로 다시 계산할 수 있는
범위와 agent가 원문을 다시 해석해야 하는 범위를 분리해야 한다.

초기 설계의 “서버 규칙 변경이 마이그레이션 없이 반영된다”는 표현은 의미 규칙에만
성립한다. CHECK 제약이나 컬럼처럼 물리 스키마가 바뀌면 스키마 마이그레이션이
필요하다.

## Decision

### 유일한 진실 원천

`journal`은 추가 전용이며 기억 상태의 유일한 진실 원천이다.

- 정상 동작에서 `journal` 행을 UPDATE하거나 DELETE하지 않는다.
- 기록, 철회, 정정, 병합, 별칭 확인은 모두 새 사건을 INSERT한다.
- 투영과 FTS는 파생물이며 언제든 삭제하고 저널에서 다시 만들 수 있다.
- 도구 핸들러나 관리 명령은 투영 테이블을 직접 수정하지 않는다.
- 투영 테이블을 변경할 수 있는 코드는 저널 사건을 입력으로 받는 projector뿐이다.

`journal`의 규범 스키마는 다음과 같다. 시간은 UTC Unix epoch **초** 단위다.

```sql
CREATE TABLE journal (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  id         TEXT NOT NULL UNIQUE,
  scope_key  TEXT NOT NULL,
  kind       TEXT NOT NULL
    CHECK (kind IN ('statement','retraction','merge','alias')),
  body       TEXT NOT NULL CHECK (json_valid(body)),
  actor      TEXT,
  branch     TEXT,
  session    TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_journal_scope ON journal(scope_key, seq);
```

`id`는 `ev_` 접두어가 붙은 ULID다. `seq`만이 재생 순서를 결정하며 ULID의 시간 순서는
재생 순서로 사용하지 않는다.

### 투영 적용과 일관성

projector는 같은 reducer를 두 방식으로 실행한다.

1. **증분 적용**: 마지막으로 반영한 사건 다음부터 적용한다.
2. **전체 재생**: 해당 scope의 투영을 비우고 유효 사건을 `seq` 순으로 다시 적용한다.

일반적인 statement, claim 철회, 새 merge/alias는 증분 적용할 수 있다. 과거 merge나
alias를 철회하거나 규칙 버전이 달라지는 등 앞선 사건의 의미가 바뀌면 전체 재생한다.
구체적인 사건별 판정은 ADR-007이 소유한다.

쓰기 도구는 `BEGIN IMMEDIATE` 트랜잭션 안에서 저널 INSERT와 필요한 투영 적용을
완료한 뒤 응답한다. 둘 중 하나라도 실패하면 전체 트랜잭션을 롤백한다. 따라서 성공
응답 이후 같은 scope의 recall은 새 상태를 보며, 비동기 eventual consistency는 v1에서
허용하지 않는다.

```sql
CREATE TABLE projection_meta (
  scope_key     TEXT PRIMARY KEY,
  last_seq      INTEGER NOT NULL,
  rules_version TEXT NOT NULL,
  rebuilt_at    INTEGER NOT NULL
);
```

- `last_seq`는 해당 scope에서 반영한 마지막 journal seq다.
- `rules_version`은 정규화, 어휘, 재생 규칙을 묶은 서버 상수다.
- 시작 시 행이 없거나 버전이 다르거나 journal의 마지막 seq보다 뒤처졌으면 응답을
  받기 전에 동기 catch-up 또는 전체 재생을 수행한다.
- WAL 독자는 전체 재생 트랜잭션이 커밋되기 전까지 이전의 일관된 스냅샷을 본다.

### 재생과 재해석

- **재생(replay)**은 저장된 사건 body를 현재 서버 규칙으로 다시 투영한다. 자연어를
  다시 파싱하지 않는다.
- **재해석(reinterpret)**은 agent가 기존 `statement.raw_text`를 다시 읽어 새
  `ClaimDraft[]`를 만든 뒤 `supersedes`가 있는 statement 사건을 추가하는 절차다.
- 재해석도 과거 행을 수정하지 않으며, 원문과 출처의 역사적 의미를 보존한다.
- 정확한 승계 규칙과 회귀 비교는 ADR-017이 소유한다.

### 규칙과 스키마 변경

- 정규화, 개체 해석, 현재 어휘 안의 매핑과 카디널리티 같은 **투영 의미 규칙**은
  `rules_version`을 올리고 재생해 반영한다.
- 랭킹·표시처럼 투영 행을 바꾸지 않는 읽기 규칙은 replay 없이 코드 버전과 golden
  recall 회귀로 배포한다.
- 테이블, 컬럼, CHECK, 인덱스가 달라지는 **물리 스키마 변경**은 명시적 SQLite
  마이그레이션을 수행한 뒤 재생한다.
- 새 관계를 CHECK 목록에 추가하는 일은 의미 변경과 스키마 마이그레이션을 모두
  요구한다.

물리 schema 이력은 memory journal과 분리한 운영 메타데이터에 append한다.

```sql
CREATE TABLE schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  checksum   TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);
```

서버는 tool을 노출하기 전에 bundled migration을 version 순으로 transaction 적용한다.
이미 적용된 version의 checksum이 코드와 다르거나 DB에 더 높은 미지원 version이 있으면
시작을 거부한다. version은 1부터 증가하는 양의 정수이며 checksum은 migration 파일의
정확한 UTF-8 byte에 대한 lowercase SHA-256 hex다. 적용한 migration 파일을 나중에
수정하지 않고 새 version을 추가한다. 이 표와 `projection_meta`는 기억 내용이 아니라
재생 안전성을 위한 운영 상태이므로 “모든 사용자 변경은 journal 사건” 불변식의
예외가 아니다.

### 스냅샷 도입 조건

v1에는 스냅샷을 넣지 않는다. 실제 데이터 또는 10만 사건 표준 fixture로 측정한 전체
재생 p95가 60초를 초과하는 결과가 세 번 연속 나오면 ADR-001의 후속 ADR에서
스냅샷을 검토한다. 스냅샷은 저널을 대체하지 않으며 `(scope_key, through_seq,
rules_version)`을 명시해야 한다.

## Alternatives

### 현재 상태만 저장

구현은 단순하지만 철회와 병합의 역사, 규칙 변경 전후 비교와 복구 근거를 잃는다.
재생 후 삭제한 기억이 부활할 수 있어 선택하지 않았다.

### 저널과 투영을 비동기로 갱신

쓰기 지연은 줄지만 성공한 `memory_revise` 직후 옛 상태가 조회된다. 개인 규모 v1의
정확성 요구보다 이점이 작아 선택하지 않았다.

### 모든 쓰기마다 전체 재생

가장 단순하고 정확하지만 사건 수에 비례하는 비용을 매번 지불한다. 같은 reducer를
사용하는 증분 적용과, 과거 의미가 바뀔 때의 전체 재생을 병행한다.

### 원문을 서버가 다시 파싱

서버가 LLM 파서와 모델 버전을 소유하게 되고 재현 가능성이 낮아진다. 파싱은 agent,
저장·검증·투영은 서버라는 경계를 유지한다.

## Consequences

- 모든 사용자 결정은 감사와 재현이 가능하다.
- projector reducer의 결정성과 사건 순서가 핵심 정확성 경계가 된다.
- 쓰기 지연에는 투영 적용 비용이 포함된다.
- 규칙 변경 전후를 같은 저널로 비교할 수 있다.
- 스키마 변경에는 여전히 일반적인 DB 마이그레이션이 필요하다.
- rules_version과 schema migration version은 서로 다른 수명과 검증 경로를 갖는다.
- 저널에 들어간 비밀값을 정상 사건으로 지울 수 없으므로 INSERT 전 검사가 필수다.

## Validation

- 같은 journal과 rules_version을 두 번 재생한 논리 투영이 동일해야 한다.
- 각 쓰기 실패를 journal INSERT 전, INSERT 후, projector 중간에 주입해도 부분 상태가
  커밋되지 않아야 한다.
- 성공한 write 직후 같은 scope의 recall이 새 상태를 반환해야 한다.
- merge와 alias를 철회한 뒤 전체 재생해도 철회 전 상태가 되살아나지 않아야 한다.
- rules_version 불일치 상태로 시작하면 조회를 제공하기 전에 재생해야 한다.
- migration checksum 불일치나 미지원 미래 schema version에서 server가 시작되지 않아야 한다.

## References

- 초기 설계 1장, 8.3, 8.4
- ADR-007, ADR-017
- [SQLite WAL](https://www.sqlite.org/wal.html)
