import type { RecallValidClaimSource } from "./ports/recall-read-port.js";
import {
  RecallGraphTraversalError,
  compareRecallTraversalClaims,
  truncateRecallSeedDisplay,
  validateRecallGraphTraversalInput,
  validateRecallTraversalNeighborhood,
  type RecallGraphTraversalInput,
  type RecallGraphTraversalResult,
  type RecallReachedClaim,
  type RecallTraversalClaimReference,
  type RecallTraversalParent,
} from "../domain/recall-graph-traversal.js";

const FANOUT_LIMIT = 30;

interface ParentState {
  readonly entityId: string;
  entityName: string | null;
  readonly parentId: string | null;
  readonly viaClaimId: string | null;
  readonly depth: number;
  readonly seedOrder: number;
  readonly discoveryOrder: number;
}

interface ReachedState {
  readonly claim: RecallTraversalClaimReference;
  readonly depth: number;
  readonly seedOrder: number;
  readonly anchorId: string;
  readonly discoveryOrder: number;
}

interface TraversalReaderBinding {
  readonly receiver: object;
  readonly read: (entityId: string) => unknown;
}

function invalidState(): never {
  throw new RecallGraphTraversalError("INVALID_TRAVERSAL_STATE");
}

function bindTraversalReader(source: unknown): TraversalReaderBinding {
  try {
    if (source === null || typeof source !== "object") {
      return invalidState();
    }
    const read: unknown = Reflect.get(source, "readTraversalNeighborhood");
    if (typeof read !== "function") {
      return invalidState();
    }
    return Object.freeze({
      receiver: source,
      read: read as TraversalReaderBinding["read"],
    });
  } catch {
    return invalidState();
  }
}

function claimSignature(reference: RecallTraversalClaimReference): string {
  return JSON.stringify([
    reference.claimId,
    reference.subjectId,
    reference.subjectName,
    reference.objectId,
    reference.objectName,
    reference.supportCount,
    reference.strongestRank,
    reference.lastSeenAt,
    reference.originSeq,
  ]);
}

function entityNameFor(
  reference: RecallTraversalClaimReference,
  entityId: string,
): string {
  if (reference.subjectId === entityId) {
    return reference.subjectName;
  }
  if (reference.objectId === entityId && reference.objectName !== null) {
    return reference.objectName;
  }
  return invalidState();
}

function compareReached(left: ReachedState, right: ReachedState): number {
  return (
    left.depth - right.depth ||
    left.seedOrder - right.seedOrder ||
    compareRecallTraversalClaims(left.claim, right.claim) ||
    left.discoveryOrder - right.discoveryOrder
  );
}

function earlierReached(left: ReachedState, right: ReachedState): boolean {
  return (
    left.depth < right.depth ||
    (left.depth === right.depth && left.seedOrder < right.seedOrder)
  );
}

function pathFor(
  state: ReachedState,
  parents: ReadonlyMap<string, ParentState>,
  entry: "surface" | "fts" | "overview",
  seedDisplayByOrder: ReadonlyMap<number, string>,
): RecallReachedClaim {
  const chain: ParentState[] = [];
  const seen = new Set<string>();
  let cursor: string | null = state.anchorId;
  while (cursor !== null) {
    if (seen.has(cursor)) {
      return invalidState();
    }
    seen.add(cursor);
    const parent = parents.get(cursor);
    if (parent === undefined || parent.entityName === null) {
      return invalidState();
    }
    chain.push(parent);
    cursor = parent.parentId;
  }
  chain.reverse();
  if (chain.length === 0) {
    return invalidState();
  }
  const first = chain[0];
  if (first === undefined || first.parentId !== null) {
    return invalidState();
  }
  const firstName = first.entityName;
  if (firstName === null) {
    return invalidState();
  }
  const pathParts = chain.map((parent) => parent.entityName ?? "");
  const rawDisplay = seedDisplayByOrder.get(state.seedOrder);
  if (rawDisplay === undefined) {
    return invalidState();
  }
  if (entry === "fts") {
    pathParts.unshift(truncateRecallSeedDisplay(`${rawDisplay} (FTS)`));
  } else if (entry === "surface" && rawDisplay !== firstName) {
    pathParts.unshift(truncateRecallSeedDisplay(rawDisplay));
  }

  let hops = Math.max(0, chain.length - 1);
  if (state.claim.objectId !== null) {
    const anchor = chain[chain.length - 1];
    if (anchor === undefined || anchor.entityId !== state.anchorId) {
      return invalidState();
    }
    let oppositeId: string;
    if (state.claim.subjectId === state.anchorId) {
      oppositeId = state.claim.objectId;
    } else if (state.claim.objectId === state.anchorId) {
      oppositeId = state.claim.subjectId;
    } else {
      return invalidState();
    }
    if (
      oppositeId !== state.anchorId &&
      anchor.viaClaimId !== state.claim.claimId
    ) {
      pathParts.push(entityNameFor(state.claim, oppositeId));
      hops += 1;
    }
  }
  if (hops > 4) {
    return invalidState();
  }
  return Object.freeze({
    claimId: state.claim.claimId,
    depth: state.depth,
    seedOrder: state.seedOrder,
    anchorId: state.anchorId,
    path: pathParts.join(" → "),
    hops,
  });
}

