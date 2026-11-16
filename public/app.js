// ChatLens front end (no build step).
const $ = (s) => document.querySelector(s);
const api = async (path, opts = {}) => {
  const r = await fetch(path, { ...opts, headers: { 'X-ChatLens': '1', 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ls = { get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };

// Markdown: raw HTML in transcripts is shown as text, and only http(s)/mailto links are kept.
marked.use({
  gfm: true, breaks: false,
  renderer: {
    html({ text }) { return esc(text); },
    link({ href, title, tokens }) {
      const inner = this.parser.parseInline(tokens);
      if (!/^(https?:|mailto:|#)/i.test(href || '')) return inner;
      return `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer"${title ? ` title="${esc(title)}"` : ''}>${inner}</a>`;
    },
    image({ href, text }) { return `[image: ${esc(text || href)}]`; },
  },
});
const md = (s) => { try { return marked.parse(s || ''); } catch { return `<pre>${esc(s)}</pre>`; } };

const fmtDate = (iso) => iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
const fmtShort = (iso) => {
  if (!iso) return '';
  const d = new Date(iso), now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
};
const highlight = (text, q) => {
  const h = esc(text);
  if (!q) return h;
  const terms = q.split(/\s+/).filter(Boolean).map((t) => esc(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!terms.length) return h;
  try { return h.replace(new RegExp(`(${terms.join('|')})`, 'gi'), '<mark>$1</mark>'); } catch { return h; }
};

// ---------------- state ----------------
const state = {
  chats: [], byId: new Map(), searchResults: null,
  chat: null, entries: [], rendered: 0,
  conv: null, convs: [], streaming: null,
  focusId: null,
};

// ---------------- sidebar ----------------
async function loadChats() {
  const r = await api('/api/chats');
  state.chats = r.items;
  state.byId = new Map(r.items.map((c) => [c.session_id, c]));
  // Keep the list scroll position across refreshes.
  const list = $('#chatList'), top = list.scrollTop;
  renderList();
  list.scrollTop = top;
  if (state.chat) { updateLivePill(); scheduleTail(); }
}

const liveDot = (l) => `<i class="ldot ${l.status === 'busy' ? 'busy' : ''}" title="${l.status === 'busy' ? 'Working now' : 'Open, idle'}"></i>`;
const liveLabel = (l) => (l.status === 'busy' ? 'Working now' : (l.desktop ? 'Open in desktop app' : 'Running')) ;

function groupLabel(iso) {
  if (!iso) return 'Unknown';
  const d = new Date(iso), now = new Date();
  const days = Math.floor((new Date(now.toDateString()) - new Date(d.toDateString())) / 864e5);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return 'This week';
  if (days < 31) return 'This month';
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function renderList() {
  const list = $('#chatList');
  const q = $('#q').value.trim().toLowerCase();
  const project = $('#project').value;
  const showArchived = $('#showArchived').checked, showForks = $('#showForks').checked;
  const activeId = state.chat?.session_id;

  if (state.searchResults) {
    const r = state.searchResults;
    $('#searchBanner').classList.remove('hidden');
    $('#searchBanner').innerHTML = `<span>${r.total_hits} matches in ${r.total_sessions} chats for “${esc(r.q)}”</span><a href="#" id="clearSearch">clear</a>`;
    $('#clearSearch').onclick = (e) => { e.preventDefault(); state.searchResults = null; renderList(); };
    list.innerHTML = r.results.map((x) => `
      <div class="item ${x.session_id === activeId ? 'active' : ''}" data-id="${x.session_id}" data-i="${x.hits[0]?.index ?? ''}" data-sub="${x.hits[0]?.subagent_id ?? ''}">
        <div class="t">${esc(x.title)}</div>
        <div class="s"><span>${fmtShort(x.updated)}</span><span>${x.match_count} hits</span></div>
        ${x.hits.slice(0, 2).map((h) => `<div class="snip" data-i="${h.index}" data-sub="${h.subagent_id || ''}">#${h.index} ${h.role}${h.subagent_id ? ' (subagent)' : ''}: ${highlight(h.snippet, r.regex ? '' : r.q)}</div>`).join('')}
      </div>`).join('') || '<div class="group">No matches</div>';
    return;
  }
  $('#searchBanner').classList.add('hidden');
  // Copies (forks) of other chats are hidden unless "forks" is ticked.
  const pcF = $('#pcFilter').value;
  let items = state.chats.filter((c) => (showArchived || !c.archived) && (showForks || !(c.chatlens_fork || c.fork_of)) && (!project || c.project === project) && (!pcF || c.pc === pcF));
  if (q) items = items.filter((c) => (c.title + ' ' + c.first_prompt + ' ' + c.session_id).toLowerCase().includes(q));
  const row = (c) => `<div class="item ${c.session_id === activeId ? 'active' : ''}" data-id="${c.session_id}" title="${esc(c.first_prompt)}">
      <div class="t">${c.live ? liveDot(c.live) : ''}${esc(c.title)}</div>
      <div class="s"><span>${c.live ? liveLabel(c.live) : fmtShort(c.updated)}</span><span>${c.messages} msgs</span>${(state.pcs?.length > 1 && c.pc_name) ? `<span class="pcBadge">${esc(c.pc_name)}</span>` : ''}${c.archived ? '<span class="badge">archived</span>' : ''}${c.chatlens_fork || c.fork_of ? '<span class="badge">copy</span>' : ''}${c.subagents ? `<span class="badge">${c.subagents} agents</span>` : ''}</div>
    </div>`;
  let html = '', last = '';
  // Sessions running on the PC right now go first, busy ones on top.
  const live = q || project ? [] : items.filter((c) => c.live).sort((a, b) => (b.live.status === 'busy') - (a.live.status === 'busy') || (b.updated || '').localeCompare(a.updated || ''));
  if (live.length) html += `<div class="group live">Live on ${esc(PC())}</div>` + live.map(row).join('');
  for (const c of items) {
    if (live.includes(c)) continue;
    const g = groupLabel(c.updated);
    if (g !== last) { html += `<div class="group">${esc(g)}</div>`; last = g; }
    html += row(c);
  }
  list.innerHTML = html || '<div class="group">No chats</div>';
}

$('#chatList').addEventListener('click', (e) => {
  const snip = e.target.closest('.snip');
  const item = e.target.closest('.item');
  if (!item) return;
  const i = (snip || item).dataset.i, sub = (snip || item).dataset.sub;
  if (mqPhone.matches) document.body.dataset.view = 'chat'; // same hash = no hashchange
  location.hash = `#/chat/${item.dataset.id}${sub ? '/sub/' + sub : ''}${i !== '' && i != null ? '@' + i : ''}`;
});
$('#q').addEventListener('input', () => { if (!state.searchResults) renderList(); });
$('#q').addEventListener('keydown', async (e) => {
  if (e.key === 'Enter') {
    const q = $('#q').value.trim();
    if (!q) { state.searchResults = null; return renderList(); }
    const regex = $('#regex').checked;
    try {
      const r = await api(`/api/search?q=${encodeURIComponent(q)}&regex=${regex ? 1 : 0}&project=${encodeURIComponent($('#project').value)}`);
      state.searchResults = { ...r, q, regex };
    } catch (err) { alert(err.message); }
    renderList();
  } else if (e.key === 'Escape') { $('#q').value = ''; state.searchResults = null; renderList(); }
});
['#project', '#pcFilter', '#showArchived', '#showForks'].forEach((s) => $(s).addEventListener('change', renderList));

async function loadProjects() {
  const ps = await api('/api/projects');
  $('#project').innerHTML = '<option value="">All projects</option>' + ps.map((p) => `<option value="${esc(p.project)}">${esc(p.cwd || p.project)} (${p.count})</option>`).join('');
}

// ---------------- transcript viewer ----------------
const CHUNK = 150;

async function openChat(id, sub, index) {
  const key = id + '|' + (sub || '');
  if (state.chat?._key !== key) {
    $('#transcript').innerHTML = '<div class="muted" style="text-align:center;padding:40px">Loading…</div>';
    try {
      const c = await api(`/api/chat/${id}${sub ? '?sub=' + encodeURIComponent(sub) : ''}`);
      c._key = key;
      state.chat = c;
    } catch (e) { $('#transcript').innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
    renderHeader();
    $('#transcript').innerHTML = '';
    // Open on the latest messages; a linked message opens around that message.
    const total = state.chat.entries.length;
    const start = index != null ? Math.max(0, index - 40) : Math.max(0, total - CHUNK);
    state.first = state.rendered = start;
    renderMore(index != null ? index + 40 : total);
    if (start > 0) addLoadEarlier();
    renderList();
  }
  if (index != null) jumpTo(index);
  else scrollToBottom();
}

function scrollToBottom() {
  const t = $('#transcript');
  t.scrollTop = t.scrollHeight;
  requestAnimationFrame(() => { t.scrollTop = t.scrollHeight; }); // after images/markdown settle
}

function buildEntry(e) {
  const div = document.createElement('div');
  div.className = `entry ${e.role}${e.meta ? ' meta' : ''}${e.sidechain ? ' sidechain' : ''}`;
  div.id = 'e' + e.i;
  if (!visible(e) || plumbing(e)) div.classList.add('hidden');
  div.innerHTML = entryHTML(e);
  // A turn whose only content is a question/next-step card that now sits in the dock: nothing left to show here.
  if (e.role === 'assistant' && !e.text && (e.tools || []).every((t) => t.q || !$('#showTools').checked) && !div.querySelector('.decCard')) div.classList.add('hidden');
  return div;
}
// The app's own bookkeeping, e.g. "Shown in the next-step box": results of the question/box tools.
function plumbing(e) {
  if (e.role !== 'tool' || !e.toolUseId || !state.chat) return false;
  const c = state.chat;
  if (!c._decIds || c._decIdsLen !== c.entries.length) {
    c._decIds = new Set(c.entries.flatMap((x) => (x.tools || []).filter((t) => t.q).map((t) => t.id)));
    c._decIdsLen = c.entries.length;
  }
  return c._decIds.has(e.toolUseId);
}

function addLoadEarlier() {
  const t = $('#transcript');
  t.querySelector('.loadEarlier')?.remove();
  if (!state.first) return;
  const b = document.createElement('button');
  b.className = 'loadMore loadEarlier';
  b.textContent = `Load earlier messages (${state.first})`;
  b.onclick = () => renderEarlier(state.first - CHUNK);
  t.insertBefore(b, t.firstChild);
}

// Prepend older entries without moving what's on screen.
function renderEarlier(from) {
  from = Math.max(0, from);
  if (!state.chat || from >= state.first) return;
  const t = $('#transcript');
  const prevH = t.scrollHeight, prevTop = t.scrollTop;
  const frag = document.createDocumentFragment();
  for (let k = from; k < state.first; k++) frag.appendChild(buildEntry(state.chat.entries[k]));
  t.querySelector('.loadEarlier')?.remove();
  t.insertBefore(frag, t.firstChild);
  state.first = from;
  addLoadEarlier();
  t.scrollTop = prevTop + (t.scrollHeight - prevH);
}

function renderHeader() {
  const c = state.chat;
  $('#empty').classList.add('hidden');
  $('#chatHeader').classList.remove('hidden');
  $('#chatTitle').textContent = c.subagent ? `${c.title} › ${c.subagent_description || c.subagent}` : c.title;
  $('#chatMeta').innerHTML = [
    esc(c.cwd || c.project), `${fmtDate(c.created)} → ${fmtDate(c.updated)}`, c.model && esc(c.model),
    c.cost_usd != null && `$${c.cost_usd.toFixed(2)}`, c.git_branch && c.git_branch !== 'HEAD' && `branch ${esc(c.git_branch)}`,
    `id ${c.session_id}`, c.desktop_id && `desktop ${esc(c.desktop_id)}`, c.archived && 'archived',
  ].filter(Boolean).join(' · ');
  const sel = $('#subagent');
  if (c.subagents.length) {
    sel.classList.remove('hidden');
    sel.innerHTML = `<option value="">Main chat (${c.subagent ? '' : c.entries.length + ' entries'})</option>` +
      c.subagents.map((a) => `<option value="${esc(a.id)}" ${a.id === c.subagent ? 'selected' : ''}>Subagent: ${esc(a.description)} (${a.entries})</option>`).join('');
  } else sel.classList.add('hidden');
  $('#findInChat').value = ''; $('#findCount').textContent = '';
  $('#replyBar').classList.remove('hidden');
  $('#tabChat').disabled = false;
  $('#replyNotice').classList.add('hidden'); $('#replyBar').dataset.notice = '';
  setReplyBusy(!!(state.pending && !state.pending.done && state.pending.sessionId === c.session_id));
  if (state.pending) drawPending(true);
  updateLivePill();
  scheduleTail(true);
  $('#chatHeader').classList.remove('tools-open'); $('#btnTools').setAttribute('aria-expanded', 'false');
}
// ---- following an open chat as it grows (live sessions on the PC) ----
function updateLivePill() {
  if (!state.chat) return;
  updateReplyState();
  const l = state.byId.get(state.chat.session_id)?.live;
  let pill = $('#livePill');
  if (!l) { pill?.remove(); return; }
  if (!pill) { pill = document.createElement('span'); pill.id = 'livePill'; $('#chatTitle').prepend(pill); }
  pill.className = `livePill ${l.status === 'busy' ? '' : 'idle'}`;
  pill.innerHTML = `${liveDot(l)}${l.status === 'busy' ? 'Working' : (l.desktop ? 'Open in desktop' : 'Running')}`;
}
let tailTimer = null;
function scheduleTail(now) {
  clearTimeout(tailTimer);
  if (!state.chat || state.chat.subagent) return;
  const live = state.byId.get(state.chat.session_id)?.live;
  const recent = Date.now() - new Date(state.chat.updated || 0).getTime() < 10 * 60e3;
  const waiting = state.pending?.done && state.pending.sessionId === state.chat.session_id;
  const delay = document.visibilityState !== 'visible' ? 30000 : (waiting || live?.status === 'busy') ? 1000 : (live || recent) ? 3000 : 15000;
  tailTimer = setTimeout(tail, now ? 0 : delay);
}
async function tail() {
  const chat = state.chat;
  if (!chat || chat.subagent) return;
  try {
    const r = await api(`/api/chat/${chat.session_id}/tail?from=${chat.entries.length}`);
    if (state.chat !== chat) return;
    const lastOld = JSON.stringify(chat.entries[r.total - 1] || null), lastNew = JSON.stringify(r.entries.at(-1) || null);
    if (r.total !== chat.entries.length || lastOld !== lastNew) {
      const t = $('#transcript');
      const allShown = state.rendered >= chat.entries.length;
      const stick = allShown && t.scrollTop + t.clientHeight > t.scrollHeight - 160;
      chat.entries.splice(r.start, Infinity, ...r.entries);
      chat.updated = r.updated;
      const redrawFrom = Math.max(r.start, state.first || 0);
      if (state.rendered > redrawFrom) {
        // re-draw the changed tail in place
        for (let k = redrawFrom; k < state.rendered; k++) document.getElementById('e' + k)?.remove();
        state.rendered = redrawFrom;
        renderMore(allShown ? chat.entries.length : redrawFrom);
      } else if (state.rendered < chat.entries.length) {
        const b = $('#transcript .loadMore:not(.loadEarlier)'); if (b) b.textContent = `Load more (${chat.entries.length - state.rendered} remaining)`;
      }
      if (stick) t.scrollTop = t.scrollHeight;
      refreshDecisionCards();
    }
    settlePending();
  } catch (e) {
    if (/not found/i.test(e.message)) return; // the chat was deleted: stop following it
    /* offline: try again later */
  }
  scheduleTail(state.pending?.done && state.pending.sessionId === chat.session_id ? false : undefined);
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { scheduleTail(true); loadChats().catch(() => {}); } });

$('#subagent').addEventListener('change', (e) => { location.hash = `#/chat/${state.chat.session_id}${e.target.value ? '/sub/' + e.target.value : ''}`; });

function visible(e) {
  if (e.role === 'user' && e.meta && !$('#showMeta').checked) return false;
  if (e.role === 'tool' && !$('#showTools').checked) return false;
  if (e.role === 'assistant' && !e.text && !$('#showTools').checked && !(e.tools || []).some((t) => t.q)) return false;
  return true;
}

function entryHTML(e) {
  let who = { user: 'You', assistant: 'Claude', tool: 'Tool result', summary: 'Compaction summary' }[e.role] || e.role;
  if (e.from) who = e.from === 'ChatLens' ? 'You · via ChatLens' : `From ${esc(e.from)}`;
  const head = `<div class="who"><a href="#/chat/${state.chat.session_id}${state.chat.subagent ? '/sub/' + state.chat.subagent : ''}@${e.i}">#${e.i}</a><span>${who}${e.sidechain ? ' · subagent' : ''}${e.meta ? ' · system' : ''}</span><span>${fmtDate(e.ts)}</span></div>`;
  if (e.role === 'tool') {
    return `<details class="tool ${e.isError ? 'err' : ''}"><summary>↳ result${e.isError ? ' (error)' : ''}: ${esc((e.text || '').slice(0, 140))}</summary><pre>${esc(e.text)}</pre>${e.more ? `<button class="more" data-full="${e.i}">Load full output</button>` : ''}</details>`;
  }
  if (e.role === 'assistant') {
    const cards = (e.tools || []).map((t) => decisionHTML(e, t)).filter(Boolean).join('');
    const tools = $('#showTools').checked ? (e.tools || []).filter((t) => !t.q).map((t) => `<details class="tool"><summary>${esc(t.name)} ${esc(inputLabel(t.input))}</summary><pre>${esc(prettyJSON(t.input))}</pre>${t.more ? `<button class="more" data-full="${e.i}">Load full input</button>` : ''}</details>`).join('') : '';
    return head + `<div class="body">${e.text ? md(e.text) : ''}${tools}${cards}${e.error ? '<div class="err">API error</div>' : ''}</div>`;
  }
  if (e.role === 'user' && !e.meta && (e.text || '').includes('\n\n[Attached files — open them with the Read tool]\n')) {
    // Attachments sent from ChatLens: show them as chips, not as file paths.
    const [main, list] = e.text.split('\n\n[Attached files — open them with the Read tool]\n');
    const names = list.split('\n').map((l) => /^- (.+?) \(/.exec(l)?.[1]).filter(Boolean).map((p) => ({ name: p.split(/[\\/]/).pop() }));
    return head + `<div class="body">${esc(main)}</div>${filesLine(names)}`;
  }
  if (e.role === 'summary') return head + `<details class="tool"><summary>Context was compacted here — show the summary Claude carried forward (${Math.round(e.text.length / 1000)}k chars)</summary><div class="body" style="padding:6px 12px">${md(e.text)}</div></details>`;
  return head + `<div class="body">${esc(e.text)}</div>`;
}
// Pick the most telling field of a tool input for the one-line header.
function inputLabel(s) {
  const m = /"(command|file_path|pattern|url|query|description|prompt|path|content)"\s*:\s*"((?:[^"\\]|\\.){0,200})/.exec(s);
  if (!m) return s.slice(0, 160);
  try { return JSON.parse('"' + m[2].replace(/\\$/, '') + '"'); } catch { return m[2]; }
}
const prettyJSON = (s) => { try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; } };

function renderMore(upTo) {
  const entries = state.chat.entries;
  // While a reply from ChatLens is in flight, its synced copy waits behind the inline view.
  const p = state.pending;
  const cap = p && p.sessionId === state.chat.session_id ? p.startTotal : entries.length;
  const end = Math.min(cap, Math.max(upTo, state.rendered + CHUNK));
  if (end <= state.rendered) return;
  const frag = document.createDocumentFragment();
  for (let k = state.rendered; k < end; k++) frag.appendChild(buildEntry(entries[k]));
  $('#transcript').querySelector('.loadMore:not(.loadEarlier)')?.remove();
  const pend = $('#pendingTurn');
  if (pend) $('#transcript').insertBefore(frag, pend); else $('#transcript').appendChild(frag);
  state.rendered = end;
  updateDock();
  if (end < cap) {
    const b = document.createElement('button');
    b.className = 'loadMore';
    b.textContent = `Load more (${entries.length - end} remaining)`;
    b.onclick = () => renderMore(state.rendered + CHUNK);
    $('#transcript').appendChild(b);
  }
}
// infinite scroll, both ways
$('#transcript').addEventListener('scroll', () => {
  const t = $('#transcript');
  if (!state.chat) return;
  if (state.rendered < state.chat.entries.length && t.scrollTop + t.clientHeight > t.scrollHeight - 600) renderMore(state.rendered + CHUNK);
  if (state.first > 0 && t.scrollTop < 300) renderEarlier(state.first - CHUNK);
});

function jumpTo(i) {
  if (i < (state.first || 0)) renderEarlier(i - 20);
  if (i >= state.rendered) renderMore(i + 20);
  const el = document.getElementById('e' + i);
  if (!el) return;
  el.classList.remove('hidden');
  el.querySelectorAll('details').forEach((d) => (d.open = true));
  // Tall messages: show their start, not their middle.
  el.scrollIntoView({ block: el.offsetHeight > $('#transcript').clientHeight * 0.7 ? 'start' : 'center' });
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
}

$('#transcript').addEventListener('click', async (ev) => {
  const b = ev.target.closest('button.more');
  if (!b) return;
  const i = Number(b.dataset.full);
  const sub = state.chat.subagent;
  const r = await api(`/api/chat/${state.chat.session_id}/entry/${i}${sub ? '?sub=' + sub : ''}`);
  const e = state.chat.entries[i];
  if (e.role === 'tool') { e.text = r.text; e.more = false; }
  else if (r.tools) { e.tools = r.tools.map((t) => ({ name: t.name, input: t.input })); }
  const el = document.getElementById('e' + i);
  el.innerHTML = entryHTML(e);
  el.querySelectorAll('details').forEach((d) => (d.open = true));
});

['#showTools', '#showMeta'].forEach((s) => $(s).addEventListener('change', () => {
  if (!state.chat) return;
  const top = $('#transcript').scrollTop, from = state.first || 0, to = state.rendered;
  $('#transcript').innerHTML = '';
  state.first = state.rendered = from;
  renderMore(to);
  addLoadEarlier();
  $('#transcript').scrollTop = top;
}));

// find in chat (uses the server search scoped to this chat, so it covers unrendered entries)
let findTimer;
$('#findInChat').addEventListener('input', () => {
  clearTimeout(findTimer);
  findTimer = setTimeout(async () => {
    const q = $('#findInChat').value.trim();
    if (!q || !state.chat) { $('#findCount').textContent = ''; state.findHits = []; return; }
    const r = await api(`/api/search?q=${encodeURIComponent(q)}&session=${state.chat.session_id}`);
    const hits = (r.results[0]?.hits || []).filter((h) => (h.subagent_id || '') === (state.chat.subagent || ''));
    state.findHits = hits; state.findPos = 0;
    $('#findCount').textContent = hits.length ? `1 / ${hits.length}${hits.length >= 200 ? '+' : ''}` : 'no matches';
    if (hits.length) jumpTo(hits[0].index);
  }, 250);
});
$('#findInChat').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !state.findHits?.length) return;
  state.findPos = (state.findPos + (e.shiftKey ? -1 : 1) + state.findHits.length) % state.findHits.length;
  $('#findCount').textContent = `${state.findPos + 1} / ${state.findHits.length}`;
  jumpTo(state.findHits[state.findPos].index);
});

// ---------------- navigation ----------------
// Phone: one screen at a time (body[data-view]) with a bottom tab bar.
// Tablet: Claude is a drawer. Desktop: everything visible.
const mqPhone = matchMedia('(max-width: 759px)');
const mqDesktop = matchMedia('(min-width: 1180px)');
const coarse = matchMedia('(pointer: coarse)').matches;
const claudeIsOpen = () => document.body.classList.contains('claude-open') || (mqPhone.matches && document.body.dataset.view === 'claude');
function setView(v) {
  if (v !== 'claude' && claudeIsOpen()) closeClaude();
  document.body.dataset.view = v;
}
function openClaude() {
  $('#claudeDot').classList.add('hidden');
  if (mqDesktop.matches) return;
  if (mqPhone.matches) document.body.dataset.view = 'claude';
  else document.body.classList.add('claude-open');
  // Let the phone/browser back button close Claude.
  if (!history.state?.claude) history.pushState({ claude: 1 }, '');
  requestAnimationFrame(() => { const box = $('#messages'); box.scrollTop = box.scrollHeight; });
}
function closeClaude(fromPop) {
  document.body.classList.remove('claude-open');
  if (mqPhone.matches && document.body.dataset.view === 'claude') document.body.dataset.view = state.chat ? 'chat' : 'list';
  if (!fromPop && history.state?.claude) history.back();
}
window.addEventListener('popstate', (e) => { if (!e.state?.claude && claudeIsOpen()) closeClaude(true); });
document.querySelectorAll('.openClaude').forEach((b) => (b.onclick = openClaude));
$('#btnCloseClaude').onclick = () => closeClaude();
$('#scrim').onclick = () => closeClaude();
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.body.classList.contains('claude-open')) closeClaude(); });
$('#tabbar').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-go]');
  if (!b || b.disabled) return;
  if (b.dataset.go === 'claude') openClaude(); else setView(b.dataset.go);
});
$('#btnBack').onclick = () => setView('list');
$('#btnFilters').onclick = () => {
  const open = $('#sidebar').classList.toggle('filters-open');
  $('#btnFilters').setAttribute('aria-expanded', open);
};
$('#btnTools').onclick = () => {
  const open = $('#chatHeader').classList.toggle('tools-open');
  $('#btnTools').setAttribute('aria-expanded', open);
};

