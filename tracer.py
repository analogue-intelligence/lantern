"""Execution tracer for the Python Visualizer.

Runs a student's program under ``sys.settrace`` and records a snapshot of the
program state (frames, variables, objects, printed output) before every line.
It runs inside Pyodide in the browser, and also under plain CPython for tests:

    import tracer, json
    trace = json.loads(tracer.run("x = 1\\nprint(x)"))

``input()`` is handled by re-execution: when the program asks for more input
than it was given, tracing stops with status ``need_input``. The page then asks
the user, and runs the program again from the start with one more input (and
the same random seed, so the run is identical up to that point).

After editing this file, regenerate tracer.js:  python3 build_tracer_js.py
"""
import builtins
import inspect
import io
import json
import random
import sys
import time
import types

FILENAME = "<program>"
MAX_STEPS = 1000      # stop runaway (infinite) loops
MAX_ITEMS = 100       # elements shown per list / dict / set
MAX_STR = 200         # characters shown per string
MAX_OBJECTS = 200     # objects shown per step

HINTS = {
    "NameError": "Python doesn't know this name. Check the spelling, and make sure the "
                 "variable gets a value before this line runs.",
    "UnboundLocalError": "This variable is used inside the function before it gets a value there.",
    "TypeError": "A value has the wrong type for this operation (for example adding a number "
                 "to a string). Check the types of the values on this line.",
    "ValueError": "The type is right but the value is not, for example int('hello').",
    "IndexError": "That position does not exist. The first position is 0 and the last one is len(...) - 1.",
    "KeyError": "This key is not in the dictionary.",
    "ZeroDivisionError": "You cannot divide by zero.",
    "AttributeError": "This value does not have that attribute or method. Check the spelling "
                      "and the type of the value.",
    "RecursionError": "The function keeps calling itself and never stops. Is there a base case?",
    "IndentationError": "The indentation (spaces at the start of a line) is wrong. The lines "
                        "after a ':' must be indented by the same amount.",
    "TabError": "Mixing tabs and spaces. Use 4 spaces for each indentation level.",
    "SyntaxError": "Python cannot read this line. Look for a missing ':', bracket or quote.",
}


class _StepLimit(BaseException):
    """Raised when the program runs too many steps (BaseException: student code can't catch it)."""


class _NeedInput(BaseException):
    """Raised when input() is called and no more input was provided."""


def run(code, inputs=(), seed=0, max_steps=MAX_STEPS):
    """Trace ``code`` and return the trace as a JSON string."""
    return json.dumps(Tracer(code, inputs, seed, max_steps).go())


