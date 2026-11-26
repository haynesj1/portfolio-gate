# portfolio-gate

A merge gate for repositories where AI coding agents open pull requests. It sets one required commit status, `review-gate`, that passes only when:

1. **a reviewer bot has reviewed the current head commit** with no unresolved findings from Codex, and no unresolved P0/P1 finding from any other reviewer (Codex's review summary, or a structured verdict from a Claude reviewer); for `risk:normal` and `risk:checked` PRs, Codex findings that are all answered also count once the owner approves or a ruling says none stands (see below), and
2. the PR's tier allows it:

| Tier (label) | What puts a PR there | What passes it, once reviewed |
|---|---|---|
| `risk:low` | docs, added tests, Dependabot patch bumps, deletion-only dead-code removal, approved copies of shared files; never a PR that touches a `pivotal_paths` or `sensitive_paths` file (see below) | nothing more |
| `risk:agent` | an agent PR that meets every agent-safe rule (opt-in per repo, see below) | nothing more |
| `risk:checked` | an agent PR kept out of `risk:agent` **only** by its size, a `sensitive_paths` file, a deleted file, or a removed or skipped test (see below) | a `check-verdict` of `pass` for the head commit, or `human-approved` on it |
| `risk:normal` | everything else, including any PR that touches a `pivotal_paths` file | the owner's `human-approved` label on this exact commit |

The `.ops.yml` lists (on the default branch) apply before `risk:low` is decided, on both the old and new path of a rename. A PR that changes any `pivotal_paths` file is `risk:normal` whatever the file type, with the reason `pivotal path <name>`. A PR that changes any `sensitive_paths` file is never `risk:low`: it is `risk:checked` or `risk:normal` by the rules below. With no `.ops.yml`, or empty lists, nothing changes. Two cases are decided before the lists are read and are unchanged: approved copies (their content is approved by hash, and every listed copy is a protected path anyway) and Dependabot patch bumps of manifests.

## Answered findings wait for `human-approved`

Codex reports `has_unresolved_findings: true` until a person resolves each of its threads, even when every finding was fixed and answered. The gate therefore has a review state `answered`, used in place of a block only when all of these hold:

- the only reason to block is Codex's own state for the head commit, and that state is completed (`review:blocking`, a blocking or unfinished verdict from another reviewer, or another reviewer bot's P0/P1 line finding on the head commit still blocks);
- Codex has at least one finding thread, and every thread Codex has commented in (any priority, P0 to P3 or none) starts with a Codex comment and has a later comment from the repository owner's account;
- no Codex comment in those threads was first made on the head commit, and no Codex review of the head commit carries a finding badge. A finding Codex raises or repeats on the newest commit always blocks, as does a Codex comment after the owner's last reply.

For a `risk:normal` PR, `answered` reads "risk:normal: waiting for human-approved — reviewer findings answered, not resolved", and the owner's `human-approved` on that commit passes it ("human-approved; reviewer findings answered, not resolved") without resolving each thread. Agents comment with the owner's identity, so a reply proves nothing on its own: `answered` **never applies to `risk:low` or `risk:agent`**, which fail with the unresolved-findings text exactly as before, and it never passes a PR without the owner's approval. `review:override` works as before, and on `codex/` PRs it covers Codex's review only (the Claude second review is unchanged). The gate never resolves or writes to review threads. Thread replies don't trigger the gate themselves; it recomputes on the next review result or label change, such as adding `human-approved`.

## Checked tier (`risk:checked`)

Most of the owner's approvals are on agent PRs that only need someone to confirm they do what their issue asked. A second, independent check can do that, so an agent PR that fails the agent-safe rules **only** for one or more of these reasons is `risk:checked` instead of `risk:normal`:

- it changes more than `agent_max_lines` lines;
- it touches a `sensitive_paths` file;
- it deletes a file;
- it removes or skips a test (the test count falls, a test file is deleted or moved out of test discovery, or a skip is added).

Every other agent-safe rule must still hold: the repo has `agent_safe: true`, the branch is `claude/…` or `codex/…`, the linked issue is open, queued and not `pivotal`, and the PR touches no protected path, no `pivotal_paths` file and no dependency or package-manager file. The reasons are an allowlist in `gate/gate.js` (`CHECKABLE_REASONS`), so any rule added later keeps a PR at `risk:normal` unless it is added there on purpose. Approved copies come first, as before: a PR whose every file is an approved copy is `risk:low`, and one that is not (a near miss, or a copy plus any other file) touches a protected path, so it is `risk:normal`, never `risk:checked`.

