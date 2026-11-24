"""Gmail's attachments, saved in one step (a part of the gmail part, mail.py): `attachments` takes a message (its id,
its gmail-message entity, or a Gmail link with the id in it) or a whole thread, finds the account it's in when none is
given, and saves every file it carries, the images its HTML shows in the body included (a customer's pasted photos are
those, not attachments), into a folder on any Mac or the server: each named as the sender named it, never written over
(the same bytes already there are kept as they are, other bytes beside them get " (2)"), each stored as a blob for
show, an ask or another appendage, the first few images shown to the caller. It also names the Google Drive links in
the body, which is where Gmail puts files over 25 MB. It changes nothing in Gmail.

Before it, this was throwaway python that dug the OAuth token out of the appendage's secrets (Nov 17, Austin's
Nutmeg.blend), or a download through the Mac mini's Chrome (Nov 14).
"""
import base64
import concurrent.futures
import datetime
import email.utils
import fnmatch
import hashlib
import json
import mimetypes
import os
import re
import shutil
import subprocess
import tempfile
import time
import zoneinfo

import mail
import sbmcp

app = mail.app
HERE = (os.environ.get("SB_INSTANCE") or "google@local").split("@", 1)[-1]
"""The machine this runs on: a folder here is written directly, one elsewhere goes there with sb cp."""
ROOT = "~/gmail-attachments"
IMAGES = {"image/jpeg", "image/png", "image/gif", "image/webp", "image/heic", "image/heif", "image/tiff", "image/bmp"}
PARALLEL = 6
"""Downloads at once."""
DRIVE_LINK = re.compile(r"https://(?:drive|docs)\.google\.com/[^\s\"'<>)\]]+")


def sb(*args, timeout=600, binary=False):
    r = subprocess.run(["sb", *args], capture_output=True, timeout=timeout)
    if r.returncode != 0:
        raise RuntimeError(f"sb {args[0]} {args[1] if len(args) > 1 else ''}: "
                           f"{r.stderr.decode(errors='replace').strip()[-400:] or 'failed'}")
    return r.stdout if binary else r.stdout.decode(errors="replace")


def answer(out):
    """What an sb command printed as JSON: its whole output (blob put prints it over several lines), else its last line
    (cp says what it did on stderr and its JSON on one line)."""
    try:
        return json.loads(out)
    except ValueError:
        return json.loads(out.strip().splitlines()[-1])


def b64(data):
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


# Which message


def target(args):
    """(message id, thread id, account address or None) from what was given: an id, a gmail-message entity, a link."""
    ident, thread, account = (args.get("id") or "").strip(), (args.get("thread") or "").strip(), args.get("account")
    for value in (ident, thread):
        if value.startswith("gmail-message:"):
            # gmail-message:<account's slug>-<id>: the id is its last part, the account what comes before it.
            slug, _, mid = value[len("gmail-message:"):].rpartition("-")
            account = account or slug
            ident, thread = (mid, thread) if value == ident else (ident, mid)
    for name, value in (("id", ident), ("thread", thread)):
        if "mail.google.com" in value:
            found = re.search(r"#[^?]*/([0-9a-f]{12,20})(?:[/?]|$)", value)
            if not found:
                raise ValueError(f"that Gmail link doesn't carry a message id I can use ({value[:120]}): give id as the "
                                 "message's id (gmail-message facts.message_id, or search's answer)")
            if name == "id":
                ident = found.group(1)
            else:
                thread = found.group(1)
    if not ident and not thread:
        raise ValueError("say which: id (a message's id, its gmail-message entity or a Gmail link) or thread")
    return ident, thread, account


def fetch(args):
    """The account and the messages (format full) to take files from, finding the account when none was given."""
    ident, thread, account = target(args)
    if account:
        candidates = [mail.find_account(account)]
    else:
        candidates = [a for a in mail.accounts.values() if a.connected] or list(mail.accounts.values())
        if not candidates:
            raise ValueError("no Gmail account is connected here")
    path = f"threads/{thread}" if thread else f"messages/{ident}"
    missed = []
    for acct in candidates:
        try:
            got = acct.get(path, format="full")
        except mail.HttpError as e:
            if e.status in (400, 404) and len(candidates) > 1:
                missed.append(acct.address)
                continue
            raise
        messages = got.get("messages", []) if thread else [got]
        if ident and thread:
            messages = [m for m in messages if m.get("id") == ident] or messages
        return acct, messages
    raise ValueError(f"no connected account has {'thread' if thread else 'message'} {thread or ident} "
                     f"(looked in {', '.join(missed)})")