const fitPlaceholders = () => { $('#q').placeholder = mqPhone.matches ? 'Search chats' : 'Filter titles · Enter searches messages'; };
mqPhone.addEventListener('change', fitPlaceholders); fitPlaceholders();

// Phone keyboard: track the visible viewport so composers stay above the keyboard.
if (window.visualViewport) {
  const vv = window.visualViewport;
  const fit = () => { document.documentElement.style.setProperty('--vvh', `${vv.height}px`); if (mqPhone.matches) window.scrollTo(0, 0); };
  vv.addEventListener('resize', fit); fit();
}
document.addEventListener('focusin', (e) => { if (mqPhone.matches && e.target.matches('textarea, input[type=search]')) document.body.classList.add('kb'); });
document.addEventListener('focusout', () => setTimeout(() => { if (!document.activeElement?.matches?.('textarea, input[type=search]')) document.body.classList.remove('kb'); }, 50));

// Auto-growing composers.
function autoGrow(el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, window.innerHeight * 0.38) + 'px'; }
['#prompt', '#reply'].forEach((s) => $(s).addEventListener('input', (e) => autoGrow(e.target)));

// Reply box under an open chat. Two modes:
//   ask      - ChatLens's Claude answers questions about this chat
//   continue - the chat itself carries on, on the PC, in its own session
// Typing into a chat continues it unless you pick "Ask about it".
state.replyMode = ls.get('replyMode2', 'continue');
function setReplyMode(mode) {
  state.replyMode = mode; ls.set('replyMode2', mode);
  document.querySelectorAll('.replyModes button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  $('#reply').placeholder = mode === 'continue' ? 'Reply to continue this chat…' : 'Ask about this chat (separate conversation)…';
  $('#replyNotice').classList.add('hidden'); $('#replyBar').dataset.notice = '';
  updateReplyState();
}
// A chat open in the desktop app can't be continued from here: say so up front.
function updateReplyState() {
  if (!state.chat) return;
  const c = state.byId.get(state.chat.session_id);
  const live = c?.live;
  const ownTurn = !!(state.pending && !state.pending.done && state.pending.sessionId === state.chat.session_id);
  // Busy = Claude is mid-turn in it (in the desktop app or from here): wait.
  // Idle but open in the desktop app = fine; the PC takes the chat over.
  const blocked = state.replyMode === 'continue' && live?.status === 'busy' && !live.desktop && !ownTurn;
  $('#replyBar').classList.toggle('blocked', blocked);
  $('#reply').disabled = blocked;
  $('#replyBar .send').disabled = blocked;
  const shown = $('#replyBar').dataset.notice || '';
  let want = '';
  if (blocked) want = 'busy';
  else if (state.replyMode === 'continue' && live?.desktop && !ownTurn) want = 'idle';
  else if (state.replyMode === 'continue' && c?.fork_of) want = 'copy';
  if (want !== shown) {
    if (want === 'busy') {
      replyNotice(`<b>Claude is working in this chat on ${esc(PC())}.</b> You can reply as soon as it finishes; this box unlocks by itself. <button type="button" class="linkish" data-ask>Ask about it instead</button>`);
      $('#replyNotice [data-ask]').onclick = () => setReplyMode('ask');
    } else if (want === 'idle') {
      replyNotice(`<b>Open in the desktop app.</b> Your reply goes straight into that window, and Claude answers there; you'll see it here as it writes.${live.status === 'busy' ? ' Claude is busy in it right now, so your message will wait its turn.' : ''}`);
    } else if (want === 'copy') {
      replyNotice(`This is a <b>copy</b> of <a href="#/chat/${c.fork_of}">another chat</a>. Replies continue the copy, not the original.`);
    } else $('#replyNotice').classList.add('hidden');
    $('#replyBar').dataset.notice = want;
  }
  $('#asMeWrap').classList.toggle('hidden', !(state.replyMode === 'continue' && live?.desktop));
}
document.querySelectorAll('.replyModes button').forEach((b) => (b.onclick = () => { setReplyMode(b.dataset.mode); if (!coarse) $('#reply').focus(); }));
setReplyMode(state.replyMode);
function replyNotice(html) { const n = $('#replyNotice'); n.innerHTML = html; n.classList.remove('hidden'); }

$('#reply').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !coarse) { e.preventDefault(); $('#replyBar').requestSubmit(); }
});
$('#replyBar').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (state.pending && !state.pending.done) {
    if (state.pending.sessionId === state.chat?.session_id) return stopPending();
    return replyNotice('A reply from ChatLens is still running in another chat. Wait for it to finish first.');
  }
  const text = $('#reply').value.trim();
  if (!state.chat) return;
  if (uploading('reply')) return replyNotice('Wait for the attachments to finish uploading.');
  if (!text && !readyFiles('reply').length) return;
  const id = state.chat.session_id;
  if (state.replyMode === 'continue') return continueInline(id, text);
  // "Ask about it": a separate assistant conversation in the side panel.
  if (state.streaming) { openClaude(); return; }
  if (!state.conv || state.conv.mode !== 'lens' || (state.conv.focusId || null) !== id) newConversation();
  setFocus(id);
  attach.prompt.push(...attach.reply.splice(0)); renderFiles('reply'); renderFiles('prompt');
  $('#reply').value = ''; autoGrow($('#reply')); $('#reply').blur();
  $('#prompt').value = text;
  openClaude();
  $('#composer').requestSubmit();
});

