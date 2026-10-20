"""The JS of src/<name> (.ts if it exists, else .js) with types stripped, for scripts that eval source in a browser."""
import subprocess
from pathlib import Path

def _esbuild(root):
    """The checkout's own esbuild, else the one in the repo root (a git worktree has no node_modules until npm install)."""
    here = Path(__file__).resolve().parents[1]
    names = [here, Path(root).resolve()]
    if here.parent.name == '.worktrees': names.append(here.parent.parent)
    for base in names:
        exe = base / 'node_modules/.bin/esbuild'
        if exe.exists(): return str(exe)
    raise FileNotFoundError('esbuild not found in ' + ', '.join(str(b / 'node_modules/.bin') for b in names) + '; run npm install')

def js_source(root, name):
    root = Path(root)
    path = root / 'src' / (name + '.ts')
    if not path.exists(): path = root / 'src' / (name + '.js')
    r = subprocess.run([_esbuild(root), str(path), '--log-level=error'], capture_output=True, text=True)
    if r.returncode: raise RuntimeError(f'esbuild failed on {path} (exit {r.returncode}):\n{r.stderr}')
    return r.stdout
