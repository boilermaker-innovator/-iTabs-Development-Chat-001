#!/usr/bin/env python3
"""Read-only backup of every Val Town val owned by the token's user.

Only GET requests and SELECT statements are sent: nothing on Val Town is
changed or deleted.

Usage:
    VALTOWN_TOKEN=... python3 -I backup.py OUTPUT_DIR

Writes, inside OUTPUT_DIR:
    vals/<val-name>/...         every file of every val, original paths kept
    vals/<val-name>/_val.json   val metadata (id, privacy, links, file types)
    sqlite/                     schema.sql + one JSON file per table
    blobs/                      every blob, plus _index.json
    README.md                   val list with live URLs, type and iTabs flag
    manifest.json               machine-readable summary
"""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

API = "https://api.val.town"
TOKEN = os.environ.get("VALTOWN_TOKEN", "proxy-injected")  # proxy may inject the real one

ITABS_PATTERNS = [
    r"itabs", r"demo\.itabs\.co", r"\bmenu", r"caf[eé]", r"coffee", r"\border",
    r"\bcart\b", r"checkout", r"queue", r"flip[-_ ]?card", r"tradie", r"espresso",
    r"latte", r"food ?hall", r"stall", r"widget",
]


PAUSE = float(os.environ.get("VALTOWN_PAUSE", "0.7"))  # seconds between calls; Val Town rate-limits


def request(method, path, body=None, raw=False, tries=8):
    url = path if path.startswith("http") else API + path
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Authorization": f"Bearer {TOKEN}", "User-Agent": "valtown-backup"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    for attempt in range(tries):
        req = urllib.request.Request(url, data=data, method=method, headers=headers)
        time.sleep(PAUSE)
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                content = r.read()
                return content if raw else json.loads(content or b"null")
        except urllib.error.HTTPError as e:
            if e.code == 429 or e.code >= 500:
                wait = e.headers.get("Retry-After")
                wait = int(wait) if wait and wait.isdigit() else min(15 * (attempt + 1), 90)
                print(f"    HTTP {e.code}, waiting {wait}s", flush=True)
                time.sleep(wait)
                continue
            raise
        except urllib.error.URLError:
            time.sleep(2 ** (attempt + 1))
    raise RuntimeError(f"giving up on {method} {url}")


def get(path, **kw):
    return request("GET", path, **kw)


def paginate(path, params=None):
    params = dict(params or {}, limit=100, offset=0)
    url = f"{path}?{urllib.parse.urlencode(params)}"
    while url:
        page = get(url)
        if isinstance(page, list):  # some v1 endpoints return a bare list
            yield from page
            return
        yield from page.get("data", [])
        url = (page.get("links") or {}).get("next")


def safe(name):
    return re.sub(r"[^A-Za-z0-9._-]+", "_", name).strip("._") or "unnamed"


def safe_relpath(p):
    parts = [safe(x) if x in ("", ".", "..") else x.replace("\x00", "") for x in p.split("/") if x]
    return os.path.join(*[x if x not in (".", "..") else "_" for x in parts]) if parts else "unnamed"


def write(path, content):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb" if isinstance(content, bytes) else "w") as f:
        f.write(content)


def backup_vals(out, me, log):
    vals = []
    try:
        listing = list(paginate("/v2/me/vals"))
    except urllib.error.HTTPError:
        listing = list(paginate(f"/v1/users/{me['id']}/vals"))
    log(f"found {len(listing)} vals")
    used = set()
    for v in listing:
        name = v.get("name") or v.get("id")
        folder = safe(name)
        while folder in used:
            folder += "_" + v["id"][:6]
        used.add(folder)
        vdir = os.path.join(out, "vals", folder)
        files, texts, errors = [], [], []
        try:
            entries = list(paginate(f"/v2/vals/{v['id']}/files", {"path": "", "recursive": "true"}))
        except urllib.error.HTTPError as e:
            entries, errors = [], [f"file listing failed: HTTP {e.code}"]
        for f in entries:
            ftype = f.get("type")
            entry = {"path": f.get("path"), "type": ftype, "links": f.get("links", {})}
            files.append(entry)
            if ftype == "directory":
                os.makedirs(os.path.join(vdir, safe_relpath(f["path"])), exist_ok=True)
                continue
            local = os.path.join(vdir, safe_relpath(f["path"]))
            try:
                if os.path.exists(local):  # resume: already downloaded on an earlier run
                    with open(local, "rb") as fh:
                        content = fh.read()
                else:
                    content = get(f"/v2/vals/{v['id']}/files/content?"
                                  + urllib.parse.urlencode({"path": f["path"]}), raw=True)
                    write(local, content)
                try:
                    texts.append(content.decode())
                except UnicodeDecodeError:
                    pass
            except (urllib.error.HTTPError, RuntimeError) as e:
                errors.append(f"{f['path']}: {e}")
        types = sorted({f["type"] for f in files if f["type"] not in ("directory", "file")})
        endpoints = [f["links"]["endpoint"] for f in files if f["links"].get("endpoint")]
        haystack = " ".join([name, v.get("description") or ""] + texts + endpoints).lower()
        hits = sorted({p for p in ITABS_PATTERNS if re.search(p, haystack)})
        record = {
            "id": v["id"], "name": name, "folder": folder,
            "privacy": v.get("privacy"), "description": v.get("description"),
            "html_url": (v.get("links") or {}).get("html"),
            "endpoints": endpoints, "types": types,
            "itabs_signals": hits, "file_count": len([f for f in files if f["type"] != "directory"]),
            "errors": errors, "files": files,
            "created_at": v.get("createdAt"), "updated_at": v.get("updatedAt") or v.get("modifiedAt"),
        }
        write(os.path.join(vdir, "_val.json"), json.dumps(record, indent=2))
        vals.append(record)
        log(f"  {name}: {record['file_count']} files {types} {'ERR' if errors else ''}")
    return vals


