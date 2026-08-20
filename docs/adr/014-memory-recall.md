# ADR-014: memory_recall 인터페이스와 응답 형태

- 상태: Accepted
- 결정일: 2026-08-20
- 소유 영역: 초기 설계 6.2, 9장 overview 정렬 항목
- 선행 ADR: ADR-003, ADR-012
- Supersedes: 초기 설계 6.2의 overview 공통 depth 입력

## Context

Agent는 구체적인 질문뿐 아니라 “이 프로젝트에서 뭘 기억하지?”라는 개요도 요청한다.
응답은 사람이 읽을 문장인 동시에 후속 `memory_revise`에 쓸 안정 ID와 provenance 근거를
제공해야 한다. 검색 실패, FTS의 원문 전용 결과, 허브·limit 절단도 서로 구분돼야
agent가 다음 행동을 선택할 수 있다.

초기 타입을 유지하면서 mode별 유효 입력, 반환 정렬과 시각 형식, full detail의 범위,
overview 순서를 확정한다.

## Decision

### 입력 계약

```typescript
type MemoryRecallInput =
  | {
      mode?: "search";
      query: string;
      terms?: string[];
      depth?: 1 | 2 | 3;
      limit?: number;
      detail?: "brief" | "full";
    }
  | {
      mode: "overview";
      limit?: number;
      detail?: "brief" | "full";
    };
```

mode 기본값은 `search`, depth 기본값은 2, limit 기본값은 10, detail 기본값은
`brief`다. limit은 1~50이다. `search`의 query는 trim 뒤 1~4,096자이고 terms는
최대 10개, 각 1~256자다. `overview`에는 query, terms와 depth를 보내지 않는다.
overview는 ADR-012의 depth 0 개요로 고정한다. mode에 맞지 않는 필드는 오류로 반환해
호출 실수를 숨기지 않는다.

scope는 입력에 없고 ADR-003에 따라 서버가 결정한다. search의 진입, overview 순서,
BFS, 랭킹, limit과 `more_available`은 전부 ADR-012를 따른다.

### 출력 계약

```typescript
type RecallResult = {
  answers: Answer[];
  entry: "surface" | "fts" | "overview" | "none";
  more_available: boolean;
  note?: string;
};

type ClaimAnswer = {
  kind: "claim";
  claim_id: string;
  text: string;
  path: string;
  hops: number;
  contested: boolean;
  support: {
    count: number;
    strongest: "user_stated" | "observed" | "inferred";
    last_seen: string;
  };
  detail?: {
    statements: Array<{
      event_id: string;
      raw_text: string;
      provenance: "user_stated" | "observed" | "inferred";
      created_at: string;
      recorded_at: string;
      actor?: string;
      branch?: string;
    }>;
    more_available: boolean;
  };
};

type RawAnswer = {
  kind: "raw";
  event_id: string;
  text: string;
  created_at: string;
  recorded_at: string;
  provenance: "user_stated" | "observed" | "inferred";
};

type Answer = ClaimAnswer | RawAnswer;
```

모든 시각 문자열은 UTC ISO 8601의 `YYYY-MM-DDTHH:mm:ssZ`다. `strongest`는
ADR-010의 strongest_rank를 문자열로 바꾼 값이고 count와 last_seen도 같은
`recall_claim_agg` 행에서 가져온다. `detail`은 요청이 full인 claim 답에만 존재하며 현재
유효한 support statement만 ADR-012의 전역 100건/1 MiB 예산 안에서 포함한다.
detail과 raw answer의 provenance/created_at은 재해석 append 시각이 아니라
`statements`의 effective 값을 사용한다. recorded_at은 `journal.created_at`의 실제 append
시각이며 재해석이 아니면 created_at과 같다. actor/branch도 실제 support event의 journal
metadata다.

claim_id는 `id_redirects`를 거친 canonical ID다. raw answer는 저장된 `parsed=[]`이고
현재 live·unexpired인 statement에 한해 FTS 또는 overview에서 반환한다. parsed claim이
철회·만료됐다는 이유로 raw fallback하지 않는다. 저널의 마스킹된 raw_text를 그대로
text로 쓴다.

### entry와 빈 결과

- surface seed 확장에서 claim 답이 하나라도 나오면 `entry='surface'`다.
- surface가 없거나 surface에서 답이 없고 FTS가 claim 또는 raw 후보를 찾으면
  `entry='fts'`다.
