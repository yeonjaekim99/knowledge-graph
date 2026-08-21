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

CREATE TABLE statements (
  event_id    TEXT PRIMARY KEY REFERENCES journal(id),
  scope_key   TEXT NOT NULL,
  state       TEXT NOT NULL CHECK (state IN ('live','retracted','superseded')),
  order_seq   INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  provenance  TEXT NOT NULL
    CHECK (provenance IN ('user_stated','observed','inferred')),
  expires_at  INTEGER
);

CREATE INDEX idx_statements_live
  ON statements(scope_key) WHERE state = 'live';

CREATE TABLE entities (
  id          TEXT PRIMARY KEY,
  scope_key   TEXT NOT NULL,
  name        TEXT NOT NULL,
  normal_name TEXT NOT NULL,
  kind        TEXT,
  merged_into TEXT REFERENCES entities(id),
  origin_seq  INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_entities_normal
  ON entities(scope_key, normal_name) WHERE merged_into IS NULL;

CREATE TABLE surface_forms (
  scope_key    TEXT NOT NULL,
  surface_norm TEXT NOT NULL,
  entity_id    TEXT NOT NULL REFERENCES entities(id),
  origin       TEXT NOT NULL
    CHECK (origin IN ('name','agent_supplied','confirmed')),
  PRIMARY KEY (scope_key, surface_norm, entity_id)
);

CREATE INDEX idx_surface_lookup
  ON surface_forms(scope_key, surface_norm);

CREATE TABLE claims (
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

CREATE UNIQUE INDEX idx_claim_identity_entity_active
  ON claims(scope_key, subject_id, relation, object_id)
  WHERE state='active' AND object_id IS NOT NULL;

CREATE UNIQUE INDEX idx_claim_identity_value_active
  ON claims(scope_key, subject_id, relation, object_value)
  WHERE state='active' AND object_value IS NOT NULL;

CREATE TABLE claim_support (
  claim_id    TEXT NOT NULL REFERENCES claims(id),
  event_id    TEXT NOT NULL REFERENCES statements(event_id),
  draft_index INTEGER NOT NULL,
  live        INTEGER NOT NULL DEFAULT 1 CHECK (live IN (0,1)),
  expires_at  INTEGER,
  PRIMARY KEY (claim_id, event_id),
  UNIQUE (event_id, draft_index)
);

CREATE INDEX idx_support_event ON claim_support(event_id);

CREATE INDEX idx_claims_subject
  ON claims(subject_id, relation) WHERE state='active';

CREATE INDEX idx_claims_object
  ON claims(object_id, relation)
  WHERE state='active' AND object_id IS NOT NULL;

CREATE UNIQUE INDEX idx_claims_describes_single
  ON claims(scope_key, subject_id)
  WHERE state='active' AND relation='describes';

CREATE TABLE id_redirects (
  old_id TEXT PRIMARY KEY,
  new_id TEXT NOT NULL,
  kind   TEXT NOT NULL CHECK (kind IN ('entity','claim')),
  reason TEXT NOT NULL CHECK (reason IN ('merge','rule_change','deduplicated')),
  CHECK (old_id <> new_id)
);

CREATE INDEX idx_redirect_new ON id_redirects(new_id);

CREATE TABLE projection_meta (
  scope_key     TEXT PRIMARY KEY,
  last_seq      INTEGER NOT NULL,
  rules_version TEXT NOT NULL,
  rebuilt_at    INTEGER NOT NULL
);
