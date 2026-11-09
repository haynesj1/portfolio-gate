// Runs the generated pr-gate workflow script against a mocked GitHub API.
// `npm test` builds the workflow first.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const yml = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'gate.yml'), 'utf8');
const lines = yml.split('\n');
const start = lines.findIndex((l) => l.trim() === 'script: |') + 1;
const body = [];
for (const l of lines.slice(start)) { if (l.trim() && !l.startsWith('            ')) break; body.push(l.slice(12)); }
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const script = new AsyncFunction('github', 'context', 'core', body.join('\n'));

const OWNER = 'haynesj1';
const ACTIONS = { login: 'github-actions[bot]' };
const codexComment = (sha, unresolved = false, status = 'completed') => ({
  user: { login: 'chatgpt-codex-connector[bot]' },
  body: `<!-- codex-review-state:v1 {"code_review":{"commit_sha":"${sha}","has_unresolved_findings":${unresolved},"status":"${status}"}} -->`,
});
const labelled = (at, extra = {}) => ({ event: 'labeled', label: { name: 'human-approved' }, actor: { login: OWNER }, created_at: at, ...extra });
const run = (sha, at, pr = 1, path = '.github/workflows/pr-gate.yml') => ({ head_sha: sha, created_at: at, path, pull_requests: [{ number: pr }] });
const code = [{ filename: 'src/app.ts', status: 'modified', patch: '+x', additions: 1 }];

function harness({ headSha = 'H', event = 'pull_request_target', action = 'synchronize', files = code, comments = [], timeline = [], runs = [], labels = [], headRef = 'feature', ops = null, issue = null, openPrs = [], issueEvent = null }) {
  const written = []; const added = []; const seenRefs = [];
  const github = {
    paginate: async (fn, args) => fn(args),
    rest: {
      pulls: {
        get: async () => ({ data: { state: 'open', draft: false, title: 't', body: '', user: { login: OWNER }, labels: labels.map((name) => ({ name })), head: { sha: headSha, ref: headRef }, base: { repo: { default_branch: 'main' } } } }),
        listFiles: async () => files,
        list: async () => openPrs,
        listCommits: async () => [{ author: { login: OWNER } }],
        listReviews: async () => [],
        listReviewComments: async () => [],
      },
      issues: {
        listEventsForTimeline: async () => timeline,
        get: async ({ issue_number: n }) => { if (!issue || issue.number !== n) throw Object.assign(new Error('nf'), { status: 404 }); return { data: issue }; },
        listComments: async () => comments,
        addLabels: async ({ labels: l }) => added.push(...l),
        removeLabel: async () => {},
      },
      repos: {
        createCommitStatus: async (s) => written.push(s),
        getContent: async ({ ref }) => { if (!ops) throw Object.assign(new Error('nf'), { status: 404 }); seenRefs.push(ref); return { data: { content: Buffer.from(ops).toString('base64') } }; },
      },
      actions: { listWorkflowRunsForRepo: async ({ head_sha: sha, event: ev }) => runs.filter((r) => r.head_sha === sha && ev === 'pull_request_target') },
    },
  };
  const context = {
    repo: { owner: OWNER, repo: 'r' }, eventName: event, serverUrl: 'https://github.com', runId: 42,
    payload: issueEvent || { action, label: action === 'labeled' ? { name: 'human-approved' } : undefined, pull_request: { number: 1, updated_at: '2026-11-06T10:00:00Z' } },
  };
  const core = { info() {}, warning() {}, summary: { addHeading() { return this; }, addList() { return this; }, write: async () => {} } };
  return { run: () => script(github, context, core), written, added, seenRefs, gate: () => written.filter((s) => s.context === 'review-gate').at(-1) };
}

test('workflow: owner approval after the head was first seen passes', async () => {
  const h = harness({ labels: ['human-approved'], comments: [codexComment('H')], runs: [run('H', '2026-11-06T09:00:00Z')], timeline: [labelled('2026-11-06T10:00:00Z')] });
  await h.run();
  assert.equal(h.gate().state, 'success');
  assert.equal(h.gate().sha, 'H');
});

