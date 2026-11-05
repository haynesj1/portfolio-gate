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

function harness({ headSha = 'H', event = 'pull_request_target', action = 'synchronize', files = code, comments = [], timeline = [], runs = [], labels = [] }) {
  const written = []; const added = [];
  const github = {
    paginate: async (fn, args) => fn(args),
    rest: {
      pulls: {
        get: async () => ({ data: { state: 'open', draft: false, title: 't', user: { login: OWNER }, labels: labels.map((name) => ({ name })), head: { sha: headSha } } }),
        listFiles: async () => files,
        listCommits: async () => [{ author: { login: OWNER } }],
        listReviews: async () => [],
        listReviewComments: async () => [],
      },
      issues: {
        listEventsForTimeline: async () => timeline,
        listComments: async () => comments,
        addLabels: async ({ labels: l }) => added.push(...l),
        removeLabel: async () => {},
      },
      repos: { createCommitStatus: async (s) => written.push(s) },
      actions: { listWorkflowRunsForRepo: async ({ head_sha: sha, event: ev }) => runs.filter((r) => r.head_sha === sha && ev === 'pull_request_target') },
    },
  };
  const context = {
    repo: { owner: OWNER, repo: 'r' }, eventName: event, serverUrl: 'https://github.com', runId: 42,
    payload: { action, label: action === 'labeled' ? { name: 'human-approved' } : undefined, pull_request: { number: 1, updated_at: '2026-11-06T10:00:00Z' } },
  };
  const core = { info() {}, warning() {}, summary: { addHeading() { return this; }, addList() { return this; }, write: async () => {} } };
  return { run: () => script(github, context, core), written, added, gate: () => written.filter((s) => s.context === 'review-gate').at(-1) };
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
  // The reusable workflow can only be called, never triggered directly.
  const on2 = yml.slice(yml.indexOf('\non:'), yml.indexOf('\njobs:'));
  assert.equal(on2.trim(), 'on:\n  workflow_call:');
});
