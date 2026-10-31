"""Offline sender regression tests. All SMTP and credentials are mocked."""
import importlib.util
import json
import re
import tempfile
import unittest
from datetime import timedelta
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("autoapply_mail", Path(__file__).with_name("mail.py"))
mail = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mail)


class FakeImap:
    """Just enough of Gmail's IMAP: mail is a list of {"from", "In-Reply-To", "References", "body"}."""

    def __init__(self, mail_list=(), fail_login=False):
        self.mail, self.fail_login, self.folder = list(mail_list), fail_login, None

    def __call__(self, *_a, **_k):
        return self

    def login(self, *_a):
        if self.fail_login:
            raise OSError("imap down")

    def logout(self):
        pass

    def list(self):
        return "OK", [b'(\\HasNoChildren) "/" "INBOX"', b'(\\All \\HasNoChildren) "/" "[Gmail]/All Mail"']

    def select(self, folder, readonly=False):
        self.folder = folder
        return "OK", [b"1"]

    def search(self, _charset, query):
        excluded = re.findall(r'NOT FROM "([^"]+)"', query)
        query = re.sub(r'NOT FROM "[^"]+"', "", query)
        wanted = re.findall(r'FROM "([^"]+)"', query)
        header = re.search(r'HEADER (\S+) "([^"]+)"', query)
        body = re.search(r'BODY "([^"]+)"', query)
        hits = []
        for i, m in enumerate(self.mail, 1):
            sender = m["from"].lower()
            if any(x in sender for x in excluded) or not all(w in sender for w in wanted):
                continue
            if header and header.group(2) not in m.get(header.group(1), ""):
                continue
            if body and body.group(1) not in m.get("body", ""):
                continue
            hits.append(str(i))
        return "OK", [" ".join(hits).encode()]

    def fetch(self, mid, _spec):
        return "OK", [(b"header", f'From: {self.mail[int(mid) - 1]["from"]}\r\n\r\n'.encode()), b")"]


