#!/usr/bin/env python3
"""Outreach mailer: send ready emails, follow up once, detect replies/bounces.

Usage:
  python3 -I autoapply/mail.py send [--dry-run]
  python3 -I autoapply/mail.py followup [--dry-run]
  python3 -I autoapply/mail.py check
  python3 -I autoapply/mail.py status
  python3 -I autoapply/mail.py room      (sends left today after waiting drafts)
  python3 -I autoapply/mail.py code --since EPOCH [--from HINT] [--wait 180]
                                        (print the newest verification code mailed after EPOCH)
  python3 -I autoapply/mail.py login      (check the Gmail address + app password; prints "ok")
  python3 -I autoapply/mail.py inbox --after-uid N [--since YYYY-MM-DD] [--limit 2000]
                                        (JSON list of inbox mail newer than UID N, read-only)

State lives in each autoapply/outreach/NNN.json (sent_at, message_id, followup_at,
replied_at, bounced). Credentials come from career-ops/.env.
"""
import email.utils
import imaplib
import json
import re
import smtplib
import sys
import os
import fcntl
import shutil
import subprocess
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "autoapply" / "outreach"
FACTS = (ROOT / "config" / "apply-facts.yml").read_text()


def fact_str(key, default=""):
    """First `key: value` in apply-facts.yml (keys used here are unique in the file)."""
    m = re.search(rf"^\s*{key}:[ \t]*['\"]?([^'\"#\n]*?)['\"]?[ \t]*(#.*)?$", FACTS, re.M)
    return m.group(1).strip() if m else default


NAME = fact_str("full_name")
PDF = ROOT / fact_str("pdf", "output/master/resume.pdf")
PDF_NAME = fact_str("send_as") or PDF.name


def allowed(d):
    """The owner's recorded OK (consent in apply-facts.yml) for this kind of email."""
    return bool(fact_str("cold_email_since" if d.get("kind") == "startup" else "outreach_email_since"))


def env():
    vals = {}
    for line in (ROOT / ".env").read_text().splitlines():
        if "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            vals[k.strip()] = v.strip()
    return vals["GMAIL_USER"], vals["GMAIL_APP_PASSWORD"]


def fact_int(key, default):
    m = re.search(rf"^\s*{key}:\s*(\d+)", FACTS, re.M)
    return int(m.group(1)) if m else default


MAX_PER_DAY = fact_int("max_emails_per_day", 25)
FOLLOW_DAYS = fact_int("follow_up_after_days", 5)
GAP_SECONDS = fact_int("seconds_between_emails", 120)
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[a-z]{2,}$", re.I)


def now():
    return datetime.now(timezone.utc)


def mail_domain_ok(addr):
    """True: domain has a mail server. False: it can't receive mail. None: DNS check failed."""
    domain = addr.rsplit("@", 1)[1]
    for rtype in ("MX", "A"):
        try:
            out = subprocess.run(["dig", "+short", "+time=3", "+tries=2", rtype, domain],
                                 capture_output=True, text=True, timeout=20)
        except Exception:
            return None
        if out.returncode != 0:
            return None
        words = out.stdout.split()
        if rtype == "MX":
            hosts = [w for w in words if not w.isdigit()]
            if hosts == ["."]:
                return False  # null MX (RFC 7505): domain says it accepts no mail
            if hosts:
                return True
        elif words:
            return True  # no MX, but an A record means mail goes to the host itself
    return False


def hunter_status(addr):
    """Hunter verifier status, or None when there is no key / no node / an error."""
    node = shutil.which("node")
    if not node:
        return None
    try:
        r = subprocess.run([node, str(ROOT / "autoapply" / "hunter.mjs"), "verify", addr],
                           capture_output=True, text=True, timeout=90)
        return json.loads(r.stdout).get("status") if r.returncode == 0 else None
    except Exception:
        return None


def email_check(addr):
    """(ok, detail). Port 25 is blocked here, so no direct mailbox probe."""
    mx = mail_domain_ok(addr)
    if mx is None:
        return None, "dns check failed"
    if not mx:
        return False, "domain has no mail server"
    status = hunter_status(addr)
    if status in ("invalid", "disposable"):
        return False, f"hunter {status}"
    return True, f"mx ok, hunter {status or 'not used'}"


