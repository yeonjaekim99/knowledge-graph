# Recall — MCP Knowledge Graph 메모리 시스템 설계

> 상태: 설계 초안 · 이 문서의 각 절은 개별 ADR로 확정된다.
>
> 표기: `→ ADR-XXX` 는 해당 절이 분리될 ADR 후보.

## 이 문서를 읽는 법

- **DDL과 타입 정의는 규범(normative)이다.** 본문 설명과 어긋나 보이면 문서의
  버그이므로 ADR에서 지적하고 확정할 것. 예시(6장)는 규범이 아니다.
- **아직 안 정한 것은 8장에 모아뒀고 전부 담당 ADR이 배정돼 있다.** 8장에 없는데
  본문에서 애매하면 그것도 문서의 버그다.
- **층위 용어**
  - `event`(사건) — 저널에 추가되는 불변 기록. 유일한 진실 원천.
  - `statement`(진술) — 사건의 한 종류. 원문과 그로부터 쪼갠 초안을 담는다.
  - `claim`(사실) — 저널에서 도출된 그래프의 간선.
  - `entity`(개체) — 그래프의 노드.
  - `surface form`(표면형) — 개체를 가리키는 말. 노드가 아니라 진입 색인.

---

## 0. 무엇을 만드는가

에이전트(Claude, OpenCode 등)가 대화·작업 중 알게 된 사실을 기록하고 나중에
꺼내 쓰는 장기 기억 시스템. MCP 서버가 유일한 writer이며 SQLite 위에 올라간다.

```
에이전트 (Claude, OpenCode, …)
     │  MCP tool 호출
     ▼
Recall MCP Server ── 유일 writer
     │
     ▼
SQLite (저널 + 투영 + 검색 인덱스)
```

답해야 하는 질문은 한 종류다.

> "이 프로젝트에서 X에 대해 우리가 뭘 알고 있지?"

기억을 문장 뭉치가 아니라 개체 사이의 관계 그래프로 다루는 이유가 여기 있다.
"로그인"을 물어보면 인증서버를 찾고, 그것이 무엇을 쓰고 무엇을 거부했는지 경로를
따라 답할 수 있어야 한다. 저장할 때 쓴 표현과 물어볼 때 쓴 표현이 달라도 연결되어야
한다.

---

## 1. 중심 결정: 저널과 투영의 분리

```
┌───────────────────────────────────────────────────────┐
│  Layer 1. journal — 사건 저널                          │
│  추가 전용. UPDATE도 DELETE도 없다.                    │
│  기록·철회·병합·별칭확인 — 모든 변경이 여기 남는다.     │
│  이 층이 유일한 진실 원천이다.                          │
└───────────────────────────────────────────────────────┘
                    │  재생(replay)
                    ▼
┌───────────────────────────────────────────────────────┐
│  Layer 2. projection — 투영                            │
│  claims / entities / surface_forms / statements        │
│  전부 저널에서 계산되는 파생물. 통째로 버리고           │
│  다시 만들 수 있다.                                     │
└───────────────────────────────────────────────────────┘
                    │  색인
                    ▼
┌───────────────────────────────────────────────────────┐
│  Layer 3. FTS — 진입 보조 색인                          │
└───────────────────────────────────────────────────────┘
```

### 1.1 규칙: 모든 변경은 사건이다

이 설계의 유일한 불변식이다.

> **투영 층을 직접 수정하는 경로는 존재하지 않는다.**
>
> 사용자·에이전트가 일으키는 모든 변화 — 기록, 철회, 정정, 개체 병합,
> 표면형 확인 — 은 저널에 사건으로 추가되고, 투영은 저널을 재생해서만 바뀐다.

정정이나 병합을 투영 층에 직접 쓰면, **재생하는 순간 그 결정이 사라진다.**
"지워달라"고 지운 사실이 유지보수 작업 한 번에 되살아나는 것이 이 시스템에서
가능한 가장 나쁜 버그이며, 위 불변식은 그걸 구조적으로 불가능하게 만든다.

### 1.2 이 구조로 얻는 것

**모든 결정이 재현된다.** 재생은 저널을 순서대로 다시 적용하는 것이므로, 정정과
병합을 포함한 현재 상태가 그대로 복원된다.

**id가 재생을 견딘다.** 발급 순서가 저널 순서에서 결정되므로 재생해도 같은 id가
나온다 (2.2). 해시를 쓰지 않으므로 정규화 규칙이 바뀌어도 id 체계가 깨지지 않는다.

**신뢰도와 상충을 저장하지 않아도 된다.** 둘 다 저널에서 도출되는 값이므로 읽을
때 계산한다 (4.3, 4.4).

**서버 규칙 변경이 마이그레이션 없이 반영된다.** 정규화 기준, 개체 해석, 관계
어휘 매핑, 카디널리티, 상충 판정을 바꾸고 재생하면 전체에 적용된다 (7.3).

**되돌리기가 가능하다.** 병합이 잘못됐으면 그 병합 사건을 철회하는 사건을 추가하면
된다. 투영을 직접 고치는 설계에서는 불가능한 동작이다.

### 1.3 이 구조로 얻지 못하는 것 — 명확히 해둘 것

**서버는 파서를 갖지 않는다.** 문장을 쪼개는 일은 agent(LLM)가 하고 서버는 그
결과를 받는다. 따라서 **재생해도 문장이 다시 쪼개지지는 않는다.** 재생은 저장된
초안(`parsed`)을 현재 서버 규칙으로 다시 투영하는 것이지 원문을 다시 해석하는 게
아니다.

문장 분할 방식을 개선해 과거 기록에 소급 적용하려면 **재해석(reinterpret)** 이라는
별도 절차가 필요하며 agent가 수행한다 (7.4).

| | 주체 | 입력 | 비용 | 무엇을 고칠 수 있나 |
|---|---|---|---|---|
| **재생(replay)** | 서버 | `journal` 전체 | 낮음, 자동화 가능 | 정규화·개체해석·어휘매핑·카디널리티·상충판정 |
| **재해석(reinterpret)** | agent | `statement.raw_text` | 높음, 수동 트리거 | 문장 분할 방식, 관계 선택 |

**재생 비용은 사실 수가 아니라 사건 수에 비례한다.** 개인·팀 규모에서는 문제되지
않으며, 커지면 스냅샷(특정 사건까지 재생한 투영을 저장해두고 이후만 적용)을 얹을
수 있다. 저널이 온전하면 언제든 추가 가능한 최적화이므로 지금 설계에는 넣지 않는다.

→ `ADR-001: 저널/투영 2층 구조, 불변식, 재생·재해석의 경계`

---

## 2. 저널

이 장의 DDL은 규범이다.

### 2.1 journal

```sql
CREATE TABLE journal (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,  -- 재생 순서. 유일한 순서 기준.
  id         TEXT NOT NULL UNIQUE,               -- "ev_" + ULID (외부 참조용)
  scope_key  TEXT NOT NULL,
  kind       TEXT NOT NULL
    CHECK (kind IN ('statement','retraction','merge','alias')),
  body       TEXT NOT NULL,                      -- kind별 JSON (2.3)
  actor      TEXT,                               -- 'claude' | 'opencode' | ...
  branch     TEXT,                               -- 참고용 메타데이터
  session    TEXT,                               -- 참고용 메타데이터
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_journal_scope ON journal(scope_key, seq);
```

**UPDATE도 DELETE도 하지 않는다.** 철회는 `retraction` 사건을 추가하는 것이지
기존 행을 고치는 게 아니다. 이 성질 덕분에 FTS 동기화가 INSERT 트리거 하나로
끝난다 (2.6).

`actor`, `branch`, `session`은 **서버가 채운다.** `actor`는 MCP 초기화 시
클라이언트가 보내는 정보에서, `branch`는 서버가 직접 git 상태를 조회해서,
`session`은 프로토콜 세션 id에서 얻는다. agent가 파라미터로 넘기지 않는다.

### 2.2 식별자 — 사건에 고정하는 방식

재생해도 안정적인 id가 필요하다. agent가 조회로 받은 `claim_id`를 정정에 쓰기
때문이다 (3.3).

**전역 카운터도, 내용 해시도 쓰지 않는다.** 전역 카운터는 규칙 변경으로 개체 둘이
하나로 합쳐지면 이후 번호가 전부 밀린다. 내용 해시는 정규화 규칙이나 병합으로
입력이 바뀌면 id 자체가 바뀐다 — 즉 **가장 흔한 재생 사유에서 정확히 깨진다.**