class MailTests(unittest.TestCase):
    def setUp(self):
        self.imap = FakeImap()
        p = patch.object(mail.imaplib, "IMAP4_SSL", self.imap); p.start(); self.addCleanup(p.stop)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        out = root / "autoapply" / "outreach"
        out.mkdir(parents=True)
        self.root, self.out = root, out
        for name, value in [("ROOT", root), ("OUT", out), ("PDF", root / "absent.pdf")]:
            p = patch.object(mail, name, value); p.start(); self.addCleanup(p.stop)
        # Fixed settings, so the tests never depend on the owner's config/apply-facts.yml.
        facts = 'outreach_email_since: "2026-01-01"\ncold_email_since: "2026-01-01"\n'
        p = patch.object(mail, "FACTS", facts); p.start(); self.addCleanup(p.stop)
        p = patch.object(mail, "env", return_value=("sender@example.com", "fake")); p.start(); self.addCleanup(p.stop)
        p = patch.object(mail, "email_check", return_value=(True, "mx ok")); p.start(); self.addCleanup(p.stop)
        p = patch.object(mail.time, "sleep"); self.sleep = p.start(); self.addCleanup(p.stop)
        self.path = out / "001.json"
        self.row = {"num": "001", "company": "Example", "role": "Engineer", "status": "ready", "to_email": "recipient@example.com", "to_name": "Example Person", "body": "Hello", "subject": "Role", "email_evidence": ["https://example.com/team"]}
        mail.save(self.path, self.row)

    def read(self):
        return json.loads(self.path.read_text())

    def test_sends_are_spaced_and_invalid_addresses_skipped(self):
        mail.save(self.out / "002.json", {**self.row, "num": "002", "company": "Other", "to_email": "b@other.com"})
        mail.save(self.out / "003.json", {**self.row, "num": "003", "company": "Third", "to_email": "c@third.com"})
        checks = {"recipient@example.com": (True, "mx ok"), "b@other.com": (False, "domain has no mail server"), "c@third.com": (True, "mx ok")}
        with patch.object(mail, "email_check", side_effect=lambda a: checks[a]), patch.object(mail, "smtp_send") as smtp:
            mail.cmd_send(False)
        self.assertEqual(smtp.call_count, 2)
        self.sleep.assert_called_once_with(mail.GAP_SECONDS)
        self.assertIn("invalid email", json.loads((self.out / "002.json").read_text())["skip"])

    def test_ambiguous_send_is_persisted_and_not_retried(self):
        with patch.object(mail, "smtp_send", side_effect=RuntimeError("disconnected")) as smtp:
            with self.assertRaises(RuntimeError):
                mail.cmd_send(False)
            self.assertEqual(self.read()["send_state"], "uncertain")
            self.assertIn("message_id", self.read())
            mail.cmd_send(False)
            self.assertEqual(smtp.call_count, 1)

    def test_success_is_only_sent_once(self):
        with patch.object(mail, "smtp_send") as smtp:
            mail.cmd_send(False); mail.cmd_send(False)
            self.assertEqual(smtp.call_count, 1)
            self.assertEqual(self.read()["send_state"], "sent")

    def test_uncertain_delivery_reserves_daily_cap_and_recipient(self):
        self.row.update(send_state="uncertain", sending_at=mail.now().isoformat())
        mail.save(self.path, self.row)
        self.assertEqual(mail.sent_today(mail.load_all()), 1)
        other = {**self.row, "num": "002"}
        del other["send_state"]; del other["sending_at"]
        mail.save(self.out / "002.json", other)
        with patch.object(mail, "smtp_send") as smtp:
            mail.cmd_send(False)
            smtp.assert_not_called()

    def test_dry_run_does_not_mutate_invalid_draft(self):
        self.row["body"] = ""; mail.save(self.path, self.row)
        before = self.path.read_bytes()
        with patch.object(mail, "smtp_send") as smtp:
            mail.cmd_send(True)
            smtp.assert_not_called()
        self.assertEqual(self.path.read_bytes(), before)

    def test_followup_failure_is_not_retried(self):
        self.row.update(sent_at=(mail.now() - timedelta(days=10)).isoformat(), message_id="<old@example.com>")
        mail.save(self.path, self.row)
        with patch.object(mail, "smtp_send", side_effect=RuntimeError("disconnected")) as smtp:
            with self.assertRaises(RuntimeError):
                mail.cmd_followup(False)
            mail.cmd_followup(False)
            self.assertEqual(smtp.call_count, 1)
            self.assertEqual(self.read()["followup_state"], "uncertain")

    def test_replied_contact_gets_no_followup(self):
        self.row.update(sent_at=(mail.now() - timedelta(days=10)).isoformat(), replied_at=mail.now().isoformat())
        mail.save(self.path, self.row)
        with patch.object(mail, "smtp_send") as smtp:
            mail.cmd_followup(False)
            smtp.assert_not_called()

    def test_no_followup_where_owner_is_interviewing(self):
        self.row.update(sent_at=(mail.now() - timedelta(days=10)).isoformat(), message_id="<old@example.com>")
        mail.save(self.path, self.row)
        (self.root / "data").mkdir()
        (self.root / "data" / "applications.md").write_text("| 1 | 2026-10-01 | Example | Engineer | 3/5 | Interview | ✅ | | |\n")
        with patch.object(mail, "smtp_send") as smtp:
            mail.cmd_followup(False)
            smtp.assert_not_called()

    def test_in_process_list_from_facts_blocks_followup(self):
        self.row.update(sent_at=(mail.now() - timedelta(days=10)).isoformat(), message_id="<old@example.com>")
        mail.save(self.path, self.row)
        with patch.object(mail, "FACTS", mail.FACTS + "in_process_companies: [ Google, Example ] # note\n"), patch.object(mail, "smtp_send") as smtp:
            mail.cmd_followup(False)
            smtp.assert_not_called()

    def due_for_followup(self, to_email="careers@example.com"):
        self.row.update(to_email=to_email, sent_at=(mail.now() - timedelta(days=10)).isoformat(), message_id="<old@example.com>")
        mail.save(self.path, self.row)

    def followups_sent(self):
        with patch.object(mail, "smtp_send") as smtp:
            mail.cmd_followup(False)
        return smtp.call_count

    def test_colleague_on_same_domain_counts_as_reply(self):
        self.due_for_followup()
        self.imap.mail = [{"from": "Founder <founder@example.com>"}]
        self.assertEqual(self.followups_sent(), 0)
        self.assertEqual(self.read()["reply_match"], "domain")
        self.assertTrue(self.read()["replied_at"])

    def test_subdomain_counts_but_lookalike_domain_does_not(self):
        self.due_for_followup()
        self.imap.mail = [{"from": "Spam <a@notexample.com>"}, {"from": "a@example.com.evil.net"}]
        self.assertEqual(self.followups_sent(), 1)
        self.assertNotIn("replied_at", self.read())
        self.row = self.read(); self.row.pop("followup_at"); self.row.pop("followup_state"); mail.save(self.path, self.row)
        self.imap.mail = [{"from": "Jobs <jobs@mail.example.com>"}]
        self.assertEqual(self.followups_sent(), 0)

    def test_stranger_on_shared_mail_provider_is_not_a_reply(self):
        self.due_for_followup("founder@gmail.com")
        self.imap.mail = [{"from": "Someone Else <other@gmail.com>"}]
        self.assertEqual(self.followups_sent(), 1)

    def test_reply_in_thread_from_any_address_counts(self):
        self.due_for_followup()
        self.imap.mail = [{"from": "Personal <someone@gmail.com>", "In-Reply-To": "<old@example.com>"}]
        self.assertEqual(self.followups_sent(), 0)
        self.assertEqual(self.read()["reply_match"], "thread")

    def test_own_mail_and_bounces_in_the_thread_are_not_replies(self):
        self.due_for_followup()
        self.imap.mail = [{"from": "sender@example.com", "References": "<old@example.com>"},
                          {"from": "mailer-daemon@googlemail.com", "References": "<old@example.com>", "body": "careers@example.com"}]
        self.assertEqual(self.followups_sent(), 0)
        self.assertNotIn("replied_at", self.read())
        self.assertTrue(self.read()["bounced"])

    def test_archived_replies_are_seen(self):
        self.due_for_followup()
        self.followups_sent()
        self.assertEqual(self.imap.folder, '"[Gmail]/All Mail"')

    def test_no_followups_when_reply_check_fails(self):
        self.due_for_followup()
        self.imap.fail_login = True
        with patch.object(mail, "smtp_send") as smtp:
            with self.assertRaises(OSError):
                mail.cmd_followup(False)
            smtp.assert_not_called()

    def test_no_followup_after_rejected_or_discarded_row(self):
        for status in ("Rejected", "Discarded"):
            self.due_for_followup()
            (self.root / "data").mkdir(exist_ok=True)
            (self.root / "data" / "applications.md").write_text(f"| 1 | 2026-10-01 | Example | Engineer | 3/5 | {status} | ✅ | | |\n")
            self.assertEqual(self.followups_sent(), 0, status)

    def test_automated_senders_are_not_replies(self):
        for sender in ("noreply", "no-reply", "no_reply", "no.reply", "NoReply", "donotreply", "do-not-reply", "careers-noreply",
                       "no-reply+abc", "notifications", "notification-jobs", "alerts", "mailer", "bounces", "auto-reply", "autoresponder"):
            with self.subTest(sender):
                self.imap.mail = [{"from": f"Example Hiring <{sender}@example.com>", "In-Reply-To": "<old@example.com>"}]
                self.assertIsNone(mail.reply_match(self.imap, {"sent_at": mail.now().isoformat(), "message_id": "<old@example.com>", "to_email": "careers@example.com"}, "sender@example.com"))

    def test_people_with_similar_addresses_still_count(self):
        for sender in ("noah", "newsom", "alerta", "jobs", "recruiting", "nora.reply", "automation-lead", "updatesmith"):
            with self.subTest(sender):
                self.imap.mail = [{"from": f"{sender}@example.com"}]
                self.assertEqual(mail.reply_match(self.imap, {"sent_at": mail.now().isoformat(), "to_email": "careers@example.com"}, "sender@example.com"), "domain")

    def test_noreply_mail_leaves_the_followup_due(self):
        self.due_for_followup()
        self.imap.mail = [{"from": "No Reply <noreply@example.com>"}]
        self.assertEqual(self.followups_sent(), 1)
        self.assertNotIn("replied_at", self.read())

    def test_person_next_to_noreply_mail_still_counts(self):
        self.due_for_followup()
        self.imap.mail = [{"from": "noreply@example.com"}, {"from": "founder@example.com"}]
        self.assertEqual(self.followups_sent(), 0)
        self.assertEqual(self.read()["reply_match"], "domain")

    def second_row(self, **fields):
        other = {**self.read(), "num": "002", **fields}
        for key in ("followup_at", "followup_state", "followup_sending_at", "followup_message_id"):
            other.pop(key, None)
        path = self.out / "002.json"
        mail.save(path, other)
        return path

    def test_repeat_runs_send_one_followup(self):
        self.due_for_followup()
        self.assertEqual(self.followups_sent(), 1)
        self.assertEqual(self.followups_sent(), 0)

    def test_one_followup_per_company_across_rows(self):
        self.due_for_followup()
        self.second_row(to_email="other@elsewhere.com")
        self.assertEqual(self.followups_sent(), 1)
        self.assertEqual(self.followups_sent(), 0)

    def test_one_followup_per_domain_and_address_across_rows(self):
        self.due_for_followup()
        self.second_row(company="Renamed Inc", to_email="other@example.com")
        self.assertEqual(self.followups_sent(), 1)
        self.second_row(company="Third Inc", to_email="careers@example.com", num="003")
        self.assertEqual(self.followups_sent(), 0)

    def test_failed_followup_blocks_the_rest_of_the_company(self):
        self.due_for_followup()
        self.row.update(followup_state="uncertain"); mail.save(self.path, self.row)
        self.second_row(to_email="other@example.com")
        self.assertEqual(self.followups_sent(), 0)

    def test_reply_on_one_row_stops_followups_on_the_other(self):
        self.due_for_followup()
        self.row.update(replied_at=mail.now().isoformat()); mail.save(self.path, self.row)
        self.second_row(to_email="other@elsewhere.com")
        self.assertEqual(self.followups_sent(), 0)

    def test_different_people_on_a_shared_provider_each_get_one(self):
        self.due_for_followup("a@gmail.com")
        self.second_row(company="Other", to_email="b@gmail.com")
        self.assertEqual(self.followups_sent(), 2)

    def test_overlapping_mail_operations_are_rejected(self):
        with mail.mail_lock():
            with self.assertRaisesRegex(RuntimeError, "Another mail operation"):
                with mail.mail_lock():
                    self.fail("second operation acquired lock")


