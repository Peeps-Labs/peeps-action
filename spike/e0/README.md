# E0 spike (throwaway)

Checks, on GitHub-hosted `ubuntu-22.04` and `ubuntu-24.04`, the runner facts the load engine plan v3 (§9) depends on: sudo, systemd-run, `use_pty`, the jail's mounts and uid drop, teardown through the cgroup, the unit-wide socket-family filter, the overlay install and the clock setup.

Run by `.github/workflows/load-e0.yml`. Every check prints `ROW <name> <value>`; the job summary collects them. This folder and the workflow are deleted before the engine's E4 PR merges.
