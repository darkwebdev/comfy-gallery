"""Phone-friendly gallery for ComfyUI renders.

Reads the generation graph ComfyUI embeds in each PNG and shows model,
LoRAs, prompt, seed, steps, CFG, sampler, size and date.
"""
import hashlib
import json
import os
import re
import threading
import time
import urllib.request
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException, Query
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image
from send2trash import send2trash

ROOT = Path(os.environ.get("GALLERY_ROOT", "~/ComfyUI/output")).expanduser().resolve()
CACHE = Path(os.environ.get("GALLERY_CACHE", Path(__file__).parent / "cache"))
THUMB_PX = 480
COMFY = os.environ.get("COMFY_URL", "http://127.0.0.1:8188")
EXTS = {".png", ".jpg", ".jpeg", ".webp"}
# Old ComfyUI installs and Python envs copied under output hold sample/docs images, not renders.
SKIP_DIRS = {"venv", ".venv", "site-packages", "custom_nodes", "comfy", "comfy_extras", "comfy_execution",
             "comfy_api", "node_modules", "__pycache__", "tests", "docs"}

app = FastAPI()
app.mount("/static", StaticFiles(directory=Path(__file__).parent / "static"), name="static")
_index = {"at": 0.0, "files": [], "dirs": []}


def is_code_dir(entries):
    return any(e.name.endswith(".py") for e in entries)


def scan():
    """All images under ROOT, newest first. Skips hidden and source-code folders."""
    if time.time() - _index["at"] < 4:
        return _index
    files, dirs = [], {}
    stack = [ROOT]
    while stack:
        d = stack.pop()
        try:
            entries = list(os.scandir(d))
        except OSError:
            continue
        if d != ROOT and is_code_dir(entries):
            continue
        for e in entries:
            if e.name.startswith("."):
                continue
            if e.is_dir(follow_symlinks=False):
                if e.name in SKIP_DIRS:
                    continue
                stack.append(Path(e.path))
            elif Path(e.name).suffix.lower() in EXTS:
                rel = os.path.relpath(e.path, ROOT)
                folder = os.path.dirname(rel)
                files.append((e.stat().st_mtime, rel, folder))
                dirs[folder] = dirs.get(folder, 0) + 1
    files.sort(reverse=True)
    _index.update(at=time.time(), files=files,
                  dirs=sorted(({"name": k, "count": v} for k, v in dirs.items()), key=lambda x: x["name"]))
    return _index


# Render times aren't stored in the PNGs. ComfyUI's job history has start/end timestamps,
# but forgets them on restart, so seen times are kept in cache/render_times.json.
TIMES_FILE = CACHE / "render_times.json"
_times = {"at": 0.0, "data": None}
# For the same reason, which Save Image node wrote which file in one run: {file: {node_id: file}}.
# Used to fill every Save Image node when a workflow is reopened from one of its images.
JOBS_FILE = CACHE / "job_outputs.json"
_jobs = {"data": None}


def save_json(path, data):
    CACHE.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data))
    tmp.replace(path)


def render_times():
    for d, f in ((_times, TIMES_FILE), (_jobs, JOBS_FILE)):
        if d["data"] is None:
            try:
                d["data"] = json.loads(f.read_text())
            except (OSError, ValueError):
                d["data"] = {}
    if time.time() - _times["at"] > 20:
        _times["at"] = time.time()
        try:
            with urllib.request.urlopen(f"{COMFY}/history", timeout=3) as r:
                hist = json.load(r)
        except Exception:
            hist = {}
        added = jobs_added = False
        for job in hist.values():
            outs = {nid: os.path.join(im.get("subfolder", ""), im["filename"])
                    for nid, out in job.get("outputs", {}).items()
                    for im in out.get("images", [])[:1] if im.get("type") == "output"}
            for key in outs.values():
                if _jobs["data"].get(key) != outs:
                    _jobs["data"][key] = outs
                    jobs_added = True
            stamps = {m[0]: m[1].get("timestamp") for m in job.get("status", {}).get("messages", [])}
            if not stamps.get("execution_start") or not stamps.get("execution_success"):
                continue
            secs = round((stamps["execution_success"] - stamps["execution_start"]) / 1000, 1)
            for out in job.get("outputs", {}).values():
                for im in out.get("images", []):
                    if im.get("type") != "output":
                        continue
                    key = os.path.join(im.get("subfolder", ""), im["filename"])
                    if _times["data"].get(key) != secs:
                        _times["data"][key] = secs
                        added = True
        if added:
            save_json(TIMES_FILE, _times["data"])
        if jobs_added:
            save_json(JOBS_FILE, _jobs["data"])
    return _times["data"]