def load_all():
    items = []
    for p in sorted(OUT.glob("*.json")):
        try:
            items.append((p, json.loads(p.read_text())))
        except json.JSONDecodeError:
            print(f"skip bad json {p.name}")
    return items


def save(p, d):
    temporary = p.with_name(p.name + "." + uuid.uuid4().hex + ".tmp")
    temporary.write_text(json.dumps(d, indent=2, ensure_ascii=False))
    os.chmod(temporary, 0o600)
    temporary.replace(p)


@contextmanager
def mail_lock():
    """All local mail commands share an OS lock; process death releases it."""
    with (ROOT / "autoapply" / ".mail.lock").open("a") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("Another mail operation is running") from None
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def sent_today(items):
    today = now().date().isoformat()
    n = 0
    for _, d in items:
        for k in ("sent_at", "followup_at"):
            if str(d.get(k, "")).startswith(today):
                n += 1
        if not d.get("sent_at") and d.get("send_state") in ("sending", "uncertain") and str(d.get("sending_at", "")).startswith(today):
            n += 1
        if not d.get("followup_at") and d.get("followup_state") in ("sending", "uncertain") and str(d.get("followup_sending_at", "")).startswith(today):
            n += 1
    return n


def build(user, d, body, subject, reply_to_id=None, attach=True):
    msg = EmailMessage()
    msg["From"] = email.utils.formataddr((NAME, user))
    msg["To"] = email.utils.formataddr((d.get("to_name", ""), d["to_email"]))
    msg["Subject"] = subject
    msg["Date"] = email.utils.formatdate(localtime=True)
    msg["Message-ID"] = email.utils.make_msgid(domain="gmail.com")
    if reply_to_id:
        msg["In-Reply-To"] = reply_to_id
        msg["References"] = reply_to_id
    msg.set_content(body)
    if attach and PDF.exists():
        msg.add_attachment(PDF.read_bytes(), maintype="application", subtype="pdf",
                           filename=PDF_NAME)
    return msg


def smtp_send(msgs, dry):
    if dry:
        for m in msgs:
            print(f"--- DRY RUN to {m['To']} | {m['Subject']}\n{m.get_body().get_content()}")
        return
    user, pw = env()
    with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=30) as s:
        s.login(user, pw)
        for m in msgs:
            s.send_message(m)


def cmd_send(dry):
    items = load_all()
    left = MAX_PER_DAY - sent_today(items)
    reserved = [d for _, d in items if d.get("sent_at") or d.get("send_state") in ("sending", "uncertain")]
    contacted = {d["to_email"].lower() for d in reserved}
    companies = {d["company"].lower() for d in reserved}
    user, _ = env() if not dry else ("dry-run@example.com", None)
    sent = 0
    for p, d in items:
        if left <= 0:
            print(f"daily cap {MAX_PER_DAY} reached")
            break
        if (d.get("status") != "ready" or d.get("sent_at") or d.get("skip")
                or d.get("send_state") in ("sending", "uncertain") or d.get("bounced") or d.get("replied_at")):
            continue
        if not dry and not allowed(d):
            continue  # no consent for this kind of email: leave the draft as it is
        to = str(d.get("to_email", "")).strip()
        if not EMAIL_RE.match(to) or not d.get("email_evidence") or not d.get("body"):
            if not dry:
                d["skip"] = "missing email/evidence/body"; save(p, d)
            continue
        if to.lower() in contacted or d["company"].lower() in companies:
            if not dry:
                d["skip"] = "already contacted this person/company"; save(p, d)
            continue
        ok, detail = email_check(to)
        if ok is None:
            print(f"hold #{d['num']} {to}: {detail}; will retry next run")
            continue
        if not ok:
            if not dry:
                d["skip"] = f"invalid email: {detail}"; save(p, d)
            print(f"skip #{d['num']} {to}: {detail}")
            continue
        if sent and not dry:
            time.sleep(GAP_SECONDS)
        d["email_check"] = detail
        msg = build(user, d, d["body"], d["subject"])
        if not dry:
            d["send_state"] = "sending"
            d["message_id"] = msg["Message-ID"]
            d["sending_at"] = now().isoformat(timespec="seconds")
            save(p, d)
        try:
            smtp_send([msg], dry)
        except Exception:
            if not dry:
                d["send_state"] = "uncertain"; save(p, d)
            raise
        if not dry:
            d["sent_at"] = now().isoformat(timespec="seconds")
            d["send_state"] = "sent"
            save(p, d)
        contacted.add(to.lower()); companies.add(d["company"].lower())
        left -= 1; sent += 1
        print(f"sent #{d['num']} {d['company']} -> {d.get('to_name')} <{to}>")
    print(f"send: {sent} sent, {max(left, 0)} left today")


