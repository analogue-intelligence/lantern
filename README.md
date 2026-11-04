# Python Visualizer

Run a Python program **one line at a time** and see what happens in memory: variables,
function calls (frames), lists/dicts/objects (with arrows for references) and printed output.
It is a modern take on Python Tutor, built for XB 0145 (Introduction to Python Programming for AI).

Real CPython 3.12 runs **inside the browser** (via [Pyodide](https://pyodide.org)), so there is
no server and students don't need to install anything.

## Using it

* **Locally:** double-click `index.html`. It needs an internet connection the first time,
  to download Python (~10 MB, cached by the browser afterwards).
* **For students:** put this folder on any static web host (GitHub Pages, VU web space,
  Canvas file area that serves HTML, …). Nothing needs to be built.

| Action | How |
|---|---|
| Run step by step | **▶ Visualize** or `Ctrl/⌘ + Enter` |
| Step forward / back | **Next / Back** buttons, `→` / `←`, slider, `Home` / `End` |
| Auto-play | **Play** (`Space`), with Slow / Normal / Fast |
| Run until a line | click the **line number** |
| Back to editing | click anywhere in the **code** (or **✏️ Edit code**) |
| Bigger text for the lecture hall | **A+** (remembered per browser) |
| Lists inside variables instead of arrows | **Inline** toggle (Memory panel) |
| Link that opens a program (at the current step) | **🔗 Share**, which copies a `#code=…&step=N` URL |

What students see at every step:

* ➜ the **next line to run** (blue) and the **line that just ran** (grey),
* **×N** next to each line: how many times that line has run (handy for loops),
* "What line 4 did" chips: `spam 0 → 1`, `new i = 0`, `printed Hello`, `called f(x=3)`,
* changed variables highlighted in yellow and new ones in green, in the Memory panel,
* friendly hints for common errors (`NameError`, `IndexError`, missing `:`, …).

`input()` works: when the program asks for input, a text box appears in the Output panel.

## Limits

* At most **1000 steps** per run, so infinite loops stop with a warning instead of freezing.
* A single step taking more than **20 s** is stopped (the Python engine is restarted).
* Only the Python standard library (`random`, `math`, … work; `pandas`, `turtle` and files don't).
* `input()` works by running the program again from the start with the extra answer. Random
  numbers use the same seed during one visualization, so `random` stays consistent.

## Files

| File | What |
|---|---|
| `index.html`, `styles.css`, `app.js` | the page and the UI (no build step) |
| `tracer.py` | records the execution with `sys.settrace` (runs inside Pyodide) |
| `tracer.js` | **generated** from `tracer.py`. Run `python3 build_tracer_js.py` after editing it |
| `vu-griffin.svg` | VU griffin (taken from the official `VU-logo-RGB.svg`), used as logo and favicon |
| `examples.js` | programs in the **Examples** menu. Add your own `{group, title, code}` entries |
| `test_tracer.py` | tests for the tracer: `python3 test_tracer.py` |