def safe_path(rel):
    p = (ROOT / rel).resolve()
    if ROOT not in p.parents or not p.is_file():
        raise HTTPException(404)
    return p


# ---------- ComfyUI graph parsing ----------

def link_id(v):
    return str(v[0]) if isinstance(v, list) and len(v) == 2 and isinstance(v[1], int) else None


def resolve_text(graph, v, seen=None):
    """A text input is either a string or a link to a primitive / string node."""
    if isinstance(v, str):
        return v
    nid = link_id(v)
    if not nid or nid not in graph:
        return None
    seen = seen or set()
    if nid in seen:
        return None
    seen.add(nid)
    inputs = graph[nid].get("inputs", {})
    for key in ("text", "value", "string", "prompt", "text_a"):
        if key in inputs:
            t = resolve_text(graph, inputs[key], seen)
            if t:
                return t
    return None


def parse_comfy(graph):
    out = {"models": [], "loras": [], "positive": [], "negative": [], "params": {}}
    helpers = []  # model_name is also used by upscalers, detectors and depth models
    roots = [k for k, n in graph.items() if "Save" in n.get("class_type", "")] or \
            [k for k, n in graph.items() if "Sampler" in n.get("class_type", "")]
    visited = set()
    stack = [(r, False) for r in roots]
    while stack:
        nid, neg = stack.pop()
        if (nid, neg) in visited or nid not in graph:
            continue
        visited.add((nid, neg))
        node = graph[nid]
        ct = node.get("class_type", "")
        inputs = node.get("inputs", {})
        if neg and "ZeroOut" in ct:
            continue  # an empty negative made by zeroing the positive: there is no negative prompt

        for key in ("unet_name", "ckpt_name", "gguf_name"):
            if isinstance(inputs.get(key), str) and inputs[key] not in out["models"]:
                out["models"].append(inputs[key])
        if isinstance(inputs.get("model_name"), str) and inputs["model_name"] not in helpers:
            helpers.append(inputs["model_name"])
        if isinstance(inputs.get("lora_name"), str):
            out["loras"].append({"name": inputs["lora_name"],
                                 "strength": inputs.get("strength_model", inputs.get("strength"))})
        for v in inputs.values():  # rgthree Power Lora Loader style
            if isinstance(v, dict) and isinstance(v.get("lora"), str) and v.get("on", True) and v["lora"] != "None":
                out["loras"].append({"name": v["lora"], "strength": v.get("strength")})

        if "TextEncode" in ct or ct in ("CLIPTextEncodeFlux", "TextEncodeQwenImageEdit"):
            for key in ("text", "prompt", "t5xxl", "clip_l"):
                t = resolve_text(graph, inputs.get(key))
                if t and t.strip():
                    bucket = out["negative" if neg else "positive"]
                    if t not in bucket:
                        bucket.append(t)
                    break

        p = out["params"]
        for src, dst in (("seed", "seed"), ("noise_seed", "seed"), ("steps", "steps"), ("cfg", "cfg"),
                         ("guidance", "guidance"), ("sampler_name", "sampler"), ("scheduler", "scheduler"),
                         ("denoise", "denoise"), ("shift", "shift")):
            if src in inputs and not isinstance(inputs[src], list) and dst not in p:
                p[dst] = inputs[src]

        for key, v in inputs.items():
            child = link_id(v)
            if child:
                stack.append((child, neg or key == "negative"))

    if not out["models"]:
        out["models"] = helpers
    # a text reachable from both sides (shared encoder, guider tricks) is a positive prompt
    out["negative"] = [t for t in out["negative"] if t not in out["positive"]]
    seen, loras = set(), []
    for l in out["loras"]:
        if l["name"] not in seen:
            seen.add(l["name"])
            loras.append(l)
    out["loras"] = loras
    return out


# ---------- model / LoRA index for the filter dropdowns ----------
# Reading every PNG's graph takes a while, so it runs in a background thread and is kept in
# cache/meta_index_v4.json ({path: [mtime, [models], [loras], has_workflow, width, height]}); only new or changed files are re-read.
META_FILE = CACHE / "meta_index_v4.json"
_meta = {"data": None, "lock": threading.Lock(), "running": False, "todo": 0}
NO_LORA = "(no LoRA)"


def short(name):
    return os.path.splitext(os.path.basename(name))[0]


