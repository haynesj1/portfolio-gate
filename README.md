# portfolio-gate

A merge gate for repositories where AI coding agents open pull requests. It sets one required commit status, `review-gate`, that passes only when:

1. **a reviewer bot has reviewed the current head commit** with no unresolved P0/P1 findings (Codex's review summary, or a structured verdict from a Claude reviewer), and
2. **the change is low risk** (docs, added tests, Dependabot patch bumps, deletion-only dead-code removal), **or the repository owner has approved this exact commit** with the `human-approved` label.

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

## Use

Copy [`caller/pr-gate.yml`](caller/pr-gate.yml) to `.github/workflows/pr-gate.yml`, then require the `review-gate` status (source: GitHub Actions) in a ruleset.

## Develop

Changes here go through this repo's own `review-gate`, so **Codex automatic review must stay on for this repository** (Codex settings → Code review → every push). Without it, gate PRs wait for a review that never comes.


```bash
npm test   # builds .github/workflows/gate.yml from gate/ and runs unit + workflow-harness tests
```

`gate/gate.js` is pure decision logic. `gate/workflow.test.js` runs the generated workflow script against a mocked GitHub API.
