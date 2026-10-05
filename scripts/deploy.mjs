// `npm run deploy`: deploys with Wrangler. While wrangler.toml still has the
// template's placeholder KV id, deploy from a copy without it so Wrangler
// creates your KV namespace (and keeps it linked on later deploys).
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const PLACEHOLDER = '00000000000000000000000000000000';
const config = fs.readFileSync('wrangler.toml', 'utf8');
const args = ['wrangler', 'deploy', ...process.argv.slice(2)];
let tmp;
if (config.includes(PLACEHOLDER)) {
  tmp = '.wrangler.deploy.toml';
  fs.writeFileSync(tmp, config.replace(new RegExp(`^id = "${PLACEHOLDER}"\\r?\\n`, 'm'), ''));
  args.push('--config', tmp);
}
const r = spawnSync('npx', args, { stdio: 'inherit', shell: process.platform === 'win32' });
if (tmp) fs.rmSync(tmp, { force: true });
process.exit(r.status ?? 1);
