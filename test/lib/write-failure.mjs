// Loaded explicitly by subprocess tests; no production fault-injection switches.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename, relative, sep } from 'node:path';

const { out, trace, faults } = JSON.parse(process.env.FAVSEED_TEST_WRITE_FAILURE);
const append = fs.appendFileSync;
const area = (path) => {
  if (typeof path !== 'string') return null;
  const parts = relative(out, path).split(sep);
  if (parts[0] === '..') return null;
  return parts[0].startsWith('.favseed.') ? (parts[1] === 'previous' ? 'backup' : 'stage') : 'out';
};
for (const method of ['writeFileSync', 'copyFileSync', 'renameSync', 'rmSync']) {
  const original = fs[method];
  fs[method] = (...args) => {
    const paired = method === 'renameSync' || method === 'copyFileSync';
    const target = args[paired ? 1 : 0];
    const event = { method, from: paired ? area(args[0]) : null, to: area(target), name: basename(target) };
    const fault = faults.find(
      (rule) => !rule.used && Object.entries(rule).every(([key, value]) => key === 'code' || event[key] === value),
    );
    if (fault) {
      fault.used = true;
      append(trace, JSON.stringify({ ...event, failed: true }) + '\n');
      throw Object.assign(new Error(`injected ${fault.code}: ${method} ${event.name}`), { code: fault.code });
    }
    const result = original(...args);
    if (event.to || event.from) append(trace, JSON.stringify(event) + '\n');
    return result;
  };
}
syncBuiltinESMExports();
