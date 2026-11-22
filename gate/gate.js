// PR gate: classifies risk and decides the `review-gate` commit status.
// Pure logic only (no network) so it can be unit-tested; the workflow
// template gathers the data and posts the result.
//
// Threat model (decision 0003): agents act with the owner's GitHub identity.
// They can push, comment, label and post commit statuses as the owner, but
// not as the GitHub Actions app, and they must not be able to edit workflows.
// So every piece of evidence the gate trusts is either written by a known
// reviewer bot and bound to the head SHA, or written by GitHub Actions.

const PROTECTED = [
  /^\.github\//, /^AGENTS\.md$/, /^CLAUDE\.md$/, /^\.ops\.yml$/, /^\.claude\//,
  /^specs\//, /^docs\/vision\.md$/, /^docs\/features\.json$/, /^docs\/decisions\//,
];
// Files named as tests: a test runner finds them by their name.
const TEST_FILE_NAME = [
  /\.(test|spec)\.[cm]?[jt]sx?$/, /(^|\/)test_[^/]*\.py$/, /_test\.(py|go|rs|exs?)$/, /_spec\.rb$/,
  /(Test|Tests|Spec)\.(kt|kts|java|swift|scala|cs)$/,
];
const TEST_PATH = [
  /(^|\/)(tests?|__tests__|e2e|spec|specs|testdata)\//, /(^|\/)src\/(test|androidTest)\//, ...TEST_FILE_NAME,
];
const DOC_PATH = [/\.md$/, /^docs\//];
const DEPENDENCY_FILES = [
  /(^|\/)package(-lock)?\.json$/, /(^|\/)npm-shrinkwrap\.json$/, /(^|\/)pnpm-lock\.yaml$/, /(^|\/)yarn\.lock$/,
  /(^|\/)bun\.lockb?$/, /(^|\/)uv\.lock$/, /(^|\/)poetry\.lock$/, /(^|\/)Pipfile(\.lock)?$/,
  /(^|\/)pyproject\.toml$/, /(^|\/)requirements[^/]*\.(txt|in)$/, /(^|\/)setup\.(py|cfg)$/,
  /(^|\/)gradle\/libs\.versions\.toml$/, /(^|\/)(build|settings)\.gradle(\.kts)?$/, /(^|\/)gradle\.lockfile$/,
  /(^|\/)Gemfile(\.lock)?$/, /(^|\/)go\.(mod|sum)$/, /(^|\/)Cargo\.(toml|lock)$/,
];
// Package-manager configuration (registries, install scripts, workspaces, tool
// versions). Not a Dependabot manifest, but never agent-safe either.
const PACKAGE_CONFIG_FILES = [
  /(^|\/)\.npmrc$/, /(^|\/)\.yarnrc(\.yml)?$/, /(^|\/)\.pnpmfile\.cjs$/, /(^|\/)pnpm-workspace\.yaml$/,
  /(^|\/)\.nvmrc$/, /(^|\/)\.node-version$/, /(^|\/)\.python-version$/, /(^|\/)\.tool-versions$/,
  /(^|\/)pip\.conf$/, /(^|\/)gradle\.properties$/, /(^|\/)gradle\/wrapper\//,
];
// A line that declares a test, and a line that asserts. Covers JS/TS, Python,
// Kotlin/Java, Go, Rust, Ruby, Swift and Elixir test syntax.
const TEST_DECL = /\b(it|test|describe|context)\s*[('"]|def test_|@Test\b|\bfunc Test\w*\(|#\[(tokio::)?test\]|\bt\.Run\(/;
const ASSERTION = /\bexpect\s*[({]|\bassert|\bt\.(Error|Errorf|Fatal|Fatalf)\(|\bXCTAssert|\brequire\.\w+\(/;
// A removed line that looks like a test or an assertion (either kind above).
const REMOVED_TEST_LINE = new RegExp('^-(?!--).*(' + TEST_DECL.source + '|' + ASSERTION.source + ')', 'm');
// Added lines must be real to offset a removed one, so the added side is
// stricter: comment lines don't count, and neither does `it`, `test`,
// `describe` or `context` called as a method (a regex `.test(`, Rust `.context(`).
const ADDED_TEST_DECL = new RegExp('(?<!\\.\\s*)(?:' + TEST_DECL.source + ')');
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*|#(?!\[)|--|<!--)/;
// An added line that disables or narrows tests.
const ADDED_SKIP_LINE = /^\+(?!\+\+).*(\.(skip|only|todo|fixme)\s*\(|\bx(it|describe|test)\s*\(|@pytest\.mark\.(skip|xfail)|pytest\.skip\(|@unittest\.skip|@Ignore\b|@Disabled\b|\bt\.Skip(Now|f)?\(|#\[ignore\]|@tag :skip|\bpending\b\s*(\(|$))/m;
const BLOCKING_FINDING = /(badge\/P[01]-|\bP[01]\s*Badge)/i;
// Bot logins whose structured verdicts the gate accepts.
const CODEX_BOT = 'chatgpt-codex-connector[bot]';
const VERDICT_BOTS = new Set(['claude[bot]', CODEX_BOT]);
const ACTIONS_BOT = 'github-actions[bot]';

const isProtected = (f) => PROTECTED.some((r) => r.test(f));
const isTest = (f) => TEST_PATH.some((r) => r.test(f));
const isDoc = (f) => DOC_PATH.some((r) => r.test(f));
const isDependencyFile = (f) => DEPENDENCY_FILES.some((r) => r.test(f));
const isPackageConfig = (f) => PACKAGE_CONFIG_FILES.some((r) => r.test(f));
const isPlainMarkdown = (f) => /\.md$/.test(f) && !isTest(f);
// A file a test runner executes: named as a test, and not a fixture.
const isTestFile = (f) => TEST_FILE_NAME.some((r) => r.test(f)) && !/(^|\/)(testdata|fixtures?)\//.test(f);

function classifyFile(file) {
  const { filename, status, patch = '' } = file;
  if (isProtected(filename)) return { low: false, why: `protected path ${filename}` };
  if (isTest(filename)) {
    if (status === 'removed') return { low: false, why: `test file deleted: ${filename}` };
    if (REMOVED_TEST_LINE.test(patch)) return { low: false, why: `test or assertion removed in ${filename}` };
    if (ADDED_SKIP_LINE.test(patch)) return { low: false, why: `test skipped or narrowed in ${filename}` };
    return { low: true, why: 'tests added' };
  }
  if (isDoc(filename) && status !== 'removed') return { low: true, why: 'docs' };
  return { low: false, why: `code change ${filename}` };
}

// Agent-safe tier (portfolio-ops decision 0005). Opt-in per repo through
// `.ops.yml` on the default branch (a protected path, so agents can't change
// it in a PR). A PR qualifies only if it is an agent PR for a linked, queued,
// non-pivotal issue, touches no protected, dependency, sensitive or pivotal
// path, doesn't lower the number of tests or assertions or skip a test, and
// stays under the size cap.
// Only the keys below are read, so a tiny parser is enough (no YAML library).
function parseOpsPolicy(text) {
  // Allowlist parser: every line must be blank, a comment, a plain top-level
  // `key: value`, or an item of the policy list being read. Anything else
  // (quoted or indented keys, nested blocks, stray text) switches the tier off,
  // so syntax this parser doesn't understand can never drop a restriction.
  const policy = { agentSafe: false, maxLines: 400, sensitive: [], pivotal: [] };
  const off = (why) => ({ ...policy, agentSafe: false, invalid: why });
  let list = null;
  for (const raw of String(text || '').split('\n')) {
    if (/^\s*(#.*)?$/.test(raw)) continue;
    const line = raw.replace(/\s+#.*$/, '');
    const item = /^\s*-\s*["']?([^"']+?)["']?\s*$/.exec(line);
    if (list && item) { policy[list].push(item[1]); continue; }
    const kv = /^([a-z][a-z0-9_]*):(?:\s+(.*))?$/.exec(line);
    if (!kv) return off(`unreadable line: ${line.trim()}`);
    list = null;
    const key = kv[1]; const value = (kv[2] || '').trim();
    if (key === 'agent_safe') policy.agentSafe = value === 'true';
    else if (key === 'agent_max_lines') { if (!/^\d+$/.test(value)) return off('agent_max_lines is not a number'); policy.maxLines = Number(value); }
    else if (key === 'sensitive_paths' || key === 'pivotal_paths') {
      const name = key === 'sensitive_paths' ? 'sensitive' : 'pivotal';
      const inline = /^\[(.*)\]$/.exec(value);
      if (inline) policy[name].push(...inline[1].split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean));
      else if (!value) list = name;
      else return off(`unreadable value for ${key}`);
    }
  }
  return policy;
}

// Glob: `**` any path (including none), `*` within one path segment.
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*'; i += glob[i + 2] === '/' ? 2 : 1; }
    else if (c === '*') re += '[^/]*';
    else re += /[.+?^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
  }
  // Built by concatenation: gate/build.js inlines this file with String.replace,
  // where a dollar sign before a backtick or ampersand is a special pattern.
  const tail = glob.endsWith('/') ? '.*' : '(?:/.*)?';
  return new RegExp('^' + re + tail + '\u0024');
}
const matchesAny = (file, globs) => globs.some((g) => globToRegExp(g).test(file));
const pathsOf = (f) => (f.previous_filename && f.previous_filename !== f.filename ? [f.filename, f.previous_filename] : [f.filename]);

// The issue an agent PR implements: from a `claude/<n>` or `codex/<n>` branch,
// else the first `Closes #n` in the body.
function linkedIssue(headRef, body) {
  const b = /^(?:claude|codex)\/(\d+)$/.exec(headRef || '');
  if (b) return Number(b[1]);
  const c = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/i.exec(body || '');
  return c ? Number(c[1]) : null;
}

// Counts, in one file's patch, the removed and added lines that declare a test
// and those that assert. A line can be both. Every removed line that
// REMOVED_TEST_LINE matches is counted; added lines use the stricter rules above.
function countTestLines(patch) {
  const n = { tests: { removed: 0, added: 0 }, assertions: { removed: 0, added: 0 } };
  // Split on every line terminator, as `^` with the m flag does.
  for (const line of String(patch || '').split(/\r\n?|[\n\u2028\u2029]/)) {
    if (/^-(?!--)/.test(line)) {
      if (TEST_DECL.test(line)) n.tests.removed++;
      if (ASSERTION.test(line)) n.assertions.removed++;
    } else if (/^\+(?!\+\+)/.test(line) && !COMMENT_LINE.test(line.slice(1))) {
      if (ADDED_TEST_DECL.test(line)) n.tests.added++;
      if (ASSERTION.test(line)) n.assertions.added++;
    }
  }
  return n;
}

// Totals across a PR's files (renames included). Markdown outside test paths
// (both names, for a rename) is counted on neither side. Added lines count in
// full only in a file a runner executes (isTestFile); in any other file they
// can offset removed lines of the same file (an edited inline test) but no more,
// so lines pasted into a file nothing runs never stand in for a removed test.
function countPrTestLines(files) {
  const total = { tests: { removed: 0, added: 0 }, assertions: { removed: 0, added: 0 } };
  for (const f of files) {
    if (pathsOf(f).every(isPlainMarkdown)) continue;
    const n = countTestLines(f.patch);
    const runs = isTestFile(f.filename);
    for (const kind of ['tests', 'assertions']) {
      total[kind].removed += n[kind].removed;
      total[kind].added += runs ? n[kind].added : Math.min(n[kind].added, n[kind].removed);
    }
  }
  return total;
}

// Returns { ok, why }. `issue` is { state, labels } of the linked issue or null.
function agentSafe({ headRef, files, policy, issue }) {
  if (!policy?.agentSafe) return { ok: false, why: 'agent-safe tier not enabled for this repo' };
  if (!/^(claude|codex)\//.test(headRef || '')) return { ok: false, why: 'not an agent branch' };
  if (!issue) return { ok: false, why: 'no linked issue' };
  if (issue.state !== 'open') return { ok: false, why: 'linked issue is not open' };
  if (!issue.labels.includes('ready') && !issue.labels.includes('in-progress')) return { ok: false, why: 'linked issue was not queued (ready)' };
  if (issue.labels.includes('pivotal')) return { ok: false, why: 'linked issue is pivotal' };
  for (const f of files) {
    // A rename touches two paths: both must be allowed.
    for (const name of pathsOf(f)) {
      if (isDependencyFile(name) || isPackageConfig(name)) return { ok: false, why: `dependency or package-manager file ${name}` };
      if (matchesAny(name, policy.sensitive)) return { ok: false, why: `sensitive path ${name}` };
      if (matchesAny(name, policy.pivotal)) return { ok: false, why: `pivotal path ${name}` };
    }
    // A test moved out of test discovery is a removed test: out of the test
    // paths, or from a name a runner finds to one it doesn't.
    const prev = f.previous_filename;
    if (prev && ((isTest(prev) && !isTest(f.filename)) || (isTestFile(prev) && !isTestFile(f.filename)))) return { ok: false, why: `test file moved out of tests: ${prev}` };
    if (f.status === 'removed') return { ok: false, why: pathsOf(f).some(isTest) ? `test file deleted: ${f.filename}` : `file deleted: ${f.filename}` };
    // Language-agnostic: whatever the file type, an added skip is never
    // agent-safe. Markdown outside test paths is exempt, by the `.md` ending only
    // (not isDoc), and for a rename only when both names are such Markdown files.
    // This assumes the repo runs no tests from Markdown (doctests); a repo that
    // does should not rely on the agent-safe tier for Markdown changes.
    if (!pathsOf(f).every(isPlainMarkdown) && ADDED_SKIP_LINE.test(f.patch || '')) return { ok: false, why: `test skipped or narrowed in ${f.filename}` };
  }
  // An edited test is not a deleted one: the PR fails only when the number of
  // test or assertion lines falls across all its files (countPrTestLines). Inline
  // tests such as Rust #[test], and test files TEST_PATH doesn't recognise, count.
  const counts = countPrTestLines(files);
  for (const kind of ['tests', 'assertions']) {
    const { removed, added } = counts[kind];
    if (removed > added) return { ok: false, why: `${kind} fell from the diff: ${removed} removed, ${added} added` };
  }
  const lines = files.reduce((n, f) => n + (f.additions || 0) + (f.deletions || 0), 0);
  if (lines > policy.maxLines) return { ok: false, why: `${lines} lines changed (cap ${policy.maxLines})` };
  return { ok: true, why: `agent-safe: queued issue #${issue.number ?? '?'}, ${lines} lines, no sensitive paths` };
}

function isPatchBump(title) {
  const m = /from v?(\d+)\.(\d+)\.(\d+)\S* to v?(\d+)\.(\d+)\.(\d+)/.exec(title || '');
  return !!m && m[1] === m[4] && m[2] === m[5];
}

// Approved copies (issue #19). A file the owner approved once at its source
// (the shared caller workflow, a shared block of an instruction file) is
// rolled out to many repositories. The list in gate/approved-copies.json is
// embedded at build time (never read from the PR or fetched at run time), and
// a PR is risk:low only when EVERY changed file is added or modified (never
// removed, renamed or otherwise) and its content at the head SHA proves it:
//  - `files`: the whole file hashes to a listed value;
//  - `blocks`: the text from the start marker to the end marker inclusive
//    hashes to a listed value, the file has exactly one of each marker at both
//    head and base, and the text before and after the block is identical to
//    the base copy (so the file must already exist on the base).
// Hash: SHA-256 of the UTF-8 text with line endings normalised to `\n`.
// Anything else, including a read that failed, is not an approved copy and
// the existing rules apply unchanged. The workflow script does the reads and
// passes the decoded text in; this code only decides.
const SHA256_HEX = /^[0-9a-f]{64}$/;
const COPY_STATUSES = new Set(['added', 'modified']);
const ENTRY_KEYS = { files: ['path', 'sha256'], blocks: ['path', 'start', 'end', 'sha256'] };
const normaliseNewlines = (text) => text.replace(/\r\n?/g, '\n');
// Required lazily so that a missing crypto module can only fail an approved-copy check (closed).
const copyHash = (text) => require('node:crypto').createHash('sha256').update(normaliseNewlines(text), 'utf8').digest('hex');
const isPlainObject = (x) => !!x && typeof x === 'object' && !Array.isArray(x);

// Returns null for a well-formed list, else what is wrong with it. A list that
// is not well formed approves nothing (and gate/build.js refuses to build it).
function approvedListError(list) {
  if (!isPlainObject(list)) return 'the list is not an object';
  for (const k of Object.keys(list)) if (!Object.hasOwn(ENTRY_KEYS, k)) return `unknown key ${k}`;
  const seen = new Set();
  for (const kind of ['files', 'blocks']) {
    const entries = list[kind] === undefined ? [] : list[kind];
    if (!Array.isArray(entries)) return `${kind} is not a list`;
    for (const e of entries) {
      if (!isPlainObject(e)) return `${kind}: an entry is not an object`;
      for (const k of Object.keys(e)) if (!ENTRY_KEYS[kind].includes(k)) return `${kind}: unknown key ${k}`;
      const p = e.path;
      if (typeof p !== 'string' || !p || p.split('/').some((s) => s === '' || s === '.' || s === '..') || /[\u0000-\u001f\\]/.test(p)) return `${kind}: bad path ${JSON.stringify(p)}`;
      // Dependency manifests and package-manager config keep their own rules.
      if (isDependencyFile(p) || isPackageConfig(p)) return `${kind}: ${p} is a dependency or package-manager file`;
      if (seen.has(p)) return `${p} is listed more than once`;
      seen.add(p);
      if (!Array.isArray(e.sha256) || !e.sha256.every((h) => typeof h === 'string' && SHA256_HEX.test(h))) return `${p}: sha256 must be a list of lowercase hex SHA-256 values`;
      if (kind === 'blocks') {
        for (const m of [e.start, e.end]) if (typeof m !== 'string' || !m || /[\r\n]/.test(m)) return `${p}: markers must be non-empty single-line strings`;
        if (e.start.includes(e.end) || e.end.includes(e.start)) return `${p}: one marker contains the other`;
      }
    }
  }
  return null;
}

// Which reads an approved-copy check needs: [{ path, kind }] when every changed
// file is a listed path with an allowed status, else null (no reads at all).
// `file` entries need the head only; `block` entries need head and base.
function approvedCopyPlan(list, files) {
  if (approvedListError(list) || !Array.isArray(files) || !files.length) return null;
  const listed = new Map([
    ...(list.files || []).map((e) => [e.path, { kind: 'file', entry: e }]),
    ...(list.blocks || []).map((e) => [e.path, { kind: 'block', entry: e }]),
  ]);
  const plan = [];
  for (const f of files) {
    const hit = listed.get(f?.filename);
    if (!hit || plan.some((p) => p.path === f.filename)) return null;
    if (!COPY_STATUSES.has(f.status) || f.previous_filename) return null;
    // A block is approved against the base copy, so the file must exist there.
    if (hit.kind === 'block' && f.status !== 'modified') return null;
    plan.push({ path: f.filename, ...hit });
  }
  return plan;
}

// Occurrences of `needle` in `text`, overlapping ones included.
function occurrences(text, needle) {
  let n = 0;
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) n++;
  return n;
}
// The one block in `text`, with the text before and after it; null unless
// there is exactly one start marker and one end marker, in that order.
function blockOf(text, { start, end }) {
  if (occurrences(text, start) !== 1 || occurrences(text, end) !== 1) return null;
  const s = text.indexOf(start);
  const e = text.indexOf(end);
  if (e < s + start.length) return null;
  return { before: text.slice(0, s), block: text.slice(s, e + end.length), after: text.slice(e + end.length) };
}

// The decoded text of a contents API response for `path`, or null for
// anything that is not a whole, readable UTF-8 file at exactly that path
// (a directory, symlink or submodule, a file over the API's size limit, a
// size mismatch, invalid UTF-8 or a NUL byte). A byte-order mark is kept.
function decodeContent(data, path) {
  if (!isPlainObject(data) || data.type !== 'file' || data.path !== path || data.encoding !== 'base64') return null;
  if (typeof data.content !== 'string' || !/^[A-Za-z0-9+/=\s]*$/.test(data.content) || !Number.isInteger(data.size)) return null;
  const bytes = Buffer.from(data.content, 'base64');
  if (bytes.length !== data.size || bytes.includes(0)) return null;
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return null; }
}

// list: the embedded approved list. contents: Map path → { head, base }, the
// decoded text at the head and base SHAs (null where a read failed).
// Returns { ok: true, reasons } only when every changed file is an approved copy.
function approvedCopy({ list, files, contents }) {
  const no = { ok: false };
  try {
    const plan = approvedCopyPlan(list, files);
    if (!plan || !(contents instanceof Map)) return no;
    for (const { path, kind, entry } of plan) {
      const { head, base } = contents.get(path) || {};
      if (typeof head !== 'string') return no;
      if (kind === 'file') { if (!entry.sha256.includes(copyHash(head))) return no; continue; }
      if (typeof base !== 'string') return no;
      const h = blockOf(head, entry);
      const b = blockOf(base, entry);
      // Outside the block, byte-identical to the base (no newline normalisation).
      if (!h || !b || h.before !== b.before || h.after !== b.after) return no;
      if (!entry.sha256.includes(copyHash(h.block))) return no;
    }
    return { ok: true, reasons: plan.map((p) => `approved copy of ${p.path}`) };
  } catch { return no; }
}

// commits: authors of every commit on the PR (logins), used so that code
// pushed onto a Dependabot branch by anyone else loses the Dependabot path.
// approvedCopies / copyContents: see approvedCopy above (absent: no approved copies).
function classify({ author, title, labels, files, commitAuthors = [], headRef, policy, issue, approvedCopies, copyContents }) {
  const copy = approvedCopy({ list: approvedCopies, files, contents: copyContents });
  if (copy.ok) return { risk: 'low', reasons: copy.reasons, agentWhy: null };
  const protectedPaths = files.flatMap(pathsOf).filter(isProtected);
  if (protectedPaths.length) { const reasons = protectedPaths.map((n) => `protected path ${n}`); return { risk: 'normal', reasons, agentWhy: reasons[0] }; }
  if (author === 'dependabot[bot]') {
    const onlyDependabot = commitAuthors.length > 0 && commitAuthors.every((a) => a === 'dependabot[bot]');
    const onlyManifests = files.every((f) => isDependencyFile(f.filename));
    return isPatchBump(title) && onlyDependabot && onlyManifests
      ? { risk: 'low', reasons: ['dependency patch bump (Dependabot commits, manifests only)'], agentWhy: null }
      : { risk: 'normal', reasons: ['dependency change that is not a pure Dependabot patch bump'], agentWhy: 'dependency change that is not a pure Dependabot patch bump' };
  }
  if (labels.includes('type:dead-code')) {
    const onlyDeletes = files.every((f) => f.status !== 'removed' && f.additions === 0);
    return onlyDeletes
      ? { risk: 'low', reasons: ['dead-code removal: deletions only, no files removed'], agentWhy: null }
      : { risk: 'normal', reasons: ['dead-code PR adds lines or deletes whole files'], agentWhy: 'dead-code PR adds lines or deletes whole files' };
  }
  // A renamed file is low risk only if its old path would be too (src/x.ts → docs/x.md is not docs).
  const results = files.flatMap((f) => (pathsOf(f).length > 1 ? [classifyFile(f), classifyFile({ ...f, filename: f.previous_filename })] : [classifyFile(f)]));
  const blockers = results.filter((r) => !r.low).map((r) => r.why);
  if (!blockers.length) return { risk: 'low', reasons: [...new Set(results.map((r) => r.why))], agentWhy: null };
  const safe = agentSafe({ headRef, files, policy, issue });
  return safe.ok ? { risk: 'agent', reasons: [safe.why], agentWhy: null } : { risk: 'normal', reasons: [...blockers, safe.why], agentWhy: safe.why };
}

// Structured verdicts bound to a commit:
//  - Codex: <!-- codex-review-state:v1 {"code_review":{"commit_sha","status","has_unresolved_findings"}} -->
//  - Claude reviewer: <!-- review-verdict:v1 {"commit_sha":"…","result":"clear"|"blocking"} -->
const CODEX_STATE = /<!--\s*codex-review-state:v1\s*(\{[\s\S]*?\})\s*-->/;
const VERDICT = /<!--\s*review-verdict:v1\s*(\{[\s\S]*?\})\s*-->/;
const parse = (re, body) => { const m = re.exec(body || ''); if (!m) return null; try { return JSON.parse(m[1]); } catch { return null; } };

// Returns 'clear' | 'blocking' | 'pending' | null (no verdict for this head).
function verdictFor(item, headSha) {
  if (!VERDICT_BOTS.has(item.author)) return null;
  const codex = item.author === CODEX_BOT ? parse(CODEX_STATE, item.body)?.code_review : null;
  if (codex) {
    if (codex.commit_sha !== headSha) return null;
    if (codex.has_unresolved_findings === true) return 'blocking';
    if (/^(completed|succeeded|success)$/i.test(codex.status || '') && codex.has_unresolved_findings === false) return 'clear';
    return 'pending';
  }
  const v = parse(VERDICT, item.body);
  if (!v || v.commit_sha !== headSha) return null;
  if (v.result === 'blocking') return 'blocking';
  if (v.result === 'clear') return 'clear';
  return 'pending';
}

// Answered findings (issue #14). Codex's `has_unresolved_findings` stays true
// until a person resolves each thread, even when every finding was fixed and
// answered. `answered` replaces `blocking` only when Codex's own completed
// state for the head is the sole reason to block, and every Codex finding
// thread is answered by the owner's account with nothing raised on the head.
// The owner's account is also the agents' identity (decision 0003), so a reply
// proves nothing by itself: `answered` never passes a PR on its own. decide()
// treats it as blocking for risk:low and risk:agent, and for risk:normal it
// still needs human-approved on this commit.
//
// Line comments are the feedback items that carry a numeric `id` (only review
// comments do), with `inReplyToId`, `originalCommitId` and `createdAt`.
// Every thread a Codex comment appears in counts as a finding thread, whatever
// its priority badge (Codex's flag counts P2/P3 threads too), and must:
// start with a Codex comment; have no Codex comment first raised on the head
// commit; and have a comment by the owner's account created after the thread's
// last Codex comment. Anything unreadable (unknown parent, missing time or
// commit) fails closed, so the gate stays red.
const ANY_PRIORITY = /(badge\/P\d-|\bP\d\s*Badge)/i;
const COMPLETED = /^(completed|succeeded|success)$/i;
const timeOf = (t) => Date.parse(t || '');
function codexFindingsAnswered({ feedback, headSha, owner }) {
  if (!owner) return false;
  // A Codex review submitted on the head that carries a finding badge in its body.
  if (feedback.some((x) => x.author === CODEX_BOT && !Number.isInteger(x.id) && x.commitId === headSha && ANY_PRIORITY.test(x.body || ''))) return false;
  const lines = feedback.filter((x) => Number.isInteger(x.id));
  const byId = new Map(lines.map((x) => [x.id, x]));
  const rootOf = (x) => {
    const seen = new Set();
    let r = x;
    while (r.inReplyToId != null) {
      if (seen.has(r.id)) return null;
      seen.add(r.id);
      r = byId.get(r.inReplyToId);
      if (!r) return null;
    }
    return r;
  };
  const threads = new Map();
  for (const x of lines) {
    const root = rootOf(x);
    if (!root) { if (x.author === CODEX_BOT) return false; continue; }
    if (!threads.has(root.id)) threads.set(root.id, { root, comments: [] });
    threads.get(root.id).comments.push(x);
  }
  let count = 0;
  for (const { root, comments } of threads.values()) {
    const fromCodex = comments.filter((x) => x.author === CODEX_BOT);
    if (!fromCodex.length) continue;
    if (root.author !== CODEX_BOT) return false;
    if (fromCodex.some((x) => !x.originalCommitId || x.originalCommitId === headSha)) return false;
    const lastCodex = Math.max(...fromCodex.map((x) => timeOf(x.createdAt)));
    if (!Number.isFinite(lastCodex)) return false;
    if (!comments.some((x) => x !== root && x.author === owner && timeOf(x.createdAt) > lastCodex)) return false;
    count++;
  }
  return count > 0;
}

// The only verdict for the head that blocks is a completed Codex state; every
// other verdict for the head is clear (no pending Codex state, no other block).
function onlyCodexStateBlocks(primary, headSha) {
  let codexBlocks = false;
  for (const x of primary) {
    const v = verdictFor(x, headSha);
    if (!v) continue;
    if (v === 'pending') return false;
    const state = x.author === CODEX_BOT ? parse(CODEX_STATE, x.body)?.code_review : null;
    if (!state) { if (v !== 'clear') return false; continue; }
    if (!COMPLETED.test(state.status || '')) return false;
    if (v === 'blocking') codexBlocks = true;
  }
  return codexBlocks;
}

// feedback: comments and reviews ({ author, body, commitId? }). Review and
// line comments carry commitId; a P0/P1 finding from a reviewer bot on the
// head commit blocks even if a summary says otherwise. Line comments also
// carry id, inReplyToId, originalCommitId and createdAt (see above).
// Returns 'blocking' | 'answered' | 'missing' | 'clear'.
function reviewState({ labels, feedback, headSha, headRef, owner }) {
  if (labels.includes('review:blocking')) return 'blocking';
  // On a Codex-written PR the primary review must be Codex's own; a Claude
  // verdict is the separate second review (secondReview), never both.
  const codexPr = /^codex\//.test(headRef || '');
  // Codex's summary tracks whether its findings are resolved, so it is
  // authoritative for Codex; raw P0/P1 line findings only count for others.
  const findings = feedback.filter((x) => VERDICT_BOTS.has(x.author) && x.author !== CODEX_BOT && x.commitId === headSha && BLOCKING_FINDING.test(x.body || ''));
  // On a Codex PR, Claude's verdicts and findings belong to secondReview only,
  // so overriding or clearing them can never stand in for Codex's own review.
  const primary = codexPr ? feedback.filter((x) => x.author === CODEX_BOT) : feedback;
  const verdicts = primary.map((x) => verdictFor(x, headSha)).filter(Boolean);
  const otherFindings = !codexPr && findings.length > 0;
  if (otherFindings || verdicts.includes('blocking')) {
    const answered = !otherFindings && onlyCodexStateBlocks(primary, headSha) && codexFindingsAnswered({ feedback, headSha, owner });
    return answered ? 'answered' : 'blocking';
  }
  if (verdicts.includes('pending')) return 'missing';
  return verdicts.includes('clear') ? 'clear' : 'missing';
}

// Second review for Codex-written PRs (portfolio-ops decision 0006). Codex
// reviews every PR, so a `codex/` PR also needs a Claude review-verdict for its
// head commit. Claude review sessions post through the owner's account, so a
// verdict from the owner counts here (and only here) as well as one from
// claude[bot]. Forging it can only reduce a Codex PR to Codex-only review (the
// position before this rule); Codex's own clean review is still required, and
// owner-account verdicts never count for any other PR.
function secondReview({ headRef, feedback, headSha, owner }) {
  if (!/^codex\//.test(headRef || '')) return 'not-needed';
  const results = feedback
    .filter((x) => x.author === 'claude[bot]' || (owner && x.author === owner))
    .map((x) => parse(VERDICT, x.body))
    .filter((v) => v && v.commit_sha === headSha)
    .map((v) => v.result);
  // claude[bot] P0/P1 line findings on the head commit block here too.
  const findings = feedback.some((x) => x.author === 'claude[bot]' && x.commitId === headSha && BLOCKING_FINDING.test(x.body || ''));
  if (findings || results.includes('blocking')) return 'blocking';
  return results.includes('clear') ? 'clear' : 'missing';
}

// Approval: the latest `labeled` event for human-approved must be by the
// owner, done directly (not via a GitHub App such as an agent), and later than
// both (a) when THIS PR adopted its head commit, i.e. the earliest pr-gate run
// GitHub recorded for this PR and head SHA (run records can't be forged, and
// unlike commit statuses they are tied to the PR), and (b) the latest force
// push. Any new push needs a new approval; re-adding the label after a force
// push restores it.
function ownerLabelled(name, { labels, labelEvents, owner, headAdoptedAt, forcePushTimes = [] }) {
  if (!labels.includes(name) || !headAdoptedAt) return false;
  const threshold = [headAdoptedAt, ...forcePushTimes].sort().at(-1);
  const last = labelEvents.filter((e) => e.event === 'labeled' && e.label === name).at(-1);
  return !!last && last.actor === owner && !last.viaApp && last.at > threshold;
}
const humanApproved = (input) => ownerLabelled('human-approved', input);
// Reviewers can be wrong. The owner can overrule blocking findings for the
// current commit with `review:override`, under the same rules as approval.
// It does not replace approval for risk:normal PRs.
const reviewOverridden = (input) => ownerLabelled('review:override', input);

// GitHub caps a status description at 140 characters. The fixed text is never
// cut: the reason is shortened to fit, ending with an ellipsis. A long path is
// shortened from the left so the file name survives.
const DESCRIPTION_MAX = 140;
function withReason(fixed, why) {
  if (!why) return fixed;
  const room = DESCRIPTION_MAX - fixed.length - ' \u2014 '.length;
  let reason = String(why).replace(/\s+/g, ' ');
  if (reason.length > room) {
    const m = /^(.*?)(\S*\/\S*)$/.exec(reason);
    if (m && room > m[1].length + 2) {
      const keep = room - m[1].length - 1; // one char for the ellipsis
      reason = m[1] + '\u2026' + m[2].slice(-keep);
    } else reason = room > 1 ? reason.slice(0, room - 1) + '\u2026' : '';
  }
  return reason ? `${fixed} \u2014 ${reason}` : fixed;
}

function decide(input) {
  const { risk, reasons, agentWhy = null } = classify(input);
  const raw = reviewState(input);
  // `answered` is still a block as far as review:override is concerned.
  const overridden = (raw === 'blocking' || raw === 'answered') && reviewOverridden(input);
  const review = overridden ? 'clear' : raw;
  const answered = review === 'answered';
  const approved = humanApproved(input);
  const second = secondReview(input);
  // review:override (owner, same rules as approval) also overrules a blocking Claude review.
  const overridden2 = second === 'blocking' && reviewOverridden(input);
  let state; let description;
  if (input.draft) { state = 'pending'; description = 'Draft PR'; }
  // Answered findings never let a PR merge without the owner: for risk:low and
  // risk:agent they block exactly as unresolved findings do.
  else if (review === 'blocking' || (answered && risk !== 'normal')) { state = 'failure'; description = 'Reviewer has unresolved findings on this commit (or review:blocking)'; }
  else if (review === 'missing') { state = 'pending'; description = 'Waiting for a completed review of this commit'; }
  else if (second === 'blocking' && !overridden2) { state = 'failure'; description = 'Claude review of this Codex PR found P0/P1 issues'; }
  // The owner's own approval of this commit stands in for a missing Claude review.
  else if (second === 'missing' && !approved) { state = 'pending'; description = 'Codex PR: waiting for the Claude review of this commit'; }
  else if (risk === 'low') { state = 'success'; description = overridden ? 'risk:low; review findings overridden by owner' : 'risk:low and reviewed'; }
  else if (risk === 'agent') { state = 'success'; description = overridden ? 'risk:agent; review findings overridden by owner' : 'risk:agent (agent-safe) and reviewed'; }
  // Only risk:normal reaches here with `answered`.
  else if (approved) { state = 'success'; description = overridden ? 'human-approved; review findings overridden by owner' : answered ? 'human-approved; reviewer findings answered, not resolved' : 'human-approved and reviewed'; }
  else if (input.labels.includes('human-approved')) { state = 'pending'; description = withReason('risk:normal: approval predates this commit; remove and re-add human-approved', agentWhy); }
  else if (answered) { state = 'pending'; description = withReason('risk:normal: waiting for human-approved — reviewer findings answered, not resolved', agentWhy); }
  else { state = 'pending'; description = withReason('risk:normal: waiting for human-approved', agentWhy); }
  return { risk, reasons, agentWhy, review, secondReview: second, overridden, approved, state, description };
}

module.exports = { approvedListError, approvedCopyPlan, approvedCopy, decodeContent, copyHash, ACTIONS_BOT,codexFindingsAnswered, secondReview, pathsOf, countTestLines, countPrTestLines, REMOVED_TEST_LINE, parseOpsPolicy, globToRegExp, linkedIssue, agentSafe, classify, classifyFile, isPatchBump, verdictFor, reviewState, humanApproved, reviewOverridden, decide };
