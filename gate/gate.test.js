const test = require('node:test');
const assert = require('node:assert/strict');
const g = require('./gate');

const OWNER = 'haynesj1';
const f = (filename, patch = '+x', extra = {}) => ({ filename, status: 'modified', patch, additions: 1, ...extra });
const codex = (sha, unresolved = false, status = 'completed') => ({
  author: 'chatgpt-codex-connector[bot]',
  body: `<!-- codex-review-state:v1 {"code_review":{"commit_sha":"${sha}","has_unresolved_findings":${unresolved},"status":"${status}"}} -->`,
});
const claudeVerdict = (sha, result = 'clear', author = 'claude[bot]') => ({ author, body: `<!-- review-verdict:v1 {"commit_sha":"${sha}","result":"${result}"} -->` });
const label = (at, extra = {}) => ({ event: 'labeled', label: 'human-approved', actor: OWNER, viaApp: false, at, ...extra });
const base = { author: OWNER, title: 'x', labels: [], files: [f('src/app.ts')], commitAuthors: [OWNER], labelEvents: [], feedback: [codex('H')], headSha: 'H', headAdoptedAt: '2026-11-06T10:00:00Z', owner: OWNER, draft: false };

// ---- risk classification -------------------------------------------------
test('docs-only and test-only additions are low risk', () => {
  assert.equal(g.classify({ ...base, files: [f('README.md'), f('docs/guide.md')] }).risk, 'low');
  assert.equal(g.classify({ ...base, files: [f('src/foo.test.ts', "+it('works', () => { expect(1).toBe(1) })")] }).risk, 'low');
});

test('protected paths, code, removed or skipped tests are normal risk', () => {
  for (const p of ['.github/workflows/ci.yml', 'AGENTS.md', 'CLAUDE.md', '.ops.yml', 'docs/vision.md', 'docs/decisions/0001-x.md', 'specs/reveal.md']) {
    assert.equal(g.classify({ ...base, files: [f(p)] }).risk, 'normal', p);
  }
  assert.equal(g.classify({ ...base, files: [f('src/app.ts'), f('README.md')] }).risk, 'normal');
  assert.equal(g.classify({ ...base, files: [f('tests/test_a.py', '-    assert x == 1')] }).risk, 'normal');
  assert.equal(g.classify({ ...base, files: [f('e2e/a.spec.ts', "+test.skip('flaky', () => {})")] }).risk, 'normal');
  assert.equal(g.classify({ ...base, files: [f('src/a.test.ts', '', { status: 'removed' })] }).risk, 'normal');
});

test('Dependabot: only pure patch bumps of manifests by Dependabot are low (Codex P1 #4)', () => {
  const dep = { ...base, author: 'dependabot[bot]', title: 'Bump vite from 5.4.1 to 5.4.9', commitAuthors: ['dependabot[bot]'] };
  assert.equal(g.classify({ ...dep, files: [f('package.json'), f('package-lock.json')] }).risk, 'low');
  assert.equal(g.classify({ ...dep, title: 'Bump anthropic from 1.8.0 to 2.3.0', files: [f('requirements.txt')] }).risk, 'normal');
  assert.equal(g.classify({ ...dep, commitAuthors: ['dependabot[bot]', OWNER], files: [f('package.json')] }).risk, 'normal');
  assert.equal(g.classify({ ...dep, files: [f('package.json'), f('src/app.ts')] }).risk, 'normal');
});

test('dead-code: deletions only is low; whole-file deletion or additions is normal', () => {
  const labels = ['type:dead-code'];
  assert.equal(g.classify({ ...base, labels, files: [f('src/a.ts', '-old', { additions: 0 })] }).risk, 'low');
  assert.equal(g.classify({ ...base, labels, files: [f('src/a.ts', '', { status: 'removed', additions: 0 })] }).risk, 'normal');
  assert.equal(g.classify({ ...base, labels, files: [f('src/a.ts', '+new')] }).risk, 'normal');
});

// ---- review evidence -------------------------------------------------------
test('Codex summary: only a completed clean review of the head clears', () => {
  const r = (fb) => g.reviewState({ ...base, feedback: fb });
  assert.equal(r([codex('H')]), 'clear');
  assert.equal(r([codex('H', null, 'running')]), 'missing');
  assert.equal(r([codex('H', true)]), 'blocking');
  for (const st of ['failed', 'cancelled', 'error', '']) assert.equal(r([codex('H', false, st)]), 'missing', st || '(none)');
  assert.equal(r([codex('OLD')]), 'missing');
});

test('a stale Codex summary neither clears nor blocks a fresh Claude verdict', () => {
  assert.equal(g.reviewState({ ...base, feedback: [codex('OLD', true), claudeVerdict('H')] }), 'clear');
});

test('arbitrary bot comments, reactions and "starting review" never count (Codex P1 #5)', () => {
  const r = (fb) => g.reviewState({ ...base, feedback: fb });
  assert.equal(r([{ author: 'claude[bot]', body: 'Starting review' }]), 'missing');
  assert.equal(r([{ author: 'chatgpt-codex-connector[bot]', body: '' }]), 'missing');
  assert.equal(r([claudeVerdict('OLD')]), 'missing');
  assert.equal(r([claudeVerdict('H', 'clear', OWNER)]), 'missing');
});