# Its files


def header(part, name):
    return next((h.get("value", "") for h in part.get("headers", []) if h.get("name", "").lower() == name), "")


def clean(name):
    """A file name as safe to write as it is readable: no folders, control characters or leading dots."""
    name = re.sub(r"[\x00-\x1f\x7f/\\:]", "_", name or "").strip().lstrip(".").strip()
    if len(name.encode()) > 200:
        stem, ext = os.path.splitext(name)
        name = stem.encode()[:200 - len(ext.encode())].decode(errors="ignore") + ext
    return name


def pieces(payload):
    """Each file a message carries, walking its MIME tree: what has a file name and bytes of its own, and images the
    HTML shows by their Content-ID (inline), named or not. Its text and HTML bodies aren't files."""
    out = []

    def walk(p, parent=""):
        kind, body = (p.get("mimeType") or "").lower(), p.get("body") or {}
        name = p.get("filename") or ""
        if p.get("parts") and not (name and body.get("attachmentId")):
            for kid in p["parts"]:
                walk(kid, kind)
            return
        if not (body.get("attachmentId") or body.get("data")):
            return
        cid = header(p, "content-id").strip("<> ")
        disposition = header(p, "content-disposition").lower()
        inline = kind in IMAGES and (parent == "multipart/related" or (bool(cid) and not disposition.startswith("attachment")))
        if not name:
            if kind.startswith("text/") or kind.startswith("multipart/") or not (body.get("attachmentId") or inline):
                return
            name = f"{'image' if kind.startswith('image/') else 'attachment'}-{len(out) + 1}{mimetypes.guess_extension(kind) or ''}"
        out.append({"name": clean(name) or f"attachment-{len(out) + 1}", "type": kind or "application/octet-stream",
                    "bytes": body.get("size"), "inline": inline, "attachment_id": body.get("attachmentId"),
                    "data": body.get("data"), **({"content_id": cid} if cid else {})})

    walk(payload)
    return out


def picked(name, only):
    """Whether a file's name is one `only` asks for: words in it, a glob (*.stl) or a /regex/, any of them."""
    if not only:
        return True
    for want in [only] if isinstance(only, str) else only:
        want = str(want).strip()
        if len(want) > 2 and want.startswith("/") and want.endswith("/"):
            if re.search(want[1:-1], name, re.I):
                return True
        elif any(c in want for c in "*?["):
            if fnmatch.fnmatch(name.lower(), want.lower()):
                return True
        elif want.lower() in name.lower():
            return True
    return False


def links_in(m):
    """Google Drive links in a message's text: where Gmail puts a file too big to attach (over 25 MB)."""
    found = []
    words = mail.text_of(m.get("payload", {})) + "\n" + mail.html_of(m.get("payload", {}))
    for link in DRIVE_LINK.findall(words):
        link = link.replace("&amp;", "&").rstrip(".,;")
        if re.search(r"/file/d/|[?&]id=|/document/d/|/spreadsheets/d/|/presentation/d/|/folders/", link) and link not in found:
            found.append(link)
    return found


# Where they go


def default_folder(acct, m):
    who = email.utils.parseaddr(mail.header(m.get("payload", {}).get("headers", []), "From"))
    sender = mail.slug(who[0] or who[1].split("@")[0] or "unknown")[:40] or "unknown"
    day = time.strftime("%Y-%m-%d", time.localtime(int(m.get("internalDate") or 0) / 1000)) if m.get("internalDate") else "undated"
    return f"{ROOT}/{day}-{sender}-{m['id']}"


def machine(mac):
    """The machine a folder is on, as sb names it: this one when none is said."""
    mac = (mac or HERE).strip()
    for prefix in ("macos@", "server@"):
        if mac.startswith(prefix):
            mac = mac[len(prefix):]
    return mac


def keeper(mac):
    return f"server@{mac}" if mac == "switchboard" else f"macos@{mac}"


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def numbered(name, n):
    stem, ext = os.path.splitext(name)
    return f"{stem} ({n}){ext}"


