// Parses Claude Code transcripts (~/.claude/projects/*/*.jsonl) plus the Claude
// desktop app's session metadata into an in-memory, searchable index.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const HOME = os.homedir();
// Locally these are the live Claude folders. On the server they point at the
// copy that the sync agent pushes from the PC.
export const PROJECTS_DIR = process.env.CHATLENS_PROJECTS_DIR || path.join(HOME, '.claude', 'projects');
const DESKTOP_DIR = process.env.CHATLENS_DESKTOP_DIR || path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'Claude', 'claude-code-sessions');
// Server: a single desktop.json (cliSessionId -> metadata) written by the sync agent.
const DESKTOP_FILE = process.env.CHATLENS_DESKTOP_FILE || null;

const TOOL_RESULT_CAP = 8000;   // chars kept per tool result
const TOOL_INPUT_CAP = 3000;    // chars kept per tool_use input
const REFRESH_MS = 15000;

// Lines we never need; checked by prefix so we never JSON.parse multi-MB blobs.
const SKIP_PREFIXES = [
  '{"type":"api-request', '{"type":"file-history', '{"type":"atis-latch',
  '{"type":"queue-operation', '{"type":"relocated', '{"type":"tools-used',
  '{"type":"last-prompt', '{"type":"attachment"',
];

export class ChatIndex {
  // roots: () => [{ pc, name, projectsDir, desktopFile?, desktopDir? }] — one per PC.
  // Default: this machine's own Claude folders (or the env-configured mirror).
  constructor({ excludeProjectDirs = [], roots = null } = {}) {
    this.roots = roots || (() => [{ pc: 'local', name: null, projectsDir: PROJECTS_DIR, desktopFile: DESKTOP_FILE, desktopDir: DESKTOP_FILE ? null : DESKTOP_DIR }]);
    this.exclude = new Set(excludeProjectDirs.map((d) => d.toLowerCase()));
    this.files = new Map();      // filePath -> { mtimeMs, size, session }
    this.desktop = new Map();    // cliSessionId -> desktop metadata
    this.lastRefresh = 0;
    this.refreshing = null;
    this.progress = { done: 0, total: 0, ready: false };
  }

  // One parser per file at a time: incremental parses must not overlap.
  _locked(p, fn) {
    this.locks ||= new Map();
    const prev = this.locks.get(p) || Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(p, next.catch(() => {}));
    return next;
  }

  /** Pick up new lines of one chat right away (used to follow a live chat). */
  async refreshSession(id) {
    for (const [p, f] of this.files) {
      if (f.session?.id !== id) continue;
      return this._locked(p, async () => {
        const cur = this.files.get(p);
        let st;
        try { st = await fsp.stat(p); } catch { return; }
        if (st.size === cur.size) return;
        const prev = st.size > cur.size ? cur.session._state : null;
        const s = await parseSession(p, cur.project, prev);
        s.subagents = cur.session.subagents;
        s.pc = cur.session.pc;
        applyDesktop(s, this.desktop.get(s.id));
        this.files.set(p, { ...cur, size: st.size, mtimeMs: st.mtimeMs, session: s });
      });
    }
  }

  // ---------- public API ----------
  async ensureFresh(force = false) {
    if (this.refreshing) return this.refreshing;
    if (!force && Date.now() - this.lastRefresh < REFRESH_MS) return;
    this.refreshing = this._refresh().finally(() => { this.refreshing = null; this.lastRefresh = Date.now(); });
    return this.refreshing;
  }

  sessions() {
    return [...this.files.values()].map((f) => f.session).filter(Boolean);
  }

  get(id) {
    for (const f of this.files.values()) if (f.session?.id === id) return f.session;
    return null;
  }

  projects() {
    const m = new Map();
    for (const s of this.sessions()) {
      const p = m.get(s.project) || { project: s.project, cwd: s.cwd, count: 0 };
      p.count++; m.set(s.project, p);
    }
    return [...m.values()].sort((a, b) => b.count - a.count);
  }

