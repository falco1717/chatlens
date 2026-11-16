// ChatLens sync agent: runs on the PC that has the Claude chats and mirrors
// them to the ChatLens server over one long-lived SSH connection
// (sync/receiver.py on the far end). It also relays/continues chats there.
//
//   node sync/chatlens-sync.mjs           run forever (started hidden at logon)
//   node sync/chatlens-sync.mjs --once    one pass, then exit (for testing)
//
// Settings (environment variables win over the file):
//   %LOCALAPPDATA%ChatLensconfig.json  {"host": "user@server", "remoteRoot": ..., "receiver": ..., "bridge": ...}
//   CHATLENS_SYNC_HOST      SSH destination (required), e.g. me@my-server
//   CHATLENS_SYNC_ROOT      mirror folder on the server   (default /opt/chatlens/sync)
//   CHATLENS_SYNC_RECEIVER  receiver.py on the server     (default /opt/chatlens/receiver.py)
//   CHATLENS_SYNC_BRIDGE    job folder on the server      (default /opt/chatlens/bridge)
//
// Transcripts (*.jsonl) only grow, so after the first copy only new bytes are
// sent. Everything is one-way: nothing on the PC is ever changed.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { relayToDesktop } from '../lib/relay.mjs';

const HOME = os.homedir();
const APP_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// A paired install keeps its config, lock and log next to itself
// (%LOCALAPPDATA%ChatLensagent); a repo checkout uses %LOCALAPPDATA%ChatLens.
const STATE_DIR = fs.existsSync(path.join(APP_DIR, 'config.json')) ? APP_DIR : path.join(process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'), 'ChatLens');
let FILE_CFG = {};
// (Windows PowerShell 5 writes UTF-8 with a BOM; JSON.parse does not accept one.)
try { FILE_CFG = JSON.parse(fs.readFileSync(process.env.CHATLENS_SYNC_CONFIG || path.join(STATE_DIR, 'config.json'), 'utf8').replace(/^\uFEFF/, '')); } catch { /* none */ }
const CFG = {
  // HTTPS (paired from ChatLens Settings) ...
  server: process.env.CHATLENS_SERVER || FILE_CFG.server,
  token: process.env.CHATLENS_TOKEN || FILE_CFG.token,
  // ... or SSH (the original setup)
  host: process.env.CHATLENS_SYNC_HOST || FILE_CFG.host,
  remoteRoot: process.env.CHATLENS_SYNC_ROOT || FILE_CFG.remoteRoot || '/opt/chatlens/sync',
  receiver: process.env.CHATLENS_SYNC_RECEIVER || FILE_CFG.receiver || '/opt/chatlens/receiver.py',
  bridge: process.env.CHATLENS_SYNC_BRIDGE || FILE_CFG.bridge || '/opt/chatlens/bridge',
  claude: path.join(HOME, '.local', 'bin', 'claude.exe'),
  sessions: path.join(HOME, '.claude', 'sessions'),
  projects: path.join(HOME, '.claude', 'projects'),
  desktop: path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'Claude', 'claude-code-sessions'),
  // The local ChatLens's own agent sessions are not chats worth mirroring.
  exclude: new Set([path.join(APP_DIR, 'workspace').replace(/[^A-Za-z0-9]/g, '-').toLowerCase()]),
  intervalMs: 1500,      // a pass: transcripts + live sessions + job pickup
  busyIntervalMs: 800,   // while a session is busy or a job runs, so the web view keeps up
  chunk: 4 * 1024 * 1024,
  maxSideFile: 20 * 1024 * 1024, // offloaded tool output larger than this is skipped
};
const LOG = path.join(STATE_DIR, 'sync.log');
const LOCK = path.join(STATE_DIR, 'sync.lock');
const ONCE = process.argv.includes('--once');
fs.mkdirSync(STATE_DIR, { recursive: true });

function log(...a) {
  const line = `${new Date().toISOString()} ${a.join(' ')}\n`;
  if (ONCE || process.stdout.isTTY) process.stdout.write(line);
  try {
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 5e6) fs.renameSync(LOG, LOG + '.1');
    fs.appendFileSync(LOG, line);
  } catch { /* ignore */ }
}