test('workflow: approval for an older commit does not carry over to a new push', async () => {
  const h = harness({ headSha: 'B', labels: ['human-approved'], comments: [codexComment('B')], runs: [run('B', '2026-11-06T11:00:00Z')], timeline: [labelled('2026-11-06T10:00:00Z')] });
  await h.run();
  assert.equal(h.gate().state, 'pending');
  assert.match(h.gate().description, /predates/);
});

test('workflow: a run for the same commit on ANOTHER PR does not count as this PR adopting it (Codex P0)', async () => {
  // B was evaluated on PR 7 at 08:00; this PR (1) only adopted B at 11:00, after the 10:00 approval of A.
  const h = harness({ headSha: 'B', labels: ['human-approved'], comments: [codexComment('B')],
    runs: [run('B', '2026-11-06T08:00:00Z', 7), run('B', '2026-11-06T11:00:00Z', 1)], timeline: [labelled('2026-11-06T10:00:00Z')] });
  await h.run();
  assert.equal(h.gate().state, 'pending');
});

test('workflow: runs of other workflows on the commit do not count', async () => {
  const h = harness({ headSha: 'B', labels: ['human-approved'], comments: [codexComment('B')],
    runs: [run('B', '2026-11-06T08:00:00Z', 1, '.github/workflows/ci.yml'), run('B', '2026-11-06T11:00:00Z', 1)], timeline: [labelled('2026-11-06T10:00:00Z')] });
  await h.run();
  assert.equal(h.gate().state, 'pending');
});

test('workflow: the status links to this gate run (provenance for the daily audit)', async () => {
  const h = harness({ files: [{ filename: 'README.md', status: 'modified', patch: '+x', additions: 1 }], comments: [codexComment('H')] });
  await h.run();
  assert.equal(h.gate().target_url, 'https://github.com/haynesj1/r/actions/runs/42');
});

test('workflow: a force push back to an older approved-looking commit voids approval', async () => {
  const h = harness({ labels: ['human-approved'], comments: [codexComment('H')], runs: [run('H', '2026-11-06T09:00:00Z')],
    timeline: [labelled('2026-11-06T10:00:00Z'), { event: 'head_ref_force_pushed', created_at: '2026-11-06T10:30:00Z' }] });
  await h.run();
  assert.equal(h.gate().state, 'pending');
});

test('workflow: a comment-triggered run decides approval without the label run (no lost approvals)', async () => {
  const h = harness({ event: 'issue_comment', action: 'edited', labels: ['human-approved'], comments: [codexComment('H')], runs: [run('H', '2026-11-06T09:00:00Z')], timeline: [labelled('2026-11-06T10:00:00Z')] });
  await h.run();
  assert.equal(h.gate().state, 'success');
});

test('workflow: label added through an app (agent) does not approve', async () => {
  const h = harness({ labels: ['human-approved'], comments: [codexComment('H')], runs: [run('H', '2026-11-06T09:00:00Z')], timeline: [labelled('2026-11-06T10:00:00Z', { performed_via_github_app: { slug: 'claude' } })] });
  await h.run();
  assert.equal(h.gate().state, 'pending');
});

test('workflow: docs PR with a clean Codex review passes and is labelled risk:low', async () => {
  const h = harness({ files: [{ filename: 'README.md', status: 'modified', patch: '+x', additions: 1 }], comments: [codexComment('H')] });
  await h.run();
  assert.equal(h.gate().state, 'success');
  assert.deepEqual(h.added, ['risk:low']);
});

test('workflow: Codex findings on the head block; running review waits', async () => {
  const blocked = harness({ comments: [codexComment('H', true)] });
  await blocked.run();
  assert.equal(blocked.gate().state, 'failure');
  const running = harness({ files: [{ filename: 'README.md', status: 'modified', patch: '+x', additions: 1 }], comments: [codexComment('H', null, 'running')] });
  await running.run();
  assert.equal(running.gate().state, 'pending');
});

