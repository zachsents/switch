"""box: one plain, temporary Hetzner box (Ubuntu 24.04) for work too heavy for this machine: a build, a lint, a test run.

It rents through hetzner.py with cfd's ssh key (cfd.keypair, cfd.hetzner_key, cfd.ssh_argv), labels the box temp=true,
made_by=box and delete_by=<YYYYMMDDTHHMMZ>, and its own loop deletes any box of its past that delete-by. box_start
reuses a live box of its own rather than renting a second; box_delete takes it down and checks Hetzner holds nothing
of it. Renting is the user's money: box_start speaks for the user.
"""

import datetime
import json
import os
import re
import shlex
import shutil
import subprocess
import threading
import time

import cfd
import hetzner
from server import app, part_home

NAME = "box"
HOME = part_home(NAME)
MAX_HOURS = 24
DEFAULT_HOURS = 4
TYPES = ("cpx41", "cpx42", "cpx51", "cpx52")  # ~8 shared vCPU and 16 GB first; the next one Hetzner offers there
WAIT_S = 540  # a call answers before ten minutes, with how far it got
RUN_MAX_S = 1200
REAP_S = float(os.environ.get("BOX_REAP_S") or 600)
OUT_HEAD, OUT_TAIL = 6000, 14000
EXCLUDE = [".git", "node_modules", ".DS_Store"]
# what setup steps and jobs start with: cloud-init runs the setup with no HOME, and an installer's bin (bun's, pip's) is found
ENV = ("export HOME=/root USER=root LANG=C.UTF-8 PATH=/root/.bun/bin:/root/.local/bin:/root/.cargo/bin:"
       "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin")

state = {"calls": 0, "failed": 0, "last_error": None, "rented": 0, "reused": 0, "deleted": 0, "last_reap": None}
renting = threading.Lock()


def now_ms():
    return int(time.time() * 1000)


def iso_ms(text):
    try:
        return int(datetime.datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp() * 1000)
    except (AttributeError, ValueError):
        return None


# ---------------------------------------------------------------------------------------------
# What it keeps: boxes.json, by server id (what Hetzner doesn't say: its price, the setup it ran)


def records():
    try:
        with open(os.path.join(HOME, "boxes.json")) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def keep(rec):
    recs = records()
    recs[str(rec["id"])] = rec
    cut = now_ms() - 7 * 86_400_000
    recs = {k: v for k, v in recs.items() if not v.get("deleted_at") or v["deleted_at"] > cut}
    tmp = os.path.join(HOME, "boxes.json.tmp")
    with open(tmp, "w") as f:
        json.dump(recs, f, indent=1)
    os.replace(tmp, os.path.join(HOME, "boxes.json"))


def record(srv):
    """A server as this part keeps it: Hetzner's facts merged into what it kept."""
    rec = records().get(str(srv["id"])) or {}
    labels = srv.get("labels") or {}
    rec.update({"id": srv["id"], "name": srv["name"], "status": srv.get("status"),
                "ip": ((srv.get("public_net") or {}).get("ipv4") or {}).get("ip"),
                "type": (srv.get("server_type") or {}).get("name"), "cores": (srv.get("server_type") or {}).get("cores"),
                "location": ((srv.get("datacenter") or {}).get("location") or {}).get("name") or rec.get("location"),
                "created": iso_ms(srv.get("created")) or rec.get("created"),
                "delete_by": hetzner.parse_label_time(labels.get("delete_by", "")), "purpose": labels.get("purpose")})
    rec.setdefault("setup", [])
    return rec


def mine():
    """Its boxes Hetzner holds now, oldest first."""
    servers = hetzner.api("GET", "/servers?label_selector=made_by%3Dbox&per_page=50").get("servers") or []
    return sorted((record(s) for s in servers), key=lambda r: r.get("created") or 0)


def live(boxes):
    t = now_ms()
    return [b for b in boxes if b["status"] not in ("deleting", "off", "stopping") and (b.get("delete_by") or 0) > t + 60_000]