def read_models_loras(p):
    """models, loras, whether the file carries a ComfyUI workflow that can be reopened, and its size"""
    try:
        with Image.open(p) as im:
            raw, wf, (w, h) = im.info.get("prompt"), "workflow" in im.info or "prompt" in im.info, im.size
    except Exception:
        return [], [], False, 0, 0
    try:
        g = parse_comfy(json.loads(raw)) if raw else {"models": [], "loras": []}
        return [short(m) for m in g["models"]], [short(l["name"]) for l in g["loras"]], wf, w, h
    except Exception:
        return [], [], wf, w, h


def save_meta():
    CACHE.mkdir(parents=True, exist_ok=True)
    tmp = META_FILE.with_suffix(".tmp")
    with _meta["lock"]:
        tmp.write_text(json.dumps(_meta["data"]))
    tmp.replace(META_FILE)


def index_meta(files):
    try:
        todo = [(m, r) for m, r, _ in files if (_meta["data"].get(r) or [None])[0] != m]
        _meta["todo"] = len(todo)
        for n, (m, r) in enumerate(todo, 1):
            models, loras, wf, w, h = read_models_loras(ROOT / r)
            with _meta["lock"]:
                _meta["data"][r] = [m, models, loras, wf, w, h]
            _meta["todo"] = len(todo) - n
            if n % 500 == 0:
                save_meta()
        if todo:
            save_meta()
    finally:
        _meta["running"] = False


def meta_index(files):
    if _meta["data"] is None:
        try:
            _meta["data"] = json.loads(META_FILE.read_text())
        except (OSError, ValueError):
            _meta["data"] = {}
    if not _meta["running"]:
        _meta["running"] = True
        threading.Thread(target=index_meta, args=(files,), daemon=True).start()
    return _meta["data"]


# ---------- grouping ----------
# Name prefix works in levels: ComfyUI's _00001_ counter and trailing seed/number tokens are dropped,
# then names group by their first word ("Virtuosa"), and a big group splits by its first two words
# ("Virtuosa_black"), and so on.
NUMERIC = re.compile(r"^([sdv]?\d+(\.\d+)?|cf\d.*)$", re.I)


def name_tokens(rel):
    n = re.sub(r"_?\d{5}_?$", "", os.path.splitext(os.path.basename(rel))[0])
    t = [x for x in re.split(r"[_\s]+", n) if x] or [n]
    while len(t) > 1 and NUMERIC.match(t[-1]):
        t.pop()
    return t


def day(mtime):
    return time.strftime("%Y-%m-%d", time.localtime(mtime))


@app.get("/api/images")
def images(offset: int = 0, limit: int = 120, folder: str | None = None, q: str = "", find: str = "",
           model: str = "", lora: str = "", by: str = "", group: str | None = None, groups: int = 0):
    idx = scan()
    meta_db = meta_index(idx["files"])
    files = idx["files"]
    if folder is not None:
        files = [f for f in files if f[2] == folder]
    if q:
        ql = q.lower()
        files = [f for f in files if ql in f[1].lower()]
    # dropdown counts: each one reflects the other dropdown's choice
    with _meta["lock"]:
        info = {r: meta_db.get(r) for _, r, _ in files}
    def has_model(r):
        e = info[r]
        return bool(e) and model in e[1]
    def has_lora(r):
        e = info[r]
        return bool(e) and (not e[2] if lora == NO_LORA else lora in e[2])
    models, loras = {}, {}
    for _, r, _ in files:
        e = info[r]
        if not e or not e[1]:
            continue
        if not lora or has_lora(r):
            for m in e[1]:
                models[m] = models.get(m, 0) + 1
        if not model or has_model(r):
            for l in e[2] or [NO_LORA]:
                loras[l] = loras.get(l, 0) + 1
    if model:
        files = [f for f in files if has_model(f[1])]
    if lora:
        files = [f for f in files if has_lora(f[1])]
    want_groups, groups = groups, None
    gtok = group.split("_") if (by == "prefix" and group) else []
    if by == "date" and group:
        files = [f for f in files if day(f[0]) == group]
    elif gtok:
        files = [f for f in files if name_tokens(f[1])[:len(gtok)] == gtok]
    if want_groups and by in ("date", "prefix"):
        # newest group first; each carries its newest images as covers
        g = {}
        for m, r, _ in files:
            k = day(m) if by == "date" else "_".join(name_tokens(r)[:len(gtok) + 1])
            e = g.setdefault(k, {"count": 0, "latest": m, "covers": []})
            e["count"] += 1
            if len(e["covers"]) < 4:
                d = info.get(r) or []
                e["covers"].append({"path": r, "w": d[4] if len(d) > 5 else 0, "h": d[5] if len(d) > 5 else 0})
        groups = [{"key": k, **v} for k, v in sorted(g.items(), key=lambda kv: -kv[1]["latest"])]
    page = files[offset:offset + limit]
    at = next((i for i, f in enumerate(files) if f[1] == find), None) if find else None
    facet = lambda d: [{"name": k, "count": v} for k, v in sorted(d.items(), key=lambda kv: kv[0].lower())]
    # wf: unknown while still indexing counts as present, so the button only hides once we know
    return {"total": len(files), "items": [{"path": r, "mtime": m, "wf": (info.get(r) or [0, 0, 0, True])[3]} for m, r, _ in page], "dirs": idx["dirs"], "at": at,
            "models": facet(models), "loras": facet(loras), "indexing": _meta["todo"] if _meta["running"] else 0,
            "groups": groups}