test('caller only uses triggers that run default-branch code, and calls the gate (Codex P1 #2)', () => {
  const caller = fs.readFileSync(path.join(__dirname, '..', 'caller', 'pr-gate.yml'), 'utf8');
  const on = caller.slice(caller.indexOf('\non:'), caller.indexOf('\npermissions:'));
  for (const bad of ['pull_request_review', 'workflow_dispatch', 'push:', '\n  pull_request:', 'workflow_run']) assert.ok(!on.includes(bad), bad);
  assert.ok(on.includes('pull_request_target') && on.includes('issue_comment'));
  assert.match(caller, /uses: haynesj1\/portfolio-gate\/\.github\/workflows\/gate\.yml@main/);
  // Comment runs are filtered to review results, and concurrency sits on the job so a
  // skipped comment run can't cancel a real evaluation (Actions minutes, Nov 2026).
  const job = caller.slice(caller.indexOf('\njobs:'));
  for (const want of ["'review-verdict:v1'", "'codex-review-state:v1'", 'concurrency:', 'cancel-in-progress: true']) assert.ok(job.includes(want), want);
  assert.ok(!caller.slice(0, caller.indexOf('\njobs:')).includes('concurrency:'), 'no workflow-level concurrency');
  // The reusable workflow can only be called, never triggered directly.
  const on2 = yml.slice(yml.indexOf('\non:'), yml.indexOf('\njobs:'));
  assert.equal(on2.trim(), 'on:\n  workflow_call:');
});

// The caller's job-level `if` decides which comment events evaluate the gate. Evaluate
// the real expression against real comment bodies: GitHub's syntax here (&&, ||, !,
// !=, 'strings', property paths) is valid JavaScript once contains() is provided.
test('caller comment filter: review results evaluate, other comments are skipped', () => {
  const callerYml = fs.readFileSync(path.join(__dirname, '..', 'caller', 'pr-gate.yml'), 'utf8');
  const lines = callerYml.split('\n');
  const start = lines.findIndex((l) => /^\s+if: >-$/.test(l));
  const expr = lines.slice(start + 1).filter((l, i, a) => a.slice(0, i + 1).every((x) => /^\s{6}/.test(x))).join(' ');
  const contains = (hay, needle) => String(hay ?? '').toLowerCase().includes(String(needle).toLowerCase());
  // GitHub expressions read a missing property as null; optional chaining does the same here.
  const js = expr.replace(/github(\.\w+)+/g, (m) => m.replace(/\./g, '?.'));
  const run = (github) => Boolean(new Function('github', 'contains', `return (${js});`)(github, contains));
  const onComment = (body, pr = true, from) => run({ event_name: 'issue_comment', event: { issue: pr ? { pull_request: { url: 'x' } } : {}, comment: { body }, ...(from === undefined ? {} : { changes: { body: { from } } }) } });
  const codex = (state) => `<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 ${state} -->\n<details>Codex Review Summary</details>`;
  // Real Codex summaries (Nov 2026 format, no spaces) and other valid spellings.
  assert.equal(onComment(codex('{"code_review":{"commit_sha":"abc","has_any_findings":false,"has_unresolved_findings":false,"status":"completed"},"security_review":{"status":null}}')), true);
  assert.equal(onComment(codex('{"code_review":{"commit_sha":"abc","has_unresolved_findings":true,"status":"completed"}}')), true);
  assert.equal(onComment(codex('{"code_review": {"commit_sha": "abc", "has_unresolved_findings": false, "status": "completed"}}')), true);
  assert.equal(onComment(codex('{"code_review":{"commit_sha":"abc","has_unresolved_findings":false,"status":"succeeded"}}')), true);
  assert.equal(onComment(codex('{"code_review":{"commit_sha":"abc","has_unresolved_findings":false,"status":"success"}}')), true);
  // Any Codex summary evaluates, whatever its state: the gate's parser decides.
  assert.equal(onComment(codex('{"code_review":{"commit_sha":"abc","has_any_findings":null,"status":"running"}}')), true);
  assert.equal(onComment(codex('{"code_review":{"commit_sha":"abc","status":"completed","has_unresolved_findings":false},"security_review":{"status":"running"}}')), true);
  // Claude reviewer verdicts evaluate.
  assert.equal(onComment('<!-- review-verdict:v1 {"commit_sha":"abc","result":"clear"} -->'), true);
  assert.equal(onComment('<!-- review-verdict:v1 {"commit_sha":"abc","result":"blocking"} -->'), true);
  // Ordinary comments, PR summaries and comments on plain issues are skipped.
  assert.equal(onComment('Fixed in the latest push.'), false);
  assert.equal(onComment('<!-- pr-summary:v1 -->\n## Summary for Jordan'), false);
  assert.equal(onComment(codex('{"code_review":{"status":"completed"}}'), false), false);
  // An edit that removes a verdict or Codex summary still evaluates, so the gate
  // recomputes; an edit between two ordinary bodies is skipped.
  assert.equal(onComment('Withdrawn: re-reviewing.', true, '<!-- review-verdict:v1 {"commit_sha":"abc","result":"clear"} -->'), true);
  assert.equal(onComment('gone', true, codex('{"code_review":{"status":"completed"}}')), true);
  assert.equal(onComment('Fixed now.', true, 'Fixed in the latest push.'), false);
  // PR events always evaluate.
  for (const event_name of ['pull_request_target']) assert.equal(run({ event_name, event: {} }), true);
  // Issue events evaluate only when they can change the agent-safe tier.
  const onIssue = (action, label, pr = false) => run({ event_name: 'issues', event: { action, label: label ? { name: label } : undefined, issue: pr ? { pull_request: { url: 'x' } } : {} } });
  assert.equal(onIssue('closed'), true);
  assert.equal(onIssue('reopened'), true);
  for (const l of ['ready', 'in-progress', 'pivotal']) { assert.equal(onIssue('labeled', l), true); assert.equal(onIssue('unlabeled', l), true); }
  assert.equal(onIssue('labeled', 'size:S'), false);
  assert.equal(onIssue('labeled', 'human-approved', true), false);
});