/**
 * Expands only through the typed request-local recall capability. Ranking,
 * formatting, public Answer assembly, and note composition remain downstream.
 */
export async function traverseRecallGraph(
  source: RecallValidClaimSource,
  suppliedInput: RecallGraphTraversalInput,
): Promise<RecallGraphTraversalResult> {
  const input = validateRecallGraphTraversalInput(suppliedInput);
  const traversalReader = bindTraversalReader(source);

  const parents = new Map<string, ParentState>();
  const seedDisplayByOrder = new Map<number, string>();
  let discoveryOrder = 0;
  for (let seedOrder = 0; seedOrder < input.seeds.length; seedOrder += 1) {
    const seed = input.seeds[seedOrder];
    if (seed === undefined || parents.has(seed.entityId)) {
      continue;
    }
    seedDisplayByOrder.set(seedOrder, seed.display);
    parents.set(seed.entityId, {
      entityId: seed.entityId,
      entityName: null,
      parentId: null,
      viaClaimId: null,
      depth: 0,
      seedOrder,
      discoveryOrder,
    });
    discoveryOrder += 1;
  }

  const reached = new Map<string, ReachedState>();
  const claimSignatures = new Map<string, string>();
  let reachedOrder = 0;
  let linksTruncated = false;
  let incidentsTruncated = false;
  let frontier = [...parents.values()];

  for (let currentDepth = 0; currentDepth <= input.depth; currentDepth += 1) {
    const nextFrontier: ParentState[] = [];
    for (const current of frontier) {
      let neighborhood;
      try {
        neighborhood = validateRecallTraversalNeighborhood(
          await Reflect.apply(
            traversalReader.read,
            traversalReader.receiver,
            [current.entityId],
          ),
          current.entityId,
        );
      } catch {
        return invalidState();
      }
      if (
        current.entityName !== null &&
        current.entityName !== neighborhood.entity.entityName
      ) {
        return invalidState();
      }
      current.entityName = neighborhood.entity.entityName;

      if (neighborhood.links.length > FANOUT_LIMIT) {
        linksTruncated = true;
      }
      if (neighborhood.incidents.length > FANOUT_LIMIT) {
        incidentsTruncated = true;
      }
      for (const claim of neighborhood.incidents.slice(0, FANOUT_LIMIT)) {
        const signature = claimSignature(claim);
        const previousSignature = claimSignatures.get(claim.claimId);
        if (previousSignature !== undefined && previousSignature !== signature) {
          return invalidState();
        }
        claimSignatures.set(claim.claimId, signature);
        const candidate: ReachedState = {
          claim,
          depth: currentDepth,
          seedOrder: current.seedOrder,
          anchorId: current.entityId,
          discoveryOrder: reachedOrder,
        };
        reachedOrder += 1;
        const previous = reached.get(claim.claimId);
        if (previous === undefined || earlierReached(candidate, previous)) {
          reached.set(claim.claimId, candidate);
        }
      }

      if (currentDepth === input.depth) {
        continue;
      }
      for (const link of neighborhood.links.slice(0, FANOUT_LIMIT)) {
        const signature = claimSignature(link);
        const previousSignature = claimSignatures.get(link.claimId);
        if (previousSignature !== undefined && previousSignature !== signature) {
          return invalidState();
        }
        claimSignatures.set(link.claimId, signature);
        const otherName = entityNameFor(link, link.toId);
        const existing = parents.get(link.toId);
        if (existing !== undefined) {
          if (existing.entityName !== null && existing.entityName !== otherName) {
            return invalidState();
          }
          if (existing.entityName === null) {
            existing.entityName = otherName;
          }
          continue;
        }
        const discovered: ParentState = {
          entityId: link.toId,
          entityName: otherName,
          parentId: current.entityId,
          viaClaimId: link.claimId,
          depth: currentDepth + 1,
          seedOrder: current.seedOrder,
          discoveryOrder,
        };
        discoveryOrder += 1;
        parents.set(link.toId, discovered);
        nextFrontier.push(discovered);
      }
    }
    frontier = nextFrontier;
    if (frontier.length === 0) {
      break;
    }
  }

  const parentResult: RecallTraversalParent[] = [...parents.values()]
    .sort(
      (left, right) =>
        left.depth - right.depth ||
        left.seedOrder - right.seedOrder ||
        left.discoveryOrder - right.discoveryOrder,
    )
    .map((parent) => {
      if (parent.entityName === null) {
        return invalidState();
      }
      return Object.freeze({
        entityId: parent.entityId,
        entityName: parent.entityName,
        parentId: parent.parentId,
        viaClaimId: parent.viaClaimId,
        depth: parent.depth,
        seedOrder: parent.seedOrder,
      });
    });
  const reachedResult = [...reached.values()]
    .sort(compareReached)
    .map((state) => pathFor(state, parents, input.entry, seedDisplayByOrder));
  return Object.freeze({
    parents: Object.freeze(parentResult),
    reached: Object.freeze(reachedResult),
    truncation: Object.freeze({
      links: linksTruncated,
      incidents: incidentsTruncated,
    }),
  });
}

export { RecallGraphTraversalError } from "../domain/recall-graph-traversal.js";