def find(box=None):
    """A live box of its own by id or name, or the one there is."""
    boxes = live(mine())
    if box:
        hits = [b for b in boxes if str(box) in (str(b["id"]), b["name"])]
        if not hits:
            raise ValueError(f"no live box {box!r}: box_status lists them")
        return hits[0]
    if not boxes:
        raise ValueError("no live box: box_start rents one")
    return boxes[-1]


# ---------------------------------------------------------------------------------------------
# The box over ssh


def ssh(b):
    return cfd.ssh_argv({"id": NAME, "box": {"ip": b["ip"]}}, known_hosts=os.path.join(HOME, f"known_hosts-{b['id']}"))


def remote(b, command, stdin=None, timeout=60):
    """(exit code, stdout, stderr) of a command on the box."""
    try:
        done = subprocess.run(ssh(b) + ["bash", "-lc", shlex.quote(command)], input=stdin, capture_output=True,
                              timeout=timeout)
    except subprocess.TimeoutExpired:
        return 124, b"", f"timed out after {timeout} s".encode()
    return done.returncode, done.stdout, done.stderr


def text(b):
    return b.decode("utf-8", "replace") if isinstance(b, bytes) else (b or "")


def setup_state(b, timeout=20):
    """ready, failed: <why>, setting up, or unreachable (ssh doesn't answer yet)."""
    code, out, _ = remote(b, "if [ -e /root/box-failed ]; then echo failed: $(cat /root/box-failed); "
                             "elif [ -e /root/box-ready ]; then echo ready; else echo setting up; fi", timeout=timeout)
    return text(out).strip() if code == 0 else "unreachable"


def wait_ready(b, until):
    """Waits for ssh and the first boot's setup, at most until `until` (epoch s): its last state."""
    got = "unreachable"
    while time.time() < until:
        got = setup_state(b)
        if got == "ready" or got.startswith("failed"):
            return got
        time.sleep(5)
    return got


def cloud_init(pubkey, setup=()):
    """First boot: cfd's key for root, a few tools, the setup commands in turn, then /root/box-ready (or /root/box-failed
    with the step that failed; /root/box-setup.log has their output)."""
    script = [ENV, "cd /root", "set -o pipefail"]
    for i, s in enumerate(setup):
        script.append(f"( {s} ) || {{ echo 'setup step {i + 1} failed' > /root/box-failed; exit 1; }}")
    script.append("touch /root/box-ready")
    lines = ["#cloud-config", "ssh_authorized_keys:", f"  - {pubkey.strip()}", "package_update: true",
             "packages: [rsync, git, curl, unzip, build-essential]", "write_files:",
             "  - path: /root/box-setup.sh", "    permissions: '0700'", "    content: |", "      #!/bin/bash"]
    lines += [f"      {line}" for line in script]
    lines += ["runcmd:", "  - [bash, -lc, '/root/box-setup.sh > /root/box-setup.log 2>&1']"]
    return "\n".join(lines) + "\n"


def run_setup(b, setup, until):
    """Setup steps a reused box hasn't run yet, over ssh: the first failure, or None."""
    for s in setup:
        if s in b["setup"]:
            continue
        code, out, err = remote(b, s, timeout=max(30, int(until - time.time())))
        if code != 0:
            return f"setup {s!r} (exit {code}): {(text(err) or text(out)).strip()[-800:]}"
        b["setup"].append(s)
        keep(b)
    return None


# ---------------------------------------------------------------------------------------------
# Money: the type, its price and the project's cores


def pick_type(server_type, location):
    for t in [server_type] if server_type else TYPES:
        hourly, currency = hetzner.price(t, location)
        if hourly is not None:
            return t, hourly, currency
    raise ValueError(f"Hetzner offers none of {', '.join([server_type] if server_type else TYPES)} in {location}")


def cores_in_use():
    """The project's servers' cores (Hetzner's API doesn't say the account's limit; a rent over it is refused)."""
    servers = hetzner.api("GET", "/servers?per_page=50").get("servers") or []
    return sum((s.get("server_type") or {}).get("cores") or 0 for s in servers), len(servers)


