# ADR-005: FTS 색인 대상, 토크나이저, 동기화

- 상태: Accepted
- 결정일: 2026-08-20
- 소유 영역: 초기 설계 2.6, 5.1, 9장 다중 클라이언트 항목
- 선행 ADR: 없음
- Supersedes: 초기 설계 2.6의 external-content FTS DDL

## Context

surface form exact lookup이 실패하면 사용자가 실제로 썼던 문장에서 진입점을 찾아야
한다. FTS는 그래프 탐색을 대신하지 않고 statement 후보를 찾는 보조 색인이다.

초기 DDL은 `content='journal'`과 FTS 컬럼 `raw_text`를 선언했지만 `journal`에는
`raw_text` 컬럼이 없고 JSON body 안에만 존재한다. SQLite external-content FTS는 필요한
컬럼을 content table에서 조회하므로 이 DDL은 규범으로 사용할 수 없다.

한국어는 조사와 어미 때문에 단어 경계 기반 tokenizer의 recall이 낮다. SQLite trigram은
부분 문자열 검색을 제공하지만 세 글자 미만 문자열을 MATCH하지 못한다.

## Decision

### contentless FTS

원문은 journal body에만 보존하고 FTS는 rowid와 역색인만 갖는 contentless 테이블로
만든다.

```sql
CREATE VIRTUAL TABLE journal_fts USING fts5(
  raw_text,
  content='',
  tokenize='trigram'
);

CREATE TRIGGER journal_ai AFTER INSERT ON journal
WHEN new.kind = 'statement' BEGIN
  INSERT INTO journal_fts(rowid, raw_text)
  VALUES (new.seq, json_extract(new.body, '$.raw_text'));
END;
```

- FTS `rowid`는 `journal.seq`와 같다.
- FTS 컬럼값을 결과로 읽지 않는다. contentless 테이블에서는 rowid 외 값이 NULL일 수
  있으며 원문은 항상 journal body에서 읽는다.
- journal이 append-only이므로 UPDATE/DELETE trigger는 없다.
- retraction 후에도 토큰은 남지만 statements 투영과 조인해 후보에서 제외한다.
- 비밀값 마스킹이 끝난 raw_text만 journal/FTS에 들어간다.

```sql
SELECT j.id, j.body, bm25(journal_fts) AS fts_score
FROM journal_fts
JOIN journal j    ON j.seq = journal_fts.rowid
JOIN statements s ON s.event_id = j.id AND s.state = 'live'
WHERE journal_fts MATCH :fts_query
  AND j.scope_key = :scope_key
  AND (s.expires_at IS NULL OR s.expires_at > :now)
ORDER BY fts_score ASC, j.seq DESC
LIMIT 21;
```

호출자는 상위 20개만 후보로 쓰고 21번째 행은 `more_available` 판정에만 사용한다.

FTS 결과의 statement가 뒷받침하는 현재 유효 claim이 있으면 그 claim의 개체를 seed로
삼는다. 저장된 `parsed`가 처음부터 빈 배열인 statement만 raw answer 후보가 된다.
parsed가 있었지만 claim이 철회·만료된 statement를 raw로 되살리지 않는다. statement와
claim 유효성 및 TTL의 정의는 ADR-010을 따른다.

### query 생성

- 사용자 query를 FTS 문법으로 직접 연결하지 않는다.
- 서버가 제어문자를 제거하고 `"`를 `""`로 escape한 뒤 하나의 quoted phrase로
  바인딩한다.
- terms가 여러 개면 각각 안전한 phrase로 만든 뒤 OR로 결합하되 최대 10개다.
- 세 Unicode code point 미만의 후보는 trigram MATCH로 보내지 않는다. surface lookup도
  실패했다면 `entry='none'`과 더 긴 표현을 요청하는 note를 반환한다.
- FTS syntax 오류는 내부 오류가 아니라 수정 가능한 빈 결과/note로 변환한다.

### 재구축과 최적화

FTS 전체 재구축은 같은 쓰기 잠금 아래 다음 순서로 실행한다.

```sql
INSERT INTO journal_fts(journal_fts) VALUES('delete-all');

INSERT INTO journal_fts(rowid, raw_text)
SELECT seq, json_extract(body, '$.raw_text')
FROM journal
WHERE kind = 'statement'
ORDER BY seq;

INSERT INTO journal_fts(journal_fts) VALUES('optimize');
```

