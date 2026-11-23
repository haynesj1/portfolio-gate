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
  for (const p of ['.github/workflows/ci.yml', 'AGENTS.md', 'CLAUDE.md', '.ops.yml', 'docs/vision.md', 'docs/features.json', 'docs/decisions/0001-x.md', 'specs/reveal.md']) {
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

test('agent-safe: comments and blank lines inside a path list keep the list going (Codex P1)', () => {
  const p = g.parseOpsPolicy(`agent_safe: true
sensitive_paths:
  - "src/auth/**"

  # payments too
  - src/payments/**   # trailing comment
pivotal_paths:
  - src/routes/reveal/**
`);
  assert.deepEqual(p.sensitive, ['src/auth/**', 'src/payments/**']);
  assert.deepEqual(p.pivotal, ['src/routes/reveal/**']);
  assert.equal(p.agentSafe, true);
  assert.equal(g.classify({ ...agentPr, policy: p, files: [f('src/payments/charge.ts')] }).risk, 'normal');
});

test('agent-safe: unreadable policy syntax turns the tier off (fail closed)', () => {
  assert.equal(g.parseOpsPolicy('agent_safe: true\nsensitive_paths:\n  - a/**\n  b/**\n').agentSafe, false);
  assert.equal(g.parseOpsPolicy('agent_safe: true\nsensitive_paths: a/**\n').agentSafe, false);
  assert.equal(g.parseOpsPolicy('agent_safe: true\nsensitive_paths:\n  - a/**\nagent_max_lines: 200\n').maxLines, 200);
});

test('renames are judged on both the old and the new path (Codex P1)', () => {
  const ren = (from, to) => f(to, '+x', { status: 'renamed', previous_filename: from });
  const c = (files) => g.classify({ ...agentPr, files }).risk;
  assert.equal(c([ren('src/auth/login.ts', 'src/login.ts')]), 'normal');
  assert.equal(c([ren('src/login.ts', 'src/auth/login.ts')]), 'normal');
  assert.equal(c([ren('src/routes/reveal/a.svelte', 'src/a.svelte')]), 'normal');
  assert.equal(c([ren('.github/workflows/ci.yml', 'ci.yml')]), 'normal');
  assert.equal(c([ren('src/a.ts', 'src/b.ts')]), 'agent');
  // docs tier: code renamed into docs is not a docs change
  assert.equal(g.classify({ ...base, files: [ren('src/x.ts', 'docs/x.md')] }).risk, 'normal');
  assert.equal(g.classify({ ...base, files: [ren('docs/a.md', 'docs/b.md')] }).risk, 'low');
});

test('docs/features.json is protected: added, modified, removed, renamed, or alongside an agent-safe change (#17)', () => {
  const FJ = 'docs/features.json';
  const ren = (from, to) => f(to, '+x', { status: 'renamed', previous_filename: from });
  for (const status of ['added', 'modified', 'removed']) {
    const r = g.classify({ ...base, files: [f(FJ, '+x', { status })] });
    assert.equal(r.risk, 'normal', status);
    assert.deepEqual(r.reasons, [`protected path ${FJ}`], status);
  }
  assert.equal(g.classify({ ...base, files: [ren('docs/checklist.json', FJ)] }).risk, 'normal');
  assert.equal(g.classify({ ...base, files: [ren(FJ, 'docs/old-features.json')] }).risk, 'normal');
  assert.equal(g.classify({ ...base, files: [ren(FJ, 'docs/old-features.json')] }).reasons[0], `protected path ${FJ}`);
  // an agent PR that is otherwise risk:agent
  assert.equal(g.classify({ ...agentPr, files: [...agentPr.files, f(FJ)] }).risk, 'normal');
  assert.equal(descOf({ files: [...agentPr.files, f(FJ)] }), `${WAIT} — protected path ${FJ}`);
  // other files under docs/ are unchanged
  assert.equal(g.classify({ ...base, files: [f('docs/guide.md'), f('docs/data.json')] }).risk, 'low');
  assert.equal(g.classify({ ...base, files: [f('docs/features.json.bak')] }).risk, 'low');
  assert.equal(g.classify({ ...base, files: [f('docs/sub/features.json')] }).risk, 'low');
  assert.equal(g.classify({ ...base, files: [f('docs/guide.md', '', { status: 'removed' })] }).risk, 'normal');
  assert.equal(g.classify({ ...agentPr, files: [...agentPr.files, f('docs/guide.md')] }).risk, 'agent');
});

// ---- second review for Codex PRs (portfolio-ops decision 0006) ------------
const verdictBy = (author, sha, result) => ({ author, body: `<!-- review-verdict:v1 {"commit_sha":"${sha}","result":"${result}"} -->` });
const codexPr = { ...agentPr, headRef: 'codex/7' };

test('codex PRs need a Claude review-verdict for the head commit as well as Codex', () => {
  assert.equal(g.decide(codexPr).state, 'pending');
  assert.match(g.decide(codexPr).description, /waiting for the Claude review/);
  assert.equal(g.decide({ ...codexPr, feedback: [codex('H'), verdictBy(OWNER, 'H', 'clear')] }).state, 'success');
  assert.equal(g.decide({ ...codexPr, feedback: [codex('H'), verdictBy('claude[bot]', 'H', 'clear')] }).state, 'success');
  // verdict for an older commit doesn't count; a blocking one fails
  assert.equal(g.decide({ ...codexPr, feedback: [codex('H'), verdictBy(OWNER, 'OLD', 'clear')] }).state, 'pending');
  assert.equal(g.decide({ ...codexPr, feedback: [codex('H'), verdictBy(OWNER, 'H', 'blocking')] }).state, 'failure');
  // Codex's own review is still required
  assert.equal(g.decide({ ...codexPr, feedback: [verdictBy(OWNER, 'H', 'clear')] }).state, 'pending');
  // someone else's verdict doesn't count
  assert.equal(g.decide({ ...codexPr, feedback: [codex('H'), verdictBy('someone', 'H', 'clear')] }).state, 'pending');
});

test('owner-account verdicts count only on codex/ PRs; Claude PRs are unchanged', () => {
  assert.equal(g.secondReview({ headRef: 'claude/7', feedback: [], headSha: 'H', owner: OWNER }), 'not-needed');
  assert.equal(g.decide(agentPr).state, 'success');
  // an owner "clear" can't stand in for Codex's review on a Claude PR
  assert.equal(g.decide({ ...agentPr, feedback: [verdictBy(OWNER, 'H', 'clear')] }).state, 'pending');
});

test('review:override by the owner overrules a blocking Claude review of a Codex PR', () => {
  const over = { ...codexPr, labels: ['review:override'], feedback: [codex('H'), verdictBy(OWNER, 'H', 'blocking')], labelEvents: [{ event: 'labeled', label: 'review:override', actor: OWNER, viaApp: false, at: '2026-11-06T11:00:00Z' }] };
  assert.equal(g.decide(over).state, 'success');
});

test('the owner approving a Codex PR stands in for a missing Claude review, not for Codex', () => {
  const approvedPr = { ...codexPr, labels: ['human-approved'], labelEvents: [label('2026-11-06T11:00:00Z')] };
  assert.equal(g.decide(approvedPr).state, 'success');
  assert.equal(g.decide({ ...approvedPr, feedback: [] }).state, 'pending');
  assert.equal(g.decide({ ...approvedPr, feedback: [codex('H'), verdictBy(OWNER, 'H', 'blocking')] }).state, 'failure');
});

// ---- second-round Codex findings --------------------------------------------
test('renaming a test out of test discovery is not agent-safe (Codex P2)', () => {
  const ren = (from, to, patch = '+x') => f(to, patch, { status: 'renamed', previous_filename: from });
  const c = (files) => g.classify({ ...agentPr, files }).risk;
  assert.equal(c([ren('tests/auth.test.ts', 'src/helper.ts')]), 'normal');
  assert.equal(c([ren('src/a.test.ts', 'src/b.test.ts', "-it('x', () => {})")]), 'normal');
  assert.equal(c([ren('src/a.test.ts', 'src/b.test.ts')]), 'low'); // a plain test rename is already low risk
});

test('indentless YAML list items are read; stray lines turn the tier off (Codex P1)', () => {
  const p = g.parseOpsPolicy('agent_safe: true\nsensitive_paths:\n- src/auth/**\n- "db/"\npivotal_paths:\n- src/reveal/**\n');
  assert.deepEqual(p.sensitive, ['src/auth/**', 'db/']);
  assert.deepEqual(p.pivotal, ['src/reveal/**']);
  assert.equal(g.classify({ ...agentPr, policy: p, files: [f('src/auth/login.ts')] }).risk, 'normal');
  assert.equal(g.parseOpsPolicy('agent_safe: true\nsensitive_paths:\n- a/**\nnot a key\n').agentSafe, false);
});

test('on a Codex PR a Claude verdict alone never stands in for Codex review (Codex P2)', () => {
  const only = { ...codexPr, feedback: [verdictBy('claude[bot]', 'H', 'clear')] };
  assert.equal(g.reviewState(only), 'missing');
  assert.equal(g.decide(only).state, 'pending');
  assert.equal(g.decide({ ...codexPr, feedback: [codex('H'), verdictBy('claude[bot]', 'H', 'clear')] }).state, 'success');
  // Claude PRs: a claude[bot] verdict still counts as a review, as before
  assert.equal(g.reviewState({ ...agentPr, feedback: [verdictBy('claude[bot]', 'H', 'clear')] }), 'clear');
});

// ---- third-round Codex findings ---------------------------------------------
test('policy parser is an allowlist: quoted keys or other odd lines turn the tier off (Codex P2)', () => {
  assert.equal(g.parseOpsPolicy('agent_safe: true\n"sensitive_paths":\n  - src/auth/**\n').agentSafe, false);
  assert.equal(g.parseOpsPolicy('agent_safe: true\n  sensitive_paths:\n  - src/auth/**\n').agentSafe, false);
  assert.equal(g.parseOpsPolicy('agent_safe: true\nagent_max_lines: lots\n').agentSafe, false);
  // the real .ops.yml files (flow maps, inline comments) still parse
  const real = `# header
app: london-living-app
web: true
install: cd app && npm ci
data: { fetch: scripts/fetch_app_data.sh, into: data/processed/discovery }
coverage: ./gradlew testDebugUnitTest  # Kover/JaCoCo to be added
dead_code: { tool: knip, paths: [app], ignore: ["app/src/routes/**"] }
agent_safe: true
sensitive_paths:
  - "src/auth/**"
pivotal_paths: [src/routes/reveal/**]
`;
  const p = g.parseOpsPolicy(real);
  assert.equal(p.agentSafe, true);
  assert.deepEqual([p.sensitive, p.pivotal], [['src/auth/**'], ['src/routes/reveal/**']]);
});

test('on a Codex PR, overriding a blocking Claude verdict never stands in for Codex review (Codex P2)', () => {
  const overrideEvents = [{ event: 'labeled', label: 'review:override', actor: OWNER, viaApp: false, at: '2026-11-06T11:00:00Z' }];
  const noCodex = { ...codexPr, labels: ['review:override'], labelEvents: overrideEvents, feedback: [verdictBy('claude[bot]', 'H', 'blocking')] };
  assert.equal(g.reviewState(noCodex), 'missing');
  assert.equal(g.decide(noCodex).state, 'pending');
  // with Codex clear, the same override does overrule the Claude block
  assert.equal(g.decide({ ...noCodex, feedback: [codex('H'), verdictBy('claude[bot]', 'H', 'blocking')] }).state, 'success');
  // without the override, a blocking Claude verdict fails a Codex-cleared PR
  assert.equal(g.decide({ ...codexPr, feedback: [codex('H'), verdictBy('claude[bot]', 'H', 'blocking')] }).state, 'failure');
});

test('on a Codex PR, a claude[bot] P0/P1 line finding blocks through the second review', () => {
  const line = { author: 'claude[bot]', commitId: 'H', body: '![P1 Badge](https://img.shields.io/badge/P1-orange) problem' };
  assert.equal(g.secondReview({ headRef: 'codex/7', feedback: [line, verdictBy('claude[bot]', 'H', 'clear')], headSha: 'H', owner: OWNER }), 'blocking');
  assert.equal(g.decide({ ...codexPr, feedback: [codex('H'), line, verdictBy(OWNER, 'H', 'clear')] }).state, 'failure');
});

test('lockfiles and package-manager config are never agent-safe (Codex P2)', () => {
  for (const name of ['npm-shrinkwrap.json', 'app/npm-shrinkwrap.json', 'bun.lockb', 'poetry.lock', 'go.sum', 'Cargo.lock', '.npmrc', '.yarnrc.yml', 'pnpm-workspace.yaml', '.nvmrc', 'gradle/wrapper/gradle-wrapper.properties', 'settings.gradle.kts']) {
    assert.equal(g.classify({ ...agentPr, files: [f(name, '+x', { additions: 50 })] }).risk, 'normal', name);
  }
  // the Dependabot path still only accepts real manifests
  assert.equal(g.classify({ author: 'dependabot[bot]', title: 'Bump x from 1.2.3 to 1.2.4', labels: [], commitAuthors: ['dependabot[bot]'], files: [f('.npmrc')] }).risk, 'normal');
  assert.equal(g.classify({ author: 'dependabot[bot]', title: 'Bump x from 1.2.3 to 1.2.4', labels: [], commitAuthors: ['dependabot[bot]'], files: [f('npm-shrinkwrap.json')] }).risk, 'low');
});

test('test removals are caught in any language and any file (Codex P2)', () => {
  const c = (filename, patch) => g.classify({ ...agentPr, files: [f(filename, patch, { additions: 0, deletions: 5 })] }).risk;
  assert.equal(c('internal/auth/login_test.go', '-func TestRejectInvalidToken(t *testing.T) {'), 'normal');
  assert.equal(c('internal/auth/login.go', '-\tif err != nil { t.Fatal(err) }'), 'normal');
  assert.equal(c('src/lib.rs', '-#[test]'), 'normal');
  assert.equal(c('spec/user_spec.rb', "-  it 'works' do"), 'normal');
  assert.equal(c('app/src/main/FooTest.kt', '-    @Test fun works() {}'), 'normal');
  assert.equal(c('src/thing.go', '+\tt.Skip("later")'), 'normal');
  assert.equal(c('src/a.py', '+@pytest.mark.xfail'), 'normal');
  // ordinary code edits still qualify
  assert.equal(c('src/app.ts', '-const x = 1;\n+const x = 2;'), 'agent');
  // Go test files are recognised as tests (added tests alone are low risk)
  assert.equal(g.classify({ ...base, files: [f('pkg/a_test.go', '+func TestNew(t *testing.T) {}')] }).risk, 'low');
});

test('the removed-test backstop skips Markdown files outside test paths', () => {
  const code = f('src/app.ts', '-const x = 1;\n+const x = 2;');
  const run = (file) => g.classify({ ...agentPr, files: [code, file] });
  const ren = (from, to, patch) => f(to, patch, { status: 'renamed', previous_filename: from });
  // Markdown outside test paths: prose that looks like a test line is not counted
  assert.equal(run(f('docs/guide.md', '-  "context": {')).risk, 'agent');
  assert.equal(run(f('notes.md', '-We assert that the cache is warm.')).risk, 'agent');
  assert.equal(run(f('docs/guide.md', '+The review is pending')).risk, 'agent');
  assert.equal(run(ren('docs/a.md', 'docs/b.md', '-  "context": {')).risk, 'agent');
  // the backstop still applies to everything else
  const kept = (file, why) => { const r = run(file); assert.equal(r.risk, 'normal'); assert.equal(r.agentWhy, why); };
  // (issue #6: the reason is now the PR-wide count, not the file name)
  const fell = 'tests fell from the diff: 1 removed, 0 added';
  kept(f('src/a.ts', '-  "context": {'), fell);
  kept(f('docs/example.rs', '-  "context": {'), fell);
  kept(ren('src/a.rs', 'notes.md', '-#[test]'), fell);
  kept(ren('notes.md', 'src/a.rs', '-#[test]'), fell);
  kept(f('notes.MD', '-#[test]'), fell);
  kept(f('tests/README.md', "-it('works', () => {})"), fell);
  kept(f('docs/decisions/0009-x.md', '-  "context": {'), 'protected path docs/decisions/0009-x.md');
});

// ---- counted tests and assertions (issue #6) --------------------------------
const run6 = (...files) => g.classify({ ...agentPr, files });
const isAgent = (...files) => { const r = run6(...files); assert.equal(r.risk, 'agent', r.agentWhy); };
const keptOut = (why, ...files) => { const r = run6(...files); assert.equal(r.risk, 'normal'); assert.equal(r.agentWhy, why); };
const ren6 = (from, to, patch = '+x') => f(to, patch, { status: 'renamed', previous_filename: from });
const realTest = "-it('doubles', () => {\n-  expect(double(2)).toBe(4);\n-});";

test('counting: each kind is counted on its own, and a removed line is counted wherever REMOVED_TEST_LINE matches', () => {
  assert.deepEqual(g.countTestLines("-it('a', () => {\n-  expect(a).toBe(1);\n+it('b', () => expect(b).toBe(2));\n+const x = 1;"),
    { tests: { removed: 1, added: 1 }, assertions: { removed: 1, added: 1 } });
  const lines = ["it('x'", 'test("x"', "describe('x'", "context 'x'", 'def test_x():', '@Test fun x()', 'func TestX(t *testing.T) {', '#[test]', '#[tokio::test]',
    't.Run("x", f)', 'expect(x)', 'expect { x }', 'assert x == 1', 'assert_eq!(a, b)', 't.Errorf("x")', 't.Fatal(err)', 'XCTAssertEqual(a, b)', 'require.NoError(t, err)',
    '"context": {', 'if (/x/.test(s))', 'const y = 1;', '--x'];
  for (const l of lines) {
    const n = g.countTestLines(`-${l}`);
    assert.equal(n.tests.removed + n.assertions.removed > 0, g.REMOVED_TEST_LINE.test(`-${l}`), l);
  }
  // CRLF patches split the same way
  assert.equal(g.countTestLines("-it('a')\r\n-it('b')\r\n").tests.removed, 2);
});

test('counting: an edited assertion, a renamed test, or a test moved between files is risk:agent', () => {
  isAgent(f('src/a.test.ts', '-  expect(x).toBe(1);\n+  expect(x).toBe(2);'));
  isAgent(f('src/a.test.ts', "-it('adds one', () => {\n+it('adds one to a number', () => {"));
  isAgent(f('tests/test_a.py', '-def test_old_name():\n+def test_new_name():'));
  isAgent(f('src/a.test.ts', realTest), f('src/b.test.ts', "+it('doubles', () => {\n+  expect(double(2)).toBe(4);\n+});"));
  // the PR that prompted the issue: 1 test and 1 assertion removed, 5 and 10 added
  const added = Array.from({ length: 5 }, (_, i) => `+it('case ${i}', () => {\n+  expect(a${i}).toBe(1);\n+  expect(b${i}).toBe(2);\n+});`).join('\n');
  isAgent(f('src/a.test.ts', `${realTest}\n${added}`));
  // an edited inline Rust test balances within its own file
  isAgent(f('src/lib.rs', '-        assert_eq!(add(1, 1), 2);\n+        assert_eq!(add(2, 2), 4);'));
});

test('counting: a removed test, fewer assertions, a skip, a deleted or moved-out test file, or a removed inline #[test] is not risk:agent', () => {
  keptOut('tests fell from the diff: 1 removed, 0 added', f('src/a.test.ts', realTest));
  keptOut('assertions fell from the diff: 2 removed, 1 added', f('src/a.test.ts', '-  expect(a).toBe(1);\n-  expect(b).toBe(2);\n+  expect([a, b]).toEqual([1, 2]);'));
  keptOut('test skipped or narrowed in src/a.test.ts', f('src/a.test.ts', "-it('x', () => {\n+it.skip('x', () => {"));
  keptOut('test skipped or narrowed in src/a.test.ts', f('src/a.test.ts', "-it('x', () => {\n+xit('x', () => {"));
  keptOut('test file deleted: src/a.test.ts', f('src/a.test.ts', realTest, { status: 'removed', additions: 0 }));
  keptOut('test file moved out of tests: tests/a.test.ts', ren6('tests/a.test.ts', 'src/a.ts'));
  // still a test path, but no longer a name the runner finds (with a code change, so not risk:low)
  keptOut('test file moved out of tests: tests/a.test.ts', f('src/app.ts'), ren6('tests/a.test.ts', 'tests/a.ts'));
  keptOut('tests fell from the diff: 1 removed, 0 added', f('src/lib.rs', '-#[test]\n-fn adds() {\n-    assert_eq!(add(1, 1), 2);\n-}'));
  // a test moved into a file that is deleted elsewhere in the PR is still a deleted file
  keptOut('test file deleted: src/b.test.ts', f('src/a.test.ts', "+it('x', () => {})"), f('src/b.test.ts', "-it('x', () => {})", { status: 'removed' }));
});

test('counting: gaming the count', () => {
  const fell = 'tests fell from the diff: 1 removed, 0 added';
  // a removed real test offset by an added trivial assertion: the test count still falls
  keptOut(fell, f('src/a.test.ts', `${realTest}\n+  expect(true).toBe(true);`));
  // "tests" added in Markdown, in a file no runner executes, or in a fixture don't count
  keptOut(fell, f('src/a.test.ts', realTest), f('docs/notes.md', "+it('doubles', () => {\n+  expect(double(2)).toBe(4);"));
  keptOut(fell, f('src/a.test.ts', realTest), f('src/unused.ts', "+it('doubles', () => {\n+  expect(double(2)).toBe(4);"));
  keptOut(fell, f('src/a.test.ts', realTest), f('tests/notes.md', "+it('doubles', () => {\n+  expect(double(2)).toBe(4);"));
  keptOut(fell, f('src/a.test.ts', realTest), f('testdata/sample.test.js', "+it('doubles', () => {\n+  expect(double(2)).toBe(4);"));
  // ordinary code that matches the patterns never offsets a removed test
  keptOut(fell, f('src/a.test.ts', realTest), f('src/a.ts', '+if (/x/.test(s)) assert(ok);\n+  expect(y);'));
  keptOut(fell, f('src/lib.rs', '-#[test]'), f('src/lib.rs', '+    let v = read().context("read failed")?;'));
  keptOut(fell, f('src/a.test.ts', `${realTest}\n+  expect(/x/.test(s)).toBe(true);`));
  // one kind never offsets the other
  keptOut('tests fell from the diff: 2 removed, 0 added', f('src/a.test.ts', "-it('a', () => {})\n-it('b', () => {})\n+  expect(a).toBe(1);\n+  expect(b).toBe(1);"));
  keptOut('assertions fell from the diff: 1 removed, 0 added', f('src/a.test.ts', "-  expect(a).toBe(1);\n+it('a', () => {})"));
  // a removed describe block counts its own line and every test in it
  const block = "-describe('suite', () => {\n-  it('a', () => {})\n-  it('b', () => {})\n-});";
  keptOut('tests fell from the diff: 3 removed, 2 added', f('src/a.test.ts', `${block}\n+it('c', () => {})\n+it('d', () => {})`));
  // comment lines don't count when added (they still count when removed)
  keptOut(fell, f('src/a.test.ts', "-it('a', () => {})\n+// it('a', () => {})"));
  keptOut('assertions fell from the diff: 1 removed, 0 added', f('tests/test_a.py', '-    assert x == 1\n+    # assert x == 1'));
  keptOut('tests fell from the diff: 1 removed, 0 added', f('src/a.test.ts', "-// it('a', () => {})"));
  // a rename cannot change which side counts
  keptOut(fell, ren6('src/a.rs', 'notes.md', '-#[test]'), f('src/b.test.ts', '+x'));
  keptOut('test file moved out of tests: src/b.test.ts', f('src/a.test.ts', realTest), ren6('src/b.test.ts', 'docs/b.md', "+it('doubles', () => {})"));
  keptOut(fell, f('src/a.test.ts', realTest), ren6('docs/b.md', 'src/b.md', "+it('doubles', () => {})"));
  // a file renamed into a runnable test name counts in full
  isAgent(f('src/a.test.ts', realTest), ren6('docs/b.md', 'src/b.test.ts', "+it('doubles', () => {\n+  expect(double(2)).toBe(4);"));
});

test('counting: what the count cannot tell (pinned so a change is deliberate)', () => {
  // a real test replaced by a trivial one in a runnable test file
  isAgent(f('src/a.test.ts', `${realTest}\n+it('works', () => {\n+  expect(true).toBe(true);\n+});`));
  // two removed tests offset by an added (empty) describe and one test
  isAgent(f('src/a.test.ts', "-it('a', () => {})\n-it('b', () => {})\n+describe('suite', () => {\n+  it('c', () => {})\n+});"));
});

test('counting: classifyFile and risk:low are unchanged by the count', () => {
  assert.equal(g.classify({ ...base, files: [f('src/a.test.ts', '-  expect(x).toBe(1);\n+  expect(x).toBe(2);')] }).risk, 'normal');
  assert.equal(g.classifyFile(f('src/a.test.ts', "-it('a', () => {})\n+it('b', () => {})")).why, 'test or assertion removed in src/a.test.ts');
  assert.equal(g.classify({ ...base, files: [f('src/a.test.ts', "+it('b', () => {})")] }).risk, 'low');
});

// ---- real app .ops.yml files (copied into gate/fixtures) -------------------
test('every real app .ops.yml parses: today without the tier, and with the proposed policy', () => {
  const fs = require('node:fs'); const path = require('node:path');
  const dir = path.join(__dirname, 'fixtures');
  for (const name of fs.readdirSync(dir)) {
    const p = g.parseOpsPolicy(fs.readFileSync(path.join(dir, name), 'utf8'));
    assert.equal(p.invalid, undefined, `${name}: ${p.invalid}`);
    assert.equal(p.agentSafe, name.includes('.agent-safe.'), name);
  }
  const london = g.parseOpsPolicy(fs.readFileSync(path.join(dir, 'london-living-app.agent-safe.ops.yml'), 'utf8'));
  assert.ok(london.sensitive.includes('app/src/lib/scoring/') && london.pivotal.includes('app/src/lib/components/QuizFlow.svelte'));
});

// ---- status description says which rule kept a PR out of risk:agent ------
const WAIT = 'risk:normal: waiting for human-approved';
const STALE = 'risk:normal: approval predates this commit; remove and re-add human-approved';
const descOf = (over) => g.decide({ ...agentPr, ...over }).description;

test('description: each agentSafe rule names itself after the unchanged fixed text', () => {
  const cases = [
    [{ policy: g.parseOpsPolicy('app: x') }, 'agent-safe tier not enabled for this repo'],
    [{ headRef: 'feature/7' }, 'not an agent branch'],
    [{ issue: null }, 'no linked issue'],
    [{ issue: { ...queued, state: 'closed' } }, 'linked issue is not open'],
    [{ issue: { ...queued, labels: ['agent:claude'] } }, 'linked issue was not queued (ready)'],
    [{ issue: { ...queued, labels: ['ready', 'pivotal'] } }, 'linked issue is pivotal'],
    [{ files: [f('package.json')] }, 'dependency or package-manager file package.json'],
    [{ files: [f('src/auth/login.ts')] }, 'sensitive path src/auth/login.ts'],
    [{ files: [f('src/routes/reveal/x.ts')] }, 'pivotal path src/routes/reveal/x.ts'],
    [{ files: [f('src/old.ts', '', { status: 'removed' })] }, 'file deleted: src/old.ts'],
    [{ files: [f('src/a.test.ts', "-it('works', () => {})")] }, 'tests fell from the diff: 1 removed, 0 added'],
    [{ files: [f('src/a.ts', '+x', { additions: 250, deletions: 51 })] }, '301 lines changed (cap 300)'],
  ];
  for (const [over, why] of cases) {
    assert.equal(g.classify({ ...agentPr, ...over }).agentWhy, why);
    assert.equal(descOf(over), `${WAIT} — ${why}`);
  }
});

test('description: protected path, dependabot and dead-code reasons come from classify', () => {
  assert.equal(descOf({ files: [f('.github/workflows/ci.yml')] }), `${WAIT} — protected path .github/workflows/ci.yml`);
  const dep = { ...base, author: 'dependabot[bot]', title: 'Bump a from 1.2.3 to 1.3.0', commitAuthors: ['dependabot[bot]'], files: [f('package.json')] };
  assert.equal(g.decide(dep).description, `${WAIT} — dependency change that is not a pure Dependabot patch bump`);
  const dead = { ...base, labels: ['type:dead-code'], files: [f('src/a.ts', '+x', { additions: 3 })] };
  assert.equal(g.decide(dead).description, `${WAIT} — dead-code PR adds lines or deletes whole files`);
});

test('description: non-agent branch, and the stale-approval text keeps its prefix', () => {
  assert.equal(g.decide({ ...base, headRef: 'feature/x', policy, issue: queued }).description, `${WAIT} — not an agent branch`);
  const stale = g.decide({ ...agentPr, policy: null, labels: ['human-approved'], labelEvents: [label('2026-11-06T09:00:00Z')] }).description;
  assert.equal(stale, `${STALE} — agent-safe tier not enabled for this repo`);
});

test('description: a long reason is shortened so the fixed text is never cut and the total is at most 140', () => {
  const long = `src/routes/reveal/${'deeply/'.repeat(20)}component.ts`;
  for (const [over, fixed] of [[{}, WAIT], [{ labels: ['human-approved'], labelEvents: [label('2026-11-06T09:00:00Z')] }, STALE]]) {
    const d = g.decide({ ...agentPr, ...over, files: [f(long)] }).description;
    assert.ok(d.length <= 140, `${d.length}`);
    assert.ok(d.startsWith(`${fixed} — pivotal path …`), d);
    assert.ok(d.endsWith('/component.ts'), d);
  }
  // A non-path reason is cut at its end with an ellipsis.
  const d = g.decide({ ...agentPr, issue: null, headRef: `claude/${'9'.repeat(200)}`, policy: g.parseOpsPolicy('app: x') }).description;
  assert.ok(d.length <= 140 && d.startsWith(WAIT));
});

test('description: risk:low, risk:agent and other descriptions are unchanged, agentWhy is null', () => {
  const low = g.decide({ ...base, files: [f('README.md')] });
  assert.equal(low.description, 'risk:low and reviewed');
  assert.equal(low.agentWhy, null);
  const agent = g.decide(agentPr);
  assert.equal(agent.description, 'risk:agent (agent-safe) and reviewed');
  assert.equal(agent.agentWhy, null);
  assert.equal(g.decide({ ...agentPr, feedback: [] }).description, 'Waiting for a completed review of this commit');
  assert.equal(g.decide({ ...agentPr, draft: true }).description, 'Draft PR');
});

test('a Codex review with unresolved findings (any severity) fails with the unresolved-findings text', () => {
  const d = g.decide({ ...base, feedback: [codex('H', true)] });
  assert.equal(d.state, 'failure');
  assert.equal(d.description, 'Reviewer has unresolved findings on this commit (or review:blocking)');
});

// ---- answered reviewer findings (issue #14) --------------------------------
const CODEX_BOT = 'chatgpt-codex-connector[bot]';
const UNRESOLVED = 'Reviewer has unresolved findings on this commit (or review:blocking)';
const ANSWERED_WAIT = 'risk:normal: waiting for human-approved — reviewer findings answered, not resolved';
const ANSWERED_OK = 'human-approved; reviewer findings answered, not resolved';
const NO_TIER = 'agent-safe tier not enabled for this repo';
// A Codex line finding (thread root) and a reply in its thread.
const cFinding = (id, commit = `C${id}`, at = '2026-11-06T09:00:00Z', p = 'P1') => ({
  author: CODEX_BOT, id, commitId: 'H', originalCommitId: commit, createdAt: at,
  body: `**![${p} Badge](https://img.shields.io/badge/${p}-orange?style=flat)** Problem ${id}`,
});
const cReply = (to, { at = '2026-11-06T09:30:00Z', author = OWNER, id = to + 1000, commit = 'C9' } = {}) => ({
  author, id, inReplyToId: to, commitId: 'H', originalCommitId: commit, createdAt: at, body: 'Fixed in a later commit.',
});
const sixAnswered = [1, 2, 3, 4, 5, 6].flatMap((i) => [cFinding(i), cReply(i)]);
const answeredPr = { ...base, feedback: [codex('H', true), ...sixAnswered] };
const approvedNow = { labels: ['human-approved'], labelEvents: [label('2026-11-06T10:05:00Z')] };
const expectState = (input, state, description) => {
  const d = g.decide(input);
  assert.equal(d.state, state);
  assert.equal(d.description, description);
  return d;
};

test('answered: six answered findings from earlier commits, risk:normal, not approved, waits for human-approved', () => {
  assert.equal(g.reviewState(answeredPr), 'answered');
  const d = expectState(answeredPr, 'pending', `${ANSWERED_WAIT} — ${NO_TIER}`);
  assert.equal(d.review, 'answered');
  assert.equal(d.risk, 'normal');
  // The agent-tier reason is appended where there is room, and shortened to fit 140 characters.
  expectState({ ...answeredPr, author: 'dependabot[bot]', title: 'Bump a from 1.2.3 to 1.3.0', commitAuthors: ['dependabot[bot]'], files: [f('package.json')] },
    'pending', `${ANSWERED_WAIT} — dependency change that is not a pure Dependabot patch bump`.slice(0, 139) + '…');
  const long = g.decide({ ...answeredPr, headRef: 'claude/7', policy, issue: queued, files: [f(`src/routes/reveal/${'deeply/'.repeat(20)}x.ts`)] }).description;
  assert.ok(long.length <= 140 && long.startsWith(`${ANSWERED_WAIT} — pivotal path …`), long);
});

test('answered: the same, approved for this commit, passes', () => {
  const d = expectState({ ...answeredPr, ...approvedNow }, 'success', ANSWERED_OK);
  assert.equal(d.review, 'answered');
  // an approval for an older commit does not
  expectState({ ...answeredPr, labels: ['human-approved'], labelEvents: [label('2026-11-06T09:00:00Z')] }, 'pending',
    `risk:normal: approval predates this commit; remove and re-add human-approved — ${NO_TIER}`);
});

test('answered: risk:agent and risk:low PRs fail as today, approved or not', () => {
  for (const pr of [{ ...agentPr, feedback: answeredPr.feedback }, { ...answeredPr, files: [f('README.md')] }]) {
    assert.equal(g.reviewState(pr), 'answered');
    expectState(pr, 'failure', UNRESOLVED);
    expectState({ ...pr, ...approvedNow }, 'failure', UNRESOLVED);
  }
  assert.equal(g.classify({ ...agentPr }).risk, 'agent');
  assert.equal(g.classify({ ...answeredPr, files: [f('README.md')] }).risk, 'low');
});

test('answered: one finding without a reply fails', () => {
  const fb = [codex('H', true), ...sixAnswered, cFinding(7)];
  expectState({ ...base, feedback: fb }, 'failure', UNRESOLVED);
  // any priority counts: an unanswered P2 or P3 thread, or one with no badge, keeps it red
  for (const p of ['P2', 'P3']) expectState({ ...base, feedback: [...fb.slice(0, -1), cFinding(7, 'C7', undefined, p)] }, 'failure', UNRESOLVED);
  expectState({ ...base, feedback: [...fb.slice(0, -1), { ...cFinding(7), body: 'Consider renaming this.' }] }, 'failure', UNRESOLVED);
});

test('answered: a reply only from an account that is not the owner fails', () => {
  for (const author of ['someone', 'claude[bot]', CODEX_BOT, 'github-actions[bot]']) {
    const fb = [codex('H', true), ...sixAnswered.filter((x) => x.id !== 1001), cReply(1, { author })];
    expectState({ ...base, feedback: fb }, 'failure', UNRESOLVED);
  }
  // no owner known: never answered
  expectState({ ...answeredPr, owner: undefined }, 'failure', UNRESOLVED);
});

test('answered: an owner comment posted before the finding, or outside its thread, fails', () => {
  const without1 = sixAnswered.filter((x) => x.id !== 1001);
  // a standalone owner line comment created before the finding (not in its thread)
  const before = { author: OWNER, id: 900, commitId: 'H', originalCommitId: 'C0', createdAt: '2026-11-06T08:00:00Z', body: 'Fixed.' };
  expectState({ ...base, feedback: [codex('H', true), ...without1, before] }, 'failure', UNRESOLVED);
  // a reply in the thread whose time is before the finding
  expectState({ ...base, feedback: [codex('H', true), ...without1, cReply(1, { at: '2026-11-06T08:59:00Z' })] }, 'failure', UNRESOLVED);
  // a reply with no time
  expectState({ ...base, feedback: [codex('H', true), ...without1, { ...cReply(1), createdAt: undefined }] }, 'failure', UNRESOLVED);
});

test('answered: an owner reply in a different thread does not answer this one', () => {
  const fb = [codex('H', true), cFinding(1), cFinding(2), cReply(1), cReply(1, { id: 2001 })];
  expectState({ ...base, feedback: fb }, 'failure', UNRESOLVED);
  // a reply to a comment that is not in the list (unknown parent) answers nothing
  expectState({ ...base, feedback: [codex('H', true), cFinding(1), cReply(999)] }, 'failure', UNRESOLVED);
});

test('answered: a Codex finding raised on the head commit fails, even with a reply', () => {
  expectState({ ...base, feedback: [codex('H', true), ...sixAnswered, cFinding(7, 'H'), cReply(7)] }, 'failure', UNRESOLVED);
  // Codex repeating itself in an old thread on the head commit blocks too
  const repeat = { ...cReply(1, { author: CODEX_BOT, id: 3001, commit: 'H', at: '2026-11-06T09:45:00Z' }), body: 'Still an issue.' };
  expectState({ ...base, feedback: [codex('H', true), ...sixAnswered, repeat, cReply(1, { id: 4001, at: '2026-11-06T09:50:00Z' })] }, 'failure', UNRESOLVED);
  // a Codex comment after the owner's reply needs a new owner reply
  const later = { ...repeat, originalCommitId: 'C9' };
  expectState({ ...base, feedback: [codex('H', true), ...sixAnswered, later] }, 'failure', UNRESOLVED);
  expectState({ ...base, feedback: [codex('H', true), ...sixAnswered, later, cReply(1, { id: 4001, at: '2026-11-06T09:50:00Z' })] }, 'pending', `${ANSWERED_WAIT} — ${NO_TIER}`);
  // a Codex finding with no original commit fails closed
  expectState({ ...base, feedback: [codex('H', true), { ...cFinding(1), originalCommitId: undefined }, cReply(1)] }, 'failure', UNRESOLVED);
  // a Codex review body on the head commit that carries a finding badge
  const review = { author: CODEX_BOT, commitId: 'H', body: '![P2 Badge](https://img.shields.io/badge/P2-yellow) General finding' };
  expectState({ ...base, feedback: [codex('H', true), ...sixAnswered, review] }, 'failure', UNRESOLVED);
  expectState({ ...base, feedback: [codex('H', true), ...sixAnswered, { ...review, commitId: 'C1' }] }, 'pending', `${ANSWERED_WAIT} — ${NO_TIER}`);
});

test('answered: a finding thread whose first comment is not by Codex does not count', () => {
  // an owner-account "finding" answered by the owner: no Codex finding threads at all
  const fake = { ...cFinding(1), author: OWNER };
  expectState({ ...base, feedback: [codex('H', true), fake, cReply(1)] }, 'failure', UNRESOLVED);
  // a thread started by someone else in which Codex comments keeps the gate red
  const codexIn = { ...cReply(1, { author: CODEX_BOT, id: 3001, at: '2026-11-06T09:10:00Z' }), body: 'P1 Badge still wrong' };
  expectState({ ...base, feedback: [codex('H', true), ...sixAnswered, { ...cFinding(50), author: 'someone' }, { ...codexIn, inReplyToId: 50 }, cReply(50)] }, 'failure', UNRESOLVED);
});

test('answered: Codex state for head not completed stays pending (or failure) as today', () => {
  expectState({ ...base, feedback: [codex('H', null, 'running'), ...sixAnswered] }, 'pending', 'Waiting for a completed review of this commit');
  // a not-completed state that already reports unresolved findings blocks, as today
  expectState({ ...base, feedback: [codex('H', true, 'running'), ...sixAnswered] }, 'failure', UNRESOLVED);
  // a completed blocking state next to a running one for the same head still blocks
  expectState({ ...base, feedback: [codex('H', true), codex('H', null, 'running'), ...sixAnswered] }, 'failure', UNRESOLVED);
});

test('answered: Codex state for an older commit only is no review of the head', () => {
  expectState({ ...base, feedback: [codex('OLD', true), ...sixAnswered] }, 'pending', 'Waiting for a completed review of this commit');
  // an older state next to the head's is ignored
  assert.equal(g.reviewState({ ...base, feedback: [codex('OLD', true), codex('H', true), ...sixAnswered] }), 'answered');
});

test('answered: review:blocking with all findings answered fails', () => {
  expectState({ ...answeredPr, labels: ['review:blocking'] }, 'failure', UNRESOLVED);
  expectState({ ...answeredPr, labels: ['review:blocking', 'human-approved'], labelEvents: [label('2026-11-06T10:05:00Z')] }, 'failure', UNRESOLVED);
});

test('answered: another reviewer bot\'s P0 on the head commit, or its blocking verdict, fails', () => {
  const p0 = { author: 'claude[bot]', commitId: 'H', body: '![P0 Badge](https://img.shields.io/badge/P0-red) broken' };
  expectState({ ...answeredPr, feedback: [...answeredPr.feedback, p0] }, 'failure', UNRESOLVED);
  expectState({ ...answeredPr, ...approvedNow, feedback: [...answeredPr.feedback, p0] }, 'failure', UNRESOLVED);
  expectState({ ...answeredPr, feedback: [...answeredPr.feedback, claudeVerdict('H', 'blocking')] }, 'failure', UNRESOLVED);
  // a Claude verdict for the head that is neither clear nor blocking keeps it blocked too
  expectState({ ...answeredPr, feedback: [...answeredPr.feedback, claudeVerdict('H', 'maybe')] }, 'failure', UNRESOLVED);
  // a clear Claude verdict does not stop the answered state
  assert.equal(g.reviewState({ ...answeredPr, feedback: [...answeredPr.feedback, claudeVerdict('H')] }), 'answered');
});

test('answered: Codex state with unresolved findings and no finding threads at all fails', () => {
  expectState({ ...base, feedback: [codex('H', true)] }, 'failure', UNRESOLVED);
  expectState({ ...base, feedback: [codex('H', true), { author: OWNER, body: 'All fixed.' }] }, 'failure', UNRESOLVED);
});

test('answered: on a codex/ PR it applies to the primary review only; the second review is unchanged', () => {
  const cpr = { ...answeredPr, headRef: 'codex/fix-x' };
  assert.equal(g.classify(cpr).risk, 'normal');
  expectState(cpr, 'pending', 'Codex PR: waiting for the Claude review of this commit');
  expectState({ ...cpr, feedback: [...cpr.feedback, verdictBy('claude[bot]', 'H', 'clear')] }, 'pending', `${ANSWERED_WAIT} — ${NO_TIER}`);
  expectState({ ...cpr, feedback: [...cpr.feedback, verdictBy(OWNER, 'H', 'blocking')] }, 'failure', 'Claude review of this Codex PR found P0/P1 issues');
  const line = { author: 'claude[bot]', commitId: 'H', body: '![P1 Badge](https://img.shields.io/badge/P1-orange) problem' };
  expectState({ ...cpr, ...approvedNow, feedback: [...cpr.feedback, line] }, 'failure', 'Claude review of this Codex PR found P0/P1 issues');
  // the owner's approval stands in for a missing Claude review, as today
  expectState({ ...cpr, ...approvedNow }, 'success', ANSWERED_OK);
  // a codex/ PR in the agent-safe tier fails as today
  expectState({ ...codexPr, feedback: [...answeredPr.feedback, verdictBy('claude[bot]', 'H', 'clear')] }, 'failure', UNRESOLVED);
});

test('answered: review:override behaves as today', () => {
  const ov = { event: 'labeled', label: 'review:override', actor: OWNER, viaApp: false, at: '2026-11-06T10:05:00Z' };
  const low = { ...answeredPr, files: [f('README.md')], labels: ['review:override'], labelEvents: [ov] };
  expectState(low, 'success', 'risk:low; review findings overridden by owner');
  expectState({ ...answeredPr, labels: ['review:override'], labelEvents: [ov] }, 'pending', `risk:normal: waiting for human-approved — ${NO_TIER}`);
  expectState({ ...answeredPr, labels: ['review:override', 'human-approved'], labelEvents: [ov, label('2026-11-06T10:06:00Z')] }, 'success', 'human-approved; review findings overridden by owner');
  expectState({ ...low, labelEvents: [{ ...ov, viaApp: true }] }, 'failure', UNRESOLVED);
});

test('answered: a draft PR stays a draft', () => {
  expectState({ ...answeredPr, draft: true }, 'pending', 'Draft PR');
});

// ---- approved copies (#19) -----------------------------------------------
const COPY = '.github/workflows/pr-gate.yml';
const DOC = 'AGENTS.md';
const START = '<!-- shared:start -->';
const END = '<!-- shared:end -->';
const BLOCK = `${START}\nShared rules.\n${END}`;
const BLOCK2 = `${START}\nShared rules, version two.\n${END}`;
const CALLER_TEXT = 'name: pr-gate\non: {}\n';
const BASE_DOC = `# Rules\n\nLocal text.\n\n${BLOCK}\n\nMore local text.\n`;
const HEAD_DOC = BASE_DOC.replace(BLOCK, BLOCK2);
const LIST = {
  files: [{ path: COPY, sha256: [g.copyHash(CALLER_TEXT)] }],
  blocks: [{ path: DOC, start: START, end: END, sha256: [g.copyHash(BLOCK2)] }],
};
const contentsOf = (obj) => new Map(Object.entries(obj));
const copyInput = (files, contents, list = LIST) => ({ ...base, files, approvedCopies: list, copyContents: contentsOf(contents) });
const WAIT_COPY = `${WAIT} — protected path ${COPY}`;

test('approved copies: a whole-file copy and a block copy are risk:low with "approved copy of <path>"', () => {
  const r = g.classify(copyInput([f(COPY)], { [COPY]: { head: CALLER_TEXT } }));
  assert.deepEqual(r, { risk: 'low', reasons: [`approved copy of ${COPY}`], agentWhy: null });
  assert.equal(g.classify(copyInput([f(COPY, '+x', { status: 'added' })], { [COPY]: { head: CALLER_TEXT } })).risk, 'low');
  const both = g.classify(copyInput([f(COPY), f(DOC)], { [COPY]: { head: CALLER_TEXT }, [DOC]: { head: HEAD_DOC, base: BASE_DOC } }));
  assert.deepEqual(both, { risk: 'low', reasons: [`approved copy of ${COPY}`, `approved copy of ${DOC}`], agentWhy: null });
  const d = g.decide(copyInput([f(COPY)], { [COPY]: { head: CALLER_TEXT } }));
  assert.equal(d.state, 'success');
  assert.equal(d.description, 'risk:low and reviewed');
});

test('approved copies: removed, renamed or other statuses are not approved copies', () => {
  for (const extra of [{ status: 'removed' }, { status: 'renamed', previous_filename: '.github/workflows/old.yml' }, { status: 'renamed', previous_filename: COPY }, { status: 'copied' }, { status: 'changed' }, { status: undefined }]) {
    const r = g.classify(copyInput([f(COPY, '+x', extra)], { [COPY]: { head: CALLER_TEXT } }));
    assert.equal(r.risk, 'normal', JSON.stringify(extra));
  }
});

test('approved copies: one other changed file puts the whole PR through the existing rules unchanged', () => {
  const contents = { [COPY]: { head: CALLER_TEXT } };
  for (const other of [f('README.md'), f('src/app.ts'), f('.github/workflows/ci.yml'), f('package.json')]) {
    const files = [f(COPY), other];
    assert.deepEqual(g.classify(copyInput(files, contents)), g.classify({ ...base, files }), other.filename);
    assert.equal(g.classify(copyInput(files, contents)).risk, 'normal');
  }
  // The same file listed twice in the PR's file list is not a copy either.
  assert.equal(g.classify(copyInput([f(COPY), f(COPY)], contents)).risk, 'normal');
});

test('approved copies: a listed path whose head matches no listed hash keeps the protected-path reason', () => {
  const r = g.classify(copyInput([f(COPY)], { [COPY]: { head: `${CALLER_TEXT}# extra\n` } }));
  assert.deepEqual(r.reasons[0], `protected path ${COPY}`);
  assert.equal(r.risk, 'normal');
  assert.equal(g.decide(copyInput([f(COPY)], { [COPY]: { head: `${CALLER_TEXT}x` } })).description, WAIT_COPY);
  // An empty hash list approves nothing.
  const empty = { files: [{ path: COPY, sha256: [] }], blocks: [] };
  assert.equal(g.classify(copyInput([f(COPY)], { [COPY]: { head: CALLER_TEXT } }, empty)).risk, 'normal');
});

test('approved copies: hashes are of the text with line endings normalised to \\n', () => {
  assert.equal(g.copyHash('a\r\nb\rc\n'), g.copyHash('a\nb\nc\n'));
  assert.equal(g.copyHash(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(g.classify(copyInput([f(COPY)], { [COPY]: { head: CALLER_TEXT.replace(/\n/g, '\r\n') } })).risk, 'low');
  // A block whose own text uses CRLF hashes the same...
  const crlf = (t) => t.replace(/\n/g, '\r\n');
  assert.equal(g.classify(copyInput([f(DOC)], { [DOC]: { head: crlf(HEAD_DOC), base: crlf(BASE_DOC) } })).risk, 'low');
  // ...but outside the block the file must be byte-identical: changing only line endings there is a change.
  const headMixed = BASE_DOC.replace(BLOCK, BLOCK2).replace('Local text.\n', 'Local text.\r\n');
  assert.equal(g.classify(copyInput([f(DOC)], { [DOC]: { head: headMixed, base: BASE_DOC } })).risk, 'normal');
});

test('approved copies: block entries fail on a change outside the markers, a missing or duplicated marker, or a new file', () => {
  const block = (head, baseText = BASE_DOC, extra = {}) => g.classify(copyInput([f(DOC, '+x', extra)], { [DOC]: { head, base: baseText } })).risk;
  assert.equal(block(HEAD_DOC), 'low');
  assert.equal(block(HEAD_DOC.replace('Local text.', 'Changed text.')), 'normal');
  assert.equal(block(HEAD_DOC.replace('More local text.\n', 'More local text.\nAdded line.\n')), 'normal');
  assert.equal(block(HEAD_DOC.replace('# Rules', '# Rules ')), 'normal');
  // Text moved from after the block to before it is still a change outside it.
  assert.equal(block(`# Rules\n\nLocal text.\n\nMore local text.\n${BLOCK2}\n\n`, `# Rules\n\nLocal text.\n\n${BLOCK}\n\nMore local text.\n`), 'normal');
  // Markers at head: missing, duplicated, or in the wrong order.
  assert.equal(block(HEAD_DOC.replace(START, '')), 'normal');
  assert.equal(block(HEAD_DOC.replace(END, '')), 'normal');
  assert.equal(block(`${HEAD_DOC}${START}\n`), 'normal');
  assert.equal(block(`${HEAD_DOC}${END}\n`), 'normal');
  assert.equal(block(`${END}\nShared rules, version two.\n${START}\n`, `${END}\nShared rules.\n${START}\n`), 'normal');
  // Markers at base: missing or duplicated.
  assert.equal(block(HEAD_DOC, BASE_DOC.replace(START, '')), 'normal');
  assert.equal(block(HEAD_DOC, `${BASE_DOC}${END}\n`), 'normal');
  assert.equal(block(HEAD_DOC, `${BASE_DOC}${START}\n`), 'normal');
  // A file new on the head (added) is not a copy, even with a base read.
  assert.equal(block(HEAD_DOC, BASE_DOC, { status: 'added' }), 'normal');
  // The block's own text must match a listed hash.
  assert.equal(block(BASE_DOC.replace(BLOCK, `${START}\nOther rules.\n${END}`)), 'normal');
});

test('approved copies: a failed or missing read is not an approved copy', () => {
  const r = (contents) => g.classify(copyInput([f(DOC)], contents)).risk;
  assert.equal(r({ [DOC]: { head: HEAD_DOC, base: null } }), 'normal');
  assert.equal(r({ [DOC]: { head: null, base: BASE_DOC } }), 'normal');
  assert.equal(r({}), 'normal');
  assert.equal(g.classify(copyInput([f(COPY)], {})).risk, 'normal');
  assert.equal(g.classify({ ...base, files: [f(COPY)], approvedCopies: LIST }).risk, 'normal');
  assert.equal(g.classify({ ...base, files: [f(COPY)], approvedCopies: LIST, copyContents: { [COPY]: { head: CALLER_TEXT } } }).risk, 'normal');
});

test('approved copies: the review of the head commit must still be complete and clean', () => {
  const input = (feedback, extra = {}) => ({ ...copyInput([f(COPY)], { [COPY]: { head: CALLER_TEXT } }), feedback, ...extra });
  assert.equal(g.decide(input([codex('H', false, 'running')])).state, 'pending');
  assert.equal(g.decide(input([])).state, 'pending');
  assert.equal(g.decide(input([codex('OLD')])).state, 'pending');
  assert.equal(g.decide(input([codex('H', true)])).state, 'failure');
  assert.equal(g.decide(input([codex('H')], { labels: ['review:blocking'] })).state, 'failure');
  assert.equal(g.decide(input([codex('H')], { draft: true })).state, 'pending');
  // A Codex PR still needs the Claude second review.
  assert.equal(g.decide(input([codex('H')], { headRef: 'codex/5' })).state, 'pending');
  assert.equal(g.decide(input([codex('H'), claudeVerdict('H')], { headRef: 'codex/5' })).state, 'success');
});

test('approved copies: an empty list (or none) behaves exactly as before', () => {
  const contents = { [COPY]: { head: CALLER_TEXT }, [DOC]: { head: HEAD_DOC, base: BASE_DOC } };
  for (const list of [{ files: [], blocks: [] }, {}, undefined, null]) {
    for (const files of [[f(COPY)], [f(DOC)], [f('README.md')], [f('src/app.ts')], []]) {
      const input = { ...base, files, approvedCopies: list, copyContents: contentsOf(contents) };
      assert.deepEqual(g.classify(input), g.classify({ ...base, files }), JSON.stringify([list, files]));
      assert.deepEqual(g.decide(input), g.decide({ ...base, files }));
    }
    assert.equal(g.approvedCopyPlan(list, [f(COPY)]), null);
  }
});

test('approved copies: a PR with no changed files is not an approved copy', () => {
  assert.equal(g.approvedCopyPlan(LIST, []), null);
  assert.deepEqual(g.approvedCopy({ list: LIST, files: [], contents: new Map() }), { ok: false });
  assert.deepEqual(g.classify(copyInput([], {})), g.classify({ ...base, files: [] }));
});

test('approved copies: reads are planned only when every changed file is a listed path', () => {
  assert.deepEqual(g.approvedCopyPlan(LIST, [f(COPY), f(DOC)]).map(({ path, kind }) => [path, kind]), [[COPY, 'file'], [DOC, 'block']]);
  assert.equal(g.approvedCopyPlan(LIST, [f(COPY), f('README.md')]), null);
  assert.equal(g.approvedCopyPlan(LIST, [f(DOC, '+x', { status: 'added' })]), null);
  assert.equal(g.approvedCopyPlan(LIST, [f(COPY, '', { status: 'removed' })]), null);
  assert.equal(g.approvedCopyPlan(LIST, [f(COPY, '', { status: 'renamed', previous_filename: 'x.yml' })]), null);
  assert.equal(g.approvedCopyPlan(LIST, [f('.github/workflows/PR-GATE.yml')]), null);
});

test('approved copies: a malformed list approves nothing, and says why', () => {
  const h = g.copyHash(CALLER_TEXT);
  const bad = {
    'not an object': [],
    'unknown key': { files: [], extra: [] },
    'files not a list': { files: {} },
    'entry unknown key': { files: [{ path: COPY, sha256: [h], note: 'x' }] },
    'both files and blocks': { files: [{ path: DOC, sha256: [h] }], blocks: [{ path: DOC, start: START, end: END, sha256: [h] }] },
    'twice in files': { files: [{ path: COPY, sha256: [h] }, { path: COPY, sha256: [] }] },
    'uppercase hash': { files: [{ path: COPY, sha256: [h.toUpperCase()] }] },
    'short hash': { files: [{ path: COPY, sha256: ['abc'] }] },
    'hash not a list': { files: [{ path: COPY, sha256: h }] },
    'leading slash': { files: [{ path: `/${COPY}`, sha256: [h] }] },
    'dot dot': { files: [{ path: `x/../${COPY}`, sha256: [h] }] },
    'dependency manifest': { files: [{ path: 'package.json', sha256: [h] }] },
    'package config': { files: [{ path: '.npmrc', sha256: [h] }] },
    'empty marker': { blocks: [{ path: DOC, start: '', end: END, sha256: [h] }] },
    'multi-line marker': { blocks: [{ path: DOC, start: `${START}\n`, end: END, sha256: [h] }] },
    'marker inside the other': { blocks: [{ path: DOC, start: '<!-- shared -->', end: 'shared -->', sha256: [h] }] },
  };
  for (const [name, list] of Object.entries(bad)) {
    assert.ok(g.approvedListError(list), name);
    assert.equal(g.approvedCopyPlan(list, [f(list.files?.[0]?.path || DOC)]), null, name);
  }
  // A path in both lists is not approved under either rule.
  const both = bad['both files and blocks'];
  assert.equal(g.classify(copyInput([f(DOC)], { [DOC]: { head: CALLER_TEXT, base: BASE_DOC } }, both)).risk, 'normal');
  assert.equal(g.approvedListError(LIST), null);
  assert.equal(g.approvedListError({ files: [], blocks: [] }), null);
});

test('approved copies: content reads decode only a whole UTF-8 file at exactly that path', () => {
  const resp = (text, extra = {}) => { const b = Buffer.from(text, 'utf8'); return { type: 'file', path: COPY, encoding: 'base64', size: b.length, content: b.toString('base64'), ...extra }; };
  assert.equal(g.decodeContent(resp(CALLER_TEXT), COPY), CALLER_TEXT);
  // GitHub wraps base64 at 60 columns.
  const wrapped = resp('x'.repeat(200)); wrapped.content = wrapped.content.replace(/(.{60})/g, '$1\n');
  assert.equal(g.decodeContent(wrapped, COPY), 'x'.repeat(200));
  // A byte-order mark is kept, so the file is not the same copy.
  assert.equal(g.decodeContent(resp('﻿a'), COPY), '﻿a');
  assert.notEqual(g.copyHash(g.decodeContent(resp(`﻿${CALLER_TEXT}`), COPY)), g.copyHash(CALLER_TEXT));
  // Over the contents API size limit: no content.
  assert.equal(g.decodeContent({ type: 'file', path: COPY, encoding: 'none', size: 2_000_000, content: '' }, COPY), null);
  assert.equal(g.decodeContent(resp(CALLER_TEXT, { size: 3 }), COPY), null);
  // A symlink resolved to another path, a symlink, a submodule or a directory.
  assert.equal(g.decodeContent(resp(CALLER_TEXT, { path: 'elsewhere.yml' }), COPY), null);
  assert.equal(g.decodeContent(resp(CALLER_TEXT, { type: 'symlink' }), COPY), null);
  assert.equal(g.decodeContent(resp(CALLER_TEXT, { type: 'submodule' }), COPY), null);
  assert.equal(g.decodeContent([resp(CALLER_TEXT)], COPY), null);
  assert.equal(g.decodeContent(null, COPY), null);
  // Binary: invalid UTF-8 or a NUL byte.
  const bin = Buffer.from([0x6e, 0xff, 0xfe, 0x0a]);
  assert.equal(g.decodeContent({ type: 'file', path: COPY, encoding: 'base64', size: bin.length, content: bin.toString('base64') }, COPY), null);
  assert.equal(g.decodeContent(resp('a\u0000b'), COPY), null);
  assert.equal(g.decodeContent(resp(CALLER_TEXT, { content: '!!not base64!!' }), COPY), null);
});

test('approved copies: the shipped list has the caller entry and the shared AGENTS.md block entry', () => {
  const shipped = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, 'approved-copies.json'), 'utf8'));
  assert.equal(g.approvedListError(shipped), null);
  assert.deepEqual(shipped.files.map((e) => e.path), [COPY]);
  assert.deepEqual(shipped.blocks.map((e) => e.path), ['AGENTS.md']);
});
