import {
  canonicalProjectionDump,
  freezeJsonCopy,
} from "./canonical-projection.mjs";

export class ReplayParityError extends Error {
  constructor({
    scenarioId,
    prefixLength,
    incrementalChecksum,
    fullReplayChecksum,
    reproduction,
  }) {
    super(
      `Replay parity mismatch for ${scenarioId} at prefix ${prefixLength}: ` +
        `incremental=${incrementalChecksum} full=${fullReplayChecksum}`,
    );
    this.name = "ReplayParityError";
    this.code = "REPLAY_PARITY_MISMATCH";
    this.scenarioId = scenarioId;
    this.prefixLength = prefixLength;
    this.incrementalChecksum = incrementalChecksum;
    this.fullReplayChecksum = fullReplayChecksum;
    this.reproduction = reproduction;
  }
}

function validateArguments({
  scenarioId,
  events,
  context,
  createIncrementalRunner,
  fullReplayRunner,
}) {
  if (typeof scenarioId !== "string" || !/^(?:S\d{2}|[A-Z][A-Z0-9-]*)$/.test(scenarioId)) {
    throw new TypeError("scenarioId must be a stable uppercase identifier");
  }
  if (!Array.isArray(events)) {
    throw new TypeError("events must be an array");
  }
  if (context === null || typeof context !== "object" || typeof context.reproduction !== "function") {
    throw new TypeError("context must provide deterministic reproduction metadata");
  }
  if (typeof createIncrementalRunner !== "function" || typeof fullReplayRunner !== "function") {
    throw new TypeError("incremental and full replay runners are required");
  }
}

export async function runReplayParity(options) {
  validateArguments(options);
  const {
    scenarioId,
    context,
    createIncrementalRunner,
    fullReplayRunner,
  } = options;
  const events = freezeJsonCopy(options.events);
  const runner = await createIncrementalRunner({ context, scenarioId });
  if (
    runner === null ||
    typeof runner !== "object" ||
    typeof runner.apply !== "function" ||
    typeof runner.snapshot !== "function"
  ) {
    throw new TypeError("incremental runner must provide apply and snapshot");
  }

  let primaryFailure;
  try {
    const prefixes = [];
    for (let prefixLength = 0; prefixLength <= events.length; prefixLength += 1) {
      const reproduction = context.reproduction({ scenarioId, prefixLength });
      if (prefixLength > 0) {
        await runner.apply(events[prefixLength - 1], freezeJsonCopy({
          prefix_length: prefixLength,
          reproduction,
        }));
      }
      const incrementalSnapshot = await runner.snapshot(freezeJsonCopy({
        prefix_length: prefixLength,
        reproduction,
      }));
      const prefix = Object.freeze(events.slice(0, prefixLength));
      const fullReplaySnapshot = await fullReplayRunner({
        events: prefix,
        context,
        scenarioId,
        prefixLength,
      });
      const incremental = canonicalProjectionDump(incrementalSnapshot);
      const fullReplay = canonicalProjectionDump(fullReplaySnapshot);

      if (incremental.checksum !== fullReplay.checksum) {
        throw new ReplayParityError({
          scenarioId,
          prefixLength,
          incrementalChecksum: incremental.checksum,
          fullReplayChecksum: fullReplay.checksum,
          reproduction,
        });
      }
      prefixes.push(freezeJsonCopy({
        prefix_length: prefixLength,
        incremental_checksum: incremental.checksum,
        full_replay_checksum: fullReplay.checksum,
        matches: true,
      }));
    }

    return freezeJsonCopy({
      scenario_id: scenarioId,
      prefixes,
      final_checksum: prefixes.at(-1).incremental_checksum,
    });
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    if (typeof runner.dispose === "function") {
      try {
        await runner.dispose();
      } catch (cleanupError) {
        if (primaryFailure === undefined) {
          throw cleanupError;
        }
      }
    }
  }
}
