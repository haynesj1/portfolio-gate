# portfolio-gate

A merge gate for repositories where AI coding agents open pull requests. It sets one required commit status, `review-gate`, that passes only when:

1. **a reviewer bot has reviewed the current head commit** with no unresolved findings from Codex, and no unresolved P0/P1 finding from any other reviewer (Codex's review summary, or a structured verdict from a Claude reviewer); for `risk:normal` PRs, Codex findings that are all answered also count once the owner approves (see below), and
2. one of:
   - **the change is low risk** (`risk:low`: docs, added tests, Dependabot patch bumps, deletion-only dead-code removal);
   - **the change is agent-safe** (`risk:agent`, opt-in per repo, see below);
   - **the repository owner has approved this exact commit** with the `human-approved` label (`risk:normal`).

## Answered findings wait for `human-approved`

Codex reports `has_unresolved_findings: true` until a person resolves each of its threads, even when every finding was fixed and answered. The gate therefore has a review state `answered`, used in place of a block only when all of these hold:

- the only reason to block is Codex's own state for the head commit, and that state is completed (`review:blocking`, a blocking or unfinished verdict from another reviewer, or another reviewer bot's P0/P1 line finding on the head commit still blocks);
- Codex has at least one finding thread, and every thread Codex has commented in (any priority, P0 to P3 or none) starts with a Codex comment and has a later comment from the repository owner's account;
- no Codex comment in those threads was first made on the head commit, and no Codex review of the head commit carries a finding badge. A finding Codex raises or repeats on the newest commit always blocks, as does a Codex comment after the owner's last reply.

For a `risk:normal` PR, `answered` reads "risk:normal: waiting for human-approved — reviewer findings answered, not resolved", and the owner's `human-approved` on that commit passes it ("human-approved; reviewer findings answered, not resolved") without resolving each thread. Agents comment with the owner's identity, so a reply proves nothing on its own: `answered` **never applies to `risk:low` or `risk:agent`**, which fail with the unresolved-findings text exactly as before, and it never passes a PR without the owner's approval. `review:override` works as before, and on `codex/` PRs it covers Codex's review only (the Claude second review is unchanged). The gate never resolves or writes to review threads. Thread replies don't trigger the gate themselves; it recomputes on the next review result or label change, such as adding `human-approved`.

## Codex-written PRs need a second review

Codex reviews every PR, so a PR on a `codex/` branch also needs a Claude `review-verdict:v1` for its head commit (`clear` to pass; `blocking` fails unless the owner adds `review:override`; if no Claude review arrives, the owner's `human-approved` on that commit stands in for it). The portfolio-ops dispatcher starts a Claude review session for each such PR. Those sessions post through the owner's account, so on `codex/` PRs only, an owner-account verdict counts as well as one from `claude[bot]`.

Because agents act as the owner, a forged verdict is possible. It can only reduce a Codex PR to Codex-only review, which was the position before this rule. Codex's own clean review is still required, and owner-account verdicts never count on any other PR (portfolio-ops decision 0006).

## Agent-safe tier (`risk:agent`)

Off unless the repo's `.ops.yml` **on the default branch** says `agent_safe: true` (the gate never reads the PR's copy, and `.ops.yml` is a protected path). A PR is agent-safe only if all of these hold:

- its branch is `claude/…` or `codex/…`, and it implements a linked issue (`claude/<n>`, `codex/<n>`, or `Closes #n`) that is open, queued (`ready` or `in-progress`) and **not** labelled `pivotal`;
- it touches no protected path, no dependency manifest, nothing under `sensitive_paths` or `pivotal_paths` from `.ops.yml`, and deletes no file (a rename is checked on both its old and new path);
- it deletes or skips no test or assertion (lines removed from Markdown files outside test folders are not counted; a repo that runs tests from Markdown, such as doctests, should not rely on this tier for Markdown changes);
- it changes at most `agent_max_lines` lines (default 400);
- a reviewer bot has cleared the head commit, as for every tier. CI checks are required separately by the repo's ruleset.