  list({ query, project, pc, since, until, includeArchived = true, limit = 100, offset = 0 } = {}) {
    let out = this.sessions();
    if (pc) out = out.filter((s) => s.pc === pc);
    if (project) out = out.filter((s) => s.project === project);
    if (!includeArchived) out = out.filter((s) => !s.archived);
    if (since) out = out.filter((s) => s.updated >= since);
    if (until) out = out.filter((s) => s.created <= until);
    if (query) {
      const q = query.toLowerCase();
      out = out.filter((s) => (s.title + ' ' + s.firstPrompt + ' ' + s.id).toLowerCase().includes(q));
    }
    out.sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
    return { total: out.length, items: out.slice(offset, offset + limit).map(summary) };
  }

  search({ query, regex = false, sessionId, project, roles, since, until, limit = 40, includeTools = true }) {
    if (!query) return { total: 0, hits: [] };
    let re;
    try {
      re = regex ? new RegExp(query, 'i') : null;
    } catch (e) { throw new Error('Bad regex: ' + e.message); }
    const terms = regex ? [] : query.toLowerCase().split(/\s+/).filter(Boolean);
    const sessionsHit = [];
    for (const s of this.sessions()) {
      if (sessionId && s.id !== sessionId) continue;
      if (project && s.project !== project) continue;
      if (since && s.updated < since) continue;
      if (until && s.created > until) continue;
      const hits = [];
      const pools = [[null, s.messages], ...(s.subagents || []).map((a) => [a.agentId, a.messages])];
      for (const [subagent, messages] of pools) for (const m of messages) {
        if (roles?.length && !roles.includes(m.role)) continue;
        if (!includeTools && m.role === 'tool') continue;
        const hay = m.search;
        let idx = -1;
        if (re) { const r = re.exec(hay); if (r) idx = r.index; }
        else {
          const lc = hay.toLowerCase();
          if (terms.every((t) => lc.includes(t))) idx = lc.indexOf(terms[0]);
        }
        if (idx >= 0) hits.push({ index: m.i, role: m.role, ts: m.ts, ...(subagent ? { subagent_id: subagent } : {}), snippet: snippet(hay, idx) });
      }
      if (hits.length) sessionsHit.push({ s, hits });
    }
    // rank: sessions with more matching messages first, then recency
    sessionsHit.sort((a, b) => b.hits.length - a.hits.length || (b.s.updated || '').localeCompare(a.s.updated || ''));
    const out = [];
    let totalHits = 0;
    for (const { s, hits } of sessionsHit) {
      totalHits += hits.length;
      out.push({ session_id: s.id, title: s.title, project: s.project, updated: s.updated, match_count: hits.length, hits: sessionId ? hits.slice(0, 200) : hits.slice(0, 5) });
    }
    return { total_sessions: out.length, total_hits: totalHits, results: out.slice(0, limit) };
  }

  // ---------- internals ----------
  async _refresh() {
    await this._loadDesktop();
    const files = await this._listFiles();
    const seen = new Set();
    const todo = [];
    for (const f of files) {
      seen.add(f.path);
      const cur = this.files.get(f.path);
      if (!cur || cur.mtimeMs !== f.mtimeMs || cur.size !== f.size || cur.subSig !== f.subSig) todo.push(f);
    }
    for (const p of [...this.files.keys()]) if (!seen.has(p)) this.files.delete(p);
    this.progress.total = files.length;
    this.progress.done = files.length - todo.length;
    // smallest first so the list fills quickly
    todo.sort((a, b) => a.size - b.size);
    const CONC = 4;
    let next = 0;
    await Promise.all(Array.from({ length: CONC }, async () => {
      while (next < todo.length) {
        const f = todo[next++];
        try {
          await this._locked(f.path, async () => {
            const cur = this.files.get(f.path);
            if (cur && cur.size === f.size && cur.subSig === f.subSig) return; // refreshed meanwhile
            // Transcripts only grow: parse just the new bytes when we can.
            const prev = cur?.session?._state && f.size >= cur.size ? cur.session._state : null;
            const session = await parseSession(f.path, f.project, prev);
            session.subagents = cur && cur.subSig === f.subSig && cur.session ? cur.session.subagents : await parseSubagents(f.path);
            session.pc = f.pc;
            this.files.set(f.path, { mtimeMs: f.mtimeMs, size: f.size, subSig: f.subSig, session });
          });
        } catch (e) {
          console.error('parse failed', f.path, e.message);
        }
        this.progress.done++;
      }
    }));
    // apply desktop metadata every refresh (titles change)
    for (const { session } of this.files.values()) if (session) applyDesktop(session, this.desktop.get(session.id));
    this.progress.ready = true;
  }

