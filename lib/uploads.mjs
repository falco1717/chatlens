// Files attached in ChatLens (images, documents, logs...). The browser uploads
// each file once; a message then refers to them by id, and they are put where
// the Claude that handles the message can open them with its Read tool.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const MAX_FILE = 25 * 1024 * 1024;   // per file
export const MAX_JOB = 30 * 1024 * 1024;    // per message sent to the PC

export function safeName(name) {
  const base = path.basename(String(name || 'file')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^\.+/, '_').slice(0, 120);
  return base || 'file';
}

export class Uploads {
  constructor(dir) { this.dir = dir; fs.mkdirSync(dir, { recursive: true }); }

  async save(name, type, data) {
    const id = crypto.randomBytes(9).toString('hex');
    const d = path.join(this.dir, id);
    await fsp.mkdir(d, { recursive: true });
    const file = path.join(d, safeName(name));
    await fsp.writeFile(file, data);
    const meta = { id, name: safeName(name), type: String(type || 'application/octet-stream').slice(0, 100), size: data.length, at: new Date().toISOString() };
    await fsp.writeFile(path.join(d, 'meta.json'), JSON.stringify(meta));
    return meta;
  }

  /** ids -> [{ id, name, type, size, file }] (unknown ids are skipped) */
  async resolve(ids) {
    const out = [];
    for (const id of (Array.isArray(ids) ? ids : []).slice(0, 10)) {
      if (!/^[a-f0-9]{18}$/.test(String(id))) continue;
      try {
        const meta = JSON.parse(await fsp.readFile(path.join(this.dir, id, 'meta.json'), 'utf8'));
        out.push({ ...meta, file: path.join(this.dir, id, meta.name) });
      } catch { /* expired or never uploaded */ }
    }
    return out;
  }

  async clean(maxAgeMs = 7 * 24 * 3600e3) {
    for (const id of await fsp.readdir(this.dir).catch(() => [])) {
      const d = path.join(this.dir, id);
      try { if (Date.now() - (await fsp.stat(d)).mtimeMs > maxAgeMs) await fsp.rm(d, { recursive: true, force: true }); } catch { /* */ }
    }
  }
}

const kb = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** The line added to a message so Claude knows where the files are. */
export function attachmentNote(files) {
  if (!files.length) return '';
  return `\n\n[Attached files — open them with the Read tool]\n` + files.map((f) => `- ${f.path} (${f.type || 'file'}, ${kb(f.size)})`).join('\n');
}
