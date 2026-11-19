/**
 * The load engine's entry point, bundled as `dist/load.js`. Nothing the action's modes run
 * imports it (test/architecture.test.ts); in this release only the tests start it, and
 * `mode: load` refuses before any of it could load (main.ts).
 *
 *   const handle = startEngine({ plan, limits }, controlPort, { repositoryRoot });
 *   const result = await handle.done;
 *
 * The input is checked in full first (`plan-input.ts`); a refused input never starts a
 * process.
 */
import type { ControlPort } from "./control-port";
import { validatePlanInput } from "./plan-input";
import { Supervisor, type EngineOptions, type EngineResult } from "./supervisor";

export type { ControlPort, LeaseAnswer, LeaseRequest, Marker } from "./control-port";
export type { EngineEvent, EngineOptions, EngineResult } from "./supervisor";
export { validatePlanInput } from "./plan-input";

export interface EngineHandle {
  done: Promise<EngineResult>;
  stop(mode: "graceful" | "now"): void;
}

export class PlanInputRefused extends Error {
  constructor(readonly errors: string[]) {
    super(`the load plan was refused: ${errors.join("; ")}`);
    this.name = "PlanInputRefused";
  }
}

export function startEngine(planInput: unknown, controlPort: ControlPort, options: EngineOptions): EngineHandle {
  const checked = validatePlanInput(planInput);
  if (!checked.ok) throw new PlanInputRefused(checked.errors);
  const supervisor = new Supervisor(checked.value, controlPort, options);
  void supervisor.start();
  return { done: supervisor.done, stop: (mode) => supervisor.stop(mode) };
}

export function runEngine(planInput: unknown, controlPort: ControlPort, options: EngineOptions): Promise<EngineResult> {
  return startEngine(planInput, controlPort, options).done;
}
