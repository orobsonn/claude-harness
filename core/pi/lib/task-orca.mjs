/** Orca owns workspace/terminal placement; the harness owns task execution and evidence. Pi binding of core/shared/lib/task-orca.mjs. */
import { taskAdmissionPath } from "./task-contract.mjs";
import {
  isOrcaLocalHostMigration,
  quoteOrcaCommand,
  resolveOrcaTaskBackend as resolveSharedOrcaTaskBackend,
  waitForOrcaTaskTerminalExit as waitForSharedOrcaTaskTerminalExit,
} from "../../shared/lib/task-orca.mjs";

export { taskWorktreeName } from "../../shared/lib/task-contract.mjs";
export { isOrcaLocalHostMigration, quoteOrcaCommand };

const piOrcaCli = () => process.env.PI_HARNESS_ORCA_CLI || process.env.ORCA_CLI_COMMAND || "orca";

/** Long-poll one host-issued task terminal. Exit is only a wake hint; callers must
 * re-read the task process and receipt before treating the task as complete. */
export function waitForOrcaTaskTerminalExit(options, injected = {}) {
  return waitForSharedOrcaTaskTerminalExit({ ...options, cli: options?.cli ?? piOrcaCli() }, injected);
}

/** Called only for a parent launched inside Orca; a stale inherited pane cannot select another repo. */
export function resolveOrcaTaskBackend(options, injected = {}) {
  return resolveSharedOrcaTaskBackend({ ...options, cli: options?.cli ?? piOrcaCli(), admissionPath: taskAdmissionPath }, injected);
}
