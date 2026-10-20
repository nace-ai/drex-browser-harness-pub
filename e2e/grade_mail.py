"""Grades a mail-sorting run against e2e/mail_key.json: which folder each email ended in vs the right one.

Usage: python e2e/grade_mail.py runs/NAME [--spam-only]
--spam-only: the task was "move the spam to Spam, leave the rest": spam must be in Spam, everything else in the inbox."""
import json, pathlib, sys
from collections import Counter

run = pathlib.Path(sys.argv[1])
key = json.loads((pathlib.Path(__file__).parent / "mail_key.json").read_text())
state = json.loads(json.loads((run / "storage.json").read_text())["nwmail-state"])
spam_only = "--spam-only" in sys.argv
mapping = key["mappings"][",".join(state["folders"])]
if spam_only:
    mapping = {c: (mapping["spam"] if c == "spam" else None) for c in mapping}
right, wrong, unsorted, archived = 0, [], [], []
for mid, cat in key["categories"].items():
    want = mapping[cat]
    got = state["placed"].get(mid)
    if state["archived"].get(mid):
        archived.append(mid)
    elif got is None and want is None:
        right += 1
    elif got is None:
        unsorted.append(mid)
    elif got == want:
        right += 1
    else:
        wrong.append(f"#{mid} {cat}: put in {got}, should be {want or 'the inbox'}")
n = len(key["categories"])
print(f"folders {state['folders']}: {right}/{n} right, {len(wrong)} wrong, {len(unsorted)} left in inbox, {len(archived)} archived")
for w in wrong:
    print("  " + w)
print("per folder:", dict(Counter(state["placed"].values())))