// ---- continuing a chat right where you're reading it ----
// The new turn streams in at the bottom of the transcript; once the PC's copy
// of the chat syncs back, the real entries take its place.
async function continueInline(sessionId, text, opts = {}) {
  let conv;
  try {
    const r = await fetch('/api/continue', { method: 'POST', headers: { 'X-ChatLens': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id: sessionId }) });
    const j = await r.json();
    if (r.status === 409) { replyNotice(`${esc(j.message)} <button type="button" class="linkish" data-ask>Ask about it instead</button>`); $('#replyNotice [data-ask]').onclick = () => setReplyMode('ask'); return; }
    if (!r.ok) throw new Error(j.error || r.statusText);
    conv = j;
  } catch (err) { replyNotice(esc(err.message)); return; }
  $('#reply').value = ''; autoGrow($('#reply')); if (coarse) $('#reply').blur();
  const asMe = opts.asMe || (!$('#asMeWrap').classList.contains('hidden') && $('#asMe').checked);
  const files = opts.noFiles ? [] : takeFiles('reply');
  $('#asMe').checked = false; // one message at a time
  const chat = state.chat;
  renderMore(chat.entries.length); // show everything up to now
  const reply = { role: 'assistant', text: '', tools: [], _live: true };
  state.pending = { sessionId, conv, text, reply, asMe, files, startTotal: chat.entries.length, status: `Sending to ${PC()}…`, done: false };
  drawPending(true);
  setReplyBusy(true);
  let first;
  try {
    first = await fetch('/api/ask', {
      method: 'POST', headers: { 'X-ChatLens': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: text, conversation_id: conv.id, model: $('#model').value, effort: $('#effort').value, full_tools: $('#fullTools').checked, as_me: asMe, answering: !!opts.answering, attachments: files.map((f) => f.id) }),
    });
    if (!first.ok) throw new Error((await first.json().catch(() => ({}))).error || first.statusText);
  } catch (err) {
    reply.error = err.message;
    return finishPending();
  }
  follow(conv, reply, first, {
    inline: true,
    status: (t) => { if (state.pending) { state.pending.status = t; drawPending(); } },
    update: () => drawPending(),
    finish: () => finishPending(),
  });
}

