// Relay a message from ChatLens into a chat that is open in the Claude desktop
// app, through Claude Code's own session-to-session messaging (SendMessage).
// The desktop app shows it live in that chat's window and its own Claude
// answers there; ChatLens then follows the chat's transcript.
//
// The sender is a throwaway `claude -p` that may only use SendMessage. It runs
// at the same permission level as the desktop chats (bypass), because messages
// between sessions of different levels are held for approval.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The desktop app does not draw relayed messages in the chat, so Claude opens
// its reply with the user's words (ChatLens hides that copy on its side).
export const ECHO_LABEL = '**You (via ChatLens):**';
export const RELAY_PREFIX = `[From ChatLens: the user typed this on their phone. Start your reply by quoting it exactly, as "> ${ECHO_LABEL} " plus their message (every line prefixed "> "), then a blank line, then answer here in this chat. Don't use SendMessage.]`;

/**
 * entry: the target's ~/.claude/sessions record ({hostSessionId, name, ...}).
 * Resolves { ok, detail, to, exact }.
 */
// The sender model occasionally answers instead of calling the tool: try twice.
export async function relayToDesktop(opts) {
  const first = await relayOnce(opts);
  if (first.ok || !first.notSent) return first;
  return relayOnce(opts);
}

function relayOnce({ entry, text, claudeExe, others = [] }) {
  const exe = claudeExe || path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
  const cwd = path.join(os.tmpdir(), 'chatlens-relay');
  fs.mkdirSync(cwd, { recursive: true });
  // SendMessage addresses open sessions by their name.
  const to = entry.name;
  if (!to) return Promise.resolve({ ok: false, detail: 'That chat has no name in the desktop app yet, so it cannot be addressed.' });
  if (others.some((o) => o.sessionId !== entry.sessionId && o.name === to)) {
    return Promise.resolve({ ok: false, detail: `Two open chats are both named “${to}”, so the message could not be addressed safely. Rename one in the desktop app.` });
  }
  const message = `${RELAY_PREFIX}\n\n${text}`;
  const prompt = `Call the SendMessage tool exactly once, with "to" set to ${JSON.stringify(to)} and "message" set to the exact text between the lines <<<MSG and MSG>>> (not including those lines). Send it unchanged, add nothing, then stop.\n<<<MSG\n${message}\nMSG>>>`;
  const args = ['-p', '--model', 'claude-haiku-5-5', '--effort', 'low', '-n', 'ChatLens',
    '--tools', 'SendMessage', '--permission-mode', 'bypassPermissions', '--dangerously-skip-permissions',
    '--strict-mcp-config', '--setting-sources', '', '--no-session-persistence',
    '--output-format', 'stream-json', '--verbose'];
  return new Promise((resolve) => {
    const proc = spawn(fs.existsSync(exe) ? exe : 'claude', args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    proc.stdin.end(prompt);
    let buf = '', stderr = '', input = null, result = null, said = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let o; try { o = JSON.parse(line); } catch { continue; }
        if (o.type === 'result' && typeof o.result === 'string') said = o.result;
        for (const b of o.message?.content || []) {
          if (o.type === 'assistant' && b.type === 'tool_use' && b.name === 'SendMessage' && !input) input = b.input;
          if (o.type === 'user' && b.type === 'tool_result' && !result) {
            const t = typeof b.content === 'string' ? b.content : (b.content || []).map((c) => c.text || '').join('');
            try { result = JSON.parse(t); } catch { result = { success: !b.is_error, message: t }; }
          }
        }
      }
    });
    proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    proc.on('error', (e) => resolve({ ok: false, detail: `could not start Claude: ${e.message}` }));
    proc.on('close', (code) => {
      if (!result) return resolve({ ok: false, notSent: true, detail: `relay did not send (exit ${code}): ${(said || stderr).trim().slice(0, 300)}` });
      resolve({ ok: !!result.success, detail: result.message || result.error || '', to: input?.to, exact: input?.message === message });
    });
  });
}
