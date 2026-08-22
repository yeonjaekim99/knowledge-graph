# REC-003: record raw 마스킹과 draft 부분 거부

- 상태: 완료 · [PR #38](https://github.com/yeonjaekim99/knowledge-graph/pull/38)
- 작업 ID: `REC-003`
- 구현 branch: `rec-003-record-sanitizer`
- 근거: ADR-011, ADR-013, ADR-017
- 선행 구현: REC-001, REC-002

## Context

REC-001은 schema-valid `MemoryRecordInput`과 원래 입력 index를 가진 결과 계약을 제공하고,
REC-002는 저장 문자열에서 비밀값 class와 UTF-16 slice 위치만 돌려주는 pure detector를
제공한다. 그러나 detector 결과를 그대로 두면 append-only journal과 contentless FTS에
평문 raw가 들어갈 수 있고, 요청 전체를 거부하면 안전한 draft와 복구 가능한 원문까지
잃는다.

이 작업은 두 경계를 연결하는 application 전처리만 소유한다. journal append, entity 해석,
요청 내 중복 제거와 projection은 각각 REC-004~006이 소유하므로 sanitizer에는 writer port,
SQLite, MCP 또는 runtime dependency가 없다.

## Decision

### 출력 plan

[`memory-record-sanitizer.ts`](../../src/application/memory-record-sanitizer.ts)는 schema 검사를
통과한 입력을 다음 immutable plan으로 바꾼다.

```typescript
type RecordSecretSanitizationResult = {
  maskedRawText: string;
  approvedDrafts: readonly { inputIndex: number; draft: ClaimDraft }[];
  rejectedClaims: readonly {
    index: number;
    status: "rejected";
    note: string;
  }[];
};
```

승인 draft는 입력 객체를 보유하지 않는 깊이 1의 immutable clone이며 alias 배열도 복사해
freeze한다. raw, 재해석 여부와 모든 draft clone은 detector를 호출하기 전에 한 번에
snapshot한다. 따라서 잘못된 주입 구현이 caller-owned 객체를 바꿔도 검사한 값과 후속 plan의
값이 달라지지 않는다. `inputIndex`는 원래 `claims` 위치다. stored `parsed` index, occurrence ID와 요청
내 duplicate mapping은 REC-005가 승인 survivor를 확정한 뒤 계산한다.

### raw 마스킹

`raw_text`를 먼저 `raw_text` context로 검사한다. class와 위치가 유효하고 겹치지 않으며
UTF-16 surrogate pair를 자르지 않을 때만 뒤에서 앞으로
`[REDACTED:<UPPERCASE-CLASS>]`로 치환한다. 원문을 결과 finding이나 error에 복사하지 않는다.

detector가 알려진 class를 반환했지만 범위를 특정할 수 없거나 순서·겹침·Unicode 경계가
손상됐으면 ADR-011의 보수적 규칙대로 raw 전체를 `[REDACTED:SECRET]`로 바꾼다. registry
version, class 또는 result shape 자체가 계약과 다르거나 detector가 예외를 던지면
`DETECTOR_FAILED`로 호출 전체를 중단한다. result/finding은 exact enumerable data property와
dense bounded array로 snapshot하며 accessor를 실행해 값을 얻지 않는다. detector가 같은
`RecordSecretSanitizationError` 타입을 던져도 그 객체는 신뢰하지 않고, message·cause·임의
property를 버린 새로운 고정 오류로 치환한다.

### draft 검사와 부분 성공

각 draft는 다음 순서의 실제 저장 문자열을 전부 검사한다.

1. subject, subject_kind
2. object, object_kind 또는 object_value
3. relation_label
4. subject_aliases, object_aliases의 배열 순서

첫 hit의 필드 경로와 class만 note에 사용하지만, hit 이후 필드도 끝까지 검사한다. 따라서
뒤쪽 detector 장애가 앞선 draft 거부에 가려져 fail-open되지 않는다. hit가 하나라도 있으면
그 draft 전체만 제외하며, 다른 draft와 마스킹 raw는 계속 진행한다. 모든 draft가 거부된
일반 record도 `approvedDrafts: []`인 유효 plan이다.

note 형식은 서버가 만든
`Secret detected at claims[N].field (class=C); remove the secret and retry.`이며 탐지 문자열,
주변 prefix/suffix, SQL, DB 경로와 detector cause를 포함하지 않는다. 위치가 손상됐으면
class도 `secret`으로 축약한다.

### 재해석과 실패 경계

`supersedes`가 있는 입력은 일부 draft만으로 successor를 만들 수 없다. 입력 claims가 처음부터
빈 배열이면 raw-only 재해석 plan을 허용하지만, 하나라도 draft가 거부되면 frozen safe
rejection 목록을 가진 `REINTERPRET_DRAFT_REJECTED`를 던진다. 이 순수 함수는 write capability를
받지 않으므로 detector failure나 재해석 거부 전에 journal write가 시작될 경로가 없다.

sanitizer runtime과 typed error는 application 내부 export다. package root는 REC-005 이후
조립에 필요한 type만 type-only로 다시 내보내므로 기존 empty runtime root를 바꾸지 않는다.

## TDD와 검증

최초 tests-only RED는 production build 성공 뒤 `dist/application/index.js`에
`RecordSecretSanitizationError` export가 없어 test module load가 0/1로 실패했다.

GREEN fixture는 다음을 검증한다.

- explicit/entropy raw 다중 치환과 평문 미보유
- draft 하나·전부 거부, 안전 draft clone과 원래 index
- subject/kind/object/value/label/양방향 alias 전체 context와 검사 순서
- UTF-16 astral 인접 slice, 겹침·역순·surrogate split·범위 손상 fallback
- detector 예외, unknown class, extra payload와 malformed result의 redacted fail-closed
- payload를 붙인 detector-owned typed error도 동일 객체를 재사용하지 않는 고정 오류 치환
- 앞선 hit 뒤의 detector 장애가 숨지 않음
- detector 실행 중 caller-owned raw/draft/alias 변경이 승인 plan에 섞이지 않음
- result/finding accessor와 sparse·extra payload가 실행되거나 plan에 섞이지 않음
- 재해석 부분 성공 금지와 raw-only 재해석
- 결과, alias 배열과 error rejection 목록의 immutable 경계

독립 review는 detector가 payload-bearing `RecordSecretSanitizationError`를 직접 던지면 같은
객체가 밖으로 나오는 경계를 찾았다. production 수정 전 회귀는 target 16/17 RED였고, 모든
detector 예외를 새 `DETECTOR_FAILED`로 바꾼 뒤 17/17 GREEN으로 닫았다.

전용 재현 명령은 다음과 같다.

```bash
pnpm verify:rec-003
```

behavior 의미는 독립 Python oracle의 S18을 전체 25-test suite로 대조한다. 실제 DB journal,
FTS, WAL, projection, log와 MCP response 어디에도 secret이 남지 않는 black-box scan은
REC-008/MCP-005가 최종 소유한다.

## 남은 경계

- REC-005: 의미 검증, duplicate survivor와 input/stored index·occurrence mapping
- REC-006: 마스킹 raw와 승인 parsed의 한 transaction append/project
- REC-008/MCP-005: DB/FTS/WAL/log/response 전체 누출 회귀
- Phase 05: revise note 마스킹과 alias/merge/correct 의미 입력 전체 거부
