// ChatLens: local web UI over every Claude chat on this computer, with a Claude
// agent that can search and read them. Binds to 127.0.0.1 only.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { ChatIndex } from './lib/indexer.mjs';
import { buildChatTools, runTurn, forkChat, messageHandler, testClaudeLogin, MODELS } from './lib/agent.mjs';
import { runOnPc, liveSessions as localLive, cleanBridge } from './lib/pcrun.mjs';
import { PcRegistry } from './lib/pcs.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.CHATLENS_PORT || 4477);
// Locally: loopback only. In the container: 0.0.0.0 behind Traefik + Authelia.
const HOST = process.env.CHATLENS_HOST || '127.0.0.1';
const HOSTED = process.env.CHATLENS_HOSTED === '1';
// Shown in messages; the PC's own name comes from its sync agent.
const SERVER_NAME = process.env.CHATLENS_SERVER_NAME || (HOSTED ? 'the server' : os.hostname());
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`,
  ...(process.env.CHATLENS_ALLOWED_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)]);
const WORKSPACE = process.env.CHATLENS_WORKSPACE || path.join(ROOT, 'workspace');
const DATA = process.env.CHATLENS_DATA_DIR || path.join(ROOT, 'data');
const CONV_FILE = path.join(DATA, 'conversations.json');
fs.mkdirSync(WORKSPACE, { recursive: true });
fs.mkdirSync(DATA, { recursive: true });

// Claude Code stores a cwd's sessions under the path with every non-alphanumeric char -> '-'.
const encodeProject = (p) => p.replace(/[^A-Za-z0-9]/g, '-');
// Hosted: one data folder per attached PC (the SSH-synced one plus any paired over HTTPS).
const pcs = HOSTED ? new PcRegistry({ dataDir: DATA, legacySyncDir: path.dirname(process.env.CHATLENS_PROJECTS_DIR || '/data/sync/projects'), bridgeDir: process.env.CHATLENS_BRIDGE_DIR || path.join(DATA, 'bridge') }) : null;
const liveSessions = () => (pcs ? pcs.live() : localLive());
const pcNameOf = (id) => (pcs ? pcs.pcName(id) : os.hostname());
const index = new ChatIndex({ excludeProjectDirs: [encodeProject(WORKSPACE)], roots: pcs ? () => pcs.roots() : null });
const mcp = buildChatTools(index);
index.ensureFresh(true).then(() => console.log(`indexed ${index.sessions().length} chats`));

// ---------- conversation store ----------
let conversations = [];
try { conversations = JSON.parse(fs.readFileSync(CONV_FILE, 'utf8')); } catch { conversations = []; }
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = CONV_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(conversations, null, 1));
    fs.renameSync(tmp, CONV_FILE);
  }, 300);
}
// ---------- Claude login (Settings → Claude account) ----------
// A token pasted in Settings is kept here (owner-only) and never sent back to a browser.
const AUTH_FILE = path.join(DATA, 'claude-auth.json');
function savedAuth() { try { return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')); } catch { return null; } }
const savedToken = () => savedAuth()?.token || null;
let loginCheck = null; // { ok, error, at } from the last test
function loginSource() {
  if (savedToken()) return 'saved';
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY) return 'env';
  const home = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || process.env.USERPROFILE || '', '.claude');
  if (fs.existsSync(path.join(home, '.credentials.json')) || !HOSTED) return 'local';
  return 'none';
}

const forkIds = () => new Set(conversations.filter((c) => c.mode === 'fork').map((c) => c.sdkSessionId));

// ---------- turns ----------
// Every Claude turn runs independently of any HTTP connection and keeps an
// event log. Browsers attach to it (and re-attach after a dropped connection,
// a locked phone screen, a reload) and get every event from where they left off.
const turns = new Map(); // conversation id -> { events, done, subs, abort, doneAt }
const isRunning = (id) => { const t = turns.get(id); return !!t && !t.done; };
function pushEvent(t, event, data) {
  const e = { seq: t.events.length, event, data };
  t.events.push(e);
  for (const fn of t.subs) fn(e);
  if (event === 'end') { t.done = true; t.doneAt = Date.now(); }
}
setInterval(() => { // forget finished turns after 15 minutes
  for (const [id, t] of turns) if (t.done && Date.now() - t.doneAt > 15 * 60e3) turns.delete(id);
  cleanBridge().catch(() => {});
}, 60e3).unref();

function attach(req, res, t, from) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const send = (e) => { if (!res.writableEnded) res.write(`id: ${e.seq}\nevent: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`); };
  for (const e of t.events.slice(from)) send(e);
  if (t.done) return res.end();
  const sub = (e) => { send(e); if (e.event === 'end') { cleanup(); res.end(); } };
  const keepalive = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 10000);
  const cleanup = () => { clearInterval(keepalive); t.subs.delete(sub); };
  t.subs.add(sub);
  req.on('close', cleanup);
}

// ---------- helpers ----------
// Pages compare this with the build they loaded and reload themselves after a deploy.
const BUILD = crypto.createHash('sha1').update(['index.html', 'app.js', 'style.css'].map((f) => { try { return fs.readFileSync(path.join(ROOT, 'public', f)); } catch { return ''; } }).join('|')).digest('hex').slice(0, 12);
const MIME = { '.webmanifest': 'application/manifest+json', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const STATIC = {
  '/': path.join(ROOT, 'public', 'index.html'),
  '/app.js': path.join(ROOT, 'public', 'app.js'),
  '/style.css': path.join(ROOT, 'public', 'style.css'),
  '/icon.svg': path.join(ROOT, 'public', 'icon.svg'),
  '/manifest.webmanifest': path.join(ROOT, 'public', 'manifest.webmanifest'),
  '/vendor/marked.js': path.join(ROOT, 'node_modules', 'marked', 'lib', 'marked.umd.js'),
};

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > 2e6) throw new Error('body too large'); chunks.push(c); }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}
const clip = (s, n) => (s && s.length > n ? s.slice(0, n) : s);

// The viewer gets every entry, but long tool payloads are clipped; the full
// text is fetched per entry on demand.
function viewEntry(m) {
  const e = { i: m.i, role: m.role, ts: m.ts, sidechain: m.sidechain || undefined };
  if (m.role === 'assistant') {
    e.text = m.text; e.error = m.error || undefined;
    if (m.tools.length) e.tools = m.tools.map((t) => ({ name: t.name, input: clip(t.input, 400), more: t.input.length > 400 || undefined }));
  } else if (m.role === 'tool') {
    e.text = clip(m.text, 400); e.more = m.text.length > 400 || undefined; e.isError = m.isError || undefined;
  } else if (m.role === 'user') {
    e.text = m.meta ? clip(m.text, 2000) : m.search; e.meta = m.meta || undefined; e.from = m.from || undefined;
  } else e.text = m.text;
  return e;
}

// ---------- routes ----------
async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  // DNS-rebinding guard: only answer to our own host names.
  const host = (req.headers.host || '').toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) { res.writeHead(421); return res.end('Misdirected'); }

  if (req.method === 'GET' && STATIC[p]) {
    const f = STATIC[p];
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'text/plain', 'Cache-Control': 'no-cache' });
    return fs.createReadStream(f).pipe(res);
  }
  // PC agents (paired from Settings): token-authenticated, routed past the login proxy.
  if (p.startsWith('/agent/')) {
    if (!pcs) return json(res, 404, { error: 'not a hosted ChatLens' });
    const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
    return pcs.handleAgent(req, res, url, { publicUrl: `${proto}://${req.headers.host}` });
  }
  if (!p.startsWith('/api/')) { res.writeHead(404); return res.end('Not found'); }
  // CSRF guard: a custom header forces a CORS preflight, which we never grant.
  if (req.headers['x-chatlens'] !== '1') return json(res, 403, { error: 'missing X-ChatLens header' });

  if (p === '/api/status') {
    let sync = null;
    if (HOSTED) { try { sync = JSON.parse(await fsp.readFile(path.join(path.dirname(process.env.CHATLENS_PROJECTS_DIR), 'last-sync.json'), 'utf8')); } catch { /* none yet */ } }
    const pcList = pcs ? pcs.list().map(({ id, name, kind, lastSync }) => ({ id, name, kind, lastSync })) : [{ id: 'local', name: os.hostname(), kind: 'local' }];
    const newest = pcList.filter((x) => x.lastSync).sort((a, b) => b.lastSync.localeCompare(a.lastSync))[0];
    if (pcs && newest) sync = { at: newest.lastSync, from: newest.name };
    return json(res, 200, { progress: index.progress, chats: index.sessions().length, models: MODELS, hosted: HOSTED, sync, build: BUILD, pc_name: pcList[0]?.name || null, pcs: pcList });
  }
  if (p === '/api/chats') {
    await index.ensureFresh();
    const r = index.list({ query: url.searchParams.get('q') || undefined, project: url.searchParams.get('project') || undefined, pc: url.searchParams.get('pc') || undefined, limit: 5000 });
    const forks = forkIds();
    const live = await liveSessions();
    const liveBy = new Map(live.sessions.map((x) => [x.sessionId, x]));
    r.items.forEach((x) => {
      if (forks.has(x.session_id)) x.chatlens_fork = true;
      if (pcs) x.pc_name = pcNameOf(x.pc);
      const l = liveBy.get(x.session_id);
      if (l) x.live = { status: l.status, since: l.statusUpdatedAt, desktop: l.entrypoint === 'claude-desktop' };
    });
    r.live_at = live.at; r.live_stale = live.stale;
    return json(res, 200, r);
  }
  if (p === '/api/projects') return json(res, 200, index.projects());
  if (p === '/api/pcs' || p.startsWith('/api/pcs/')) {
    if (!pcs) return json(res, 200, { hosted: false, pcs: [] });
    if (p === '/api/pcs/pair' && req.method === 'POST') {
      const { code, expires } = pcs.createPairing();
      const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
      const base = `${proto}://${req.headers.host}`;
      return json(res, 200, { code, expires, command: `powershell -NoProfile -ExecutionPolicy Bypass -Command "irm '${base}/agent/install.ps1?code=${code}' | iex"` });
    }
    const del = p.match(/^\/api\/pcs\/([a-f0-9]{12})$/);
    if (del && req.method === 'DELETE') return pcs.remove(del[1]) ? json(res, 200, { ok: true }) : json(res, 404, { error: 'not found' });
    await index.ensureFresh();
    const counts = {};
    for (const s of index.sessions()) counts[s.pc] = (counts[s.pc] || 0) + 1;
    const live = await liveSessions();
    return json(res, 200, { hosted: true, pcs: pcs.list().map((x) => ({ ...x, chats: counts[x.id] || 0, live: live.sessions.filter((l) => l.pc === x.id).length, online: !!x.lastSync && Date.now() - new Date(x.lastSync).getTime() < 120000 })) });
  }
  if (p === '/api/account') {
    if (req.method === 'POST') {
      const { token } = await readBody(req);
      const t = String(token || '').replace(/\s/g, '');
      if (!/^sk-ant-(oat|api)\d+-[A-Za-z0-9_-]{40,}$/.test(t)) return json(res, 400, { error: 'That does not look like a Claude token. Run "claude setup-token" and paste the sk-ant-oat01-… value it prints.' });
      const r = await testClaudeLogin({ authToken: t, workspace: WORKSPACE });
      if (!r.ok) return json(res, 400, { error: `Claude did not accept that token: ${r.error}` });
      fs.writeFileSync(AUTH_FILE, JSON.stringify({ token: t, savedAt: new Date().toISOString() }), { mode: 0o600 });
      loginCheck = { ok: true, at: new Date().toISOString() };
      return json(res, 200, { ok: true });
    }
    if (req.method === 'DELETE') {
      fs.rmSync(AUTH_FILE, { force: true });
      loginCheck = null;
      return json(res, 200, { ok: true, source: loginSource() });
    }
    // GET (?check=1 runs a tiny request with the current login, at most every 20 s)
    if (url.searchParams.get('check') === '1' && (!loginCheck || Date.now() - new Date(loginCheck.at).getTime() > 20000)) {
      const r = await testClaudeLogin({ authToken: savedToken(), workspace: WORKSPACE });
      loginCheck = { ...r, at: new Date().toISOString() };
    }
    return json(res, 200, { source: loginSource(), saved_at: savedAuth()?.savedAt || null, hosted: HOSTED, check: loginCheck });
  }
  if (p === '/api/search') {
    await index.ensureFresh();
    try {
      return json(res, 200, index.search({
        query: url.searchParams.get('q') || '', regex: url.searchParams.get('regex') === '1',
        project: url.searchParams.get('project') || undefined, sessionId: url.searchParams.get('session') || undefined,
        limit: 200,
      }));
    } catch (e) { return json(res, 400, { error: e.message }); }
  }
  let m;
  if ((m = p.match(/^\/api\/chat\/([\w-]+)$/))) {
    await index.ensureFresh();
    const s = index.get(m[1]);
    if (!s) return json(res, 404, { error: 'not found' });
    const sub = url.searchParams.get('sub');
    const target = sub ? s.subagents?.find((a) => a.agentId === sub) : s;
    if (!target) return json(res, 404, { error: 'subagent not found' });
    return json(res, 200, {
      session_id: s.id, title: s.title, project: s.project, cwd: s.cwd, created: s.created, updated: s.updated,
      model: s.model, cost_usd: s.costUSD, archived: s.archived, desktop_id: s.desktop?.desktopId, git_branch: s.gitBranch,
      subagents: (s.subagents || []).map((a) => ({ id: a.agentId, description: a.description, type: a.agentType, entries: a.messages.length, created: a.created })),
      subagent: sub || null, subagent_description: sub ? target.description : null,
      entries: target.messages.map(viewEntry),
    });
  }
  if ((m = p.match(/^\/api\/chat\/([\w-]+)\/entry\/(\d+)$/))) {
    const s = index.get(m[1]);
    const sub = url.searchParams.get('sub');
    const target = s && (sub ? s.subagents?.find((a) => a.agentId === sub) : s);
    const e = target?.messages[Number(m[2])];
    if (!e) return json(res, 404, { error: 'not found' });
    return json(res, 200, { text: e.text, tools: e.tools, thinking: e.thinking });
  }

  // conversations with the ChatLens agent
  if (p === '/api/conversations' && req.method === 'GET') {
    return json(res, 200, conversations.map(({ messages, ...c }) => ({ ...c, count: messages.length, running: isRunning(c.id) })).sort((a, b) => b.updated.localeCompare(a.updated)));
  }
  if ((m = p.match(/^\/api\/conversations\/([\w-]+)$/))) {
    const c = conversations.find((x) => x.id === m[1]);
    if (!c) return json(res, 404, { error: 'not found' });
    if (req.method === 'DELETE') { turns.get(c.id)?.abort.abort(); conversations = conversations.filter((x) => x !== c); save(); return json(res, 200, { ok: true }); }
    return json(res, 200, { ...c, running: isRunning(c.id) });
  }
  // Re-attach to a turn's event stream (after a dropped connection or a reload).
  if ((m = p.match(/^\/api\/stream\/([\w-]+)$/))) {
    const t = turns.get(m[1]);
    if (!t) return json(res, 404, { error: 'no turn' });
    return attach(req, res, t, Math.max(0, Number(url.searchParams.get('from')) || 0));
  }
  // Claude sessions running on the PC right now.
  if (p === '/api/live') return json(res, 200, await liveSessions());
  // New entries of one chat since index `from` (the viewer polls this to follow a live chat).
  if ((m = p.match(/^\/api\/chat\/([\w-]+)\/tail$/))) {
    await index.refreshSession(m[1]);
    const s = index.get(m[1]);
    if (!s) return json(res, 404, { error: 'not found' });
    const from = Math.max(0, Number(url.searchParams.get('from')) || 0);
    // Resend the last couple of entries: a streamed reply grows in place.
    const start = Math.max(0, Math.min(from, s.messages.length) - 2);
    return json(res, 200, { total: s.messages.length, start, updated: s.updated, entries: s.messages.slice(start).map(viewEntry) });
  }
  // Continue a chat on the PC in its own session (same id: the desktop app shows the new turns).
  if (p === '/api/continue' && req.method === 'POST') {
    const { session_id } = await readBody(req);
    const s = index.get(session_id);
    if (!s) return json(res, 404, { error: 'chat not found' });
    // Idle in the desktop app is fine (the PC takes it over); busy is not.
    const live = (await liveSessions()).sessions.find((x) => x.sessionId === s.id);
    if (live && live.status !== 'idle' && live.entrypoint !== 'claude-desktop') return json(res, 409, { error: 'busy', status: live.status, message: openMessage(live) });
    let c = conversations.find((x) => x.mode === 'pc' && x.sessionId === s.id);
    if (!c) {
      const now = new Date().toISOString();
      c = { id: crypto.randomUUID(), title: `⇢ ${s.title}`, mode: 'pc', sessionId: s.id, sourceId: s.id, cwd: s.cwd, pc: s.pc || null, created: now, updated: now, messages: [] };
      conversations.push(c); save();
    }
    return json(res, 200, c);
  }
  if (p === '/api/fork' && req.method === 'POST') {
    const { session_id } = await readBody(req);
    const s = index.get(session_id);
    if (!s) return json(res, 404, { error: 'chat not found' });
    try {
      let forkId;
      if (HOSTED) {
        // The synced transcript is not in this container's Claude store, and its
        // Windows cwd doesn't exist here: stage a copy under the workspace
        // project, fork it there, then drop the staging copy.
        const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || '/root', '.claude');
        const stageDir = path.join(configDir, 'projects', encodeProject(WORKSPACE));
        await fsp.mkdir(stageDir, { recursive: true });
        const staged = path.join(stageDir, `${s.id}.jsonl`);
        await fsp.copyFile(s.file, staged);
        try { forkId = await forkChat(s.id, `${s.title} (ChatLens)`, WORKSPACE); }
        finally { await fsp.rm(staged, { force: true }); }
      } else {
        forkId = await forkChat(s.id, `${s.title} (ChatLens)`);
      }
      const now = new Date().toISOString();
      const c = { id: crypto.randomUUID(), title: `↪ ${s.title}`, mode: 'fork', sdkSessionId: forkId, sourceId: s.id, cwd: HOSTED ? WORKSPACE : s.cwd, created: now, updated: now, messages: [] };
      conversations.push(c); save();
      return json(res, 200, c);
    } catch (e) { return json(res, 500, { error: 'fork failed: ' + e.message }); }
  }
  if (p === '/api/stop' && req.method === 'POST') {
    const { conversation_id } = await readBody(req);
    turns.get(conversation_id)?.abort.abort();
    return json(res, 200, { ok: true });
  }
  if (p === '/api/ask' && req.method === 'POST') return ask(req, res);

  return json(res, 404, { error: 'unknown endpoint' });
}

