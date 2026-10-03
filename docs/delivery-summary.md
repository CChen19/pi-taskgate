# Delivery evidence and plan-coverage summary

`task_status` appends a read-only `DELIVERY SUMMARY` block and returns the same
data structured in `details.delivery`. It is derived by
`src/orchestration/delivery-summary.ts` from already-persisted board state and
the existing DELIVERABLE selection. Queries never mutate the board, never call
the host, and never change which revision is delivered; repeated queries over
the same board return equal results.

## Behavior table

| Aspect | Source | Behavior |
| --- | --- | --- |
| Revision acceptance (DELIVERABLE) | `task-service.ts` `deliverable()` | Unchanged: the most recently planned PASSED integration, else the single non-integration task's PASSED revision, else none with a reason. The summary reports on that selection; it never alters it. |
| Delivery evidence — verification | the deliverable task's current attempt | Shown only when the attempt's own evidence bundle is bound to the exact delivered revision (`taskId`, `attemptId`, and `artifactRevision` all match) and the settled candidate is that revision: verdict plus each command's exit code (bounded, `+N more`). A missing or mismatched bundle is `unknown` / `not available` — never passed, never fabricated. Evidence naming another revision is reported as a mismatch naming that revision. |
| Delivery evidence — review | `reviewRequired` + the attempt's review record | Explicit `review_required: false` is shown as `not required` and is never presented as a review pass. A recorded review that is bound to the delivered revision shows its outcome with reviewer agent id and review id; otherwise it is `awaiting`, `not available`, or a `revision-mismatch`. |
| Integration inputs | the recorded integration spec | Each input lists `taskId@revision`, plus `stacked on <task>` when its recorded `baseRevision` equals an earlier input's revision. Inputs from another session carry their evidence source. A base revision that is neither the integration base nor a recorded input is flagged conservatively. |
| Plan coverage | all current non-integration tasks (every state) | A task counts as included only when the deliverable integration records an input with that task id AND its exact accepted revision (a single-task deliverable includes itself). Everything else is omitted with its state: pending, ready, running, verifying, retrying, blocked, failed, cancelled, and passed-but-not-included. Failed tasks carry their failure reason. |
| Cancelled tasks | `cancel` events | Cancelled tasks are explained with their cancellation reason and produce a note; the plan is never declared complete while they are omitted. |
| Conservative handling | legacy / cross-session events | Inputs without a matching board task, id-with-different-revision matches, and missing base revisions become notes instead of inclusion; coverage only claims `complete` when a deliverable exists and nothing is omitted. |
| Output bounds | — | Human text and structured listings are capped (8 entries, `+N more` computed from full counts); structured `inputs` stay complete. |
| `task_status` filtering | `task_id` parameter | Only the per-task list shrinks. The DELIVERABLE line, delivery evidence, and coverage stay global, so filtering cannot falsely shrink coverage. |

## Regressions

`tests/delivery-summary.test.ts` drives boards through persisted events only
(no git, hosts, network, or models): empty board, no deliverable, reviewed and
unreviewed single task, complete and partial integration, later-added
unfinished tasks, failed and cancelled tasks, identity/revision mismatch,
stacked inputs, missing or mismatched evidence, bounded listings, and
read-only repeated queries. The legacy `Deliverable` contract
(`taskId`/`revision`/`reason`/`notIncluded`) is unchanged and covered by the
same tests.
