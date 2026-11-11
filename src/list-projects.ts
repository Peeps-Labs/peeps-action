/**
 * A second reporter on the action's own `--list` run: each project's `dependencies` and
 * `teardown`, which Playwright's JSON report leaves out of `config.projects`. Server evidence
 * needs them to keep a setup or teardown project's files out of runs of their own
 * (PQA-3201 PR 3). Bundled to `dist/list-projects.js`; dependency-free.
 */
import { writeFileSync } from "node:fs";
import type { FullConfig, Reporter } from "@playwright/test/reporter";

export default class ListProjects implements Reporter {
  onBegin(config: FullConfig): void {
    const file = process.env.PEEPS_PROJECTS_FILE;
    if (!file) return;
    const projects = config.projects.map((project) => ({ name: project.name, dependencies: project.dependencies, teardown: project.teardown }));
    writeFileSync(file, JSON.stringify(projects), { mode: 0o600 });
  }

  printsToStdio(): boolean {
    return false;
  }
}
