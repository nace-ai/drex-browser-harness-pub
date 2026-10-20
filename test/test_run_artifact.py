"""Disk/process boundary regressions; no model or external network calls."""
import json
import pathlib
import select
import signal
import subprocess
import sys
import tempfile
import unittest

MODULE_DIR = pathlib.Path(__file__).resolve().parents[1] / "e2e"
sys.path.insert(0, str(MODULE_DIR))
from run_artifact import initial_run_artifact, panel_run_artifact, save_download_artifact, write_run_artifact

CHILD = r"""
import os, pathlib, signal, sys
sys.path.insert(0, sys.argv[1])
from run_artifact import initial_run_artifact, write_run_artifact
out, mode = pathlib.Path(sys.argv[2]), sys.argv[3]
write_run_artifact(out, initial_run_artifact())
if mode != "startup":
    write_run_artifact(out, {"status":"partial", "answer":"Order 42", "artifact_incomplete":True})
if mode == "interrupted":
    def pause_before_replace(fd):
        print("ready", flush=True)
        signal.pause()
    os.fsync = pause_before_replace
    write_run_artifact(out, {"status":"done", "answer":"Uncommitted answer"})
else:
    print("ready", flush=True)
    signal.pause()
"""

class ArtifactTests(unittest.TestCase):
    def test_process_death_keeps_complete_last_written_json(self):
        for mode, sig, answer in [("startup", signal.SIGTERM, ""),
                                  ("checkpoint", signal.SIGKILL, "Order 42"),
                                  ("interrupted", signal.SIGKILL, "Order 42")]:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                process = subprocess.Popen([sys.executable, "-c", CHILD, str(MODULE_DIR), directory, mode],
                                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                try:
                    self.assertTrue(select.select([process.stdout], [], [], 5)[0])
                    self.assertEqual(process.stdout.readline().strip(), "ready")
                    process.send_signal(sig)
                    process.wait(timeout=5)
                    artifact = json.loads((pathlib.Path(directory) / "run.json").read_text())
                    self.assertEqual(artifact["answer"], answer)
                    self.assertEqual(artifact["status"], "partial")
                    self.assertTrue(artifact["artifact_incomplete"])
                finally:
                    if process.poll() is None:
                        process.kill()
                        process.wait()
                    process.stdout.close()
                    process.stderr.close()

    def test_real_runner_startup_persists_before_browser_launch(self):
        child = r"""
import runpy, signal, sys, types
sys.path.insert(0, sys.argv[1])
class LaunchBoundary:
    def __enter__(self):
        print("ready", flush=True)
        signal.pause()
    def __exit__(self, *args):
        pass
playwright = types.ModuleType("playwright")
sync = types.ModuleType("playwright.sync_api")
sync.sync_playwright = LaunchBoundary
sync.TimeoutError = type("TimeoutError", (Exception,), {})  # run.py catches Playwright's own timeout
sys.modules["playwright"] = playwright
sys.modules["playwright.sync_api"] = sync
runner, directory = sys.argv[2:4]
sys.argv = [runner, "Read public page", "--out", directory]
runpy.run_path(runner, run_name="__main__")
"""
        with tempfile.TemporaryDirectory() as directory:
            process = subprocess.Popen([sys.executable, "-c", child, str(MODULE_DIR), str(MODULE_DIR / "run.py"), directory],
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                self.assertTrue(select.select([process.stdout], [], [], 5)[0])
                self.assertEqual(process.stdout.readline().strip(), "ready")
                process.kill()
                process.wait(timeout=5)
                artifact = json.loads((pathlib.Path(directory) / "run.json").read_text())
                self.assertTrue(artifact["artifact_incomplete"])
                self.assertEqual(artifact["status"], "partial")
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()
                process.stdout.close()
                process.stderr.close()

    def test_invalid_download_preserves_partial_then_valid_download_replaces_it(self):
        class Download:
            def __init__(self, body):
                self.body = body
            def save_as(self, path):
                pathlib.Path(path).write_text(self.body)
        with tempfile.TemporaryDirectory() as directory:
            write_run_artifact(directory, {**initial_run_artifact(), "answer":"Known fact"})
            with self.assertRaises(json.JSONDecodeError):
                save_download_artifact(directory, Download('{"broken":'))
            path = pathlib.Path(directory) / "run.json"
            self.assertEqual(json.loads(path.read_text())["answer"], "Known fact")
            save_download_artifact(directory, Download('{"status":"done","record":[{"event":"read"}],"answer":"Final"}'))
            self.assertEqual(json.loads(path.read_text()), {"status":"done","record":[{"event":"read"}],"answer":"Final"})
            self.assertFalse((path.parent / "run.download.json").exists())

    def test_public_dom_snapshot_is_partial_even_when_panel_says_done(self):
        from playwright.sync_api import sync_playwright
        with sync_playwright() as browser_driver:
            browser = browser_driver.chromium.launch(headless=True)
            try:
                page = browser.new_page()
                page.set_content('<div id="status">Done</div><div id="answerText">Order 42</div><ol id="log"><li>Read order</li><li>Cost 0.003</li></ol>')
                artifact = panel_run_artifact(page)
                self.assertEqual(artifact["answer"], "Order 42")
                self.assertEqual(artifact["panel_status"], "Done")
                self.assertEqual(artifact["log_rows"], ["Read order", "Cost 0.003"])
                self.assertTrue(artifact["artifact_incomplete"])
                self.assertEqual(artifact["status"], "partial")
            finally:
                browser.close()

if __name__ == "__main__":
    unittest.main()
