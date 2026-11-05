// Builds .github/workflows/gate.yml (the reusable workflow) by embedding gate.js.
const fs = require('node:fs');
const path = require('node:path');

const js = fs.readFileSync(path.join(__dirname, 'gate.js'), 'utf8')
  .split('\n').map((l) => (l ? `              ${l}` : l)).join('\n');
const tpl = fs.readFileSync(path.join(__dirname, 'gate.template.yml'), 'utf8');
const out = path.join(__dirname, '..', '.github', 'workflows', 'gate.yml');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, tpl.replace('__GATE_JS__', js));
console.log(`wrote ${path.relative(process.cwd(), out)}`);
