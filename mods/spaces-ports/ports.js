// Listening TCP ports per space, like the old herdr-gpui status line: a port
// belongs to a space when the listening process descends from one of the
// space's terminals. Remote spaces' ports are forwarded here over ssh on click.

import { terminals, exec, hc, notify } from 'herdr';

// Prints "L <port> <pid>" for each listening socket the user may see, then
// "P <pid> <ppid>" for every process. Linux uses ss, macOS lsof.
const SCAN = `
if command -v ss >/dev/null 2>&1; then
  ss -ltnpH 2>/dev/null | awk '{n=split($4,a,":"); port=a[n]; s=$0;
    while (match(s,/pid=[0-9]+/)) { print "L", port, substr(s,RSTART+4,RLENGTH-4); s=substr(s,RSTART+RLENGTH) } }'
else
  lsof -nP -iTCP -sTCP:LISTEN -Fpn 2>/dev/null | awk '/^p/{pid=substr($0,2)} /^n/{n=split($0,a,":"); print "L", a[n], pid}'
fi
ps -eo pid=,ppid= | awk '{print "P", $1, $2}'
`;

export const FORWARD_LABEL = 'ports.forward';

// machine name (null: here) of a core address like "glod/t3".
const machineOf = (address) =>
  address.includes('/') ? address.split('/')[0] : null;

export class PortScanner {
  constructor() {
    this.pids = {}; // terminal address -> shell pid
    this.bySpace = {}; // space id -> sorted ports
    this.busy = 0; // when the running scan started (0: none)
  }

  async pidOf(t) {
    if (typeof t.pid === 'number') return t.pid;
    if (this.pids[t.address]) return this.pids[t.address];
    const r = await hc(['get', t.address, '--json']).catch(() => null);
    let pid = null;
    try {
      pid = JSON.parse(r?.stdout ?? '').pid ?? null;
    } catch {}
    // Cache only a real pid: a failed lookup (core still starting, machine
    // reconnecting) must be retried on the next scan, not remembered.
    if (pid) this.pids[t.address] = pid;
    return pid;
  }

  // Resolves to true when anything changed.
  async scan() {
    // A scan started while this copy was being created can hang for good
    // (its exec never answers), so a scan older than 20 s no longer blocks.
    if (this.busy && Date.now() - this.busy < 20000) return false;
    const started = (this.busy = Date.now());
    try {
      // machine -> Map(shell pid -> space id)
      const roots = new Map();
      const live = new Set();
      for (const t of terminals()) {
        live.add(t.address);
        const label = t.labels?.['herdr.space'];
        if (t.state !== 'live' || !label) continue;
        const machine = machineOf(t.address);
        const pid = await this.pidOf(t);
        if (!pid) continue;
        if (!roots.has(machine)) roots.set(machine, new Map());
        roots.get(machine).set(pid, machine ? `${machine}/${label}` : label);
      }
      for (const a of Object.keys(this.pids))
        if (!live.has(a)) delete this.pids[a];

      const next = {};
      await Promise.all(
        [...roots].map(async ([machine, shells]) => {
          const r = await exec('sh', ['-c', SCAN], { on: machine }).catch(
            () => null
          );
          if (!r) return;
          const parent = new Map();
          const listens = [];
          for (const line of r.stdout.split('\n')) {
            const [k, a, b] = line.trim().split(/\s+/);
            if (k === 'P') parent.set(Number(a), Number(b));
            else if (k === 'L' && Number(a) > 0)
              listens.push([Number(a), Number(b)]);
          }
          for (const [port, pid] of listens) {
            let p = pid;
            for (let hops = 0; p > 1 && hops < 64; hops++) {
              const space = shells.get(p);
              if (space) {
                (next[space] ??= new Set()).add(port);
                break;
              }
              p = parent.get(p);
            }
          }
        })
      );
      const out = Object.fromEntries(
        Object.entries(next).map(([s, set]) => [
          s,
          [...set].sort((a, b) => a - b),
        ])
      );
      const changed = JSON.stringify(out) !== JSON.stringify(this.bySpace);
      this.bySpace = out;
      return changed;
    } finally {
      if (this.busy === started) this.busy = 0;
    }
  }
}

// Live forwards started by this mod: "machine:port" -> { address, local }.
export function forwards() {
  const out = {};
  for (const t of terminals()) {
    const v = t.labels?.[FORWARD_LABEL];
    if (!v || t.state !== 'live' || machineOf(t.address)) continue;
    const [key, local] = v.split('=');
    out[key] = { address: t.address, local: Number(local) };
  }
  return out;
}

async function listening(port) {
  const r = await exec('lsof', [
    '-nP',
    `-iTCP:${port}`,
    '-sTCP:LISTEN',
    '-t',
  ]).catch(() => null);
  return Boolean(r?.stdout.trim());
}

async function open(port) {
  await exec('open', [`http://localhost:${port}/`]);
}

// Opens a space's port in the browser: directly when the space is here,
// otherwise through an ssh -L forward (started once, reused after).
export async function openPort(machine, port, target) {
  if (!machine) return open(port);
  const key = `${machine}:${port}`;
  const existing = forwards()[key];
  if (existing) return open(existing.local);
  if (!target) {
    notify({
      title: "Can't forward",
      body: `No ssh target for ${machine}`,
      level: 'error',
    });
    return;
  }
  let local = port;
  for (let i = 0; i < 20 && (await listening(local)); i++)
    local = 20000 + Math.floor(Math.random() * 40000);
  // ControlMaster=no: the user's ssh config multiplexes, which would move the
  // listener into a detached master and end this terminal at once.
  await hc([
    'run',
    '--bg',
    '--label',
    `${FORWARD_LABEL}=${key}=${local}`,
    '--',
    'ssh',
    '-N',
    '-o',
    'ControlMaster=no',
    '-o',
    'ControlPath=none',
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'ServerAliveInterval=15',
    '-L',
    `127.0.0.1:${local}:localhost:${port}`,
    target,
  ]);
  for (let i = 0; i < 40; i++) {
    if (await listening(local)) {
      notify({
        title: `Forwarding ${machine}:${port}`,
        body: `→ localhost:${local}`,
        level: 'info',
        timeout: 4000,
      });
      return open(local);
    }
    await exec('sleep', ['0.25']);
  }
  notify({
    title: 'Forward failed',
    body: `${machine}:${port} did not start listening`,
    level: 'error',
  });
}

export async function stopForward(machine, port) {
  const f = forwards()[`${machine}:${port}`];
  if (f) await hc(['kill', f.address]);
}