test('workflow: agent-safe PR passes without approval, reading .ops.yml from the default branch', async () => {
  const h = harness({ headRef: 'claude/7', ops: 'agent_safe: true\n', issue: { number: 7, state: 'open', labels: [{ name: 'ready' }] }, comments: [codexComment('H')], runs: [run('H', '2026-11-06T09:00:00Z')] });
  await h.run();
  assert.equal(h.gate().state, 'success');
  assert.deepEqual(h.added, ['risk:agent']);
  assert.deepEqual(h.seenRefs, ['main']);
});

test('workflow: without .ops.yml opt-in the same PR still needs approval', async () => {
  const h = harness({ headRef: 'claude/7', issue: { number: 7, state: 'open', labels: [{ name: 'ready' }] }, comments: [codexComment('H')], runs: [run('H', '2026-11-06T09:00:00Z')] });
  await h.run();
  assert.equal(h.gate().state, 'pending');
  assert.deepEqual(h.added, ['risk:normal']);
});

test('workflow: an issue event re-evaluates only the open PRs that implement it', async () => {
  const pr = (number, ref, body = '') => ({ number, head: { ref }, body });
  const h = harness({
    event: 'issues', headRef: 'claude/7', ops: 'agent_safe: true\n',
    issue: { number: 7, state: 'open', labels: [{ name: 'ready' }, { name: 'pivotal' }] },
    issueEvent: { action: 'labeled', label: { name: 'pivotal' }, issue: { number: 7 } },
    openPrs: [pr(1, 'claude/7'), pr(2, 'claude/8')],
    comments: [codexComment('H')], runs: [run('H', '2026-11-06T09:00:00Z')],
  });
  await h.run();
  assert.equal(h.written.length, 1);
  assert.equal(h.gate().state, 'pending');
  assert.deepEqual(h.added, ['risk:normal']);
});

test('caller: PR body edits re-evaluate (the linked issue can live in the body)', () => {
  const callerYml = fs.readFileSync(path.join(__dirname, '..', 'caller', 'pr-gate.yml'), 'utf8');
  assert.match(callerYml, /pull_request_target:\n(\s+#.*\n)*\s+types: \[opened, edited,/);
});