// ---- single instance ----
function takeLock() {
  try {
    const pid = Number(fs.readFileSync(LOCK, 'utf8'));
    if (pid && pid !== process.pid) { try { process.kill(pid, 0); return false; } catch { /* stale */ } }
  } catch { /* none */ }
  fs.writeFileSync(LOCK, String(process.pid));
  return true;
}

// ---- local scan ----
// Returns Map rel -> { full, size, mtimeMs, kind: 'log' | 'file' }.
async function scan() {
  const out = new Map();
  const add = async (full, rel, kind) => {
    try {
      const st = await fsp.stat(full);
      if (kind === 'file' && st.size > CFG.maxSideFile) return;
      out.set(rel, { full, size: st.size, mtimeMs: st.mtimeMs, kind });
    } catch { /* vanished */ }
  };
  const ls = async (d) => { try { return await fsp.readdir(d, { withFileTypes: true }); } catch { return []; } };
  for (const proj of await ls(CFG.projects)) {
    if (!proj.isDirectory() || CFG.exclude.has(proj.name.toLowerCase())) continue;
    const pdir = path.join(CFG.projects, proj.name);
    const prel = `projects/${proj.name}`;
    for (const e of await ls(pdir)) {
      const full = path.join(pdir, e.name);
      if (e.isFile() && e.name.endsWith('.jsonl')) await add(full, `${prel}/${e.name}`, 'log');
      else if (e.isDirectory() && e.name === 'memory') {
        for (const m of await ls(full)) if (m.isFile() && m.name.endsWith('.md')) await add(path.join(full, m.name), `${prel}/memory/${m.name}`, 'file');
      } else if (e.isDirectory()) {
        // <session-id>/subagents/* and <session-id>/tool-results/*
        for (const sub of ['subagents', 'tool-results']) {
          for (const f of await ls(path.join(full, sub))) {
            if (!f.isFile()) continue;
            const kind = f.name.endsWith('.jsonl') ? 'log' : 'file';
            if (sub === 'subagents' && kind === 'file' && !f.name.endsWith('.meta.json')) continue;
            await add(path.join(full, sub, f.name), `${prel}/${e.name}/${sub}/${f.name}`, kind);
          }
        }
      }
    }
  }
  return out;
}

// Desktop-app metadata, reduced to what ChatLens shows (the raw files carry
// large MCP configs and change on every focus).
async function desktopIndex() {
  const map = {};
  const walk = async (dir, depth) => {
    let entries = [];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 4 && !e.name.startsWith('deleted_')) await walk(p, depth + 1);
      else if (e.isFile() && /^local_.*\.json$/.test(e.name)) {
        try {
          const j = JSON.parse(await fsp.readFile(p, 'utf8'));
          if (j.cliSessionId) map[j.cliSessionId] = { desktopId: j.sessionId, title: j.title, archived: !!j.isArchived, createdAt: j.createdAt, lastActivityAt: j.lastActivityAt, model: j.model, effort: j.effort };
        } catch { /* mid-write */ }
      }
    }
  };
  await walk(CFG.desktop, 0);
  return Buffer.from(JSON.stringify(map));
}

// ---- SSH channel ----
class Channel {
  constructor() {
    const ssh = process.env.CHATLENS_SSH || (fs.existsSync('C:\\Windows\\System32\\OpenSSH\\ssh.exe') ? 'C:\\Windows\\System32\\OpenSSH\\ssh.exe' : 'ssh');
    this.proc = spawn(ssh, ['-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3', '-o', 'ConnectTimeout=15',
      CFG.host, 'python3', '-u', CFG.receiver, CFG.remoteRoot, CFG.bridge], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.buf = '';
    this.waiters = [];
    this.closed = false;
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (d) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
        const w = this.waiters.shift();
        if (w) w.resolve(JSON.parse(line));
      }
    });
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (d) => log('ssh:', d.trim()));
    const fail = (why) => {
      if (this.closed) return;
      this.closed = true;
      for (const w of this.waiters.splice(0)) w.reject(new Error(why));
    };
    this.proc.on('exit', (code) => fail(`ssh exited (${code})`));
    this.proc.on('error', (e) => fail(`ssh failed: ${e.message}`));
    this.proc.stdin.on('error', () => fail('ssh stdin closed'));
  }
  request(header, payload) {
    if (this.closed) return Promise.reject(new Error('channel closed'));
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      const h = { ...header, ...(payload ? { len: payload.length } : {}) };
      this.proc.stdin.write(JSON.stringify(h) + '\n');
      if (payload?.length) this.proc.stdin.write(payload);
    });
  }
  close() { try { this.proc.stdin.end(); } catch { /* */ } }
}