def view(b):
    t = now_ms()
    spent, hours = hetzner.cost(b["created"], b.get("deleted_at") or t, b.get("price_hourly")) if b.get("created") else (None, None)
    return {"id": b["id"], "name": b["name"], "ip": b.get("ip"), "status": b.get("status"), "type": b.get("type"),
            "cores": b.get("cores"), "location": b.get("location"), "purpose": b.get("purpose"),
            "created": cfd.pt(b.get("created")), "delete_by": cfd.pt(b.get("delete_by")),
            "price": f"{b['price_hourly']:.4f} {b.get('currency')}/h" if b.get("price_hourly") else None,
            "cost_so_far": f"{spent} {b.get('currency')} ({hours} h started)" if spent is not None else None,
            "setup": b.get("setup") or [], "ssh": " ".join(shlex.quote(a) for a in ssh(b)) if b.get("ip") else None}


# ---------------------------------------------------------------------------------------------
# Tools


@app.tool(name="box_start", speaks_for_person=True, schema={
    "type": "object",
    "properties": {
        "hours": {"type": "number", "description": "Its delete-by, in hours from now (default 4, at most 24 after it was made): the box is deleted then, whatever it's doing. A reused box's delete-by only moves later."},
        "setup": {"type": "array", "items": {"type": "string"}, "description": "Shell commands run once, as root, in turn (e.g. 'curl -fsSL https://bun.sh/install | bash'). A reused box runs the ones it hasn't yet."},
        "server_type": {"type": "string", "description": "Hetzner server type (default cpx41, 8 shared vCPU and 16 GB, or the next Hetzner offers there)."},
        "location": {"type": "string", "description": "Hetzner location (default hil, Hillsboro)."},
        "purpose": {"type": "string", "description": "What it's for, in a few words, kept on its label."},
    },
})
def start(hours=DEFAULT_HOURS, setup=None, server_type=None, location="hil", purpose=None):
    "Rents one plain Ubuntu 24.04 Hetzner box (the user's money, until its delete-by at most), or reuses the live one it rented already, and answers once ssh answers and its setup ran: its id, IP and delete-by. box_run runs commands on it, box_send sends a folder, box_delete deletes it."
    state["calls"] += 1
    try:
        if not hetzner.token():
            raise ValueError("no Hetzner key: connect Hetzner Cloud in Switch's connections")
        hours = float(hours)
        if not 0 < hours <= MAX_HOURS:
            raise ValueError(f"hours: its delete-by is at most {MAX_HOURS} h out")
        setup = [s for s in (setup or []) if s and s.strip()]
        until = time.time() + WAIT_S
        with renting:
            boxes = live(mine())
            if boxes:
                b = boxes[-1]
                want = min(now_ms() + int(hours * 3_600_000), b["created"] + MAX_HOURS * 3_600_000)
                if want > b["delete_by"] + 60_000:
                    label = cfd.relabel(b["id"], want)
                    b["delete_by"] = hetzner.parse_label_time(label)
                keep(b)
                state["reused"] += 1
                reused = True
            else:
                used, count = cores_in_use()
                server_type, hourly, currency = pick_type(server_type, location)
                created = now_ms()
                labels = {"temp": "true", "made_by": NAME, "delete_by": hetzner.label_time(created + int(hours * 3_600_000))}
                if purpose:
                    labels["purpose"] = re.sub(r"[^a-z0-9]+", "-", purpose.lower()).strip("-")[:63].strip("-") or "box"
                _, pubkey = cfd.keypair()
                body = {"name": f"temp-box-{time.strftime('%m%d-%H%M')}", "server_type": server_type, "location": location,
                        "image": "ubuntu-24.04", "labels": labels, "start_after_create": True, "ssh_keys": [cfd.hetzner_key()],
                        "user_data": cloud_init(pubkey, setup), "public_net": {"enable_ipv4": True, "enable_ipv6": True}}
                try:
                    made = hetzner.api("POST", "/servers", body)["server"]
                except hetzner.HetznerError as e:
                    hint = (f" The project already runs {count} servers with {used} cores: delete one, or ask for a smaller type."
                            if e.code == "resource_limit_exceeded" else "")
                    raise ValueError(f"Hetzner wouldn't rent the box: {e.message}.{hint}")
                b = record(made)
                b.update(location=b["location"] or location, price_hourly=hourly, currency=currency, setup=list(setup), cores_before=used)
                keep(b)
                state["rented"] += 1
                reused = False
        got = wait_ready(b, until)
        if reused and got == "ready" and setup:
            failed = run_setup(b, setup, until)
            got = f"failed: {failed}" if failed else got
        out = dict(view(b), reused=reused, setup_state=got)
        if not reused:
            out["project_cores_before"] = b.get("cores_before")
        if got != "ready":
            out["next"] = ("box_status says when it's ready; /root/box-setup.log on it has the setup's output"
                           if not got.startswith("failed") else "box_run 'tail -50 /root/box-setup.log' says why")
        return out
    except Exception as e:
        state["failed"] += 1
        state["last_error"] = f"start: {e}"
        raise