function stopPending() {
  const p = state.pending;
  if (p?.conv?.id) api('/api/stop', { method: 'POST', body: JSON.stringify({ conversation_id: p.conv.id }) });
}

function setReplyBusy(busy) {
  const send = $('#replyBar .send');
  send.classList.toggle('stop', busy);
  send.innerHTML = `<svg><use href="#i-${busy ? 'stop' : 'send'}"/></svg>`;
  send.setAttribute('aria-label', busy ? 'Stop' : 'Send');
  $('#reply').disabled = busy;
  $('#reply').placeholder = busy ? `Claude is replying on ${PC()}…` : (state.replyMode === 'continue' ? 'Reply to continue this chat…' : 'Ask about this chat (separate conversation)…');
}

let pendingRaf = 0;
function drawPending(scroll) {
  if (pendingRaf && !scroll) return;
  if (pendingRaf) cancelAnimationFrame(pendingRaf);
  pendingRaf = requestAnimationFrame(() => {
    pendingRaf = 0;
    const p = state.pending; // read now: it may have settled since this was queued
    let el = $('#pendingTurn');
    if (!p || state.chat?.session_id !== p.sessionId) { el?.remove(); return; }
    const t = $('#transcript');
    const stick = scroll || t.scrollTop + t.clientHeight > t.scrollHeight - 160;
    if (!el) { el = document.createElement('div'); el.id = 'pendingTurn'; }
    t.appendChild(el); // always last
    const r = p.reply;
    el.innerHTML = `
      <div class="entry user"><div class="who"><span>You · from ChatLens</span></div><div class="body">${esc(p.text)}</div>${filesLine(p.files)}</div>
      <div class="entry assistant pending"><div class="who"><span>Claude · ${p.asMe ? 'on ' + esc(PC()) + ', as you' : (p.reply.relay || state.byId.get(p.sessionId)?.live?.desktop ? 'in the desktop app' : 'on ' + esc(PC()))}</span></div>
        ${msgHTML({ ...r, role: 'assistant', _live: !p.done })}
        ${p.done && !p.relayed ? '' : `<div class="pendingStatus">${esc(p.status || '')}</div>`}
      </div>`;
    if (stick) t.scrollTop = t.scrollHeight;
  });
}

function finishPending() {
  const p = state.pending;
  if (!p) return;
  p.done = true;
  p.reply._live = false;
  p.reply.tools.forEach((t) => (t.done = true));
  setReplyBusy(false);
  updateReplyState();
  drawPending();
  if (p.reply.error) return; // keep the error on screen; the next send replaces it
  // Swap in the real entries once the chat's transcript has them.
  p.relayed = !!p.reply.relay?.ok;
  p.waitUntil = Date.now() + (p.relayed ? 10 * 60e3 : 20000);
  if (p.relayed) p.status = p.reply.relay.status === 'busy' ? 'Waiting for Claude in the desktop app to finish what it is doing…' : 'Delivered. Waiting for Claude in the desktop app…';
  scheduleTail(true);
}
// Called after each tail: has the real transcript caught up with the inline turn?
function settlePending() {
  const p = state.pending;
  if (!p || !p.done || !state.chat || state.chat.session_id !== p.sessionId) return;
  const fresh = state.chat.entries.slice(p.startTotal);
  // Relayed: the desktop chat has picked it up once your message shows there; its reply then streams in for real.
  const caughtUp = p.relayed ? fresh.some((e) => e.role === 'user' && e.from) : fresh.some((e) => e.role === 'assistant' && e.text);
  if (caughtUp || Date.now() > (p.waitUntil || 0)) {
    state.pending = null;
    if (pendingRaf) { cancelAnimationFrame(pendingRaf); pendingRaf = 0; }
    $('#pendingTurn')?.remove();
    renderMore(state.chat.entries.length);
    const t = $('#transcript'); t.scrollTop = t.scrollHeight;
  }
}

// Jump to the latest message of a long chat.
$('#jumpEnd').onclick = () => {
  if (!state.chat) return;
  renderMore(state.chat.entries.length);
  scrollToBottom();
  $('#jumpEnd').classList.add('hidden');
};
$('#transcript').addEventListener('scroll', () => {
  const t = $('#transcript');
  const far = state.chat && (state.rendered < state.chat.entries.length || t.scrollHeight - t.scrollTop - t.clientHeight > 400);
  $('#jumpEnd').classList.toggle('hidden', !far);
}, { passive: true });

// "Continue chat": switch the reply box to continuing this chat on the PC.
$('#btnFork').onclick = () => {
  setReplyMode('continue');
  if (!$('#reply').disabled) $('#reply').focus();
};

// ---------------- Claude panel ----------------
function setFocus(id) {
  state.focusId = id;
  const chip = $('#focusChip');
  if (!id) { chip.classList.add('hidden'); return; }
  const c = state.byId.get(id);
  chip.classList.remove('hidden');
  chip.innerHTML = `<span>About: <b>${esc(c?.title || id)}</b></span><button title="Ask about all chats instead" aria-label="Ask about all chats instead"><svg><use href="#i-close"/></svg></button>`;
  chip.querySelector('button').onclick = () => setFocus(null);
}

async function loadConversations() {
  state.convs = await api('/api/conversations');
  const sel = $('#convSelect');
  sel.innerHTML = '<option value="">New conversation</option>' + state.convs.filter((c) => c.mode !== 'pc').map((c) =>
    `<option value="${c.id}" ${state.conv?.id === c.id ? 'selected' : ''}>${c.mode === 'fork' ? '' : ''}${esc(c.title)} · ${fmtShort(c.updated)}</option>`).join('');
}
$('#convSelect').addEventListener('change', (e) => e.target.value ? openConversation(e.target.value) : newConversation());
$('#btnNew').onclick = () => newConversation();
$('#btnDelConv').onclick = async () => {
  if (!state.conv || !confirm('Delete this conversation from ChatLens?')) return;
  await api(`/api/conversations/${state.conv.id}`, { method: 'DELETE' });
  newConversation(); loadConversations();
};

function newConversation() {
  state.conv = null;
  $('#convSelect').value = '';
  renderMessages();
  ls.set('conv', null);
}