  async _listFiles() {
    const out = [];
    for (const root of this.roots()) {
    let dirs = [];
    try { dirs = await fsp.readdir(root.projectsDir, { withFileTypes: true }); } catch { continue; }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      if (this.exclude.has(d.name.toLowerCase())) continue;
      const dir = path.join(root.projectsDir, d.name);
      let entries = [];
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
        const p = path.join(dir, e.name);
        try {
          const st = await fsp.stat(p);
          out.push({ path: p, project: d.name, pc: root.pc, mtimeMs: st.mtimeMs, size: st.size, subSig: await subagentSig(p) });
        } catch { /* vanished */ }
      }
    }
    }
    return out;
  }

  async _loadDesktop() {
    for (const root of this.roots()) {
      if (root.desktopFile) {
        try {
          const j = JSON.parse(await fsp.readFile(root.desktopFile, 'utf8'));
          for (const [k, v] of Object.entries(j)) this.desktop.set(k, v);
        } catch { /* not synced yet */ }
      }
      if (root.desktopDir) await this._walkDesktop(root.desktopDir);
    }
  }

  async _walkDesktop(top) {
    const walk = async (dir, depth) => {
      let entries = [];
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory() && depth < 4 && !e.name.startsWith('deleted_')) await walk(p, depth + 1);
        else if (e.isFile() && /^local_.*\.json$/.test(e.name)) {
          try {
            const j = JSON.parse(await fsp.readFile(p, 'utf8'));
            if (j.cliSessionId) this.desktop.set(j.cliSessionId, {
              desktopId: j.sessionId, title: j.title, archived: !!j.isArchived,
              createdAt: j.createdAt, lastActivityAt: j.lastActivityAt, model: j.model, effort: j.effort,
            });
          } catch { /* partial write */ }
        }
      }
    };
    await walk(top, 0);
  }
}

function applyDesktop(s, d) {
  s.desktop = d || null;
  s.archived = !!d?.archived;
  s.title = s.customTitle || d?.title || s.agentName || s.firstPrompt.slice(0, 80) || '(untitled)';
}

function summary(s) {
  return {
    session_id: s.id, title: s.title, project: s.project, cwd: s.cwd,
    created: s.created, updated: s.updated, archived: s.archived,
    messages: s.counts.user + s.counts.assistant, tool_calls: s.counts.tool,
    first_prompt: s.firstPrompt.slice(0, 240), model: s.model, cost_usd: s.costUSD,
    desktop_id: s.desktop?.desktopId || null, fork_of: s.forkOf || null, pc: s.pc || null,
    subagents: (s.subagents || []).length,
  };
}

function snippet(text, idx, radius = 140) {
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + radius);
  return (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ') + (end < text.length ? '…' : '');
}

const SYS_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

function blockText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => {
    if (b.type === 'text') return b.text;
    if (b.type === 'image') return '[image]';
    if (b.type === 'document') return '[document]';
    return '';
  }).join('\n');
}

function stripEcho(t) {
  if (!t.startsWith('> **You (via ChatLens):**')) return t;
  const lines = t.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].startsWith('>')) i++;
  return lines.slice(i).join('\n').replace(/^\s+/, '');
}

function cap(s, n) {
  return s.length > n ? s.slice(0, n) + `\n…[truncated ${s.length - n} chars]` : s;
}

// Read complete lines from `start`; returns the offset just past the last full
// line, so a half-written (or half-synced) final line is picked up next time.
async function readLinesFrom(file, start, onLine) {
  const fh = await fsp.open(file, 'r');
  try {
    const CHUNK = 8 * 1024 * 1024;
    let pos = start, carry = null;
    for (;;) {
      const buf = Buffer.allocUnsafe(CHUNK);
      const { bytesRead } = await fh.read(buf, 0, CHUNK, pos);
      if (!bytesRead) break;
      pos += bytesRead;
      let data = buf.subarray(0, bytesRead);
      if (carry) { data = Buffer.concat([carry, data]); carry = null; }
      const last = data.lastIndexOf(0x0a);
      if (last < 0) { carry = data; continue; }
      const text = data.toString('utf8', 0, last);
      for (const line of text.split('\n')) onLine(line.endsWith('\r') ? line.slice(0, -1) : line);
      if (last + 1 < data.length) carry = data.subarray(last + 1);
    }
    return pos - (carry ? carry.length : 0);
  } finally { await fh.close(); }
}

