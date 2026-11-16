#!/usr/bin/env python3
"""ChatLens sync receiver. Runs on the server, started over SSH by the sync agent
on the PC (sync/chatlens-sync.mjs), and mirrors Claude transcripts into ROOT.

Protocol on stdin/stdout: each request is one JSON line, optionally followed by
exactly `len` raw bytes; each request gets one JSON line back.

  {"op":"hello"}                               -> {"ok":true,"files":{rel:size}}
  {"op":"append","path":p,"offset":n,"len":k}  + k bytes  (only if size == offset)
  {"op":"put","path":p,"len":k}                + k bytes  (atomic replace)
  {"op":"delete","path":p}
  {"op":"stamp","data":{...}}                  -> writes ROOT/last-sync.json
  {"op":"jobs"}                                -> {"ok":true,"jobs":[...],"stops":[ids]}
  {"op":"event","job":id,"len":k}              + k bytes appended to BRIDGE/events/<id>.jsonl

Paths are relative to ROOT and confined to it. BRIDGE (argv[2]) is where the
ChatLens container drops "continue this chat on the PC" jobs.
"""
import json
import os
import re
import sys

ROOT = os.path.realpath(sys.argv[1] if len(sys.argv) > 1 else "/opt/chatlens/sync")
BRIDGE = os.path.realpath(sys.argv[2] if len(sys.argv) > 2 else "/opt/chatlens/bridge")
SAFE = re.compile(r"^[A-Za-z0-9._ \-/]+$")
JOB_ID = re.compile(r"^[A-Za-z0-9\-]{8,64}$")
inp = sys.stdin.buffer
out = sys.stdout


def reply(obj):
    out.write(json.dumps(obj) + "\n")
    out.flush()


def resolve(rel):
    if not rel or not SAFE.match(rel) or rel.startswith("/") or ".." in rel.split("/"):
        raise ValueError("bad path: %r" % rel)
    full = os.path.realpath(os.path.join(ROOT, rel))
    if not full.startswith(ROOT + os.sep):
        raise ValueError("path escapes root: %r" % rel)
    return full


def read_exact(n):
    chunks, left = [], n
    while left:
        b = inp.read(left)
        if not b:
            raise EOFError("stream closed mid-payload")
        chunks.append(b)
        left -= len(b)
    return b"".join(chunks)


def manifest():
    files = {}
    for dirpath, _dirs, names in os.walk(ROOT):
        for n in names:
            if n.endswith(".chatlens-tmp"):
                continue
            full = os.path.join(dirpath, n)
            files[os.path.relpath(full, ROOT).replace(os.sep, "/")] = os.path.getsize(full)
    return files


def main():
    os.makedirs(ROOT, exist_ok=True)
    while True:
        line = inp.readline()
        if not line:
            return
        req = json.loads(line)
        op = req.get("op")
        payload = read_exact(req["len"]) if req.get("len") else b""
        try:
            if op == "hello":
                reply({"ok": True, "files": manifest()})
            elif op == "append":
                full = resolve(req["path"])
                size = os.path.getsize(full) if os.path.exists(full) else 0
                if size != req["offset"]:
                    reply({"ok": False, "path": req["path"], "size": size, "error": "offset mismatch"})
                    continue
                os.makedirs(os.path.dirname(full), exist_ok=True)
                with open(full, "ab") as f:
                    f.write(payload)
                reply({"ok": True, "path": req["path"], "size": size + len(payload)})
            elif op == "put":
                full = resolve(req["path"])
                os.makedirs(os.path.dirname(full), exist_ok=True)
                tmp = full + ".chatlens-tmp"
                with open(tmp, "wb") as f:
                    f.write(payload)
                os.replace(tmp, full)
                reply({"ok": True, "path": req["path"], "size": len(payload)})
            elif op == "delete":
                full = resolve(req["path"])
                if os.path.exists(full):
                    os.remove(full)
                reply({"ok": True, "path": req["path"]})
            elif op == "stamp":
                target = os.path.join(ROOT, "last-sync.json")
                with open(target + ".tmp", "w") as f:
                    json.dump(req.get("data", {}), f)
                os.replace(target + ".tmp", target)
                reply({"ok": True})
            elif op == "jobs":
                jobs_dir = os.path.join(BRIDGE, "jobs")
                os.makedirs(jobs_dir, exist_ok=True)
                jobs, stops = [], []
                for n in sorted(os.listdir(jobs_dir)):
                    p = os.path.join(jobs_dir, n)
                    if n.endswith(".json") and JOB_ID.match(n[:-5]):
                        try:
                            with open(p) as f:
                                jobs.append(json.load(f))
                            os.replace(p, p[:-5] + ".taken")  # hand each job out once
                        except (OSError, ValueError):
                            pass
                    elif n.endswith(".stop") and JOB_ID.match(n[:-5]):
                        stops.append(n[:-5])
                        os.remove(p)
                reply({"ok": True, "jobs": jobs, "stops": stops})
            elif op == "event":
                if not JOB_ID.match(str(req.get("job", ""))):
                    raise ValueError("bad job id")
                ev_dir = os.path.join(BRIDGE, "events")
                os.makedirs(ev_dir, exist_ok=True)
                with open(os.path.join(ev_dir, req["job"] + ".jsonl"), "ab") as f:
                    f.write(payload)
                reply({"ok": True})
            else:
                reply({"ok": False, "error": "unknown op %r" % op})
        except Exception as e:  # report and keep serving
            reply({"ok": False, "path": req.get("path"), "error": str(e)})


if __name__ == "__main__":
    main()