- overview 호출은 entity 또는 raw-only 후보가 있으면 `entry='overview'`다.
- 어떤 답 후보도 없으면 `entry='none'`, `answers=[]`, `more_available=false`다.

`entry='none'`에는 다음 행동을 설명하는 note를 넣는다. 예:
`이 프로젝트에 관련 기억이 없습니다. 새로 확인한 내용은 memory_record로 기록하세요.`
query가 세 글자 미만이고 surface hit가 없어 FTS를 실행하지 못했다면 더 긴 표현이나
terms를 요청하라는 이유도 note에 넣는다.

`more_available=true`일 때 note는 limit, FTS, surface/overview seed, fanout 또는
raw/detail payload 중 실제 절단 원인을 나열한다. false일 때 note는 선택 사항이다.

### 오류와 읽기 전용성

유효한 “검색 결과 없음”은 오류가 아니다. 잘못된 mode 조합, 범위를 벗어난 depth/limit,
빈 query만 입력 오류다. DB busy나 내부 손상은 성공 모양의 빈 배열로 숨기지 않고
tool error로 반환한다.

호출은 TEMP table과 connection-local 임시 상태만 사용할 수 있다. journal과 영구
projection, FTS를 수정하지 않는다. SQLite TEMP 쓰기는 제품 기억 상태 변경이 아니며
read-only annotation과 모순되지 않는다. 같은 DB snapshot, 입력과 캡처한 `now`에서는
답과 순서가 동일해야 한다.

### overview 결정

초기 설계 9장에서 열어둔 overview 순서는 ADR-012과 같이 다음으로 확정한다.

1. 유효 incident claim 수
2. 유효 support의 최근성
3. entity id

그 entity들을 depth 0 seed로 사용한 claim 응답이므로 연결 수만 많은 오래된 hub가
최종 답을 독점하지 않도록 기존 provenance·support·최근성 랭킹을 다시 적용한다.

## Alternatives

### 숫자 confidence 하나만 반환

보정 기준을 설명하기 어렵고 agent가 답변 근거로 쓰기 힘들다. strongest, count와
last_seen을 분리한다.

### 결과 없음에 예외 사용

정상적인 빈 기억과 서버 장애가 섞인다. 정상 빈 결과는 `entry='none'`, 장애는 error다.

### overview에서 entity 객체 반환

새 응답 union과 해석 규칙이 필요하다. ADR-012의 entity seed + claim 답을 재사용한다.

### full detail에 철회·만료 support까지 포함

감사에는 유용하지만 현재 사실의 근거라는 의미가 흐려진다. v1 recall은 유효 support만
반환하고 전체 감사 기록은 별도 관리 기능으로 남긴다.

## Consequences

- agent는 answer의 claim_id를 그대로 revise에 사용할 수 있다.
- 빈 결과와 시스템 오류, raw 원문 fallback이 구분된다.
- overview의 의미와 순서가 구현자에 따라 달라지지 않는다.
- full detail은 응답이 커질 수 있으나 limit 상한과 유효 support 한정으로 제어한다.
- recall은 product state를 쓰지 않으므로 안전하게 read-only로 표시할 수 있다.

## Validation

- search에서 query 누락, overview에서 query/depth 제공, limit=51이 각각 입력 오류여야 한다.
- 같은 snapshot, 입력과 캡처한 now를 반복하면 answers와 path 순서가 byte-equivalent여야 한다.
- detail brief에는 detail 필드가 없고 full에는 유효 support만 있어야 한다. 전역 예산을
  넘으면 detail/result의 more_available과 note가 함께 절단을 알려야 한다.
- raw answer text와 full detail raw_text의 UTF-8 byte 합도 1 MiB 이하여야 한다.
- 모든 시각이 UTC `Z` 형식이고 support 세 값이 같은 aggregate에서 나와야 한다.
- 재해석 fixture에서 created_at은 원본 시각, recorded_at은 successor append 시각이어야 한다.
- 빈 scope와 FTS 불가 단문 검색이 각각 적절한 `entry='none'` note를 반환해야 한다.
- claim 철회·TTL 만료가 raw fallback으로 우회되지 않고 unexpired parsed=[]만 raw로
  반환돼야 한다.
- 허브/limit/FTS 절단 원인이 more_available과 note에 드러나야 한다.
- 호출 전후 journal과 영구 projection/FTS의 row 수와 내용이 같아야 한다.

## References

- 초기 설계 5장, 6.2, 9장 overview 항목
- ADR-003, ADR-005, ADR-010, ADR-012, ADR-015, ADR-016