def job_result(b, job, wait_until):
    """Waits for a job on the box until `wait_until` (epoch s): its exit and output (head and tail), or how far it got."""
    d = f"/root/jobs/{job}"
    code = None
    while True:
        # the job holds {d}/lock while it runs: flock answers the moment it ends, in one call (a job started before
        # the lock, with no lock file, is looked at every 5 s instead)
        left = max(1, int(wait_until - time.time()))
        c, out, _ = remote(b, f"if [ -e {d}/lock ]; then timeout {left} flock -s {d}/lock true; else sleep 5; fi; "
                              f"cat {d}/exit 2>/dev/null", timeout=left + 30)
        if text(out).strip().lstrip("-").isdigit():
            code = int(text(out).strip())
            break
        if time.time() >= wait_until:
            break
        if c not in (0, 1):
            time.sleep(5)  # ssh didn't get through: try again while there's time
    c, out, err = remote(b, f"test -d {d} || exit 3; n=$(wc -c < {d}/out); echo $n; "
                            f"if [ $n -le {OUT_HEAD + OUT_TAIL} ]; then cat {d}/out; else head -c {OUT_HEAD} {d}/out; "
                            f"printf '\\n<<1>>\\n'; tail -c {OUT_TAIL} {d}/out; fi", timeout=60)
    if c == 3:
        raise ValueError(f"no job {job} on {b['name']}")
    body = text(out)
    size, _, body = body.partition("\n")
    size = int(size.strip() or 0)
    cut = size > OUT_HEAD + OUT_TAIL
    if cut:
        body = body.replace("\n<<1>>\n", f"\n... [{size - OUT_HEAD - OUT_TAIL} bytes cut] ...\n", 1)
    res = {"box": b["name"], "job": job, "output": body, "bytes": size, "cut": cut}
    if code is None:
        res.update(running=True, next=f"box_run with job {job!r} waits for it again")
    else:
        res.update(exit=code, timed_out=code == 124)
    return res


