// Continue a chat on the PC, inside its real Claude Code session (same
// session id, so the desktop app shows the new turns as part of that chat).
//
// Hosted (container on a server): a job file goes into the bridge folder; the
// sync agent on the PC picks it up over its SSH channel, runs
// `claude -p --resume <id> --output-format stream-json` there, and streams the
// output lines back into bridge/events/<job>.jsonl, which we tail here.
// Local (server running on the PC): we run that same CLI command directly.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { relayToDesktop } from './relay.mjs';

const HOSTED = process.env.CHATLENS_HOSTED === '1';
export const BRIDGE = process.env.CHATLENS_BRIDGE_DIR || null;
const LIVE_FILE = process.env.CHATLENS_LIVE_FILE || null;
const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');

const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/** Claude sessions running on the PC right now: [{sessionId, name, status, updatedAt, entrypoint, alive}] */
export async function liveSessions() {
  if (HOSTED) {
    try {
      const j = JSON.parse(await fsp.readFile(LIVE_FILE, 'utf8'));
      // The PC agent rewrites this every few seconds; a stale file means the PC is off.
      const age = Date.now() - new Date(j.at).getTime();
      return { at: j.at, stale: age > 60000, sessions: age > 600000 ? [] : j.sessions };
    } catch { return { at: null, stale: true, sessions: [] }; }
  }
  return { at: new Date().toISOString(), stale: false, sessions: await readRegistry() };
}

// Shared with the sync agent: reads ~/.claude/sessions/<pid>.json.
export async function readRegistry(dir = SESSIONS_DIR) {
  const out = [];
  let names = [];
  try { names = (await fsp.readdir(dir)).filter((n) => n.endsWith('.json')); } catch { return out; }
  for (const n of names) {
    try {
      const j = JSON.parse(await fsp.readFile(path.join(dir, n), 'utf8'));
      if (!j.sessionId || !pidAlive(j.pid)) continue;
      out.push({ sessionId: j.sessionId, name: j.name || null, status: j.status || null, updatedAt: j.updatedAt || null,
        statusUpdatedAt: j.statusUpdatedAt || null, entrypoint: j.entrypoint || null, kind: j.kind || null, hostSessionId: j.hostSessionId || null });
    } catch { /* mid-write */ }
  }
  return out;
}

export function cliArgs({ sessionId, model, effort, fullTools }) {
  const a = ['-p', '--resume', sessionId, '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
  if (model) a.push('--model', model);
  if (effort) a.push('--effort', effort);
  if (fullTools) a.push('--dangerously-skip-permissions');
  else a.push('--permission-mode', 'dontAsk', '--allowedTools', 'Read Glob Grep WebSearch WebFetch');
  return a;
}

/**
 * Run one continuation turn. Calls onLine(obj) for each stream-json message
 * and onStatus(text) for progress; resolves {code, stderr} when the CLI exits.
 */
export async function runOnPc(job, { onLine, onStatus, signal }) {
  return HOSTED ? runViaBridge(job, { onLine, onStatus, signal }) : runLocally(job, { onLine, onStatus, signal });
}

function processName(pid) {
  try {
    const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
    return (/^"([^"]+)"/.exec(out.trim()) || [])[1]?.toLowerCase() || null;
  } catch { return null; }
}
// Same rule as the sync agent: stop the idle background process of a chat that
// is open in the desktop app, never a busy one. Returns a reason when blocked.
export async function takeOver(sessionId) {
  let names = [];
  try { names = (await fsp.readdir(SESSIONS_DIR)).filter((n) => n.endsWith('.json')); } catch { return null; }
  for (const n of names) {
    let j; try { j = JSON.parse(await fsp.readFile(path.join(SESSIONS_DIR, n), 'utf8')); } catch { continue; }
    if (j.sessionId !== sessionId || !pidAlive(j.pid)) continue;
    if (j.status !== 'idle') return `Claude is working in that chat right now (${j.status || 'busy'}). Reply again once it finishes.`;
    if (Date.now() - (j.statusUpdatedAt || 0) < 5000) return 'That chat was just used. Try again in a few seconds.';
    const name = processName(j.pid);
    if (!name || !name.startsWith('claude')) return `Could not confirm the process holding that chat (pid ${j.pid}), so it was left alone.`;
    try { process.kill(j.pid); } catch (e) { return `Could not stop the idle process for that chat: ${e.message}`; }
    for (let i = 0; i < 50 && pidAlive(j.pid); i++) await new Promise((r) => setTimeout(r, 100));
    if (pidAlive(j.pid)) return 'The idle process for that chat did not stop in time.';
  }
  return null;
}