@app.get("/api/meta")
def meta(path: str):
    p = safe_path(path)
    st = p.stat()
    info = {"path": path, "name": p.name, "mtime": st.st_mtime, "bytes": st.st_size,
            "render_s": render_times().get(path)}
    try:
        with Image.open(p) as im:
            info["width"], info["height"] = im.size
            raw = dict(im.info)
    except Exception:
        return info
    if "prompt" in raw:
        try:
            info.update(parse_comfy(json.loads(raw["prompt"])))
        except Exception as e:
            info["error"] = f"could not parse ComfyUI graph: {e}"
    elif "parameters" in raw:
        info["raw"] = raw["parameters"]
    return info


@app.post("/api/delete")
def delete(path: str, x_gallery: str = Header(default="")):
    # The custom header forces a CORS preflight, so other web pages can't trigger deletes.
    if x_gallery != "1":
        raise HTTPException(403)
    p = safe_path(path)
    send2trash(str(p))  # macOS Trash, so "Put Back" still works
    _index["at"] = 0.0
    with _meta["lock"]:
        (_meta["data"] or {}).pop(path, None)
    return {"ok": True}


@app.get("/api/siblings")
def siblings(path: str, nodes: str = "{}"):
    """Files written by the other Save Image nodes in the same run as `path`.
    nodes = {node_id: filename_prefix}. Uses ComfyUI's job history when known, otherwise the file
    with that prefix written closest in time (within 15 minutes)."""
    render_times()
    want = json.loads(nodes)
    known = (_jobs["data"] or {}).get(path, {})
    p = safe_path(path)
    t = p.stat().st_mtime
    files = scan()["files"]
    found = {}
    for nid, prefix in want.items():
        if nid in known:
            found[nid] = known[nid]
            continue
        folder, stem = os.path.split(prefix)
        best = min(((abs(m - t), r) for m, r, f in files
                    if f == folder and os.path.basename(r).startswith(stem)), default=None)
        if best and best[0] < 900:
            found[nid] = best[1]
    out = {nid: {"filename": os.path.basename(r), "subfolder": os.path.dirname(r)} for nid, r in found.items()}
    return JSONResponse(out, headers={"Access-Control-Allow-Origin": "*"})


@app.get("/thumb")
def thumb(path: str):
    p = safe_path(path)
    st = p.stat()
    key = hashlib.sha1(f"{path}|{st.st_mtime}|{THUMB_PX}".encode()).hexdigest()
    out = CACHE / key[:2] / f"{key}.webp"
    if not out.exists():
        out.parent.mkdir(parents=True, exist_ok=True)
        with Image.open(p) as im:
            im.thumbnail((THUMB_PX, THUMB_PX * 2))
            if im.mode not in ("RGB", "RGBA"):
                im = im.convert("RGB")
            tmp = out.with_suffix(".tmp")
            im.save(tmp, "WEBP", quality=80)
            tmp.replace(out)
    return FileResponse(out, media_type="image/webp", headers={"Cache-Control": "public, max-age=31536000"})


@app.get("/full")
def full(path: str):
    return FileResponse(safe_path(path), headers={"Cache-Control": "public, max-age=3600"})


@app.get("/")
def index():
    # version the shared viewer files by their mtime so browsers never keep a stale copy
    here = Path(__file__).parent
    html = (here / "index.html").read_text()
    for f in ("viewer.js", "viewer.css"):
        html = html.replace(f"static/{f}", f"static/{f}?v={int((here / 'static' / f).stat().st_mtime)}")
    return HTMLResponse(html, headers={"Cache-Control": "no-cache"})
