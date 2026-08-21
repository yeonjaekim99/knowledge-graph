from __future__ import annotations

import base64
import contextlib
import hashlib
import json
import math
import re
import secrets
import sqlite3
import threading
import unicodedata
from collections import defaultdict, deque
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable, Iterator, Sequence


RULES_VERSION = "adr-spike-v1"
CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
ORIGIN_PRIORITY = {"agent_supplied": 1, "name": 2, "confirmed": 3}
RELATIONS = {"uses", "rejects", "contains", "describes", "relates_to"}
DEFAULT_PREDICATES = {
    "uses": "사용",
    "rejects": "거부",
    "contains": "포함",
    "describes": "=",
    "relates_to": "관련",
}
PROVENANCE_RANK = {"inferred": 1, "observed": 2, "user_stated": 3}
TTL_SECONDS = {"session": 43_200, "weeks": 2_592_000, "permanent": None}
DEFAULT_TTL = {
    "user_stated": "permanent",
    "observed": "permanent",
    "inferred": "weeks",
}


SCHEMA = r"""
CREATE TABLE IF NOT EXISTS journal (
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

CREATE INDEX IF NOT EXISTS idx_journal_scope ON journal(scope_key, seq);

CREATE VIRTUAL TABLE IF NOT EXISTS journal_fts USING fts5(
  raw_text,
  content='',
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS journal_ai AFTER INSERT ON journal
WHEN new.kind = 'statement' BEGIN
  INSERT INTO journal_fts(rowid, raw_text)
  VALUES (new.seq, json_extract(new.body, '$.raw_text'));
END;

CREATE TABLE IF NOT EXISTS statements (
  event_id    TEXT PRIMARY KEY REFERENCES journal(id),
  scope_key   TEXT NOT NULL,
  state       TEXT NOT NULL CHECK (state IN ('live','retracted','superseded')),
  order_seq   INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  provenance  TEXT NOT NULL
    CHECK (provenance IN ('user_stated','observed','inferred')),
  expires_at  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_statements_live
  ON statements(scope_key) WHERE state = 'live';

CREATE TABLE IF NOT EXISTS entities (
  id          TEXT PRIMARY KEY,
  scope_key   TEXT NOT NULL,
  name        TEXT NOT NULL,
  normal_name TEXT NOT NULL,
  kind        TEXT,
  merged_into TEXT REFERENCES entities(id),
  origin_seq  INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_normal
  ON entities(scope_key, normal_name) WHERE merged_into IS NULL;

CREATE TABLE IF NOT EXISTS surface_forms (
  scope_key    TEXT NOT NULL,
  surface_norm TEXT NOT NULL,
  entity_id    TEXT NOT NULL REFERENCES entities(id),
  origin       TEXT NOT NULL
    CHECK (origin IN ('name','agent_supplied','confirmed')),
  PRIMARY KEY (scope_key, surface_norm, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_surface_lookup
  ON surface_forms(scope_key, surface_norm);

CREATE TABLE IF NOT EXISTS claims (
  id             TEXT PRIMARY KEY,
  scope_key      TEXT NOT NULL,
  subject_id     TEXT NOT NULL REFERENCES entities(id),
  relation       TEXT NOT NULL
    CHECK (relation IN ('uses','rejects','contains','describes','relates_to')),
  object_id      TEXT REFERENCES entities(id),
  object_value   TEXT,
  state          TEXT NOT NULL
    CHECK (state IN ('active','superseded','retracted')),
  origin_seq     INTEGER NOT NULL,
  first_seen_at  INTEGER NOT NULL,
  last_seen_at   INTEGER NOT NULL,
  CHECK ((object_id IS NULL) <> (object_value IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_claim_identity_entity_active
  ON claims(scope_key, subject_id, relation, object_id)
  WHERE state='active' AND object_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_claim_identity_value_active
  ON claims(scope_key, subject_id, relation, object_value)
  WHERE state='active' AND object_value IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_claims_describes_single
  ON claims(scope_key, subject_id)
  WHERE state='active' AND relation='describes';

CREATE TABLE IF NOT EXISTS claim_support (
  claim_id    TEXT NOT NULL REFERENCES claims(id),
  event_id    TEXT NOT NULL REFERENCES statements(event_id),
  draft_index INTEGER NOT NULL,
  live        INTEGER NOT NULL DEFAULT 1 CHECK (live IN (0,1)),
  expires_at  INTEGER,
  PRIMARY KEY (claim_id, event_id),
  UNIQUE (event_id, draft_index)
);

CREATE INDEX IF NOT EXISTS idx_support_event ON claim_support(event_id);
CREATE INDEX IF NOT EXISTS idx_claims_subject
  ON claims(subject_id, relation) WHERE state='active';
CREATE INDEX IF NOT EXISTS idx_claims_object
  ON claims(object_id, relation)
  WHERE state='active' AND object_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS id_redirects (
  old_id TEXT PRIMARY KEY,
  new_id TEXT NOT NULL,
  kind   TEXT NOT NULL CHECK (kind IN ('entity','claim')),
  reason TEXT NOT NULL CHECK (reason IN ('merge','rule_change','deduplicated')),
  CHECK (old_id <> new_id)
);

CREATE INDEX IF NOT EXISTS idx_redirect_new ON id_redirects(new_id);

CREATE TABLE IF NOT EXISTS projection_meta (
  scope_key     TEXT PRIMARY KEY,
  last_seq      INTEGER NOT NULL,
  rules_version TEXT NOT NULL,
  rebuilt_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  checksum   TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);
"""


class SpikeError(RuntimeError):
    """Base error raised by the executable reference model."""


class ValidationError(SpikeError):
    pass


class InvariantError(SpikeError):
    pass


class InjectedFailure(SpikeError):
    pass


@dataclass(frozen=True)
class Approval:
    scope_key: str
    target_event_id: str
    through_seq: int
    raw_text: str
    parsed_json: str
    provenance: str
    ttl: str
    expires_at: int


def normalize_v1(value: str) -> str:
    value = unicodedata.normalize("NFKC", value.strip()).lower()
    value = "".join(ch for ch in value if not (ch.isspace() or ch in "_-"))
    if not value:
        raise ValidationError("normalization produced an empty value")
    return value


def normalize_literal(value: str) -> str:
    value = unicodedata.normalize("NFKC", value.strip())
    if not value:
        raise ValidationError("literal object must not be empty")
    return value