async function runLocally(job, { onLine, onStatus, signal }) {
  const exe = path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
  // Open in the desktop app: relay into that live window (same as the sync agent does).
  const live = await readRegistry();
  const desk = live.find((s) => s.sessionId === job.sessionId && s.entrypoint === 'claude-desktop');
  if (desk) {
    onStatus?.('Relaying to the desktop app…');
    const r = await relayToDesktop({ entry: desk, others: live, text: job.prompt, claudeExe: exe });
    onLine({ type: 'chatlens_relay', ok: r.ok, detail: r.detail, exact: r.exact, name: desk.name, status: desk.status });
    return { code: 0, relayed: true };
  }
  if (!fs.existsSync(job.cwd || '')) throw new Error(`The chat's folder no longer exists: ${job.cwd}`);
  const blocked = await takeOver(job.sessionId);
  if (blocked) throw new Error(blocked);
  onStatus?.('Running on this PC…');
  const proc = spawn(fs.existsSync(exe) ? exe : 'claude', cliArgs(job), { cwd: job.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  proc.stdin.end(job.prompt);
  let buf = '', stderr = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) { try { onLine(JSON.parse(l)); } catch { /* non-JSON */ } } }
  });
  proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
  const kill = () => proc.kill();
  signal?.addEventListener('abort', kill);
  const code = await new Promise((r) => proc.on('close', r));
  signal?.removeEventListener('abort', kill);
  return { code, stderr };
}

async function runViaBridge(job, { onLine, onStatus, signal }) {
  const jobs = path.join(BRIDGE, 'jobs'), events = path.join(BRIDGE, 'events');
  await fsp.mkdir(jobs, { recursive: true }); await fsp.mkdir(events, { recursive: true });
  const jobFile = path.join(jobs, `${job.id}.json`);
  const evFile = path.join(events, `${job.id}.jsonl`);
  await fsp.writeFile(jobFile + '.tmp', JSON.stringify(job));
  await fsp.rename(jobFile + '.tmp', jobFile);
  onStatus?.('Waiting for the PC…');
  const stop = () => fsp.writeFile(path.join(jobs, `${job.id}.stop`), '').catch(() => {});
  signal?.addEventListener('abort', stop);

  const started = Date.now();
  let offset = 0, carry = '', taken = false, exit = null;
  try {
    while (!exit) {
      if (!taken && fs.existsSync(path.join(jobs, `${job.id}.taken`))) { taken = true; onStatus?.('Running on the PC…'); }
      if (!taken && Date.now() - started > 25000) {
        await fsp.rm(jobFile, { force: true });
        throw new Error('The PC did not pick this up. Its sync agent is not connected (is the PC on and signed in?).');
      }
      let st = null;
      try { st = await fsp.stat(evFile); } catch { /* not yet */ }
      if (st && st.size > offset) {
        const fh = await fsp.open(evFile, 'r');
        try {
          const b = Buffer.alloc(st.size - offset);
          await fh.read(b, 0, b.length, offset);
          offset = st.size;
          carry += b.toString('utf8');
        } finally { await fh.close(); }
        let i;
        while ((i = carry.indexOf('\n')) >= 0) {
          const l = carry.slice(0, i).trim(); carry = carry.slice(i + 1);
          if (!l) continue;
          let o; try { o = JSON.parse(l); } catch { continue; }
          if (o.type === 'chatlens_exit') exit = { code: o.code, stderr: o.stderr || '', error: o.error, relayed: !!o.relayed };
          else onLine(o);
        }
      }
      if (!exit) await new Promise((r) => setTimeout(r, 250));
    }
  } finally {
    signal?.removeEventListener('abort', stop);
  }
  if (exit.error) throw new Error(exit.error);
  return exit;
}

// Old bridge files are only useful while a turn is being watched.
export async function cleanBridge(maxAgeMs = 24 * 3600e3) {
  if (!BRIDGE) return;
  for (const sub of ['jobs', 'events']) {
    const dir = path.join(BRIDGE, sub);
    let names = [];
    try { names = await fsp.readdir(dir); } catch { continue; }
    for (const n of names) {
      const p = path.join(dir, n);
      try { if (Date.now() - (await fsp.stat(p)).mtimeMs > maxAgeMs) await fsp.rm(p, { force: true }); } catch { /* */ }
    }
  }
}