**id를 그 대상이 처음 등장한 사건에 고정한다.**

```
entity_id = "e" + <최초 등장 사건의 seq> + "." + <그 사건 안에서의 등장 순번>
claim_id  = "c" + <최초 등장 사건의 seq> + "." + <parsed 배열에서의 인덱스>
```

재생 시 저널을 순서대로 훑으며, 이미 존재하는 대상이면 기존 id를 재사용하고
처음 보는 것이면 위 규칙으로 발급한다. 사건 seq는 불변이므로 **id는 앞선 사건들의
해석 결과가 바뀌어도 흔들리지 않는다.**

규칙 변경으로 서로 다르던 두 개체가 하나로 합쳐지면 **먼저 등장한 쪽의 id가
남는다.** 사라진 id를 들고 있는 agent를 위해 재생 시 리다이렉트를 남긴다.

```sql
CREATE TABLE id_redirects (
  old_id TEXT PRIMARY KEY,
  new_id TEXT NOT NULL,
  reason TEXT NOT NULL      -- 'merge' | 'rule_change'
);
```

조회·정정 시 들어온 id는 항상 이 표를 거쳐 해석한다.

→ `ADR-002: 식별자 발급 규칙과 재생 안정성`

### 2.3 사건 종류별 body

**`statement`** — 사실 진술

```typescript
{
  raw_text: string,
  parsed: ClaimDraft[],            // 빈 배열 허용
  provenance: "user_stated" | "observed" | "inferred",
  ttl: "session" | "weeks" | "permanent",
  supersedes?: string              // 재해석일 때 원본 statement 사건 id (7.4)
}
```

**`retraction`** — 철회

```typescript
{
  target: { claim_id: string } | { event_id: string },
  note?: string
}
```

두 범위의 차이는 3.3.1에서 다룬다. `event_id` 대상은 `statement`뿐 아니라
`merge`·`alias` 사건도 가리킬 수 있다 — 그래서 병합 취소가 가능하다.

**`merge`** — 개체 병합

```typescript
{ keep: string, absorb: string }   // entity_id
```

**`alias`** — 표면형 확인

```typescript
{ surface: string, entity_id: string }
```

### 2.4 scope — 무엇이 경계이고 무엇이 아닌가

기억이 프로젝트 경계를 넘어 새는 것이 가장 큰 사고다. 동시에 경계를 너무 잘게
자르면 기억이 조회되지 않아 시스템이 무용지물이 된다.

**`scope_key`는 사용자와 프로젝트, 두 요소로만 구성한다.**

```
scope_key = "u:{user_id}/p:{project_id}"
```

| 요소 | scope_key에 포함? | 결정 주체 | 이유 |
|---|---|---|---|
| user | ✅ | 서버 연결 시 인증 정보 | 다른 사용자의 기억이 보이면 안 됨 |
| project | ✅ | 서버 기동 설정(`.mcp.json`, 실행 경로) | 프로젝트 간 격리가 핵심 경계 |
| repo | ❌ (project에 흡수) | — | 멀티 리포 프로젝트에서 리포마다 갈리면 해로움 |
| branch | ❌ (사건 메타데이터) | 서버가 git 조회 | 브랜치를 갈아탄다고 기억이 사라지면 안 됨 |
| session | ❌ (메타데이터 + TTL) | 프로토콜 세션 id | 세션이 경계면 다음 대화에서 아무것도 못 찾음 |

저장과 조회 모두 같은 수준(`u/p`)을 쓴다. 요소가 둘뿐이라 걸어 올라갈 계층이 없으므로
접두어 매칭은 쓰지 않는다.

**`scope_key`는 agent가 넘기는 파라미터가 아니다.** agent가 자기 위치를 잘못
주장하면 경계가 무너진다. agent가 조절할 수 있는 것은 `ttl`로 수명을 짧게 하는
것뿐이며, 범위를 넓히는 방향은 인터페이스에 없다.

→ `ADR-003: scope_key 구성과 결정 경로`

### 2.5 관계 어휘 — 닫힌 집합과 열린 라벨의 병행

고정 목록을 강제하면 agent가 맞는 항목을 못 찾아 엉뚱한 걸 고르거나 저장을
포기한다. 완전히 자유롭게 두면 `uses`/`use`/`사용`/`utilizes`가 난립해 그래프가
조각난다. **둘 다 저장한다.**

| relation | 의미 | 카디널리티 | 예 |
|---|---|---|---|
| `uses` | 의존·사용·요구 | 다중 | 인증서버 → 서버세션 |
| `rejects` | 배제·거부·탈락한 선택지 | 다중 | 인증서버 → JWT |
| `contains` | 포함·위치·소속 | 다중 | 리포 → 인증모듈 |
| `describes` | 속성·설정값·상태 | **단일** | 테스트 → "pnpm test" |
| `relates_to` | 위 어디에도 안 맞는 연결 | 다중 | (탈출구) |

`relation_label`에는 agent가 실제로 쓴 표현을 그대로 담는다. 표시(5.5)와 어휘
승격 판단(7.1)에 쓴다.

**카디널리티는 어휘의 속성이고 4.2의 대체 규칙이 여기에 의존한다.** `describes`만
단일이므로 같은 주어에 새 값이 오면 이전 값이 대체된다. 나머지는 다중이라 목적어가
다르다고 자동 대체되지 않는다 — "인증서버가 세션을 쓴다"와 "인증서버가 PostgreSQL을
쓴다"는 둘 다 참일 수 있다.

**`relates_to`가 탈출구인 것이 핵심이다.** 확신이 없으면 이걸 고르면 되고 저장은
성공한다. 나중에 `relates_to`에 쌓인 `relation_label`을 집계해
"`configures`가 40번 나왔으니 승격하자"를 데이터로 결정한다.

**별칭 계열 관계(`same_as` 등)는 어휘에 없다.** 별칭은 개체 사이의 사실이 아니라
개체를 가리키는 말이므로 표면형(3장)과 `alias` 사건으로 다루고, 동일 개체 판정은
`merge` 사건으로 다룬다. 관계로 두면 탐색 시 "로그인 → 인증서버 → 인증 서버" 같은
무의미한 경로가 답에 섞인다.

→ `ADR-004: 관계 어휘, 카디널리티, 승격 절차`

### 2.6 FTS

FTS는 표면형 조회가 실패했을 때 **진입점을 찾기 위한** 보조 색인이다. 그래프 탐색
자체에는 관여하지 않는다.

```sql
CREATE VIRTUAL TABLE journal_fts USING fts5(
  raw_text,
  content='journal',
  content_rowid='seq',
  tokenize='trigram'
);

CREATE TRIGGER journal_ai AFTER INSERT ON journal
WHEN new.kind = 'statement' BEGIN
  INSERT INTO journal_fts(rowid, raw_text)
  VALUES (new.seq, json_extract(new.body, '$.raw_text'));
END;
```

**트리거가 INSERT 하나뿐인 것은 저널이 진짜로 불변이기 때문이다.** 철회를
`retracted_at` 같은 컬럼 갱신으로 표현했다면 UPDATE 트리거와 재색인 처리가 필요했을
것이다. 철회된 진술은 색인에 남아 있지만, 5.1에서 투영(`statements.state`)과 조인해
걸러낸다 — 색인은 후보 생성기이고 판정은 투영이 한다.

색인 대상이 개체 이름이 아니라 **원문**인 이유: 표면형 조회 실패는 "이 표현이 개체
이름과 안 맞는다"는 뜻이므로 이미 실패한 이름 목록을 다시 뒤지는 건 도움이 안 된다.
원문에는 사용자가 실제 쓴 표현이 남아 있다.