export async function parseSession(file, project, prev = null) {
  const id = path.basename(file, '.jsonl');
  const s = prev?.s || {
    id, file, project, cwd: null, gitBranch: null, model: null,
    created: null, updated: null, customTitle: null, agentName: null, firstPrompt: '',
    messages: [], counts: { user: 0, assistant: 0, tool: 0 }, costUSD: null, forkOf: null,
    title: '', archived: false, desktop: null,
  };
  const byMsgId = prev?.byMsgId || new Map(); // merge streamed assistant chunks sharing message.id
  const firstNew = s.messages.length;
  const offset = await readLinesFrom(file, prev?.offset || 0, (line) => parseLine(s, byMsgId, id, line));
  for (let k = firstNew; k < s.messages.length; k++) s.messages[k].search ??= s.messages[k].text || '';
  Object.defineProperty(s, '_state', { value: { s, byMsgId, offset }, enumerable: false, configurable: true, writable: true });
  return s;
}

function parseLine(s, byMsgId, id, line) {
  {
    if (!line || SKIP_PREFIXES.some((p) => line.startsWith(p))) return;
    let o;
    try { o = JSON.parse(line); } catch { return; }
    const t = o.type;
    if (t === 'custom-title') { s.customTitle = o.customTitle; return; }
    if (t === 'agent-name') { s.agentName = o.agentName; return; }
    if (t === 'cost-state') { s.costUSD = o.totalCostUSD; return; }
    if (t === 'summary' && o.summary) { s.customTitle ||= o.summary; return; }
    if (t !== 'user' && t !== 'assistant') return;
    if (o.forkedFrom?.sessionId) s.forkOf ||= o.forkedFrom.sessionId;
    if (o.sessionId && o.sessionId !== id && !s.forkOf) s.forkOf = o.sessionId;
    s.cwd ||= o.cwd; s.gitBranch ||= o.gitBranch;
    if (o.timestamp) { s.created ||= o.timestamp; s.updated = o.timestamp; }
    const m = o.message || {};
    const base = { uuid: o.uuid, ts: o.timestamp, sidechain: !!o.isSidechain };

    if (t === 'assistant') {
      if (m.model && m.model !== '<synthetic>') s.model = m.model;
      const blocks = Array.isArray(m.content) ? m.content : [];
      let entry = m.id && byMsgId.get(m.id);
      if (!entry) {
        entry = { ...base, role: 'assistant', text: '', tools: [], error: !!o.isApiErrorMessage };
        if (m.id) byMsgId.set(m.id, entry);
        push(s, entry);
        s.counts.assistant++;
      }
      for (const b of blocks) {
        // Replies to relayed messages open with a quote of them for the desktop window; ChatLens already shows the message.
        if (b.type === 'text' && b.text) entry.text += (entry.text ? '\n\n' : '') + (entry.text ? b.text : stripEcho(b.text));
        else if (b.type === 'thinking' && b.thinking) entry.thinking = (entry.thinking || '') + b.thinking;
        else if (b.type === 'tool_use') {
          let input = '';
          try { input = JSON.stringify(b.input); } catch { input = String(b.input); }
          entry.tools.push({ id: b.id, name: b.name, input: cap(input, TOOL_INPUT_CAP) });
          s.counts.tool++;
        }
      }
      entry.search = entry.text + (entry.tools.length ? '\n' + entry.tools.map((x) => x.name + ' ' + x.input).join('\n') : '');
      return;
    }

    // user record: either a human prompt, meta/system content, or tool results
    const content = m.content;
    if (Array.isArray(content) && content.some((b) => b.type === 'tool_result')) {
      for (const b of content) {
        if (b.type !== 'tool_result') return;
        const txt = cap(blockText(b.content), TOOL_RESULT_CAP);
        push(s, { ...base, role: 'tool', toolUseId: b.tool_use_id, isError: !!b.is_error, text: txt, search: txt });
      }
      return;
    }
    // A message relayed from another session (e.g. ChatLens on the phone): show its own words.
    if (o.origin?.kind === 'peer' && typeof o.origin.body === 'string') {
      const body = o.origin.body;
      const clean = body.replace(/^\[(?:Sent by the user from ChatLens|From ChatLens)[\s\S]*?\]\s*\n/, '').trim();
      push(s, { ...base, role: 'user', meta: false, from: o.origin.name || 'another session', text: clean, search: clean });
      s.counts.user++;
      if (!s.firstPrompt) s.firstPrompt = clean.slice(0, 2000);
      return;
    }
    const raw = blockText(content);
    if (o.isCompactSummary) {
      push(s, { ...base, role: 'summary', text: raw, search: raw });
      return;
    }
    const clean = raw.replace(SYS_REMINDER, '').trim();
    const meta = !!o.isMeta || !clean || /^<(command-|local-command|bash-|task-notification|side-sessions-event|ci-monitor-event)/.test(clean);
    push(s, { ...base, role: 'user', meta, text: raw, search: clean });
    if (!meta) {
      s.counts.user++;
      if (!s.firstPrompt) s.firstPrompt = clean.slice(0, 2000);
    }
  }
}