def normalize_kind(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = unicodedata.normalize("NFKC", value.strip()).lower()
    if not normalized or len(normalized) > 64:
        raise ValidationError("kind must contain 1..64 Unicode characters")
    return normalized


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def event_id_for_seq(seq: int) -> str:
    if seq <= 0:
        raise ValueError("seq must be positive")
    value = seq
    encoded = []
    for _ in range(26):
        encoded.append(CROCKFORD[value & 31])
        value >>= 5
    if value:
        raise ValueError("sequence is too large for a canonical ULID-shaped value")
    return "ev_" + "".join(reversed(encoded))


def id_order(identifier: str) -> tuple[int, int]:
    match = re.fullmatch(r"[ce]([1-9][0-9]*)\.([0-9]+)", identifier)
    if not match:
        raise InvariantError(f"non-canonical anchored id: {identifier}")
    return int(match.group(1)), int(match.group(2))


def expiry(created_at: int, ttl: str) -> int | None:
    seconds = TTL_SECONDS[ttl]
    return None if seconds is None else created_at + seconds


def _entropy(value: str) -> float:
    if not value:
        return 0.0
    counts: dict[str, int] = defaultdict(int)
    for char in value:
        counts[char] += 1
    length = len(value)
    return -sum((count / length) * math.log2(count / length) for count in counts.values())


SECRET_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    (
        "aws-access-key",
        re.compile(r"(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![A-Za-z0-9])"),
    ),
    (
        "github-token",
        re.compile(r"(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{20,}(?![A-Za-z0-9])"),
    ),
    (
        "jwt",
        re.compile(
            r"(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]+\."
            r"[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?![A-Za-z0-9_-])"
        ),
    ),
    ("private-key", re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----")),
    (
        "credential-url",
        re.compile(r"\b[a-z][a-z0-9+.-]*://[^\s:/]+:[^\s/@]+@", re.IGNORECASE),
    ),
    (
        "secret-assignment",
        re.compile(r"\b(?:password|passwd|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+", re.IGNORECASE),
    ),
)


def secret_hits(value: str, *, context: str = "") -> list[tuple[int, int, str]]:
    hits: list[tuple[int, int, str]] = []
    for kind, pattern in SECRET_PATTERNS:
        hits.extend((match.start(), match.end(), kind) for match in pattern.finditer(value))
    if hits:
        return sorted(hits)

    lower_context = context.lower()
    for match in re.finditer(r"[A-Za-z0-9+/=_-]{20,}|[0-9a-fA-F]{20,64}", value):
        token = match.group(0)
        if re.fullmatch(r"ev_[0-7][0-9A-HJKMNP-TV-Z]{25}", token):
            continue
        if re.fullmatch(r"[0-9a-fA-F]{7,64}", token) and any(
            marker in lower_context for marker in ("commit", "sha", "checksum")
        ):
            continue
        classes = sum(
            bool(re.search(pattern, token))
            for pattern in (r"[a-z]", r"[A-Z]", r"[0-9]", r"[^A-Za-z0-9]")
        )
        if len(token) >= 20 and classes >= 2 and _entropy(token) >= 4.0:
            hits.append((match.start(), match.end(), "high-entropy"))
    return sorted(hits)


def mask_secrets(value: str, *, context: str = "") -> tuple[str, list[str]]:
    hits = secret_hits(value, context=context)
    if not hits:
        return value, []
    merged: list[tuple[int, int, str]] = []
    for start, end, kind in hits:
        if merged and start < merged[-1][1]:
            old_start, old_end, old_kind = merged[-1]
            merged[-1] = (old_start, max(old_end, end), old_kind)
        else:
            merged.append((start, end, kind))
    pieces: list[str] = []
    cursor = 0
    classes: list[str] = []
    for start, end, kind in merged:
        pieces.append(value[cursor:start])
        pieces.append(f"[REDACTED:{kind.upper()}]")
        cursor = end
        classes.append(kind)
    pieces.append(value[cursor:])
    return "".join(pieces), classes


def _typed_bytes(value: Any) -> bytes:
    if value is None:
        return b"n0:"
    if isinstance(value, int):
        payload = str(value).encode("ascii")
        return b"i" + str(len(payload)).encode("ascii") + b":" + payload
    if isinstance(value, bytes):
        return b"b" + str(len(value)).encode("ascii") + b":" + value
    payload = str(value).encode("utf-8")
    return b"s" + str(len(payload)).encode("ascii") + b":" + payload


class ReferenceSpike:
    """Naive executable oracle for ADR semantics.

    Every write rebuilds all projections. That is intentional: this class is a
    spike oracle, not the production incremental projector.
    """

    def __init__(
        self,
        db_path: str | Path,
        *,
        start_time: int = 1_700_000_000,
        fault_hook: Callable[[str], None] | None = None,
    ):
        self.db_path = str(db_path)
        self.conn = sqlite3.connect(
            self.db_path,
            isolation_level=None,
            timeout=5.0,
            check_same_thread=False,
        )
        self.conn.row_factory = sqlite3.Row
        self._write_lock = threading.RLock()
        self._clock = start_time
        self._approvals: dict[str, Approval] = {}
        self._fault_hook = fault_hook
        self._configure_first_writer()
        self.conn.executescript(SCHEMA)
        self._install_migration_record()
        self.capability_smoke_test()

    def close(self) -> None:
        self.conn.close()

    def __enter__(self) -> "ReferenceSpike":
        return self

    def __exit__(self, *_: Any) -> None:
        self.close()

    def _configure_first_writer(self) -> None:
        mode = self.conn.execute("PRAGMA journal_mode=WAL").fetchone()[0]
        if mode.lower() != "wal":
            raise InvariantError(f"WAL unavailable: {mode}")
        self.conn.execute("PRAGMA synchronous=NORMAL")
        self.conn.execute("PRAGMA busy_timeout=5000")
        self.conn.execute("PRAGMA cache_size=-20000")
        self.conn.execute("PRAGMA temp_store=MEMORY")
        self.conn.execute("PRAGMA foreign_keys=ON")

    def _install_migration_record(self) -> None:
        checksum = hashlib.sha256(SCHEMA.encode("utf-8")).hexdigest()
        existing = self.conn.execute(
            "SELECT name,checksum FROM schema_migrations WHERE version=1"
        ).fetchone()
        if existing is None:
            self.conn.execute(
                "INSERT INTO schema_migrations(version,name,checksum,applied_at) VALUES(1,?,?,?)",
                ("adr-spike-schema", checksum, self._clock),
            )
        elif existing["name"] != "adr-spike-schema" or existing["checksum"] != checksum:
            raise InvariantError("schema migration checksum mismatch on reopen")

    def _fault(self, point: str) -> None:
        if self._fault_hook is not None:
            self._fault_hook(point)

    def capability_smoke_test(self) -> dict[str, bool]:
        json_ok = self.conn.execute("SELECT json_extract('{\"a\":1}', '$.a')").fetchone()[0] == 1
        time_ok = isinstance(self.conn.execute("SELECT unixepoch()").fetchone()[0], int)
        self.conn.execute("CREATE VIRTUAL TABLE temp.fts_probe USING fts5(v, tokenize='trigram')")
        self.conn.execute("INSERT INTO temp.fts_probe(v) VALUES ('인증서버')")
        trigram_ok = self.conn.execute(
            "SELECT count(*) FROM temp.fts_probe WHERE fts_probe MATCH ?", ('"인증서"',)
        ).fetchone()[0] == 1
        self.conn.execute("DROP TABLE temp.fts_probe")
        if not (json_ok and time_ok and trigram_ok):
            raise InvariantError("required SQLite capability is missing")
        return {"json": json_ok, "unixepoch": time_ok, "fts5_trigram": trigram_ok}

    def _next_time(self, at: int | None) -> int:
        if at is not None:
            self._clock = max(self._clock, at)
            return at
        self._clock += 60
        return self._clock

    def _next_seq(self) -> int:
        return self.conn.execute("SELECT COALESCE(MAX(seq),0)+1 FROM journal").fetchone()[0]

    def _append_event(
        self,
        scope_key: str,
        kind: str,
        body: dict[str, Any],
        *,
        at: int,
        actor: str | None = None,
        branch: str | None = None,
        session: str | None = None,
    ) -> tuple[str, int]:
        seq = self._next_seq()
        event_id = event_id_for_seq(seq)
        self._fault("before_journal_insert")
        self.conn.execute(
            "INSERT INTO journal(id,scope_key,kind,body,actor,branch,session,created_at) "
            "VALUES(?,?,?,?,?,?,?,?)",
            (event_id, scope_key, kind, canonical_json(body), actor, branch, session, at),
        )
        self._fault("after_journal_insert")
        actual_seq = self.conn.execute("SELECT seq FROM journal WHERE id=?", (event_id,)).fetchone()[0]
        if actual_seq != seq:
            raise InvariantError("deterministic event ID does not match assigned seq")
        return event_id, seq

    @contextlib.contextmanager
    def _write(self) -> Iterator[None]:
        with self._write_lock:
            self.conn.execute("BEGIN IMMEDIATE")
            try:
                yield
                self._fault("before_commit")
                self.conn.commit()
            except BaseException:
                if self.conn.in_transaction:
                    self.conn.rollback()
                raise
            self._fault("after_commit")

    @staticmethod
    def _validate_scope(scope_key: str) -> None:
        if not re.fullmatch(r"u:[A-Za-z0-9._-]{1,64}/p:[A-Za-z0-9._-]{1,64}", scope_key):
            raise ValidationError("invalid server-derived scope_key")

    @staticmethod
    def _validate_draft(draft: dict[str, Any]) -> dict[str, Any]:
        allowed = {
            "subject",
            "subject_kind",
            "relation",
            "relation_label",
            "object",
            "object_kind",
            "object_value",
            "subject_aliases",
            "object_aliases",
        }
        if set(draft) - allowed:
            raise ValidationError("draft contains unknown fields")
        subject = draft.get("subject")
        if not isinstance(subject, str) or not subject.strip():
            raise ValidationError("draft subject is required")
        relation = draft.get("relation")
        if relation not in RELATIONS:
            raise ValidationError("draft relation is outside the closed vocabulary")
        has_object = isinstance(draft.get("object"), str) and bool(draft["object"].strip())
        has_value = isinstance(draft.get("object_value"), str) and bool(draft["object_value"].strip())
        if has_object == has_value:
            raise ValidationError("exactly one of object and object_value is required")
        if not has_object and (draft.get("object_aliases") or draft.get("object_kind")):
            raise ValidationError("object aliases/kind require an entity object")
        label = draft.get("relation_label")
        if relation == "relates_to" and (not isinstance(label, str) or not label.strip()):
            raise ValidationError("relates_to requires relation_label")
        result = dict(draft)
        result["subject"] = subject.strip()
        if has_object:
            result["object"] = draft["object"].strip()
        else:
            result["object_value"] = draft["object_value"].strip()
        if label is not None:
            result["relation_label"] = label.strip()
        for key in ("subject_kind", "object_kind"):
            if key in result:
                result[key] = normalize_kind(result[key])
        for key in ("subject_aliases", "object_aliases"):
            if key in result:
                aliases = []
                for alias in result[key]:
                    alias = alias.strip()
                    if alias and alias not in aliases:
                        aliases.append(alias)
                result[key] = aliases
        return result

    @staticmethod
    def _draft_strings(draft: dict[str, Any]) -> Iterable[tuple[str, str]]:
        for key, value in draft.items():
            if isinstance(value, str):
                yield key, value
            elif isinstance(value, list):
                for index, item in enumerate(value):
                    if isinstance(item, str):
                        yield f"{key}[{index}]", item

    def _prepare_drafts(
        self, drafts: Sequence[dict[str, Any]], *, allow_partial: bool
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        if len(drafts) > 100:
            raise ValidationError("claims exceeds 100")
        accepted: list[dict[str, Any]] = []
        outcomes: list[dict[str, Any]] = []
        seen: dict[tuple[Any, ...], int] = {}
        for input_index, raw_draft in enumerate(drafts):
            draft = self._validate_draft(raw_draft)
            hit_field: str | None = None
            hit_class: str | None = None
            for field, value in self._draft_strings(draft):
                hits = secret_hits(value, context=field)
                if hits:
                    hit_field, hit_class = field, hits[0][2]
                    break
            if hit_field is not None:
                if not allow_partial:
                    raise ValidationError(
                        f"reinterpret draft rejected: {hit_field} contains {hit_class}"
                    )
                outcomes.append(
                    {
                        "index": input_index,
                        "status": "rejected",
                        "note": f"{hit_field} contains {hit_class}; remove the secret and retry",
                    }
                )
                continue
            key = (
                normalize_v1(draft["subject"]),
                draft["relation"],
                "entity" if "object" in draft else "value",
                normalize_v1(draft["object"])
                if "object" in draft
                else normalize_literal(draft["object_value"]),
            )
            if key in seen:
                outcomes.append(
                    {
                        "index": input_index,
                        "status": "reinforced",
                        "stored_index": seen[key],
                        "note": "duplicate draft folded into the first stored draft",
                    }
                )
                continue
            stored_index = len(accepted)
            seen[key] = stored_index
            accepted.append(draft)
            outcomes.append(
                {"index": input_index, "status": "accepted", "stored_index": stored_index}
            )
        return accepted, outcomes

    def record(
        self,
        scope_key: str,
        raw_text: str,
        drafts: Sequence[dict[str, Any]],
        *,
        provenance: str = "inferred",
        ttl: str | None = None,
        supersedes: str | None = None,
        reinterpret_approval: str | None = None,
        at: int | None = None,
        actor: str | None = None,
        branch: str | None = None,
        failpoint: str | None = None,
    ) -> dict[str, Any]:
        self._validate_scope(scope_key)
        if provenance not in PROVENANCE_RANK:
            raise ValidationError("invalid provenance")
        ttl = ttl or DEFAULT_TTL[provenance]
        if ttl not in TTL_SECONDS:
            raise ValidationError("invalid ttl")
        raw_text = raw_text.strip()
        if not raw_text or len(raw_text) > 32_768:
            raise ValidationError("raw_text must contain 1..32768 characters")
        masked_raw, _ = mask_secrets(raw_text, context="raw_text")
        parsed, outcomes = self._prepare_drafts(drafts, allow_partial=supersedes is None)
        if (supersedes is None) != (reinterpret_approval is None):
            raise ValidationError("supersedes and reinterpret_approval must appear together")

        event_time = self._next_time(at)
        with self._write():
            if supersedes is not None:
                source = self.conn.execute(
                    "SELECT s.*, j.body FROM statements s JOIN journal j ON j.id=s.event_id "
                    "WHERE s.event_id=? AND s.scope_key=? AND s.state='live'",
                    (supersedes, scope_key),
                ).fetchone()
                if source is None:
                    raise ValidationError("supersedes target is not a live statement in scope")
                source_body = json.loads(source["body"])
                if masked_raw.encode("utf-8") != source_body["raw_text"].encode("utf-8"):
                    raise ValidationError("reinterpret raw_text differs from stored source")
                source_ttl = source_body.get("ttl") or DEFAULT_TTL[source["provenance"]]
                if provenance != "inferred" and provenance != source["provenance"]:
                    raise ValidationError("reinterpret provenance must inherit the source")
                provenance = source["provenance"]
                if ttl != DEFAULT_TTL["inferred"] and ttl != source_ttl:
                    raise ValidationError("reinterpret ttl must inherit the source")
                ttl = source_ttl
                self._consume_approval(
                    reinterpret_approval,
                    scope_key,
                    supersedes,
                    masked_raw,
                    parsed,
                    provenance,
                    ttl,
                    event_time,
                )

            body: dict[str, Any] = {
                "raw_text": masked_raw,
                "parsed": parsed,
                "provenance": provenance,
                "ttl": ttl,
            }
            if supersedes is not None:
                body["supersedes"] = supersedes
            prior_claim_ids = {
                row[0] for row in self.conn.execute("SELECT id FROM claims").fetchall()
            }
            event_id, seq = self._append_event(
                scope_key,
                "statement",
                body,
                at=event_time,
                actor=actor,
                branch=branch,
            )
            if failpoint == "after_journal":
                raise InjectedFailure("after journal append")
            self._rebuild_all(failpoint=failpoint)

            result_rows: list[dict[str, Any]] = []
            stored_claims: dict[int, str] = {}
            for stored_index in range(len(parsed)):
                candidate = f"c{seq}.{stored_index}"
                stored_claims[stored_index] = self.resolve_redirect(candidate, "claim")
            for outcome in outcomes:
                item = {"index": outcome["index"], "status": outcome["status"]}
                if "stored_index" in outcome:
                    claim_id = stored_claims[outcome["stored_index"]]
                    item["claim_id"] = claim_id
                    if outcome["status"] == "accepted":
                        item["status"] = "reinforced" if claim_id in prior_claim_ids else "created"
                if outcome.get("note"):
                    item["note"] = outcome["note"]
                result_rows.append(item)
        if supersedes is not None:
            self._approvals.pop(reinterpret_approval, None)
        return {"event_id": event_id, "claims": result_rows}

    def issue_reinterpret_approval(
        self,
        scope_key: str,
        target_event_id: str,
        raw_text: str,
        drafts: Sequence[dict[str, Any]],
        *,
        now: int,
    ) -> str:
        source = self.conn.execute(
            "SELECT s.*, j.body FROM statements s JOIN journal j ON j.id=s.event_id "
            "WHERE s.event_id=? AND s.scope_key=? AND s.state='live'",
            (target_event_id, scope_key),
        ).fetchone()
        if source is None:
            raise ValidationError("approval target is not live in scope")
        source_body = json.loads(source["body"])
        masked_raw, _ = mask_secrets(raw_text, context="raw_text")
        if masked_raw.encode("utf-8") != source_body["raw_text"].encode("utf-8"):
            raise ValidationError("approval raw_text differs from source")
        parsed, _ = self._prepare_drafts(drafts, allow_partial=False)
        token = "ra_" + base64.urlsafe_b64encode(secrets.token_bytes(32)).decode("ascii").rstrip("=")
        if not re.fullmatch(r"ra_[A-Za-z0-9_-]{43}", token):
            raise InvariantError("approval token encoding is non-canonical")
        source_ttl = source_body.get("ttl") or DEFAULT_TTL[source["provenance"]]
        through_seq = self.conn.execute(
            "SELECT COALESCE(MAX(seq),0) FROM journal WHERE scope_key=?", (scope_key,)
        ).fetchone()[0]
        self._approvals[token] = Approval(
            scope_key=scope_key,
            target_event_id=target_event_id,
            through_seq=through_seq,
            raw_text=masked_raw,
            parsed_json=canonical_json(parsed),
            provenance=source["provenance"],
            ttl=source_ttl,
            expires_at=now + 900,
        )
        return token

    def _consume_approval(
        self,
        token: str | None,
        scope_key: str,
        target_event_id: str,
        raw_text: str,
        parsed: Sequence[dict[str, Any]],
        provenance: str,
        ttl: str,
        now: int,
    ) -> None:
        if token is None or not re.fullmatch(r"ra_[A-Za-z0-9_-]{43}", token):
            raise ValidationError("invalid reinterpret approval token")
        approval = self._approvals.get(token)
        if approval is None or now > approval.expires_at:
            raise ValidationError("reinterpret approval is missing or expired")
        through_seq = self.conn.execute(
            "SELECT COALESCE(MAX(seq),0) FROM journal WHERE scope_key=?", (scope_key,)
        ).fetchone()[0]
        expected = (
            approval.scope_key,
            approval.target_event_id,
            approval.through_seq,
            approval.raw_text,
            approval.parsed_json,
            approval.provenance,
            approval.ttl,
        )
        actual = (
            scope_key,
            target_event_id,
            through_seq,
            raw_text,
            canonical_json(parsed),
            provenance,
            ttl,
        )
        if not secrets.compare_digest(
            canonical_json(expected).encode("utf-8"),
            canonical_json(actual).encode("utf-8"),
        ):
            raise ValidationError("reinterpret approval does not match payload or through_seq")

    def _resolve_scoped_id(self, identifier: str, kind: str, scope_key: str) -> str:
        canonical = self.resolve_redirect(identifier, kind)
        table = "entities" if kind == "entity" else "claims"
        row = self.conn.execute(
            f"SELECT scope_key FROM {table} WHERE id=?", (canonical,)
        ).fetchone()
        if row is None or row["scope_key"] != scope_key:
            raise ValidationError("target not found in current scope")
        return canonical

    def retract_claim(
        self,
        scope_key: str,
        claim_id: str,
        *,
        at: int | None = None,
        note: str | None = None,
    ) -> str:
        event_time = self._next_time(at)
        with self._write():
            canonical = self._resolve_scoped_id(claim_id, "claim", scope_key)
            body: dict[str, Any] = {"target": {"claim_id": canonical}}
            if note:
                body["note"] = mask_secrets(note, context="note")[0]
            event_id, _ = self._append_event(scope_key, "retraction", body, at=event_time)
            self._rebuild_all()
        return event_id

    def retract_event(
        self,
        scope_key: str,
        target_event_id: str,
        *,
        cascade: bool = True,
        at: int | None = None,
    ) -> str:
        event_time = self._next_time(at)
        with self._write():
            target = self.conn.execute(
                "SELECT seq,kind,scope_key FROM journal WHERE id=?", (target_event_id,)
            ).fetchone()
            if target is None or target["scope_key"] != scope_key:
                raise ValidationError("event target not found in current scope")
            if target["kind"] == "retraction":
                raise ValidationError("a retraction cannot target another retraction")
            target_body: dict[str, Any] = {"event_id": target_event_id}
            if target["kind"] == "statement":
                target_body["cascade"] = bool(cascade)
            body = {"target": target_body}
            event_id, _ = self._append_event(scope_key, "retraction", body, at=event_time)
            self._rebuild_all()
        return event_id

    def correct_claim(
        self,
        scope_key: str,
        claim_id: str,
        raw_text: str,
        replacement: dict[str, Any],
        *,
        provenance: str = "user_stated",
        ttl: str | None = None,
        at: int | None = None,
        failpoint: str | None = None,
    ) -> tuple[str, str]:
        event_time = self._next_time(at)
        masked_raw, _ = mask_secrets(raw_text.strip(), context="raw_text")
        parsed, _ = self._prepare_drafts([replacement], allow_partial=False)
        ttl = ttl or DEFAULT_TTL[provenance]
        with self._write():
            canonical = self._resolve_scoped_id(claim_id, "claim", scope_key)
            retract_id, _ = self._append_event(
                scope_key,
                "retraction",
                {"target": {"claim_id": canonical}},
                at=event_time,
            )
            statement_id, _ = self._append_event(
                scope_key,
                "statement",
                {
                    "raw_text": masked_raw,
                    "parsed": parsed,
                    "provenance": provenance,
                    "ttl": ttl,
                },
                at=event_time,
            )
            if failpoint == "after_journal":
                raise InjectedFailure("after correct journal batch")
            self._rebuild_all(failpoint=failpoint)
        return retract_id, statement_id

    def merge(
        self,
        scope_key: str,
        keep: str,
        absorb: str,
        *,
        at: int | None = None,
    ) -> str:
        event_time = self._next_time(at)
        with self._write():
            keep_id = self._resolve_scoped_id(keep, "entity", scope_key)
            absorb_id = self._resolve_scoped_id(absorb, "entity", scope_key)
            if keep_id == absorb_id:
                raise ValidationError("merge targets already resolve to the same entity")
            event_id, _ = self._append_event(
                scope_key,
                "merge",
                {"keep": keep_id, "absorb": absorb_id},
                at=event_time,
            )
            self._rebuild_all()
        return event_id

    def alias(
        self,
        scope_key: str,
        surface: str,
        entity_id: str,
        *,
        at: int | None = None,
    ) -> str:
        event_time = self._next_time(at)
        if secret_hits(surface, context="alias.surface"):
            raise ValidationError("alias surface contains a suspected secret")
        with self._write():
            canonical = self._resolve_scoped_id(entity_id, "entity", scope_key)
            event_id, _ = self._append_event(
                scope_key,
                "alias",
                {"surface": surface.strip(), "entity_id": canonical},
                at=event_time,
            )
            self._rebuild_all()
        return event_id

    def replay_all(self, *, failpoint: str | None = None) -> None:
        before = self.journal_checksum()
        with self._write():
            self._rebuild_all(failpoint=failpoint)
        if self.journal_checksum() != before:
            raise InvariantError("replay changed the journal")

    def _rebuild_all(self, *, failpoint: str | None = None) -> None:
        rows = self.conn.execute("SELECT * FROM journal ORDER BY seq").fetchall()
        events: list[dict[str, Any]] = []
        for row in rows:
            events.append({**dict(row), "body_obj": json.loads(row["body"])})

        by_id = {event["id"]: event for event in events}
        statements = [event for event in events if event["kind"] == "statement"]
        statement_by_id = {event["id"]: event for event in statements}
        parent: dict[str, str] = {}
        children: dict[str, list[str]] = defaultdict(list)
        for event in statements:
            target = event["body_obj"].get("supersedes")
            if target is None:
                continue
            source = statement_by_id.get(target)
            if source is None or source["scope_key"] != event["scope_key"] or source["seq"] >= event["seq"]:
                raise InvariantError("invalid supersedes edge")
            parent[event["id"]] = target
            children[target].append(event["id"])

        event_retracted: set[str] = set()
        for event in events:
            if event["kind"] != "retraction":
                continue
            target = event["body_obj"]["target"]
            target_event_id = target.get("event_id")
            if target_event_id is None:
                continue
            target_event = by_id.get(target_event_id)
            if (
                target_event is None
                or target_event["scope_key"] != event["scope_key"]
                or target_event["seq"] >= event["seq"]
                or target_event["kind"] == "retraction"
            ):
                raise InvariantError("invalid event-level retraction target")
            if target_event["kind"] != "statement" or not target.get("cascade", True):
                event_retracted.add(target_event_id)
                continue
            root = target_event_id
            while root in parent:
                root = parent[root]
            queue = deque([root])
            while queue:
                item = queue.popleft()
                candidate = statement_by_id[item]
                if candidate["seq"] < event["seq"]:
                    event_retracted.add(item)
                    queue.extend(children.get(item, []))

        root_of: dict[str, str] = {}
        for event in statements:
            node = event["id"]
            seen: set[str] = set()
            while node in parent:
                if node in seen:
                    raise InvariantError("supersedes cycle")
                seen.add(node)
                node = parent[node]
            root_of[event["id"]] = node

        grouped: dict[str, list[str]] = defaultdict(list)
        for event in statements:
            grouped[root_of[event["id"]]].append(event["id"])
        statement_state: dict[str, str] = {}
        live_leaf_by_root: dict[str, str] = {}
        for root, members in grouped.items():
            available = [member for member in members if member not in event_retracted]
            leaves = [
                member
                for member in available
                if not any(child in available for child in children.get(member, []))
            ]
            if len(leaves) > 1:
                raise InvariantError("more than one live supersedes leaf")
            if leaves:
                live_leaf_by_root[root] = leaves[0]
            for member in members:
                if member in event_retracted:
                    statement_state[member] = "retracted"
                elif leaves and member == leaves[0]:
                    statement_state[member] = "live"
                else:
                    statement_state[member] = "superseded"

        statement_meta: dict[str, dict[str, Any]] = {}
        for event in statements:
            root = statement_by_id[root_of[event["id"]]]
            root_body = root["body_obj"]
            provenance = root_body.get("provenance", "inferred")
            ttl = root_body.get("ttl") or DEFAULT_TTL[provenance]
            statement_meta[event["id"]] = {
                "state": statement_state[event["id"]],
                "order_seq": root["seq"],
                "created_at": root["created_at"],
                "provenance": provenance,
                "ttl": ttl,
                "expires_at": expiry(root["created_at"], ttl),
            }

        entities: dict[str, dict[str, Any]] = {}
        claims: dict[str, dict[str, Any]] = {}
        supports: dict[tuple[str, int], dict[str, Any]] = {}
        redirects: dict[str, dict[str, str]] = {}
        occurrences: dict[tuple[str, int], dict[str, Any]] = {}
        normal_entity: dict[tuple[str, str], str] = {}
        base_claim: dict[tuple[Any, ...], str] = {}

        def add_redirect(old: str, new: str, kind: str, reason: str) -> None:
            if old == new:
                return
            redirects[old] = {"new_id": new, "kind": kind, "reason": reason}

        def resolve(identifier: str, kind: str) -> str:
            seen: set[str] = set()
            while identifier in redirects:
                if identifier in seen or len(seen) >= 32:
                    raise InvariantError("redirect cycle or excessive depth")
                seen.add(identifier)
                redirect = redirects[identifier]
                if redirect["kind"] != kind:
                    raise InvariantError("redirect kind mismatch")
                identifier = redirect["new_id"]
            return identifier

        for event in statements:
            meta = statement_meta[event["id"]]
            entity_position = 0
            for draft_index, draft in enumerate(event["body_obj"].get("parsed", [])):
                subject_candidate = f"e{event['seq']}.{entity_position}"
                entity_position += 1
                subject_normal = normalize_v1(draft["subject"])
                subject_id = normal_entity.get((event["scope_key"], subject_normal))
                if subject_id is None:
                    subject_id = subject_candidate
                    normal_entity[(event["scope_key"], subject_normal)] = subject_id
                    entities[subject_id] = {
                        "id": subject_id,
                        "scope_key": event["scope_key"],
                        "name": draft["subject"].strip(),
                        "normal_name": subject_normal,
                        "kind": None,
                        "merged_into": None,
                        "origin_seq": event["seq"],
                    }
                else:
                    add_redirect(subject_candidate, subject_id, "entity", "deduplicated")

                object_id: str | None = None
                object_value: str | None = None
                object_candidate: str | None = None
                if "object" in draft:
                    object_candidate = f"e{event['seq']}.{entity_position}"
                    entity_position += 1
                    object_normal = normalize_v1(draft["object"])
                    object_id = normal_entity.get((event["scope_key"], object_normal))
                    if object_id is None:
                        object_id = object_candidate
                        normal_entity[(event["scope_key"], object_normal)] = object_id
                        entities[object_id] = {
                            "id": object_id,
                            "scope_key": event["scope_key"],
                            "name": draft["object"].strip(),
                            "normal_name": object_normal,
                            "kind": None,
                            "merged_into": None,
                            "origin_seq": event["seq"],
                        }
                    else:
                        add_redirect(object_candidate, object_id, "entity", "deduplicated")
                else:
                    object_value = normalize_literal(draft["object_value"])

                identity = (
                    event["scope_key"],
                    subject_id,
                    draft["relation"],
                    "entity" if object_id is not None else "value",
                    object_id if object_id is not None else object_value,
                )
                claim_candidate = f"c{event['seq']}.{draft_index}"
                claim_id = base_claim.get(identity)
                if claim_id is None:
                    claim_id = claim_candidate
                    base_claim[identity] = claim_id
                    claims[claim_id] = {
                        "id": claim_id,
                        "scope_key": event["scope_key"],
                        "subject_id": subject_id,
                        "relation": draft["relation"],
                        "object_id": object_id,
                        "object_value": object_value,
                        "state": "retracted",
                        "origin_seq": event["seq"],
                        "first_seen_at": meta["created_at"],
                        "last_seen_at": meta["created_at"],
                        "activation": None,
                    }
                else:
                    add_redirect(claim_candidate, claim_id, "claim", "deduplicated")
                supports[(event["id"], draft_index)] = {
                    "claim_id": claim_id,
                    "event_id": event["id"],
                    "draft_index": draft_index,
                    "live": 0,
                    "expires_at": meta["expires_at"],
                }
                occurrences[(event["id"], draft_index)] = {
                    "draft": draft,
                    "subject_candidate": subject_candidate,
                    "object_candidate": object_candidate,
                    "claim_candidate": claim_candidate,
                }

        surfaces: dict[tuple[str, str, str], str] = {}

        def upsert_surface(scope: str, surface: str, entity_id: str, origin: str) -> None:
            entity_id = resolve(entity_id, "entity")
            key = (scope, normalize_v1(surface), entity_id)
            existing = surfaces.get(key)
            if existing is None or ORIGIN_PRIORITY[origin] > ORIGIN_PRIORITY[existing]:
                surfaces[key] = origin

        def claim_identity(claim: dict[str, Any]) -> tuple[Any, ...]:
            subject_id = resolve(claim["subject_id"], "entity")
            object_id = resolve(claim["object_id"], "entity") if claim["object_id"] else None
            return (
                claim["scope_key"],
                subject_id,
                claim["relation"],
                "entity" if object_id is not None else "value",
                object_id if object_id is not None else claim["object_value"],
            )

        def choose_claim(candidates: Iterable[str]) -> str:
            return min(candidates, key=id_order)

        def redirect_claim(old: str, new: str, reason: str) -> None:
            old = resolve(old, "claim")
            new = resolve(new, "claim")
            if old == new:
                return
            for support in supports.values():
                if resolve(support["claim_id"], "claim") == old:
                    support["claim_id"] = new
            claims[old]["state"] = "superseded"
            add_redirect(old, new, "claim", reason)

        def dedupe_supports() -> None:
            best: dict[tuple[str, str], tuple[str, int]] = {}
            for key, support in list(supports.items()):
                support["claim_id"] = resolve(support["claim_id"], "claim")
                group = (support["claim_id"], support["event_id"])
                current = best.get(group)
                if current is None or support["draft_index"] < supports[current]["draft_index"]:
                    if current is not None:
                        del supports[current]
                    best[group] = key
                else:
                    del supports[key]

        def dedupe_claim_identities(reason: str) -> None:
            groups: dict[tuple[Any, ...], list[str]] = defaultdict(list)
            for claim_id, claim in claims.items():
                if resolve(claim_id, "claim") != claim_id:
                    continue
                claim["subject_id"] = resolve(claim["subject_id"], "entity")
                if claim["object_id"]:
                    claim["object_id"] = resolve(claim["object_id"], "entity")
                groups[claim_identity(claim)].append(claim_id)
            for ids in groups.values():
                if len(ids) < 2:
                    continue
                survivor = choose_claim(ids)
                states = [claims[item]["state"] for item in ids]
                activations = [claims[item]["activation"] for item in ids if claims[item]["activation"]]
                for losing in ids:
                    if losing != survivor:
                        redirect_claim(losing, survivor, reason)
                if "active" in states:
                    claims[survivor]["state"] = "active"
                elif "superseded" in states:
                    claims[survivor]["state"] = "superseded"
                if activations:
                    claims[survivor]["activation"] = max(activations)
            dedupe_supports()

        def resolve_occurrence_entity(candidate: str, name: str, scope: str) -> str:
            current = resolve(candidate, "entity")
            surface_norm = normalize_v1(name)
            mapped = sorted(
                {
                    resolve(entity_id, "entity")
                    for (mapped_scope, mapped_norm, entity_id) in surfaces
                    if mapped_scope == scope and mapped_norm == surface_norm
                },
                key=id_order,
            )
            if len(mapped) > 1:
                exact = [
                    entity_id
                    for entity_id in mapped
                    if entities[entity_id]["normal_name"] == surface_norm
                    and entities[entity_id]["merged_into"] is None
                ]
                if len(exact) != 1:
                    raise InvariantError(
                        "ambiguous surface reached the journal; record preflight should reject it"
                    )
                chosen = exact[0]
            elif mapped:
                chosen = mapped[0]
            else:
                chosen = current
            if chosen == current:
                return current

            if current in entities:
                entities[current]["merged_into"] = chosen
            add_redirect(current, chosen, "entity", "deduplicated")
            moved: list[tuple[tuple[str, str, str], str]] = []
            for key, origin in list(surfaces.items()):
                if key[2] == current:
                    del surfaces[key]
                    moved.append(((key[0], key[1], chosen), origin))
            for key, origin in moved:
                existing = surfaces.get(key)
                if existing is None or ORIGIN_PRIORITY[origin] > ORIGIN_PRIORITY[existing]:
                    surfaces[key] = origin
            dedupe_claim_identities("deduplicated")
            return chosen

        def apply_statement(event: dict[str, Any]) -> None:
            meta = statement_meta[event["id"]]
            for draft_index, draft in enumerate(event["body_obj"].get("parsed", [])):
                occurrence = occurrences[(event["id"], draft_index)]
                subject_id = resolve_occurrence_entity(
                    occurrence["subject_candidate"], draft["subject"], event["scope_key"]
                )
                object_id = (
                    resolve_occurrence_entity(
                        occurrence["object_candidate"], draft["object"], event["scope_key"]
                    )
                    if occurrence["object_candidate"]
                    else None
                )
                upsert_surface(event["scope_key"], draft["subject"], subject_id, "name")
                for alias_value in draft.get("subject_aliases", []):
                    upsert_surface(event["scope_key"], alias_value, subject_id, "agent_supplied")
                if object_id is not None:
                    upsert_surface(event["scope_key"], draft["object"], object_id, "name")
                    for alias_value in draft.get("object_aliases", []):
                        upsert_surface(event["scope_key"], alias_value, object_id, "agent_supplied")

                subject_kind = normalize_kind(draft.get("subject_kind"))
                object_kind = normalize_kind(draft.get("object_kind"))
                if subject_kind and entities[subject_id]["kind"] is None:
                    entities[subject_id]["kind"] = subject_kind
                if object_id and object_kind and entities[object_id]["kind"] is None:
                    entities[object_id]["kind"] = object_kind

                candidate_claim = resolve(occurrence["claim_candidate"], "claim")
                desired_identity = (
                    event["scope_key"],
                    subject_id,
                    draft["relation"],
                    "entity" if object_id is not None else "value",
                    object_id if object_id is not None else normalize_literal(draft["object_value"]),
                )
                matching = [
                    claim_id
                    for claim_id, claim in claims.items()
                    if resolve(claim_id, "claim") == claim_id and claim_identity(claim) == desired_identity
                ]
                if matching:
                    target_claim = choose_claim(matching)
                    if candidate_claim != target_claim:
                        redirect_claim(candidate_claim, target_claim, "deduplicated")
                else:
                    target_claim = candidate_claim
                    claim = claims[target_claim]
                    claim["subject_id"] = subject_id
                    claim["object_id"] = object_id
                    claim["object_value"] = (
                        None if object_id is not None else normalize_literal(draft["object_value"])
                    )

                if draft["relation"] == "describes":
                    for claim_id, claim in claims.items():
                        if (
                            resolve(claim_id, "claim") == claim_id
                            and claim_id != target_claim
                            and claim["scope_key"] == event["scope_key"]
                            and resolve(claim["subject_id"], "entity") == subject_id
                            and claim["relation"] == "describes"
                            and claim["state"] == "active"
                        ):
                            claim["state"] = "superseded"
                claim = claims[target_claim]
                claim["state"] = "active"
                claim["activation"] = (meta["order_seq"], event["seq"], draft_index)
                support = supports.get((event["id"], draft_index))
                if support is None:
                    raise InvariantError("missing anchored support")
                support["claim_id"] = target_claim
                support["live"] = 1

        def apply_claim_retraction(event: dict[str, Any]) -> None:
            target = event["body_obj"]["target"]["claim_id"]
            target = resolve(target, "claim")
            if target not in claims:
                raise InvariantError("claim retraction target disappeared")
            for support in supports.values():
                if resolve(support["claim_id"], "claim") != target:
                    continue
                meta = statement_meta[support["event_id"]]
                if meta["order_seq"] < event["seq"]:
                    support["live"] = 0
            claims[target]["state"] = "retracted"

        def apply_merge(event: dict[str, Any]) -> None:
            keep = resolve(event["body_obj"]["keep"], "entity")
            absorb = resolve(event["body_obj"]["absorb"], "entity")
            if keep == absorb:
                return
            if keep not in entities or absorb not in entities:
                raise InvariantError("merge references unknown entity")
            entities[absorb]["merged_into"] = keep
            add_redirect(absorb, keep, "entity", "merge")
            moved: list[tuple[tuple[str, str, str], str]] = []
            for key, origin in list(surfaces.items()):
                if key[2] == absorb:
                    del surfaces[key]
                    moved.append(((key[0], key[1], keep), origin))
            for key, origin in moved:
                existing = surfaces.get(key)
                if existing is None or ORIGIN_PRIORITY[origin] > ORIGIN_PRIORITY[existing]:
                    surfaces[key] = origin
            dedupe_claim_identities("merge")
            describes: dict[tuple[str, str], list[str]] = defaultdict(list)
            for claim_id, claim in claims.items():
                if (
                    resolve(claim_id, "claim") == claim_id
                    and claim["state"] == "active"
                    and claim["relation"] == "describes"
                ):
                    describes[(claim["scope_key"], claim["subject_id"])].append(claim_id)
            for ids in describes.values():
                if len(ids) <= 1:
                    continue
                winner = max(ids, key=lambda item: claims[item]["activation"] or (-1, -1, -1))
                for item in ids:
                    if item != winner:
                        claims[item]["state"] = "superseded"

        def apply_alias(event: dict[str, Any]) -> None:
            entity_id = resolve(event["body_obj"]["entity_id"], "entity")
            upsert_surface(event["scope_key"], event["body_obj"]["surface"], entity_id, "confirmed")

        semantic: list[tuple[int, int, int, dict[str, Any]]] = []
        for root, leaf_id in live_leaf_by_root.items():
            leaf = statement_by_id[leaf_id]
            semantic.append((statement_by_id[root]["seq"], 0, leaf["seq"], leaf))
        for event in events:
            if event["kind"] in {"merge", "alias"} and event["id"] not in event_retracted:
                semantic.append((event["seq"], 1, event["seq"], event))
            elif event["kind"] == "retraction" and "claim_id" in event["body_obj"]["target"]:
                semantic.append((event["seq"], 2, event["seq"], event))
        semantic.sort(key=lambda item: (item[0], item[1], item[2]))

        for _, _, _, event in semantic:
            if event["kind"] == "statement":
                apply_statement(event)
            elif event["kind"] == "merge":
                apply_merge(event)
            elif event["kind"] == "alias":
                apply_alias(event)
            elif event["kind"] == "retraction":
                apply_claim_retraction(event)

        dedupe_claim_identities("deduplicated")
        for old_id in list(redirects):
            kind = redirects[old_id]["kind"]
            final = resolve(old_id, kind)
            redirects[old_id]["new_id"] = final

        for claim_id, claim in claims.items():
            if resolve(claim_id, "claim") != claim_id:
                claim["state"] = "superseded"
                continue
            live_supports = [
                support
                for support in supports.values()
                if resolve(support["claim_id"], "claim") == claim_id and support["live"]
            ]
            if claim["state"] == "active" and not live_supports:
                claim["state"] = "retracted"
            if live_supports:
                seen = [statement_meta[support["event_id"]]["created_at"] for support in live_supports]
                claim["first_seen_at"] = min(seen)
                claim["last_seen_at"] = max(seen)

        dedupe_supports()

        self.conn.execute("DELETE FROM claim_support")
        self.conn.execute("DELETE FROM surface_forms")
        self.conn.execute("DELETE FROM id_redirects")
        self.conn.execute("DELETE FROM claims")
        self.conn.execute("DELETE FROM entities")
        self.conn.execute("DELETE FROM statements")
        self.conn.execute("DELETE FROM projection_meta")
        self._fault("after_projection_delete")
        if failpoint == "during_projection":
            raise InjectedFailure("during projection rebuild")

        for event in statements:
            meta = statement_meta[event["id"]]
            self.conn.execute(
                "INSERT INTO statements VALUES(?,?,?,?,?,?,?)",
                (
                    event["id"],
                    event["scope_key"],
                    meta["state"],
                    meta["order_seq"],
                    meta["created_at"],
                    meta["provenance"],
                    meta["expires_at"],
                ),
            )
        for entity in sorted(entities.values(), key=lambda item: id_order(item["id"])):
            self.conn.execute(
                "INSERT INTO entities(id,scope_key,name,normal_name,kind,merged_into,origin_seq) "
                "VALUES(?,?,?,?,?,NULL,?)",
                (
                    entity["id"],
                    entity["scope_key"],
                    entity["name"],
                    entity["normal_name"],
                    entity["kind"],
                    entity["origin_seq"],
                ),
            )
        for entity in entities.values():
            if entity["merged_into"]:
                self.conn.execute(
                    "UPDATE entities SET merged_into=? WHERE id=?",
                    (resolve(entity["merged_into"], "entity"), entity["id"]),
                )
        for (scope, surface_norm, entity_id), origin in sorted(surfaces.items()):
            self.conn.execute(
                "INSERT INTO surface_forms VALUES(?,?,?,?)",
                (scope, surface_norm, resolve(entity_id, "entity"), origin),
            )
        self._fault("during_projection_write")
        for claim in sorted(claims.values(), key=lambda item: id_order(item["id"])):
            self.conn.execute(
                "INSERT INTO claims VALUES(?,?,?,?,?,?,?,?,?,?)",
                (
                    claim["id"],
                    claim["scope_key"],
                    resolve(claim["subject_id"], "entity"),
                    claim["relation"],
                    resolve(claim["object_id"], "entity") if claim["object_id"] else None,
                    claim["object_value"],
                    claim["state"],
                    claim["origin_seq"],
                    claim["first_seen_at"],
                    claim["last_seen_at"],
                ),
            )
        for support in sorted(supports.values(), key=lambda item: (item["event_id"], item["draft_index"])):
            claim_id = resolve(support["claim_id"], "claim")
            self.conn.execute(
                "INSERT INTO claim_support VALUES(?,?,?,?,?)",
                (
                    claim_id,
                    support["event_id"],
                    support["draft_index"],
                    support["live"],
                    support["expires_at"],
                ),
            )
        for old_id, redirect in sorted(redirects.items()):
            self.conn.execute(
                "INSERT INTO id_redirects VALUES(?,?,?,?)",
                (old_id, redirect["new_id"], redirect["kind"], redirect["reason"]),
            )
        for scope_row in self.conn.execute("SELECT scope_key,MAX(seq) last_seq FROM journal GROUP BY scope_key"):
            self.conn.execute(
                "INSERT INTO projection_meta VALUES(?,?,?,?)",
                (scope_row["scope_key"], scope_row["last_seq"], RULES_VERSION, self._clock),
            )
        self._fault("after_projection_meta")

        fk_errors = self.conn.execute("PRAGMA foreign_key_check").fetchall()
        if fk_errors:
            raise InvariantError(f"foreign key errors: {fk_errors}")
        duplicate_describes = self.conn.execute(
            "SELECT scope_key,subject_id,count(*) FROM claims "
            "WHERE state='active' AND relation='describes' GROUP BY scope_key,subject_id HAVING count(*)>1"
        ).fetchall()
        if duplicate_describes:
            raise InvariantError("multiple active describes values")

    def resolve_redirect(self, identifier: str, kind: str) -> str:
        current = identifier
        seen: set[str] = set()
        for _ in range(33):
            row = self.conn.execute(
                "SELECT new_id,kind FROM id_redirects WHERE old_id=?", (current,)
            ).fetchone()
            if row is None:
                return current
            if row["kind"] != kind:
                raise InvariantError("redirect kind mismatch")
            if current in seen:
                raise InvariantError("redirect cycle")
            seen.add(current)
            current = row["new_id"]
        raise InvariantError("redirect exceeds 32 hops")

    def entity_id(self, scope_key: str, name: str) -> str:
        rows = self.conn.execute(
            "SELECT entity_id FROM surface_forms WHERE scope_key=? AND surface_norm=? ORDER BY entity_id",
            (scope_key, normalize_v1(name)),
        ).fetchall()
        ids = sorted({self.resolve_redirect(row["entity_id"], "entity") for row in rows})
        if len(ids) != 1:
            raise ValidationError(f"entity lookup expected one result, got {len(ids)}")
        return ids[0]

    def _materialize_recall_agg(self, scope_key: str, now: int) -> None:
        self.conn.execute("DROP TABLE IF EXISTS temp.recall_claim_agg")
        self.conn.execute(
            "CREATE TEMP TABLE recall_claim_agg("
            "claim_id TEXT PRIMARY KEY,support_count INTEGER,strongest_rank INTEGER,"
            "last_seen_at INTEGER,relation_label TEXT,effective_expires_at INTEGER)"
        )
        self.conn.execute(
            """
            INSERT INTO recall_claim_agg
            SELECT
              cs.claim_id,
              COUNT(*),
              MAX(CASE s.provenance WHEN 'user_stated' THEN 3 WHEN 'observed' THEN 2 ELSE 1 END),
              MAX(s.created_at),
              (
                SELECT NULLIF(TRIM(json_extract(
                         jl.body, '$.parsed[' || csl.draft_index || '].relation_label'
                       )), '')
                FROM claim_support csl
                JOIN statements sl ON sl.event_id=csl.event_id
                JOIN journal jl ON jl.id=csl.event_id
                WHERE csl.claim_id=cs.claim_id
                  AND csl.live=1 AND sl.state='live'
                  AND (csl.expires_at IS NULL OR csl.expires_at>:now)
                  AND NULLIF(TRIM(json_extract(
                        jl.body, '$.parsed[' || csl.draft_index || '].relation_label'
                      )), '') IS NOT NULL
                ORDER BY sl.order_seq DESC, jl.seq DESC
                LIMIT 1
              ),
              CASE WHEN COUNT(*)>COUNT(cs.expires_at) THEN NULL ELSE MAX(cs.expires_at) END
            FROM claim_support cs
            JOIN statements s ON s.event_id=cs.event_id
            JOIN claims c ON c.id=cs.claim_id
            WHERE cs.live=1 AND s.state='live' AND c.state='active'
              AND c.scope_key=:scope
              AND (cs.expires_at IS NULL OR cs.expires_at>:now)
            GROUP BY cs.claim_id
            """,
            {"scope": scope_key, "now": now},
        )

    def recall(
        self,
        scope_key: str,
        *,
        query: str | None = None,
        terms: Sequence[str] | None = None,
        mode: str = "search",
        depth: int = 2,
        limit: int = 10,
        now: int,
    ) -> dict[str, Any]:
        if mode not in {"search", "overview"}:
            raise ValidationError("invalid recall mode")
        if mode == "search" and (query is None or not query.strip()):
            raise ValidationError("search query is required")
        if depth not in {1, 2, 3} or not 1 <= limit <= 50:
            raise ValidationError("invalid depth or limit")

        persistent_before = self.projection_checksum()
        self.conn.execute("BEGIN")
        try:
            self._materialize_recall_agg(scope_key, now)
            agg = {
                row["claim_id"]: dict(row)
                for row in self.conn.execute("SELECT * FROM recall_claim_agg")
            }
            seeds: list[tuple[str, str]] = []
            raw_candidates: list[dict[str, Any]] = []
            pinned_claims: set[str] = set()
            more = False
            notes: list[str] = []
            entry = "none"

            if mode == "overview":
                rows = self.conn.execute(
                    """
                    SELECT e.id,e.name,COUNT(DISTINCT c.id) incident,MAX(a.last_seen_at) recent
                    FROM entities e
                    JOIN claims c ON c.subject_id=e.id OR c.object_id=e.id
                    JOIN recall_claim_agg a ON a.claim_id=c.id
                    WHERE e.scope_key=? AND e.merged_into IS NULL
                    GROUP BY e.id,e.name
                    ORDER BY incident DESC,recent DESC,e.id ASC
                    LIMIT 11
                    """,
                    (scope_key,),
                ).fetchall()
                if len(rows) > 10:
                    more = True
                    notes.append("overview seed cap")
                seeds = [(row["id"], row["name"]) for row in rows[: min(limit, 10)]]
                raw_rows = self.conn.execute(
                    """
                    SELECT j.id,j.seq,j.body,s.created_at,s.provenance
                    FROM statements s JOIN journal j ON j.id=s.event_id
                    WHERE s.scope_key=? AND s.state='live'
                      AND (s.expires_at IS NULL OR s.expires_at>?)
                      AND json_array_length(j.body,'$.parsed')=0
                    ORDER BY s.created_at DESC,j.seq DESC LIMIT ?
                    """,
                    (scope_key, now, limit + 1),
                ).fetchall()
                if len(raw_rows) > limit:
                    more = True
                    notes.append("overview raw limit")
                for raw_row in raw_rows[:limit]:
                    body = json.loads(raw_row["body"])
                    raw_candidates.append(
                        {
                            "kind": "raw",
                            "event_id": raw_row["id"],
                            "text": body["raw_text"],
                            "created_at": raw_row["created_at"],
                            "provenance": raw_row["provenance"],
                            "score": 0.0,
                            "seq": raw_row["seq"],
                        }
                    )
                entry = "overview" if seeds or raw_candidates else "none"
            else:
                candidate_terms = list(terms or [])
                if not candidate_terms:
                    candidate_terms = [query.strip()]
                    candidate_terms.extend(re.findall(r"[\w]+", query, flags=re.UNICODE))
                unique_terms: list[str] = []
                seen_norms: set[str] = set()
                for term in candidate_terms:
                    try:
                        normal = normalize_v1(term)
                    except ValidationError:
                        continue
                    if len(normal) < 2 or normal in seen_norms:
                        continue
                    seen_norms.add(normal)
                    unique_terms.append(term.strip())
                    if len(unique_terms) == 10:
                        break
                for term in unique_terms:
                    rows = self.conn.execute(
                        "SELECT entity_id FROM surface_forms WHERE scope_key=? AND surface_norm=? "
                        "ORDER BY entity_id LIMIT 51",
                        (scope_key, normalize_v1(term)),
                    ).fetchall()
                    for row in rows:
                        pair = (self.resolve_redirect(row["entity_id"], "entity"), term)
                        if pair not in seeds:
                            seeds.append(pair)
                    if len(seeds) > 50:
                        seeds = seeds[:50]
                        more = True
                        notes.append("surface seed cap")
                        break

                if seeds:
                    entry = "surface"

                    # A valid graph edge is also an incident answer, so no
                    # seed with an aggregate incident means expansion cannot
                    # produce a claim at any depth. ADR-012 then requires the
                    # same safe FTS fallback as a complete surface miss.
                    has_surface_answer = any(
                        self.conn.execute(
                            "SELECT EXISTS(SELECT 1 FROM claims c "
                            "JOIN recall_claim_agg a ON a.claim_id=c.id "
                            "WHERE c.subject_id=? OR c.object_id=?)",
                            (entity_id, entity_id),
                        ).fetchone()[0]
                        for entity_id, _ in seeds
                    )
                    if not has_surface_answer:
                        seeds = []
                        entry = "none"
                        notes.append("surface produced no valid claim; tried FTS")

                if not seeds:
                    fts_terms = [term for term in unique_terms if len(term) >= 3]
                    if fts_terms:
                        fts_query = " OR ".join('"' + term.replace('"', '""') + '"' for term in fts_terms)
                        try:
                            fts_rows = self.conn.execute(
                                """
                                SELECT j.id,j.seq,j.body,bm25(journal_fts) score
                                FROM journal_fts
                                JOIN journal j ON j.seq=journal_fts.rowid
                                JOIN statements s ON s.event_id=j.id AND s.state='live'
                                WHERE journal_fts MATCH ? AND j.scope_key=?
                                  AND (s.expires_at IS NULL OR s.expires_at>?)
                                ORDER BY score ASC,j.seq DESC LIMIT 21
                                """,
                                (fts_query, scope_key, now),
                            ).fetchall()
                        except sqlite3.OperationalError:
                            fts_rows = []
                            notes.append("safe FTS query produced no result")
                        if len(fts_rows) > 20:
                            more = True
                            notes.append("FTS candidate cap")
                        for fts_row in fts_rows[:20]:
                            body = json.loads(fts_row["body"])
                            support_rows = self.conn.execute(
                                "SELECT cs.claim_id,c.subject_id,c.object_id FROM claim_support cs "
                                "JOIN claims c ON c.id=cs.claim_id "
                                "JOIN recall_claim_agg a ON a.claim_id=cs.claim_id "
                                "WHERE cs.event_id=?",
                                (fts_row["id"],),
                            ).fetchall()
                            if support_rows:
                                for support_row in support_rows:
                                    pinned_claims.add(support_row["claim_id"])
                                    seeds.append((support_row["subject_id"], f"{fts_terms[0]} (FTS)"))
                                    if support_row["object_id"]:
                                        seeds.append((support_row["object_id"], f"{fts_terms[0]} (FTS)"))
                            elif not body.get("parsed"):
                                raw_candidates.append(
                                    {
                                        "kind": "raw",
                                        "event_id": fts_row["id"],
                                        "text": body["raw_text"],
                                        "created_at": self.conn.execute(
                                            "SELECT created_at FROM statements WHERE event_id=?",
                                            (fts_row["id"],),
                                        ).fetchone()[0],
                                        "provenance": body.get("provenance", "inferred"),
                                        "score": fts_row["score"],
                                        "seq": fts_row["seq"],
                                    }
                                )
                        if seeds or raw_candidates:
                            entry = "fts"
                    elif not seeds:
                        notes.append("surface miss and no trigram-length FTS term")

            deduped_seeds: list[tuple[str, str]] = []
            seen_seed_ids: set[str] = set()
            for entity_id, label in seeds:
                entity_id = self.resolve_redirect(entity_id, "entity")
                if entity_id not in seen_seed_ids:
                    seen_seed_ids.add(entity_id)
                    deduped_seeds.append((entity_id, label))
            seeds = deduped_seeds

            came_from: dict[str, tuple[str | None, str | None, int, str, int]] = {
                entity_id: (None, None, 0, label, index)
                for index, (entity_id, label) in enumerate(seeds)
            }
            reached: dict[str, tuple[int, int, str]] = {}

            def ordered_incident(entity_id: str) -> list[sqlite3.Row]:
                return self.conn.execute(
                    """
                    SELECT c.*,a.* FROM claims c JOIN recall_claim_agg a ON a.claim_id=c.id
                    WHERE c.subject_id=? OR c.object_id=?
                    ORDER BY a.support_count DESC,a.strongest_rank DESC,a.last_seen_at DESC,
                             c.origin_seq ASC,c.id ASC LIMIT 31
                    """,
                    (entity_id, entity_id),
                ).fetchall()

            def ordered_links(entity_id: str) -> list[tuple[sqlite3.Row, str]]:
                rows = self.conn.execute(
                    """
                    SELECT c.*,a.* FROM claims c JOIN recall_claim_agg a ON a.claim_id=c.id
                    WHERE c.object_id IS NOT NULL AND (c.subject_id=? OR c.object_id=?)
                    ORDER BY a.support_count DESC,a.strongest_rank DESC,a.last_seen_at DESC,
                             c.origin_seq ASC,c.id ASC LIMIT 31
                    """,
                    (entity_id, entity_id),
                ).fetchall()
                return [
                    (row, row["object_id"] if row["subject_id"] == entity_id else row["subject_id"])
                    for row in rows
                ]

            frontier = list(came_from)
            max_depth = 0 if mode == "overview" else depth
            for current_depth in range(max_depth + 1):
                next_frontier: list[str] = []
                for entity_id in frontier:
                    incident = ordered_incident(entity_id)
                    if len(incident) > 30:
                        more = True
                        notes.append("incident fanout")
                    seed_order = came_from[entity_id][4]
                    for row in incident[:30]:
                        candidate = (current_depth, seed_order, entity_id)
                        if row["id"] not in reached or candidate < reached[row["id"]]:
                            reached[row["id"]] = candidate
                    if current_depth == max_depth:
                        continue
                    links = ordered_links(entity_id)
                    if len(links) > 30:
                        more = True
                        notes.append("link fanout")
                    for row, other in links[:30]:
                        if other in came_from:
                            continue
                        came_from[other] = (
                            entity_id,
                            row["id"],
                            current_depth + 1,
                            came_from[entity_id][3],
                            seed_order,
                        )
                        next_frontier.append(other)
                frontier = next_frontier
                if not frontier:
                    break

            for claim_id in pinned_claims:
                row = self.conn.execute(
                    "SELECT subject_id FROM claims WHERE id=?", (claim_id,)
                ).fetchone()
                if row and claim_id not in reached:
                    reached[claim_id] = (0, 0, row["subject_id"])

            ranked: list[tuple[tuple[Any, ...], dict[str, Any]]] = []
            recent_cutoff = now - 2_592_000
            for claim_id, (claim_depth, seed_order, anchor_id) in reached.items():
                row = self.conn.execute(
                    "SELECT c.*,a.support_count,a.strongest_rank,"
                    "a.last_seen_at AS aggregate_last_seen_at,a.relation_label,"
                    "a.effective_expires_at "
                    "FROM claims c JOIN recall_claim_agg a ON a.claim_id=c.id WHERE c.id=?",
                    (claim_id,),
                ).fetchone()
                if row is None:
                    continue
                opposite = None
                if row["relation"] == "uses":
                    opposite = "rejects"
                elif row["relation"] == "rejects":
                    opposite = "uses"
                contested = False
                if opposite:
                    contested = self.conn.execute(
                        """
                        SELECT EXISTS(
                          SELECT 1 FROM claims x JOIN recall_claim_agg a ON a.claim_id=x.id
                          WHERE x.scope_key=? AND x.subject_id=?
                            AND x.object_id IS ? AND x.object_value IS ? AND x.relation=?
                        )
                        """,
                        (
                            scope_key,
                            row["subject_id"],
                            row["object_id"],
                            row["object_value"],
                            opposite,
                        ),
                    ).fetchone()[0] == 1
                score = (
                    -2 * claim_depth
                    + {3: 6, 2: 4, 1: 1}[row["strongest_rank"]]
                    + min(row["support_count"], 4)
                    + (2 if row["aggregate_last_seen_at"] > recent_cutoff else 0)
                    - (3 if contested else 0)
                )
                subject_name = self.conn.execute(
                    "SELECT name FROM entities WHERE id=?", (row["subject_id"],)
                ).fetchone()[0]
                if row["object_id"]:
                    object_name = self.conn.execute(
                        "SELECT name FROM entities WHERE id=?", (row["object_id"],)
                    ).fetchone()[0]
                else:
                    object_name = row["object_value"]
                predicate = row["relation_label"] or DEFAULT_PREDICATES[row["relation"]]

                chain: list[str] = []
                cursor = anchor_id
                while cursor is not None and cursor in came_from:
                    chain.append(cursor)
                    cursor = came_from[cursor][0]
                chain.reverse()
                names = [
                    self.conn.execute("SELECT name FROM entities WHERE id=?", (entity_id,)).fetchone()[0]
                    for entity_id in chain
                ]
                seed_label = came_from[anchor_id][3] if anchor_id in came_from else subject_name
                path_parts = list(names)
                if path_parts and seed_label != path_parts[0]:
                    path_parts.insert(0, seed_label)
                hops = max(0, len(chain) - 1)
                if row["object_id"]:
                    other = row["object_id"] if anchor_id == row["subject_id"] else row["subject_id"]
                    if not chain or other not in chain:
                        path_parts.append(object_name if other == row["object_id"] else subject_name)
                        hops += 1
                answer = {
                    "kind": "claim",
                    "claim_id": claim_id,
                    "text": f"{subject_name} {predicate} {object_name}",
                    "path": " → ".join(path_parts or [subject_name]),
                    "hops": hops,
                    "contested": contested,
                    "support": {
                        "count": row["support_count"],
                        "strongest": {1: "inferred", 2: "observed", 3: "user_stated"}[
                            row["strongest_rank"]
                        ],
                        "last_seen": row["aggregate_last_seen_at"],
                    },
                }
                key = (
                    -score,
                    claim_depth,
                    -row["strongest_rank"],
                    -row["support_count"],
                    -row["aggregate_last_seen_at"],
                    row["origin_seq"],
                    id_order(claim_id)[1],
                )
                ranked.append((key, answer))
            ranked.sort(key=lambda item: item[0])
            claim_answers = [item[1] for item in ranked]
            if len(claim_answers) > limit:
                more = True
                notes.append("answer limit")
            answers = claim_answers[:limit]
            if len(answers) < limit:
                raw_candidates.sort(key=lambda item: (item["score"], -item["seq"]))
                for raw in raw_candidates:
                    if len(answers) >= limit:
                        more = True
                        notes.append("raw answer limit")
                        break
                    raw = dict(raw)
                    raw.pop("score", None)
                    raw.pop("seq", None)
                    answers.append(raw)
            if not answers:
                entry = "none"
            result = {
                "answers": answers,
                "entry": entry,
                "more_available": more,
                "note": "; ".join(dict.fromkeys(notes)) if notes else None,
            }
        finally:
            self.conn.rollback()
        if self.projection_checksum() != persistent_before:
            raise InvariantError("recall modified persistent projection state")
        return result

    def rebuild_fts(self) -> None:
        with self._write():
            self.conn.execute("INSERT INTO journal_fts(journal_fts) VALUES('delete-all')")
            self.conn.execute(
                "INSERT INTO journal_fts(rowid,raw_text) "
                "SELECT seq,json_extract(body,'$.raw_text') FROM journal "
                "WHERE kind='statement' ORDER BY seq"
            )
            self.conn.execute("INSERT INTO journal_fts(journal_fts) VALUES('optimize')")

    def journal_checksum(self) -> str:
        digest = hashlib.sha256()
        columns = ["seq", "id", "scope_key", "kind", "body", "actor", "branch", "session", "created_at"]
        for row in self.conn.execute("SELECT * FROM journal ORDER BY seq"):
            for column in columns:
                digest.update(_typed_bytes(row[column]))
        return digest.hexdigest()

    def projection_checksum(self) -> str:
        digest = hashlib.sha256()
        specs = (
            ("statements", "event_id"),
            ("entities", "id"),
            ("surface_forms", "scope_key,surface_norm,entity_id"),
            ("claims", "id"),
            ("claim_support", "claim_id,event_id"),
            ("id_redirects", "old_id"),
        )
        for table, order_by in specs:
            columns = [row["name"] for row in self.conn.execute(f"PRAGMA table_info({table})")]
            digest.update(_typed_bytes(table))
            for row in self.conn.execute(f"SELECT * FROM {table} ORDER BY {order_by}"):
                for column in columns:
                    digest.update(_typed_bytes(row[column]))
        return digest.hexdigest()

    def rows(self, query: str, params: Sequence[Any] = ()) -> list[dict[str, Any]]:
        return [dict(row) for row in self.conn.execute(query, params).fetchall()]