class Local:
    """A folder on this machine."""

    def __init__(self, folder):
        self.folder = os.path.abspath(os.path.expanduser(folder))
        self.shown = folder

    def ready(self):
        os.makedirs(self.folder, exist_ok=True)

    def existing(self, name):
        """The sha256 of a file of that name there, None when there's none."""
        path = os.path.join(self.folder, name)
        if not os.path.exists(path):
            return None
        if not os.path.isfile(path):
            return "not a file"
        with open(path, "rb") as f:
            return sha256(f.read())

    def put(self, name, data, staged):
        path = os.path.join(self.folder, name)
        tmp = path + ".part"
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
        return path, None

    def path(self, name):
        return os.path.join(self.folder, name)


class Remote:
    """A folder on another Mac or the server, reached through its keeper (stat_file, exec) and sb cp."""

    def __init__(self, mac, folder):
        self.mac, self.folder, self.shown = mac, folder.rstrip("/") or "/", folder
        self.listing = None

    def request(self, action, args, timeout=120):
        out = answer(sb("request", keeper(self.mac), action, "--args", json.dumps(args), "--timeout", str(timeout),
                        timeout=timeout + 30))
        if not out.get("ok"):
            raise RuntimeError(f"{keeper(self.mac)} {action}: {out.get('error') or 'failed'}")
        return out.get("output") or {}

    def ready(self):
        pass  # sb cp makes the folders a destination is in

    def path(self, name):
        return f"{self.folder}/{name}"

    def existing(self, name):
        got = self.request("stat_file", {"path": self.path(name)})
        if not got.get("exists"):
            return None
        if got.get("kind") != "file":
            return "not a file"
        run = self.request("exec", {"command": f"shasum -a 256 {sh(self.path(name))}"})
        return (run.get("stdout") or "").split(" ", 1)[0].strip() or "unknown"

    def put(self, name, data, staged):
        copied = answer(sb("cp", staged, f"{keeper(self.mac)}:{self.path(name)}", timeout=900))
        return copied.get("to", "").split(":", 1)[-1] or self.path(name), copied.get("blob")


def sh(path):
    """A path for zsh, ~ left to expand."""
    if path.startswith("~/"):
        return "~/" + "'" + path[2:].replace("'", "'\\''") + "'"
    return "'" + path.replace("'", "'\\''") + "'"


def preview(data, kind, name, scratch):
    """An image as the caller sees it: JPEG at most 1200 px across (sips does HEIC too), or as it is when small."""
    src = os.path.join(scratch, "in-" + re.sub(r"[^\w.]+", "_", name))
    out = os.path.join(scratch, "out-" + re.sub(r"[^\w.]+", "_", name) + ".jpg")
    with open(src, "wb") as f:
        f.write(data)
    if shutil.which("sips"):
        r = subprocess.run(["sips", "-s", "format", "jpeg", "-s", "formatOptions", "80", "-Z", "1200", src, "--out", out],
                           capture_output=True, timeout=60)
        if r.returncode == 0 and os.path.exists(out):
            with open(out, "rb") as f:
                return sbmcp.image(f.read(), "image/jpeg")
    if kind in ("image/jpeg", "image/png", "image/gif", "image/webp") and len(data) < 3_500_000:
        return sbmcp.image(data, kind)
    return None


def size_of(n):
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024


def when(m):
    ms = int(m.get("internalDate") or 0)
    if not ms:
        return None
    return datetime.datetime.fromtimestamp(ms / 1000, zoneinfo.ZoneInfo(mail.ZONE)).strftime("%a %b %-d %Y, %-I:%M %p")


