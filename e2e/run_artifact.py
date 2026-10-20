"""Crash-safe journal for the browser runner; snapshots contain public panel data only."""
import json
import os
import pathlib


def write_run_artifact(out, artifact):
    """Retain the previous valid JSON until a complete replacement is on disk."""
    target = pathlib.Path(out) / "run.json"
    temporary = target.with_suffix(".json.tmp")
    with temporary.open("w") as stream:
        json.dump(artifact, stream, ensure_ascii=False, allow_nan=False)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(target)


def initial_run_artifact():
    return {
        "status": "partial",
        "message": "Runner started; no controller artifact is available yet",
        "answer": "",
        "record": [],
        "artifact_incomplete": True,
        "artifact_source": "runner",
    }


def panel_run_artifact(panel):
    """Visible UI is a partial fallback, never a substitute for the full run download."""
    visible = panel.evaluate("""() => {
      const text = selector => document.querySelector(selector)?.innerText || '';
      return {
        panel_status: text('#status'),
        answer: text('#answerText'),
        log_rows: [...document.querySelectorAll('#log li')].map(el => el.innerText)
      };
    }""")
    return {
        **initial_run_artifact(),
        **visible,
        "message": "Public panel snapshot; full controller artifact is not available",
        "artifact_source": "public_panel",
    }


def save_download_artifact(out, download):
    """Validate the full downloaded JSON before replacing the last good snapshot."""
    temporary = pathlib.Path(out) / "run.download.json"
    try:
        download.save_as(str(temporary))
        artifact = json.loads(temporary.read_text())
        if not isinstance(artifact, dict):
            raise ValueError("Downloaded run artifact must be a JSON object")
        write_run_artifact(out, artifact)
    finally:
        temporary.unlink(missing_ok=True)
