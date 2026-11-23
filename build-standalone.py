"""Refresh the embedded CSS and JavaScript in the downloadable index.html."""

import re
from pathlib import Path

root = Path(__file__).resolve().parent
page = root / "index.html"
html = page.read_text(encoding="utf-8")
css = (root / "style.css").read_text(encoding="utf-8").rstrip()
model = (root / "simulation.mjs").read_text(encoding="utf-8").rstrip()
audio = (root / "audio.mjs").read_text(encoding="utf-8").rstrip()
app = (root / "app.mjs").read_text(encoding="utf-8").rstrip()
model = re.sub(r"^export ", "", model, flags=re.MULTILINE)
audio = re.sub(r"^export ", "", audio, flags=re.MULTILINE)
app = re.sub(r"^import .*\n", "", app, flags=re.MULTILINE).lstrip()

for pattern, content in [
    (r'<script id="wfo-peer">.*?</script>',
     '<script id="wfo-peer">' + (root / "vendor" / "peerjs.min.js").read_text(encoding="utf-8") + '</script>'),
    (r'<link rel="stylesheet" href="style\.css">|<style id="wfo-style">.*?</style>',
     f'<style id="wfo-style">\n{css}\n</style>'),
    (r'<script type="module" src="app\.mjs"></script>|<script id="wfo-code">.*?</script>',
     f'<script id="wfo-code">\n(() => {{\n"use strict";\n{model}\n\n{audio}\n\n{app}\n}})();\n</script>'),
]:
    html, changed = re.subn(pattern, lambda _: content, html, count=1, flags=re.DOTALL)
    if changed != 1:
        raise SystemExit("Missing standalone template marker")

page.write_text(html, encoding="utf-8")