// ---- live sessions: ~/.claude/sessions/<pid>.json for processes still running ----
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
async function liveSessions() {
  const out = [];
  let names = [];
  try { names = (await fsp.readdir(CFG.sessions)).filter((n) => n.endsWith('.json')); } catch { return out; }
  for (const n of names) {
    try {
      const j = JSON.parse(await fsp.readFile(path.join(CFG.sessions, n), 'utf8'));
      if (!j.sessionId || !pidAlive(j.pid)) continue;
      out.push({ sessionId: j.sessionId, name: j.name || null, status: j.status || null, updatedAt: j.updatedAt || null,
        statusUpdatedAt: j.statusUpdatedAt || null, entrypoint: j.entrypoint || null, kind: j.kind || null });
    } catch { /* mid-write */ }
  }
  out.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  return out;
}

// ---- jobs: continue a chat in its own session, on this PC ----
const jobsRunning = new Map(); // job id -> child process

// Files attached in ChatLens: the note that tells Claude where they are.
const kb = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
function attachmentNote(files) {
  if (!files.length) return '';
  return '\n\n[Attached files — open them with the Read tool]\n' + files.map((f) => `- ${f.path} (${f.type || 'file'}, ${kb(f.size)})`).join('\n');
}
function cliArgs({ sessionId, model, effort, fullTools }, extraDirs = []) {
  const a = ['-p', '--resume', sessionId, '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
  if (model) a.push('--model', model);
  if (effort) a.push('--effort', effort);
  if (fullTools) a.push('--dangerously-skip-permissions');
  else a.push('--permission-mode', 'dontAsk', '--allowedTools', 'Read Glob Grep WebSearch WebFetch');
  for (const d of extraDirs) a.push('--add-dir', d); // so Claude may read attached files
  return a;
}
// The image name of a running process (Windows), or null.

// Is this chat stopped on an unanswered AskUserQuestion? (Then answering it may
// take the chat over even though its process isn't idle: it's waiting for you.)
async function pendingQuestion(sessionId, projectsDir) {
  let file = null;
  for (const d of await fsp.readdir(projectsDir).catch(() => [])) {
    const f = path.join(projectsDir, d, sessionId + '.jsonl');
    if (fs.existsSync(f)) { file = f; break; }
  }
  if (!file) return false;
  const st = await fsp.stat(file);
  const len = Math.min(st.size, 2 * 1024 * 1024);
  const fh = await fsp.open(file, 'r');
  const buf = Buffer.alloc(len);
  try { await fh.read(buf, 0, len, st.size - len); } finally { await fh.close(); }
  let ask = null; const answered = new Set();
  for (const line of buf.toString('utf8').split('\n')) {
    let o; try { o = JSON.parse(line); } catch { continue; }
    for (const b of (Array.isArray(o.message?.content) ? o.message.content : [])) {
      if (o.type === 'assistant' && b.type === 'tool_use' && b.name === 'AskUserQuestion') ask = b.id;
      if (o.type === 'user' && b.type === 'tool_result') answered.add(b.tool_use_id);
    }
  }
  return !!ask && !answered.has(ask);
}

function processName(pid) {
  try {
    const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
    const m = /^"([^"]+)"/.exec(out.trim());
    return m ? m[1].toLowerCase() : null;
  } catch { return null; }
}

