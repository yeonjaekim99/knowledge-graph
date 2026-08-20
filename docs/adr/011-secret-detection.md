# ADR-011: 비밀값 탐지 규칙과 오탐 처리

- 상태: Accepted
- 결정일: 2026-08-20
- 소유 영역: 초기 설계 4.5
- 선행 ADR: 없음
- Supersedes: 없음

## Context

Recall의 journal은 정상 동작에서 수정·삭제하지 않으며 FTS와 recall을 통해 내용이 다시
노출된다. API key, token, password 또는 private key가 한번 기록되면 일반 retraction은
검색 결과만 숨길 뿐 원문을 제거하지 못한다. 따라서 비밀값 검사는 journal INSERT보다
앞선 필수 보안 경계다.

형식 패턴만으로는 임의 token을 놓치고 entropy만으로는 commit SHA, UUID와 해시를
과도하게 차단한다. 패턴과 entropy를 결합하고 오탐 시 안전한 재시도 경로를 제공해야
한다.

## Decision

### 검사 범위와 순서

서버는 **모든 event body 문자열과 저장될 metadata**를 journal INSERT 전에 검사한다.

1. `raw_text`
2. subject, subject_kind, object, object_kind, object_value
3. relation_label
4. subject_aliases, object_aliases
5. revise note와 alias surface
6. actor와 branch

session 원문은 탐지 대상 이전에 ADR-003의 HMAC-SHA-256 상관키로 바꾸며 저장하지 않는다.
actor/branch hit는 해당 구간을 마스킹하고, detector가 실패하거나 위치를 특정하지
못하면 그 metadata만 NULL로 둔다. 사용자 memory body 검사는 아래 fail-closed 규칙을
그대로 따른다.

ADR-017의 `reinterpret_approval`은 단기 capability이므로 형식과 서버 보유값을 constant-
time으로 검증한 뒤 event body에서 제외한다. application log, metric label, journal과 오류
응답에 token을 남기지 않는다. 이 필드는 저장 대상이 아니므로 entropy allowlist가 아니라
별도의 인증 입력 경계로 처리한다.

알려진 provider 형식, private-key header, JWT, connection string과 자격 증명 URL은
버전 관리되는 signature registry로 탐지한다. registry에는 최소 AWS, GitHub, GitLab,
Google, Slack, Stripe 계열 token, PEM private key, JWT와 일반 password/secret assignment
패턴을 포함한다.

패턴에 걸리지 않은 연속 문자열은 다음을 모두 만족할 때 entropy 의심값으로 분류한다.

- 길이 20자 이상
- Shannon entropy 4.0 bits/character 이상
- 문자 종류가 둘 이상(대문자, 소문자, 숫자, 기호)

allowlist는 값 모양만으로 전역 적용하지 않고 field/context에 묶는다.

- claim/entity/event target처럼 서버가 식별자 필드로 아는 곳의 UUID/ULID
- `commit`, `sha`, `checksum` 문맥이 인접하거나 로컬 git object로 확인된 7~64자리
  16진 값
- production에서 비활성인 문서화된 synthetic test fixture

문맥 없는 긴 16진 문자열은 secret일 수 있으므로 entropy 검사를 그대로 받는다.
allowlist는 어떤 경우에도 pattern detector 결과를 무시할 수 없다.

### raw_text와 draft 처리

- raw_text에서 탐지된 구간은 `[REDACTED:<class>]`로 치환한 뒤 journal에 저장한다.
- ClaimDraft의 어떤 필드에서든 탐지되면 그 draft 전체를 `rejected`로 제외한다.
- 다른 안전한 draft와 마스킹된 raw_text는 같은 statement에 기록할 수 있다.
- 모든 draft가 거부돼도 마스킹된 raw_text를 `parsed: []`로 기록할 수 있다.
- detector가 안전하게 위치를 특정하지 못하면 raw_text 전체를 `[REDACTED:SECRET]`로
  바꾸며 원문을 임시 파일이나 로그에 남기지 않는다.
- revise의 raw_text와 note는 같은 방식으로 마스킹할 수 있다. alias surface,
  merge의 surface 입력과 correct replacement처럼 사건 의미를 이루는 문자열에서
  탐지되면 값을 바꿔 실행하지 않고 revise 전체를 `rejected`로 반환한다.

