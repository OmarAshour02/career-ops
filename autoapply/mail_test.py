"""Offline sender regression tests. All SMTP and credentials are mocked."""
import importlib.util
import json
import tempfile
import unittest
from datetime import timedelta
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("autoapply_mail", Path(__file__).with_name("mail.py"))
mail = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mail)


class MailTests(unittest.TestCase):
    def setUp(self):
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
