import { traverseRecallGraph } from "../../../src/application/recall-graph-traversal.js";
import type { RecallValidClaimSource } from "../../../src/application/ports/recall-read-port.js";
import type { RecallGraphTraversalResult } from "../../../src/domain/recall-graph-traversal.js";

declare const source: RecallValidClaimSource;

const searchResult: Promise<RecallGraphTraversalResult> = traverseRecallGraph(source, {
  entry: "surface",
  depth: 2,
  seeds: [{ entityId: "e1.0", display: "로그인" }],
});
const overviewResult: Promise<RecallGraphTraversalResult> = traverseRecallGraph(source, {
  entry: "overview",
  seeds: [{ entityId: "e1.0", display: "ignored" }],
});

void searchResult;
void overviewResult;
void source.readTraversalNeighborhood("e1.0");

// @ts-expect-error search traversal requires an explicit depth from one to three
void traverseRecallGraph(source, { entry: "fts", seeds: [] });

// @ts-expect-error overview is depth zero and must not accept the search depth field
void traverseRecallGraph(source, { entry: "overview", depth: 1, seeds: [] });

// @ts-expect-error traversal seeds are canonical entity IDs plus a display label
void source.readTraversalNeighborhood({ entityId: "e1.0" });