def attachments(ctx=None, id=None, thread=None, account=None, folder=None, mac=None, only=None, inline=True,
                blobs=True, show=4):
    progress = ctx.progress if ctx else (lambda *a, **k: None)
    acct, messages = fetch({"id": id, "thread": thread, "account": account})
    if not messages:
        raise ValueError("that thread has no messages")
    first = messages[0]
    where = machine(mac)
    folder = (folder or default_folder(acct, first)).strip()
    if not (folder.startswith("~") or folder.startswith("/")):
        raise ValueError(f"give folder as a full path or one from ~ on {where}, like ~/jobs/job/in")
    dest = Local(folder) if where == HERE else Remote(where, folder)

    files, left_out, links, jobs = [], [], [], []
    seen = {}  # sha256 → the file saved with those bytes
    taken = set()  # names this call has written, so two files of one name in one call don't meet
    images = []
    for m in messages:
        for link in links_in(m):
            if link not in links:
                links.append(link)
        for p in pieces(m.get("payload", {})):
            if not inline and p["inline"]:
                left_out.append({"name": p["name"], "why": "an image shown in the body (inline: false)"})
            elif not picked(p["name"], only):
                left_out.append({"name": p["name"], "why": "not what only asked for"})
            else:
                jobs.append((m, p))

    def load(job):
        m, p = job
        progress(f"Downloading {p['name']}" + (f" ({size_of(p['bytes'])})" if p.get("bytes") else ""))
        if p["attachment_id"]:
            return b64(acct.get(f"messages/{m['id']}/attachments/{p['attachment_id']}")["data"])
        return b64(p["data"])

    def save(m, p, data, scratch):
        digest = sha256(data)
        if digest in seen:
            # The same file again (a forward, a reply quoting its image, a re-attach): saved once, and said where else.
            earlier = seen[digest]
            if m["id"] != earlier["message_id"] and m["id"] not in earlier.setdefault("also_in", []):
                earlier["also_in"].append(m["id"])
            if p["name"] != earlier["name"] and not any(x["name"] == p["name"] for x in left_out):
                left_out.append({"name": p["name"], "why": f"the same bytes as {earlier['name']}, saved once"})
            return
        name, n, status = p["name"], 1, "saved"
        while True:
            there = None if name in taken else dest.existing(name)
            if name not in taken and there is None:
                break
            if name not in taken and there == digest:
                status = "already there"
                break
            n += 1
            name = numbered(p["name"], n)
        staged = os.path.join(scratch, f"{len(files)}-{re.sub(r'[^\w.]+', '_', name)}")
        with open(staged, "wb") as f:
            f.write(data)
        path, blob = (dest.path(name), None) if status == "already there" else dest.put(name, data, staged)
        taken.add(name)
        entry = {"name": name, "path": path, "status": status, "type": p["type"], "bytes": len(data), "sha256": digest,
                 "inline": p["inline"], "message_id": m["id"],
                 "from": mail.header(m.get("payload", {}).get("headers", []), "From"),
                 **({"renamed_from": p["name"]} if name != p["name"] else {})}
        if blobs:
            # sb cp went by a blob already; else put stores it (once, however often it's put).
            entry["blob"] = blob or answer(sb("blob", "put", staged, timeout=600))["blob"]
        if p["type"] in IMAGES and len(images) < int(show or 0):
            shown = preview(data, p["type"], name, scratch)
            if shown:
                images.append(shown)
                entry["shown"] = True
        seen[digest] = entry
        files.append(entry)

    scratch = tempfile.mkdtemp(prefix="gmail-attachments-")
    try:
        dest.ready()
        if jobs:
            acct.token()  # one refresh, before the downloads share it
        # A few at a time: a thread's dozens of photos in seconds, never more than a few 25 MB files in memory, and
        # each saved in the order Gmail has them, so names and duplicates come out the same every time.
        with concurrent.futures.ThreadPoolExecutor(PARALLEL) as pool:
            for at in range(0, len(jobs), PARALLEL):
                chunk = jobs[at:at + PARALLEL]
                for (m, p), data in zip(chunk, list(pool.map(load, chunk))):
                    save(m, p, data, scratch)
    finally:
        shutil.rmtree(scratch, ignore_errors=True)

    h = first.get("payload", {}).get("headers", [])
    sender = email.utils.parseaddr(mail.header(h, "From"))
    subject = mail.header(h, "Subject") or "(no subject)"
    out = {
        "summary": summarize(files, links, left_out, sender[0] or sender[1], subject, f"{dest.shown} on {where}"),
        "account": acct.address,
        **({"thread_id": first.get("threadId"), "messages": [m["id"] for m in messages]} if thread
           else {"message_id": first["id"], "thread_id": first.get("threadId")}),
        "from": mail.header(h, "From"), "subject": subject, "date": when(first),
        "mac": where, "folder": dest.shown, "files": files,
        **({"left_out": left_out} if left_out else {}), **({"drive_links": links} if links else {}),
    }
    if not images:
        return out
    return sbmcp.content(sbmcp.text(json.dumps(out, ensure_ascii=False)), *images, structured=out)


