# Production-readiness checklist (v1 definition of done)

Verbatim from `VELERO_FLEET_PLAN.md` §17 (lines 819–834), tracked from day 1 so
nothing is discovered late. A box is ticked only when the stated verification has
actually run and passed — PLAN.md §0 rule 7.

|     | Item                                                                                           | Verified by                                         | Status                                              |
| --- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------- |
| 1   | All 12 e2e golden paths pass on `VELERO_PRIMARY` and the oldest supported minor                | `make e2e` matrix (M8 day 44)                       | ☐ not started                                       |
| 2   | No stubbed/mocked production code paths; `Deferred` list in PROGRESS.md reviewed               | manual review at each milestone exit                | ☐ in progress — Deferred list maintained from day 1 |
| 3   | Org isolation tests cover 100% of OpenAPI operations                                           | generated security suite (M7 day 37)                | ☐ not started                                       |
| 4   | Namespace-scope authorization has ≥ 50 table-driven test cases, all passing                    | `server` unit tests (M1 day 8)                      | ☐ not started                                       |
| 5   | Credentials grep test passes (DB dump, all logs, audit, command payloads)                      | grep test (M4 day 27)                               | ☐ not started                                       |
| 6   | Agent RBAC exactly matches §12.2, checked by a test that renders the chart and diffs the rules | chart render test (M2 day 15)                       | ☐ not started                                       |
| 7   | Threat model written; each mitigation verified                                                 | `docs/THREAT_MODEL.md` (M7 day 36)                  | ☐ not started                                       |
| 8   | Load test meets §13 targets                                                                    | `tools/fake-agent` + `docs/LOADTEST.md` (M7 day 38) | ☐ not started                                       |
| 9   | Zero high/critical vulnerabilities in deps and images                                          | `pnpm audit`, `govulncheck`, Trivy in CI            | ☐ in progress — audit job wired day 1               |
| 10  | Air-gapped install verified with egress blocked                                                | e2e with egress blocked (M8 day 42)                 | ☐ not started                                       |
| 11  | Upgrade from previous version verified without downtime                                        | upgrade test (M8 day 42)                            | ☐ not started                                       |
| 12  | Docs: README, OPERATIONS, AIRGAP, API, RBAC reference, user guide                              | M8 day 43                                           | ☐ not started                                       |
| 13  | Grafana dashboard + alerts for VFM itself                                                      | M7 day 40                                           | ☐ not started                                       |
| 14  | Restore drill on a real non-kind cluster performed and documented by the human                 | ⛔ human checkpoint, M4 exit                        | ☐ not started                                       |