test('review:clear label no longer bypasses review (Codex P1 #3)', () => {
  assert.equal(g.reviewState({ ...base, labels: ['review:clear'], feedback: [] }), 'missing');
});

test('P0/P1 line findings: Claude ones block; Codex ones defer to its summary (so resolving works)', () => {
  const finding = { author: 'claude[bot]', commitId: 'H', body: '![P1 Badge](https://img.shields.io/badge/P1-orange)' };
  assert.equal(g.reviewState({ ...base, feedback: [codex('H'), finding] }), 'blocking');
  assert.equal(g.reviewState({ ...base, feedback: [codex('H'), { ...finding, commitId: 'OLD' }] }), 'clear');
  const codexFinding = { ...finding, author: 'chatgpt-codex-connector[bot]' };
  assert.equal(g.reviewState({ ...base, feedback: [codex('H', false), codexFinding] }), 'clear'); // thread resolved
  assert.equal(g.reviewState({ ...base, feedback: [codex('H', true), codexFinding] }), 'blocking');
  assert.equal(g.reviewState({ ...base, labels: ['review:blocking'] }), 'blocking');
});

test('review:override: owner can overrule blocking findings for the current commit only', () => {
  const ov = (at, extra = {}) => ({ event: 'labeled', label: 'review:override', actor: OWNER, viaApp: false, at, ...extra });
  const blocked = { ...base, files: [f('README.md')], feedback: [codex('H', true)], labels: ['review:override'] };
  assert.equal(g.decide({ ...blocked, labelEvents: [ov('2026-11-06T10:05:00Z')] }).state, 'success');
  assert.equal(g.decide({ ...blocked, labelEvents: [ov('2026-11-06T09:00:00Z')] }).state, 'failure'); // older commit
  assert.equal(g.decide({ ...blocked, labelEvents: [ov('2026-11-06T10:05:00Z', { viaApp: true })] }).state, 'failure'); // agent
  // Override does not replace approval for risk:normal PRs:
  const code = { ...base, feedback: [codex('H', true)], labels: ['review:override'], labelEvents: [ov('2026-11-06T10:05:00Z')] };
  assert.equal(g.decide(code).state, 'pending');
  assert.equal(g.decide({ ...code, labels: ['review:override', 'human-approved'], labelEvents: [ov('2026-11-06T10:05:00Z'), label('2026-11-06T10:06:00Z')] }).state, 'success');
});

// ---- approval ---------------------------------------------------------------
test('approval: owner label after this PR adopted the head approves', () => {
  assert.equal(g.humanApproved({ ...base, labels: ['human-approved'], labelEvents: [label('2026-11-06T10:05:00Z')] }), true);
});

test('approval: label before this PR adopted the head (i.e. for an older commit) does not', () => {
  assert.equal(g.humanApproved({ ...base, labels: ['human-approved'], labelEvents: [label('2026-11-06T09:55:00Z')] }), false);
  assert.equal(g.humanApproved({ ...base, labels: ['human-approved'], labelEvents: [label('2026-11-06T10:05:00Z')], headAdoptedAt: undefined }), false);
});

test('approval: label added via an app (agent), or an agent re-adding it last, does not', () => {
  const labels = ['human-approved'];
  assert.equal(g.humanApproved({ ...base, labels, labelEvents: [label('2026-11-06T10:05:00Z', { viaApp: true })] }), false);
  assert.equal(g.humanApproved({ ...base, labels, labelEvents: [label('2026-11-06T10:05:00Z'), label('2026-11-06T10:06:00Z', { viaApp: true })] }), false);
});

test('approval: a force push voids earlier approval, but re-approving afterwards works (Codex P1)', () => {
  const input = { ...base, labels: ['human-approved'], labelEvents: [label('2026-11-06T10:05:00Z')] };
  assert.equal(g.humanApproved({ ...input, forcePushTimes: ['2026-11-06T10:10:00Z'] }), false);
  assert.equal(g.humanApproved({ ...input, forcePushTimes: ['2026-11-06T09:00:00Z'] }), true);
  const relabelled = { ...input, labelEvents: [label('2026-11-06T10:05:00Z'), { event: 'unlabeled', label: 'human-approved', actor: OWNER, at: '2026-11-06T10:11:00Z' }, label('2026-11-06T10:12:00Z')] };
  assert.equal(g.humanApproved({ ...relabelled, forcePushTimes: ['2026-11-06T10:10:00Z'] }), true);
});

