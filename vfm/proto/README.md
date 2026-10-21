# Agent protocol contract

`proto/vfm/agent/v1/` is one of the three contracts named in PLAN.md §0 rule 5
(alongside `server/prisma/schema.prisma` and `server/openapi.yaml`). Changing it
is deliberate: edit the `.proto`, run `make gen`, and record the change in
`docs/DECISIONS.md`.

- `buf lint` and `buf breaking` run in CI (PLAN.md §5.7).
- Message definitions land in M2 day 10. The directory is intentionally empty
  until then; `make gen-proto` reports that rather than failing.
- Generated code is committed so a clean checkout builds without `buf`.

Field sets for Velero objects must be derived from the pinned Velero Go types
(`github.com/vmware-tanzu/velero` at v1.18.4) — never invented. See PLAN.md §0
rule 4 and ADR-002.