한국어는 조사·어미로 어절 경계가 흐려지므로 `trigram`을 쓴다. `porter`/`unicode61`은
영어 스테밍용이라 "서버가"/"서버를"을 같은 토큰으로 묶지 못한다.

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous  = NORMAL;
PRAGMA busy_timeout = 5000;
PRAGMA cache_size   = -20000;
PRAGMA temp_store   = MEMORY;
PRAGMA foreign_keys = ON;
```

대량 변경·재생 후 `INSERT INTO journal_fts(journal_fts) VALUES('optimize')`.

→ `ADR-005: FTS 색인 대상, 토크나이저, 동기화`

---

## 3. 투영

전부 저널에서 재생성된다. **이 장의 어떤 테이블도 사용자 요청으로 직접 수정되지
않는다** (1.1).

### 3.1 스키마

```sql
CREATE TABLE statements (            -- statement 사건의 현재 상태
  event_id   TEXT PRIMARY KEY,
  scope_key  TEXT NOT NULL,
  state      TEXT NOT NULL CHECK (state IN ('live','retracted','superseded')),
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_statements_live ON statements(scope_key) WHERE state = 'live';

CREATE TABLE entities (
  id          TEXT PRIMARY KEY,      -- 2.2
  scope_key   TEXT NOT NULL,
  name        TEXT NOT NULL,
  normal_name TEXT NOT NULL,
  kind        TEXT,                  -- 참고용
  merged_into TEXT REFERENCES entities(id),   -- merge 사건 재생 결과
  origin_seq  INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_entities_normal
  ON entities(scope_key, normal_name) WHERE merged_into IS NULL;

CREATE TABLE surface_forms (
  scope_key    TEXT NOT NULL,
  surface_norm TEXT NOT NULL,
  entity_id    TEXT NOT NULL REFERENCES entities(id),
  origin       TEXT NOT NULL CHECK (origin IN ('name','agent_supplied','confirmed')),
  PRIMARY KEY (scope_key, surface_norm, entity_id)
);

CREATE INDEX idx_surface_lookup ON surface_forms(scope_key, surface_norm);

CREATE TABLE claims (
  id             TEXT PRIMARY KEY,   -- 2.2
  scope_key      TEXT NOT NULL,
  subject_id     TEXT NOT NULL REFERENCES entities(id),
  relation       TEXT NOT NULL
    CHECK (relation IN ('uses','rejects','contains','describes','relates_to')),
  relation_label TEXT,               -- 가장 최근 진술의 표현 (3.3)
  object_id      TEXT REFERENCES entities(id),
  object_value   TEXT,
  state          TEXT NOT NULL CHECK (state IN ('active','superseded','retracted')),
  first_seen_at  INTEGER NOT NULL,
  last_seen_at   INTEGER NOT NULL,
  CHECK ((object_id IS NULL) <> (object_value IS NULL))
);

CREATE TABLE claim_support (
  claim_id   TEXT NOT NULL REFERENCES claims(id),
  event_id   TEXT NOT NULL REFERENCES journal(id),   -- statement 사건
  live       INTEGER NOT NULL DEFAULT 1,             -- retraction 재생 결과
  expires_at INTEGER,                                -- 이 진술의 TTL (3.4)
  PRIMARY KEY (claim_id, event_id)
);

CREATE INDEX idx_support_event ON claim_support(event_id);

-- 탐색용. active만 담아 죽은 사실이 쌓여도 탐색 비용이 늘지 않는다.
CREATE INDEX idx_claims_subject ON claims(subject_id, relation) WHERE state='active';
CREATE INDEX idx_claims_object  ON claims(object_id,  relation) WHERE state='active';

-- describes 단일 카디널리티를 DB가 강제한다 (2.5, 4.2)
CREATE UNIQUE INDEX idx_claims_describes_single
  ON claims(scope_key, subject_id)
  WHERE state='active' AND relation='describes';
```

**저장하지 않는 것**: 신뢰도(4.3), 상충 여부(4.4), 사실의 만료 시각(3.4).
전부 파생값이라 저장하면 갱신 지점이 흩어지고 조용히 틀린 값이 남는다.

`claim_support.expires_at`은 파생값이 아니라 **그 진술이 선언한 TTL 자체**이므로
저장한다. 사실의 만료는 여기서 집계한다.

### 3.2 정규화 (`normalize`)

`normal_name`과 `surface_norm` 양쪽에서 쓴다. 강도가 품질을 크게 좌우한다.

- 약하면 "인증서버"와 "인증 서버"가 갈려 같은 것이 흩어진다.
- 강하면 "인증서버"와 "인증 서비스"가 뭉쳐 다른 것이 섞인다.

**초기 규칙**: 소문자화 → 유니코드 NFKC → 공백·하이픈·언더스코어 제거 → 양끝 정리.
한국어 조사 제거는 하지 않는다 — "세션을"의 "을"과 단어 끝의 "을"을 구분하지 못해
오작동 위험이 있고, 표면형 등록으로 대부분 해결된다. 7.1 지표를 보고 재검토한다.

이 규칙에서 **"인증서버"와 "인증 서버"는 같은 개체가 된다**(공백 제거). 병합이
필요한 실제 사례는 정규화로 이어지지 않는 표기다 — `인증서버` vs `auth-server`,
`PostgreSQL` vs `주 DB` 같은 경우이며, 이건 표면형 등록이나 `merge` 사건으로만
연결된다.

→ `ADR-006: 정규화 규칙과 강도`

### 3.3 재생 규칙

저널을 `seq` 순으로 훑으며 투영을 만든다. 각 사건 종류별 처리다.

**`statement`**

1. `statements`에 `state='live'`로 등록. `supersedes`가 있으면 그 대상을
   `superseded`로 표시.
2. `parsed`의 각 초안에 대해:
   - `subject`/`object` 이름을 정규화해 개체를 해석한다. 없으면 2.2 규칙으로 발급.
     `merged_into`가 있으면 흡수한 쪽으로 치환한다.
   - 별칭(`subject_aliases`/`object_aliases`)을 `origin='agent_supplied'`로 등록.
   - 사실을 찾거나(같은 `scope/subject/relation/목적어`) 없으면 2.2 규칙으로 발급.
   - **카디널리티 검사를 먼저 한다.** `describes`이고 같은 주어에 다른 값의 사실이
     `active`면 그것을 `superseded`로 내린다.
   - 그 다음 사실을 `active`로 만들고, `claim_support`에 이 사건을 연결한다
     (`expires_at`은 3.4 규칙으로 계산).
   - `relation_label`은 **가장 최근 진술의 값으로 덮어쓴다.** 최근 표현이 현재
     어휘에 가깝다고 보기 때문이다.

   순서가 중요하다. 카디널리티 검사를 활성화보다 **먼저** 해야, 한 번 대체됐던
   `describes` 값이 다시 진술될 때 이전 값과 둘 다 살아나는 사태를 막는다.

**`retraction`**

- `target.claim_id` → 그 사실을 향한 `claim_support`의 `live`를 0으로. 유효 support가
  0이 되면 사실을 `retracted`로. **진술과 같은 진술에서 나온 다른 사실은 그대로.**
- `target.event_id`가 `statement` → 그 진술을 `retracted`로 하고, 그로부터 나온
  모든 support의 `live`를 0으로. 영향받은 사실들을 각각 재평가.
- `target.event_id`가 `merge` → 그 병합을 무효로 간주하고 재생을 계속한다.
  결과적으로 개체가 다시 갈라진다.
- `target.event_id`가 `alias` → 그 표면형 등록을 건너뛴다.

**`merge`**

- `absorb` 개체에 `merged_into = keep`을 설정한다.
- 이후 재생에서 `absorb`로 해석되는 이름은 전부 `keep`으로 치환된다.
- 이미 만들어진 사실 중 `absorb`를 참조하는 것은 `keep`으로 바꾼 형태의 사실과
  동일해질 수 있다. 이때 **먼저 등장한 쪽의 id가 남고**, 사라진 id는
  `id_redirects`에 남긴다 (2.2).
- 표면형은 `INSERT OR IGNORE`로 옮긴다 — PK가 `(scope, surface, entity)`라
  이미 같은 표면형이 `keep`에 있으면 충돌하기 때문이다.

**`alias`**

- `surface_forms`에 `origin='confirmed'`로 등록.

→ `ADR-007: 재생 규칙과 사건별 처리 순서`

### 3.4 TTL과 만료 (단일 출처)

진술이 선언한 `ttl`이 `claim_support.expires_at`이 된다. `ttl`이 생략되면
`provenance`에서 파생한다.

| provenance | 생략 시 ttl |
|---|---|
| `user_stated` | `permanent` |
| `observed` | `permanent` |
| `inferred` | `weeks` |

| ttl | `expires_at` |
|---|---|
| `session` | 사건 시각 + 12시간 |
| `weeks` | 사건 시각 + 30일 |
| `permanent` | NULL |

**사실의 만료는 저장하지 않고 support에서 집계한다** (4.3). 유효 support 중 하나라도
무기한이면 그 사실은 무기한이다. 이렇게 하면 `inferred`로 30일 시한부로 들어온
사실이 나중에 사용자가 확인해주면 **자동으로 무기한이 된다** — 저장 방식이었다면
강화 시 만료 시각을 다시 계산하는 로직을 따로 넣어야 했고, 빠뜨리기 쉬운 지점이다.

추측을 오래 두면 사실처럼 굳으므로 `inferred`가 스스로 삭기 시작하는 편이 안전하다.
**TTL은 이 절이 유일한 출처이며 문서 다른 곳에서 다시 정의하지 않는다.**

---

## 4. 도출 규칙

### 4.1 개체 해석과 경합

```python
def resolve_entity(name, kind, scope_key, seq, pos):
    normal = normalize(name)
    row = db.execute(
        "SELECT id, merged_into FROM entities WHERE scope_key=? AND normal_name=?",
        (scope_key, normal)).fetchone()
    if row:
        return row["merged_into"] or row["id"]
    eid = f"e{seq}.{pos}"                     # 2.2
    db.execute("INSERT OR IGNORE INTO entities "
               "(id, scope_key, name, normal_name, kind, origin_seq) VALUES (?,?,?,?,?,?)",
               (eid, scope_key, name, normal, kind, seq))
    return db.execute("SELECT id FROM entities WHERE scope_key=? AND normal_name=?",
                      (scope_key, normal)).fetchone()["id"]
```

재생은 단일 프로세스에서 순차 실행되므로 경합이 없다. 실시간 기록 경로에서도
`INSERT OR IGNORE` 후 재조회로 처리해 동시 삽입이 충돌해도 결과가 같게 한다.

`kind`가 기존 값과 다르면 **덮어쓰지 않는다.** 개체의 정체성은 이름이고 `kind`는
참고 정보다. 불일치가 잦으면 서로 다른 것이 같은 이름으로 뭉쳤다는 신호이므로
7.2의 정비 리포트로 넘긴다.

→ `ADR-008: 개체 해석, kind 불일치, 경합 처리`

### 4.2 강화와 대체

**같은 사실이 다시 진술되면** support가 늘고 `last_seen_at`이 갱신된다.
`state`가 `superseded`/`retracted`였다면 3.3의 카디널리티 검사를 거친 뒤
`active`로 되살린다.

**같은 주어·관계에 다른 목적어가 오면** 카디널리티를 따른다 (2.5).

| relation | 처리 |
|---|---|
| `describes` (단일) | 기존을 `superseded`, 새 사실을 `active` |
| 나머지 4종 (다중) | 둘 다 `active`. 대체하지 않는다 |

**상충을 자동으로 해결하지 않는다.** 사용자가 "세션 쓰자"고 했다가 나중에 "JWT
쓰자"고 했다면, 시스템이 임의로 하나를 고르는 것보다 둘 다 보여주고 어느 게 더
최근인지 알려주는 편이 정확하다. 진짜 대체는 사용자가 정정(3.3의 `retraction` +
새 `statement`)을 명시할 때 일어난다.

→ `ADR-009: 강화·대체 규칙`

### 4.3 신뢰도와 만료 — 저장하지 않고 집계한다

이 뷰가 응답의 `support`(5.5), 랭킹(5.4), 만료 판정(5.3)이 공유하는 **단일 출처**다.

```sql
CREATE VIEW claim_agg AS
SELECT
  cs.claim_id,
  COUNT(*)                                                   AS support_count,
  MAX(CASE json_extract(j.body,'$.provenance')
        WHEN 'user_stated' THEN 3
        WHEN 'observed'    THEN 2
        ELSE 1 END)                                          AS strongest_rank,
  MAX(j.created_at)                                          AS last_seen_at,
  CASE WHEN COUNT(*) > COUNT(cs.expires_at)                  -- NULL이 하나라도 있으면
       THEN NULL ELSE MAX(cs.expires_at) END                 AS effective_expires_at
FROM claim_support cs
JOIN journal j    ON j.id = cs.event_id
JOIN statements s ON s.event_id = cs.event_id
WHERE cs.live = 1 AND s.state = 'live'
GROUP BY cs.claim_id;
```

`strongest_rank` 3/2/1은 각각 `user_stated`/`observed`/`inferred`이며, 응답에서는
문자열로 되돌린다.

**비용**: 조회마다 `claim_support ⋈ journal ⋈ statements` 조인과 GROUP BY가 든다.
사실당 support 수가 작은 동안은 문제없다. 5.6 목표를 넘거나 7.1의 "사실당 support
수 상위값"이 커지면, 뷰는 정답의 정의로 남기고 `claims`에 캐시 컬럼을 얹어 재생·기록
시 갱신하는 방식으로 전환한다. 그때도 뷰가 있으므로 캐시 정합성을 검증할 수 있다.

### 4.4 상충도 계산한다

`(주어, 목적어)` 쌍에 `uses`와 `rejects`가 모두 `active`면 상충이다.
**저장하지 않고 조회 시 판정한다** — 상대편 사실이 철회되면 상충이 자동으로
풀려야 하는데, 저장하면 그 해제 로직을 따로 넣어야 하고 빠뜨리기 쉽다.

```sql
EXISTS (
  SELECT 1 FROM claims x
  WHERE x.scope_key = c.scope_key
    AND x.subject_id = c.subject_id
    AND x.object_id  = c.object_id
    AND x.state = 'active'
    AND x.relation = CASE c.relation WHEN 'uses' THEN 'rejects'
                                     WHEN 'rejects' THEN 'uses' END
) AS contested
```

`uses`/`rejects` 외의 관계에서는 항상 거짓이다.

→ `ADR-010: 신뢰도·만료·상충 산출 방식과 캐시 전환 조건`

### 4.5 비밀값

API 키·토큰·비밀번호가 기억에 남으면 검색으로 그대로 튀어나온다. 2단계로 잡는다.

1. **패턴**: 알려진 키 형식(AWS, GitHub 토큰, JWT 등) 정규식
2. **엔트로피**: 패턴에 안 걸리는 긴 무작위 문자열은 Shannon 엔트로피로 의심 판정

**차단이 아니라 보류다.** 정상 값(해시, 커밋 SHA, 빌드 id)이 오탐될 수 있으므로
해당 초안만 거부하고 무엇이 걸렸는지 알려 재시도하게 한다.

`raw_text`에 포함된 경우 **저널에 쓰기 전에 마스킹한다.** 저널은 불변이라 나중에
지울 수 없으므로, 이 검사만은 기록 이전에 반드시 통과해야 한다.

→ `ADR-011: 비밀값 탐지 규칙과 오탐 처리`

---

## 5. 읽기 경로

```
memory_recall 호출
      │
      ▼
① 진입점 확보 — terms(또는 query) → surface_forms 조회
      │          전부 실패 → FTS로 진술 검색 → 그 진술의 사실로 진입
      ▼
② 확장       — 진입 개체에서 사실을 따라 depth까지 (5.2)
      │
      ▼
③ 수집       — 방문한 개체에 붙은 모든 사실 (리터럴 포함, 5.2)
      │
      ▼
④ 랭킹       — 전체를 점수화한 뒤 자른다 (5.4)
      │
      ▼
⑤ 응답 구성  — 경로 복원 + support 부착 (5.5)
```

### 5.1 진입점

```sql
SELECT entity_id FROM surface_forms
WHERE scope_key = ? AND surface_norm = ?;
```

표면형 후보를 **전부 조회해 매칭된 개체를 모두 진입점으로 삼는다.** 첫 히트에서
멈추지 않는 이유는 질문 하나가 여러 개체를 언급할 수 있기 때문이다.

전부 실패하면 FTS로 넘어간다. 색인에는 철회된 진술도 남아 있으므로 투영과 조인해
걸러낸다 (2.6).

```sql
SELECT j.id, j.body FROM journal_fts f
JOIN journal j    ON j.seq = f.rowid
JOIN statements s ON s.event_id = j.id AND s.state = 'live'
WHERE journal_fts MATCH :q AND j.scope_key = :scope
ORDER BY rank LIMIT 20;
```

```
찾은 진술 →
  ├─ 그 진술이 뒷받침하는 active 사실이 있으면 → 그 사실의 개체를 진입점으로 (kind:"claim")
  └─ 없으면 (parsed가 비었거나 전부 철회) → 진술 자체를 kind:"raw" 답으로 반환
```

**FTS 결과를 그대로 답으로 주지 않고 그래프로 되돌아가는 것**이 원칙이다. 원문
조각만 던지면 기억 그래프가 아니라 로그 검색이다. 다만 `parsed: []`로 기록된 진술은
되돌아갈 그래프가 없으므로 `raw`로 반환한다 — 이 예외가 없으면 원문만 기록하는
사용 패턴(6.1)이 조회 단계에서 막힌다.

### 5.2 확장과 수집 — 이동과 답은 다르다

**두 가지를 구분해야 한다.**

- **이동(traversal)**: 개체에서 개체로 건너간다. 목적어가 개체인 사실만 쓸 수 있다.
- **수집(collection)**: 방문한 개체에 붙은 **모든** 사실을 답 후보로 담는다.
  목적어가 리터럴인 사실(`describes` → `"pnpm test"`)도 여기 포함된다.

이 구분이 없으면 리터럴 값 사실은 이동에 쓸 수 없다는 이유로 **답에서도 통째로
빠진다.** 값을 노드로 만들지 않기로 한 설계(2.5)가 그 값을 조회 불가능하게 만드는
결과가 되므로, 수집을 이동과 분리하는 것이 필수다.

```sql
-- 이동용: 개체 ↔ 개체
CREATE VIEW claim_links AS
  SELECT subject_id AS from_id, object_id AS to_id, id AS claim_id
    FROM claims WHERE state='active' AND object_id IS NOT NULL
  UNION ALL
  SELECT object_id AS from_id, subject_id AS to_id, id AS claim_id
    FROM claims WHERE state='active' AND object_id IS NOT NULL;

-- 수집용: 개체에 붙은 모든 사실 (리터럴 포함)
CREATE VIEW claim_incident AS
  SELECT subject_id AS entity_id, id AS claim_id FROM claims WHERE state='active'
  UNION ALL
  SELECT object_id  AS entity_id, id AS claim_id FROM claims
   WHERE state='active' AND object_id IS NOT NULL;
```

양방향이 필요한 이유: "인증서버가 뭘 쓰나"와 "뭐가 인증서버를 쓰나"는 둘 다 유효한
질문이다. `subject_id = ? OR object_id = ?`는 인덱스를 온전히 못 쓰므로 뷰로 나눈다.

**경로 복원을 위해 부모 포인터를 남긴다.** 방문 집합만으로는 `path`와 `hops`를
만들 수 없다.

```python
def expand(seeds, scope_key, depth, fanout=30):
    # came_from[entity] = (parent_entity, via_claim, depth, seed)
    came_from = {e: (None, None, 0, surface) for e, surface in seeds}
    frontier, collected = list(came_from), []

    for d in range(1, depth + 1):
        nxt = []
        for node in frontier:
            for link in links_of(node, scope_key, fanout):     # claim_links
                if link.to_id in came_from:
                    continue
                came_from[link.to_id] = (node, link.claim_id, d, came_from[node][3])
                nxt.append(link.to_id)
        collected += incident_claims(frontier, scope_key, fanout)  # claim_incident
        if not nxt:
            break
        frontier = nxt

    collected += incident_claims(frontier, scope_key, fanout)
    return came_from, dedup(collected)
```

**조기 종료를 두지 않는다.** `depth`까지 전부 펼친 뒤 5.4에서 점수로 자른다.
"1홉에서 충분히 나오면 멈춘다" 같은 규칙을 두면 2홉의 더 강한 사실이 1홉의 약한
사실들 때문에 후보에 들지도 못한다. 깊이 페널티는 랭킹 신호에 이미 있으므로 같은
목적의 장치를 두 번 걸 이유가 없다.

**대신 허브 개체를 방어한다.** 연결이 아주 많은 개체를 지날 때 탐색이 폭발하므로,
한 개체에서 뻗는 간선을 `support_count` 상위 K개(초기값 K=30)로 자른다. 품질이
아니라 비용을 위한 제한이며, 잘렸으면 `more_available`을 세운다.

**경로는 BFS 특성상 최단 경로 하나만 남는다.** 같은 개체에 여러 경로로 도달하면
먼저 도달한 것(더 짧은 것)을 쓴다. 시드가 여럿이면 각 개체는 자기를 처음 발견한
시드에 귀속된다.

### 5.3 랭킹으로 넘기기

확장 결과를 임시 테이블에 담아 SQL로 넘긴다. 파라미터 바인딩으로 수백 개 id를
넘기는 방식은 SQLite 변수 한도에 걸릴 수 있다.

```sql
CREATE TEMP TABLE reached(
  claim_id TEXT PRIMARY KEY,
  depth    INTEGER NOT NULL,
  seed     TEXT
);
```

### 5.4 랭킹

```sql
SELECT
  c.id, c.subject_id, c.relation, c.relation_label,
  c.object_id, c.object_value,
  r.depth, r.seed,
  a.support_count, a.strongest_rank, a.last_seen_at,
  EXISTS (SELECT 1 FROM claims x
           WHERE x.scope_key=c.scope_key AND x.subject_id=c.subject_id
             AND x.object_id=c.object_id AND x.state='active'
             AND x.relation = CASE c.relation WHEN 'uses' THEN 'rejects'
                                              WHEN 'rejects' THEN 'uses' END) AS contested,
  (-2 * r.depth)
  + CASE a.strongest_rank WHEN 3 THEN 6 WHEN 2 THEN 4 ELSE 1 END
  + CASE WHEN a.support_count > 4 THEN 4 ELSE a.support_count END
  + CASE WHEN a.last_seen_at > :recent_cutoff THEN 2 ELSE 0 END
  + CASE WHEN EXISTS (SELECT 1 FROM claims x
           WHERE x.scope_key=c.scope_key AND x.subject_id=c.subject_id
             AND x.object_id=c.object_id AND x.state='active'
             AND x.relation = CASE c.relation WHEN 'uses' THEN 'rejects'
                                              WHEN 'rejects' THEN 'uses' END)
         THEN -3 ELSE 0 END
  AS score
FROM reached r
JOIN claims    c ON c.id = r.claim_id
JOIN claim_agg a ON a.claim_id = c.id            -- 4.3
WHERE c.state = 'active'
  AND (a.effective_expires_at IS NULL OR a.effective_expires_at > :now)
ORDER BY score DESC
LIMIT :limit;
```

만료 판정이 `claim_agg`의 집계값으로 이뤄지므로 **조회 중 쓰기가 전혀 없다.**
그래서 `memory_recall`에 `readOnlyHint: true`를 붙이는 것이 정당하다 (6.4).

집계는 반드시 `claim_agg`를 통한다. 같은 계산을 두 곳에서 하면 응답의 `support`와
점수가 어긋난다.

가중치 숫자는 초기값이며 실사용 로그로 조정한다. 구조적으로 정할 것은 "어디서
계산하는가"(SQL 안)와 "어떤 신호를 쓰는가"(깊이·출처 강도·뒷받침 수·최근성·상충)이고,
숫자는 ADR이 아니라 튜닝 대상이다.

### 5.5 결과를 문장으로

**조합 규칙은 하나뿐이다.**

```
text = "{subject.name} {predicate} {object.name 또는 object_value}"
predicate = relation_label ?? 정규 관계 기본 표현
```

| relation | 기본 표현 |
|---|---|
| `uses` | 사용 |
| `rejects` | 거부 |
| `contains` | 포함 |
| `describes` | = |
| `relates_to` | 관련 |

**한국어 조사는 보정하지 않는다.** `relation_label`을 그대로 이어붙이므로 어색할
수 있다. agent가 어차피 자기 문장으로 다시 쓰므로 서버가 조사를 추측해 틀리는 것보다
낫다고 본다. 7.1 지표로 재검토한다.

`path`는 `came_from`을 시드까지 거슬러 올라가 개체 이름을 `→`로 잇고, 맨 앞에
진입 표면형을 붙인다. `hops`는 그 경로의 간선 수다.

```
"로그인 → 인증 시스템 → 서버 세션"
```

`path`가 필요한 이유: 사용자가 "로그인"이라 물었는데 답이 "인증 시스템"에 대한
것일 때 연결을 보여주지 않으면 agent가 엉뚱한 답이라고 오해한다. 경로가 답의
근거다.

### 5.6 성능 목표 (초기값, 7.1에서 재조정)

| 구간 | 목표 |
|---|---|
| 표면형 진입 + 1홉 | p95 50ms |
| 2홉 확장 + 랭킹 (사실 10만 건) | p95 200ms |
| FTS 진입 경로 | p95 300ms |
| 전체 재생 (사건 10만 건) | 60초 이내 |

→ `ADR-012: 확장·수집 알고리즘, 경로 복원, 랭킹 신호, 문장 조합`

---

## 6. MCP 도구

도구는 셋이며 각각 사용자의 서로 다른 의도에 대응한다.

| 도구 | 의도 | 저널에 남기는 사건 |
|---|---|---|
| `memory_record` | "이거 기억해둬" / 대화 중 사실이 나왔다 | `statement` |
| `memory_recall` | "그거 뭐였지?" / "지금 뭘 알고 있어?" | 없음 (읽기 전용) |
| `memory_revise` | "그거 틀렸어" / "지워" / "이 둘은 같은 거야" | `retraction`, `merge`, `alias` |

### 6.1 memory_record

```typescript
memory_record({
  raw_text: string,          // 필수. 이 기억의 출처가 된 원문.
  claims: ClaimDraft[],      // 필수. 빈 배열 허용 (원문만 기록).
  provenance?: "user_stated" | "observed" | "inferred",   // 기본 "inferred"
  ttl?: "session" | "weeks" | "permanent",                // 생략 시 3.4의 표
  supersedes?: string        // 재해석일 때 원본 statement 사건 id (7.4)
}) -> RecordResult

type ClaimDraft = {
  subject: string;                 // 자연어 개체명. "인증서버"
  relation: "uses" | "rejects" | "contains" | "describes" | "relates_to";
  relation_label?: string;         // 실제 표현. "세션을 쓴다" 등.
  object?: string;                 // 개체일 때
  object_value?: string;           // 리터럴일 때. object와 상호배타(정확히 하나).
  subject_aliases?: string[];      // subject 개체의 추가 표면형
  object_aliases?: string[];       // object 개체의 추가 표면형
}
```

**별칭이 두 필드로 나뉜 이유**: 하나의 `aliases` 배열이면 그 별칭이 주어의 것인지
목적어의 것인지 결정할 수 없다. "로그인"이 실수로 "서버 세션"의 별칭으로 등록되면
검색이 조용히 오작동한다.

**`raw_text`가 필수인 이유**: 저널에 남는 값이고, agent의 파싱이 틀렸을 때 복구할
유일한 근거다.

**`claims`가 빈 배열이어도 되는 이유**: agent가 "중요한 말이 나왔는데 어떻게 쪼갤지
모르겠다"는 상태일 때 아무것도 저장 못 하는 것보다 원문이라도 남기는 편이 낫다.
이런 진술은 5.1의 FTS 경로로 찾을 수 있고 7.4의 재해석 대상이 된다.

**수치 신뢰도를 받지 않는 이유**: LLM이 0.0~1.0 값을 일관되게 보정하지 못한다.
`provenance` 3지선다만 받으며, 이건 "사용자가 말했나 / 내가 확인했나 / 내가
추측했나"라 대화 맥락에서 자연스럽게 아는 값이다. 기본값이 가장 보수적인
`inferred`이므로 확신 없으면 생략하면 된다.

**scope를 받지 않는 이유**: 2.4 참고.

```typescript
type RecordResult = {
  event_id: string;
  claims: Array<{
    index: number;
    status: "created" | "reinforced" | "superseded_previous" | "rejected";
    claim_id?: string;
    note?: string;      // rejected면 어떻게 고칠지
  }>;
}
```

**부분 성공을 허용한다.** 초안 하나가 거부돼도 나머지와 원문 기록은 유지된다.
한 항목의 오류로 문장 전체가 유실되면 "저장했다고 생각했는데 없더라"가 되는데,
기억 시스템에서 가장 나쁜 실패 양상이다.

→ `ADR-013: memory_record 인터페이스`

### 6.2 memory_recall

```typescript
memory_recall({
  mode?: "search" | "overview",   // 기본 "search"
  query?: string,                 // search일 때 필수
  terms?: string[],               // 선택. agent가 추출한 핵심 표현.
  depth?: 1 | 2 | 3,              // 기본 2
  limit?: number,                 // 기본 10
  detail?: "brief" | "full"       // 기본 "brief"
}) -> RecallResult
```

**`mode: "overview"`가 있는 이유**: 질의 기반 조회만 있으면 "지금 뭘 기억하고 있어?"에
답할 방법이 없다. overview는 이 스코프에서 연결이 많고 최근 갱신된 개체를 상위
N개 돌려준다. 사용자가 기억 상태를 점검하거나 새 프로젝트에 합류했을 때 쓰는 경로다.

**`terms`가 선택인 이유**: 핵심어를 뽑아주면 표면형 조회를 바로 시작할 수 있어
빠르지만, 안 넘겨도 서버가 `query`를 정규화해 후보를 만든다. 필수로 만들면 "핵심어를
어떻게 뽑지"라는 판단 부담이 호출 자체를 막는다.

```typescript
type RecallResult = {
  answers: Answer[];                    // 없으면 빈 배열
  entry: "surface" | "fts" | "overview" | "none";
  more_available: boolean;
  note?: string;                        // 결과 없음/절단 시 다음 행동 안내
}

type Answer =
  | {
      kind: "claim";
      claim_id: string;                 // memory_revise에 그대로 넘길 수 있다 (2.2)
      text: string;                     // 5.5
      path: string;                     // "로그인 → 인증 시스템 → 서버 세션"
      hops: number;
      contested: boolean;
      support: {
        count: number;
        strongest: "user_stated" | "observed" | "inferred";
        last_seen: string;              // ISO 날짜
      };
      detail?: {                        // detail:"full"일 때만
        statements: Array<{ event_id: string; raw_text: string;
                            provenance: string; created_at: string;
                            actor?: string; branch?: string }>;
      };
    }
  | {
      kind: "raw";                      // 사실로 쪼개지지 않은 진술 (5.1)
      event_id: string;
      text: string;                     // raw_text 그대로
      created_at: string;
      provenance: "user_stated" | "observed" | "inferred";
    };
```

**`entry: "none"`일 때**: `answers`는 빈 배열이고 `note`에 안내를 담는다.
예: `"이 프로젝트에 관련 기억이 없습니다. 방금 알게 된 내용이 있으면 memory_record로 기록하세요."`

**신뢰도를 숫자 하나로 주지 않는 이유**: `0.87`은 agent가 해석할 수 없다. "사용자가
직접 말했고, 3번 확인됐고, 마지막이 어제"는 답변에 그대로 녹여 쓸 수 있다. 기억
시스템의 출력은 결국 사람에게 갈 문장이 되므로 근거의 형태가 쓸모 있다.

→ `ADR-014: memory_recall 인터페이스와 응답 형태`

### 6.3 memory_revise

정정·삭제·병합·별칭확인을 하나로 묶는다. 전부 "지금 믿는 것을 바꾼다"는 같은
의도에서 나오고, 도구가 늘수록 agent가 어느 걸 쓸지 헷갈린다.

```typescript
memory_revise({
  action: "retract" | "correct" | "merge" | "alias",

  target?:
    | { claim_id: string }        // 사실 하나 (권장)
    | { event_id: string }        // 사건 하나와 그로부터 나온 전부
    | { subject: string, relation?: string },   // 자연어 지정

  replacement?: ClaimDraft,       // correct일 때 필수
  merge?: { keep: string, absorb: string },     // merge일 때 필수 (표면형 또는 entity_id)
  alias?: { surface: string, entity: string }   // alias일 때 필수
}) -> ReviseResult
```

모든 동작은 **저널에 사건을 추가하고 재생을 트리거한다.** 투영을 직접 고치지
않는다 (1.1).

#### 6.3.1 철회의 두 범위 — 가장 주의할 부분

하나의 진술은 사실 여러 개를 뒷받침한다(7장 예시: 진술 1개 → 사실 2개). 그래서
**"이 사실 하나만 취소"와 "이 진술 전체를 취소"는 다른 동작이어야 한다.** 진술만
철회할 수 있게 만들면 사실 하나를 지우려다 같은 문장에서 나온 다른 사실이 함께
죽는다.

| target | 무엇이 철회되나 | 진술은? | 같은 진술의 다른 사실은? |
|---|---|---|---|
| `{claim_id}` | 그 사실을 향한 support 링크들 | 유지 | **유지** |
| `{event_id}` (statement) | 그 진술과 모든 support 링크 | 철회 | 함께 철회 |
| `{event_id}` (merge) | 그 병합 | — | 개체가 다시 갈라짐 |
| `{event_id}` (alias) | 그 표면형 등록 | — | — |
| `{subject, relation}` | 해석해서 나온 사실들 | 유지 | 유지 |

**`{subject, relation}` 지정이 여러 사실에 걸리면 실행하지 않는다.** 후보 목록을
`note`에 담아 반환하고 agent가 `claim_id`로 다시 지정하게 한다. 자연어 지정은 편의
기능이지 모호성을 임의로 해소하는 장치가 아니다.

#### 6.3.2 correct

`retraction` 사건과 새 `statement` 사건을 **연속된 두 사건으로** 저널에 추가한다.
"JWT 쓰기로 한 거 취소하고 세션으로 바꿨어"가 한 번의 호출로 처리된다. 저널에
둘 다 남으므로 "언제 뭘로 바꿨었지"에도 답할 수 있다.

#### 6.3.3 merge

`merge` 사건을 추가한다. 재생 규칙은 3.3에 있다. **되돌릴 수 있다** — 그 사건을
`retraction`으로 가리키면 개체가 다시 갈라진다.

되돌릴 수 있게 됐지만 **자동으로 수행하지는 않는다.** 잘못 병합하면 서로 다른
사실이 뒤섞이고, 되돌려도 그 사이에 쌓인 기록의 해석이 달라져 있을 수 있다. 후보는
7.2의 정비 리포트에 쌓고 사용자 확인을 받아 실행한다.

→ `ADR-015: memory_revise 동작 정의, 철회 범위, 병합 절차`

### 6.4 도구가 agent에게 잘 쓰이게 하는 장치

**이름**: `memory_` 접두어로 묶는다. 다른 MCP 서버에 `save`/`search`가 있으면
agent가 어느 쪽인지 판단해야 한다.

```json
memory_recall: { "readOnlyHint": true,  "idempotentHint": true }
memory_record: { "readOnlyHint": false, "idempotentHint": true }
memory_revise: { "readOnlyHint": false, "destructiveHint": true }
```

`readOnlyHint: true`가 정당한 이유: 5.4에서 만료 판정이 집계로 이뤄지므로 조회
경로에 쓰기가 전혀 없다. 일부 클라이언트가 확인 프롬프트를 생략하므로 조회 마찰이
줄어든다.

`memory_record`가 idempotent인 이유: 같은 사실을 다시 기록해도 새 사실이 생기지
않고 support만 는다 (4.2). 재시도가 안전하다.

**description에 반드시 들어갈 것**

- 호출해야 하는 상황과 하지 말아야 하는 상황을 **둘 다** 예시로 (호출 조건만 적으면
  과호출이 난다)
- `relation` 5종 각각의 의미와, 애매하면 `relates_to`를 쓰라는 안내
- `object` vs `object_value` 판단 기준 예시 (개체면 앞, 값이면 뒤)
- `subject_aliases`와 `object_aliases` 각각의 예시

**거부 응답은 재시도 가능해야 한다**

```json
{ "status": "rejected",
  "note": "relation 'configures'는 정규 관계가 아닙니다. relates_to로 저장하고 relation_label에 'configures'를 넣어 다시 보내세요." }
```

불투명한 에러 코드를 주면 agent는 같은 실수를 반복하거나 저장을 포기한다.

→ `ADR-016: 도구 명명·annotation·description 규약`

---

## 7. 예시로 따라가기

규범이 아니라 이해를 돕기 위한 것이다.

**① 첫 기록**

```
사용자: "인증 시스템은 JWT 쓰는 것 같네"

agent → memory_record({
  raw_text: "인증 시스템은 JWT 쓰는 것 같네",
  provenance: "inferred",              // agent의 추측
  claims: [{ subject: "인증 시스템", relation: "uses", object: "JWT",
             subject_aliases: ["인증", "로그인"] }]
})
```

저널: `ev_1 (statement)`. 개체 `e1.0`(인증 시스템), `e1.1`(JWT), 사실 `c1.0` 생성.
`inferred`이므로 support의 `expires_at`은 30일 뒤 (3.4).

**② 정정**

```
사용자: "아니야, JWT 대신 서버 세션 쓰기로 했어"

agent → memory_record({
  raw_text: "JWT 대신 서버 세션 쓰기로 했어",
  provenance: "user_stated",
  claims: [
    { subject: "인증 시스템", relation: "uses",    object: "서버 세션",
      relation_label: "쓰기로 함" },
    { subject: "인증 시스템", relation: "rejects", object: "JWT" }
  ]
})
```

저널: `ev_2`. `uses`는 다중이므로 `c1.0`(uses JWT)은 자동 대체되지 않는다. 대신
같은 `(인증 시스템, JWT)` 쌍에 `uses`와 `rejects`가 모두 active가 되어 **조회 시
상충으로 판정된다** (4.4).

**③ 조회**

```
agent → memory_recall({ query: "로그인 어떻게 하기로 했었지?", terms: ["로그인"] })

answers[0] = { kind:"claim", text:"인증 시스템 쓰기로 함 서버 세션",
               path:"로그인 → 인증 시스템 → 서버 세션", hops:1, contested:false,
               support:{ count:1, strongest:"user_stated", last_seen:"2026-08-20" } }

answers[1] = { kind:"claim", text:"인증 시스템 거부 JWT",
               path:"로그인 → 인증 시스템 → JWT", hops:1, contested:true, … }

answers[2] = { kind:"claim", text:"인증 시스템 사용 JWT",
               path:"로그인 → 인증 시스템 → JWT", hops:1, contested:true,
               support:{ count:1, strongest:"inferred", … } }   // 점수 낮음

entry: "surface"
```

"로그인"은 개체가 아니지만 표면형으로 등록돼 있어 진입에 성공했다. 상충하는 둘이
모두 반환되고, 추측이었던 `uses JWT`는 출처 강도(1점)와 상충 감점(-3)으로 아래에
깔린다. agent는 이 정보로 "예전엔 JWT로 추측했지만 세션으로 정해졌다"고 답할 수 있다.

**④ 사실 하나만 철회**

```
사용자: "JWT 쓴다는 거 아예 지워"

agent → memory_revise({ action:"retract", target:{ claim_id:"c1.0" } })
```

저널: `ev_3 (retraction)`. `c1.0`의 support만 끊기므로 **같은 진술(`ev_1`)에서
나온 다른 사실은 영향받지 않고, 진술 원문도 저널에 그대로 남는다.** `c1.0`이
죽으면서 `rejects JWT`의 상충도 자동으로 풀린다 — 상충을 저장하지 않고 계산하기
때문이다 (4.4).

**⑤ 재생해도 그대로**

7.3의 재생을 돌리면 `ev_1 → ev_2 → ev_3`가 순서대로 적용되어 위 상태가 그대로
복원된다. 철회가 저널에 있기 때문이다. **투영을 직접 고치는 설계였다면 이 철회는
재생과 함께 사라졌을 것이다.**

---

## 8. 운영

### 8.1 무엇을 볼 것인가

| 신호 | 읽는 법 | 대응 |
|---|---|---|
| `entry` 분포 | fts 비율이 오르면 표면형 등록이 부족 | 8.2 정비, description 보강 |
| `relates_to` 비율 | 높으면 정규 관계 5종이 용례를 못 담음 | 어휘 승격 (2.5) |
| `relation_label` 빈도 상위 | 정규 관계 승격 후보 | 어휘 승격 (2.5) |
| `actor`별 파싱 편차 | 특정 agent가 유독 다르게 쪼갬 | description 수정, 8.4 재해석 |
| 상충 사실 수 | 급증하면 개체 해석이 다른 것을 묶고 있을 수 있음 | 8.2 정비 |
| 사실당 평균 support 수 | 1에 가까우면 같은 사실이 매번 갈라짐 | 정규화 강도 재검토 (3.2) |
| 사실당 support 수 상위값 | 커지면 4.3 집계 비용 상승 | 캐시 전환 검토 (4.3) |
| 재생 소요 시간 | 5.6 목표 초과 시 | 스냅샷 도입 검토 (1.3) |
| 조회 지연 | 5.6 목표 대비 | 인덱스·캐시 재검토 |

"사실당 평균 support 수"와 "상충 사실 수"가 특히 중요하다. 둘 다 그래프가 조용히
조각나고 있다는 신호인데, 겉으로는 아무 에러 없이 진행되기 때문에 지표로 보지
않으면 모른다.

### 8.2 정비

주기적으로(또는 요청 시) 리포트를 만든다. **자동으로 고치지 않는다.**

| 항목 | 처리 |
|---|---|
| 표면형이 비슷한데 별개인 개체 쌍 | 사용자 확인 후 `memory_revise merge` |
| 반복 실패한 검색어 | 사용자 확인 후 `memory_revise alias` |
| 오래된 `inferred` 사실 | TTL로 자동 만료되므로 보고만 |
| 상충 사실 목록 | 사용자 확인 후 `correct` |
| `kind` 불일치 개체 | 잘못 뭉친 개체일 수 있으므로 조사 대상 |

정비 후보는 투영에서 계산해 보고만 하고, 실제 변경은 전부 사건으로 들어간다.

### 8.3 재생 (replay) — 서버 주도

투영을 비우고 `journal`을 `seq` 순으로 재적용한다. 2.2의 사건 고정 id 덕분에
**재생은 멱등하며, agent가 이전에 받은 `claim_id`는 재생 후에도 유효하다**
(규칙 변경으로 사라진 id는 `id_redirects`로 해석된다).

재생으로 반영되는 변경: 정규화 규칙(3.2), 개체 해석 기준(4.1), 관계 어휘·카디널리티
(2.5), 대체 규칙(4.2), TTL 규칙(3.4).

재생은 규칙 변경의 회귀 확인 수단이기도 하다. 같은 저널로 새 규칙을 돌려 사실 수,
`relates_to` 비율, 상충 수, 사실당 평균 support가 어떻게 변하는지 비교하면 규칙
변경이 실제 개선인지 알 수 있다.

### 8.4 재해석 (reinterpret) — agent 주도

문장 분할 방식이나 관계 선택을 개선해 과거 기록에 소급 적용하려면 `raw_text`를
다시 해석해야 한다. **서버에는 파서가 없으므로 agent가 한다** (1.3).

1. 서버가 대상 진술을 준다 — `parsed`가 빈 것, 특정 `actor`의 것, 특정 기간의 것.
2. agent가 `raw_text`를 읽고 현재 도구 스펙으로 `ClaimDraft[]`를 다시 만든다.
3. `memory_record`에 `supersedes: "ev_…"`를 붙여 기록한다. 재생 시 원본 진술이
   `superseded`가 되고 새 진술이 그 자리를 대신하되, **원본의 `created_at`과
   `provenance`를 승계한다** — 시간 순서와 출처 강도가 재해석으로 바뀌면 안 되기
   때문이다.

비용이 크고 결과가 달라질 수 있으므로 자동 실행하지 않는다. 8.1에서 파싱 편차가
확인된 범위에만 적용한다.

→ `ADR-017: 재생·재해석 절차와 회귀 비교 방법`

---

## 9. 아직 정하지 않은 것

전부 담당 ADR이 있다. ADR 작성자는 해당 항목을 자기 결정 범위로 포함해야 한다.

| 미결 사항 | 왜 지금 못 정하나 | 담당 |
|---|---|---|
| 관계가 5종이 맞는가 | `relates_to` 비율과 라벨 분포를 쌓아봐야 안다. 지금 정한 건 "탈출구가 있는 작은 집합"이라는 구조뿐 | ADR-004 |
| 정규화 강도 (조사 제거 여부) | 강하면 다른 것이 뭉치고 약하면 같은 것이 갈린다. 8.1의 "사실당 평균 support 수"로 판단 | ADR-006 |
| 모델 간 파싱 편차 크기 | Claude/OpenCode에 같은 문장 20개를 주고 사실 집합 겹침을 재봐야 한다. 크면 8.4에 무게를 더 둔다 | ADR-013, ADR-017 |
| 허브 방어 K=30, depth 기본 2 | 실제 그래프 밀도를 봐야 한다 | ADR-012 |
| 4.3 집계를 캐시로 전환할 시점 | 5.6 목표 초과 또는 support 수 상승이 트리거 | ADR-010 |
| 재생 스냅샷 도입 시점 | 저널이 커지는 속도를 봐야 안다 | ADR-001 |
| 재생을 언제 돌리나 (동기/비동기) | `memory_revise` 직후 동기 재생은 지연이 크고, 비동기면 그 사이 조회가 옛 상태를 본다 | ADR-007 |
| 한 서버가 여러 프로젝트를 오가는 사용 방식 | 2.4는 서버 프로세스가 하나의 프로젝트에 묶인다고 가정한다 | ADR-003 |
| 다중 클라이언트 동시 접속 | WAL과 `busy_timeout=5000`으로 충분한지는 접속 패턴을 봐야 안다 | ADR-005 |
| `session` TTL 12시간 근사 | 서버가 세션 종료를 항상 알 수는 없다. 종료 신호를 받을 수 있으면 정확히 처리 | ADR-013 |
| `overview` 모드의 정렬 기준 | 연결 수·최근성·출처 중 무엇을 우선할지는 실사용을 봐야 안다 | ADR-014 |

---

## 10. ADR 목록

| ID | 제목 | 절 |
|---|---|---|
| ADR-001 | 저널/투영 2층 구조, 불변식, 재생·재해석 경계 | 1 |
| ADR-002 | 식별자 발급 규칙과 재생 안정성 | 2.2 |
| ADR-003 | scope_key 구성과 결정 경로 | 2.4 |
| ADR-004 | 관계 어휘, 카디널리티, 승격 절차 | 2.5 |
| ADR-005 | FTS 색인 대상, 토크나이저, 동기화 | 2.6 |
| ADR-006 | 정규화 규칙과 강도 | 3.2 |
| ADR-007 | 재생 규칙과 사건별 처리 순서 | 3.3 |
| ADR-008 | 개체 해석, kind 불일치, 경합 처리 | 4.1 |
| ADR-009 | 강화·대체 규칙 | 4.2 |
| ADR-010 | 신뢰도·만료·상충 산출 방식과 캐시 전환 조건 | 4.3, 4.4 |
| ADR-011 | 비밀값 탐지 규칙과 오탐 처리 | 4.5 |
| ADR-012 | 확장·수집 알고리즘, 경로 복원, 랭킹, 문장 조합 | 5.2~5.5 |
| ADR-013 | memory_record 인터페이스 | 6.1 |
| ADR-014 | memory_recall 인터페이스와 응답 형태 | 6.2 |
| ADR-015 | memory_revise 동작 정의, 철회 범위, 병합 절차 | 6.3 |
| ADR-016 | 도구 명명·annotation·description 규약 | 6.4 |
| ADR-017 | 재생·재해석 절차와 회귀 비교 방법 | 8.3, 8.4 |

각 ADR은 Context / Decision / Alternatives / Consequences 형식을 따르며, 이 문서의
해당 절을 Context의 출발점으로 인용한다. **9장에서 자기 ADR로 배정된 미결 사항이
있으면 그 결정까지 포함해야 한다.**

### 의존 순서

```
ADR-001 (2층 구조·불변식)
   ├─→ ADR-002 (id) ──┬─→ ADR-007 (재생 규칙) ─→ ADR-009 (강화·대체)
   ├─→ ADR-003 (scope)┤                              │
   └─→ ADR-017 (재생·재해석)                          ▼
                      └─→ ADR-008 (개체) ─→ ADR-010 (신뢰도·상충)
ADR-006 (정규화) ─────────→ ADR-008                    │
ADR-004 (어휘) ───────────→ ADR-009                    ▼
ADR-005 (FTS) ────────────────────────────→ ADR-012 (탐색·랭킹)
                                                       │
ADR-013 (record) ─→ ADR-015 (revise) ─→ ADR-016 (도구 규약)
ADR-014 (recall) ─────────────────────────┘
ADR-011 (비밀값) — 독립
```

**ADR-001을 먼저 확정해야 한다.** "모든 변경은 사건이다"라는 불변식이 나머지 전부의
전제이며, 이게 흔들리면 ADR-002(id 안정성), ADR-007(재생), ADR-015(정정)가 동시에
근거를 잃는다. 그 다음이 ADR-002와 ADR-003이다.