class ValidityTests(unittest.TestCase):
    def test_null_mx_and_missing_domain_are_invalid(self):
        with patch.object(mail.subprocess, "run") as run:
            run.return_value.returncode = 0
            run.return_value.stdout = "0 .\n"
            self.assertFalse(mail.mail_domain_ok("a@example.com"))
            run.return_value.stdout = ""
            self.assertFalse(mail.mail_domain_ok("a@nope.invalid"))
            run.return_value.stdout = "10 mx.example.org.\n"
            self.assertTrue(mail.mail_domain_ok("a@example.org"))

    def test_hunter_invalid_blocks_and_dns_failure_holds(self):
        with patch.object(mail, "mail_domain_ok", return_value=True), patch.object(mail, "hunter_status", return_value="invalid"):
            self.assertEqual(mail.email_check("a@x.com"), (False, "hunter invalid"))
        with patch.object(mail, "mail_domain_ok", return_value=None):
            self.assertIsNone(mail.email_check("a@x.com")[0])


class LinkTests(unittest.TestCase):
    def test_verify_link_is_picked_over_other_links(self):
        body = ('<a href="https://acme.wd5.myworkdayjobs.com/privacy">Privacy</a>'
                '<a href="https://acme.wd5.myworkdayjobs.com/en-US/careers/activate/abc123?redirect=x&amp;y=1">Verify</a>'
                '<a href="https://x.com/unsubscribe?token=1">Unsubscribe</a>')
        self.assertEqual(mail.extract_link(body), "https://acme.wd5.myworkdayjobs.com/en-US/careers/activate/abc123?redirect=x&y=1")

    def test_no_link_when_only_unsubscribe(self):
        self.assertIsNone(mail.extract_link("Hi https://x.com/unsubscribe?confirm=1 bye"))


if __name__ == "__main__":
    unittest.main()