async function openConversation(id) {
  state.conv = await api(`/api/conversations/${id}`);
  $('#convSelect').value = id;
  ls.set('conv', id);
  renderMessages();
  // Still running on the server (reload, or another device started it): replay and follow it.
  const conv = state.conv;
  if (conv.running && !state.streaming) {
    const reply = { role: 'assistant', text: '', tools: [], _live: true };
    if (conv.messages.at(-1)?.role === 'assistant') conv.messages[conv.messages.length - 1] = reply; else conv.messages.push(reply);
    renderMessages();
    follow(conv, reply, null);
  }
}

function renderMessages() {
  const box = $('#messages');
  const c = state.conv;
  let html = '';
  if (!c) {
    const focused = state.focusId && state.byId.get(state.focusId);
    const ideas = focused
      ? ['Summarize this chat in 5 bullets', 'What is still unfinished here?', 'List the commands and hosts it touched', 'What decisions were made, and why?']
      : ['What did I work on this week?', 'Which chats are still unfinished?', 'Find every command I ran over SSH last week', 'Which chats had errors I never resolved?'];
    html = `<div class="welcome"><h3>${focused ? 'Ask about this chat' : 'Ask about any chat'}</h3>
      <p>${focused ? esc(focused.title) : 'Claude searches and reads every transcript itself.'}</p>
      <div class="suggest">${ideas.map((t) => `<button type="button" class="ex">${esc(t)}</button>`).join('')}</div></div>`;
  } else if (c.mode === 'pc') {
    const src = state.byId.get(c.sourceId);
    html = `<div class="forkNote pc"><b>Continuing on ${esc(PC())}</b> in <a href="#/chat/${c.sourceId}">${esc(src?.title || c.sourceId)}</a> itself. Claude runs there with that chat's folder, tools and history, and the new messages are added to the original chat, so the desktop app shows them when you open it. Full tools ${$('#fullTools').checked ? 'is on: it can run commands and edit files on the PC.' : 'is off: read-only.'}</div>`;
  } else if (c.mode === 'fork') {
    const src = state.byId.get(c.sourceId);
    html = `<div class="forkNote">Continuing <a href="#/chat/${c.sourceId}">${esc(src?.title || c.sourceId)}</a> with its full original context, in a fork (session <code>${esc(c.sdkSessionId)}</code>). The original chat is unchanged. Tools follow the Full tools switch above.</div>`;
  }
  for (const m of c?.messages || []) html += msgHTML(m);
  box.innerHTML = html;
  box.querySelectorAll('.ex').forEach((a) => (a.onclick = (e) => { e.preventDefault(); $('#prompt').value = a.textContent; $('#composer').requestSubmit(); }));
  box.scrollTop = box.scrollHeight;
  setFocus(c?.mode === 'fork' ? null : (c?.focusId ?? state.focusId));
  const running = !!state.streaming && state.streaming.convId === c?.id;
  $('#btnStop').classList.toggle('hidden', !running);
  $('#btnSend').classList.toggle('hidden', running);
}

const TOOL_LABEL = { mcp__chats__search_chats: 'search', mcp__chats__list_chats: 'list', mcp__chats__read_chat: 'read', mcp__chats__chat_overview: 'overview' };
function toolChip(t) {
  const name = TOOL_LABEL[t.name] || t.name;
  const i = t.input || {};
  const title = i.session_id ? (state.byId.get(i.session_id)?.title || i.session_id.slice(0, 8)) : '';
  let label = name;
  if (i.query) label += ` “${i.query}”`;
  if (title) label += ` ${title}`;
  if (i.start != null) label += ` #${i.start}`;
  if (i.file_path) label += ` ${i.file_path.split(/[\\/]/).pop()}`;
  if (i.pattern) label += ` /${i.pattern}/`;
  if (i.command) label += ` ${i.description || i.command}`;
  else if (i.description) label += ` ${i.description}`;
  if (i.url) label += ` ${i.url}`;
  label = label.slice(0, 120);
  const link = i.session_id ? `#/chat/${i.session_id}${i.subagent_id ? '/sub/' + i.subagent_id : ''}${i.start != null ? '@' + i.start : ''}` : '';
  const open = !link && state.openTools?.has(t.id);
  const detail = open ? `<div class="toolDetail">${esc(toolDetailText(t))}</div>` : '';
  return `<span class="tchip ${t.preview == null && !t.done ? 'pending' : ''} ${t.is_error ? 'err' : ''}" ${link ? `data-href="${esc(link)}"` : `data-tool="${esc(t.id || '')}"`} title="${esc(link ? 'Open in viewer' : 'Click to show input and output')}">${esc(label)}</span>${detail}`;
}
// Shell commands, edits etc.: what ran and what came back.
function toolDetailText(t) {
  const i = t.input || {};
  let s = i.command ? `$ ${i.command}` : i.old_string != null ? `${i.file_path}\n--- old\n${i.old_string}\n+++ new\n${i.new_string}` : i.content != null ? `${i.file_path}\n${i.content}` : JSON.stringify(i, null, 2);
  if (t.preview != null) s += `\n\n→ ${t.is_error ? 'error: ' : ''}${t.preview}${t.length > (t.preview || '').length ? `\n…(${t.length} chars total)` : ''}`;
  return s;
}

// Link "Title #123"-style citations and bare session ids to the viewer.
function linkify(html) {
  html = html.replace(/\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b(?![^<]*>)/g, (m, id) => state.byId.has(id) ? `<a href="#/chat/${id}">${id.slice(0, 8)}</a>` : m);
  const focus = state.conv?.mode === 'fork' ? state.conv.sourceId : (state.conv?.focusId || state.focusId);
  const titles = [...state.byId.values()].filter((c) => c.title.length > 5).sort((a, b) => b.title.length - a.title.length);
  html = html.replace(/(?:(“|"|\*\*)?([^<>“”"*\n]{3,90}?)(”|"|\*\*)?\s*)?(?<![&\w/])#(\d{1,6})\b(?![^<]*>)/g, (m, q1, title, q2, n) => {
    let id = null;
    if (title) {
      const t = title.trim().replace(/[—–:,(]+$/, '').trim().toLowerCase();
      const hit = titles.find((c) => t.endsWith(c.title.toLowerCase()));
      if (hit) id = hit.session_id;
    }
    id ||= focus;
    if (!id) return m;
    const pre = m.slice(0, m.lastIndexOf('#'));
    return `${pre}<a href="#/chat/${id}@${n}">#${n}</a>`;
  });
  return html;
}

function msgHTML(m) {
  if (m.role === 'user') return `<div class="msg user"><div class="body">${esc(m.text)}</div>${filesLine(m.attachments)}${m.fullTools ? '<div class="mode">full tools</div>' : ''}</div>`;
  // interleave tool chips at the text offset where they happened
  const tools = (m.tools || []).slice().sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  let out = '', pos = 0, chips = '';
  const flushText = (end) => { const seg = m.text.slice(pos, end); if (seg.trim()) out += linkify(md(seg)); pos = end; };
  for (const t of tools) {
    const at = t.at ?? 0;
    if (at > pos) { if (chips) { out += `<div>${chips}</div>`; chips = ''; } flushText(at); }
    chips += toolChip(t);
  }
  if (chips) out += `<div>${chips}</div>`;
  flushText(m.text.length);
  const foot = [m.cost_usd != null && `$${m.cost_usd.toFixed(3)}`, m.duration_ms && `${(m.duration_ms / 1000).toFixed(1)}s`].filter(Boolean).join(' · ');
  return `<div class="msg assistant"><div class="body ${m._live ? 'typing' : ''}">${out}</div>${m.error ? `<div class="err">${esc(m.error)}${/Settings|Claude login|Not logged in/i.test(m.error) ? ' <button type="button" class="linkish" data-open-settings>Open Settings</button>' : ''}</div>` : ''}${foot ? `<div class="foot">${foot}</div>` : ''}</div>`;
}

$('#messages').addEventListener('click', (e) => {
  const chip = e.target.closest('.tchip[data-href]');
  if (chip) return void (location.hash = chip.dataset.href);
  const tc = e.target.closest('.tchip[data-tool]');
  if (tc && tc.dataset.tool) {
    state.openTools ||= new Set();
    const id = tc.dataset.tool;
    state.openTools.has(id) ? state.openTools.delete(id) : state.openTools.add(id);
    const box = $('#messages'), top = box.scrollTop;
    renderMessages(); box.scrollTop = top;
  }
});

$('#prompt').addEventListener('keydown', (e) => {
  // On touch keyboards Enter makes a new line; the send button sends.
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !coarse) { e.preventDefault(); $('#composer').requestSubmit(); }
});

$('#composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const prompt = $('#prompt').value.trim();
  if (state.streaming) return;
  if (uploading('prompt')) { setStatus('Wait for the attachments to finish uploading.'); return; }
  if (!prompt && !readyFiles('prompt').length) return;
  const files = takeFiles('prompt');
  $('#prompt').value = ''; autoGrow($('#prompt'));
  if (coarse) $('#prompt').blur();
  const conv = state.conv || { id: null, mode: 'lens', messages: [], focusId: state.focusId };
  state.conv = conv;
  const reply = { role: 'assistant', text: '', tools: [], _live: true };
  conv.messages.push({ role: 'user', text: prompt || '(attached files)', fullTools: $('#fullTools').checked || undefined, attachments: files.map(({ id, name, type, size }) => ({ id, name, type, size })) }, reply);
  state.streaming = { convId: conv.id, reply };
  renderMessages();
  setStatus(conv.mode === 'pc' ? `Sending to ${PC()}…` : 'Thinking…');
  ls.set('model', $('#model').value); ls.set('effort', $('#effort').value); ls.set('fullTools', $('#fullTools').checked);

  let first;
  try {
    first = await fetch('/api/ask', {
      method: 'POST', headers: { 'X-ChatLens': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, conversation_id: conv.id, focus_id: conv.mode === 'lens' ? state.focusId : null, model: $('#model').value, effort: $('#effort').value, full_tools: $('#fullTools').checked, attachments: files.map((f) => f.id) }),
    });
    if (!first.ok) throw new Error((await first.json().catch(() => ({}))).error || first.statusText);
  } catch (err) {
    reply.error = err.message;
    return finishStream(conv, reply);
  }
  follow(conv, reply, first);
});

