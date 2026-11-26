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
// github-script passes `require` too (gate.js uses node:crypto for approved copies).
const script = new AsyncFunction('github', 'context', 'core', 'require', body.join('\n'));

const OWNER = 'haynesj1';
const ACTIONS = { login: 'github-actions[bot]' };
const codexComment = (sha, unresolved = false, status = 'completed') => ({
  user: { login: 'chatgpt-codex-connector[bot]' },
  body: `<!-- codex-review-state:v1 {"code_review":{"commit_sha":"${sha}","has_unresolved_findings":${unresolved},"status":"${status}"}} -->`,
});
const labelled = (at, extra = {}) => ({ event: 'labeled', label: { name: 'human-approved' }, actor: { login: OWNER }, created_at: at, ...extra });
const run = (sha, at, pr = 1, path = '.github/workflows/pr-gate.yml') => ({ head_sha: sha, created_at: at, path, pull_requests: [{ number: pr }] });
const code = [{ filename: 'src/app.ts', status: 'modified', patch: '+x', additions: 1 }];

function harness({ headSha = 'H', event = 'pull_request_target', action = 'synchronize', files = code, comments = [], timeline = [], runs = [], labels = [], headRef = 'feature', ops = null, issue = null, openPrs = [], issueEvent = null, pushRef = undefined, reviewComments = [], baseSha = 'BASE', contents = {} }) {
  const written = []; const added = []; const removed = []; const summary = []; const seenRefs = []; const contentReads = [];
  const github = {
    paginate: async (fn, args) => fn(args),
    rest: {
      pulls: {
        get: async () => ({ data: { state: 'open', draft: false, title: 't', body: '', user: { login: OWNER }, labels: labels.map((name) => ({ name })), head: { sha: headSha, ref: headRef }, base: { sha: baseSha, repo: { default_branch: 'main' } } } }),
        listFiles: async () => files,
        list: async () => openPrs,
        listCommits: async () => [{ author: { login: OWNER } }],
        listReviews: async () => [],
        listReviewComments: async () => reviewComments,
      },
      issues: {
        listEventsForTimeline: async () => timeline,
        get: async ({ issue_number: n }) => { if (!issue || issue.number !== n) throw Object.assign(new Error('nf'), { status: 404 }); return { data: issue }; },
        listComments: async () => comments,
        addLabels: async ({ labels: l }) => added.push(...l),
        removeLabel: async ({ name }) => removed.push(name),
      },
      repos: {
        createCommitStatus: async (s) => written.push(s),
        // contents: `${ref}:${path}` -> file text, or a contents API response object.
        getContent: async ({ path: p, ref }) => {
          if (p !== '.ops.yml') {
            contentReads.push(`${ref}:${p}`);
            const c = contents[`${ref}:${p}`];
            if (c === undefined) throw Object.assign(new Error('nf'), { status: 404 });
            if (typeof c !== 'string') return { data: c };
            const buf = Buffer.from(c, 'utf8');
            return { data: { type: 'file', path: p, encoding: 'base64', size: buf.length, content: buf.toString('base64') } };
          }
          if (!ops) throw Object.assign(new Error('nf'), { status: 404 }); seenRefs.push(ref); return { data: { content: Buffer.from(ops).toString('base64') } }; },
      },
      actions: { listWorkflowRunsForRepo: async ({ head_sha: sha, event: ev }) => runs.filter((r) => r.head_sha === sha && ev === 'pull_request_target') },
    },
  };
  const context = {
    ref: pushRef, repo: { owner: OWNER, repo: 'r' }, eventName: event, serverUrl: 'https://github.com', runId: 42,
    payload: issueEvent || { action, label: action === 'labeled' ? { name: 'human-approved' } : undefined, pull_request: { number: 1, updated_at: '2026-11-06T10:00:00Z' } },
  };
  const core = { info() {}, warning() {}, summary: { addHeading() { return this; }, addList(l) { summary.push(...l); return this; }, write: async () => {} } };
  return { github, run: () => script(github, context, core, require), written, added, removed, summary, seenRefs, contentReads, gate: () => written.filter((s) => s.context === 'review-gate').at(-1) };
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

test('workflow: a PR touching only docs/features.json is risk:normal and waits for approval (#17)', async () => {
  const h = harness({ files: [{ filename: 'docs/features.json', status: 'modified', patch: '+x', additions: 1 }], comments: [codexComment('H')] });
  await h.run();
  assert.equal(h.gate().state, 'pending');
  assert.equal(h.gate().description, 'risk:normal: waiting for human-approved \u2014 protected path docs/features.json');
  assert.deepEqual(h.added, ['risk:normal']);
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
  for (const bad of ['pull_request_review', 'workflow_dispatch', '\n  pull_request:', 'workflow_run']) assert.ok(!on.includes(bad), bad);
  // push is allowed only as default-branch pushes of .ops.yml (policy changes), which
  // happen only by merging a reviewed PR; any other push trigger is rejected.
  const pushBlock = on.includes('push:') ? on.slice(on.indexOf('\n  push:')).split('\n').filter((l) => /^ {4}\S/.test(l)) : [];
  if (on.includes('push:')) assert.deepEqual(pushBlock, ["    branches: [main, master]", "    paths: ['.ops.yml']"]);
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
  // Check and ruling verdicts (risk:checked tier, #21) evaluate, as does an edit that removes one.
  assert.equal(onComment('Check done.\n<!-- check-verdict:v1 {"commit_sha":"abc","result":"pass"} -->'), true);
  assert.equal(onComment('<!-- ruling-verdict:v1 {"commit_sha":"abc","result":"none-stand"} -->'), true);
  assert.equal(onComment('Withdrawn.', true, '<!-- check-verdict:v1 {"commit_sha":"abc","result":"pass"} -->'), true);
  assert.equal(onComment('Withdrawn.', true, '<!-- ruling-verdict:v1 {"commit_sha":"abc","result":"stands"} -->'), true);
  // A deleted comment: the payload still carries its body, so deleting a verdict evaluates (#21).
  const onDelete = (body) => run({ event_name: 'issue_comment', event: { action: 'deleted', issue: { pull_request: { url: 'x' } }, comment: { body } } });
  assert.equal(onDelete('<!-- check-verdict:v1 {"commit_sha":"abc","result":"pass"} -->'), true);
  assert.equal(onDelete('<!-- ruling-verdict:v1 {"commit_sha":"abc","result":"none-stand"} -->'), true);
  assert.equal(onDelete('<!-- review-verdict:v1 {"commit_sha":"abc","result":"clear"} -->'), true);
  assert.equal(onDelete('Thanks, fixed.'), false);
  const types = /issue_comment:\n(?:\s+#.*\n)*\s+types: \[([^\]]*)\]/.exec(callerYml)[1].split(/,\s*/);
  assert.deepEqual(types, ['created', 'edited', 'deleted']);
  // Ordinary comments, PR summaries and comments on plain issues are skipped.
  assert.equal(onComment('Fixed in the latest push.'), false);
  assert.equal(onComment('<!-- pr-summary:v1 -->\n## Summary for the owner'), false);
  assert.equal(onComment(codex('{"code_review":{"status":"completed"}}'), false), false);
  // An edit that removes a verdict or Codex summary still evaluates, so the gate
  // recomputes; an edit between two ordinary bodies is skipped.
  assert.equal(onComment('Withdrawn: re-reviewing.', true, '<!-- review-verdict:v1 {"commit_sha":"abc","result":"clear"} -->'), true);
  assert.equal(onComment('gone', true, codex('{"code_review":{"status":"completed"}}')), true);
  assert.equal(onComment('Fixed now.', true, 'Fixed in the latest push.'), false);
  // PR events: opened, synchronize and the like always evaluate (see the PR filter test below).
  for (const event_name of ['pull_request_target', 'push']) assert.equal(run({ event_name, event: {} }), true);
  // Issue events evaluate only when they can change the agent-safe tier.
  const onIssue = (action, label, pr = false) => run({ event_name: 'issues', event: { action, label: label ? { name: label } : undefined, issue: pr ? { pull_request: { url: 'x' } } : {} } });
  assert.equal(onIssue('closed'), true);
  assert.equal(onIssue('reopened'), true);
  for (const l of ['ready', 'in-progress', 'pivotal']) { assert.equal(onIssue('labeled', l), true); assert.equal(onIssue('unlabeled', l), true); }
  assert.equal(onIssue('labeled', 'size:S'), false);
  assert.equal(onIssue('labeled', 'human-approved', true), false);
});

// The same real `if` expression, for pull_request_target label changes and edits.
test('caller PR filter: unread label changes and title-only edits are skipped', () => {
  const callerYml = fs.readFileSync(path.join(__dirname, '..', 'caller', 'pr-gate.yml'), 'utf8');
  const lines = callerYml.split('\n');
  const start = lines.findIndex((l) => /^\s+if: >-$/.test(l));
  const expr = lines.slice(start + 1).filter((l, i, a) => a.slice(0, i + 1).every((x) => /^\s{6}/.test(x))).join(' ');
  const contains = (hay, needle) => String(hay ?? '').toLowerCase().includes(String(needle).toLowerCase());
  const js = expr.replace(/github(\.\w+)+/g, (m) => m.replace(/\./g, '?.'));
  const run = (github) => Boolean(new Function('github', 'contains', `return (${js});`)(github, contains));
  const pr = (action, extra = {}, author = 'octocat') => run({ event_name: 'pull_request_target', event: { action, pull_request: { user: { login: author } }, ...extra } });
  const label = (action, name) => pr(action, name === undefined ? {} : { label: { name } });
  for (const l of ['human-approved', 'review:override', 'review:blocking', 'type:dead-code', 'risk:low', 'risk:agent', 'risk:checked', 'risk:normal']) {
    assert.equal(label('labeled', l), true, `labeled ${l}`);
    assert.equal(label('unlabeled', l), true, `unlabeled ${l}`);
  }
  for (const l of ['queue', 'size:S', 'enhancement']) {
    assert.equal(label('labeled', l), false, `labeled ${l}`);
    assert.equal(label('unlabeled', l), false, `unlabeled ${l}`);
  }
  assert.equal(label('labeled'), true);
  assert.equal(label('unlabeled'), true);
  const edit = (changes, author) => pr('edited', changes === undefined ? {} : { changes }, author);
  assert.equal(edit({ title: { from: 'Old' } }), false);
  assert.equal(edit({ title: { from: '' } }), false);
  assert.equal(edit({ title: { from: 'Old' } }, 'dependabot[bot]'), true);
  assert.equal(edit({ body: { from: '' } }), true);
  assert.equal(edit({ body: { from: 'Closes #3' } }), true);
  assert.equal(edit({ title: { from: 'Old' }, body: { from: '' } }), true);
  assert.equal(edit({ base: { ref: { from: 'main' } } }), true);
  assert.equal(edit({ title: { from: 'Old' }, base: { ref: { from: 'main' } } }), true);
  assert.equal(edit(undefined), true);
  // A payload with no author must evaluate, not skip.
  assert.equal(run({ event_name: 'pull_request_target', event: { action: 'edited', changes: { title: { from: 'Old' } } } }), true);
  assert.equal(run({ event_name: 'pull_request_target', event: { action: 'edited', changes: { title: { from: 'Old' } }, pull_request: { user: {} } } }), true);
  assert.equal(edit({}), true);
  for (const a of ['opened', 'synchronize', 'reopened', 'ready_for_review', 'converted_to_draft']) assert.equal(pr(a), true, a);
});

test('workflow: agent-safe PR passes without approval, reading .ops.yml from the default branch', async () => {
  const h = harness({ headRef: 'claude/7', ops: 'agent_safe: true\n', issue: { number: 7, state: 'open', labels: [{ name: 'ready' }] }, comments: [codexComment('H')], runs: [run('H', '2026-11-06T09:00:00Z')] });
  await h.run();
  assert.equal(h.gate().state, 'success');
  assert.deepEqual(h.added, ['risk:agent']);
  assert.ok(h.seenRefs.length >= 1 && h.seenRefs.every((r) => r === 'main'));
});

test('workflow: without .ops.yml opt-in the same PR still needs approval', async () => {
  const h = harness({ headRef: 'claude/7', issue: { number: 7, state: 'open', labels: [{ name: 'ready' }] }, comments: [codexComment('H')], runs: [run('H', '2026-11-06T09:00:00Z')] });
  await h.run();
  assert.equal(h.gate().state, 'pending');
  assert.equal(h.gate().description, 'risk:normal: waiting for human-approved \u2014 agent-safe tier not enabled for this repo');
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

test('workflow: a run that published an agent-safe pass re-checks the issue and withdraws it if it changed (Codex P2)', async () => {
  // The issue gains `pivotal` between this run's first read and its write: the
  // stale pass must be replaced by this same run.
  let reads = 0;
  const h = harness({ headRef: 'claude/7', ops: 'agent_safe: true\n', comments: [codexComment('H')], runs: [run('H', '2026-11-06T09:00:00Z')] });
  const before = { number: 7, state: 'open', labels: [{ name: 'ready' }] };
  const after = { number: 7, state: 'open', labels: [{ name: 'ready' }, { name: 'pivotal' }] };
  h.github.rest.issues.get = async () => ({ data: reads++ === 0 ? before : after });
  await h.run();
  const states = h.written.filter((x) => x.context === 'review-gate').map((x) => x.state);
  assert.deepEqual(states, ['success', 'pending']);
  assert.equal(h.gate().state, 'pending');
});

test('workflow: an unchanged issue means one write only', async () => {
  const h = harness({ headRef: 'claude/7', ops: 'agent_safe: true\n', issue: { number: 7, state: 'open', labels: [{ name: 'ready' }] }, comments: [codexComment('H')], runs: [run('H', '2026-11-06T09:00:00Z')] });
  await h.run();
  assert.equal(h.written.filter((x) => x.context === 'review-gate').length, 1);
});

test('workflow: the post-write check also catches a PR body edit that drops the linked issue (Codex P2)', async () => {
  // Branch without an issue number: the link comes from the body, which loses
  // `Closes #7` between this run's first read and its write.
  const h = harness({ headRef: 'claude/fix-login', ops: 'agent_safe: true\n', issue: { number: 7, state: 'open', labels: [{ name: 'ready' }] }, comments: [codexComment('H')], runs: [run('H', '2026-11-06T09:00:00Z')] });
  const base = (body) => ({ data: { state: 'open', draft: false, title: 't', body, user: { login: OWNER }, labels: [], head: { sha: 'H', ref: 'claude/fix-login' }, base: { repo: { default_branch: 'main' } } } });
  let gets = 0;
  h.github.rest.pulls.get = async () => (gets++ === 0 ? base('Closes #7') : base('no link any more'));
  await h.run();
  assert.deepEqual(h.written.filter((x) => x.context === 'review-gate').map((x) => x.state), ['success', 'pending']);
});

test('workflow: the post-write check stops if a newer commit has arrived', async () => {
  const h = harness({ headRef: 'claude/7', ops: 'agent_safe: true\n', issue: { number: 7, state: 'open', labels: [{ name: 'ready' }] }, comments: [codexComment('H')], runs: [run('H', '2026-11-06T09:00:00Z')] });
  const get = h.github.rest.pulls.get; let gets = 0;
  h.github.rest.pulls.get = async (a) => { const r = await get(a); return gets++ === 0 ? r : { data: { ...r.data, head: { ...r.data.head, sha: 'NEW' } } }; };
  await h.run();
  assert.equal(h.written.filter((x) => x.context === 'review-gate').length, 1);
});

test('workflow: after publishing a pass, a review:blocking label added meanwhile wins (Codex P2)', async () => {
  const h = harness({ headRef: 'claude/7', ops: 'agent_safe: true\n', issue: { number: 7, state: 'open', labels: [{ name: 'ready' }] }, comments: [codexComment('H')], runs: [run('H', '2026-11-06T09:00:00Z')] });
  const get = h.github.rest.pulls.get; let gets = 0;
  h.github.rest.pulls.get = async (a) => { const r = await get(a); return gets++ === 0 ? r : { data: { ...r.data, labels: [{ name: 'review:blocking' }] } }; };
  await h.run();
  assert.deepEqual(h.written.filter((x) => x.context === 'review-gate').map((x) => x.state), ['success', 'failure']);
});

test('workflow: a non-pass result is published once, with no re-check', async () => {
  const h = harness({ comments: [codexComment('H')], runs: [run('H', '2026-11-06T09:00:00Z')] });
  let gets = 0; const get = h.github.rest.pulls.get;
  h.github.rest.pulls.get = async (a) => { gets++; return get(a); };
  await h.run();
  assert.equal(h.gate().state, 'pending');
  assert.equal(gets, 1);
});

test('workflow: a .ops.yml push to the default branch re-evaluates every open PR, agent or not (Codex P2, #26)', async () => {
  const pr = (number, ref) => ({ number, head: { ref }, body: '' });
  const h = harness({ event: 'push', pushRef: 'refs/heads/main', issueEvent: { repository: { default_branch: 'main' } }, headRef: 'claude/7',
    ops: 'agent_safe: false\n', openPrs: [pr(1, 'claude/7'), pr(2, 'feature/x')], comments: [codexComment('H')], runs: [run('H', '2026-11-06T09:00:00Z')] });
  await h.run();
  assert.equal(h.written.length, 2);
  assert.equal(h.gate().state, 'pending');
  const other = harness({ event: 'push', pushRef: 'refs/heads/claude/7', issueEvent: { repository: { default_branch: 'main' } }, openPrs: [pr(1, 'claude/7')] });
  await other.run();
  assert.equal(other.written.length, 0);
});

test('workflow: adding a reviewed docs PR\'s file to pivotal_paths withdraws its risk:low pass on the policy push (#26)', async () => {
  const docs = [{ filename: 'docs/guide.md', status: 'modified', patch: '+x', additions: 1, deletions: 0 }];
  const opts = { headRef: 'feature/docs', files: docs, comments: [codexComment('H')], runs: [run('H', '2026-11-06T09:00:00Z')] };
  const before = harness(opts);
  await before.run();
  assert.equal(before.gate().state, 'success');
  const h = harness({ ...opts, event: 'push', pushRef: 'refs/heads/main', issueEvent: { repository: { default_branch: 'main' } },
    ops: 'pivotal_paths:\n  - docs/\n', openPrs: [{ number: 1, head: { ref: 'feature/docs' }, body: '' }] });
  await h.run();
  assert.equal(h.gate().state, 'pending');
  assert.match(h.gate().description, /risk:normal: waiting for human-approved — pivotal path docs\/guide\.md/);
});

test('caller: pushes of .ops.yml to the default branch trigger the gate', () => {
  const callerYml = fs.readFileSync(path.join(__dirname, '..', 'caller', 'pr-gate.yml'), 'utf8');
  assert.match(callerYml, /push:\n\s+branches: \[main, master\]\n\s+paths: \['\.ops\.yml'\]/);
});

test('workflow: answered Codex findings pass their thread fields through; the PR waits for human-approved (#14)', async () => {
  const codexBot = { login: 'chatgpt-codex-connector[bot]' };
  const reviewComments = [1, 2].flatMap((i) => [
    { id: i, user: codexBot, body: '![P1 Badge](https://img.shields.io/badge/P1-orange) problem', commit_id: 'H', original_commit_id: `C${i}`, created_at: '2026-11-06T09:00:00Z' },
    { id: 100 + i, in_reply_to_id: i, user: { login: OWNER }, body: 'Fixed in C3.', commit_id: 'H', original_commit_id: 'C3', created_at: '2026-11-06T09:30:00Z' },
  ]);
  const waiting = harness({ comments: [codexComment('H', true)], reviewComments, runs: [run('H', '2026-11-06T09:00:00Z')] });
  await waiting.run();
  assert.equal(waiting.gate().state, 'pending');
  assert.equal(waiting.gate().description, 'risk:normal: waiting for human-approved \u2014 reviewer findings answered, not resolved \u2014 agent-safe tier not enabled for this repo');
  const approved = harness({ labels: ['human-approved'], comments: [codexComment('H', true)], reviewComments, runs: [run('H', '2026-11-06T09:00:00Z')], timeline: [labelled('2026-11-06T10:00:00Z')] });
  await approved.run();
  assert.equal(approved.gate().state, 'success');
  assert.equal(approved.gate().description, 'human-approved; reviewer findings answered, not resolved');
  // the same threads with one reply missing stay red
  const open = harness({ comments: [codexComment('H', true)], reviewComments: reviewComments.slice(0, 3), runs: [run('H', '2026-11-06T09:00:00Z')] });
  await open.run();
  assert.equal(open.gate().state, 'failure');
  // a docs PR (risk:low) with every finding answered still fails
  const docs = harness({ files: [{ filename: 'README.md', status: 'modified', patch: '+x', additions: 1 }], comments: [codexComment('H', true)], reviewComments });
  await docs.run();
  assert.equal(docs.gate().state, 'failure');
});

// ---- approved copies (#19) ----------------------------------------------
const CALLER = '.github/workflows/pr-gate.yml';
const callerText = fs.readFileSync(path.join(__dirname, '..', 'caller', 'pr-gate.yml'), 'utf8');
const approvedFile = JSON.parse(fs.readFileSync(path.join(__dirname, 'approved-copies.json'), 'utf8'));
const HEX_HEAD = 'a'.repeat(40);
const HEX_BASE = 'b'.repeat(40);
const callerPr = (extra = {}) => harness({ headSha: HEX_HEAD, baseSha: HEX_BASE, files: [{ filename: CALLER, status: 'modified', patch: '+x', additions: 1 }],
  comments: [codexComment(HEX_HEAD)], runs: [run(HEX_HEAD, '2026-11-06T09:00:00Z')], ...extra });

test('workflow: the build embeds the hash of this repo\'s caller in the approved list (#19)', () => {
  const g = require('./gate');
  const m = /const APPROVED_COPIES = (.*);$/m.exec(yml);
  const list = JSON.parse(m[1]);
  assert.equal(g.approvedListError(list), null);
  assert.deepEqual(list.blocks, approvedFile.blocks);
  assert.deepEqual(list.files, [{ path: CALLER, sha256: [g.copyHash(callerText)] }]);
});

test('workflow: the approved list holds the shared AGENTS.md block, embedded as listed (#22)', () => {
  const g = require('./gate');
  assert.equal(g.approvedListError(approvedFile), null);
  assert.deepEqual(approvedFile.blocks, [{ path: 'AGENTS.md', start: '<!-- portfolio-ops:common:start -->', end: '<!-- portfolio-ops:common:end -->',
    sha256: ['44c98b1b8251c9ae802aeafdc5b731e5f8a046e09bc5709f2f4e085cb28b3846'] }]);
  // The built workflow embeds the same list (the build only adds the caller's hash to its file entry).
  const embedded = JSON.parse(/const APPROVED_COPIES = (.*);$/m.exec(yml)[1]);
  const expected = structuredClone(approvedFile);
  expected.files.find((e) => e.path === CALLER).sha256.push(g.copyHash(callerText));
  assert.deepEqual(embedded, expected);
});

test('workflow: a PR that only updates the caller to the approved copy is risk:low, read once at the head SHA (#19)', async () => {
  const h = callerPr({ contents: { [`${HEX_HEAD}:${CALLER}`]: callerText } });
  await h.run();
  assert.equal(h.gate().state, 'success');
  assert.equal(h.gate().description, 'risk:low and reviewed');
  assert.deepEqual(h.added, ['risk:low']);
  assert.deepEqual(h.contentReads, [`${HEX_HEAD}:${CALLER}`]);
  // CRLF line endings hash the same.
  const crlf = callerPr({ contents: { [`${HEX_HEAD}:${CALLER}`]: callerText.replace(/\n/g, '\r\n') } });
  await crlf.run();
  assert.deepEqual(crlf.added, ['risk:low']);
  // Review still required: an unfinished review waits.
  const unreviewed = callerPr({ comments: [codexComment(HEX_HEAD, null, 'running')], contents: { [`${HEX_HEAD}:${CALLER}`]: callerText } });
  await unreviewed.run();
  assert.equal(unreviewed.gate().state, 'pending');
  assert.deepEqual(unreviewed.added, ['risk:low']);
});

test('workflow: a near-miss copy of the caller is risk:normal with the protected-path reason (#19)', async () => {
  const WAIT_CALLER = `risk:normal: waiting for human-approved — protected path ${CALLER}`;
  const h = callerPr({ contents: { [`${HEX_HEAD}:${CALLER}`]: `${callerText}# one more line\n` } });
  await h.run();
  assert.equal(h.gate().state, 'pending');
  assert.equal(h.gate().description, WAIT_CALLER);
  assert.deepEqual(h.added, ['risk:normal']);
  // A failed read is not an approved copy, and the run still publishes.
  const failed = callerPr({});
  await failed.run();
  assert.equal(failed.gate().description, WAIT_CALLER);
  // A file over the contents API size limit (no content returned) is not either.
  const big = callerPr({ contents: { [`${HEX_HEAD}:${CALLER}`]: { type: 'file', path: CALLER, encoding: 'none', size: 2_000_000, content: '' } } });
  await big.run();
  assert.equal(big.gate().description, WAIT_CALLER);
  // A head that is not a commit SHA is never read (no fallback to a branch).
  const odd = callerPr({ headSha: 'H', comments: [codexComment('H')], runs: [run('H', '2026-11-06T09:00:00Z')], contents: { [`H:${CALLER}`]: callerText } });
  await odd.run();
  assert.deepEqual(odd.contentReads, []);
  assert.deepEqual(odd.added, ['risk:normal']);
});

test('workflow: no content is read unless every changed file is a listed path (#19)', async () => {
  const files = [{ filename: CALLER, status: 'modified', patch: '+x', additions: 1 }, { filename: 'README.md', status: 'modified', patch: '+x', additions: 1 }];
  const h = callerPr({ files, contents: { [`${HEX_HEAD}:${CALLER}`]: callerText } });
  await h.run();
  assert.deepEqual(h.contentReads, []);
  assert.deepEqual(h.added, ['risk:normal']);
  for (const status of ['removed', 'renamed']) {
    const r = callerPr({ files: [{ filename: CALLER, previous_filename: status === 'renamed' ? '.github/workflows/old.yml' : undefined, status, patch: '', additions: 0 }], contents: { [`${HEX_HEAD}:${CALLER}`]: callerText } });
    await r.run();
    assert.deepEqual(r.contentReads, [], status);
    assert.deepEqual(r.added, ['risk:normal'], status);
  }
});

// ---- risk:checked tier and rulings (#21) -----------------------------------
const SENS_OPS = 'agent_safe: true\nsensitive_paths:\n  - "src/auth/**"\n';
const sensFiles = [{ filename: 'src/auth/login.ts', status: 'modified', patch: '+x', additions: 1 }];
const verdict = (kind, sha, result, login = 'github-actions[bot]', at = '2026-11-06T11:00:00Z') => ({ user: { login }, created_at: at, updated_at: at,
  body: `<!-- ${kind}-verdict:v1 {"commit_sha":"${sha}","result":"${result}"} -->\nResult above.` });
const checkedPr = (extra = {}) => harness({ headRef: 'claude/7', ops: SENS_OPS, issue: { number: 7, state: 'open', labels: [{ name: 'ready' }] }, files: sensFiles,
  runs: [run('H', '2026-11-06T09:00:00Z')], labels: ['risk:normal'], ...extra });

test('workflow: a checked PR with a clean review and a passing check succeeds, labelled risk:checked (#21)', async () => {
  const h = checkedPr({ comments: [codexComment('H'), verdict('check', 'H', 'pass')] });
  await h.run();
  assert.equal(h.gate().state, 'success');
  assert.equal(h.gate().description, 'risk:checked: check passed and reviewed — sensitive path src/auth/login.ts');
  assert.deepEqual(h.added, ['risk:checked']);
  assert.deepEqual(h.removed, ['risk:normal']);
  assert.ok(h.seenRefs.length >= 1 && h.seenRefs.every((r) => r === 'main'));
  assert.ok(h.summary.includes('in risk:checked because: sensitive path src/auth/login.ts'), h.summary.join('\n'));
  assert.ok(h.summary.includes('check of this commit: pass'));
  // the owner's account counts too; nothing yet means waiting for the check
  const owner = checkedPr({ comments: [codexComment('H'), verdict('check', 'H', 'pass', OWNER)] });
  await owner.run();
  assert.equal(owner.gate().state, 'success');
  const none = checkedPr({ comments: [codexComment('H')] });
  await none.run();
  assert.equal(none.gate().description, 'risk:checked: waiting for the check of this commit — sensitive path src/auth/login.ts');
});

test('workflow: a checked PR whose check is unclear waits for human-approved (#21)', async () => {
  const h = checkedPr({ comments: [codexComment('H'), verdict('check', 'H', 'unclear', OWNER)] });
  await h.run();
  assert.equal(h.gate().state, 'pending');
  assert.equal(h.gate().description, 'risk:checked: check unclear; waiting for human-approved — sensitive path src/auth/login.ts');
  assert.deepEqual(h.added, ['risk:checked']);
  assert.ok(h.summary.includes('check of this commit: unclear'));
  // human-approved on the head passes it
  const ok = checkedPr({ labels: ['human-approved'], timeline: [labelled('2026-11-06T10:00:00Z')], comments: [codexComment('H'), verdict('check', 'H', 'unclear', OWNER)] });
  await ok.run();
  assert.equal(ok.gate().state, 'success');
  // a verdict from another account, or for another commit, is no check
  for (const c of [verdict('check', 'H', 'pass', 'someone'), verdict('check', 'OLD', 'pass')]) {
    const x = checkedPr({ comments: [codexComment('H'), c] });
    await x.run();
    assert.equal(x.gate().description, 'risk:checked: waiting for the check of this commit — sensitive path src/auth/login.ts');
  }
});

test('workflow: checked_tier: false on the default branch keeps such PRs risk:normal (#21)', async () => {
  const h = checkedPr({ ops: `${SENS_OPS}checked_tier: false\n`, labels: [], comments: [codexComment('H'), verdict('check', 'H', 'pass')] });
  await h.run();
  assert.equal(h.gate().state, 'pending');
  assert.equal(h.gate().description, 'risk:normal: waiting for human-approved — sensitive path src/auth/login.ts');
  assert.deepEqual(h.added, ['risk:normal']);
  assert.ok(h.seenRefs.every((r) => r === 'main'));
  // a PR that edits .ops.yml to turn it back on is still risk:normal (protected path; the default-branch copy is read)
  const self = checkedPr({ ops: `${SENS_OPS}checked_tier: false\n`, labels: [], comments: [codexComment('H'), verdict('check', 'H', 'pass')],
    files: [...sensFiles, { filename: '.ops.yml', status: 'modified', patch: '-checked_tier: false\n+checked_tier: true', additions: 1, deletions: 1 }] });
  await self.run();
  assert.equal(self.gate().description, 'risk:normal: waiting for human-approved — protected path .ops.yml');
});

test('workflow: a none-stand ruling lets an answered checked PR proceed to its check (#21)', async () => {
  const codexBot = { login: 'chatgpt-codex-connector[bot]' };
  const reviewComments = [
    { id: 1, user: codexBot, body: '![P1 Badge](https://img.shields.io/badge/P1-orange) problem', commit_id: 'H', original_commit_id: 'C1', created_at: '2026-11-06T09:00:00Z' },
    { id: 101, in_reply_to_id: 1, user: { login: OWNER }, body: 'Fixed in C3.', commit_id: 'H', original_commit_id: 'C3', created_at: '2026-11-06T09:30:00Z' },
  ];
  const waiting = checkedPr({ comments: [codexComment('H', true), verdict('check', 'H', 'pass')], reviewComments });
  await waiting.run();
  assert.equal(waiting.gate().description, 'risk:checked: waiting for human-approved — reviewer findings answered, not resolved — sensitive path src/auth/login.ts');
  const ruled = checkedPr({ comments: [codexComment('H', true), verdict('ruling', 'H', 'none-stand', OWNER), verdict('check', 'H', 'pass')], reviewComments });
  await ruled.run();
  assert.equal(ruled.gate().state, 'success');
  assert.equal(ruled.gate().description, 'risk:checked: check passed; no reviewer finding stands — sensitive path src/auth/login.ts');
  const stands = checkedPr({ comments: [codexComment('H', true), verdict('ruling', 'H', 'stands'), verdict('check', 'H', 'pass')], reviewComments });
  await stands.run();
  assert.equal(stands.gate().state, 'failure');
  assert.equal(stands.gate().description, 'Ruling for this commit: a reviewer finding stands');
});

test('workflow: deleting the passing check verdict withdraws the pass (#21)', async () => {
  const passed = checkedPr({ comments: [codexComment('H'), verdict('check', 'H', 'pass')] });
  await passed.run();
  assert.equal(passed.gate().state, 'success');
  // The comment is deleted: the deleted event runs the gate, which no longer lists it.
  const gone = checkedPr({ event: 'issue_comment', action: 'deleted', comments: [codexComment('H')] });
  await gone.run();
  assert.equal(gone.gate().state, 'pending');
  assert.equal(gone.gate().description, 'risk:checked: waiting for the check of this commit — sensitive path src/auth/login.ts');
  // the same for a covering ruling: the answered PR goes back to waiting for human-approved
  const codexBot = { login: 'chatgpt-codex-connector[bot]' };
  const reviewComments = [
    { id: 1, user: codexBot, body: '![P1 Badge](https://img.shields.io/badge/P1-orange) problem', commit_id: 'H', original_commit_id: 'C1', created_at: '2026-11-06T09:00:00Z' },
    { id: 101, in_reply_to_id: 1, user: { login: OWNER }, body: 'Fixed in C3.', commit_id: 'H', original_commit_id: 'C3', created_at: '2026-11-06T09:30:00Z' },
  ];
  const ruled = checkedPr({ comments: [codexComment('H', true), verdict('ruling', 'H', 'none-stand'), verdict('check', 'H', 'pass')], reviewComments });
  await ruled.run();
  assert.equal(ruled.gate().state, 'success');
  const unruled = checkedPr({ event: 'issue_comment', action: 'deleted', comments: [codexComment('H', true), verdict('check', 'H', 'pass')], reviewComments });
  await unruled.run();
  assert.equal(unruled.gate().description, 'risk:checked: waiting for human-approved — reviewer findings answered, not resolved — sensitive path src/auth/login.ts');
});
