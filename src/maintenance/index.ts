import type { UseCase } from "../application/index.js";

/** Maintenance enters through application operations, never raw SQLite/projector handles. */
export interface MaintenanceApplicationPorts<
  ReplayInput,
  ReplayOutput,
  ReinterpretInput,
  ReinterpretOutput,
> {
  readonly replay: UseCase<ReplayInput, ReplayOutput>;
  readonly reinterpretCandidates: UseCase<ReinterpretInput, ReinterpretOutput>;
}