function subagentDir(file) {
  return path.join(file.slice(0, -'.jsonl'.length), 'subagents');
}

async function subagentSig(file) {
  try {
    const names = (await fsp.readdir(subagentDir(file))).filter((n) => n.endsWith('.jsonl'));
    let sig = names.length + ':';
    for (const n of names) { const st = await fsp.stat(path.join(subagentDir(file), n)); sig += st.size + ','; }
    return sig;
  } catch { return ''; }
}

async function parseSubagents(file) {
  const dir = subagentDir(file);
  let names = [];
  try { names = (await fsp.readdir(dir)).filter((n) => n.endsWith('.jsonl')); } catch { return []; }
  const out = [];
  for (const n of names) {
    const agentId = n.replace(/^agent-/, '').replace(/\.jsonl$/, '');
    let meta = {};
    try { meta = JSON.parse(await fsp.readFile(path.join(dir, n.replace(/\.jsonl$/, '.meta.json')), 'utf8')); } catch { /* none */ }
    try {
      const sub = await parseSession(path.join(dir, n), null);
      out.push({ agentId, description: meta.description || sub.firstPrompt.slice(0, 80), agentType: meta.agentType || null,
        created: sub.created, updated: sub.updated, counts: sub.counts, messages: sub.messages });
    } catch { /* skip */ }
  }
  out.sort((a, b) => (a.created || '').localeCompare(b.created || ''));
  return out;
}

function push(s, entry) {
  entry.i = s.messages.length;
  s.messages.push(entry);
}

// Render a slice of a session as plain text for the model.
export function renderForModel(s, { start = 0, count = 40, includeTools = true, maxChars = 3000, includeMeta = false } = {}) {
  const msgs = s.messages.slice(start, start + count);
  const lines = [];
  for (const m of msgs) {
    if (m.role === 'user' && m.meta && !includeMeta) continue;
    if (m.role === 'tool' && !includeTools) continue;
    const ts = m.ts ? m.ts.replace('T', ' ').slice(0, 19) : '';
    const tag = m.sidechain ? ' (subagent)' : '';
    if (m.role === 'user') lines.push(`[#${m.i} USER ${ts}${tag}]\n${cap(includeMeta ? m.text : m.search, maxChars)}`);
    else if (m.role === 'summary') lines.push(`[#${m.i} COMPACTION SUMMARY ${ts}]\n${cap(m.text, maxChars)}`);
    else if (m.role === 'assistant') {
      let body = m.text ? cap(m.text, maxChars) : '';
      if (includeTools && m.tools.length) body += (body ? '\n' : '') + m.tools.map((x) => `→ ${x.name} ${cap(x.input, Math.min(maxChars, 800))}`).join('\n');
      if (body) lines.push(`[#${m.i} CLAUDE ${ts}${tag}]\n${body}`);
    } else if (m.role === 'tool') lines.push(`[#${m.i} TOOL RESULT${m.isError ? ' (error)' : ''}]\n${cap(m.text, Math.min(maxChars, 1500))}`);
  }
  return lines.join('\n\n');
}