def cmd_followup(dry):
    items = load_all()
    left = MAX_PER_DAY - sent_today(items)
    user, _ = env() if not dry else ("dry-run@example.com", None)
    n = 0
    for p, d in items:
        if left <= 0:
            break
        if (not d.get("sent_at") or d.get("followup_at") or d.get("replied_at") or d.get("bounced")
                or d.get("followup_state") in ("sending", "uncertain")):
            continue
        if not dry and not allowed(d):
            continue
        if now() - datetime.fromisoformat(d["sent_at"]) < timedelta(days=FOLLOW_DAYS):
            continue
        body = d.get("followup_body") or (
            f"Hi {d.get('to_name', '').split(' ')[0]},\n\nJust a quick follow-up on my note about the "
            f"{d['role']} role. Happy to share more if useful.\n\nThanks,\n{NAME}")
        if n and not dry:
            time.sleep(GAP_SECONDS)
        msg = build(user, d, body, "Re: " + d["subject"], d.get("message_id"), attach=False)
        if not dry:
            d["followup_state"] = "sending"
            d["followup_message_id"] = msg["Message-ID"]
            d["followup_sending_at"] = now().isoformat(timespec="seconds")
            save(p, d)
        try:
            smtp_send([msg], dry)
        except Exception:
            if not dry:
                d["followup_state"] = "uncertain"; save(p, d)
            raise
        if not dry:
            d["followup_at"] = now().isoformat(timespec="seconds")
            d["followup_state"] = "sent"; save(p, d)
        left -= 1; n += 1
        print(f"follow-up #{d['num']} {d['company']} -> {d['to_email']}")
    print(f"followup: {n} sent")


def cmd_room():
    """Emails that can still go out today after the drafts already waiting."""
    items = load_all()
    waiting = sum(1 for _, d in items if d.get("status") == "ready" and not d.get("sent_at")
                  and not d.get("skip") and d.get("send_state") not in ("sending", "uncertain"))
    print(max(0, MAX_PER_DAY - sent_today(items) - waiting))


def cmd_check():
    """Mark replies (any mail from the recipient) and bounces (mailer-daemon naming them)."""
    items = [(p, d) for p, d in load_all() if d.get("sent_at") and not d.get("replied_at") and not d.get("bounced")]
    if not items:
        print("check: nothing to check"); return
    user, pw = env()
    im = imaplib.IMAP4_SSL("imap.gmail.com", timeout=30)
    im.login(user, pw)
    im.select("INBOX", readonly=True)
    since = min(datetime.fromisoformat(d["sent_at"]) for _, d in items).strftime("%d-%b-%Y")
    replies = bounces = 0
    for p, d in items:
        to = d["to_email"]
        typ, data = im.search(None, f'(SINCE {since} FROM "{to}")')
        if typ == "OK" and data[0].split():
            d["replied_at"] = now().isoformat(timespec="seconds"); save(p, d); replies += 1
            print(f"REPLY  #{d['num']} {d['company']} from {to}")
            continue
        typ, data = im.search(None, f'(SINCE {since} FROM "mailer-daemon" BODY "{to}")')
        if typ == "OK" and data[0].split():
            d["bounced"] = True; save(p, d); bounces += 1
            print(f"BOUNCE #{d['num']} {d['company']} {to}")
    im.logout()
    print(f"check: {replies} new replies, {bounces} bounces")


