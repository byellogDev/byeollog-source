import importlib.util
import pathlib
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location("guard", pathlib.Path(__file__).with_name("research-resume-guard.py"))
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class ResumeTests(unittest.TestCase):
    def check_rows(self, text, expected):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            (root / "observer-b.jsonl").write_text(text, encoding="utf-8")
            self.assertEqual(guard.may_resume(root), expected)

    def test_new_segment(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertTrue(guard.may_resume(pathlib.Path(directory)))

    def test_offline_and_clean_shutdown(self):
        self.check_rows('{"kind":"waiting"}\n{"kind":"campaign_finished","stopped":true}\n', True)

    def test_review_cannot_be_hidden_by_shutdown(self):
        self.check_rows('{"kind":"needs_review"}\n{"kind":"campaign_finished"}\n', False)

    def test_partial_evidence_fails_closed(self):
        self.check_rows('{"kind":"waiting"}\n{"kind":', False)

    def test_oversized_evidence_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            with (root / "test.jsonl").open("wb") as stream:
                stream.truncate(32 * 1024 * 1024 + 1)
            self.assertFalse(guard.may_resume(root))


if __name__ == "__main__":
    unittest.main()