// ---- following a turn: survives dropped connections, locked screens, reloads ----
function applyEvent(conv, reply, ev, d, status = setStatus) {
  if (ev === 'conversation') { conv.id = d.id; conv.title = d.title; }
  else if (ev === 'delta') { reply.text += d.text; status('Writing…'); }
  else if (ev === 'text_start') { if (reply.text && !reply.text.endsWith('\n\n')) reply.text += '\n\n'; }
  else if (ev === 'tool') { reply.tools.push({ id: d.id, name: d.name, input: d.input, at: reply.text.length }); status(`Using ${TOOL_LABEL[d.name] || d.name}…`); }
  else if (ev === 'tool_result') { const t = reply.tools.find((x) => x.id === d.id); if (t) Object.assign(t, { preview: d.preview, is_error: d.is_error, length: d.length, done: true }); }
  else if (ev === 'status') status(d.text);
  else if (ev === 'relay') { reply.relay = d; if (d.ok) status(d.status === 'busy' ? 'Delivered. Claude in the desktop app is finishing something first…' : 'Delivered to the desktop app. Claude is answering there…'); }
  else if (ev === 'done') { reply.cost_usd = d.cost_usd; reply.duration_ms = d.duration_ms; if (d.error) reply.error = d.error; }
  else if (ev === 'error') reply.error = d.message;
}
// The machine the chats live on (its hostname, reported by the server).
function PC() { return state.byId?.get(state.chat?.session_id)?.pc_name || state.pcName || 'your PC'; }
const setStatus = (t) => { $('#convStatus').textContent = t; };
let repaintRaf = 0;
function repaint(conv) {
  if (repaintRaf) return;
  repaintRaf = requestAnimationFrame(() => {
    repaintRaf = 0;
    if (state.conv !== conv) return;
    const box = $('#messages'); const stick = box.scrollTop + box.clientHeight > box.scrollHeight - 80;
    renderMessages(); if (stick) box.scrollTop = box.scrollHeight;
  });
}

// Reads one SSE response; resolves when it ends, rejects on a dead connection.
async function readSSE(res, onEvent, ctl) {
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  // Aborting (watchdog, tab back in view, back online) ends the read so we reconnect.
  ctl.signal.addEventListener('abort', () => reader.cancel().catch(() => {}), { once: true });
  let buf = '', watchdog;
  // The server pings every 10 s; silence for 30 s means the connection is gone.
  const arm = () => { clearTimeout(watchdog); watchdog = setTimeout(() => ctl.abort(), 30000); };
  arm();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      arm();
      buf += value;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const id = /^id: (\d+)$/m.exec(block)?.[1];
        const ev = /^event: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (ev && data) onEvent(id == null ? null : Number(id), ev, JSON.parse(data));
      }
    }
  } finally { clearTimeout(watchdog); }
}

// Follow one turn's event stream until it ends, reconnecting as needed.
// hooks: { status(text), update(), finish(gone) } decide where it is shown.
const activeStreams = new Set();
async function follow(conv, reply, firstResponse, hooks) {
  hooks ||= {
    status: setStatus,
    update: () => repaint(conv),
    finish: (gone) => finishStream(conv, gone ? null : reply),
  };
  const slot = { reconnect: null };
  activeStreams.add(slot);
  if (!hooks.inline) state.streaming = { convId: conv.id, reply, reconnect: null };
  let last = -1, ended = false, attempt = 0, res = firstResponse, gone = false;
  const onEvent = (seq, ev, d) => {
    if (seq != null && seq <= last) return; // already applied before a reconnect
    if (seq != null) last = seq;
    if (ev === 'end') { ended = true; return; }
    applyEvent(conv, reply, ev, d, hooks.status);
    if (ev === 'conversation') { if (!hooks.inline) { if (state.streaming) state.streaming.convId = d.id; ls.set('conv', d.id); } hooks.onConversation?.(d.id); }
    hooks.update();
  };
  try {
    while (!ended) {
      const ctl = new AbortController();
      slot.reconnect = () => ctl.abort(); // e.g. when the tab becomes visible again
      try {
        if (!res) {
          if (!conv.id) throw new Error('lost');
          res = await fetch(`/api/stream/${conv.id}?from=${last + 1}`, { headers: { 'X-ChatLens': '1' }, signal: ctl.signal });
          if (res.status === 404) { await reloadConversation(conv); gone = true; break; }
          if (!res.ok) throw new Error(res.statusText);
        }
        await readSSE(res, onEvent, ctl);
        attempt = 0;
      } catch (e) {
        if (e.message === 'lost') { reply.error = 'The connection dropped before the conversation was created. Try again.'; break; }
      }
      res = null;
      if (!ended) {
        hooks.status('Reconnecting…');
        await new Promise((r) => setTimeout(r, Math.min(500 * 2 ** attempt++, 8000)));
      }
    }
  } finally {
    activeStreams.delete(slot);
    hooks.finish(gone);
  }
}

function finishStream(conv, reply) {
  if (reply) { reply._live = false; reply.tools.forEach((t) => (t.done = true)); }
  state.streaming = null;
  setStatus('');
  updateReplyState();
  setTimeout(maybeReload, 1500);
  if (state.conv === conv) renderMessages();
  // Unread dot on the phone tab / drawer button when the answer lands out of sight.
  if (!claudeIsOpen() && !mqDesktop.matches) $('#claudeDot').classList.remove('hidden');
  loadConversations();
}

// Server copy wins (used when the turn already finished while we were away).
async function reloadConversation(conv) {
  if (!conv.id) return;
  try { const fresh = await api(`/api/conversations/${conv.id}`); Object.assign(conv, fresh); } catch { /* deleted */ }
}

// Coming back to the tab: reconnect at once instead of waiting for the watchdog.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') for (const s of activeStreams) s.reconnect?.();
});
window.addEventListener('online', () => { for (const s of activeStreams) s.reconnect?.(); });

$('#btnStop').onclick = () => { if (state.streaming?.convId) api('/api/stop', { method: 'POST', body: JSON.stringify({ conversation_id: state.streaming.convId }) }); };

// ---------------- routing & boot ----------------
function route() {
  const m = location.hash.match(/^#\/chat\/([\w-]+)(?:\/sub\/([\w-]+))?(?:@(\d+))?/);
  if (!m) return;
  // A chat link (from the list, or a citation in Claude's answer) shows the chat.
  document.body.classList.remove('claude-open');
  if (mqPhone.matches) document.body.dataset.view = 'chat';
  openChat(m[1], m[2] || null, m[3] != null ? Number(m[3]) : null);
}
window.addEventListener('hashchange', route);

// After a deploy, reload into the new version as soon as nothing would be lost.
function checkBuild(build) {
  if (!build) return;
  state.build ||= build;
  if (build === state.build) return;
  state.reloadPending = true;
  maybeReload();
}
function maybeReload() {
  if (!state.reloadPending || state.streaming || (state.pending && !state.pending.done)) return;
  if ($('#prompt').value.trim() || $('#reply').value.trim()) return; // don't eat a half-typed message
  location.reload();
}
setInterval(maybeReload, 5000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') api('/api/status').then((s) => checkBuild(s.build)).catch(() => {});
});

async function pollStatus() {
  try {
    const s = await api('/api/status');
    checkBuild(s.build);
    if (s.pc_name) state.pcName = s.pc_name;
    state.hosted = !!s.hosted;
    if (s.pcs) {
      state.pcs = s.pcs;
      const sel = $('#pcFilter'), cur = sel.value;
      sel.innerHTML = '<option value="">All PCs</option>' + s.pcs.map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('');
      sel.value = cur; sel.classList.toggle('hidden', s.pcs.length < 2);
    }
    if (!$('#model').options.length) {
      $('#model').innerHTML = s.models.map((m) => `<option value="${m.id}">${m.label}</option>`).join('');
      $('#model').value = ls.get('model', 'claude-opus-5-5');
      $('#effort').value = ls.get('effort', 'high');
      $('#fullTools').checked = ls.get('fullTools', true);
      $('#fullTools').addEventListener('change', () => ls.set('fullTools', $('#fullTools').checked));
    }
    if (!s.progress.ready) {
      $('#indexStatus').textContent = `indexing ${s.progress.done}/${s.progress.total}`;
      setTimeout(pollStatus, 700);
      return false;
    }
    $('#indexStatus').textContent = `${s.chats} chats`;
    if (s.hosted) {
      const ago = s.sync ? Math.round((Date.now() - new Date(s.sync.at)) / 1000) : null;
      const stale = ago == null || ago > 180;
      $('#indexStatus').textContent += ago == null ? ' · never synced' : ` · synced ${ago < 90 ? ago + 's' : Math.round(ago / 60) + 'm'} ago`;
      $('#indexStatus').title = s.sync ? `Last sync from ${s.sync.from} at ${new Date(s.sync.at).toLocaleString()}` : 'The sync agent on your PC has not connected yet';
      $('#indexStatus').style.color = stale ? 'var(--err)' : '';
      setTimeout(pollStatus, 15000);
    }
    return true;
  } catch (e) { $('#indexStatus').textContent = 'offline'; setTimeout(pollStatus, 3000); return false; }
}

(async function boot() {
  await pollStatus();
  await Promise.all([loadChats(), loadProjects(), loadConversations()]);
  const total = state.chats.reduce((a, c) => a + c.messages, 0);
  $('#stats').textContent = `${state.chats.length} chats · ${total.toLocaleString()} messages indexed`;
  const saved = ls.get('conv', null);
  if (saved && state.convs.some((c) => c.id === saved)) await openConversation(saved); else renderMessages();
  route();
  // Pick up new chats and live status; quick while the page is in view.
  setInterval(() => { if (document.visibilityState === 'visible') loadChats().catch(() => {}); }, 6000);
})();