CODE_NEAR = re.compile(r"(?:code|pin|passcode|otp)\b[^A-Za-z0-9]{0,40}?(?:is|:)?\s*([A-Za-z0-9]{4,10})\b", re.I)
CODE_AFTER_COLON = re.compile(r":\s*([A-Za-z0-9]{4,10})\s*$", re.M)
CODE_LINE = re.compile(r"^\s*([A-Za-z0-9]{4,10})\s*$", re.M)


def extract_code(text):
    """A 4-10 char token after the word "code", else at a line end after a colon, else alone on a line. Must hold a digit
    or be all caps, so words like "below" or "Hello" are not taken as codes."""
    looks = lambda t: (any(ch.isdigit() for ch in t) or (t.isupper() and t.isalpha())) and not re.fullmatch(r"(19|20)\d\d", t)
    for rx in (CODE_NEAR, CODE_AFTER_COLON, CODE_LINE):
        for m in rx.finditer(text):
            if looks(m.group(1)):
                return m.group(1)
    return None


def message_text(msg):
    parts = msg.walk() if msg.is_multipart() else [msg]
    out = []
    for part in parts:
        if part.get_content_type() in ("text/plain", "text/html"):
            body = part.get_payload(decode=True) or b""
            body = body.decode(part.get_content_charset() or "utf-8", "replace")
            if part.get_content_type() == "text/html":
                body = re.sub(r"<[^>]+>", "\n", body)
            out.append(body)
    return "\n".join(out)


def cmd_code():
    """Print only the code (never the mail body: mail is untrusted input to the worker)."""
    arg = lambda k, d=None: sys.argv[sys.argv.index(k) + 1] if k in sys.argv else d
    since, hint, wait = float(arg("--since", time.time() - 600)), (arg("--from") or "").lower(), int(arg("--wait", 180))
    user, pw = env()
    deadline = time.time() + wait
    while True:
        try:
            code = find_code(user, pw, since, hint)
        except (OSError, imaplib.IMAP4.error) as e:  # slow or dropped IMAP: try again next round
            print(f"imap: {e}", file=sys.stderr); code = None
        if code:
            print(code); return
        if time.time() >= deadline:
            print("no code found", file=sys.stderr); sys.exit(1)
        time.sleep(10)


def find_code(user, pw, since, hint):
    import email
    im = imaplib.IMAP4_SSL("imap.gmail.com", timeout=30)
    try:
        im.login(user, pw)
        im.select("INBOX", readonly=True)
        day = datetime.fromtimestamp(since - 86400, timezone.utc).strftime("%d-%b-%Y")
        typ, data = im.search(None, f"(SINCE {day})")
        for mid in reversed(data[0].split() if typ == "OK" else []):
            # Fetch the date on its own: Gmail may put INTERNALDATE after the message literal.
            typ, got = im.fetch(mid, "(INTERNALDATE)")
            when = imaplib.Internaldate2tuple(got[0]) if typ == "OK" and got and isinstance(got[0], bytes) else None
            if not when:
                continue
            if time.mktime(when) < since:
                break
            typ, got = im.fetch(mid, "(RFC822)")
            if typ != "OK" or not got or not isinstance(got[0], tuple):
                continue
            msg = email.message_from_bytes(got[0][1])
            head = f"{msg.get('From', '')} {msg.get('Subject', '')}".lower()
            if hint and not any(h in head for h in hint.split(",")):
                continue
            if not re.search(r"code|verif|confirm|security|one.time", head):
                continue
            code = extract_code(f"{msg.get('Subject', '')}\n{message_text(msg)}")
            if code:
                return code
        return None
    finally:
        try:
            im.logout()
        except (OSError, imaplib.IMAP4.error):
            pass


