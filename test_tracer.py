"""Tests for tracer.py. Run with:  python3 test_tracer.py"""
import json
import unittest

import tracer


def trace(code, inputs=(), max_steps=1000):
    return json.loads(tracer.run(code, inputs, 42, max_steps))


def var(step, name, frame=-1):
    return dict(step["frames"][frame]["vars"]).get(name)


class TracerTests(unittest.TestCase):
    def test_while_loop_steps_and_output(self):
        t = trace("spam = 0\nwhile spam < 3:\n    print('hi')\n    spam += 1\nprint(spam)\n")
        self.assertEqual(t["status"], "finished")
        self.assertEqual(t["output"], "hi\nhi\nhi\n3\n")
        lines = [s["line"] for s in t["steps"] if s["event"] == "line"]
        self.assertEqual(lines[:4], [1, 2, 3, 4])
        self.assertEqual(lines.count(2), 4)            # condition checked 4 times
        self.assertEqual(t["steps"][-1]["event"], "finished")
        self.assertEqual(var(t["steps"][-1], "spam"), {"t": "int", "v": "3"})

    def test_step_limit_stops_infinite_loop(self):
        t = trace("i = 0\nwhile i < 5:\n    if i == 2:\n        continue\n    i += 1\n", max_steps=50)
        self.assertEqual(t["status"], "step_limit")
        self.assertEqual(len(t["steps"]), 50)

    def test_input_needs_rerun(self):
        code = "name = input('Name? ')\nprint('Hi', name)\n"
        t = trace(code)
        self.assertEqual(t["status"], "need_input")
        self.assertEqual(t["prompt"], "Name? ")
        self.assertEqual(t["steps"][-1]["event"], "input")
        t = trace(code, ["Ada"])
        self.assertEqual(t["status"], "finished")
        self.assertEqual(t["output"], "Name? Ada\nHi Ada\n")
        self.assertEqual(t["input_spans"], [[6, 9]])

    def test_functions_frames_and_return(self):
        t = trace("def square(x):\n    y = x * x\n    return y\n\nr = square(4)\n")
        ret = [s for s in t["steps"] if s["event"] == "return"]
        self.assertEqual(len(ret), 1)
        top = ret[0]["frames"][-1]
        self.assertEqual(top["name"], "square")
        self.assertEqual(top["ret"], {"t": "int", "v": "16"})
        self.assertEqual(var(t["steps"][-1], "r"), {"t": "int", "v": "16"})
        fn = var(t["steps"][-1], "square")
        self.assertEqual(t["steps"][-1]["heap"][str(fn["ref"])]["type"], "function")

    def test_aliasing_shares_object_ids(self):
        t = trace("a = [1, 2]\nb = a\nb.append(3)\nc = a[:]\n")
        last = t["steps"][-1]
        self.assertEqual(var(last, "a"), var(last, "b"))
        self.assertNotEqual(var(last, "a"), var(last, "c"))
        self.assertEqual(len(last["heap"][str(var(last, "a")["ref"])]["items"]), 3)

    def test_runtime_error_reports_line_and_state(self):
        t = trace("x = 5\ny = 0\nz = x / y\n")
        self.assertEqual(t["status"], "error")
        self.assertEqual(t["error"]["type"], "ZeroDivisionError")
        self.assertEqual(t["error"]["line"], 3)
        self.assertEqual(var(t["steps"][-1], "x"), {"t": "int", "v": "5"})

    def test_error_inside_function_keeps_frames(self):
        t = trace("def f(n):\n    return n + 'a'\n\nf(1)\n")
        self.assertEqual(t["error"]["type"], "TypeError")
        self.assertEqual([f["name"] for f in t["steps"][-1]["frames"]], ["Global frame", "f"])

    def test_caught_exception_is_not_an_error(self):
        t = trace("try:\n    int('x')\nexcept ValueError:\n    ok = True\n")
        self.assertEqual(t["status"], "finished")

    def test_syntax_error(self):
        t = trace("while True\n    print(1)\n")
        self.assertEqual(t["status"], "syntax_error")
        self.assertEqual(t["error"]["line"], 1)

    def test_self_reference_and_classes(self):
        t = trace("class Dog:\n    def __init__(self, name):\n        self.name = name\n\n"
                  "d = Dog('Rex')\nlst = [1]\nlst.append(lst)\n")
        last = t["steps"][-1]
        dog = last["heap"][str(var(last, "d")["ref"])]
        self.assertEqual(dog["type"], "instance")
        self.assertEqual(dict(dog["attrs"])["name"], {"t": "str", "v": "'Rex'"})
        lst_ref = var(last, "lst")["ref"]
        self.assertEqual(last["heap"][str(lst_ref)]["items"][1], {"ref": lst_ref})

    def test_random_is_reproducible(self):
        code = "import random\nx = random.randint(1, 1000)\n"
        self.assertEqual(var(trace(code)["steps"][-1], "x"), var(trace(code)["steps"][-1], "x"))
        self.assertEqual(var(trace(code)["steps"][-1], "random")["t"], "module")

    def test_sys_exit_finishes(self):
        t = trace("import sys\nx = 1\nsys.exit()\ny = 2\n")
        self.assertEqual(t["steps"][-1]["event"], "finished")


if __name__ == "__main__":
    unittest.main()