// A chat open but idle in the desktop app has a Claude process waiting in the
// background. Stop that one process so the chat has a single writer; the desktop
// app reloads the chat from its transcript when you click back into it.
async function takeOver(sessionId, { answering = false } = {}) {
  const entries = [];
  for (const n of await fsp.readdir(CFG.sessions).catch(() => [])) {
    if (!n.endsWith('.json')) continue;
    try { const j = JSON.parse(await fsp.readFile(path.join(CFG.sessions, n), 'utf8')); if (j.sessionId === sessionId && pidAlive(j.pid)) entries.push(j); } catch { /* */ }
  }
  for (const j of entries) {
    const waitingForYou = answering && await pendingQuestion(sessionId, CFG.projects);
    if (j.status !== 'idle' && !waitingForYou) return `Claude is working in that chat on this PC right now (${j.status || 'busy'}). Reply again once it finishes.`;
    if (!waitingForYou && Date.now() - (j.statusUpdatedAt || 0) < 5000) return 'That chat was just used on this PC. Try again in a few seconds.';
    const name = processName(j.pid);
    if (!name || !name.startsWith('claude')) return `Could not confirm the process holding that chat (pid ${j.pid} is ${name || 'unknown'}), so it was left alone.`;
    log('taking over session', sessionId, 'from idle pid', j.pid, `(${j.entrypoint || '?'})`);
    try { process.kill(j.pid); } catch (e) { return `Could not stop the idle process for that chat: ${e.message}`; }
    for (let i = 0; i < 50 && pidAlive(j.pid); i++) await new Promise((r) => setTimeout(r, 100));
    if (pidAlive(j.pid)) return 'The idle process for that chat did not stop in time.';
  }
  return null;
}