def cmd_inbox():
    """Print new inbox mail as JSON (uid, date, from, subject, text) for inbox-sync.mjs. Read-only (BODY.PEEK)."""
    import email
    import email.header
    import html
    arg = lambda k, d=None: sys.argv[sys.argv.index(k) + 1] if k in sys.argv else d
    after, since, limit = int(arg("--after-uid", 0)), arg("--since"), int(arg("--limit", 2000))
    dec = lambda s: str(email.header.make_header(email.header.decode_header(s or ""))).replace("\n", " ")
    user, pw = env()
    im = imaplib.IMAP4_SSL("imap.gmail.com", timeout=60)
    im.login(user, pw)
    im.select("INBOX", readonly=True)
    crit = f"(UID {after + 1}:*)" if after else f"(SINCE {datetime.fromisoformat(since or now().date().isoformat()).strftime('%d-%b-%Y')})"
    typ, data = im.uid("SEARCH", None, crit)
    uids = [int(u) for u in (data[0].split() if typ == "OK" else []) if int(u) > after][:limit]
    out = []
    for uid in uids:
        typ, got = im.uid("FETCH", str(uid), "(BODY.PEEK[])")
        if typ != "OK" or not got or not isinstance(got[0], tuple):
            continue
        msg = email.message_from_bytes(got[0][1])
        text = ""
        for part in (msg.walk() if msg.is_multipart() else [msg]):
            kind = part.get_content_type()
            if kind not in ("text/plain", "text/html"):
                continue
            body = (part.get_payload(decode=True) or b"").decode(part.get_content_charset() or "utf-8", "replace")
            if kind == "text/html":
                body = re.sub(r"<(style|script)[^>]*>.*?</\1>", " ", body, flags=re.S | re.I)
                body = html.unescape(re.sub(r"<[^>]+>", " ", body))
            text = body
            if kind == "text/plain":
                break
        text = re.sub(r"\s+", " ", re.sub(r"https?://\S+", "", html.unescape(text))).strip()
        try:
            date = email.utils.parsedate_to_datetime(msg["Date"]).astimezone(timezone.utc).isoformat(timespec="seconds")
        except (TypeError, ValueError):
            date = now().isoformat(timespec="seconds")
        out.append({"uid": uid, "date": date, "from": dec(msg["From"]), "subject": dec(msg["Subject"]),
                    "message_id": (msg["Message-ID"] or "").strip(), "text": text[:6000]})
    im.logout()
    json.dump(out, sys.stdout)


def cmd_login():
    user, pw = env()
    im = imaplib.IMAP4_SSL("imap.gmail.com", timeout=30)
    try:
        im.login(user, pw)
    except imaplib.IMAP4.error as e:
        print(f"login failed for {user}: {e}"); sys.exit(1)
    im.logout()
    s = smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=30)
    s.login(user, pw)
    s.quit()
    print(f"ok: {user} can read (IMAP) and send (SMTP)")


def cmd_status():
    items = load_all()
    c = lambda f: sum(1 for _, d in items if f(d))
    print(f"outreach files: {len(items)} | ready unsent: {c(lambda d: d.get('status') == 'ready' and not d.get('sent_at') and not d.get('skip'))}"
          f" | no_contact: {c(lambda d: d.get('status') == 'no_contact')} | sent: {c(lambda d: d.get('sent_at'))}"
          f" | followed up: {c(lambda d: d.get('followup_at'))} | replies: {c(lambda d: d.get('replied_at'))}"
          f" | bounced: {c(lambda d: d.get('bounced'))} | sent today: {sent_today(items)}/{MAX_PER_DAY}")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    dry = "--dry-run" in sys.argv
    OUT.mkdir(parents=True, exist_ok=True)
    if cmd == "code":
        cmd_code(); sys.exit(0)  # read-only; must not wait behind a long send
    if cmd == "inbox":
        cmd_inbox(); sys.exit(0)  # read-only too
    if cmd == "login":
        cmd_login(); sys.exit(0)
    with mail_lock():
        {"send": lambda: cmd_send(dry), "followup": lambda: cmd_followup(dry),
         "check": cmd_check, "room": cmd_room, "status": cmd_status}.get(cmd, cmd_status)()
