/* Python Visualizer: UI. Python itself runs in a Web Worker (Pyodide), see WORKER_SRC. */
(() => {
  'use strict';

  const PYODIDE_URL = 'https://cdn.jsdelivr.net/npm/pyodide@0.27.7/';
  const MAX_STEPS = 1000;
  const TIMEOUT_MS = 20000;

  // The worker is built from a string so the page also works when opened as a local file.
  const WORKER_SRC = `
    let py = null, runFn = null;
    self.onmessage = async (event) => {
      const msg = event.data;
      if (msg.type === 'init') {
        try {
          importScripts(msg.indexURL + 'pyodide.js');
          py = await loadPyodide({ indexURL: msg.indexURL });
          py.runPython(msg.tracer);
          runFn = py.globals.get('run');
          self.postMessage({ type: 'ready' });
        } catch (err) {
          self.postMessage({ type: 'fatal', message: String(err) });
        }
      } else if (msg.type === 'run') {
        try {
          const inputs = py.toPy(msg.inputs);
          const json = runFn(msg.code, inputs, msg.seed, msg.maxSteps);
          inputs.destroy();
          self.postMessage({ type: 'result', id: msg.id, json });
        } catch (err) {
          self.postMessage({ type: 'result', id: msg.id, crash: String(err) });
        }
      }
    };`;

  // ---------------------------------------------------------------- helpers
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem('pyviz.' + key); return v === null ? fallback : v; } catch { return fallback; }
    },
    set(key, value) { try { localStorage.setItem('pyviz.' + key, value); } catch { /* storage unavailable */ } },
  };
  function b64encode(text) {
    let bin = '';
    new TextEncoder().encode(text).forEach((b) => { bin += String.fromCharCode(b); });
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64decode(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));
  }
  function hashParams() {
    const params = new URLSearchParams(location.hash.slice(1));
    let code = null;
    try { if (params.get('code')) code = b64decode(params.get('code')); } catch { code = null; }
    return { code, step: parseInt(params.get('step') || '', 10) };
  }
  let toastTimer = null;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
  }

  // ---------------------------------------------------------------- state
  const examples = window.PYVIZ_EXAMPLES || [];
  const fromHash = hashParams();
  const state = {
    mode: 'edit',          // 'edit' | 'vis'
    trace: null,
    cur: 0,
    code: '',
    inputs: [],
    seed: 0,
    playTimer: null,
    view: store.get('view', 'arrows'),
    autoRun: !!fromHash.code,
    startStep: Number.isFinite(fromHash.step) ? fromHash.step - 1 : 0,
  };

  // ---------------------------------------------------------------- editor
  const cm = CodeMirror($('editor'), {
    value: fromHash.code ?? store.get('code', null) ?? (examples[0] ? examples[0].code : 'print("Hello!")\n'),
    mode: 'python',
    lineNumbers: true,
    indentUnit: 4,
    tabSize: 4,
    indentWithTabs: false,
    gutters: ['gutter-arrow', 'CodeMirror-linenumbers', 'gutter-runs'],
    extraKeys: {
      Tab: (ed) => (ed.somethingSelected() ? ed.indentSelection('add') : ed.replaceSelection('    ', 'end')),
      'Shift-Tab': (ed) => ed.indentSelection('subtract'),
      'Ctrl-Enter': () => visualize(),
      'Cmd-Enter': () => visualize(),
    },
  });
  cm.on('change', () => {
    if (state.mode === 'edit') {
      store.set('code', cm.getValue());
      clearMarks();
      hideBanner();
    }
  });
  // Clicking the code while stepping switches back to editing (line numbers keep "run to line").
  cm.on('mousedown', (ed, e) => {
    if (state.mode === 'vis' && !e.target.closest('.CodeMirror-gutters, .CodeMirror-gutter-wrapper')) setMode('edit');
  });
  cm.on('gutterClick', (ed, line) => {
    if (state.mode !== 'vis') return;
    const steps = state.trace.steps;
    for (let i = state.cur + 1; i < steps.length; i++) {
      if (steps[i].event === 'line' && steps[i].line === line + 1) { stopPlay(); go(i); return; }
    }
    toast(`Line ${line + 1} does not run again`);
  });

  let marked = [];
  function mark(line0, cls) {
    if (line0 < 0 || line0 >= cm.lineCount()) return;
    cm.addLineClass(line0, 'background', cls);
    marked.push([line0, cls]);
  }
  function clearMarks() {
    cm.operation(() => {
      for (const [ln, cls] of marked) cm.removeLineClass(ln, 'background', cls);
      marked = [];
      cm.clearGutter('gutter-arrow');
      cm.clearGutter('gutter-runs');
    });
  }
  function gutterEl(cls, text, title) {
    const el = document.createElement('div');
    el.className = cls;
    el.textContent = text;
    if (title) el.title = title;
    return el;
  }

  // ---------------------------------------------------------------- python worker
  let worker = null;
  let workerReady = false;
  let pending = null;
  let reqId = 0;

  function startWorker() {
    workerReady = false;
    updateRunButton();
    const url = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
    worker = new Worker(url);
    worker.onmessage = (event) => {
      const m = event.data;
      if (m.type === 'ready') {
        workerReady = true;
        updateRunButton();
        if (state.autoRun) { state.autoRun = false; visualize(state.startStep); }
      } else if (m.type === 'fatal') {
        showBanner('error', `<b>Python could not be loaded.</b> Check your internet connection and reload the page.<div class="hint">${esc(m.message)}</div>`);
        $('btn-run').textContent = '⚠️ Python unavailable';
      } else if (m.type === 'result' && pending && m.id === pending.id) {
        const p = pending;
        pending = null;
        clearTimeout(p.timer);
        updateRunButton();
        if (m.crash) p.reject(new Error(m.crash));
        else p.resolve(JSON.parse(m.json));
      }
    };
    worker.onerror = (e) => showBanner('error', 'Python worker error: ' + esc(e.message || 'unknown'));
    worker.postMessage({ type: 'init', indexURL: PYODIDE_URL, tracer: window.TRACER_PY });
  }

  function runTrace(code, inputs, seed) {
    return new Promise((resolve, reject) => {
      if (!workerReady) { reject(new Error('Python is still loading')); return; }
      const id = ++reqId;
      const timer = setTimeout(() => {
        if (!pending || pending.id !== id) return;
        pending = null;
        worker.terminate();
        startWorker();                       // a fresh Python, the old one is stuck
        reject(new Error('timeout'));
      }, TIMEOUT_MS);
      pending = { id, resolve, reject, timer };
      updateRunButton();
      worker.postMessage({ type: 'run', id, code, inputs, seed, maxSteps: MAX_STEPS });
    });
  }

  function updateRunButton() {
    const b = $('btn-run');
    if (!workerReady) { b.disabled = true; b.textContent = '⏳ Loading Python…'; }
    else if (pending) { b.disabled = true; b.textContent = '⏳ Running…'; }
    else { b.disabled = false; b.textContent = '▶ Visualize'; }
  }

  // ---------------------------------------------------------------- running
  async function visualize(startAt = 0) {
    if (state.mode === 'vis') return;
    if (!workerReady) { state.autoRun = true; state.startStep = startAt; toast('Python is still loading, it will start automatically'); return; }
    stopPlay();
    state.code = cm.getValue();
    state.inputs = [];
    state.seed = Math.floor(Math.random() * 1e9);
    store.set('code', state.code);
    await execute(startAt);
  }

  async function execute(jumpTo) {
    let trace;
    try {
      trace = await runTrace(state.code, state.inputs, state.seed);
    } catch (err) {
      if (err.message === 'timeout') {
        showBanner('error', '<b>Your program took too long</b> (more than 20 seconds on one step) and was stopped. Is it doing a very big calculation?');
      } else {
        showBanner('error', 'Something went wrong while running the program: ' + esc(err.message));
      }
      if (state.mode === 'vis') setMode('edit');
      return;
    }
    if (trace.status === 'syntax_error') {
      setMode('edit');
      showSyntaxError(trace.error);
      return;
    }
    state.trace = trace;
    setMode('vis');
    go(Math.min(Math.max(jumpTo, 0), trace.steps.length - 1));
  }

  function showSyntaxError(e) {
    clearMarks();
    if (e.line) {
      mark(e.line - 1, 'ln-error');
      cm.setGutterMarker(e.line - 1, 'gutter-arrow', gutterEl('mk-arrow err', '✖', e.type));
      cm.scrollIntoView({ line: e.line - 1, ch: 0 }, 80);
    }
    showBanner('error', `<b>${esc(e.type)}</b>${e.line ? ` on line ${e.line}` : ''}: ${esc(e.msg)}` +
      (e.hint ? `<div class="hint">💡 ${esc(e.hint)}</div>` : ''));
  }

  function showBanner(kind, html) {
    const b = $('banner');
    b.className = 'banner ' + kind;
    b.innerHTML = html;
    b.hidden = false;
  }
  function hideBanner() { $('banner').hidden = true; }

  function setMode(mode) {
    state.mode = mode;
    const vis = mode === 'vis';
    document.body.classList.toggle('is-vis', vis);
    cm.setOption('readOnly', vis);
    $('mode-badge').textContent = vis ? 'Step by step' : 'Editing';
    $('btn-edit').hidden = !vis;
    $('btn-run').hidden = vis;
    $('controls').hidden = !vis;
    $('legend').hidden = !vis;
    if (vis) {
      hideBanner();
    } else {
      stopPlay();
      state.trace = null;
      clearMarks();
      renderEmpty();
    }
    requestAnimationFrame(() => { cm.refresh(); drawArrows(); });
  }

  // ---------------------------------------------------------------- navigation
  function go(i) {
    const n = state.trace.steps.length;
    state.cur = Math.max(0, Math.min(n - 1, i));
    render();
  }
  function stepCount() { return state.trace ? state.trace.steps.length : 0; }
  function atInputStep() { return state.trace && state.trace.steps[state.cur].event === 'input'; }

  function togglePlay() {
    if (state.playTimer) { stopPlay(); return; }
    if (state.cur >= stepCount() - 1) go(0);
    $('btn-play').textContent = '⏸ Pause';
    state.playTimer = setInterval(() => {
      if (state.cur >= stepCount() - 1 || atInputStep()) { stopPlay(); return; }
      go(state.cur + 1);
      if (atInputStep()) stopPlay();
    }, parseInt($('speed').value, 10));
  }
  function stopPlay() {
    if (state.playTimer) clearInterval(state.playTimer);
    state.playTimer = null;
    $('btn-play').textContent = '▶︎ Play';
  }

  // ---------------------------------------------------------------- value helpers
  function shortRepr(val, heap, depth = 0) {
    if (!val) return '';
    if ('v' in val) return val.v;
    const o = heap[val.ref];
    if (!o) return '…';
    if (depth > 2) return '…';
    const r = (v) => shortRepr(v, heap, depth + 1);
    let s;
    switch (o.type) {
      case 'list': s = '[' + o.items.map(r).join(', ') + (o.more ? ', …' : '') + ']'; break;
      case 'tuple': s = '(' + o.items.map(r).join(', ') + (o.items.length === 1 ? ',' : '') + ')'; break;
      case 'set': case 'frozenset': s = o.items.length ? '{' + o.items.map(r).join(', ') + '}' : o.type + '()'; break;
      case 'dict': s = '{' + o.entries.map(([k, v]) => r(k) + ': ' + r(v)).join(', ') + (o.more ? ', …' : '') + '}'; break;
      case 'function': s = 'function ' + o.name + o.sig; break;
      case 'class': s = 'class ' + o.name; break;
      case 'instance': s = o.name + ' object'; break;
      default: s = o.repr;
    }
    return s.length > 70 ? s.slice(0, 69) + '…' : s;
  }
  function sameVal(a, b) {
    if ('v' in a && 'v' in b) return a.v === b.v && a.t === b.t;
    if ('ref' in a && 'ref' in b) return a.ref === b.ref;
    return false;
  }
  function childrenOf(o) {
    if (!o) return [];
    if (o.items) return o.items;
    if (o.entries) return o.entries.flat();
    if (o.attrs) return o.attrs.map(([, v]) => v);
    return [];
  }
  function touchesChanged(val, heap, changed, seen = new Set()) {
    if (!val || val.ref == null) return false;
    const k = String(val.ref);
    if (changed.has(k)) return true;
    if (seen.has(k)) return false;
    seen.add(k);
    return childrenOf(heap[k]).some((c) => touchesChanged(c, heap, changed, seen));
  }

  // ---------------------------------------------------------------- diff between two steps
  function diffSteps(prev, cur) {
    const d = { newVars: new Set(), changedVars: new Set(), newObjs: new Set(), changedObjs: new Set(), newFrames: new Set(), items: [] };
    if (!prev) return d;
    const prevFrames = new Map(prev.frames.map((f) => [f.id, f]));
    const curIds = new Set(cur.frames.map((f) => f.id));
    for (const pf of prev.frames) {
      if (!curIds.has(pf.id)) d.items.push({ kind: 'returned', html: `↩ left <code>${esc(pf.name)}</code>` });
    }
    for (const f of cur.frames) {
      const pf = prevFrames.get(f.id);
      if (!pf) {
        d.newFrames.add(f.id);
        const args = f.vars.map(([n, v]) => `${n}=${shortRepr(v, cur.heap)}`).join(', ');
        d.items.push({ kind: 'call', html: `📞 called <code>${esc(f.name)}(${esc(args)})</code>` });
        f.vars.forEach(([n]) => d.newVars.add(f.id + ':' + n));
        continue;
      }
      const before = new Map(pf.vars);
      for (const [name, val] of f.vars) {
        const key = f.id + ':' + name;
        if (!before.has(name)) {
          d.newVars.add(key);
          d.items.push({ kind: 'new', html: `new <code>${esc(name)}</code> = <code>${esc(shortRepr(val, cur.heap))}</code>` });
        } else if (!sameVal(before.get(name), val)) {
          d.changedVars.add(key);
          d.items.push({ kind: 'changed', html: `<code>${esc(name)}</code> ${esc(shortRepr(before.get(name), prev.heap))} → <b><code>${esc(shortRepr(val, cur.heap))}</code></b>` });
        }
      }
    }
    for (const [k, o] of Object.entries(cur.heap)) {
      if (!(k in prev.heap)) { d.newObjs.add(k); continue; }
      if (JSON.stringify(o) !== JSON.stringify(prev.heap[k])) {
        d.changedObjs.add(k);
        d.items.push({ kind: 'changed', html: `${esc(o.type === 'instance' ? o.name : o.type)} <code>${esc(shortRepr({ ref: +k }, prev.heap))}</code> → <b><code>${esc(shortRepr({ ref: +k }, cur.heap))}</code></b>` });
      }
    }
    if (cur.out > prev.out) {
      let text = state.trace.output.slice(prev.out, cur.out).replace(/\n$/, '');
      if (text.length > 60) text = text.slice(0, 59) + '…';
      d.items.push({ kind: 'print', html: `🖨 printed <code>${esc(text).replace(/\n/g, '↵')}</code>` });
    }
    return d;
  }

  // ---------------------------------------------------------------- rendering
  function render() {
    const t = state.trace;
    const step = t.steps[state.cur];
    const prev = state.cur > 0 ? t.steps[state.cur - 1] : null;
    const diff = diffSteps(prev, step);
    renderControls();
    renderMarks(step, prev);
    renderExplain(step, prev, diff);
    renderOutput(step, prev);
    renderMemory(step, diff);
  }

  function renderControls() {
    const n = stepCount();
    const last = state.cur >= n - 1;
    $('slider').max = String(n - 1);
    $('slider').value = String(state.cur);
    $('step-label').textContent = `Step ${state.cur + 1} of ${n}`;
    $('btn-first').disabled = $('btn-prev').disabled = state.cur === 0;
    $('btn-next').disabled = $('btn-last').disabled = last;
  }

  function renderMarks(step, prev) {
    cm.operation(() => {
      clearMarks();
      const counts = {};
      for (let k = 0; k < state.cur; k++) {
        const s = state.trace.steps[k];
        if (s.event === 'line') counts[s.line] = (counts[s.line] || 0) + 1;
      }
      for (const [ln, c] of Object.entries(counts)) {
        cm.setGutterMarker(+ln - 1, 'gutter-runs', gutterEl('mk-runs', '×' + c, `This line has run ${c} time${c === 1 ? '' : 's'}`));
      }
      // lines where outer frames are waiting for a function call to finish
      step.frames.slice(0, -1).forEach((f) => { if (f.line) mark(f.line - 1, 'ln-caller'); });

      if (prev && prev.event === 'line' && prev.line !== step.line && step.event !== 'error') {
        mark(prev.line - 1, 'ln-prev');
        cm.setGutterMarker(prev.line - 1, 'gutter-arrow', gutterEl('mk-arrow prev', '➜', 'line that just ran'));
      }
      const ln = step.line ? step.line - 1 : -1;
      if (ln >= 0) {
        if (step.event === 'line') {
          mark(ln, 'ln-next');
          cm.setGutterMarker(ln, 'gutter-arrow', gutterEl('mk-arrow next', '➜', 'next line to run'));
        } else if (step.event === 'return') {
          mark(ln, 'ln-prev');
          cm.setGutterMarker(ln, 'gutter-arrow', gutterEl('mk-arrow prev', '➜', 'returning from the function'));
        } else if (step.event === 'input') {
          mark(ln, 'ln-wait');
          cm.setGutterMarker(ln, 'gutter-arrow', gutterEl('mk-arrow next', '⌨', 'waiting for input'));
        } else if (step.event === 'error') {
          mark(ln, 'ln-error');
          cm.setGutterMarker(ln, 'gutter-arrow', gutterEl('mk-arrow err', '✖', 'error'));
        }
        if (step.event !== 'finished') cm.scrollIntoView({ line: ln, ch: 0 }, 60);
      }
    });
  }

  function renderExplain(step, prev, diff) {
    const t = state.trace;
    const isLast = state.cur === t.steps.length - 1;
    let head = '';
    switch (step.event) {
      case 'line':
        head = state.cur === 0
          ? `Python starts at the top. Next line to run: <b>line ${step.line}</b>`
          : `Next line to run: <b>line ${step.line}</b>`;
        break;
      case 'return': {
        const f = step.frames[step.frames.length - 1];
        head = `Function <code>${esc(f.name)}</code> is done and returns <code>${esc(shortRepr(f.ret, step.heap))}</code>`;
        break;
      }
      case 'finished':
        head = `✅ <b>Program finished</b> after ${t.steps.length} steps.`;
        break;
      case 'input':
        head = '⌨️ <b>The program is waiting for input.</b> Type your answer in the Output panel and press Enter.';
        break;
      case 'error': {
        const e = step.error || t.error || {};
        head = `<span class="err-text">❌ <b>${esc(e.type)}</b>${step.line ? ` on line ${step.line}` : ''}: ${esc(e.msg)}</span>` +
          (e.hint ? `<div class="hint">💡 ${esc(e.hint)}</div>` : '');
        break;
      }
      default:
        head = '';
    }
    let html = `<div class="head">${head}</div>`;
    if (prev) {
      const what = prev.event === 'line' ? `What line ${prev.line} did:` : 'What changed:';
      const chips = diff.items.length
        ? diff.items.map((it) => `<span class="chip ${it.kind}">${it.html}</span>`).join('')
        : `<span class="chip quiet">${prev.event === 'line' ? 'checked a condition or jumped, no variables changed' : 'nothing changed'}</span>`;
      if (step.event !== 'error' || diff.items.length) html += `<div class="sub">${what}</div><div class="chips">${chips}</div>`;
    }
    if (isLast && t.status === 'step_limit') {
      html += `<div class="warn">⚠️ Stopped after ${t.max_steps} steps. Is this an <b>infinite loop</b>? Check that the loop condition can become <code>False</code>.</div>`;
    }
    $('explain').innerHTML = html;
  }

  function renderOutput(step, prev) {
    const t = state.trace;
    const out = $('output');
    const end = step.out;
    const from = prev ? Math.min(prev.out, end) : end;
    const spans = (t.input_spans || []).filter(([a]) => a < end);
    const cuts = new Set([0, end, from]);
    spans.forEach(([a, b]) => { cuts.add(a); cuts.add(Math.min(b, end)); });
    const pts = [...cuts].filter((x) => x >= 0 && x <= end).sort((a, b) => a - b);
    let html = '';
    for (let k = 0; k < pts.length - 1; k++) {
      const a = pts[k], b = pts[k + 1];
      if (a === b) continue;
      const cls = [];
      if (spans.some(([s, e]) => a >= s && b <= e)) cls.push('user-in');
      if (prev && a >= from) cls.push('fresh');
      html += `<span class="${cls.join(' ')}">${esc(t.output.slice(a, b))}</span>`;
    }
    if (step.event === 'input') {
      html += '<input id="console-input" class="console-input" autocomplete="off" spellcheck="false" placeholder="type here, then Enter">';
    }
    out.innerHTML = html || '<span class="placeholder">Nothing printed yet</span>';
    const inp = $('console-input');
    if (inp) {
      inp.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          state.inputs.push(inp.value);
          inp.disabled = true;
          execute(state.cur);
        }
      });
      inp.focus({ preventScroll: true });
    }
    out.scrollTop = out.scrollHeight;
  }

  function renderVal(val, heap, inline, seen) {
    if (!val) return '';
    if ('v' in val) return `<span class="prim t-${esc(val.t)}">${esc(val.v)}</span>`;
    if (!inline) return `<span class="ptr" data-ref="${val.ref}"></span>`;
    const k = String(val.ref);
    if (seen.has(k)) return '<span class="prim t-cycle">↺ (itself)</span>';
    const inner = new Set(seen);
    inner.add(k);
    const o = heap[k];
    return `<div class="obj inline-obj"><div class="obj-label">${esc(objLabel(o))}</div>${renderObjBody(o, heap, true, inner)}</div>`;
  }

  function objLabel(o) {
    if (!o) return '';
    if (o.type === 'instance') return o.name + ' object';
    if (o.type === 'other') return o.name;
    return o.type;
  }

  function renderObjBody(o, heap, inline, seen) {
    if (!o) return '<span class="prim t-trunc">…</span>';
    const rv = (v) => renderVal(v, heap, inline, seen);
    switch (o.type) {
      case 'list': case 'tuple': case 'set': case 'frozenset': {
        if (!o.items.length) return `<div class="emptyobj">empty ${o.type}</div>`;
        const indexed = o.type === 'list' || o.type === 'tuple';
        const cells = o.items.map((it, i) =>
          `<div class="cell"><div class="cv">${rv(it)}</div>${indexed ? `<div class="ci">${i}</div>` : ''}</div>`).join('');
        const more = o.more ? `<div class="cell more"><div class="cv">+${o.more} more</div></div>` : '';
        return `<div class="cells ${o.type}">${cells}${more}</div>`;
      }
      case 'dict': {
        if (!o.entries.length) return '<div class="emptyobj">empty dict</div>';
        const rows = o.entries.map(([k, v]) => `<tr><th>${rv(k)}</th><td>${rv(v)}</td></tr>`).join('');
        const more = o.more ? `<tr><td colspan="2" class="muted">+${o.more} more</td></tr>` : '';
        return `<table class="vars dict">${rows}${more}</table>`;
      }
      case 'function':
        return `<div class="fn"><span class="kw">def</span> ${esc(o.name)}${esc(o.sig)}</div>`;
      case 'class': case 'instance': {
        const head = o.type === 'class' ? `<div class="fn"><span class="kw">class</span> ${esc(o.name)}</div>` : '';
        if (!o.attrs.length) return head || '<div class="emptyobj">no attributes</div>';
        const rows = o.attrs.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${rv(v)}</td></tr>`).join('');
        return `${head}<table class="vars">${rows}</table>`;
      }
      default:
        return `<div class="other">${esc(o.repr)}</div>`;
    }
  }

  function heapOrder(step) {
    const order = [];
    const seen = new Set();
    const visit = (v) => {
      if (!v || v.ref == null) return;
      const k = String(v.ref);
      if (seen.has(k)) return;
      seen.add(k);
      order.push(k);
      childrenOf(step.heap[k]).forEach(visit);
    };
    for (const f of step.frames) {
      f.vars.forEach(([, v]) => visit(v));
      if (f.ret) visit(f.ret);
    }
    Object.keys(step.heap).forEach((k) => { if (!seen.has(k)) { seen.add(k); order.push(k); } });
    return order;
  }

  function renderMemory(step, diff) {
    const inline = state.view === 'inline';
    $('viz').classList.toggle('inline', inline);
    const n = step.frames.length;
    const frames = step.frames.map((f, idx) => {
      const rows = f.vars.map(([name, val]) => {
        const key = f.id + ':' + name;
        let cls = '';
        if (diff.newVars.has(key)) cls = 'new';
        else if (diff.changedVars.has(key) || (inline && touchesChanged(val, step.heap, diff.changedObjs))) cls = 'changed';
        return `<tr class="var ${cls}"><th>${esc(name)}</th><td>${renderVal(val, step.heap, inline, new Set())}</td></tr>`;
      });
      if (f.ret) rows.push(`<tr class="var ret"><th>return value</th><td>${renderVal(f.ret, step.heap, inline, new Set())}</td></tr>`);
      const active = idx === n - 1 && step.event !== 'finished';
      const title = idx === 0 ? 'Global frame' : esc(f.name);
      const tag = idx === 0 ? '' : '<span class="tag">function call</span>';
      return `<div class="frame ${active ? 'active' : ''} ${diff.newFrames.has(f.id) ? 'appear' : ''}"><div class="frame-head"><span>${title}</span>${tag}</div>` +
        (rows.length ? `<table class="vars">${rows.join('')}</table>` : '<div class="empty">no variables yet</div>') + '</div>';
    });
    $('frames').innerHTML = frames.join('') || '<div class="empty">no frames</div>';
    if (!inline) {
      const cards = heapOrder(step).map((k) => {
        const o = step.heap[k];
        const cls = diff.newObjs.has(k) && state.cur > 0 ? 'new' : diff.changedObjs.has(k) ? 'changed' : '';
        return `<div class="obj ${cls}" data-oid="${k}"><div class="obj-label">${esc(objLabel(o))}</div>${renderObjBody(o, step.heap, false, new Set([k]))}</div>`;
      });
      $('heap').innerHTML = cards.join('') || '<div class="empty">no lists or other objects yet</div>';
    } else {
      $('heap').innerHTML = '';
    }
    requestAnimationFrame(drawArrows);
  }

  function renderEmpty() {
    $('frames').innerHTML = `<div class="placeholder-big">Write a program on the left, then press <b>▶ Visualize</b>
      (or <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>Enter</kbd>) to run it <b>one line at a time</b>
      and watch the variables change here.</div>`;
    $('heap').innerHTML = '';
    $('output').innerHTML = '<span class="placeholder">Printed output will appear here</span>';
    $('arrows').innerHTML = '';
  }

  // ---------------------------------------------------------------- arrows
  function drawArrows() {
    const svg = $('arrows');
    const viz = $('viz');
    if (state.mode !== 'vis' || state.view === 'inline') { svg.innerHTML = ''; return; }
    const box = viz.getBoundingClientRect();
    const ox = viz.scrollLeft - box.left;
    const oy = viz.scrollTop - box.top;
    svg.setAttribute('width', viz.scrollWidth);
    svg.setAttribute('height', viz.scrollHeight);
    let paths = '';
    viz.querySelectorAll('.ptr').forEach((p, i) => {
      const target = $('heap').querySelector(`.obj[data-oid="${p.dataset.ref}"]`);
      if (!target) return;
      const body = target.querySelector(':scope > :not(.obj-label)') || target;
      const a = p.getBoundingClientRect();
      const b = body.getBoundingClientRect();
      const x1 = a.left + a.width / 2 + ox;
      const y1 = a.top + a.height / 2 + oy;
      const x2 = b.left + ox - 2;
      const y2 = b.top + Math.min(b.height / 2, 16) + oy;
      const dx = Math.max(36, Math.abs(x2 - x1) / 2);
      p.dataset.i = i;
      paths += `<path class="arrow" data-i="${i}" d="M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}" marker-end="url(#ah)"/>`;
    });
    svg.innerHTML = '<defs><marker id="ah" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">' +
      '<path d="M0,0 L10,5 L0,10 z" class="arrowhead"/></marker></defs>' + paths;
  }

  function highlightFrom(el, on) {
    el.querySelectorAll('.ptr').forEach((p) => {
      const path = $('arrows').querySelector(`path[data-i="${p.dataset.i}"]`);
      if (path) path.classList.toggle('hl', on);
      const target = $('heap').querySelector(`.obj[data-oid="${p.dataset.ref}"]`);
      if (target) target.classList.toggle('hl', on);
    });
  }
  $('viz').addEventListener('mouseover', (e) => {
    const host = e.target.closest('tr, .cell');
    if (host) highlightFrom(host, true);
  });
  $('viz').addEventListener('mouseout', (e) => {
    const host = e.target.closest('tr, .cell');
    if (host) highlightFrom(host, false);
  });
  new ResizeObserver(() => drawArrows()).observe($('viz'));

  // ---------------------------------------------------------------- toolbar & controls
  function setView(view) {
    state.view = view;
    store.set('view', view);
    $('view-arrows').classList.toggle('on', view === 'arrows');
    $('view-inline').classList.toggle('on', view === 'inline');
    if (state.mode === 'vis') render();
  }

  function setFontSize(px) {
    px = Math.max(12, Math.min(30, px));
    document.documentElement.style.setProperty('--fs', px + 'px');
    store.set('fs', String(px));
    requestAnimationFrame(() => { cm.refresh(); drawArrows(); });
  }
  const currentFs = () => parseInt(getComputedStyle(document.documentElement).getPropertyValue('--fs'), 10) || 15;

  function setTheme(theme) {
    document.documentElement.dataset.theme = theme;
    store.set('theme', theme);
  }

  // examples menu
  const sel = $('examples');
  const groups = {};
  examples.forEach((ex, i) => {
    if (!groups[ex.group]) {
      groups[ex.group] = document.createElement('optgroup');
      groups[ex.group].label = ex.group;
      sel.appendChild(groups[ex.group]);
    }
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = ex.title;
    groups[ex.group].appendChild(opt);
  });
  sel.addEventListener('change', () => {
    const ex = examples[parseInt(sel.value, 10)];
    sel.value = '';
    if (!ex) return;
    if (state.mode === 'vis') setMode('edit');
    cm.setValue(ex.code);
    visualize();
  });

  $('btn-run').addEventListener('click', () => visualize());
  $('btn-edit').addEventListener('click', () => { setMode('edit'); cm.focus(); });
  $('btn-first').addEventListener('click', () => { stopPlay(); go(0); });
  $('btn-prev').addEventListener('click', () => { stopPlay(); go(state.cur - 1); });
  $('btn-next').addEventListener('click', () => { stopPlay(); go(state.cur + 1); });
  $('btn-last').addEventListener('click', () => { stopPlay(); go(stepCount() - 1); });
  $('btn-play').addEventListener('click', togglePlay);
  $('speed').addEventListener('change', () => { if (state.playTimer) { stopPlay(); togglePlay(); } });
  $('slider').addEventListener('input', () => { stopPlay(); go(parseInt($('slider').value, 10)); });
  $('view-arrows').addEventListener('click', () => setView('arrows'));
  $('view-inline').addEventListener('click', () => setView('inline'));
  $('btn-bigger').addEventListener('click', () => setFontSize(currentFs() + 2));
  $('btn-smaller').addEventListener('click', () => setFontSize(currentFs() - 2));
  $('btn-theme').addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === 'dark'
      : matchMedia('(prefers-color-scheme: dark)').matches;
    setTheme(dark ? 'light' : 'dark');
  });
  $('btn-share').addEventListener('click', async () => {
    const code = state.mode === 'vis' ? state.code : cm.getValue();
    let hash = 'code=' + b64encode(code);
    if (state.mode === 'vis' && state.cur > 0) hash += '&step=' + (state.cur + 1);
    const url = location.href.split('#')[0] + '#' + hash;
    history.replaceState(null, '', '#' + hash);
    try {
      await navigator.clipboard.writeText(url);
      toast(state.mode === 'vis' && state.cur > 0 ? `Link copied (opens at step ${state.cur + 1})` : 'Link copied');
    } catch {
      window.prompt('Copy this link:', url);
    }
  });

  document.addEventListener('keydown', (e) => {
    if (state.mode !== 'vis' || e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = e.target.tagName;
    const inEditor = e.target.closest && e.target.closest('.CodeMirror');
    if (!inEditor && (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA')) return;
    const keys = {
      ArrowRight: () => go(state.cur + 1),
      ArrowLeft: () => go(state.cur - 1),
      Home: () => go(0),
      End: () => go(stepCount() - 1),
    };
    if (keys[e.key]) { e.preventDefault(); stopPlay(); keys[e.key](); }
    else if (e.key === ' ' && !inEditor) { e.preventDefault(); togglePlay(); }
  });
  window.addEventListener('resize', () => drawArrows());

  // ---------------------------------------------------------------- start
  const savedTheme = store.get('theme', null);
  if (savedTheme) document.documentElement.dataset.theme = savedTheme;
  const savedFs = parseInt(store.get('fs', ''), 10);
  if (savedFs) setFontSize(savedFs);
  setView(state.view);
  setMode('edit');
  startWorker();
})();
