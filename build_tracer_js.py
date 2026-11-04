"""Regenerate tracer.js from tracer.py (so the page also works when opened as a local file)."""
import json
import pathlib

here = pathlib.Path(__file__).parent
source = (here / "tracer.py").read_text(encoding="utf-8")
(here / "tracer.js").write_text(
    "// GENERATED from tracer.py by build_tracer_js.py. Do not edit by hand.\n"
    "window.TRACER_PY = " + json.dumps(source) + ";\n",
    encoding="utf-8",
)
print("wrote tracer.js")