```yaml
# .ops.yml (example)
agent_safe: true
agent_max_lines: 400
sensitive_paths:       # always need human-approved
  - "src/auth/**"
  - db/migrations/
pivotal_paths:         # core-journey UI that the owner wants to see first
  - "src/routes/reveal/**"
```

When a PR is `risk:normal`, the `review-gate` status description ends with ` — <reason>`, the one rule that kept it out of `risk:agent` (shortened to fit GitHub's 140-character limit), and the job summary repeats it as `kept out of risk:agent by: <reason>`.

Policy parsing fails closed: blank lines and comments inside a path list are skipped, and any line the gate can't read switches the tier off for that repo (everything is `risk:normal`).

Because the tier depends on the linked issue, the caller also listens to `issues` events (closed, reopened, or a `ready` / `in-progress` / `pivotal` label change) and re-evaluates the open PRs that implement that issue. Marking an issue `pivotal` therefore withdraws an earlier agent-safe pass at once. Runs for the same PR can overlap (PR, comment and issue events use different concurrency groups), so any run that publishes a pass re-gathers every input from GitHub afterwards and decides again, republishing if the answer changed. The last writer has therefore always read every input after the last change. A change to `.ops.yml` on the default branch re-evaluates every open agent PR under the new policy: the caller has one narrow `push` trigger (default branch, `.ops.yml` only). Default-branch pushes only happen by merging a reviewed PR, so this runs trusted code. A push to any other branch runs that branch's own workflow files whatever the default caller says, so the trigger adds no new exposure. A test pins the trigger to exactly that shape. Merge this repo's gate change **before** syncing the caller to app repos, or the older gate will fail on issue events.

Residual risk, accepted in portfolio-ops decision 0005: agents act with the owner's identity, so they can set issue labels such as `ready` or remove `pivotal`. The path, size and test rules and the review are the real controls; the daily merge audit and the dashboard's auto-merge digest catch the rest.

## Why it looks the way it does

The agents act with the owner's GitHub identity: they can push, comment, label and post commit statuses as the owner. So the gate trusts only evidence an agent can't forge:

| Evidence | Why it's trusted |
|---|---|
| `review-gate` status | Rulesets require it **from the GitHub Actions app**; a status posted with the owner's token doesn't count |
| The gate's own code | App repos call it only from `pull_request_target` / `issue_comment`, which run the default-branch copy, so a PR can't change the gate judging it |
| Review verdicts | Structured, bound to the head SHA, and posted by known bot accounts |
| Approval timing | The label event must be by the owner directly (not `performed_via_github_app`) and later than the gate's first recorded run for this PR and SHA, and than any force push |

Reviewers can be wrong, so the owner can overrule blocking findings for the current commit with `review:override` (same rules as approval).

Known residual risk: agent apps with the Workflows permission could add a workflow that writes an Actions-attributed status. Mitigated by tool permissions, provenance links on every status, and a daily audit of merged PRs.

The caller skips two kinds of pull request event that cannot change the gate's answer, so no runner starts (a skipped job uses no Actions minutes). A label change is skipped unless the label is `human-approved`, `review:override`, `review:blocking`, `type:dead-code`, `risk:low`, `risk:agent` or `risk:normal`; adding and removing are treated alike, and a label event with no label name evaluates. An edit is skipped only when it changed the title and nothing else (no body, no base branch) and the author is not Dependabot, whose title the gate reads. Every other edit and every other PR action evaluates.

## Use

Copy [`caller/pr-gate.yml`](caller/pr-gate.yml) to `.github/workflows/pr-gate.yml`, then require the `review-gate` status (source: GitHub Actions) in a ruleset.

## Develop

Changes here go through this repo's own `review-gate`, so **Codex automatic review must stay on for this repository** (Codex settings → Code review → every push). Without it, gate PRs wait for a review that never comes.


```bash
npm test   # builds .github/workflows/gate.yml from gate/ and runs unit + workflow-harness tests
```

`gate/gate.js` is pure decision logic. `gate/workflow.test.js` runs the generated workflow script against a mocked GitHub API.
