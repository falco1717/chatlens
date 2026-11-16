// PCs attached to a hosted ChatLens.
//
// Two kinds:
//   ssh     - the original setup: the PC's agent connects over SSH and
//             receiver.py writes into a folder mounted at /data/sync.
//   paired  - added from Settings: the PC's agent connects out over HTTPS to
//             /agent/* with its own bearer token, and this server writes its
//             mirror into DATA/pcs/<id>/.
// Either way each PC has the same layout: projects/, desktop.json, live.json,
// last-sync.json. "Continue this chat" jobs go through the bridge folder,
// tagged with the PC they are for.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SAFE = /^[A-Za-z0-9._ \-/]+$/;
const JOB_ID = /^[A-Za-z0-9-]{8,64}$/;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
// Files a new PC downloads while pairing (they are also in the public repo).
const AGENT_FILES = { 'sync/chatlens-sync.mjs': 'sync/chatlens-sync.mjs', 'lib/relay.mjs': 'lib/relay.mjs', 'sync/start-sync-hidden.vbs': 'sync/start-sync-hidden.vbs' };

export class PcRegistry {
  constructor({ dataDir, legacySyncDir, bridgeDir }) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'pcs.json');
    this.pcsDir = path.join(path.dirname(dataDir), 'pcs'); // next to state/, on the writable volume
    this.legacy = legacySyncDir || null;
    this.bridge = bridgeDir;
    this.pairings = new Map(); // code -> { expires, name }
    this.lastSeen = new Map();  // pc id -> ms
    try { this.pcs = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.pcs = []; }
  }

  _save() {
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.pcs, null, 1), { mode: 0o600 });
    fs.renameSync(this.file + '.tmp', this.file);
  }
  dirOf(id) { return id === 'default' ? this.legacy : path.join(this.pcsDir, id); }

  _syncInfo(id) { try { return JSON.parse(fs.readFileSync(path.join(this.dirOf(id), 'last-sync.json'), 'utf8')); } catch { return null; } }

  /** Every PC with data or a registration: [{ id, name, kind, lastSync, created }] */
  list() {
    const out = [];
    if (this.legacy && fs.existsSync(path.join(this.legacy, 'projects'))) {
      const s = this._syncInfo('default');
      out.push({ id: 'default', name: s?.from || 'PC', kind: 'ssh', lastSync: s?.at || null, created: null });
    }
    for (const p of this.pcs) {
      const s = this._syncInfo(p.id);
      out.push({ id: p.id, name: s?.from || p.name, kind: 'paired', lastSync: s?.at || null, created: p.created });
    }
    return out;
  }

  /** Index roots, one per PC. */
  roots() {
    return this.list().map((p) => {
      const d = this.dirOf(p.id);
      return { pc: p.id, name: p.name, projectsDir: path.join(d, 'projects'), desktopFile: path.join(d, 'desktop.json') };
    });
  }

  /** Live sessions across all PCs, each tagged with its pc. */
  async live() {
    const sessions = [];
    let newest = null, anyFresh = false;
    for (const p of this.list()) {
      try {
        const j = JSON.parse(await fsp.readFile(path.join(this.dirOf(p.id), 'live.json'), 'utf8'));
        const age = Date.now() - new Date(j.at).getTime();
        if (age < 60000) anyFresh = true;
        if (!newest || j.at > newest) newest = j.at;
        if (age <= 600000) for (const s of j.sessions) sessions.push({ ...s, pc: p.id, pcName: p.name });
      } catch { /* no live file yet */ }
    }
    return { at: newest, stale: !anyFresh, sessions };
  }

  pcName(id) { return this.list().find((p) => p.id === id)?.name || 'the PC'; }

  // ---- pairing ----
  createPairing() {
    for (const [c, v] of this.pairings) if (v.expires < Date.now()) this.pairings.delete(c);
    const code = crypto.randomBytes(18).toString('base64url');
    const expires = Date.now() + 15 * 60e3;
    this.pairings.set(code, { expires });
    return { code, expires: new Date(expires).toISOString() };
  }
  pairingValid(code) { const p = this.pairings.get(code); return !!p && p.expires > Date.now(); }
  claim(code, name) {
    if (!this.pairingValid(code)) return null;
    this.pairings.delete(code);
    const id = crypto.randomBytes(6).toString('hex');
    const token = crypto.randomBytes(32).toString('base64url');
    this.pcs.push({ id, name: String(name || 'PC').slice(0, 64), tokenHash: sha(token), created: new Date().toISOString() });
    this._save();
    fs.mkdirSync(path.join(this.pcsDir, id, 'projects'), { recursive: true });
    return { id, token };
  }
  remove(id) {
    const before = this.pcs.length;
    this.pcs = this.pcs.filter((p) => p.id !== id);
    if (this.pcs.length === before) return false;
    this._save();
    fs.rmSync(path.join(this.pcsDir, id), { recursive: true, force: true });
    return true;
  }
  authenticate(req) {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!m) return null;
    const h = sha(m[1]);
    const pc = this.pcs.find((p) => p.tokenHash.length === h.length && crypto.timingSafeEqual(Buffer.from(p.tokenHash), Buffer.from(h)));
    if (pc) this.lastSeen.set(pc.id, Date.now());
    return pc || null;
  }

  // ---- the agent API (/agent/*), the HTTPS twin of receiver.py ----
  async handleAgent(req, res, url, { publicUrl }) {
    const p = url.pathname;
    const send = (code, body, type = 'application/json; charset=utf-8') => {
      res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };

    // Unauthenticated: the installer (needs a live pairing code) and the agent's own files.
    if (req.method === 'GET' && p === '/agent/install.ps1') {
      const code = url.searchParams.get('code') || '';
      if (!this.pairingValid(code)) return send(403, 'Write-Host "This pairing code has expired or was already used. Make a new one in ChatLens: Settings > PCs > Add a PC." -ForegroundColor Red\n', 'text/plain; charset=utf-8');
      return send(200, installScript(publicUrl, code), 'text/plain; charset=utf-8');
    }
    if (req.method === 'GET' && p.startsWith('/agent/files/')) {
      const rel = AGENT_FILES[p.slice('/agent/files/'.length)];
      if (!rel) return send(404, { error: 'unknown file' });
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return fs.createReadStream(path.join(APP_ROOT, rel)).pipe(res);
    }
    if (req.method === 'POST' && p === '/agent/claim') {
      const body = JSON.parse((await readRaw(req, 1e5)).toString('utf8') || '{}');
      const r = this.claim(String(body.code || ''), body.name);
      if (!r) return send(403, { error: 'pairing code expired or already used' });
      return send(200, { id: r.id, token: r.token });
    }

    const pc = this.authenticate(req);
    if (!pc) return send(401, { error: 'unknown or removed PC' });
    if (req.method !== 'POST') return send(405, { error: 'POST only' });
    const root = path.join(this.pcsDir, pc.id);
    const op = p.slice('/agent/'.length);
    const resolve = (rel) => {
      if (!rel || !SAFE.test(rel) || rel.startsWith('/') || rel.split('/').includes('..')) throw new Error(`bad path: ${rel}`);
      const full = path.resolve(root, rel);
      if (!full.startsWith(root + path.sep)) throw new Error('path escapes root');
      return full;
    };
    try {
      if (op === 'hello') {
        await fsp.mkdir(root, { recursive: true });
        return send(200, { ok: true, files: await manifest(root) });
      }
      if (op === 'append') {
        const rel = url.searchParams.get('path');
        const full = resolve(rel);
        const offset = Number(url.searchParams.get('offset'));
        const data = await readRaw(req, 16e6);
        let size = 0; try { size = (await fsp.stat(full)).size; } catch { /* new */ }
        if (size !== offset) return send(200, { ok: false, path: rel, size, error: 'offset mismatch' });
        await fsp.mkdir(path.dirname(full), { recursive: true });
        await fsp.appendFile(full, data);
        return send(200, { ok: true, path: rel, size: size + data.length });
      }
      if (op === 'put') {
        const rel = url.searchParams.get('path');
        const full = resolve(rel);
        const data = await readRaw(req, 64e6);
        await fsp.mkdir(path.dirname(full), { recursive: true });
        await fsp.writeFile(full + '.chatlens-tmp', data);
        await fsp.rename(full + '.chatlens-tmp', full);
        return send(200, { ok: true, path: rel, size: data.length });
      }
      if (op === 'delete') {
        await fsp.rm(resolve(url.searchParams.get('path')), { force: true });
        return send(200, { ok: true });
      }
      if (op === 'stamp') {
        const data = await readRaw(req, 1e5);
        await fsp.writeFile(path.join(root, 'last-sync.json'), data);
        return send(200, { ok: true });
      }
      if (op === 'jobs') {
        const jobsDir = path.join(this.bridge, 'jobs');
        await fsp.mkdir(jobsDir, { recursive: true });
        const jobs = [], stops = [];
        for (const n of (await fsp.readdir(jobsDir)).sort()) {
          const f = path.join(jobsDir, n);
          if (n.endsWith('.json') && JOB_ID.test(n.slice(0, -5))) {
            let j; try { j = JSON.parse(await fsp.readFile(f, 'utf8')); } catch { continue; }
            if (j.pcId !== pc.id) continue; // other PCs' jobs
            await fsp.rename(f, f.slice(0, -5) + '.taken');
            jobs.push(j);
          } else if (n.endsWith('.stop') && JOB_ID.test(n.slice(0, -5))) {
            // only stops for this PC's jobs (the .taken file says whose it is)
            const id = n.slice(0, -5);
            let owner = null; try { owner = JSON.parse(await fsp.readFile(path.join(jobsDir, id + '.taken'), 'utf8')).pcId; } catch { /* */ }
            if (owner === pc.id) { stops.push(id); await fsp.rm(f, { force: true }); }
          }
        }
        return send(200, { ok: true, jobs, stops });
      }
      if (op === 'event') {
        const job = url.searchParams.get('job') || '';
        if (!JOB_ID.test(job)) throw new Error('bad job id');
        const evDir = path.join(this.bridge, 'events');
        await fsp.mkdir(evDir, { recursive: true });
        await fsp.appendFile(path.join(evDir, job + '.jsonl'), await readRaw(req, 16e6));
        return send(200, { ok: true });
      }
      return send(404, { error: 'unknown op' });
    } catch (e) {
      return send(200, { ok: false, error: String(e.message || e) });
    }
  }
}