The check and the ruling sessions are started outside the gate. They post their verdicts as PR comments, each bound to a commit:

```html
<!-- check-verdict:v1 {"commit_sha":"<head sha>","result":"pass"|"fail"|"unclear"} -->
<!-- ruling-verdict:v1 {"commit_sha":"<head sha>","result":"none-stand"|"stands"|"unclear"} -->
```

A marker counts only when it is in a PR conversation comment (not a review or a line comment) written by the repository owner's account or by `github-actions[bot]`, and names the head commit. **Sessions that write verdicts must make the marker the first line of the comment, alone (at most three leading spaces, nothing after it but spaces or tabs), and must not use its name anywhere else in the comment**; anything else carries no marker. Because nothing can open before the first line, no list, fence, quote, code span or HTML comment can hide or fake a marker there, and the gate needs no Markdown parsing. Prose, lists, code and quotes after the first line are fine. The newest counted verdict wins (an edited comment is as new as its edit); verdicts that disagree at the same time, or that cannot be ordered, read as `unclear`. A marker whose JSON does not parse, or has no `commit_sha`, counts as none; a result outside the listed values reads as `unclear`. A new commit clears every verdict.

The caller evaluates the gate when a comment carrying either marker is posted, edited to remove one, or deleted (so deleting a passing check or a covering ruling withdraws the pass); until an app repository has the updated caller, a verdict there is read at the next PR event instead.

| `risk:checked`, review clean | Status |
|---|---|
| no check verdict for the head | pending: `risk:checked: waiting for the check of this commit — <reason>` |
| `pass` | **success**: `risk:checked: check passed and reviewed — <reason>` |
| `fail` | pending: `risk:checked: check found gaps — <reason>` |
| `unclear` | pending: `risk:checked: check unclear; waiting for human-approved — <reason>` |
| `human-approved` on the head, any verdict | **success**, as for `risk:normal` |

`<reason>` lists every rule that put the PR in the tier (shortened to fit 140 characters), and the job summary repeats it as `in risk:checked because: …`, with the check and ruling it read. "Review clean" means the same as for `risk:agent`: the review of the head commit is clear, or the owner overruled findings with `review:override`; or, from this tier, answered findings that a ruling settled (below). A Codex PR still needs its Claude second review.

**Off switch:** `checked_tier: false` in `.ops.yml` on the default branch turns the tier off for that repository; such PRs are `risk:normal` exactly as before. Absent means on, but only where `agent_safe: true`. Any other value (`no`, `"false"`, …) is unreadable and, like every unreadable line, switches the agent-safe tier off too. `.ops.yml` is read from the default branch only and is a protected path, so a PR cannot turn the tier on for itself.

### Rulings on answered findings

Where the gate would say "waiting for human-approved — reviewer findings answered, not resolved" (`risk:normal`, and now `risk:checked`), a `none-stand` ruling for the head commit lets the PR proceed by its own tier: a `risk:checked` PR goes on to its check, and a `risk:normal` PR waits for `human-approved` on its tier alone. `unclear`, or no ruling, keeps that behaviour. `stands` fails the PR (`Ruling for this commit: a reviewer finding stands`), in every tier, until a new commit: a later ruling for the same commit does not replace it, and neither `human-approved` nor `review:override` overrules it. Answered findings on `risk:low` and `risk:agent` PRs fail as before, with or without a ruling.

A ruling **covers** the findings only if it was written after every Codex line comment on the PR (any thread, any commit) and after every Codex review of the head commit that carries a finding badge; a comment or ruling without a readable time is never covered. A Codex finding raised on the head commit still blocks unless a covering ruling exists, and even then its thread needs the owner's reply after Codex's last comment, like every answered thread. Other reviewers' P0/P1 findings, a blocking verdict and `review:blocking` are never covered.

### Residual risk (the owner's decision)

The gate ignores verdicts that the owner's account writes on its own review (`review-verdict`), because agents act with that account and could write their own pass; that is unchanged. For the two markers above, and only for them, a verdict from the owner's account **is** accepted. So an agent could write a `pass` or `none-stand` for its own PR and merge a `risk:checked` PR without a real check. The gate cannot tell; the proof that each check was started independently is kept outside the gate, by an audit of each such merge. This is residual risk of the same kind the agent-safe tier already accepts (agents can also set issue labels such as `ready`). The size, path, issue and test rules that remain, the bot review of the head commit, and the audit are the controls. A repository that does not accept this sets `checked_tier: false`.