@app.tool(name="box_run", schema={
    "type": "object",
    "properties": {
        "command": {"type": "string", "description": "A shell command, run as root in a login bash on the box (stdout and stderr together)."},
        "cwd": {"type": "string", "description": "Where it runs (default /root; a folder box_send sent is under /root/work)."},
        "timeout_s": {"type": "integer", "description": "How long it may run before it's killed (default 600, at most 1200)."},
        "job": {"type": "string", "description": "A job a call answered still running: waits for it again (no command)."},
        "box": {"type": "string", "description": "The box's id or name (default the live one)."},
    },
})
def run(command=None, cwd="/root", timeout_s=600, job=None, box=None):
    "Runs a shell command on the box and answers its exit code and output (its head and tail when long). A command still running at about nine minutes answers its job id, and box_run with that job waits again."
    state["calls"] += 1
    b = find(box)
    if job:
        if not re.fullmatch(r"[0-9a-z-]+", job):
            raise ValueError(f"job: {job!r} isn't one box_run answered")
        return job_result(b, job, time.time() + WAIT_S)
    if not command or not command.strip():
        raise ValueError("command: what to run, or job: one to wait for")
    timeout_s = max(5, min(int(timeout_s), RUN_MAX_S))
    job = time.strftime("%m%d-%H%M%S-") + os.urandom(2).hex()
    d = f"/root/jobs/{job}"
    script = f"{ENV}\ncd {shlex.quote(cwd or '/root')} || exit 97\n{command}\n".encode()
    # one call writes the job and starts it apart from this ssh session (setsid -f, every fd off it), so the call
    # returns at once whatever the job does and however loaded the box is
    # the lock is taken before the job forks and held by it (fd 9, not passed on to the command) until its exit is written
    launch = (f"mkdir -p {d} && cat > {d}/cmd.sh && exec 9> {d}/lock && flock 9 && setsid -f bash -c "
              f"'timeout -k 10 {timeout_s} bash -l {d}/cmd.sh 9>&- > {d}/out 2>&1; echo $? > {d}/exit' "
              f"< /dev/null > /dev/null 2>&1")
    code, out, err = remote(b, launch, stdin=script, timeout=60)
    if code != 0:
        why = (text(err) or text(out)).strip()[-500:]
        seen, _, _ = remote(b, f"test -e {d}/out", timeout=60)
        if seen == 1:
            raise RuntimeError(f"{b['name']} didn't start the job (exit {code}): {why}")
        if seen != 0:  # can't tell: the job may be running, so its id comes back to wait on
            return {"box": b["name"], "job": job, "running": None, "start_error": f"exit {code}: {why}",
                    "next": f"box_run with job {job!r} waits for it (or says it's not there)"}
    return job_result(b, job, time.time() + min(timeout_s + 15, WAIT_S))


@app.tool(name="box_send", schema={
    "type": "object",
    "properties": {
        "folder": {"type": "string", "description": "A folder here."},
        "to": {"type": "string", "description": "Where on the box (default /root/work/<the folder's name>)."},
        "exclude": {"type": "array", "items": {"type": "string"}, "description": "rsync patterns left out (default .git, node_modules, .DS_Store; [] sends everything)."},
        "delete": {"type": "boolean", "description": "Delete files there that aren't here (default true), so the copy matches."},
        "box": {"type": "string", "description": "The box's id or name (default the live one)."},
    },
    "required": ["folder"],
})
def send(folder, to=None, exclude=None, delete=True, box=None):
    "Sends a folder here to the box with rsync (only what changed after the first time), and answers where it is there and its size. rsync keeps the files' times: fine for bun and tsc, but a build cache judged by mtime (cargo) wants the sources touched there first."
    state["calls"] += 1
    b = find(box)
    src = os.path.abspath(os.path.expanduser(folder))
    if not os.path.isdir(src):
        raise ValueError(f"folder: {src} isn't a folder here")
    to = (to or f"/root/work/{os.path.basename(src.rstrip('/'))}").rstrip("/")
    rsync = shutil.which("rsync") or "/usr/bin/rsync"
    code, out, err = remote(b, f"command -v rsync >/dev/null && mkdir -p {shlex.quote(to)}", timeout=30)
    if code != 0:
        raise RuntimeError(f"{b['name']} isn't ready for rsync (exit {code}): {(text(err) or text(out)).strip()[-300:]}")
    argv = [rsync, "-az", "-e", " ".join(shlex.quote(a) for a in ssh(b)[:-1])]
    if delete:
        argv.append("--delete")
    for pat in EXCLUDE if exclude is None else exclude:
        argv += ["--exclude", pat]
    argv += [src + "/", f"{ssh(b)[-1]}:{to}/"]
    t = time.time()
    try:
        done = subprocess.run(argv, capture_output=True, timeout=WAIT_S, env=dict(os.environ, COPYFILE_DISABLE="1"))
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"rsync took over {WAIT_S} s: send a smaller folder, or exclude more")
    if done.returncode != 0:
        raise RuntimeError(f"rsync said (exit {done.returncode}): {(text(done.stderr) or text(done.stdout)).strip()[-800:]}")
    code, out, _ = remote(b, f"du -sh {shlex.quote(to)} | cut -f1; find {shlex.quote(to)} -type f | wc -l", timeout=60)
    size, _, files = text(out).strip().partition("\n")
    return {"box": b["name"], "to": to, "size": size or None, "files": int(files) if files.strip().isdigit() else None,
            "seconds": round(time.time() - t, 1)}