// ---- decisions --------------------------------------------------------------
test('decide: end-to-end outcomes', () => {
  const docs = { ...base, files: [f('README.md')] };
  assert.equal(g.decide({ ...docs, feedback: [] }).state, 'pending');
  assert.equal(g.decide(docs).state, 'success');
  assert.equal(g.decide({ ...docs, draft: true }).state, 'pending');
  assert.equal(g.decide(base).state, 'pending');
  assert.equal(g.decide({ ...base, labels: ['human-approved'], labelEvents: [label('2026-11-06T10:05:00Z')] }).state, 'success');
  assert.match(g.decide({ ...base, labels: ['human-approved'], labelEvents: [label('2026-11-06T09:00:00Z')] }).description, /predates/);
  assert.equal(g.decide({ ...base, feedback: [codex('H', true)], labels: ['human-approved'], labelEvents: [label('2026-11-06T10:05:00Z')] }).state, 'failure');
  const dep = { ...base, author: 'dependabot[bot]', title: 'Bump a from 1.2.3 to 1.2.4', commitAuthors: ['dependabot[bot]'], files: [f('package.json')] };
  assert.equal(g.decide({ ...dep, feedback: [] }).state, 'pending');
  assert.equal(g.decide(dep).state, 'success');
});

// ---- agent-safe tier (portfolio-ops decision 0005) -----------------------
const OPS = `app: x
agent_safe: true   # on for this repo
agent_max_lines: 300
sensitive_paths:
  - "src/auth/**"
  - db/migrations/
pivotal_paths: ["src/routes/reveal/**"]
`;
const policy = g.parseOpsPolicy(OPS);
const queued = { number: 7, state: 'open', labels: ['ready', 'agent:claude'] };
const agentPr = { ...base, headRef: 'claude/7', policy, issue: queued, files: [f('src/app.ts', '+x', { additions: 20, deletions: 5 })] };

test('agent-safe: .ops.yml policy is parsed, off by default', () => {
  assert.deepEqual(policy, { agentSafe: true, maxLines: 300, sensitive: ['src/auth/**', 'db/migrations/'], pivotal: ['src/routes/reveal/**'] });
  assert.equal(g.parseOpsPolicy('app: x\n').agentSafe, false);
  assert.equal(g.parseOpsPolicy('').maxLines, 400);
});

test('agent-safe: globs match paths and directories', () => {
  assert.ok(g.globToRegExp('src/auth/**').test('src/auth/a/b.ts'));
  assert.ok(g.globToRegExp('db/migrations/').test('db/migrations/001.sql'));
  assert.ok(g.globToRegExp('*.sql').test('a.sql'));
  assert.ok(!g.globToRegExp('*.sql').test('dir/a.sql'));
  assert.ok(!g.globToRegExp('src/auth/**').test('src/authz.ts'));
});

test('agent-safe: linked issue from branch or Closes line', () => {
  assert.equal(g.linkedIssue('claude/12', ''), 12);
  assert.equal(g.linkedIssue('codex/fix-map', 'Closes #34\n...'), 34);
  assert.equal(g.linkedIssue('feature/x', 'nothing'), null);
});

test('agent-safe: a small agent PR for a queued issue is risk:agent and passes once reviewed', () => {
  assert.equal(g.classify(agentPr).risk, 'agent');
  const d = g.decide(agentPr);
  assert.equal(d.state, 'success');
  assert.match(d.description, /agent-safe/);
  assert.equal(g.decide({ ...agentPr, feedback: [] }).state, 'pending');
  assert.equal(g.decide({ ...agentPr, feedback: [codex('H', true)] }).state, 'failure');
});

test('agent-safe: each condition falls back to risk:normal', () => {
  const normal = (over) => g.classify({ ...agentPr, ...over }).risk;
  assert.equal(normal({ policy: g.parseOpsPolicy('app: x') }), 'normal');
  assert.equal(normal({ policy: null }), 'normal');
  assert.equal(normal({ headRef: 'feature/7' }), 'normal');
  assert.equal(normal({ issue: null }), 'normal');
  assert.equal(normal({ issue: { ...queued, state: 'closed' } }), 'normal');
  assert.equal(normal({ issue: { ...queued, labels: ['agent:claude'] } }), 'normal');
  assert.equal(normal({ issue: { ...queued, labels: ['ready', 'pivotal'] } }), 'normal');
  assert.equal(normal({ files: [f('src/auth/login.ts')] }), 'normal');
  assert.equal(normal({ files: [f('src/routes/reveal/+page.svelte')] }), 'normal');
  assert.equal(normal({ files: [f('package.json')] }), 'normal');
  assert.equal(normal({ files: [f('src/old.ts', '', { status: 'removed' })] }), 'normal');
  assert.equal(normal({ files: [f('src/a.test.ts', "-it('works', () => {})")] }), 'normal');
  assert.equal(normal({ files: [f('src/a.ts', '+x', { additions: 250, deletions: 51 })] }), 'normal');
  assert.equal(normal({ files: [f('.github/workflows/ci.yml')] }), 'normal');
  assert.equal(normal({ files: [f('AGENTS.md')] }), 'normal');
});

test('agent-safe: in-progress issue still counts as queued; tests added alongside code are fine', () => {
  assert.equal(g.classify({ ...agentPr, issue: { ...queued, labels: ['in-progress'] } }).risk, 'agent');
  assert.equal(g.classify({ ...agentPr, files: [f('src/a.ts'), f('src/a.test.ts', "+it('x', () => {})")] }).risk, 'agent');
});