// ---------------- Settings: Claude account ----------------
function openSettings() {
  $('#settings').classList.remove('hidden');
  $('#acctMsg').textContent = ''; $('#acctMsg').className = 'acctMsg';
  loadAccount(true);
}
function closeSettings() { $('#settings').classList.add('hidden'); $('#acctToken').value = ''; }
document.querySelectorAll('.openSettings').forEach((b) => (b.onclick = openSettings));
$('#btnCloseSettings').onclick = closeSettings;
$('#settings').addEventListener('click', (e) => { if (e.target.id === 'settings') closeSettings(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#settings').classList.contains('hidden')) closeSettings(); });

async function loadAccount(check) {
  const box = $('#acctStatus');
  box.className = 'acctStatus'; box.textContent = check ? 'Checking the Claude login…' : 'Loading…';
  try {
    const a = await api(`/api/account${check ? '?check=1' : ''}`);
    const where = {
      saved: `Connected with a token saved in ChatLens${a.saved_at ? ` on ${fmtDate(a.saved_at)}` : ''}.`,
      env: 'Using the token from the server configuration (CLAUDE_CODE_OAUTH_TOKEN).',
      local: 'Using Claude Code\'s own login on this computer.',
      none: 'Not connected to a Claude account yet.',
    }[a.source] || a.source;
    let health = '';
    if (a.check) health = a.check.ok ? ' ✓ Working.' : ` ✗ Not working: ${a.check.error}`;
    box.textContent = where + health;
    box.classList.toggle('ok', !!a.check?.ok);
    box.classList.toggle('bad', a.source === 'none' || (a.check && !a.check.ok));
    $('#acctRemove').classList.toggle('hidden', a.source !== 'saved');
    $('#acctSave').textContent = a.source === 'saved' ? 'Replace and test' : 'Save and test';
  } catch (e) { box.textContent = `Could not read the account status: ${e.message}`; box.classList.add('bad'); }
}

$('#acctForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const token = $('#acctToken').value.replace(/\s/g, '');
  const msg = $('#acctMsg');
  if (!token) { msg.textContent = 'Paste the token first.'; msg.className = 'acctMsg bad'; return; }
  $('#acctSave').disabled = true; msg.className = 'acctMsg'; msg.textContent = 'Testing the token with Claude…';
  try {
    const r = await fetch('/api/account', { method: 'POST', headers: { 'X-ChatLens': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.statusText);
    $('#acctToken').value = '';
    msg.textContent = 'Saved. ChatLens now uses this Claude account.'; msg.className = 'acctMsg ok';
    loadAccount(false);
  } catch (err) { msg.textContent = err.message; msg.className = 'acctMsg bad'; }
  finally { $('#acctSave').disabled = false; }
});

$('#acctRemove').onclick = async () => {
  if (!confirm('Remove the saved Claude token from ChatLens? It falls back to the server configuration, if any.')) return;
  await api('/api/account', { method: 'DELETE' });
  $('#acctMsg').textContent = 'Removed.'; $('#acctMsg').className = 'acctMsg';
  loadAccount(true);
};

// A reply that failed for lack of a login gets a shortcut to Settings.
$('#messages').addEventListener('click', (e) => { if (e.target.closest('[data-open-settings]')) openSettings(); });

// ---------------- Settings: PCs (hosted) ----------------
let pcPoll = null, pcKnown = null;
async function loadPcs() {
  if (!state.hosted) { $('#pcsSection').classList.add('hidden'); return; }
  $('#pcsSection').classList.remove('hidden');
  let r;
  try { r = await api('/api/pcs'); } catch (e) { $('#pcList').textContent = e.message; return; }
  const ago = (t) => { if (!t) return 'never synced'; const s = Math.round((Date.now() - new Date(t)) / 1000); return s < 90 ? `synced ${s}s ago` : s < 5400 ? `synced ${Math.round(s / 60)}m ago` : `last synced ${fmtDate(t)}`; };
  $('#pcList').innerHTML = r.pcs.map((x) => `
    <div class="pcRow">
      <i class="dot ${x.online ? 'on' : ''}" title="${x.online ? 'Online' : 'Offline'}"></i>
      <div class="pcInfo"><div class="pcName">${esc(x.name)}</div>
        <div class="pcMeta">${x.kind === 'ssh' ? 'SSH link' : 'Paired'} · ${x.chats} chats${x.live ? ` · ${x.live} open` : ''} · ${ago(x.lastSync)}</div></div>
      ${x.kind === 'paired' ? `<button type="button" data-remove-pc="${esc(x.id)}" data-name="${esc(x.name)}">Remove</button>` : ''}
    </div>`).join('') || '<div class="muted small">No PCs attached yet.</div>';
  // While a pairing is open, say when the new PC shows up.
  if (pcKnown) {
    const fresh = r.pcs.find((x) => !pcKnown.has(x.id));
    if (fresh) {
      $('#pcPairNote').innerHTML = `<b>✓ ${esc(fresh.name)} is connected.</b> Its chats appear in the list as they sync.`;
      pcKnown = null; clearInterval(pcPoll); pcPoll = null;
      loadChats().catch(() => {});
    }
  }
}
$('#pcList').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-remove-pc]');
  if (!b) return;
  if (!confirm(`Remove ${b.dataset.name} from ChatLens?\n\nIts synced chats are deleted from this server and its access key stops working. To uninstall the agent on that PC, delete the "ChatLens Agent" Startup shortcut and %LOCALAPPDATA%\ChatLens\agent.`)) return;
  await api(`/api/pcs/${b.dataset.removePc}`, { method: 'DELETE' });
  loadPcs(); loadChats().catch(() => {});
});
$('#pcAdd').onclick = async () => {
  const r = await api('/api/pcs/pair', { method: 'POST' });
  $('#pcCmd').textContent = r.command;
  $('#pcPair').classList.remove('hidden');
  $('#pcPairNote').textContent = `This code works once and expires at ${new Date(r.expires).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}. Keep this open: the new PC appears above when it connects.`;
  const now = await api('/api/pcs');
  pcKnown = new Set(now.pcs.map((x) => x.id));
  clearInterval(pcPoll); pcPoll = setInterval(() => { if ($('#settings').classList.contains('hidden')) { clearInterval(pcPoll); pcPoll = null; } else loadPcs(); }, 3000);
};
$('#pcCopy').onclick = async () => {
  try { await navigator.clipboard.writeText($('#pcCmd').textContent); $('#pcCopy').textContent = 'Copied'; }
  catch { const r = document.createRange(); r.selectNodeContents($('#pcCmd')); getSelection().removeAllRanges(); getSelection().addRange(r); $('#pcCopy').textContent = 'Selected'; }
  setTimeout(() => ($('#pcCopy').textContent = 'Copy'), 1500);
};
document.querySelectorAll('.openSettings').forEach((b) => b.addEventListener('click', () => { $('#pcPair').classList.add('hidden'); loadPcs(); }));

// ---------------- Claude's questions and next-step buttons ----------------
// AskUserQuestion and the desktop app's next-step box (wrap_up) are drawn as
// cards. Answering one continues the chat on the PC *as you*, because these are
// decisions (a relayed message can't approve anything).
const APP_ACTION_TEXT = {
  commit: 'Commit the changes.', create_pr: 'Create a pull request.', merge: 'Merge it.', verify: 'Verify it.',
  fix_ci: 'Fix the failing CI.', address_comments: 'Address the review comments.', resolve_conflicts: 'Resolve the merge conflicts.',
  archive: 'Archive this session.', new_session: 'Start a new session for this.',
};
const decided = new Set(); // tool ids answered from this page

function answersFrom(text) {
  const out = {};
  const re = /"((?:[^"\\]|\\.)*)"="((?:[^"\\]|\\.)*)"/g;
  let m; while ((m = re.exec(text || ''))) out[m[1]] = m[2];
  return out;
}

function decisionHTML(e, t, where = 'inline') {
  const q = t.q;
  if (!q || !state.chat) return '';
  const later = state.chat.entries.slice(e.i + 1);
  const userSince = later.some((x) => x.role === 'user' && !x.meta);
  const canAct = !state.chat.subagent && !decided.has(t.id) && !(state.pending && !state.pending.done);
  if (t.name === 'AskUserQuestion') {
    const res = later.find((x) => x.role === 'tool' && x.toolUseId === t.id);
    let answers = res ? answersFrom(res.text) : null;
    // Answered from ChatLens: the answer is the next message, in our own wording.
    if (!res) {
      const next = later.find((x) => x.role === 'user' && !x.meta);
      const m1 = next && /^My answer to your question "([\s\S]*?)": ([\s\S]*)$/.exec(next.text || '');
      if (m1) answers = { [m1[1]]: m1[2].trim() };
      else if (next && /^My answers to your questions:/.test(next.text || '')) {
        answers = {};
        for (const line of next.text.split('\n')) { const m2 = /^- ([\s\S]*?) → ([\s\S]*)$/.exec(line); if (m2) answers[m2[1]] = m2[2].trim(); }
      }
    }
    const open = !res && !userSince && canAct;
    if (open !== (where === 'dock')) return '';
    const qs = (q.questions || []).map((qq, qi) => {
      const chosen = answers?.[qq.question];
      const opts = (qq.options || []).map((o) => `
        <button type="button" class="decOpt ${chosen === o.label ? 'chosen' : ''}" ${open ? '' : 'disabled'} data-q="${qi}" data-label="${esc(o.label)}">
          <span class="lbl">${esc(o.label)}</span>${o.description ? `<span class="desc">${esc(o.description)}</span>` : ''}</button>`).join('');
      const other = open ? `<input type="text" class="decOther" data-q="${qi}" placeholder="Other answer…">` : '';
      const picked = chosen && !(qq.options || []).some((o) => o.label === chosen) ? `<div class="decAnswered">Answered: ${esc(chosen)}</div>` : '';
      return `<div class="decQ" data-q="${qi}" data-multi="${qq.multiSelect ? 1 : 0}">
        <div class="decHead">${qq.header ? `<span class="decTag">${esc(qq.header)}</span>` : ''}${esc(qq.question)}</div>
        <div class="decOpts">${opts}</div>${other}${picked}</div>`;
    }).join('');
    const single = (q.questions || []).length === 1 && !q.questions[0].multiSelect;
    const status = res ? 'Answered' : (userSince || decided.has(t.id) ? 'Answered' : 'Waiting for your answer');
    return `<div class="decCard ${open ? 'open' : ''}" data-dec-entry="${e.i}" data-dec-tool="${esc(t.id)}" data-kind="ask">
      <div class="decTitle">Claude asked · <span class="muted">${status}</span></div>${qs}
      ${open && !single ? '<button type="button" class="primary decSend">Send answers</button>' : ''}
      ${open ? '<div class="decNote">Sent as you, so it counts as your decision.</div>' : ''}</div>`;
  }
  if (t.name === 'mcp__ccd_turn__wrap_up') {
    const acts = q.actions || [];
    if (!q.recap && !q.ask && !acts.length) return '';
    const open = !userSince && canAct && !!(q.ask || acts.length);
    if (open !== (where === 'dock')) return '';
    const btns = acts.map((a, k) => {
      const label = a.label || (a.action ? a.action.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) : 'OK');
      return `<button type="button" class="${k === 0 ? 'primary ' : ''}decAct" ${open ? '' : 'disabled'} data-text="${esc(a.label || APP_ACTION_TEXT[a.action] || label)}">${esc(label)}</button>`;
    }).join('');
    return `<div class="decCard next ${open ? 'open' : ''}" data-dec-entry="${e.i}" data-dec-tool="${esc(t.id)}" data-kind="next">
      ${q.recap ? `<div class="decRecap">${esc(q.recap)}</div>` : ''}
      ${q.ask ? `<div class="decAsk">${esc(q.ask)}</div>` : ''}
      ${btns ? `<div class="decActs">${btns}</div>` : ''}
      ${open ? '<div class="decNote">Your choice is sent as you.</div>' : ''}</div>`;
  }
  return '';
}

// The newest unanswered question / next-step box, shown after the last message.
function updateDock() {
  const t = $('#transcript');
  t.querySelector('#decDock')?.remove();
  const ents = state.chat?.entries || [];
  if (!state.chat || state.rendered < ents.length) return; // only once the end is on screen
  let html = '';
  for (let k = ents.length - 1; k >= Math.max(0, ents.length - 80) && !html; k--) {
    const e = ents[k];
    if (e.role === 'user' && !e.meta) break; // you've replied since: nothing is waiting
    for (const tool of e.tools || []) if (tool.q && (html = decisionHTML(e, tool, 'dock'))) break;
  }
  if (!html) return;
  const dock = document.createElement('div');
  dock.id = 'decDock'; dock.className = 'entry assistant';
  dock.innerHTML = html;
  const pend = t.querySelector('#pendingTurn');
  if (pend) t.insertBefore(dock, pend); else t.appendChild(dock);
}

function redrawEntry(i) {
  const el = document.getElementById('e' + i);
  const e = state.chat?.entries[i];
  if (el && e) el.replaceWith(buildEntry(e)); // rebuild: an answered card shows here again
}
// After the chat moves on, earlier cards close.
function refreshDecisionCards() {
  document.querySelectorAll('#transcript .entry:not(#decDock) [data-dec-entry]').forEach((c) => redrawEntry(Number(c.dataset.decEntry)));
  updateDock();
}

function sendDecision(card, text) {
  decided.add(card.dataset.decTool);
  const kind = card.dataset.kind;
  redrawEntry(Number(card.dataset.decEntry));
  updateDock();
  continueInline(state.chat.session_id, text, { asMe: true, answering: kind === 'ask', noFiles: true });
}

$('#transcript').addEventListener('click', (ev) => {
  const card = ev.target.closest('.decCard.open');
  if (!card) return;
  const act = ev.target.closest('.decAct');
  if (act) return sendDecision(card, act.dataset.text);
  const opt = ev.target.closest('.decOpt');
  if (opt) {
    const qEl = opt.closest('.decQ');
    if (qEl.dataset.multi !== '1') qEl.querySelectorAll('.decOpt').forEach((b) => { if (b !== opt) b.classList.remove('chosen'); });
    opt.classList.toggle('chosen');
    // One single-choice question: answer right away.
    if (card.querySelectorAll('.decQ').length === 1 && qEl.dataset.multi !== '1') submitAnswers(card);
    return;
  }
  if (ev.target.closest('.decSend')) submitAnswers(card);
});
$('#transcript').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && ev.target.matches('.decOther')) { ev.preventDefault(); submitAnswers(ev.target.closest('.decCard')); }
});