거부 응답은 secret 원문, 일부 prefix/suffix 또는 entropy 문자열을 되돌려주지 않는다.
필드 경로, 탐지 class와 “비밀값을 제거하고 다시 호출”하는 안내만 제공한다.

### 로그와 보관

- tool arguments와 journal body를 application log에 기록하지 않는다.
- actor/branch 원문과 session 원문도 log에 기록하지 않는다.
- 탐지 metric은 class와 필드명만 집계한다.
- DB 파일, WAL과 backup은 OS 권한으로 현재 사용자/서비스 계정만 읽을 수 있게 한다.
- 원격 전송을 지원할 때는 transport 암호화와 요청별 인증을 별도 배포 요구사항으로 둔다.

### 누출 사고

detector를 통과한 실제 비밀을 발견하면 일반 retraction만으로 해결됐다고 간주하지
않는다.

1. 해당 credential을 즉시 폐기·회전한다.
2. 서버를 중지하고 DB 및 backup을 격리한다.
3. 원본 seq와 event ID를 보존하면서 해당 body만 마스킹한 새 DB를 만드는 보안 복구
   절차를 실행한다.
4. 원본 DB는 접근 통제된 사고 증적으로 격리하거나 정책에 따라 파기한다.
5. detector regression fixture를 추가한다.

이 offline 보안 복구는 정상 event semantics가 아니며 운영자의 명시적 승인과 감사
기록을 요구한다. 보안상 비밀값 제거가 append-only 원칙보다 우선한다.

signature/entropy 규칙 버전을 올릴 때는 기존 journal을 읽기 전용으로 다시 검사한다.
새 탐지 hit는 replay로 마스킹할 수 없으므로 위 누출 사고 절차의 후보로 보고하고,
자동 UPDATE나 단순 retraction으로 끝내지 않는다.

## Alternatives

### 탐지 시 전체 호출 차단

가장 단순하지만 안전한 draft와 원문 맥락까지 유실된다. raw 마스킹과 draft별 부분
성공을 선택했다.

### entropy 검사 제외

오탐은 줄지만 형식이 없는 고엔트로피 token을 놓친다. 명시적 allowlist와 재시도
안내로 오탐 비용을 제한한다.

### 암호화해서 그대로 저장

암호화 at rest는 DB 탈취 위험을 줄이지만 정상 recall이 복호화해 비밀을 노출할 수
있다. 저장 전 제거를 대체하지 않는다.

### retraction으로 나중에 숨김

journal과 backup에 평문이 남으므로 비밀값 제거 요구를 충족하지 못한다.

## Consequences

- journal과 FTS에는 알려진 비밀값이 평문으로 들어가지 않는다.
- 고엔트로피 build ID 등 일부 정상 값이 거부될 수 있다.
- signature registry와 fixture를 지속해서 갱신해야 한다.
- raw_text와 parsed 내용이 일부 다를 수 있으며 rejected 결과가 이를 설명한다.
- 실제 누출 시 credential 회전과 offline 복구가 필요하다.

## Validation

- 각 signature class의 synthetic secret이 journal, FTS, tool error와 log 어디에도
  평문으로 남지 않아야 한다.
- commit/checksum 문맥의 SHA와 식별자 필드 UUID/ULID는 통과하고, 문맥 없는 고엔트로피
  hex는 보류돼야 한다.
- 한 draft만 비밀을 포함한 요청에서 나머지 draft와 마스킹 raw가 기록돼야 한다.
- correct replacement나 alias surface에서 비밀을 탐지하면 철회/alias 사건이 일부만
  기록되지 않고 revise 전체가 실패해야 한다.
- detector가 예외를 던지면 fail-open이 아니라 전체 write를 롤백해야 한다.
- 로그 캡처 테스트에서 tool argument/body가 나타나지 않아야 한다.
- secret 모양 clientInfo/branch가 마스킹되고 session 원문은 DB/FTS/log 어디에도 없어야 한다.
- reinterpret approval token이 journal, FTS, log와 error에 남지 않고 비교가 실패하면
  재해석 사건이 생기지 않아야 한다.

## References

- 초기 설계 4.5
- ADR-001, ADR-013
- [OWASP Secrets Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html)
- [OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)
- [GitHub supported secret scanning patterns](https://docs.github.com/en/code-security/reference/secret-security/supported-secret-scanning-patterns)
