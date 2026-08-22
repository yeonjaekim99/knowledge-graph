import { resolveRecallQuerySurface } from "../../../src/application/recall-query-surface.js";
import type { RecallValidClaimSource } from "../../../src/application/ports/recall-read-port.js";
import type {
  RecallQuerySurfaceSelection,
  RecallQueryTerm,
} from "../../../src/domain/recall-query-surface.js";

declare const source: RecallValidClaimSource;
declare const term: RecallQueryTerm;

const result: Promise<RecallQuerySurfaceSelection> = resolveRecallQuerySurface(
  source,
  { query: "로그인", terms: ["로그인"] },
);
void result;
void source.resolveSurfaceSeeds([term]);

// @ts-expect-error query is required at the RCL-002 policy boundary.
void resolveRecallQuerySurface(source, { terms: ["로그인"] });

// @ts-expect-error the typed recall source never exposes raw SQL.
void source.query("SELECT * FROM surface_forms");

// @ts-expect-error seed terms must carry the shared normalized surface form.
void source.resolveSurfaceSeeds([{ text: "로그인" }]);