대량 import, 전체 FTS 재구축 또는 마지막 optimize 뒤 10,000개 이상의 statement가
추가됐을 때만 maintenance에서 optimize한다. 사용자 tool 호출마다 실행하지 않는다.

### SQLite 연결과 동시성

DB를 처음 여는 writer가 `journal_mode=WAL`을 설정하고 반환값이 `wal`인지 확인한다.
그 뒤 모든 연결은 현재 mode가 `wal`인지 검증하고 나머지 connection-local 설정을
적용한다.

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous  = NORMAL;
PRAGMA busy_timeout = 5000;
PRAGMA cache_size   = -20000;
PRAGMA temp_store   = MEMORY;
PRAGMA foreign_keys = ON;
```

- DB 파일은 로컬 filesystem에 둔다. WAL을 network filesystem에서 공유하지 않는다.
- 여러 reader는 허용하고 서버 프로세스 안의 write queue가 write transaction을
  직렬화한다.
- 다른 프로세스가 같은 DB에 쓰는 구성은 v1에서 지원하지 않는다.
- 5초 안에 write lock을 얻지 못하면 retryable busy 오류를 반환한다.
- 시작 시 `fts5`, `trigram`, JSON 함수와 `unixepoch()` 지원 여부를 실제 query로 smoke
  test하고 하나라도 없으면 서버를 시작하지 않는다.

다중 클라이언트는 허용하지만 결국 SQLite writer는 하나다. v1의 지원 모델은 “여러
동시 reader + 서버가 직렬화한 단일 writer”로 확정한다.

## Alternatives

### journal을 external-content table로 직접 지정

raw_text가 실제 컬럼이 아니어서 FTS가 기대하는 content schema와 맞지 않는다. generated
column을 추가할 수도 있지만 journal의 최소 스키마와 중복 규범을 늘려 선택하지 않았다.

### contentful FTS

가장 단순하지만 불변 원문을 FTS shadow table에 한 번 더 저장한다. rowid만 필요한
사용 패턴에는 contentless가 충분하다.

### unicode61 또는 porter tokenizer

영어 단어 검색에는 적합하지만 한국어 조사 변화와 붙여쓰기 차이를 잘 흡수하지 못한다.
trigram의 세 글자 제한을 명시적으로 감수한다.

### 다중 writer 프로세스

WAL도 동시에 하나의 writer만 허용하며 프로세스 간 조율과 장애 모드가 늘어난다.
개인·소규모 팀 v1에는 단일 서버 writer가 더 예측 가능하다.

## Consequences

- 초기 external-content DDL 오류가 제거된다.
- 원문 중복 저장을 줄이는 대신 FTS에서 raw_text/snippet을 직접 읽을 수 없다.
- 두 글자 이하 검색은 surface form에 의존한다.
- reader는 writer와 병행할 수 있지만 긴 write/replay는 다른 write를 대기시킨다.
- SQLite 빌드 기능 차이를 시작 시 명확히 발견한다.

## Validation

- 깨끗한 SQLite DB에서 FTS DDL과 trigger를 생성해야 한다.
- 한국어 statement INSERT 후 세 글자 이상 부분 문자열 MATCH가 rowid를 반환해야 한다.
- 두 글자 MATCH가 결과를 주지 않는 동작을 테스트로 고정해야 한다.
- 철회 statement가 FTS 자체에는 남아도 join 결과에서는 제외돼야 한다.
- parsed claim을 모두 claim 철회한 live statement가 raw fallback으로 반환되지 않아야 한다.
- TTL이 지난 parsed=[] statement가 FTS join 결과에서 제외돼야 한다.
- delete-all, 전체 재삽입, optimize 뒤 검색 결과 집합이 같아야 한다.
- 8개 동시 client의 혼합 read/write 테스트에서 손상이나 scope 누출이 없어야 한다.
- 초기 writer 이후 새 reader 연결이 WAL mode를 바꾸려 하지 않고 `wal`을 검증해야 한다.

## References

- 초기 설계 2.6, 5.1
- ADR-001, ADR-010, ADR-012
- [SQLite FTS5](https://www.sqlite.org/fts5.html)
- [SQLite WAL](https://www.sqlite.org/wal.html)
- [SQLite PRAGMA](https://www.sqlite.org/pragma.html)