class Tracer:
    def __init__(self, code, inputs, seed, max_steps):
        self.code = code
        self.inputs = [str(x) for x in inputs]
        self.input_pos = 0
        self.input_spans = []          # [start, end) of echoed user input in the output
        self.prompt = None
        self.seed = int(seed)
        self.max_steps = int(max_steps)
        self.steps = []
        self.out = io.StringIO()
        self.obj_ids, self.objs_keep = {}, []      # stable small ids for objects
        self.frame_ids, self.frames_keep = {}, []  # stable small ids for frames
        self.unwinding = set()                     # frames an exception is passing through
        self.exc_obj = None
        self.exc_step = None
        self.budget = 0
        safe_builtins = dict(builtins.__dict__)
        safe_builtins["input"] = self._input
        self.globals = {"__name__": "__main__", "__builtins__": safe_builtins}

    # ------------------------------------------------------------------ running
    def go(self):
        result = {"status": "finished", "steps": self.steps, "output": "",
                  "input_spans": self.input_spans, "error": None, "prompt": None,
                  "max_steps": self.max_steps}
        try:
            compiled = compile(self.code, FILENAME, "exec")
        except SyntaxError as e:
            name = type(e).__name__
            result["status"] = "syntax_error"
            result["error"] = {"type": name, "msg": e.msg, "line": e.lineno,
                               "col": e.offset, "hint": HINTS.get(name)}
            return result

        old_stdout, old_sleep = sys.stdout, time.sleep
        old_random = random.getstate()
        random.seed(self.seed)
        sys.stdout = self.out
        time.sleep = lambda *args, **kwargs: None   # sleeping is pointless when stepping
        try:
            sys.settrace(self._trace)
            try:
                exec(compiled, self.globals)
            finally:
                sys.settrace(None)
        except _StepLimit:
            result["status"] = "step_limit"
        except _NeedInput:
            result["status"] = "need_input"
            result["prompt"] = self.prompt
            if self.steps:
                waiting = dict(self.steps[-1])
                waiting["event"] = "input"
                waiting["out"] = self.out.tell()
                self.steps.append(waiting)
        except SystemExit:
            if self.steps and self.steps[-1]["event"] != "finished":
                done = dict(self.steps[-1])
                done["event"] = "finished"
                done["out"] = self.out.tell()
                self.steps.append(done)
        except BaseException as e:  # an uncaught error in the student's program
            name = type(e).__name__
            if self.exc_step is not None and self.exc_obj is e:
                step = dict(self.exc_step)
            else:
                step = {"line": None, "frames": [], "heap": {}}
            step["event"] = "error"
            step["out"] = self.out.tell()
            error = {"type": name, "msg": str(e), "line": step["line"], "hint": HINTS.get(name)}
            step["error"] = error
            self.steps.append(step)
            result["status"] = "error"
            result["error"] = error
        finally:
            sys.stdout, time.sleep = old_stdout, old_sleep
            random.setstate(old_random)
        result["output"] = self.out.getvalue()
        return result

    def _input(self, prompt=""):
        prompt = str(prompt)
        self.out.write(prompt)
        if self.input_pos < len(self.inputs):
            value = self.inputs[self.input_pos]
            self.input_pos += 1
            start = self.out.tell()
            self.out.write(value)
            self.input_spans.append([start, self.out.tell()])
            self.out.write("\n")
            return value
        self.prompt = prompt
        raise _NeedInput()

    def _trace(self, frame, event, arg):
        if frame.f_code.co_filename != FILENAME:
            return None                       # don't trace library / tracer code
        key = id(frame)
        if event == "line":
            self.unwinding.discard(key)
            if len(self.steps) >= self.max_steps:
                raise _StepLimit()
            self.steps.append(self._snapshot(frame, "line"))
        elif event == "return":
            if key in self.unwinding:         # leaving because of an exception
                self.unwinding.discard(key)
            elif frame.f_code.co_name == "<module>":
                self.steps.append(self._snapshot(frame, "finished"))
            else:
                self.steps.append(self._snapshot(frame, "return", arg))
        elif event == "exception":
            self.unwinding.add(key)
            exc = arg[1]
            if exc is not self.exc_obj and not isinstance(exc, (_StepLimit, _NeedInput)):
                self.exc_obj = exc            # remember the state where it was first raised
                self.exc_step = self._snapshot(frame, "error")
        return self._trace

    # ------------------------------------------------------------------ snapshots
    def _snapshot(self, frame, event, retval=None):
        stack = []
        f = frame
        while f is not None:
            if f.f_code.co_filename == FILENAME:
                stack.append(f)
            f = f.f_back
        stack.reverse()

        heap = {}
        self.budget = MAX_OBJECTS
        frames = []
        for f in stack:
            is_module = f.f_code.co_name == "<module>"
            names = f.f_globals if is_module else f.f_locals
            variables = []
            for name, value in list(names.items()):
                if not isinstance(name, str) or not name.isidentifier():
                    continue                  # e.g. the hidden '.0' of comprehensions
                if name.startswith("__") and name.endswith("__"):
                    continue
                variables.append([name, self._encode(value, heap)])
            entry = {"id": self._frame_id(f),
                     "name": "Global frame" if is_module else f.f_code.co_name,
                     "line": f.f_lineno, "vars": variables}
            if f is frame and event == "return":
                entry["ret"] = self._encode(retval, heap)
            frames.append(entry)
        return {"line": frame.f_lineno, "event": event, "frames": frames,
                "heap": heap, "out": self.out.tell()}

    def _frame_id(self, f):
        key = id(f)
        if key not in self.frame_ids:
            self.frame_ids[key] = len(self.frame_ids) + 1
            self.frames_keep.append(f)        # keep alive so ids are never reused
        return self.frame_ids[key]

    def _obj_id(self, v):
        key = id(v)
        if key not in self.obj_ids:
            self.obj_ids[key] = len(self.obj_ids) + 1
            self.objs_keep.append(v)
        return self.obj_ids[key]

    def _encode(self, v, heap):
        """Primitive values are inlined: {"t": type, "v": repr}. Others become {"ref": id}."""
        t = type(v)
        if v is None or t in (bool, int, float, complex):
            return {"t": t.__name__, "v": repr(v)}
        if t is str:
            r = repr(v)
            return {"t": "str", "v": r if len(r) <= MAX_STR else r[:MAX_STR] + "…"}
        if t is types.ModuleType:
            return {"t": "module", "v": "module " + v.__name__}
        if t is range:
            return {"t": "range", "v": repr(v)}
        if isinstance(v, type) and v.__module__ == "builtins":
            return {"t": "type", "v": "class " + v.__name__}
        if isinstance(v, types.BuiltinFunctionType):
            return {"t": "builtin", "v": "built-in " + v.__name__}
        key = str(self._obj_id(v))
        if key not in heap:
            if self.budget <= 0:
                return {"t": "trunc", "v": "…"}
            self.budget -= 1
            heap[key] = None                  # placeholder: handles self-references
            heap[key] = self._encode_obj(v, heap)
        return {"ref": int(key)}

    def _encode_obj(self, v, heap):
        t = type(v)
        if t in (list, tuple, set, frozenset):
            items = list(v)
            obj = {"type": t.__name__,
                   "items": [self._encode(x, heap) for x in items[:MAX_ITEMS]]}
            if len(items) > MAX_ITEMS:
                obj["more"] = len(items) - MAX_ITEMS
            return obj
        if t is dict:
            entries = list(v.items())
            obj = {"type": "dict",
                   "entries": [[self._encode(k, heap), self._encode(x, heap)]
                               for k, x in entries[:MAX_ITEMS]]}
            if len(entries) > MAX_ITEMS:
                obj["more"] = len(entries) - MAX_ITEMS
            return obj
        if t is types.FunctionType:
            try:
                sig = str(inspect.signature(v))
            except (TypeError, ValueError):
                sig = "(...)"
            return {"type": "function", "name": v.__name__, "sig": sig}
        if isinstance(v, type):
            attrs = [[k, self._encode(x, heap)] for k, x in vars(v).items()
                     if not (k.startswith("__") and k.endswith("__"))]
            return {"type": "class", "name": v.__name__, "attrs": attrs}
        if t.__module__ == "__main__" and hasattr(v, "__dict__"):
            attrs = [[k, self._encode(x, heap)] for k, x in vars(v).items()]
            return {"type": "instance", "name": t.__name__, "attrs": attrs}
        try:
            r = repr(v)
        except Exception:
            r = "<" + t.__name__ + " object>"
        return {"type": "other", "name": t.__name__,
                "repr": r if len(r) <= MAX_STR else r[:MAX_STR] + "…"}