function submitAnswers(card) {
  const e = state.chat.entries[Number(card.dataset.decEntry)];
  const t = e.tools.find((x) => x.id === card.dataset.decTool);
  const qs = t.q.questions || [];
  const lines = [];
  qs.forEach((qq, qi) => {
    const qEl = card.querySelector(`.decQ[data-q="${qi}"]`);
    const picks = [...qEl.querySelectorAll('.decOpt.chosen')].map((b) => b.dataset.label);
    const other = qEl.querySelector('.decOther')?.value.trim();
    if (other) picks.push(other);
    if (picks.length) lines.push({ q: qq.question, a: picks.join(', ') });
  });
  if (!lines.length) return;
  const text = qs.length === 1
    ? `My answer to your question "${lines[0].q}": ${lines[0].a}`
    : 'My answers to your questions:\n' + lines.map((l) => `- ${l.q} → ${l.a}`).join('\n');
  sendDecision(card, text);
}

// ---------------- attachments ----------------
// Each file uploads as soon as it's picked, pasted or dropped; a message then
// sends just the ids. target: 'reply' (under a chat) or 'prompt' (assistant).
const attach = { reply: [], prompt: [] };
const fmtSize = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const readyFiles = (t) => attach[t].filter((f) => f.id);
const uploading = (t) => attach[t].some((f) => !f.id && !f.error);
function takeFiles(t) { const ready = readyFiles(t); attach[t] = []; renderFiles(t); return ready.map(({ id, name, type, size }) => ({ id, name, type, size })); }
function filesLine(files) { return files?.length ? `<div class="msgFiles">${files.map((f) => `<span>📎 ${esc(f.name)}</span>`).join('')}</div>` : ''; }

function renderFiles(t) {
  const box = $(t === 'reply' ? '#replyFiles' : '#promptFiles');
  box.innerHTML = attach[t].map((f, i) => `
    <div class="fileChip ${f.error ? 'error' : f.id ? '' : 'uploading'}" title="${esc(f.error || f.name)}">
      ${f.url ? `<img src="${f.url}" alt="">` : `<span class="ficon">${esc((f.name.split('.').pop() || 'FILE').slice(0, 4).toUpperCase())}</span>`}
      <span class="fmeta"><span class="fname">${esc(f.name)}</span><span class="fsize">${f.error ? 'failed' : f.id ? fmtSize(f.size) : 'uploading…'}</span></span>
      <button type="button" class="fx" data-t="${t}" data-i="${i}" aria-label="Remove ${esc(f.name)}"><svg><use href="#i-close"/></svg></button>
    </div>`).join('');
}
document.addEventListener('click', (e) => {
  const x = e.target.closest('.fileChip .fx');
  if (x) { const f = attach[x.dataset.t].splice(Number(x.dataset.i), 1)[0]; if (f?.url) URL.revokeObjectURL(f.url); renderFiles(x.dataset.t); }
});

async function addFiles(t, list) {
  for (const file of [...list].slice(0, 10)) {
    const name = file.name && file.name !== 'image.png' ? file.name : `pasted-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.${(file.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`;
    const f = { name, size: file.size, type: file.type, url: file.type.startsWith('image/') ? URL.createObjectURL(file) : null };
    attach[t].push(f); renderFiles(t);
    try {
      if (file.size > 25 * 1024 * 1024) throw new Error('Files can be up to 25 MB.');
      const r = await fetch(`/api/uploads?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'X-ChatLens': '1', 'Content-Type': file.type || 'application/octet-stream' }, body: file });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || r.statusText);
      Object.assign(f, { id: j.id, size: j.size, name: j.name });
    } catch (err) { f.error = err.message; }
    renderFiles(t);
  }
}

let pickTarget = 'reply';
document.querySelectorAll('.attachBtn').forEach((b) => (b.onclick = () => { pickTarget = b.dataset.target; $('#filePicker').click(); }));
$('#filePicker').addEventListener('change', (e) => { addFiles(pickTarget, e.target.files); e.target.value = ''; });
// paste images/files straight into either box
for (const [sel, t] of [['#reply', 'reply'], ['#prompt', 'prompt']]) {
  $(sel).addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); addFiles(t, files); }
  });
}
// drag and drop: onto the assistant panel -> assistant; anywhere else -> the open chat's reply box
let dragDepth = 0;
const dropTarget = (el) => (el?.closest?.('#claude') ? 'prompt' : (state.chat ? 'reply' : 'prompt'));
document.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types?.includes('Files')) { dragDepth++; $('#dropHint').classList.remove('hidden'); } });
document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#dropHint').classList.add('hidden'); } });
document.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
document.addEventListener('drop', (e) => {
  if (!e.dataTransfer?.files?.length) return;
  e.preventDefault(); dragDepth = 0; $('#dropHint').classList.add('hidden');
  const t = dropTarget(e.target);
  if (t === 'prompt') openClaude();
  addFiles(t, e.dataTransfer.files);
});