async function runJob(ch, job) {
  const send = (obj) => ch.request({ op: 'event', job: job.id }, Buffer.from(JSON.stringify(obj) + '\n')).catch(() => {});
  const fail = (error) => { log('job', job.id, 'refused:', error); return send({ type: 'chatlens_exit', code: -1, error }); };
  // Open in the desktop app: relay the message into that live window instead of running it here.
  // Attached files: save them under this agent's folder and point Claude at them.
  let extraDirs = [];
  if (job.attachments?.length) {
    const dir = path.join(STATE_DIR, 'uploads', job.id);
    fs.mkdirSync(dir, { recursive: true });
    const saved = job.attachments.map((f) => {
      const name = path.basename(String(f.name || 'file')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'file';
      const full = path.join(dir, name);
      fs.writeFileSync(full, Buffer.from(f.data || '', 'base64'));
      return { path: full, type: f.type, size: f.size };
    });
    job = { ...job, prompt: job.prompt + attachmentNote(saved) };
    extraDirs = [dir];
    log('job', job.id, 'saved', saved.length, 'attached file(s) in', dir);
  }
  const live = await liveSessions();
  const desk = live.find((s) => s.sessionId === job.sessionId && s.entrypoint === 'claude-desktop');
  if (desk && !job.asMe) {
    log('job', job.id, 'relaying into desktop chat', JSON.stringify(desk.name), `(${desk.status})`);
    const r = await relayToDesktop({ entry: desk, others: live, text: job.prompt, claudeExe: CFG.claude });
    log('job', job.id, r.ok ? 'relayed' : 'relay failed:', r.ok ? '' : r.detail);
    await send({ type: 'chatlens_relay', ok: r.ok, detail: r.detail, exact: r.exact, name: desk.name, status: desk.status });
    return send({ type: 'chatlens_exit', code: 0, relayed: true });
  }
  if (!job.cwd || !fs.existsSync(job.cwd)) return fail(`The chat's folder no longer exists on this PC: ${job.cwd}`);
  // One writer per transcript: take the chat over from the desktop app if it's idle there, never if busy.
  const blocked = await takeOver(job.sessionId, { answering: !!job.answering });
  if (blocked) return fail(blocked);
  log('job', job.id, 'continuing session', job.sessionId, 'in', job.cwd);
  const proc = spawn(fs.existsSync(CFG.claude) ? CFG.claude : 'claude', cliArgs(job, extraDirs), { cwd: job.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  jobsRunning.set(job.id, proc);
  proc.stdin.end(job.prompt);
  // Forward stdout in small batches of whole lines.
  let pending = '', stderr = '', timer = null;
  const flush = () => {
    timer = null;
    const cut = pending.lastIndexOf('\n');
    if (cut < 0) return;
    const chunk = pending.slice(0, cut + 1); pending = pending.slice(cut + 1);
    ch.request({ op: 'event', job: job.id }, Buffer.from(chunk)).catch(() => {});
  };
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (d) => { pending += d; if (!timer) timer = setTimeout(flush, 120); });
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
  proc.on('error', (e) => { stderr += `\nspawn failed: ${e.message}`; });
  proc.on('close', (code) => {
    clearTimeout(timer); pending += '\n'; flush();
    jobsRunning.delete(job.id);
    log('job', job.id, 'finished, code', code);
    send({ type: 'chatlens_exit', code, stderr });
  });
}

// ---- HTTPS channel: the same requests, as calls to ChatLens's /agent API ----
class HttpChannel {
  constructor() { this.closed = false; }
  async request(header, payload) {
    const q = new URLSearchParams();
    if (header.path != null) q.set('path', header.path);
    if (header.offset != null) q.set('offset', String(header.offset));
    if (header.job != null) q.set('job', header.job);
    const body = header.op === 'stamp' ? Buffer.from(JSON.stringify(header.data || {})) : (payload || Buffer.alloc(0));
    let res;
    try {
      res = await fetch(`${CFG.server}/agent/${header.op}?${q}`, {
        method: 'POST', headers: { Authorization: `Bearer ${CFG.token}`, 'Content-Type': 'application/octet-stream' }, body,
        signal: AbortSignal.timeout(header.op === 'append' || header.op === 'put' ? 120000 : 30000),
      });
    } catch (e) { throw new Error(`cannot reach ${CFG.server}: ${e.cause?.code || e.message}`); }
    if (res.status === 401) { const e = new Error('This PC was removed from ChatLens (its access key is no longer valid).'); e.fatal = true; throw e; }
    if (!res.ok) throw new Error(`${header.op}: HTTP ${res.status}`);
    return res.json();
  }
  close() { this.closed = true; }
}

async function readRange(full, start, end) {
  const fh = await fsp.open(full, 'r');
  try {
    const buf = Buffer.allocUnsafe(end - start);
    const { bytesRead } = await fh.read(buf, 0, end - start, start);
    return buf.subarray(0, bytesRead);
  } finally { await fh.close(); }
}

// ---- one session of syncing over a live channel ----
async function runSession() {
  const ch = CFG.server ? new HttpChannel() : new Channel();
  const hello = await ch.request({ op: 'hello' });
  const remote = new Map(Object.entries(hello.files)); // rel -> size
  const sent = new Map(); // rel -> mtimeMs last pushed (side files)
  let desktopHash = '';
  log(`connected to ${CFG.server || CFG.host}; remote has ${remote.size} files`);
  let lastStamp = 0, lastLive = '', lastLiveAt = 0;

  for (;;) {
    const t0 = Date.now();
    const local = await scan();
    let bytes = 0, files = 0;

    for (const [rel, f] of local) {
      const rsize = remote.get(rel);
      if (f.kind === 'log') {
        if (rsize === f.size) continue;
        if (rsize !== undefined && rsize < f.size) {
          // append only the new bytes, in chunks
          let off = rsize;
          while (off < f.size) {
            const data = await readRange(f.full, off, Math.min(f.size, off + CFG.chunk));
            if (!data.length) break;
            const r = await ch.request({ op: 'append', path: rel, offset: off }, data);
            if (!r.ok) { log('append refused', rel, r.error || '', 'remote size', r.size); remote.set(rel, r.size ?? 0); off = -1; break; }
            off = r.size; bytes += data.length;
          }
          if (off >= 0) { remote.set(rel, off); files++; }
          continue;
        }
        // new on the server, or the local file shrank (rewritten): send it whole
      } else if (rsize === f.size && (sent.get(rel) ?? 0) >= f.mtimeMs) continue;
      else if (rsize === f.size && !sent.has(rel)) { sent.set(rel, f.mtimeMs); continue; } // first pass: same size = same file
      if (f.size > 64 * 1024 * 1024) {
        // big new transcript: stream it as appends from 0 instead of one put
        await ch.request({ op: 'put', path: rel }, Buffer.alloc(0));
        remote.set(rel, 0);
        let off = 0;
        while (off < f.size) {
          const data = await readRange(f.full, off, Math.min(f.size, off + CFG.chunk));
          if (!data.length) break;
          const r = await ch.request({ op: 'append', path: rel, offset: off }, data);
          if (!r.ok) throw new Error(`append failed for ${rel}: ${r.error}`);
          off = r.size; bytes += data.length;
        }
        remote.set(rel, off);
      } else {
        const data = await fsp.readFile(f.full);
        const r = await ch.request({ op: 'put', path: rel }, data);
        if (!r.ok) { log('put failed', rel, r.error); continue; }
        remote.set(rel, data.length); bytes += data.length;
      }
      sent.set(rel, f.mtimeMs); files++;
    }

    // mirror deletions (only inside projects/)
    for (const rel of [...remote.keys()]) {
      if (rel.startsWith('projects/') && !local.has(rel)) {
        // side files over the size cap are skipped, not deleted
        await ch.request({ op: 'delete', path: rel });
        remote.delete(rel); files++;
      }
    }

    const desk = await desktopIndex();
    const h = crypto.createHash('sha1').update(desk).digest('hex');
    if (h !== desktopHash) {
      const r = await ch.request({ op: 'put', path: 'desktop.json' }, desk);
      if (r.ok) { desktopHash = h; bytes += desk.length; files++; }
    }

    // Live sessions: resend when they change, and every 20 s so the server can tell the PC is up.
    const live = await liveSessions();
    const liveKey = JSON.stringify(live);
    if (liveKey !== lastLive || Date.now() - lastLiveAt > 20000) {
      const r = await ch.request({ op: 'put', path: 'live.json' }, Buffer.from(JSON.stringify({ at: new Date().toISOString(), from: os.hostname(), sessions: live })));
      if (r.ok) { lastLive = liveKey; lastLiveAt = Date.now(); }
    }

    // Jobs from the web UI: continue a chat here, in its own session.
    if (!ONCE) {
      const jr = await ch.request({ op: 'jobs' });
      for (const id of jr.stops || []) { const p = jobsRunning.get(id); if (p) { log('job', id, 'stop requested'); p.kill(); } }
      for (const job of jr.jobs || []) runJob(ch, job).catch((e) => log('job', job.id, 'crashed:', e.message));
    }

    if (files || Date.now() - lastStamp > 60000) {
      await ch.request({ op: 'stamp', data: { at: new Date().toISOString(), from: os.hostname(), files: local.size, changed: files, bytes } });
      lastStamp = Date.now();
    }
    if (files > 1 || bytes > 1e6) log(`pushed ${files} files, ${(bytes / 1e6).toFixed(2)} MB in ${Date.now() - t0} ms`);
    if (ONCE) { ch.close(); return; }
    const busy = jobsRunning.size || live.some((s) => s.status === 'busy');
    await new Promise((r) => setTimeout(r, busy ? CFG.busyIntervalMs : CFG.intervalMs));
  }
}

async function main() {
  // attached files older than a week
  for (const d of await fsp.readdir(path.join(STATE_DIR, 'uploads')).catch(() => [])) {
    const full = path.join(STATE_DIR, 'uploads', d);
    try { if (Date.now() - fs.statSync(full).mtimeMs > 7 * 24 * 3600e3) fs.rmSync(full, { recursive: true, force: true }); } catch { /* */ }
  }
  if (!CFG.host && !(CFG.server && CFG.token)) { log('No server configured: pair this PC from ChatLens (Settings > PCs), or set "host" in', path.join(STATE_DIR, 'config.json')); process.exitCode = 2; return; }
  if (!takeLock()) { log('another sync agent is running; exiting'); return; }
  let backoff = 5000;
  for (;;) {
    try {
      await runSession();
      if (ONCE) break;
    } catch (e) {
      log('sync error:', e.message);
      if (e.fatal) { process.exitCode = 3; break; } // removed in Settings: stop for good
      if (ONCE) process.exitCode = 1;
      if (ONCE) break;
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 300000);
      continue;
    }
    backoff = 5000;
  }
  try { if (Number(fs.readFileSync(LOCK, 'utf8')) === process.pid) fs.unlinkSync(LOCK); } catch { /* */ }
}

main();