## Codex-written PRs need a second review

Codex reviews every PR, so a PR on a `codex/` branch also needs a Claude `review-verdict:v1` for its head commit (`clear` to pass; `blocking` fails unless the owner adds `review:override`; if no Claude review arrives, the owner's `human-approved` on that commit stands in for it). The portfolio-ops dispatcher starts a Claude review session for each such PR. Those sessions post through the owner's account, so on `codex/` PRs only, an owner-account verdict counts as well as one from `claude[bot]`.

Because agents act as the owner, a forged verdict is possible. It can only reduce a Codex PR to Codex-only review, which was the position before this rule. Codex's own clean review is still required, and owner-account verdicts never count on any other PR (portfolio-ops decision 0006).

## Agent-safe tier (`risk:agent`)

Off unless the repo's `.ops.yml` **on the default branch** says `agent_safe: true` (the gate never reads the PR's copy, and `.ops.yml` is a protected path). A PR is agent-safe only if all of these hold:

- its branch is `claude/…` or `codex/…`, and it implements a linked issue (`claude/<n>`, `codex/<n>`, or `Closes #n`) that is open, queued (`ready` or `in-progress`) and **not** labelled `pivotal`;
- it touches no protected path, no dependency manifest, nothing under `sensitive_paths` or `pivotal_paths` from `.ops.yml`, and deletes no file (a rename is checked on both its old and new path);
- the number of tests or assertions does not fall, and no test is skipped. Test-declaring and asserting lines are counted separately, removed against added, across the whole PR, so an edited, renamed or moved test is fine; a deleted test file, or one moved out of test discovery, still fails. Added lines count in full only in files a runner finds by name (such as `*.test.ts`, `test_*.py`, `*_test.go`), and not when they are comments; in any other file they can only offset removed lines of that same file. Lines in Markdown files outside test folders are not counted at all (a repo that runs tests from Markdown, such as doctests, should not rely on this tier for Markdown changes);
- it changes at most `agent_max_lines` lines (default 400);
- a reviewer bot has cleared the head commit, as for every tier. CI checks are required separately by the repo's ruleset.

