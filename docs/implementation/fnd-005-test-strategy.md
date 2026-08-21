# FND-005: 로컬 TDD 테스트 계층과 oracle 전략

- 상태: Accepted
- 결정일: 2026-08-21
- 작업: FND-005
- Owner: `log0629`
- PR: [#11](https://github.com/yeonjaekim99/knowledge-graph/pull/11)
- 규범 관계: ADR을 대체하지 않는 implementation decision

## 기존 증거와 production gap

behavior spike의 S01~S24는 Python reference model에서 ADR 상태 의미, 288개 adversarial
prefix와 8개 process crash case가 함께 성립함을 확인했다. FND-002~004는 production
TypeScript의 module 경계, 결정적 runtime provider, JSON Schema source와 각각의 targeted
Node test를 제공한다.

FND-005는 이 동작들을 다시 구현하거나 Python 코드를 TypeScript로 옮기지 않는다. 아직
남아 있던 다음 test infrastructure gap만 닫는다.

- 후속 작업이 같은 위치와 명령을 쓰는 unit/integration/contract/e2e/performance 계층
- S01~S24를 누락·중복 없이 production black-box test로 이전할 기계 판독 계획
- 증분 journal prefix와 독립 full replay 결과를 비교할 공통 canonical harness
- 실패를 seed·clock·locale·prefix로 재현하되 payload와 secret을 노출하지 않는 문맥
- 자동 CI 없이 깨끗한 checkout에서 재현할 단일 로컬 빠른 검증 명령

## 결론

Node.js 내장 `node:test`를 유일한 test runner로 사용한다. 별도 test framework나 mocking
library를 추가하지 않는다. [`test-layers.json`](../../test/test-layers.json)이 계층,
suite와 고정 process environment의 단일 원본이고
[`run-test-layers.mjs`](../../scripts/run-test-layers.mjs)가 이를 읽어 test file을 정렬한 뒤
하나의 child Node process로 실행한다.

```text
pnpm test
  ├─ build production TypeScript
  └─ fast suite (고정 TZ/locale/clock/seed)
       ├─ foundation
       ├─ unit
       ├─ integration/sqlite
       ├─ integration/projection
       ├─ contract/mcp
       └─ e2e/process

pnpm test:performance
  └─ performance (명시 실행, fast에서 제외)
```

Recall v1에는 자동 CI workflow를 만들지 않는다. `pnpm verify:local`이 현재 repository의
필수 로컬 gate이며, 각 PR은 실행 결과를 본문에 남기고 reviewer가 확인한다. 이 결정은
[FND-006 범위 제외 결정](fnd-006-ci-retirement.md)을 따른다.

## 테스트 계층

| 계층 | 관찰 경계 | 실제 자원 | 현재 FND-005 범위 |
|---|---|---|---|
| `foundation` | architecture/runtime/schema/test support 계약 | production build와 local filesystem fixture | 기존 29개 + FND-005 infrastructure test |
| `unit` | IO 없는 domain/application 정책 | 없음 | 디렉터리·runner 계약만, 제품 test는 후속 작업 |
| `integration/sqlite` | migration, WAL, transaction, FTS | **실제 임시 SQLite file** | 구조만, STO/RCL 작업이 test 추가 |
| `integration/projection` | journal prefix, projector/replay 결과 | 실제 SQLite adapter 또는 독립 runner | parity harness만, PRJ 작업이 의미 구현 |
| `contract/mcp` | catalog, JSON Schema, structured result, protocol | **실제 MCP SDK/transport** | 구조만, MCP 작업이 test 추가 |
| `e2e/process` | hard exit, reopen, 동시 client | **별도 child process** | 구조만, STO/REL 작업이 test 추가 |
| `performance` | 10만 event/claim p50·p95와 plan | 대표 file DB/process | 구조만, 기본 suite에서 제외 |

선택한 계층에 test가 아직 없으면 runner는 `test_files=0`과
`PASS (no tests assigned yet)`를 명시한다. 이는 제품 gate 통과 증거가 아니다. 각 roadmap
작업의 완료 체크는 자기 target test를 먼저 RED로 만들고 실제 자원에서 GREEN으로 바꿔야
한다.

## 로컬 TDD 계약

모든 제품 작업은 다음 순서를 따른다.

1. active roadmap 작업과 Accepted ADR Validation에서 하나의 관찰 가능한 실패를 고른다.
2. 소유 계층에 black-box test를 쓰고 **아직 없는 제품 동작 때문에** RED인지 확인한다.
3. 해당 test를 통과시키는 최소 production 변경을 구현한다.
4. target 계층 GREEN 뒤 `pnpm test`로 빠른 전체 회귀를 실행한다.
5. 상태 의미를 바꾸면 scenario manifest의 target과 parity/golden evidence를 함께 갱신한다.
6. 성능 작업만 fixture 생성 시간을 제외하고 `pnpm test:performance`를 별도로 실행한다.

잘못된 import, 준비되지 않은 fixture나 환경 의존으로 난 실패는 RED 증거가 아니다. test는
public/application seam을 호출하며 `spikes/adr-behavior`를 import하지 않는다. Python
reference는 별도 process의 승인된 비교 oracle로 사용할 수 있지만 production 구조나
reducer source로 복사하지 않는다.

## S01~S24 production 이전 manifest

[`adr-production-scenarios.json`](../../test/manifests/adr-production-scenarios.json)은 각
scenario에 다음을 고정한다.

- source Python test method와 ADR 목록
- production 계층과 유일한 target `.test.mjs` 경로
- roadmap traceability의 구현·검증 owner task 전체
- `planned` 또는 `implemented` 상태
- source matrix exact UTF-8 byte의 SHA-256

foundation test는 source checksum, S01~S24 순서·개수, ADR 목록, target 중복, 계층 root,
roadmap task 연결과 target file 존재 여부를 검사한다. 후속 owner는 target test와 production
동작을 같은 PR에서 추가한 뒤에만 `implemented`로 바꾼다. 현재 24개는 의도적으로 모두
`planned`이며 FND-005가 그 의미를 선점하지 않는다.

ADR-016 MCP transport와 production 성능은 Python spike 밖이었다. manifest의
`MCP-CONTRACT`와 `PERFORMANCE` non-scenario gate가 각각 contract/performance 계층과 후속
owner를 별도로 추적한다.

## 결정적 실행 문맥

runner는 모든 test child process에 다음 값을 덮어쓴다.

| 값 | 고정값 |
|---|---|
| timezone | `TZ=UTC` |
| process locale | `LANG=C`, `LC_ALL=C` |
| 명시 locale | `RECALL_TEST_LOCALE=en-US` |
| base clock | `RECALL_TEST_NOW_SECONDS=1700000000` |
| seed | `RECALL_TEST_SEED=recall-fnd-005-v1` |

[`deterministic-test-context.mjs`](../../test/support/deterministic-test-context.mjs)는 이 값을
검증해 frozen clock, label 기반 SHA-256 entropy와 reproduction record를 만든다. entropy는
호출 순서에 의존하지 않으므로 병렬 test 순서가 바뀌어도 같은 label은 같은 byte를 얻는다.
시간 변화는 ambient clock 대신 명시적 non-negative second offset으로 표현한다.

실패 reproduction은 `scenario_id`, seed, prefix length, base clock, timezone과 locale만
담는다. event body, raw_text, secret, SQL, 절대 DB 경로나 임의 환경 변수는 포함하지 않는다.

## canonical projection과 parity harness

후속 PRJ test는 다음 두 독립 runner를
[`runReplayParity`](../../test/support/replay-parity-harness.mjs)에 주입한다.

- `createIncrementalRunner`: 상태를 한 번 만들고 사건을 하나씩 누적 적용한다.
- `fullReplayRunner`: 매 prefix의 journal 전체로 새 projection을 만든다.

harness는 빈 prefix 0을 포함해 모든 prefix를 비교하며 첫 mismatch에서 fail fast한다.
입력 event는 JSON-safe copy로 만든 뒤 재귀 freeze해 runner가 fixture를 수정하지 못하게 한다.
mismatch error에는 두 checksum과 안전한 reproduction record만 남기고 projection/event
payload를 보유하지 않는다. incremental runner의 `dispose`는 성공과 실패 양쪽에서 호출한다.

[`canonicalProjectionDump`](../../test/support/canonical-projection.mjs)는 table마다
`primaryKey`와 row 배열을 받고 다음 규칙으로 `recall-projection-v1` dump와 lowercase
SHA-256을 만든다.

1. 값은 NULL, boolean, finite/safe number, string, dense array와 plain object인 JSON-safe
   subset만 허용한다. cycle, accessor, symbol, bigint, unsafe/non-finite number와 class
   instance는 fail closed다.
2. object key와 table은 정렬하고, row는 type-tagged/UTF-8 length-prefixed primary-key tuple로
   정렬한다. 같은 PK 두 개나 누락된 PK는 거부한다.
3. array 순서는 보존하고 문자열 길이는 code unit이 아닌 UTF-8 byte로 센다.
4. output 자체도 JSON-safe하고 recursively frozen이다.

production dumper는 manifest에 적힌 `statements`, `entities`, `surface_forms`, `claims`,
`claim_support`, `id_redirects`만 포함한다. 실행마다 달라지는 `projection_meta`, migration과
FTS는 제외한다. 실제 table query와 PK descriptor는 PRJ-001/009가 소유하며 FND-005는 DB나
projector를 구현하지 않는다.

## 대안

### Python spike test를 production suite로 그대로 사용

이미 동작하지만 TypeScript production과 같은 module·driver·MCP 경계를 검증하지 못하고
독립 oracle을 잃는다. source checksum과 target manifest만 공유한다.

### Jest, Vitest 또는 property-test framework 추가

fixture와 matcher는 풍부하지만 현재 요구는 Node 24 내장 runner, 작은 deterministic helper와
고정 seed로 충족된다. 필요를 증명하는 후속 test가 생길 때 dependency를 재검토한다.

### 매 prefix마다 incremental runner도 새로 실행

full replay 두 개를 비교할 뿐 실제 누적 적용 오류를 찾지 못한다. 하나의 incremental
runner를 누적하고 full runner만 prefix마다 새로 호출한다.

### canonical JSON 문자열만 비교

object/row 입력 순서와 UTF-8 길이, 비JSON 값이 조용히 흔들릴 수 있다. 명시적 type tag,
length prefix, PK 정렬과 checksum을 사용한다.

### performance test를 기본 빠른 suite에 포함

TDD feedback을 느리게 하고 일상 test에서 수치 변동을 만든다. 성능 gate는 명시 명령과
대표 fixture를 소유하는 RCL/REL 작업에서만 실행한다.

## 범위 경계

- FND-005는 production `src/`의 storage, projector, MCP tool이나 실제 S01~S24 동작을
  추가하지 않는다.
- STO 작업은 실제 file DB, migration/WAL/transaction과 process recovery fixture를 만든다.
- PRJ-001/009/010은 production incremental/full replay runner와 S01~S24 parity를 연결한다.
- REC/REV/RCL 작업은 자기 scenario target을 black-box vertical test로 구현한다.
- MCP-002~008은 실제 SDK/transport contract와 agent fixture를 구현한다.
- RCL-009/REL-001~004는 대표 규모와 performance gate를 구현한다.
- FND-007은 깨끗한 checkout에서 이 로컬 명령을 재현하는 기여 문서를 완성한다.

Accepted ADR의 상태 의미를 바꾸지 않으므로 superseding ADR은 필요하지 않다.

## 검증

RED 확인:

```text
node --test test/foundation/test-plan.test.mjs \
  test/foundation/deterministic-test-context.test.mjs \
  test/foundation/replay-parity-harness.test.mjs

ERR_MODULE_NOT_FOUND: 세 support module 부재, 0 pass / 3 fail
```

GREEN과 회귀 명령:

```bash
pnpm verify:fnd-005
python3 docs/roadmap/validate.py
python3 -m unittest discover -s spikes/adr-behavior -p 'test_*.py' -v
git diff --check
```

새 foundation test는 정상·경계·실패 경로를 포함한다.

- 정상: 7개 계층/고정 environment, S01~S24 manifest, deterministic entropy/clock, 모든 prefix
  parity와 ordering-independent canonical checksum
- 경계: 빈 journal prefix, 빈 future 계층, UTF-8 byte 길이, empty entropy, zero offset
- 실패: source/task drift, unknown selector, invalid environment/context, non-JSON/cycle/accessor,
  missing/duplicate PK, frozen event mutation과 의도적 prefix mismatch
- 보안: mismatch JSON/message에 event secret이 없고 reproduction 필드가 allowlist다.

## 증거

- PR: [#11](https://github.com/yeonjaekim99/knowledge-graph/pull/11)
- `pnpm verify:fnd-005`: production probe, architecture/type/build와 local fast suite 42/42 통과
- `python3 docs/roadmap/validate.py`: active 73, historical 74, retired 1, ADR 17/17,
  scenario 24/24와 dependency graph 통과
- 깨끗한 `git archive`에서 `pnpm install --frozen-lockfile`과 같은 FND-005 gate 통과
- `pnpm audit --prod`: 알려진 취약점 0개
- behavior oracle: S01~S24 25/25는 독립 회귀로 유지
- `git diff --check`와 새 JavaScript 파일 syntax 검사 통과
