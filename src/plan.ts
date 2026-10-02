/**
 * Ask Peeps for the batch this dispatched job runs. Shared by the Playwright
 * and pytest run modes.
 *
 * `null` means Peeps closed the batch before this job asked for it: the run
 * was cancelled in Peeps (or Peeps stopped waiting for the job) while the CI
 * system was still starting the job. There is nothing to run, and Peeps has
 * already recorded every run's outcome, so the job ends successfully instead
 * of failing the pipeline with an error the person who cancelled did not
 * cause.
 */
import { PeepsHttpError, type PeepsClient } from "./peeps";

export async function requestPlan<T>(
  peeps: PeepsClient,
  sessionId: string,
  body: unknown,
): Promise<T | null> {
  try {
    return await peeps.post<T>(`/api/v1/ci/batches/${sessionId}/plan`, body);
  } catch (error) {
    if (error instanceof PeepsHttpError && error.status === 409 && error.code === "batch_closed") {
      console.log(
        "[peeps] Peeps closed this batch before the job started (it was cancelled, or Peeps stopped waiting for the job); nothing to run.",
      );
      return null;
    }
    throw error;
  }
}
