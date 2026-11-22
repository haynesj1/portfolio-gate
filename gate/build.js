// Builds .github/workflows/gate.yml (the reusable workflow) by embedding gate.js
// and the approved-copies list (issue #19).
const fs = require('node:fs');
const path = require('node:path');
const gate = require('./gate.js');

// The approved list, with this repository's own caller added to the entry for
// .github/workflows/pr-gate.yml (if there is one), so the current caller is
// always approved without a hand-edited hash. No entries means no approved copies.
const CALLER_PATH = '.github/workflows/pr-gate.yml';
const list = JSON.parse(fs.readFileSync(path.join(__dirname, 'approved-copies.json'), 'utf8'));
const invalid = (l) => { const err = gate.approvedListError(l); if (err) throw new Error(`gate/approved-copies.json: ${err}`); };
invalid(list);
const callerEntry = (list.files || []).find((e) => e.path === CALLER_PATH);
if (callerEntry) {
  const hash = gate.copyHash(fs.readFileSync(path.join(__dirname, '..', 'caller', 'pr-gate.yml'), 'utf8'));
  if (!callerEntry.sha256.includes(hash)) callerEntry.sha256.push(hash);
}
invalid(list);
const listJson = JSON.stringify(list);
// The script is a workflow expression context: never embed an expression opener.
if (listJson.includes('$' + '{{')) throw new Error('gate/approved-copies.json must not contain an expression opener');

const js = fs.readFileSync(path.join(__dirname, 'gate.js'), 'utf8')
  .split('\n').map((l) => (l ? `              ${l}` : l)).join('\n');
const tpl = fs.readFileSync(path.join(__dirname, 'gate.template.yml'), 'utf8');
const out = path.join(__dirname, '..', '.github', 'workflows', 'gate.yml');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, tpl.replace('__APPROVED_COPIES__', () => listJson).replace('__GATE_JS__', () => js));
console.log(`wrote ${path.relative(process.cwd(), out)}`);
