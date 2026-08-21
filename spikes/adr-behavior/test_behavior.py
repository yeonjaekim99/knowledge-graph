from __future__ import annotations

import json
import random
import re
import sqlite3
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).parent))

from reference import (  # noqa: E402
    InjectedFailure,
    ReferenceSpike,
    RULES_VERSION,
    ValidationError,
    event_id_for_seq,
    normalize_v1,
)


SCOPE = "u:alice/p:recall"
OTHER_SCOPE = "u:alice/p:other"
T0 = 1_700_000_000


def entity_draft(subject: str, relation: str, obj: str, **extra: object) -> dict[str, object]:
    return {"subject": subject, "relation": relation, "object": obj, **extra}


def literal_draft(subject: str, relation: str, value: str, **extra: object) -> dict[str, object]:
    return {"subject": subject, "relation": relation, "object_value": value, **extra}


class BehaviorSpikeTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "adr-spike.db"
        self.spike = ReferenceSpike(self.db_path, start_time=T0 - 60)

    def tearDown(self) -> None:
        self.spike.close()
        self.tempdir.cleanup()

    def active_claims(self, scope: str = SCOPE) -> list[dict[str, object]]:
        return self.spike.rows(
            "SELECT * FROM claims WHERE scope_key=? AND state='active' ORDER BY id", (scope,)
        )

    def assert_projection_invariants(self, spike: ReferenceSpike) -> None:
        self.assertEqual([row[0] for row in spike.conn.execute("PRAGMA integrity_check")], ["ok"])
        self.assertEqual(spike.conn.execute("PRAGMA foreign_key_check").fetchall(), [])
        self.assertEqual(
            spike.rows(
                "SELECT scope_key,subject_id,count(*) count FROM claims "
                "WHERE state='active' AND relation='describes' "
                "GROUP BY scope_key,subject_id HAVING count(*)>1"
            ),
            [],
        )
        self.assertEqual(
            spike.rows(
                "SELECT c.id FROM claims c JOIN entities s ON s.id=c.subject_id "
                "LEFT JOIN entities o ON o.id=c.object_id "
                "WHERE c.scope_key<>s.scope_key "
                "OR (c.object_id IS NOT NULL AND c.scope_key<>o.scope_key)"
            ),
            [],
        )
        self.assertEqual(
            spike.rows(
                "SELECT sf.entity_id FROM surface_forms sf "
                "JOIN entities e ON e.id=sf.entity_id WHERE sf.scope_key<>e.scope_key"
            ),
            [],
        )
        self.assertEqual(
            spike.rows(
                "SELECT cs.claim_id,cs.event_id FROM claim_support cs "
                "JOIN claims c ON c.id=cs.claim_id "
                "JOIN statements s ON s.event_id=cs.event_id "
                "WHERE c.scope_key<>s.scope_key"
            ),
            [],
        )
        self.assertEqual(
            spike.rows(
                "SELECT c.id FROM claims c WHERE c.state='active' AND NOT EXISTS ("
                "SELECT 1 FROM claim_support cs JOIN statements s ON s.event_id=cs.event_id "
                "WHERE cs.claim_id=c.id AND cs.live=1 AND s.state='live')"
            ),
            [],
        )
        self.assertEqual(
            spike.rows(
                "SELECT m.scope_key,m.last_seq,j.last_seq,m.rules_version "
                "FROM projection_meta m JOIN ("
                "SELECT scope_key,MAX(seq) last_seq FROM journal GROUP BY scope_key"
                ") j ON j.scope_key=m.scope_key "
                "WHERE m.last_seq<>j.last_seq OR m.rules_version<>?",
                (RULES_VERSION,),
            ),
            [],
        )
        statement_count = spike.conn.execute(
            "SELECT count(*) FROM journal WHERE kind='statement'"
        ).fetchone()[0]
        self.assertEqual(
            spike.conn.execute("SELECT count(*) FROM journal_fts").fetchone()[0],
            statement_count,
        )
        self.assertEqual(
            spike.conn.execute("SELECT count(*) FROM schema_migrations").fetchone()[0], 1
        )
        journal_rows = spike.conn.execute("SELECT seq,id FROM journal ORDER BY seq").fetchall()
        self.assertEqual(
            [row["seq"] for row in journal_rows],
            list(range(1, len(journal_rows) + 1)),
        )
        for row in journal_rows:
            self.assertEqual(row["id"], event_id_for_seq(row["seq"]))

        redirects = {
            row["old_id"]: (row["new_id"], row["kind"])
            for row in spike.conn.execute("SELECT old_id,new_id,kind FROM id_redirects")
        }
        for old_id, (_, expected_kind) in redirects.items():
            current = old_id
            visited: set[str] = set()
            for _ in range(33):
                if current not in redirects:
                    break
                self.assertNotIn(current, visited)
                visited.add(current)
                current, kind = redirects[current]
                self.assertEqual(kind, expected_kind)
            else:
                self.fail(f"redirect chain exceeds 32 hops: {old_id}")
            table = "entities" if expected_kind == "entity" else "claims"
            final = spike.conn.execute(
                f"SELECT scope_key FROM {table} WHERE id=?", (current,)
            ).fetchone()
            self.assertIsNotNone(final, f"redirect target missing: {old_id} -> {current}")
            origin = spike.conn.execute(
                f"SELECT scope_key FROM {table} WHERE id=?", (old_id,)
            ).fetchone()
            if origin is not None:
                self.assertEqual(origin["scope_key"], final["scope_key"])

    @staticmethod
    def semantic_snapshot(
        spike: ReferenceSpike, scope: str, *, include_times: bool = True
    ) -> dict[str, object]:
        entity_rows = {
            row["id"]: dict(row)
            for row in spike.conn.execute(
                "SELECT id,normal_name,merged_into FROM entities WHERE scope_key=?", (scope,)
            )
        }

        def entity_name(entity_id: str) -> str:
            canonical = spike.resolve_redirect(entity_id, "entity")
            return entity_rows[canonical]["normal_name"]

        entities = sorted(
            (
                row["normal_name"],
                entity_name(row["id"]),
                row["merged_into"] is not None,
            )
            for row in entity_rows.values()
        )
        surfaces = sorted(
            (
                row["surface_norm"],
                entity_name(row["entity_id"]),
                row["origin"],
            )
            for row in spike.conn.execute(
                "SELECT surface_norm,entity_id,origin FROM surface_forms WHERE scope_key=?",
                (scope,),
            )
        )
        claims = []
        for row in spike.conn.execute(
            "SELECT * FROM claims WHERE scope_key=? ORDER BY id", (scope,)
        ):
            live_supports = spike.conn.execute(
                "SELECT count(*) FROM claim_support WHERE claim_id=? AND live=1", (row["id"],)
            ).fetchone()[0]
            claims.append(
                (
                    entity_name(row["subject_id"]),
                    row["relation"],
                    ("entity", entity_name(row["object_id"]))
                    if row["object_id"]
                    else ("value", row["object_value"]),
                    row["state"],
                    live_supports,
                )
            )
        statements = []
        for row in spike.conn.execute(
            "SELECT s.state,s.provenance,s.created_at,s.expires_at,j.body "
            "FROM statements s JOIN journal j ON j.id=s.event_id "
            "WHERE s.scope_key=? ORDER BY s.order_seq,j.seq",
            (scope,),
        ):
            body = json.loads(row["body"])
            item: tuple[object, ...] = (
                body["raw_text"],
                row["state"],
                row["provenance"],
                body["parsed"],
            )
            if include_times:
                item += (row["created_at"], row["expires_at"])
            statements.append(item)
        return {
            "entities": entities,
            "surfaces": surfaces,
            "claims": sorted(claims, key=repr),
            "statements": statements,
        }

    @staticmethod
    def recall_without_times(result: dict[str, object]) -> dict[str, object]:
        copied = json.loads(json.dumps(result, ensure_ascii=False))
        for answer in copied["answers"]:
            if answer["kind"] == "claim":
                answer["support"].pop("last_seen", None)
            else:
                answer.pop("created_at", None)
        return copied

    def test_001_sqlite_capabilities_normalization_and_fts_rebuild(self) -> None:
        self.assertEqual(
            self.spike.capability_smoke_test(),
            {"json": True, "unixepoch": True, "fts5_trigram": True},
        )
        self.assertEqual(normalize_v1(" 인증_서버-API "), "인증서버api")
        self.assertEqual(normalize_v1("ＰｏｓｔｇｒｅＳＱＬ"), "postgresql")
        self.assertNotEqual(normalize_v1("서버가"), normalize_v1("서버를"))

        self.spike.record(SCOPE, "인증서버는 세션을 사용한다", [], at=T0)
        three_or_more = self.spike.conn.execute(
            "SELECT rowid FROM journal_fts WHERE journal_fts MATCH ?", ('"인증서"',)
        ).fetchall()
        two = self.spike.conn.execute(
            "SELECT rowid FROM journal_fts WHERE journal_fts MATCH ?", ('"인증"',)
        ).fetchall()
        self.assertEqual([row[0] for row in three_or_more], [1])
        self.assertEqual(two, [])
        before = [
            row[0]
            for row in self.spike.conn.execute(
                "SELECT rowid FROM journal_fts WHERE journal_fts MATCH ?", ('"인증서"',)
            )
        ]
        self.spike.rebuild_fts()
        after = [
            row[0]
            for row in self.spike.conn.execute(
                "SELECT rowid FROM journal_fts WHERE journal_fts MATCH ?", ('"인증서"',)
            )
        ]
        self.assertEqual(after, before)

    def test_002_append_rollback_and_replay_are_deterministic(self) -> None:
        self.spike.record(
            SCOPE,
            "인증 시스템은 서버 세션을 사용한다",
            [entity_draft("인증 시스템", "uses", "서버 세션")],
            provenance="user_stated",
            at=T0,
        )
        journal_before = self.spike.journal_checksum()
        projection_before = self.spike.projection_checksum()
        self.spike.replay_all()
        first_replay = self.spike.projection_checksum()
        self.spike.replay_all()
        self.assertEqual(self.spike.projection_checksum(), first_replay)
        self.assertEqual(first_replay, projection_before)
        self.assertEqual(self.spike.journal_checksum(), journal_before)

        with self.assertRaises(InjectedFailure):
            self.spike.record(
                SCOPE,
                "롤백되어야 한다",
                [literal_draft("롤백", "describes", "after journal")],
                at=T0 + 10,
                failpoint="after_journal",
            )
        self.assertEqual(self.spike.journal_checksum(), journal_before)
        self.assertEqual(self.spike.projection_checksum(), projection_before)
        self.assertEqual(self.spike.rows("SELECT rowid FROM journal_fts"), [{"rowid": 1}])

        with self.assertRaises(InjectedFailure):
            self.spike.record(
                SCOPE,
                "projector 실패도 롤백되어야 한다",
                [literal_draft("롤백", "describes", "during projection")],
                at=T0 + 20,
                failpoint="during_projection",
            )
        self.assertEqual(self.spike.journal_checksum(), journal_before)
        self.assertEqual(self.spike.projection_checksum(), projection_before)

    def test_003_reinforcement_duplicate_draft_and_stable_ids(self) -> None:
        first = self.spike.record(
            SCOPE,
            "인증 시스템은 PostgreSQL을 사용한다",
            [entity_draft("인증 시스템", "uses", "PostgreSQL")],
            provenance="observed",
            at=T0,
        )
        second = self.spike.record(
            SCOPE,
            "인증 시스템은 PostgreSQL을 사용한다",
            [
                entity_draft("인증 시스템", "uses", "PostgreSQL"),
                entity_draft("인증-시스템", "uses", "Postgre_SQL"),
            ],
            provenance="observed",
            at=T0 + 60,
        )
        self.assertEqual(first["claims"][0]["claim_id"], "c1.0")
        self.assertEqual(second["claims"][0]["claim_id"], "c1.0")
        self.assertEqual(second["claims"][1]["claim_id"], "c1.0")
        body = json.loads(
            self.spike.conn.execute("SELECT body FROM journal WHERE seq=2").fetchone()[0]
        )
        self.assertEqual(len(body["parsed"]), 1)
        self.assertEqual(
            self.spike.conn.execute(
                "SELECT count(*) FROM claim_support WHERE claim_id='c1.0'"
            ).fetchone()[0],
            2,
        )
        self.assertEqual(self.spike.resolve_redirect("c2.0", "claim"), "c1.0")
        checksum = self.spike.projection_checksum()
        self.spike.replay_all()
        self.assertEqual(self.spike.projection_checksum(), checksum)

    def test_004_describes_claim_and_event_retractions_have_different_history(self) -> None:
        first = self.spike.record(
            SCOPE,
            "테스트 명령은 pnpm test다",
            [literal_draft("테스트 명령", "describes", "pnpm test")],
            provenance="user_stated",
            at=T0,
        )
        second = self.spike.record(
            SCOPE,
            "테스트 명령은 pnpm test:unit이다",
            [literal_draft("테스트 명령", "describes", "pnpm test:unit")],
            provenance="user_stated",
            at=T0 + 60,
        )
        states = {
            row["object_value"]: row["state"]
            for row in self.spike.rows("SELECT object_value,state FROM claims ORDER BY id")
        }
        self.assertEqual(states, {"pnpm test": "superseded", "pnpm test:unit": "active"})

        current_id = second["claims"][0]["claim_id"]
        self.spike.retract_claim(SCOPE, current_id, at=T0 + 120)
        states = {
            row["object_value"]: row["state"]
            for row in self.spike.rows("SELECT object_value,state FROM claims ORDER BY id")
        }
        self.assertEqual(states, {"pnpm test": "superseded", "pnpm test:unit": "retracted"})
        self.assertEqual(self.active_claims(), [])

        self.spike.retract_event(SCOPE, second["event_id"], at=T0 + 180)
        states = {
            row["object_value"]: row["state"]
            for row in self.spike.rows("SELECT object_value,state FROM claims ORDER BY id")
        }
        self.assertEqual(states["pnpm test"], "active")
        self.assertEqual(states["pnpm test:unit"], "retracted")
        self.assertEqual(first["claims"][0]["claim_id"], self.active_claims()[0]["id"])

    def test_005_claim_and_statement_retraction_scopes_differ(self) -> None:
        record = self.spike.record(
            SCOPE,
            "인증 시스템은 세션을 쓰고 JWT는 거부한다",
            [
                entity_draft("인증 시스템", "uses", "서버 세션"),
                entity_draft("인증 시스템", "rejects", "JWT"),
            ],
            provenance="user_stated",
            at=T0,
        )
        self.spike.retract_claim(SCOPE, record["claims"][0]["claim_id"], at=T0 + 60)
        active = self.active_claims()
        # Every subject/object occurrence consumes an ADR-002 entity position,
        # even when the repeated subject redirects to an earlier entity.
        self.assertEqual([(row["relation"], row["object_id"]) for row in active], [("rejects", "e1.3")])
        self.assertEqual(
            self.spike.conn.execute(
                "SELECT state FROM statements WHERE event_id=?", (record["event_id"],)
            ).fetchone()[0],
            "live",
        )
        self.spike.retract_event(SCOPE, record["event_id"], at=T0 + 120)
        self.assertEqual(self.active_claims(), [])
        self.assertEqual(
            self.spike.conn.execute(
                "SELECT state FROM statements WHERE event_id=?", (record["event_id"],)
            ).fetchone()[0],
            "retracted",
        )

    def test_006_correct_is_two_consecutive_atomic_events(self) -> None:
        old = self.spike.record(
            SCOPE,
            "런타임은 Node 22다",
            [literal_draft("런타임 버전", "describes", "Node 22")],
            provenance="user_stated",
            at=T0,
        )
        event_ids = self.spike.correct_claim(
            SCOPE,
            old["claims"][0]["claim_id"],
            "런타임은 Node 24로 정정한다",
            literal_draft("런타임 버전", "describes", "Node 24"),
            at=T0 + 60,
        )
        rows = self.spike.rows(
            "SELECT seq,id,kind FROM journal WHERE id IN (?,?) ORDER BY seq", event_ids
        )
        self.assertEqual([row["kind"] for row in rows], ["retraction", "statement"])
        self.assertEqual(rows[1]["seq"], rows[0]["seq"] + 1)
        self.assertEqual([row["object_value"] for row in self.active_claims()], ["Node 24"])

        journal_before = self.spike.journal_checksum()
        projection_before = self.spike.projection_checksum()
        current = self.active_claims()[0]["id"]
        with self.assertRaises(InjectedFailure):
            self.spike.correct_claim(
                SCOPE,
                current,
                "실패하는 교정",
                literal_draft("런타임 버전", "describes", "Node 25"),
                at=T0 + 120,
                failpoint="during_projection",
            )
        self.assertEqual(self.spike.journal_checksum(), journal_before)
        self.assertEqual(self.spike.projection_checksum(), projection_before)

    def test_007_merge_deduplicates_claim_support_and_event_retraction_undoes_it(self) -> None:
        first = self.spike.record(
            SCOPE,
            "인증서버는 PostgreSQL을 사용한다",
            [entity_draft("인증서버", "uses", "PostgreSQL", subject_aliases=["로그인"] )],
            provenance="observed",
            at=T0,
        )
        second = self.spike.record(
            SCOPE,
            "auth-service는 PostgreSQL을 사용한다",
            [entity_draft("auth-service", "uses", "PostgreSQL")],
            provenance="observed",
            at=T0 + 60,
        )
        keep = self.spike.entity_id(SCOPE, "인증서버")
        absorb = self.spike.entity_id(SCOPE, "auth-service")
        merge_event = self.spike.merge(SCOPE, keep, absorb, at=T0 + 120)

        active = self.active_claims()
        self.assertEqual(len(active), 1)
        survivor = active[0]["id"]
        self.assertEqual(
            self.spike.conn.execute(
                "SELECT count(*) FROM claim_support WHERE claim_id=? AND live=1", (survivor,)
            ).fetchone()[0],
            2,
        )
        self.assertEqual(self.spike.resolve_redirect(absorb, "entity"), keep)
        self.assertEqual(self.spike.resolve_redirect(second["claims"][0]["claim_id"], "claim"), survivor)
        self.assertEqual(self.spike.entity_id(SCOPE, "auth-service"), keep)

        self.spike.retract_event(SCOPE, merge_event, at=T0 + 180)
        self.assertEqual(len(self.active_claims()), 2)
        self.assertEqual(self.spike.entity_id(SCOPE, "인증서버"), keep)
        self.assertEqual(self.spike.entity_id(SCOPE, "auth-service"), absorb)
        self.assertEqual(self.spike.resolve_redirect(absorb, "entity"), absorb)
        self.assertEqual(first["claims"][0]["claim_id"], "c1.0")

    def test_008_alias_confirmation_and_retraction_restore_origin(self) -> None:
        record = self.spike.record(
            SCOPE,
            "인증 시스템은 세션을 사용한다",
            [entity_draft("인증 시스템", "uses", "서버 세션", subject_aliases=["로그인"])],
            at=T0,
        )
        entity_id = self.spike.entity_id(SCOPE, "로그인")
        self.assertEqual(
            self.spike.conn.execute(
                "SELECT origin FROM surface_forms WHERE scope_key=? AND surface_norm=? AND entity_id=?",
                (SCOPE, normalize_v1("로그인"), entity_id),
            ).fetchone()[0],
            "agent_supplied",
        )
        alias_event = self.spike.alias(SCOPE, "로그인", entity_id, at=T0 + 60)
        self.assertEqual(
            self.spike.conn.execute(
                "SELECT origin FROM surface_forms WHERE scope_key=? AND surface_norm=? AND entity_id=?",
                (SCOPE, normalize_v1("로그인"), entity_id),
            ).fetchone()[0],
            "confirmed",
        )
        self.spike.retract_event(SCOPE, alias_event, at=T0 + 120)
        self.assertEqual(
            self.spike.conn.execute(
                "SELECT origin FROM surface_forms WHERE scope_key=? AND surface_norm=? AND entity_id=?",
                (SCOPE, normalize_v1("로그인"), entity_id),
            ).fetchone()[0],
            "agent_supplied",
        )
        self.assertEqual(record["event_id"], event_id_for_seq(1))

    def test_009_scope_isolation_applies_to_recall_and_ids(self) -> None:
        first = self.spike.record(
            SCOPE,
            "API는 SQLite를 사용한다",
            [entity_draft("API", "uses", "SQLite")],
            provenance="user_stated",
            at=T0,
        )
        second = self.spike.record(
            OTHER_SCOPE,
            "API는 PostgreSQL을 사용한다",
            [entity_draft("API", "uses", "PostgreSQL")],
            provenance="user_stated",
            at=T0 + 60,
        )
        recalled = self.spike.recall(SCOPE, query="API", terms=["API"], now=T0 + 120)
        self.assertEqual(len(recalled["answers"]), 1)
        self.assertIn("SQLite", recalled["answers"][0]["text"])
        self.assertNotIn("PostgreSQL", json.dumps(recalled, ensure_ascii=False))
        with self.assertRaisesRegex(ValidationError, "not found"):
            self.spike.retract_claim(SCOPE, second["claims"][0]["claim_id"], at=T0 + 180)
        self.assertEqual(
            self.spike.conn.execute(
                "SELECT count(*) FROM journal WHERE scope_key=?", (SCOPE,)
            ).fetchone()[0],
            1,
        )
        self.assertEqual(first["claims"][0]["claim_id"], "c1.0")

    def test_010_ttl_aggregate_label_fallback_and_contested_expiry(self) -> None:
        first = self.spike.record(
            SCOPE,
            "인증은 JWT를 사용한다",
            [entity_draft("인증", "uses", "JWT", relation_label="예전에 사용")],
            provenance="observed",
            ttl="permanent",
            at=T0,
        )
        self.spike.record(
            SCOPE,
            "인증은 JWT를 채택했다",
            [entity_draft("인증", "uses", "JWT", relation_label="최근 채택")],
            provenance="user_stated",
            ttl="session",
            at=T0 + 60,
        )
        self.spike.record(
            SCOPE,
            "인증은 JWT를 거부했다",
            [entity_draft("인증", "rejects", "JWT")],
            provenance="user_stated",
            ttl="session",
            at=T0 + 60,
        )
        before = self.spike.recall(SCOPE, query="인증", terms=["인증"], now=T0 + 120)
        uses_before = next(answer for answer in before["answers"] if answer["claim_id"] == first["claims"][0]["claim_id"])
        self.assertIn("최근 채택", uses_before["text"])
        self.assertEqual(uses_before["support"], {
            "count": 2,
            "strongest": "user_stated",
            "last_seen": T0 + 60,
        })
        self.assertTrue(uses_before["contested"])

        after = self.spike.recall(SCOPE, query="인증", terms=["인증"], now=T0 + 43_261)
        self.assertEqual(len(after["answers"]), 1)
        uses_after = after["answers"][0]
        self.assertIn("예전에 사용", uses_after["text"])
        self.assertEqual(uses_after["support"], {
            "count": 1,
            "strongest": "observed",
            "last_seen": T0,
        })
        self.assertFalse(uses_after["contested"])

    def test_011_raw_fallback_respects_ttl_and_never_resurrects_parsed_claim(self) -> None:
        raw = self.spike.record(
            SCOPE,
            "배포 창구는 금요일 오후다",
            [],
            provenance="inferred",
            ttl="session",
            at=T0,
        )
        before = self.spike.recall(SCOPE, query="배포 창구", terms=["배포 창구"], now=T0 + 60)
        self.assertEqual(before["entry"], "fts")
        self.assertEqual(before["answers"][0]["kind"], "raw")
        self.assertEqual(before["answers"][0]["event_id"], raw["event_id"])
        expired = self.spike.recall(
            SCOPE, query="배포 창구", terms=["배포 창구"], now=T0 + 43_201
        )
        self.assertEqual(expired["answers"], [])

        parsed = self.spike.record(
            SCOPE,
            "인증서버는 JWT를 사용한다",
            [entity_draft("인증서버", "uses", "JWT")],
            provenance="user_stated",
            at=T0 + 100,
        )
        self.spike.retract_claim(SCOPE, parsed["claims"][0]["claim_id"], at=T0 + 160)
        deleted = self.spike.recall(
            SCOPE, query="인증서버", terms=["인증서버"], now=T0 + 200
        )
        self.assertEqual(deleted["answers"], [])
        self.assertNotIn("JWT", json.dumps(deleted, ensure_ascii=False))

    def test_012_graph_recall_collects_literals_and_traverses_both_directions(self) -> None:
        self.spike.record(
            SCOPE,
            "리포는 인증 시스템을 포함한다",
            [entity_draft("리포", "contains", "인증 시스템")],
            provenance="observed",
            at=T0,
        )
        self.spike.record(
            SCOPE,
            "인증 시스템은 서버 세션을 사용한다",
            [entity_draft("인증 시스템", "uses", "서버 세션", object_aliases=["세션 저장소"])],
            provenance="user_stated",
            at=T0 + 60,
        )
        literal = self.spike.record(
            SCOPE,
            "인증 테스트 명령은 pnpm test:auth다",
            [literal_draft("인증 테스트 명령", "describes", "pnpm test:auth")],
            provenance="user_stated",
            at=T0 + 120,
        )
        incoming = self.spike.recall(
            SCOPE, query="세션 저장소", terms=["세션 저장소"], depth=2, now=T0 + 180
        )
        texts = [answer["text"] for answer in incoming["answers"]]
        self.assertTrue(any("인증 시스템 사용 서버 세션" in text for text in texts))
        use_answer = next(answer for answer in incoming["answers"] if "서버 세션" in answer["text"])
        self.assertIn("세션 저장소", use_answer["path"])
        self.assertGreaterEqual(use_answer["hops"], 1)

        literal_result = self.spike.recall(
            SCOPE,
            query="인증 테스트 명령",
            terms=["인증 테스트 명령"],
            now=T0 + 180,
        )
        literal_answer = next(
            answer for answer in literal_result["answers"] if answer["claim_id"] == literal["claims"][0]["claim_id"]
        )
        self.assertEqual(literal_answer["hops"], 0)
        self.assertIn("pnpm test:auth", literal_answer["text"])

    def test_013_hub_fanout_is_bounded_and_visible(self) -> None:
        drafts = [entity_draft("허브", "relates_to", f"노드 {index}", relation_label="연결") for index in range(31)]
        self.spike.record(
            SCOPE,
            "허브는 31개 노드에 연결된다",
            drafts,
            provenance="observed",
            at=T0,
        )
        result = self.spike.recall(
            SCOPE, query="허브", terms=["허브"], depth=1, limit=50, now=T0 + 60
        )
        self.assertEqual(len(result["answers"]), 30)
        self.assertTrue(result["more_available"])
        self.assertIn("incident fanout", result["note"])

    def test_014_reinterpret_inherits_metadata_and_respects_prior_claim_retraction(self) -> None:
        root = self.spike.record(
            SCOPE,
            "인증은 JWT를 사용한다",
            [entity_draft("인증", "uses", "JWT")],
            provenance="inferred",
            ttl="weeks",
            at=T0,
        )
        self.spike.retract_claim(SCOPE, root["claims"][0]["claim_id"], at=T0 + 60)
        reparsed = [entity_draft("인증", "uses", "JWT", relation_label="사용한다고 추론")]
        token = self.spike.issue_reinterpret_approval(
            SCOPE, root["event_id"], "인증은 JWT를 사용한다", reparsed, now=T0 + 100
        )
        successor = self.spike.record(
            SCOPE,
            "인증은 JWT를 사용한다",
            reparsed,
            supersedes=root["event_id"],
            reinterpret_approval=token,
            at=T0 + 120,
        )
        statement = self.spike.conn.execute(
            "SELECT * FROM statements WHERE event_id=?", (successor["event_id"],)
        ).fetchone()
        self.assertEqual(statement["order_seq"], 1)
        self.assertEqual(statement["created_at"], T0)
        self.assertEqual(statement["provenance"], "inferred")
        self.assertEqual(statement["expires_at"], T0 + 2_592_000)
        self.assertEqual(self.active_claims(), [])
        self.assertNotIn(
            token,
            "".join(row["body"] for row in self.spike.rows("SELECT body FROM journal")),
        )
        support = self.spike.conn.execute(
            "SELECT cs.live,s.order_seq FROM claim_support cs JOIN statements s ON s.event_id=cs.event_id "
            "WHERE cs.event_id=?",
            (successor["event_id"],),
        ).fetchone()
        self.assertEqual((support["live"], support["order_seq"]), (0, 1))
        with self.assertRaises(ValidationError):
            self.spike.record(
                SCOPE,
                "인증은 JWT를 사용한다",
                reparsed,
                supersedes=successor["event_id"],
                reinterpret_approval=token,
                at=T0 + 180,
            )

    def test_015_backdated_reinterpret_cannot_override_later_describes_and_can_be_undone(self) -> None:
        root = self.spike.record(
            SCOPE,
            "런타임은 Node 20이다",
            [literal_draft("런타임 버전", "describes", "Node 20")],
            provenance="user_stated",
            at=T0,
        )
        later = self.spike.record(
            SCOPE,
            "런타임은 Node 22이다",
            [literal_draft("런타임 버전", "describes", "Node 22")],
            provenance="user_stated",
            at=T0 + 60,
        )
        reparsed = [literal_draft("런타임 버전", "describes", "Node 20 LTS")]
        token = self.spike.issue_reinterpret_approval(
            SCOPE, root["event_id"], "런타임은 Node 20이다", reparsed, now=T0 + 100
        )
        successor = self.spike.record(
            SCOPE,
            "런타임은 Node 20이다",
            reparsed,
            supersedes=root["event_id"],
            reinterpret_approval=token,
            at=T0 + 120,
        )
        self.assertEqual([row["object_value"] for row in self.active_claims()], ["Node 22"])
        self.spike.retract_event(SCOPE, successor["event_id"], cascade=False, at=T0 + 180)
        self.assertEqual([row["object_value"] for row in self.active_claims()], ["Node 22"])
        states = {
            row["event_id"]: row["state"]
            for row in self.spike.rows("SELECT event_id,state FROM statements")
        }
        self.assertEqual(states[root["event_id"]], "live")
        self.assertEqual(states[successor["event_id"]], "retracted")
        self.assertEqual(states[later["event_id"]], "live")

        # A later default cascade against the successor removes the whole
        # reinterpret chain; the independent later decision remains current.
        self.spike.retract_event(SCOPE, successor["event_id"], at=T0 + 240)
        states = {
            row["event_id"]: row["state"]
            for row in self.spike.rows("SELECT event_id,state FROM statements")
        }
        self.assertEqual(states[root["event_id"]], "retracted")
        self.assertEqual(states[successor["event_id"]], "retracted")
        self.assertEqual(states[later["event_id"]], "live")
        self.assertEqual([row["object_value"] for row in self.active_claims()], ["Node 22"])

    def test_016_reinterpret_approval_is_payload_bound_expiring_and_stale(self) -> None:
        root = self.spike.record(
            SCOPE,
            "파싱하지 못한 원문",
            [],
            provenance="observed",
            at=T0,
        )
        drafts = [literal_draft("파싱 상태", "describes", "완료")]
        mismatch = self.spike.issue_reinterpret_approval(
            SCOPE, root["event_id"], "파싱하지 못한 원문", drafts, now=T0 + 10
        )
        with self.assertRaises(ValidationError):
            self.spike.record(
                SCOPE,
                "파싱하지 못한 원문",
                [literal_draft("파싱 상태", "describes", "다른 payload")],
                supersedes=root["event_id"],
                reinterpret_approval=mismatch,
                at=T0 + 20,
            )
        self.assertEqual(
            self.spike.conn.execute("SELECT count(*) FROM journal").fetchone()[0], 1
        )

        stale = self.spike.issue_reinterpret_approval(
            SCOPE, root["event_id"], "파싱하지 못한 원문", drafts, now=T0 + 30
        )
        self.spike.record(SCOPE, "중간 사건", [], at=T0 + 40)
        with self.assertRaises(ValidationError):
            self.spike.record(
                SCOPE,
                "파싱하지 못한 원문",
                drafts,
                supersedes=root["event_id"],
                reinterpret_approval=stale,
                at=T0 + 50,
            )
        self.assertEqual(
            self.spike.conn.execute("SELECT count(*) FROM journal").fetchone()[0], 2
        )

        expired = self.spike.issue_reinterpret_approval(
            SCOPE, root["event_id"], "파싱하지 못한 원문", drafts, now=T0 + 60
        )
        with self.assertRaises(ValidationError):
            self.spike.record(
                SCOPE,
                "파싱하지 못한 원문",
                drafts,
                supersedes=root["event_id"],
                reinterpret_approval=expired,
                at=T0 + 961,
            )

    def test_017_merge_with_competing_describes_uses_latest_structural_activation(self) -> None:
        self.spike.record(
            SCOPE,
            "A 런타임은 Node 20이다",
            [literal_draft("A 런타임", "describes", "Node 20")],
            provenance="observed",
            at=T0,
        )
        self.spike.record(
            SCOPE,
            "B 런타임은 Node 22이다",
            [literal_draft("B 런타임", "describes", "Node 22")],
            provenance="observed",
            at=T0 + 60,
        )
        keep = self.spike.entity_id(SCOPE, "A 런타임")
        absorb = self.spike.entity_id(SCOPE, "B 런타임")
        merge_event = self.spike.merge(SCOPE, keep, absorb, at=T0 + 120)
        self.assertEqual([row["object_value"] for row in self.active_claims()], ["Node 22"])
        self.spike.retract_event(SCOPE, merge_event, at=T0 + 180)
        self.assertEqual(
            sorted(row["object_value"] for row in self.active_claims()),
            ["Node 20", "Node 22"],
        )

    def test_018_secret_masking_partial_draft_rejection_and_fail_closed_revise(self) -> None:
        token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456"
        result = self.spike.record(
            SCOPE,
            f"토큰 {token}은 저장하면 안 되고 SQLite는 사용한다",
            [
                entity_draft("비밀", "describes", token),
                entity_draft("저장소", "uses", "SQLite"),
            ],
            provenance="user_stated",
            at=T0,
        )
        self.assertEqual([item["status"] for item in result["claims"]], ["rejected", "created"])
        body = self.spike.conn.execute("SELECT body FROM journal").fetchone()[0]
        self.assertNotIn(token, body)
        self.assertIn("[REDACTED:GITHUB-TOKEN]", body)
        self.assertEqual(len(json.loads(body)["parsed"]), 1)
        self.assertEqual(result["claims"][1]["claim_id"], "c1.0")
        self.assertEqual(len(self.active_claims()), 1)

        entity_id = self.spike.entity_id(SCOPE, "저장소")
        journal_before = self.spike.journal_checksum()
        with self.assertRaises(ValidationError):
            self.spike.alias(SCOPE, token, entity_id, at=T0 + 60)
        self.assertEqual(self.spike.journal_checksum(), journal_before)
        self.assertEqual(
            self.spike.conn.execute(
                "SELECT count(*) FROM journal_fts WHERE journal_fts MATCH ?",
                ('"' + token.replace('"', '""') + '"',),
            ).fetchone()[0],
            0,
        )

    def test_019_overview_is_deterministic_and_read_only(self) -> None:
        self.spike.record(
            SCOPE,
            "인증은 세션과 DB를 사용한다",
            [
                entity_draft("인증", "uses", "세션"),
                entity_draft("인증", "uses", "DB"),
            ],
            provenance="user_stated",
            at=T0,
        )
        self.spike.record(
            SCOPE,
            "원문만 남긴 메모",
            [],
            provenance="observed",
            at=T0 + 60,
        )
        checksum = self.spike.projection_checksum()
        first = self.spike.recall(SCOPE, mode="overview", now=T0 + 120)
        second = self.spike.recall(SCOPE, mode="overview", now=T0 + 120)
        self.assertEqual(first, second)
        self.assertEqual(first["entry"], "overview")
        self.assertEqual(self.spike.projection_checksum(), checksum)

    def test_020_wal_supports_serialized_writes_and_concurrent_readers(self) -> None:
        barrier = threading.Barrier(8)
        failures: list[BaseException] = []

        def writer(index: int) -> None:
            try:
                barrier.wait()
                self.spike.record(
                    SCOPE,
                    f"writer {index}",
                    [entity_draft("공유 writer", "uses", f"대상 {index}")],
                    provenance="observed",
                    at=T0 + index,
                )
            except BaseException as exc:  # captured for assertion in the parent thread
                failures.append(exc)

        def reader() -> None:
            connection = sqlite3.connect(self.db_path, timeout=5.0)
            try:
                barrier.wait()
                for _ in range(20):
                    connection.execute("SELECT count(*) FROM journal").fetchone()
                    connection.execute("SELECT count(*) FROM claims").fetchone()
            except BaseException as exc:
                failures.append(exc)
            finally:
                connection.close()

        threads = [threading.Thread(target=writer, args=(index,)) for index in range(4)]
        threads.extend(threading.Thread(target=reader) for _ in range(4))
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=15)
        self.assertFalse(any(thread.is_alive() for thread in threads))
        self.assertEqual(failures, [])
        self.assertEqual(
            self.spike.conn.execute("SELECT count(*) FROM journal").fetchone()[0], 4
        )
        self.assertEqual(len(self.active_claims()), 4)
        self.assertEqual(
            self.spike.conn.execute(
                "SELECT count(*) FROM entities WHERE scope_key=? AND normal_name=? "
                "AND merged_into IS NULL",
                (SCOPE, normalize_v1("공유 writer")),
            ).fetchone()[0],
            1,
        )
        self.assertEqual(
            self.spike.conn.execute("PRAGMA journal_mode").fetchone()[0].lower(), "wal"
        )
        self.assertEqual(self.spike.conn.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_021_scenario_matrix_is_complete_and_points_to_real_tests(self) -> None:
        matrix_path = Path(__file__).with_name("scenario-matrix.json")
        matrix = json.loads(matrix_path.read_text(encoding="utf-8"))
        scenarios = matrix["scenarios"]
        self.assertEqual(len({item["id"] for item in scenarios}), len(scenarios))
        self.assertEqual(len({item["test"] for item in scenarios}), len(scenarios))
        available = set(dir(type(self)))
        for scenario in scenarios:
            self.assertIn(scenario["test"], available)
            self.assertTrue(scenario["adrs"])
        executable_adrs = {adr for item in scenarios for adr in item["adrs"]}
        expected_executable = {f"ADR-{number:03d}" for number in range(1, 16)} | {"ADR-017"}
        self.assertTrue(expected_executable <= executable_adrs)
        self.assertEqual(
            matrix["non_executable_assessment"]["ADR-016"]["classification"],
            "implementation decision",
        )

    def test_022_confirmed_alias_resolves_later_statement_to_the_same_entity(self) -> None:
        self.spike.record(
            SCOPE,
            "인증 시스템은 서버 세션을 사용한다",
            [entity_draft("인증 시스템", "uses", "서버 세션")],
            provenance="observed",
            at=T0,
        )
        canonical = self.spike.entity_id(SCOPE, "인증 시스템")
        self.spike.alias(SCOPE, "로그인", canonical, at=T0 + 60)
        later = self.spike.record(
            SCOPE,
            "로그인은 MFA를 사용한다",
            [entity_draft("로그인", "uses", "MFA")],
            provenance="observed",
            at=T0 + 120,
        )
        claim = self.spike.conn.execute(
            "SELECT * FROM claims WHERE id=?", (later["claims"][0]["claim_id"],)
        ).fetchone()
        self.assertEqual(claim["subject_id"], canonical)
        self.assertEqual(self.spike.resolve_redirect("e3.0", "entity"), canonical)
        self.assertEqual(self.spike.entity_id(SCOPE, "로그인"), canonical)
        checksum = self.spike.projection_checksum()
        self.spike.replay_all()
        self.assertEqual(self.spike.projection_checksum(), checksum)

    def test_023_surface_without_valid_claim_falls_back_to_fts_and_overview_raw(self) -> None:
        self.spike.record(
            SCOPE,
            "배포시스템은 임시 큐를 사용한다",
            [entity_draft("배포시스템", "uses", "임시 큐")],
            provenance="inferred",
            ttl="session",
            at=T0,
        )
        raw = self.spike.record(
            SCOPE,
            "배포시스템 창구는 금요일 오후다",
            [],
            provenance="observed",
            at=T0 + 60,
        )
        now = T0 + 43_201
        search = self.spike.recall(
            SCOPE,
            query="배포시스템",
            terms=["배포시스템"],
            now=now,
        )
        self.assertEqual(search["entry"], "fts")
        self.assertEqual([answer["event_id"] for answer in search["answers"]], [raw["event_id"]])
        self.assertIn("surface produced no valid claim", search["note"])

        overview = self.spike.recall(SCOPE, mode="overview", now=now)
        self.assertEqual(overview["entry"], "overview")
        self.assertEqual([answer["event_id"] for answer in overview["answers"]], [raw["event_id"]])

    def test_024_seeded_state_machine_and_metamorphic_invariants(self) -> None:
        coverage: set[str] = set()
        seeds = (3, 17, 29, 43, 59, 71, 89, 101)

        for seed in seeds:
            trace_path = Path(self.tempdir.name) / f"trace-{seed}.db"
            rng = random.Random(seed)
            reversible: list[tuple[str, str]] = []
            retracted_events: set[str] = set()
            with ReferenceSpike(trace_path, start_time=T0 - 60) as trace:
                for step in range(36):
                    if step <= 10:
                        scope = (SCOPE, OTHER_SCOPE)[step % 2]
                    else:
                        scope = rng.choice((SCOPE, OTHER_SCOPE))
                    at = T0 + seed * 10_000 + step * 60
                    active = trace.rows(
                        "SELECT c.*,e.name subject_name FROM claims c "
                        "JOIN entities e ON e.id=c.subject_id "
                        "WHERE c.scope_key=? AND c.state='active' ORDER BY c.id",
                        (scope,),
                    )
                    entities = trace.rows(
                        "SELECT id,name FROM entities WHERE scope_key=? AND merged_into IS NULL "
                        "ORDER BY id",
                        (scope,),
                    )
                    event_candidates = [
                        event_id
                        for event_scope, event_id in reversible
                        if event_scope == scope and event_id not in retracted_events
                    ]
                    event_candidates.extend(
                        row["event_id"]
                        for row in trace.rows(
                            "SELECT event_id FROM statements WHERE scope_key=? AND state='live' "
                            "ORDER BY event_id",
                            (scope,),
                        )
                    )

                    forced = {
                        0: "record",
                        1: "record",
                        2: "record",
                        3: "record",
                        4: "record",
                        5: "record",
                        6: "alias",
                        7: "merge",
                        8: "correct",
                        9: "retract_claim",
                        10: "retract_event",
                    }
                    operation = forced.get(step)
                    if operation is None:
                        available = ["record"]
                        weights = [42]
                        if active:
                            available.extend(("retract_claim", "correct"))
                            weights.extend((14, 12))
                        if len(entities) >= 2:
                            available.append("merge")
                            weights.append(11)
                        if entities:
                            available.append("alias")
                            weights.append(10)
                        if event_candidates:
                            available.append("retract_event")
                            weights.append(11)
                        operation = rng.choices(available, weights=weights, k=1)[0]

                    coverage.add(operation)
                    if operation == "record":
                        relation = rng.choice(
                            ("uses", "rejects", "contains", "describes", "relates_to")
                        )
                        subject = f"서비스 {rng.randrange(6)}"
                        extra: dict[str, object] = {}
                        if step % 5 == 0:
                            extra["subject_aliases"] = [f"입구-{seed}-{step}"]
                        if relation == "describes":
                            draft = literal_draft(
                                subject,
                                relation,
                                f"값-{seed}-{step % 9}",
                                **extra,
                            )
                        else:
                            if relation == "relates_to":
                                extra["relation_label"] = "연결됨"
                            draft = entity_draft(
                                subject,
                                relation,
                                f"대상 {rng.randrange(7)}",
                                **extra,
                            )
                        trace.record(
                            scope,
                            f"seed {seed} step {step} {relation}",
                            [draft],
                            provenance=rng.choice(("user_stated", "observed", "inferred")),
                            ttl=rng.choice(("session", "weeks", "permanent")),
                            at=at,
                        )
                    elif operation == "retract_claim":
                        target = rng.choice(active)
                        trace.retract_claim(scope, target["id"], at=at)
                    elif operation == "correct":
                        target = rng.choice(active)
                        if target["relation"] == "describes":
                            replacement = literal_draft(
                                target["subject_name"],
                                "describes",
                                f"교정값-{seed}-{step}",
                            )
                        else:
                            replacement_extra: dict[str, object] = {}
                            if target["relation"] == "relates_to":
                                replacement_extra["relation_label"] = "교정 연결"
                            replacement = entity_draft(
                                target["subject_name"],
                                target["relation"],
                                f"교정대상 {seed}-{step}",
                                **replacement_extra,
                            )
                        trace.correct_claim(
                            scope,
                            target["id"],
                            f"seed {seed} step {step} 교정",
                            replacement,
                            at=at,
                        )
                    elif operation == "merge":
                        keep, absorb = rng.sample(entities, 2)
                        event_id = trace.merge(scope, keep["id"], absorb["id"], at=at)
                        reversible.append((scope, event_id))
                    elif operation == "alias":
                        entity = rng.choice(entities)
                        event_id = trace.alias(
                            scope, f"확인별칭-{seed}-{step}", entity["id"], at=at
                        )
                        reversible.append((scope, event_id))
                    elif operation == "retract_event":
                        target_event = rng.choice(event_candidates)
                        trace.retract_event(
                            scope,
                            target_event,
                            cascade=rng.choice((True, False)),
                            at=at,
                        )
                        retracted_events.add(target_event)
                    else:  # pragma: no cover - the generator has a closed operation set
                        self.fail(f"unknown generated operation: {operation}")

                    journal_before = trace.journal_checksum()
                    projection_before = trace.projection_checksum()
                    trace.replay_all()
                    self.assertEqual(trace.journal_checksum(), journal_before)
                    self.assertEqual(trace.projection_checksum(), projection_before)
                    self.assert_projection_invariants(trace)
                    if step % 9 == 0:
                        persistent = trace.projection_checksum()
                        for recall_scope in (SCOPE, OTHER_SCOPE):
                            trace.recall(
                                recall_scope,
                                mode="overview",
                                now=at + 2_592_001,
                                limit=20,
                            )
                        self.assertEqual(trace.projection_checksum(), persistent)

        self.assertEqual(
            coverage,
            {"record", "retract_claim", "correct", "merge", "alias", "retract_event"},
        )

        def emit(spike: ReferenceSpike, scope: str, label: str, local_index: int) -> None:
            if local_index == 0:
                draft = entity_draft(f"{label} 서비스", "uses", f"{label} DB")
            else:
                draft = literal_draft(
                    f"{label} 명령", "describes", f"{label}-v{local_index}"
                )
            spike.record(
                scope,
                f"{label} local event {local_index}",
                [draft],
                provenance="observed",
                at=T0 + local_index * 60,
            )

        sequential_path = Path(self.tempdir.name) / "scope-sequential.db"
        interleaved_path = Path(self.tempdir.name) / "scope-interleaved.db"
        with (
            ReferenceSpike(sequential_path, start_time=T0 - 60) as sequential,
            ReferenceSpike(interleaved_path, start_time=T0 - 60) as interleaved,
        ):
            for scope, label in ((SCOPE, "A"), (OTHER_SCOPE, "B")):
                for local_index in range(3):
                    emit(sequential, scope, label, local_index)
            for local_index in range(3):
                emit(interleaved, SCOPE, "A", local_index)
                emit(interleaved, OTHER_SCOPE, "B", local_index)
            self.assertEqual(
                self.semantic_snapshot(sequential, SCOPE),
                self.semantic_snapshot(interleaved, SCOPE),
            )
            self.assertEqual(
                self.semantic_snapshot(sequential, OTHER_SCOPE),
                self.semantic_snapshot(interleaved, OTHER_SCOPE),
            )

        correct_path = Path(self.tempdir.name) / "correct-compound.db"
        primitive_path = Path(self.tempdir.name) / "correct-primitives.db"
        with (
            ReferenceSpike(correct_path, start_time=T0 - 60) as compound,
            ReferenceSpike(primitive_path, start_time=T0 - 60) as primitives,
        ):
            for spike in (compound, primitives):
                spike.record(
                    SCOPE,
                    "런타임은 v1이다",
                    [literal_draft("런타임", "describes", "v1")],
                    provenance="user_stated",
                    at=T0,
                )
            replacement = literal_draft("런타임", "describes", "v2")
            compound.correct_claim(
                SCOPE, "c1.0", "런타임은 v2다", replacement, at=T0 + 60
            )
            primitives.retract_claim(SCOPE, "c1.0", at=T0 + 60)
            primitives.record(
                SCOPE,
                "런타임은 v2다",
                [replacement],
                provenance="user_stated",
                at=T0 + 60,
            )
            self.assertEqual(compound.journal_checksum(), primitives.journal_checksum())
            self.assertEqual(compound.projection_checksum(), primitives.projection_checksum())

        undo_path = Path(self.tempdir.name) / "merge-alias-undo.db"
        with ReferenceSpike(undo_path, start_time=T0 - 60) as undo:
            undo.record(
                SCOPE,
                "서비스 A는 DB를 사용한다",
                [entity_draft("서비스 A", "uses", "DB")],
                at=T0,
            )
            undo.record(
                SCOPE,
                "service-a는 큐를 사용한다",
                [entity_draft("service-a", "uses", "큐")],
                at=T0 + 60,
            )
            baseline = undo.projection_checksum()
            merge_event = undo.merge(
                SCOPE,
                undo.entity_id(SCOPE, "서비스 A"),
                undo.entity_id(SCOPE, "service-a"),
                at=T0 + 120,
            )
            undo.retract_event(SCOPE, merge_event, at=T0 + 180)
            self.assertEqual(undo.projection_checksum(), baseline)
            alias_event = undo.alias(
                SCOPE, "로그인", undo.entity_id(SCOPE, "서비스 A"), at=T0 + 240
            )
            undo.retract_event(SCOPE, alias_event, at=T0 + 300)
            self.assertEqual(undo.projection_checksum(), baseline)

        early_path = Path(self.tempdir.name) / "ttl-early.db"
        shifted_path = Path(self.tempdir.name) / "ttl-shifted.db"
        delta = 9_000_000
        with (
            ReferenceSpike(early_path, start_time=T0 - 60) as early,
            ReferenceSpike(shifted_path, start_time=T0 + delta - 60) as shifted,
        ):
            draft = entity_draft("임시 기능", "uses", "임시 저장소")
            early.record(
                SCOPE, "임시 기능 메모", [draft], ttl="session", at=T0
            )
            shifted.record(
                SCOPE, "임시 기능 메모", [draft], ttl="session", at=T0 + delta
            )
            self.assertEqual(
                self.semantic_snapshot(early, SCOPE, include_times=False),
                self.semantic_snapshot(shifted, SCOPE, include_times=False),
            )
            early_live = early.recall(
                SCOPE, query="임시 기능", terms=["임시 기능"], now=T0 + 100
            )
            shifted_live = shifted.recall(
                SCOPE,
                query="임시 기능",
                terms=["임시 기능"],
                now=T0 + delta + 100,
            )
            self.assertEqual(
                self.recall_without_times(early_live),
                self.recall_without_times(shifted_live),
            )
            self.assertEqual(
                early.recall(
                    SCOPE,
                    query="임시 기능",
                    terms=["임시 기능"],
                    now=T0 + 43_201,
                )["answers"],
                [],
            )
            self.assertEqual(
                shifted.recall(
                    SCOPE,
                    query="임시 기능",
                    terms=["임시 기능"],
                    now=T0 + delta + 43_201,
                )["answers"],
                [],
            )

    def test_025_process_crash_reopen_is_atomic_and_recoverable(self) -> None:
        worker = Path(__file__).with_name("crash_worker.py")
        crash_cases = [
            ("before_journal_insert", "record", "old"),
            ("after_journal_insert", "record", "old"),
            ("after_projection_delete", "record", "old"),
            ("during_projection_write", "record", "old"),
            ("after_projection_meta", "record", "old"),
            ("before_commit", "record", "old"),
            ("after_commit", "record", "new"),
            ("after_journal_insert", "correct", "old"),
        ]
        for index, (point, operation, expected_state) in enumerate(crash_cases):
            with self.subTest(point=point, operation=operation):
                crash_path = Path(self.tempdir.name) / f"crash-{index}.db"
                with ReferenceSpike(crash_path, start_time=T0 - 60) as baseline:
                    baseline.record(
                        SCOPE,
                        "장애 복구 값은 v1이다",
                        [literal_draft("장애 복구 값", "describes", "v1")],
                        provenance="user_stated",
                        at=T0,
                    )
                    old_journal = baseline.journal_checksum()
                    old_projection = baseline.projection_checksum()

                child = subprocess.run(
                    [sys.executable, str(worker), str(crash_path), point, operation],
                    cwd=Path(__file__).parent,
                    capture_output=True,
                    text=True,
                    timeout=15,
                    check=False,
                )
                self.assertEqual(
                    child.returncode,
                    91,
                    f"child did not hard-crash at {point}: {child.stderr}",
                )

                with ReferenceSpike(crash_path, start_time=T0 + 60) as recovered:
                    self.assert_projection_invariants(recovered)
                    if expected_state == "old":
                        self.assertEqual(recovered.journal_checksum(), old_journal)
                        self.assertEqual(recovered.projection_checksum(), old_projection)
                        self.assertEqual(
                            recovered.conn.execute("SELECT count(*) FROM journal").fetchone()[0],
                            1,
                        )
                        self.assertEqual(
                            [row["object_value"] for row in recovered.rows(
                                "SELECT object_value FROM claims WHERE state='active'"
                            )],
                            ["v1"],
                        )
                    else:
                        self.assertEqual(
                            recovered.conn.execute("SELECT count(*) FROM journal").fetchone()[0],
                            2,
                        )
                        self.assertEqual(
                            [row["object_value"] for row in recovered.rows(
                                "SELECT object_value FROM claims WHERE state='active'"
                            )],
                            ["v2"],
                        )

                    journal_after_reopen = recovered.journal_checksum()
                    projection_after_reopen = recovered.projection_checksum()
                    recovered.replay_all()
                    self.assertEqual(recovered.journal_checksum(), journal_after_reopen)
                    self.assertEqual(recovered.projection_checksum(), projection_after_reopen)
                    recovered.record(
                        SCOPE,
                        "복구 후 값은 v3이다",
                        [literal_draft("장애 복구 값", "describes", "v3")],
                        provenance="user_stated",
                        at=T0 + 120,
                    )
                    self.assertEqual(
                        [row["object_value"] for row in recovered.rows(
                            "SELECT object_value FROM claims WHERE state='active'"
                        )],
                        ["v3"],
                    )
                    self.assert_projection_invariants(recovered)


if __name__ == "__main__":
    unittest.main(verbosity=2)