@app.tool(name="box_status", read_only=True)
def status():
    "Its boxes Hetzner holds now (id, IP, type, delete-by, cost so far), the project's cores in use, and boxes deleted in the last day with what they cost."
    boxes = mine()
    used, count = cores_in_use()
    held = {str(b["id"]) for b in boxes}
    gone = [dict(view(r), deleted=cfd.pt(r["deleted_at"]), verified_clean=r.get("verified_clean"), left=r.get("left"))
            for k, r in records().items() if k not in held and r.get("deleted_at") and now_ms() - r["deleted_at"] < 86_400_000]
    return {"boxes": [view(b) for b in boxes], "project": {"servers": count, "cores_in_use": used},
            "deleted": [{k: v for k, v in g.items() if k not in ("ssh", "status")} for g in gone],
            "last_reap": state["last_reap"]}


def delete_now(b, wait_s=120):
    """Deletes a box and checks Hetzner holds nothing of it (the server, its primary IPs, volumes, images)."""
    try:
        hetzner.api("DELETE", f"/servers/{b['id']}")
    except hetzner.HetznerError as e:
        if e.status != 404:
            raise
    end = time.time() + wait_s
    left = None
    while True:
        left = cfd.leftovers(b["id"])
        if left is not None and b.get("ip"):  # its IPv4 kept apart from the server would still bill
            ips = hetzner.api("GET", "/primary_ips?per_page=50").get("primary_ips") or []
            left += [f"primary IP {ip['ip']}" for ip in ips if ip.get("ip") == b["ip"] and ip.get("assignee_id") != b["id"]]
        if left == [] or time.time() >= end:
            break
        time.sleep(5)
    b["deleted_at"] = now_ms()
    b["status"] = "deleted"
    b["verified_clean"] = left == []
    b["left"] = left if left is not None else ["the server (still deleting)"]
    keep(b)
    state["deleted"] += 1
    return b


@app.tool(name="box_delete", schema={
    "type": "object",
    "properties": {"box": {"type": "string", "description": "The box's id or name (default every box of its own)."}},
})
def delete(box=None):
    "Deletes the box now (default every box it rented) and checks Hetzner holds nothing of it: no server, no primary IP, no volume or image. Answers what each cost."
    state["calls"] += 1
    boxes = mine()
    if box:
        boxes = [b for b in boxes if str(box) in (str(b["id"]), b["name"])]
        if not boxes:
            raise ValueError(f"no box {box!r} on Hetzner: box_status lists them")
    out = []
    for b in boxes:
        b = delete_now(b)
        spent, hours = hetzner.cost(b["created"], b["deleted_at"], b.get("price_hourly"))
        out.append({"id": b["id"], "name": b["name"], "verified_clean": b["verified_clean"], "left": b["left"],
                    "cost": f"{spent} {b.get('currency')} ({hours} h started)" if spent is not None else None})
    return {"deleted": out}


def reap():
    """Deletes any box of its own past its delete-by (or a day old, when its label went missing)."""
    try:
        boxes = mine()
    except hetzner.HetznerError as e:
        state["last_error"] = f"reaping: {e}"
        return []
    gone = []
    for b in boxes:
        due = b.get("delete_by") or ((b.get("created") or now_ms()) + MAX_HOURS * 3_600_000)
        if now_ms() > due:
            try:
                delete_now(b, wait_s=0)
                gone.append(b["name"])
            except hetzner.HetznerError as e:
                state["last_error"] = f"reaping {b['name']}: {e}"
    state["last_reap"] = {"at": cfd.pt(now_ms()), "deleted": gone}
    return gone


def health():
    "How box is: its token, its boxes, its last reap and error."
    return dict(state, token=bool(hetzner.token()), boxes=[r["name"] for r in records().values() if not r.get("deleted_at")])


@app.background
def loop():
    while True:
        try:
            if hetzner.token():
                reap()
        except Exception as e:  # noqa: BLE001
            state["last_error"] = f"reaping: {type(e).__name__}: {e}"
        time.sleep(REAP_S)