async function readRaw(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > limit) throw new Error('body too large'); chunks.push(c); }
  return Buffer.concat(chunks);
}

async function manifest(root) {
  const files = {};
  const walk = async (dir) => {
    let entries = [];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (!e.name.endsWith('.chatlens-tmp')) files[path.relative(root, full).split(path.sep).join('/')] = (await fsp.stat(full)).size;
    }
  };
  await walk(root);
  return files;
}

// The one-time installer a PC runs while pairing (PowerShell, Windows).
function installScript(server, code) {
  return `# ChatLens agent installer (pairing code is single-use and expires in 15 minutes)
$ErrorActionPreference = 'Stop'
$server = '${server}'
$code = '${code}'
$dir = Join-Path $env:LOCALAPPDATA 'ChatLens\\agent'
Write-Host "Installing the ChatLens agent into $dir" -ForegroundColor Cyan
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'Node.js 20 or newer is required. Install the LTS version from https://nodejs.org and run this command again.' }
$claude = Join-Path $env:USERPROFILE '.local\\bin\\claude.exe'
if (-not (Test-Path $claude)) { Write-Warning 'Claude Code was not found (~\\.local\\bin\\claude.exe). Chats will sync, but continuing them on this PC needs Claude Code installed and signed in.' }
New-Item -ItemType Directory -Force (Join-Path $dir 'sync'), (Join-Path $dir 'lib') | Out-Null
foreach ($f in 'sync/chatlens-sync.mjs', 'lib/relay.mjs', 'sync/start-sync-hidden.vbs') {
  Invoke-WebRequest -UseBasicParsing "$server/agent/files/$f" -OutFile (Join-Path $dir $f)
}
Set-Content -Path (Join-Path $dir 'package.json') -Value '{"type":"module"}' -Encoding ascii
$r = Invoke-RestMethod -Method Post "$server/agent/claim" -ContentType 'application/json' -Body (@{ code = $code; name = $env:COMPUTERNAME } | ConvertTo-Json)
[IO.File]::WriteAllText((Join-Path $dir 'config.json'), (@{ server = $server; pcId = $r.id; token = $r.token } | ConvertTo-Json))  # no BOM
# Start at sign-in, hidden.
$lnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'ChatLens Agent.lnk'
$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut($lnk)
$s.TargetPath = "$env:WINDIR\\System32\\wscript.exe"; $s.Arguments = '"' + (Join-Path $dir 'sync\\start-sync-hidden.vbs') + '"'
$s.WorkingDirectory = (Join-Path $dir 'sync'); $s.Description = 'ChatLens agent'; $s.Save()
Start-Process "$env:WINDIR\\System32\\wscript.exe" -ArgumentList ('"' + (Join-Path $dir 'sync\\start-sync-hidden.vbs') + '"')
Write-Host "Paired as $env:COMPUTERNAME. Its chats will appear in ChatLens within a minute (Settings > PCs)." -ForegroundColor Green
Write-Host "Log: $dir\\sync.log    To remove: delete the 'ChatLens Agent' Startup shortcut and $dir, and remove the PC in Settings." -ForegroundColor DarkGray
`;
}