A PR that fails only the size, `sensitive_paths`, deleted-file or test rules is `risk:checked` (see [Checked tier](#checked-tier-riskchecked)) unless `.ops.yml` says `checked_tier: false`.

```yaml
# .ops.yml (example)
agent_safe: true
agent_max_lines: 400
checked_tier: true     # default; false makes the PRs below risk:normal again
sensitive_paths:       # risk:checked: need a passing check, or human-approved
  - "src/auth/**"
  - db/migrations/
pivotal_paths:         # core-journey UI that the owner wants to see first
  - "src/routes/reveal/**"
```

When a PR is `risk:normal`, the `review-gate` status description ends with ` — <reason>`, the one rule that kept it out of `risk:agent` (shortened to fit GitHub's 140-character limit), and the job summary repeats it as `kept out of risk:agent by: <reason>`.

Policy parsing fails closed: blank lines and comments inside a path list are skipped, and any line the gate can't read switches the tier off for that repo (everything is `risk:normal`).

Because the tier depends on the linked issue, the caller also listens to `issues` events (closed, reopened, or a `ready` / `in-progress` / `pivotal` label change) and re-evaluates the open PRs that implement that issue. Marking an issue `pivotal` therefore withdraws an earlier agent-safe pass at once. Runs for the same PR can overlap (PR, comment and issue events use different concurrency groups), so any run that publishes a pass re-gathers every input from GitHub afterwards and decides again, republishing if the answer changed. The last writer has therefore always read every input after the last change. A change to `.ops.yml` on the default branch re-evaluates every open PR under the new policy, agent or not, since `pivotal_paths` and `sensitive_paths` apply to every PR: the caller has one narrow `push` trigger (default branch, `.ops.yml` only). That is one gate run per such push, which evaluates the open PRs in turn; no other push starts it. Default-branch pushes only happen by merging a reviewed PR, so this runs trusted code. A push to any other branch runs that branch's own workflow files whatever the default caller says, so the trigger adds no new exposure. A test pins the trigger to exactly that shape. Merge this repo's gate change **before** syncing the caller to app repos, or the older gate will fail on issue events.

Residual risk, accepted in portfolio-ops decision 0005: agents act with the owner's identity, so they can set issue labels such as `ready` or remove `pivotal`. The path, size and test rules and the review are the real controls; the daily merge audit and the dashboard's auto-merge digest catch the rest.

## Approved copies

The caller workflow and shared blocks of instruction files are rolled out to every repository that uses the gate, one PR per repository, each touching a protected path. A PR whose **every** changed file is an approved copy is `risk:low` (reason `approved copy of <path>`), so the owner approves the content once, here, instead of once per repository. The review of the head commit is still required, as for any `risk:low` PR.

The list is [`gate/approved-copies.json`](gate/approved-copies.json), embedded into the generated workflow by `npm run build` (the gate never reads it from the PR or fetches it at run time):

- `files`: `{ "path", "sha256": [...] }`. The whole file at the PR's head commit must hash to a listed value. The build adds the hash of this repository's own `caller/pr-gate.yml` to the entry for `.github/workflows/pr-gate.yml`, so the current caller is always approved.
- `blocks`: `{ "path", "start", "end", "sha256": [...] }`. The text from the start marker to the end marker inclusive must hash to a listed value; the file must exist on the base with exactly one start and one end marker at both base and head, and everything outside the block must be byte-identical to the base copy. The one block entry is the shared block of `AGENTS.md` (between `<!-- portfolio-ops:common:start -->` and `<!-- portfolio-ops:common:end -->`); a new version of that block needs its hash added here first, and the old hash stays listed until every repository has the new text.

A copy must be added or modified (never removed or renamed), and the gate reads each listed file at the head SHA (and, for blocks, the base SHA) only when every changed file is a listed path. A failed read, a file over the contents API's 1 MB limit, a symlink, invalid UTF-8, a path listed twice, or any other doubt means "not an approved copy", and the existing rules apply (a protected path stays `risk:normal`). Other hashes are added by hand in a PR to this repository; `.github/` is protected here, so the rebuilt workflow needs the owner's approval. That is the one approval.

Hashes are SHA-256 of the UTF-8 text with line endings normalised to `\n`. From this repository:

```bash
node -p "require('./gate/gate').copyHash(require('fs').readFileSync('path/to/file', 'utf8'))"
```

**Off switch:** with no entries (`{ "files": [], "blocks": [] }`, so no caller entry either) the gate reads nothing and behaves exactly as it did before approved copies.

## Why it looks the way it does

The agents act with the owner's GitHub identity: they can push, comment, label and post commit statuses as the owner. So the gate trusts only evidence an agent can't forge:

| Evidence | Why it's trusted |
|---|---|
| `review-gate` status | Rulesets require it **from the GitHub Actions app**; a status posted with the owner's token doesn't count |
| The gate's own code | App repos call it only from `pull_request_target` / `issue_comment`, which run the default-branch copy, so a PR can't change the gate judging it |
| Review verdicts | Structured, bound to the head SHA, and posted by known bot accounts |
| Check and ruling verdicts | Structured and bound to the head SHA, but accepted from the owner's account: **not** forgery-proof; each merge they allow is audited outside the gate (see the checked tier) |
| Approval timing | The label event must be by the owner directly (not `performed_via_github_app`) and later than the gate's first recorded run for this PR and SHA, and than any force push |

Reviewers can be wrong, so the owner can overrule blocking findings for the current commit with `review:override` (same rules as approval).

Known residual risk: agent apps with the Workflows permission could add a workflow that writes an Actions-attributed status. Mitigated by tool permissions, provenance links on every status, and a daily audit of merged PRs.

The caller skips two kinds of pull request event that cannot change the gate's answer, so no runner starts (a skipped job uses no Actions minutes). A label change is skipped unless the label is `human-approved`, `review:override`, `review:blocking`, `type:dead-code`, `risk:low`, `risk:agent`, `risk:checked` or `risk:normal`; adding and removing are treated alike, and a label event with no label name evaluates. An edit is skipped only when it changed the title and nothing else (no body, no base branch) and the author is not Dependabot, whose title the gate reads. Every other edit and every other PR action evaluates.

## Use

Copy [`caller/pr-gate.yml`](caller/pr-gate.yml) to `.github/workflows/pr-gate.yml`, then require the `review-gate` status (source: GitHub Actions) in a ruleset.

## Develop

Changes here go through this repo's own `review-gate`, so **Codex automatic review must stay on for this repository** (Codex settings → Code review → every push). Without it, gate PRs wait for a review that never comes.


```bash
npm test   # builds .github/workflows/gate.yml from gate/ and runs unit + workflow-harness tests
```

`gate/gate.js` is pure decision logic. `gate/workflow.test.js` runs the generated workflow script against a mocked GitHub API.