def summarize(files, links, left_out, who, subject, place):
    """The answer in a sentence or two, to say as it is."""
    total = sum(f["bytes"] for f in files)
    kept = sum(1 for f in files if f["status"] == "already there")
    inline_n = sum(1 for f in files if f["inline"])
    attached = [f["name"] for f in files if not f["inline"]]
    names = ", ".join(attached[:8]) + (f" and {len(attached) - 8} more" if len(attached) > 8 else "")
    if files:
        s = (f"{len(files)} file{'s' if len(files) != 1 else ''} ({size_of(total)}) from {who}'s “{subject}” "
             f"{'are' if len(files) != 1 else 'is'} in {place}"
             + (f": {names}" if names else "")
             + (f"{', and ' if names else ': '}{inline_n} image{'s' if inline_n != 1 else ''} shown in the body" if inline_n else "")
             + (f" ({kept} {'was' if kept == 1 else 'were'} there already, left as {'it was' if kept == 1 else 'they were'})" if kept else "")
             + ".")
    else:
        s = f"{who}'s “{subject}” carries no files" + (" that fit only" if left_out else "") + "."
    if links:
        s += (f" Its body links {len(links)} Google Drive {'files or folders' if len(links) != 1 else 'file or folder'} "
              f"(where Gmail puts files over 25 MB): open {'them' if len(links) != 1 else 'it'} in the Mac mini's Chrome.")
    return s


DESCRIPTION = (
    "Gmail: save a message's attachments to a folder in one step: every file it carries, the images it shows in the body "
    "included (a customer's pasted photos are those, which read lists apart as images_in_body), downloaded through the Gmail "
    "API into a folder on any Mac or the server (default ~/gmail-attachments/<date>-<sender>-<id> on the Mac mini), each "
    "named as sent and never written over (the same bytes already there are kept; other bytes get \" (2)\"), each also a "
    "blob (for show, an ask's blobs, slicer, mesh, jlc3dp), the first few images shown to you. Give the message as id (its "
    "facts.message_id, its gmail-message entity, or a Gmail link with the id), or thread for every message in a thread "
    "(a file sent twice is saved once); account is found when left out. Answers each file's path, bytes, type, sha256, "
    "blob and which message it came in, what only left out, Google Drive links in the body (Gmail's way past 25 MB) and a "
    "summary to say as it is. Changes nothing in Gmail.")

STATS = {"calls": 0, "failed": 0, "files": 0, "bytes": 0, "last": None, "last_failure": None}
"""How the tool has done since it started, for the Gmail heartbeat (vitals/google, sense:gmail)."""


def counted(ctx=None, **args):
    STATS["calls"] += 1
    try:
        out = attachments(ctx=ctx, **args)
    except Exception as e:
        STATS["failed"] += 1
        STATS["last_failure"] = {"at": int(time.time() * 1000), "args": {k: v for k, v in args.items() if k in ("id", "thread", "mac", "folder")},
                                 "error": f"{type(e).__name__}: {e}"[:300]}
        raise
    got = out.structured if isinstance(out, sbmcp.content) else out
    STATS["files"] += len(got["files"])
    STATS["bytes"] += sum(f["bytes"] for f in got["files"])
    STATS["last"] = {"at": int(time.time() * 1000), "summary": got["summary"][:300]}
    return out


app.tool(counted, name="attachments", read_only=True, description=DESCRIPTION, schema={
    "type": "object",
    "properties": {
        "id": {"type": "string", "description": "The message: its id (gmail-message facts.message_id, as search and read give it), its gmail-message:<account>-<id> entity, or a Gmail link ending in the id."},
        "thread": {"type": "string", "description": "Or a thread's id (facts.thread_id): the files of every message in it, oldest first."},
        "account": {"type": "string", "description": "The connected account it's in, like me@example.com (default: whichever has it)."},
        "folder": {"type": "string", "description": "Where they go, made when missing: a full path or one from ~ on mac, like ~/jobs/pendant/in (default ~/gmail-attachments/<date>-<sender>-<message id>)."},
        "mac": {"type": "string", "description": "The machine the folder is on: local (default, where this runs), laptop, or switchboard for the server. Another machine must be awake."},
        "only": {"description": "Only files whose names have these words, match this glob (*.stl) or /regex/; a list for any of several."},
        "inline": {"type": "boolean", "description": "Also the images shown in the body (default true); false for attached files alone."},
        "blobs": {"type": "boolean", "description": "Store each as a blob too (default true)."},
        "show": {"type": "integer", "description": "How many of its images to show you inline (default 4; 0 for none)."},
    }})