def backup_sqlite(out, log):
    sdir = os.path.join(out, "sqlite")
    res = request("POST", "/v1/sqlite/execute", {
        "statement": "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL"})
    cols, rows = res["columns"], res["rows"]
    objs = [dict(zip(cols, r)) for r in rows]
    write(os.path.join(sdir, "schema.sql"), ";\n\n".join(o["sql"] for o in objs) + ";\n")
    tables = []
    for o in objs:
        if o["type"] != "table" or o["name"].startswith(("sqlite_", "_litestream", "libsql_")):
            continue
        q = '"' + o["name"].replace('"', '""') + '"'
        data = request("POST", "/v1/sqlite/execute", {"statement": f"SELECT * FROM {q}"})
        write(os.path.join(sdir, safe(o["name"]) + ".json"),
              json.dumps({"columns": data["columns"], "rows": data["rows"]}, indent=1, default=str))
        tables.append({"name": o["name"], "rows": len(data["rows"])})
        log(f"  table {o['name']}: {len(data['rows'])} rows")
    return tables


def backup_blobs(out, log):
    bdir = os.path.join(out, "blobs")
    items = get("/v1/blob")
    index = []
    for b in items:
        key = b["key"]
        local = safe_relpath(key)
        path = os.path.join(bdir, local)
        if not os.path.exists(path):
            write(path, get("/v1/blob/" + urllib.parse.quote(key, safe=""), raw=True))
        index.append({"key": key, "file": local, "size": b.get("size"),
                      "last_modified": b.get("lastModified")})
    write(os.path.join(bdir, "_index.json"), json.dumps(index, indent=2))
    log(f"  {len(index)} blobs")
    return index


def kind(v):
    t = set(v["types"])
    labels = [l for k, l in (("http", "HTTP endpoint"), ("interval", "Cron job"),
                             ("email", "Email handler"), ("script", "Script")) if k in t]
    return ", ".join(labels) or "Library / files only"


def readme(me, vals, tables, blobs, warnings):
    itabs = [v for v in vals if v["itabs_signals"]]
    lines = [
        f"# Val Town backup — {me.get('username')}",
        "",
        f"Taken {time.strftime('%Y-%m-%d %H:%M UTC', time.gmtime())}, read-only, before Val Town "
        "goes read-only on 10 Dec 2026.",
        "",
        f"- **{len(vals)} vals**, {sum(v['file_count'] for v in vals)} files",
        f"- **{len(tables)} SQLite tables** in `sqlite/` (schema in `sqlite/schema.sql`)",
        f"- **{len(blobs)} blobs** in `blobs/` (index in `blobs/_index.json`)",
        "",
        "Not included (the API doesn't return them): environment variable *values*. "
        "Note those down from each val's settings before 10 Dec.",
        "",
        "## Move first: looks like a live iTabs site",
        "",
        "| Val | Live URL | Type | Why flagged |",
        "|---|---|---|---|",
    ]
    for v in sorted(itabs, key=lambda v: (-len(v["itabs_signals"]), v["name"].lower())):
        url = "<br>".join(v["endpoints"]) or "—"
        why = ", ".join(s.replace("\\b", "").replace("\\", "") for s in v["itabs_signals"])
        lines.append(f"| [{v['name']}](vals/{v['folder']}) | {url} | {kind(v)} | {why} |")
    if not itabs:
        lines.append("| — | — | — | none matched |")
    lines += ["", "## All vals", "", "| | Val | Live URL | Type | Privacy | Files |", "|---|---|---|---|---|---|"]
    for v in sorted(vals, key=lambda v: v["name"].lower()):
        url = "<br>".join(v["endpoints"]) or (v["html_url"] or "—")
        flag = "⭐ iTabs" if v["itabs_signals"] else ""
        lines.append(f"| {flag} | [{v['name']}](vals/{v['folder']}) | {url} | {kind(v)} | "
                     f"{v['privacy'] or ''} | {v['file_count']} |")
    if warnings:
        lines += ["", "## Warnings", ""] + [f"- {w}" for w in warnings]
    return "\n".join(lines) + "\n"


def main():
    out = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else "valtown-backup")
    os.makedirs(out, exist_ok=True)
    log = lambda m: print(m, flush=True)
    me = get("/v1/me")
    log(f"logged in as {me.get('username')}")
    warnings = []
    vals = backup_vals(out, me, log)
    for v in vals:
        warnings += [f"{v['name']}: {e}" for e in v["errors"]]
    tables, blobs = [], []
    try:
        tables = backup_sqlite(out, log)
    except Exception as e:  # noqa: BLE001
        warnings.append(f"SQLite backup failed: {e}")
    try:
        blobs = backup_blobs(out, log)
    except Exception as e:  # noqa: BLE001
        warnings.append(f"Blob backup failed: {e}")
    write(os.path.join(out, "README.md"), readme(me, vals, tables, blobs, warnings))
    write(os.path.join(out, "manifest.json"), json.dumps(
        {"user": me.get("username"), "vals": vals, "sqlite_tables": tables,
         "blobs": blobs, "warnings": warnings}, indent=2))
    log(f"done: {len(vals)} vals, {len(tables)} tables, {len(blobs)} blobs, {len(warnings)} warnings")


if __name__ == "__main__":
    main()