async function ask(req, res) {
  const body = await readBody(req);
  const prompt = String(body.prompt || '').trim();
  if (!prompt) return json(res, 400, { error: 'empty prompt' });
  const now = new Date().toISOString();
  let c = body.conversation_id && conversations.find((x) => x.id === body.conversation_id);
  if (!c) {
    c = { id: crypto.randomUUID(), title: prompt.slice(0, 70), mode: 'lens', sdkSessionId: null, focusId: body.focus_id || null, created: now, updated: now, messages: [] };
    conversations.push(c);
  }
  if (isRunning(c.id)) return json(res, 409, { error: 'this conversation is already running' });
  if (c.mode === 'pc') {
    const live = (await liveSessions()).sessions.find((x) => x.sessionId === c.sessionId);
    if (live && live.status !== 'idle' && live.entrypoint !== 'claude-desktop') return json(res, 409, { error: openMessage(live) });
  }

  const t = { events: [], done: false, subs: new Set(), abort: new AbortController(), doneAt: 0 };
  turns.set(c.id, t);
  const emit = (event, data) => pushEvent(t, event, data);
  const abort = t.abort;
  // The turn runs on its own; this request is just the first viewer.
  attach(req, res, t, 0);
  const fullTools = body.full_tools === true;
  c.messages.push({ role: 'user', text: prompt, ts: now, focusId: body.focus_id || undefined, fullTools: fullTools || undefined });
  const reply = { role: 'assistant', text: '', tools: [], ts: now };
  c.messages.push(reply);
  c.updated = now;
  save();
  emit('conversation', { id: c.id, title: c.title, mode: c.mode });

  const record = (event, data) => {
    if (event === 'error' && HOSTED && /authentication_failed|Not logged in|invalid.*token|OAuth/i.test(data.message || '')) {
      data = { message: `ChatLens on ${SERVER_NAME} has no working Claude login. Open Settings (the gear in the assistant panel) → Claude account and paste a token from "claude setup-token".`, login: true };
      if (reply.error) return;
    }
    if (event === 'delta') reply.text += data.text;
    else if (event === 'text_start' && reply.text && !reply.text.endsWith('\n\n')) { reply.text += '\n\n'; data.sep = true; }
    else if (event === 'tool') reply.tools.push({ id: data.id, name: data.name, input: data.input, at: reply.text.length });
    else if (event === 'tool_result') { const t = reply.tools.find((x) => x.id === data.id); if (t) Object.assign(t, { preview: data.preview, is_error: data.is_error, length: data.length }); }
    else if (event === 'session') c.sdkSessionId = data.session_id;
    else if (event === 'done') { reply.cost_usd = data.cost_usd; reply.duration_ms = data.duration_ms; if (data.error) reply.error = data.error; }
    else if (event === 'error') reply.error = data.message;
    emit(event, data);
  };

  // Persist the growing reply now and then, so a reload mid-turn shows progress.
  const autosave = setInterval(save, 3000);
  try {
    if (c.mode === 'pc') {
      // A resumed session reports its lifetime cost; show just this turn's.
      await index.refreshSession(c.sessionId);
      const prior = index.get(c.sessionId)?.costUSD;
      const handle = messageHandler((event, data) => {
        if (event === 'done' && prior != null && data.cost_usd >= prior) data = { ...data, cost_usd: data.cost_usd - prior };
        record(event, data);
      }, c.sessionId);
      let relay = null;
      const { code, stderr, relayed } = await runOnPc(
        { id: crypto.randomUUID(), sessionId: c.sessionId, cwd: c.cwd, pcId: c.pc || index.get(c.sessionId)?.pc || 'default', asMe: body.as_me === true, prompt, model: body.model, effort: body.effort, fullTools },
        { onLine: (o) => { if (o.type === 'chatlens_relay') { relay = o; record('relay', o); } else handle(o); }, onStatus: (text) => record('status', { text }), signal: abort.signal },
      );
      if (relayed) {
        // Handed to the chat open in the desktop app; its reply arrives through the transcript.
        if (!relay?.ok) throw new Error(`Could not hand the message to the desktop app: ${relay?.detail || 'unknown error'}`);
        reply.relayed = { name: relay.name, status: relay.status };
        record('done', { relayed: true });
        return;
      }
      handle.finish();
      if (abort.signal.aborted) throw new Error('Stopped.');
      if (!handle.hasResult()) {
        const why = (stderr || '').trim().split('\n').slice(-3).join(' ').slice(0, 400);
        throw new Error(`Claude on ${pcNameOf(c.pc)} exited (code ${code})${why ? ': ' + why : ''}`);
      }
    } else {
      await runTurn({
        index, mcp, prompt, sessionId: c.sdkSessionId, mode: c.mode,
        focusId: c.mode === 'lens' ? (body.focus_id || null) : null,
        cwd: c.cwd, workspace: WORKSPACE, model: body.model, effort: body.effort, fullTools, authToken: savedToken(), abort, emit: record,
      });
    }
  } catch (e) {
    const msg = abort.signal.aborted ? 'Stopped.' : String(e.message || e);
    if (!(reply.error && /Not logged in|authentication_failed/i.test(msg))) {
      reply.error = msg;
      emit('error', { message: msg });
    }
  } finally {
    clearInterval(autosave);
    c.updated = new Date().toISOString();
    save();
    emit('end', {});
  }
}

// Hosted: the PC's hostname as its sync agent reports it. Local: this machine.
async function pcName() {
  if (!HOSTED) return os.hostname();
  try { return JSON.parse(await fsp.readFile(path.join(path.dirname(process.env.CHATLENS_PROJECTS_DIR), 'last-sync.json'), 'utf8')).from || 'the PC'; } catch { return 'the PC'; }
}

function openMessage(live) {
  const name = live.name ? `“${live.name}”` : 'This chat';
  return `Claude is working in ${name} on the PC right now. Reply again once it finishes.`;
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: String(e.message || e) }); else res.end();
  });
});
server.listen(PORT, HOST, () => console.log(`ChatLens on http://${HOST}:${PORT}`));
