/* ════════════════════════════════════════════════════════════
   Muscovado · frontend interaction logic
   - Bottom composer: tap to type / hold to talk / swipe up to cancel
   - Pull-up image panel at the top
   - Conversation feed in the middle
   ════════════════════════════════════════════════════════════ */
'use strict';

const $ = (s) => document.querySelector(s);

/* Works when mounted on a subpath (/ai/) too — no assumptions */
const BASE = location.pathname.replace(/[^/]*$/, '');

/* ───────────────────────── State ───────────────────────── */
/* Input/voice state lives in composer.js (keeps the two gesture handlers from fighting) */

/* ───────────────────────── Message rendering ───────────────────────── */
const msgList = $('#msgList');

function scrollBottom(smooth = true) {
  const f = $('#feed');
  f.scrollTo({ top: f.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function addUser(text, isVoice = false) {
  const el = document.createElement('div');
  el.className = 'msg user';
  el.innerHTML = `<div class="bubble${isVoice ? ' voice' : ''}">${esc(text)}</div>`;
  msgList.appendChild(el);
  scrollBottom();
}

/* Waiting state: Hermes takes 6-15s to cold-start before streaming tokens.
   A bare three-dot animation looks disconnected, so show a live timer. */
function addTyping(label) {
  const el = document.createElement('div');
  el.className = 'msg ai';
  el.id = 'typingMsg';
  el.innerHTML = `<div class="avatar"></div><div class="bubble">`
    + `<span class="typing"><i></i><i></i><i></i></span>`
    + `<span class="typing-note">${esc(label || 'Connecting to Hermes')} <b>0.0s</b></span>`
    + `</div>`;
  msgList.appendChild(el);
  scrollBottom();

  const note = el.querySelector('.typing-note b');
  const t0 = performance.now();
  const timer = setInterval(() => {
    if (!note || !note.isConnected) { clearInterval(timer); return; }
    note.textContent = ((performance.now() - t0) / 1000).toFixed(1) + 's';
  }, 200);
  el.dataset.timer = 'on';

  /* Let callers stop the timer just by removing the element */
  const remove = el.remove.bind(el);
  el.remove = () => {
    clearInterval(timer);
    remove();
  };
  return el;
}

function addAI(text, card) {
  const el = document.createElement('div');
  el.className = 'msg ai';
  /* Assistant answers render as markdown; history uses the same path so a
     reply doesn't turn from formatted to plain text after a refresh. */
  let html = `<div class="avatar"></div><div class="bubble md">${
    window.__md ? window.__md(text) : '<p>' + esc(text) + '</p>'
  }`;
  if (card) {
    html += `<div class="inline-card">
      <div class="ic-head"><span class="dot cyan"></span>${esc(card.title)}</div>
      <div class="ic-body">` +
      card.rows.map(([k, v]) => `<div class="ic-kv"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`).join('') +
      `</div></div>`;
  }
  html += `</div>`;
  el.innerHTML = html;
  msgList.appendChild(el);
  scrollBottom();
}

/* Character-by-character reveal, simulating streaming */
function streamAI(text, card, done) {
  const el = document.createElement('div');
  el.className = 'msg ai';
  el.innerHTML = `<div class="avatar"></div><div class="bubble"><p></p></div>`;
  msgList.appendChild(el);
  const p = el.querySelector('p');

  const total = text.length;
  const perChar = 26;                 // 26ms per 2 characters
  const duration = Math.max(400, Math.ceil(total / 2) * perChar);
  const start = performance.now();
  let finished = false;

  const finish = () => {
    if (finished) return;
    finished = true;
    p.textContent = text;
    if (card) {
      const c = document.createElement('div');
      c.className = 'inline-card';
      c.innerHTML = `<div class="ic-head"><span class="dot cyan"></span>${esc(card.title)}</div>
        <div class="ic-body">` +
        card.rows.map(([k, v]) => `<div class="ic-kv"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`).join('') +
        `</div>`;
      el.querySelector('.bubble').appendChild(c);
      scrollBottom();
    }
    done && done();
  };

  /* Advance by timestamp instead of accumulating per-frame setTimeout calls:
     background tabs throttle timers to 1s, so accumulation would stretch the
     reveal to tens of seconds and keep busy locked. Real-time progress only
     skips characters when throttled, never stalls. */
  const tick = () => {
    const elapsed = performance.now() - start;
    const ratio = Math.min(1, elapsed / duration);
    const n = Math.ceil(ratio * total);
    p.textContent = text.slice(0, n);
    scrollBottom(false);
    if (ratio >= 1) { finish(); return; }
    requestAnimationFrame(tick);
  };
  tick();

  /* Hard fallback: done must be called even if rendering is throttled */
  setTimeout(finish, duration + 2000);
}

/* Send a message → get a reply
   Note: while the previous reply is still streaming, new messages must be
   queued, not dropped, or a rapid second message would silently vanish. */
/* ─────────────────── Backend API (real Hermes) ───────────────────
   All requests go same-origin under BASE: nginx proxies /ai/ to the local authd.
   · Sessions use an HttpOnly cookie; the page never sees or needs the token
   · Mutations carry X-CSRF, issued by /api/session
   · Failures must be shown to the user, never swallowed silently */

const API = BASE + 'api/';
let csrfToken = null;

async function apiFetch(name, options) {
  const opts = Object.assign({ credentials: 'same-origin', cache: 'no-store' }, options || {});
  opts.headers = Object.assign({}, opts.headers || {});
  if (opts.method && opts.method !== 'GET' && csrfToken) {
    opts.headers['X-CSRF'] = csrfToken;
  }
  const res = await fetch(API + name, opts);
  if (res.status === 401) {
    /* Session expired: go to login instead of staying on a broken screen */
    location.replace(BASE + 'login');
    throw new Error('Session expired');
  }
  let data = {};
  try {
    data = await res.json();
  } catch (e) { /* non-JSON response → treat as empty object */ }
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || ('Request failed ' + res.status));
  }
  return data;
}

const ready = apiFetch('session')
  .then((d) => { csrfToken = d.csrf; return d; })
  .catch(() => null);

/* Speech transcription: hand the recorded audio to the backend (which forwards
   it to the local asr_api). Lives here because it reuses CSRF/401 handling;
   composer.js does not deal with auth. Has a hard 25s timeout: a stuck network
   must error out rather than sit on "Transcribing…" forever. */
window.__transcribe = async (blob) => {
  await ready;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const res = await fetch(API + 'asr', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      signal: ctrl.signal,
      headers: {
        'Content-Type': blob.type || 'application/octet-stream',
        'X-CSRF': csrfToken || '',
      },
      body: blob,
    });
    if (res.status === 401) {
      location.replace(BASE + 'login');
      throw new Error('Session expired');
    }
    let data = {};
    try { data = await res.json(); } catch (e) { /* not JSON */ }
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || ('Transcription failed ' + res.status));
    }
    return data;
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error('Transcription timed out — try again');
    throw err;
  } finally {
    clearTimeout(timer);
  }
};

/* ───────────────────────── Conversation ───────────────────────── */

let busy = false;
const sendQueue = [];

function send(text, isVoice = false) {
  const t = (text || '').trim();
  if (!t) return;
  sendQueue.push({ text: t, isVoice });
  drainQueue();
}

function drainQueue() {
  if (busy || !sendQueue.length) return;
  const { text, isVoice } = sendQueue.shift();
  addUser(text, isVoice);
  busy = true;

  /* Safety net: no exception may leave busy stuck, or later messages are silently dropped */
  const release = once(() => {
    busy = false;
    drainQueue();
  });
  const guard = setTimeout(() => {
    console.warn('[chat] guard fired, releasing busy');
    release();
  }, 200000);

  const t = addTyping();

  (async () => {
    /* Read NDJSON via fetch + ReadableStream, painting token by token */
    let bubbleBox = null;
    let acc = '';
    let started = performance.now();
    let sid = null;

    /* ── Thinking trace ───────────────────────────────
       Before the first token, Hermes may run several tools (seconds to tens
       of seconds). A spinner left the user guessing. Now a slim thinking bar
       shows what's happening and how long it's been; on the first token it
       collapses to "Thought N.Ns" and can be tapped to expand the steps. */
    let think = null;
    let thinkT0 = 0;
    let thinkTimer = null;

    const ensureThink = () => {
      if (think) return think;
      const el = document.createElement('div');
      el.className = 'msg ai thinking';
      el.innerHTML = '<div class="avatar"></div>'
        + '<div class="think-bar">'
        + '<span class="think-dots"><i></i><i></i><i></i></span>'
        + '<span class="think-text">Thinking…</span>'
        + '<span class="think-secs">0.0s</span>'
        + '<span class="think-caret">▾</span>'
        + '</div>'
        + '<div class="think-steps"></div>';
      msgList.appendChild(el);
      think = el;
      thinkT0 = performance.now();
      const bar = el.querySelector('.think-bar');
      if (bar) {
        bar.addEventListener('click', () => {
          el.classList.toggle('open');
        });
      }
      (function tick() {
        if (!think || !think.isConnected) return;
        const secs = (performance.now() - thinkT0) / 1000;
        const out = think.querySelector('.think-secs');
        if (out) out.textContent = secs.toFixed(1) + 's';
        thinkTimer = setTimeout(tick, 100);
      })();
      scrollBottom();
      return think;
    };

    const pushStep = (evt) => {
      const el = ensureThink();
      const steps = el.querySelector('.think-steps');
      if (!steps) return;
      const isResult = evt.kind === 'result';
      if (isResult) {
        /* Results only update the last row's state instead of adding a row
           (the list would explode). Rows come from tool_use; when tool_result
           arrives, match by name against the newest incomplete row
           (the list is reversed, so scan from the head). */
        const hit = Array.from(steps.children)
          .find((r) => r.dataset.tool === String(evt.name) && !r.classList.contains('ok'));
        if (hit) {
          hit.classList.add('ok');
          const d = hit.querySelector('.ts-detail');
          if (d && evt.detail) d.textContent = evt.detail;
          return;
        }
      }
      const row = document.createElement('div');
      row.className = 'think-step' + (isResult ? ' ok' : '');
      row.dataset.tool = String(evt.name || '');
      row.innerHTML = '<span class="ts-icon"></span>'
        + '<span class="ts-name"></span>'
        + '<span class="ts-detail"></span>';
      row.querySelector('.ts-name').textContent = evt.name || 'Step';
      row.querySelector('.ts-detail').textContent = evt.detail || '';
      /* Insert in reverse: newest step on top, so there's no scrolling to
         find it and the growing list doesn't push the answer away. */
      steps.insertBefore(row, steps.firstChild);
      while (steps.children.length > 6) steps.removeChild(steps.lastElementChild);
      if (isResult) return;   /* result rows don't overwrite the status text */
      const txt = el.querySelector('.think-text');
      if (txt) txt.textContent = evt.name || 'Working';
      scrollBottom(false);
    };

    const finishThink = () => {
      /* Even if the think reference is lost, mark every unfinished thinking bar
         as done. answer_start / delta both call this; if the reference was
         cleared early, a leftover "Thinking…" sticks forever — the user sees
         "thinking only, answer never appears". */
      const stuck = msgList.querySelectorAll('.thinking:not(.done)');
      stuck.forEach((el) => {
        el.classList.add('done');
        const txt = el.querySelector('.think-text');
        if (txt && /Thinking|Working/.test(txt.textContent || '')) {
          const secs = ((performance.now() - thinkT0) / 1000).toFixed(1);
          txt.textContent = 'Thought for ' + secs + 's';
        }
        const ticker = el.querySelector('.think-secs');
        if (ticker) ticker.textContent = '';
      });
      if (!think || !think.isConnected) { think = null; return; }
      clearTimeout(thinkTimer);
      think.classList.add('done');
      const secs = ((performance.now() - thinkT0) / 1000).toFixed(1);
      const txt = think.querySelector('.think-text');
      if (txt) txt.textContent = 'Thought for ' + secs + 's';
      /* Collapsed state shows the total only; keeping the stopwatch cell would show "4.6s 4.5s" twice */
      const ticker = think.querySelector('.think-secs');
      if (ticker) ticker.textContent = '';
      think = null;
    };

    const ensureBubble = () => {
      if (bubbleBox) return bubbleBox;
      const el = document.createElement('div');
      el.className = 'msg ai';
      el.innerHTML = '<div class="avatar"></div><div class="bubble md"></div>';
      /* The thinking bar and answer bubble are two separate .msg elements.
         Appending the bubble last gives "bubble → thinking bar" in the DOM,
         which reads as if the answer precedes the thinking. The answer always
         goes below the thinking, so insert right after the thinking bar. */
      if (think && think.isConnected && think.parentNode === msgList) {
        msgList.insertBefore(el, think.nextSibling);
      } else {
        msgList.appendChild(el);
      }
      /* Keep only the container reference, never cache the inner <p>:
         paintNow rewrites innerHTML each time, so a cached <p> becomes detached
         and later writes to it are invisible — one cause of "answer frozen". */
      bubbleBox = el.querySelector('.bubble');
      scrollBottom();
      return bubbleBox;
    };

    /* ── Streaming markdown rendering ─────────────────
       Re-rendering the whole markdown on every chunk is too heavy (hundreds of
       chars, hundreds of chunks), so renders are coalesced to ~80ms.

       Key: rendering must hang off rAF, not setTimeout.
       iOS throttles setTimeout when backgrounded, locked, or when a long
       answer saturates the main thread (down to 1/min). If the last chunk's
       timer was throttled, content stayed on the previous frame — exactly
       "answer frozen until refresh". rAF pauses while hidden but fires a
       frame immediately on return, so nothing is lost. */
    let paintQueued = false;      // a frame is already queued (don't test the rAF return value — it can be 0)
    let rafId = null;
    let paintedLen = 0;

    const paintNow = () => {
      paintQueued = false;
      rafId = null;
      if (!acc) return;
      /* ensureBubble now returns the .bubble container itself.
         It used to be ensureBubble().parentNode, which with a container
         reference yields the outer .msg or null, so it returned here every
         time and no content reached the DOM (paints stuck at 0/1). */
      const box = ensureBubble();
      if (!box) return;
      try {
        box.innerHTML = window.__md ? window.__md(acc) : esc(acc);
      } catch (e) {
        box.textContent = acc;       // renderer error → fall back to plain text, never a blank screen
      }
      paintedLen = acc.length;
      scrollBottom(false);
    };

    const schedulePaint = () => {
      /* Track "queued" with a boolean, never via the timer/raf handle.
         requestAnimationFrame returns a positive integer but **the first frame
         may be 0**; treating 0 as "frame already queued" stops all future
         scheduling — only the first paint happens, the rest piles up in acc. */
      if (paintQueued) return;
      paintQueued = true;
      rafId = (window.requestAnimationFrame || ((f) => setTimeout(f, 16)))(paintNow);
    };

    /* Fallback: rAF doesn't run while hidden and on return a frame can be
       missed (especially in Safari low-power mode). Force a paint on visibility change. */
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && acc && paintedLen !== acc.length) paintNow();
    });
    /* On iOS rAF can stop entirely when backgrounded, locked, or switching
       apps. deltas keep arriving (fetch doesn't stop) but nothing paints —
       "only the thinking shows, the answer needs a refresh".
       So a low-frequency timer backs up rAF: whenever content is ahead of what
       was painted, paint synchronously. 150ms has negligible cost. */
    const paintWatchdog = setInterval(() => {
      if (acc && paintedLen !== acc.length) paintNow();
    }, 150);

    const flushBubble = () => {
      if (rafId !== null) {
        (window.cancelAnimationFrame || clearTimeout)(rafId);
        rafId = null;
      }
      paintQueued = false;
      const need = acc && paintedLen !== acc.length;
      /* rAF doesn't run while hidden, so paint synchronously here or the tail is lost */
      if (need || document.hidden) paintNow();
    };

    try {
      await ready;
      const res = await fetch(API + 'chat', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-CSRF': csrfToken || '' },
        body: JSON.stringify({
          message: text,
          bk: activeSid ? undefined : activeBk,
          rid: activeSid || undefined,
        }),
      });
      if (res.status === 401) {
        location.replace(BASE + 'login');
        throw new Error('Session expired');
      }
      if (!res.ok || !res.body) {
        throw new Error('Request failed ' + res.status);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      /* Whether done was received. A stream that ends without done was cut
         mid-way (iOS backgrounding killed the keep-alive, frp reconnect, etc.):
         content is partial and the user must be told, not shown as success. */
      let sawDone = false;
      /* Time of the last received data, used by the watchdog below */
      let lastChunkAt = performance.now();
      /* Stall watchdog: abort after 90s with no bytes at all.
         After iOS returns from background the old TCP connection is often dead
         without local knowledge, so read() hangs forever — "stuck until refresh".
         A healthy answer always produces output within that window (even the
         slowest first token has heartbeats). */
      const stall = setInterval(() => {
        if (performance.now() - lastChunkAt > 90000) {
          clearInterval(stall);
          try { reader.cancel(); } catch (e) { /* already closed */ }
        }
      }, 5000);

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        lastChunkAt = performance.now();
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let evt;
          try { evt = JSON.parse(line); } catch (e) { continue; }

          if (evt.type === 'init') {
            sid = evt.session_id || sid;
            /* Don't remove the typing indicator yet: there can be a few seconds
               between init and the first tool call, so hand off to the thinking
               bar first to avoid a blank gap. */
            think = ensureThink();
            try { t.remove(); } catch (e) { /* already removed */ }
          } else if (evt.type === 'step') {
            try { t.remove(); } catch (e) { /* already removed */ }
            pushStep(evt);
          } else if (evt.type === 'answer_start') {
            finishThink();
            ensureBubble();
          } else if (evt.type === 'delta') {
            try { t.remove(); } catch (e) { /* already removed */ }
            finishThink();
            acc += evt.text || '';
            schedulePaint();
            /* Diagnostics: tells "data not received" apart from "not rendered" when output stops early */
          } else if (evt.type === 'done') {
            sid = evt.session_id || sid;
            sawDone = true;
            finishThink();
            /* done means we're finished. Don't wait for read() to return done
               again: despite Connection: close, the TCP FIN can be delayed
               through frp/nginx/browser caches (on device: "all content shown
               but busy stuck"), so finally never runs and the next message is
               dropped as "busy". Cancel the reader so read() returns at once. */
            try { reader.cancel(); } catch (e) { /* already closed */ }
            if (evt.ms) paintLatency(evt.ms);
            /* Hermes produced images this turn (referenced in text or newly generated)
               → send them to the preview panel and light up the pull handle */
            if (Array.isArray(evt.images) && evt.images.length) {
              lastImages = evt.images;
              showPreview(evt.images[0].url);
              const trig = document.getElementById('drawerTrigger');
              if (trig) trig.classList.add('has-image');
            }
          } else if (evt.type === 'error') {
            throw new Error(evt.error || 'Backend error');
          }
        }
      }

      try { t.remove(); } catch (e) { /* already removed */ }
      flushBubble();                      /* paint the final chunk immediately at wrap-up */
      if (!bubbleBox) {
        addAI(acc || '(Hermes returned no text)');
      } else if (!acc.trim()) {
        bubbleBox.textContent = '(Hermes returned no text)';
      }

      /* Stream ended without done: content may be partial.
         Append a notice after the bubble; don't pass it off as success. */
      if (!sawDone && acc.trim() && bubbleBox && !bubbleBox.querySelector('.stream-cut')) {
        const tip = document.createElement('div');
        tip.className = 'stream-cut';
        tip.textContent = '⚠️ The answer may be incomplete (connection lost). Refresh or send again.';
        bubbleBox.appendChild(tip);
      }

      /* After the first reply of a new chat, bind Hermes' session_id so later
         messages in the same chat use --resume and keep context.
         Note: swallow errors here. This runs after the stream ends; a throw
         would fall into the catch below and overwrite the rendered answer with
         plain text — looking like "the answer didn't render until refresh". */
      if (sid) {
        const existed = serverSessions.some((s) => s.id === sid);
        activeSid = sid;
        if (!existed) {
          try {
            await loadSessions();
          } catch (e) {
            console.warn('[chat] failed to refresh session list; answer unaffected', e);
          }
        }
      }
    } catch (err) {
      try { t.remove(); } catch (e) { /* already removed */ }
      const msg = (err && err.message) ? err.message : 'Unknown error';
      /* If content exists, keep the markdown render and only append the error
         line at the end; a full textContent overwrite would lose formatting. */
      if (bubbleBox) {
        flushBubble();
        if (acc.trim()) {
          const tip = document.createElement('div');
          tip.className = 'stream-cut';
          tip.textContent = '⚠️ ' + msg;
          bubbleBox.appendChild(tip);
        } else {
          bubbleBox.textContent = '⚠️ ' + msg;
        }
      } else {
        addAI('⚠️ ' + msg);
      }
    } finally {
      /* release() must come first: it's the only path that clears busy.
         If earlier cleanup blocked it, all later messages would be dropped as
         "busy". Clearing timers is housekeeping and must not affect sending. */
      release();
      try { clearTimeout(guard); } catch (e) { /* ignore */ }
      try { clearInterval(stall); } catch (e) { /* ignore */ }
      try { clearInterval(paintWatchdog); } catch (e) { /* ignore */ }
    }
  })();
}

function once(fn) {
  let called = false;
  return (...args) => {
    if (called) return;
    called = true;
    fn(...args);
  };
}

/* ───────────────────────── Pull-up drawer ───────────────────────── */
const drawer = $('#drawer');
const drawerClip = $('#drawerClip');
const backdrop = $('#drawerBackdrop');
const grip = $('#drawerGrip');
const composerGesture = $('#composerGesture');

let dOpen = false;

function setClipOpen(on) {
  if (!drawerClip) return;
  drawerClip.classList.toggle('open', !!on);
}

function drawerOpen() {
  /* Don't use `if (dOpen) return`: during a drag bounce dOpen may already be
     true, yet the card still has to be restored to the open position. */
  dOpen = true;
  drawer.style.transform = '';
  drawer.classList.remove('dragging');
  drawer.classList.add('open');
  setClipOpen(true);
  drawer.setAttribute('aria-hidden', 'false');
  backdrop.classList.add('show');
}
function drawerClose() {
  dOpen = false;
  drawer.style.transform = '';
  drawer.classList.remove('dragging');
  drawer.classList.remove('open');
  setClipOpen(false);
  drawer.setAttribute('aria-hidden', 'true');
  backdrop.classList.remove('show');
}

/* Whether the user intends the panel to be open.
   Don't read the .open class: it's temporarily removed during drags so the
   inline transform takes over, while the intent is still open. Use dOpen then. */
function isOpen() {
  if (drawer.classList.contains('dragging')) return dOpen;
  const actual = drawer.classList.contains('open');
  if (dOpen !== actual) dOpen = actual;
  return dOpen;
}
function drawerToggle() { dOpen ? drawerClose() : drawerOpen(); }

function drawerHeight() { return drawer.getBoundingClientRect().height; }

/* ── Grip: left to the unified swipe-down handler ─────
   The grip used to have its own pointer drag logic that double-responded with
   the drawer's touch handler (each swipe applied twice: track, then snap back).
   It's now purely visual with no event listeners. */

/* ── Pull up: open the panel from the whole composer area (pill + field) ──
   Listens to touch + pointer directly, independent of composer.js state.
   Key: the composer veil calls preventDefault, so touchstart must be taken in
   the capture phase, and a large enough movement is a "pull up", not "hold to talk". */
/* ── Pull up: slide the card out of the whole composer area (pill + field) ──
   What makes it feel attached to the finger:
   1. Add .dragging (transition:none) to the drawer during drags, or every
      transform write lags behind the 0.34s transition and feels floaty.
   2. Move with translate3d batched through rAF, at most one write per frame.
   3. The open state reuses the same transform math, so drag and animation are continuous. */
const PULL_START_PX = 6;        // beyond this the pull is "dragging" and tracking the finger
const OPEN_THRESHOLD = 0.32;    // open once dragged past 32% of card height
const VELOCITY_FLICK = 0.8;     // px/ms — a fast flick also opens/closes
const FLICK_MIN_RATIO = 0.18;   // a flick needs at least 18% of card height to fire, so taps don't

let pull = null;

function drawerH() {
  return drawer.offsetHeight || Math.round(window.innerHeight * 0.74);
}
function composerH() {
  return parseFloat(getComputedStyle(document.documentElement)
    .getPropertyValue('--composer-h')) || 84;
}

/* Write transform.
   Deliberately not batched through requestAnimationFrame: rAF doesn't fire
   when the page is hidden/throttled, causing the hard-to-debug "drag does
   nothing". touchmove already fires per frame, so writing synchronously is fine. */
function scheduleTransform(value) {
  drawer.style.transform = value;
}

/* Convert "how many pixels of card are visible" into a transform.
   Scale for visible: 0 = fully collapsed, drawerH() + composerH() = fully open.
   The pull gesture's dy uses this directly (drag distance = reveal, capped at
   the full hide distance). */
function transformFor(visible) {
  /* Hide distance = the drawer's own height.
     The drawer slides inside .drawer-clip, whose bottom edge is the composer's
     top edge, so at zero offset the whole card is clipped out; every pixel
     moved up reveals one pixel — it appears to slide out of the input's top
     edge, not rise from the bottom of the screen. */
  const hideOffset = drawerH();
  const v = Math.max(0, Math.min(hideOffset, visible));
  return `translate3d(0, ${hideOffset - v}px, 0)`;
}

/* Voice takes priority.
   composer.js exposes state in window.__composer.S.mode:
   idle | pressing | recording | typing.
   Only recording means the long-press took effect and audio is being captured —
   then an upward swipe means "cancel voice" and must never pull the drawer out.
   The pressing phase (< 180ms held) still allows the drawer gesture, or pulling
   the panel up from the composer would be impossible. */
function voiceRecording() {
  const c = window.__composer;
  return !!(c && c.S && c.S.mode === 'recording');
}

/* Abandon the current drawer gesture and reset, so a half-dragged card doesn't float */
function abortPull() {
  if (!pull) return;
  pull.active = false;
  pull = null;
  drawer.classList.remove('dragging');
  drawer.style.transform = '';
  void drawer.offsetHeight;
  if (!dOpen) {
    drawer.classList.remove('open');
    setClipOpen(false);
    drawer.setAttribute('aria-hidden', 'true');
    backdrop.classList.remove('show');
  }
}

function pullStart(x, y) {
  if (isOpen()) return;
  if (voiceRecording()) return;          /* recording: drawer doesn't take over */
  pull = { y0: y, x0: x, dy: 0, lastT: performance.now(), v: 0, moved: false, active: true };
}

function pullMove(x, y) {
  if (!pull || !pull.active || isOpen()) return;
  /* Once recording starts (180ms hold), abandon the drawer gesture immediately */
  if (voiceRecording()) { abortPull(); return; }
  const dy = pull.y0 - y;                 // up is positive
  const dx = Math.abs(x - pull.x0);
  pull.dy = dy;
  if (Math.abs(dy) > PULL_START_PX || dx > PULL_START_PX) pull.moved = true;

  /* Velocity (for flick detection) */
  const now = performance.now();
  const dt = now - pull.lastT;
  if (dt > 0) pull.v = (pull.v * 0.6) + ((dy - (pull.lastDy || 0)) / dt) * 0.4;
  pull.lastT = now;
  pull.lastDy = dy;

  /* Only mostly-vertical swipes move the card */
  if (dy > PULL_START_PX && dy > dx * 1.1) {
    if (!pull.dragging) {
      pull.dragging = true;
      drawer.classList.add('dragging');
      /* Drop .open; the inline transform drives position, or the CSS rule overrides the drag */
      drawer.classList.remove('open');
      backdrop.classList.add('show');
      drawer.setAttribute('aria-hidden', 'false');
    }
    scheduleTransform(transformFor(dy));
  }
}

function pullEnd() {
  if (!pull) return {};
  const { dy, v, dragging, moved } = pull;
  pull.active = false;
  pull = null;

  drawer.classList.remove('dragging');
  /* Clear the inline style then force one reflow so the CSS .open / default
     rules take over at once; otherwise computed style can lag the actual render. */
  drawer.style.transform = '';
  void drawer.offsetHeight;

  if (dragging) {
    const h = drawerH();
    const flicked = v > VELOCITY_FLICK && dy > h * FLICK_MIN_RATIO;
    const shouldOpen = dy > h * OPEN_THRESHOLD || flicked;
    if (shouldOpen) {
      dOpen = true;
      drawer.classList.add('open');
      setClipOpen(true);
      drawer.setAttribute('aria-hidden', 'false');
      backdrop.classList.add('show');
    } else {
      dOpen = false;
      drawer.classList.remove('open');
      setClipOpen(false);
      drawer.setAttribute('aria-hidden', 'true');
      backdrop.classList.remove('show');
    }
  }
  return { moved, dy };
}

/* touch: capture phase, recording the start point before the veil preventDefaults */
composerGesture?.addEventListener('touchstart', (e) => {
  const t = e.touches[0];
  if (t) pullStart(t.clientX, t.clientY);
}, { passive: true, capture: true });
composerGesture?.addEventListener('touchmove', (e) => {
  const t = e.touches[0];
  if (t) pullMove(t.clientX, t.clientY);
}, { passive: true, capture: true });
composerGesture?.addEventListener('touchend', (e) => {
  const res = pullEnd();
  /* If this really was a pull-up, tell the composer not to treat it as tap/long-press */
  if (res && res.moved && res.dy > PULL_START_PX) {
    window.__suppressNextTap?.();
  }
}, { passive: true, capture: true });
composerGesture?.addEventListener('touchcancel', () => { pullEnd(); }, { passive: true, capture: true });

/* Desktop: dragging the mouse up from the composer also pulls it out */
composerGesture?.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'mouse') return;
  pullStart(e.clientX, e.clientY);
});
composerGesture?.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse' || !pull) return;
  pullMove(e.clientX, e.clientY);
});
composerGesture?.addEventListener('pointerup', (e) => {
  if (e.pointerType !== 'mouse') return;
  pullEnd();
});

backdrop.addEventListener('click', drawerClose);

/* ── Swipe down to close: the whole drawer is a start zone (including the grip) ──
   Previously only drawer-body was bound, leaving a gap between grip and content
   where swiping did nothing. Now bound to .drawer, using scrollTop to decide
   whether the content should scroll first. */
let swipeDown = null;
const drawerBody = document.querySelector('.drawer-body');

drawer.addEventListener('touchstart', (e) => {
  if (!isOpen()) return;
  const t = e.touches[0];
  swipeDown = {
    y0: t.clientY, dy: 0, active: true,
    lastT: performance.now(), lastDy: 0, v: 0, dragging: false,
  };
}, { passive: true });

drawer.addEventListener('touchmove', (e) => {
  if (!swipeDown || !swipeDown.active) return;
  const t = e.touches[0];
  const dy = t.clientY - swipeDown.y0;
  const atTop = !drawerBody || drawerBody.scrollTop <= 0;

  /* If content isn't at the top let it scroll first; take over closing at the top */
  if (dy <= 0 || !atTop) {
    if (swipeDown.dragging) {
      swipeDown.dragging = false;
      drawer.classList.remove('dragging');
      drawer.style.transform = '';
    }
    return;
  }

  swipeDown.dy = dy;
  const now = performance.now();
  const dt = now - swipeDown.lastT;
  if (dt > 0) swipeDown.v = (swipeDown.v * 0.6) + ((dy - swipeDown.lastDy) / dt) * 0.4;
  swipeDown.lastT = now;
  swipeDown.lastDy = dy;

  if (!swipeDown.dragging) {
    swipeDown.dragging = true;
    drawer.classList.add('dragging');
    /* .open must be removed during a drag or its transform overrides the
       inline style — finger moves, card doesn't. Inline transform drives it. */
    drawer.classList.remove('open');
  }
  /* Dragging down = card moves down, reveal counts down from fully open */
  const hideOffset = drawerH();
  const visible = Math.max(0, hideOffset - dy);
  scheduleTransform(transformFor(visible));
}, { passive: true });

function swipeDownEnd() {
  if (!swipeDown) return;
  const { dy, v, dragging } = swipeDown;
  swipeDown.active = false;
  swipeDown = null;

  drawer.classList.remove('dragging');
  drawer.style.transform = '';
  void drawer.offsetHeight;

  if (!dragging) return;
  const h = drawerH();
  const flicked = v > VELOCITY_FLICK && dy > h * FLICK_MIN_RATIO;
  const shouldClose = dy > h * 0.24 || flicked;
  if (shouldClose) drawerClose();
  else drawerOpen();   /* not enough drag → snap back to open */
}

drawer.addEventListener('touchend', swipeDownEnd, { passive: true });
drawer.addEventListener('touchcancel', swipeDownEnd, { passive: true });

/* ───────────────────────── Image preview ───────────────────────── */
/* Images returned by Hermes are shown here.
   Current design: one at a time — newer images replace it; no thumbnail list.
   External code only needs window.__showPreview(url). */
const previewStage = $('#previewStage');
const previewImg = $('#previewImg');
const previewEmpty = $('#previewEmpty');

function showPreview(url) {
  if (!previewImg || !url || typeof url !== 'string') return;
  previewImg.classList.remove('loaded');
  previewImg.hidden = false;
  if (previewEmpty) previewEmpty.style.display = 'none';
  if (previewStage) previewStage.classList.remove('empty');

  previewImg.src = url;
  /* onload may not fire for cached images; use complete as a fallback */
  const reveal = () => previewImg.classList.add('loaded');
  if (previewImg.complete && previewImg.naturalWidth) reveal();
  else previewImg.onload = reveal;
}

/* Clear the preview back to the "No image" empty state */
/* Images sent by Hermes this turn (the first one goes to the preview) */
let lastImages = [];

function clearPreview() {
  lastImages = [];
  const trig = document.getElementById('drawerTrigger');
  if (trig) trig.classList.remove('has-image');
  if (!previewImg) return;
  previewImg.removeAttribute('src');
  previewImg.classList.remove('loaded');
  previewImg.hidden = true;
  if (previewEmpty) previewEmpty.style.display = '';
  if (previewStage) previewStage.classList.add('empty');
}

/* Tap the image to view it full screen (native Safari preview, no custom overlay) */
previewImg?.addEventListener('click', () => {
  if (!previewImg.src) return;
  window.open(previewImg.src, '_blank');
});

/* Legacy API: arrays are accepted but only the first item is used (one image at a time) */
window.__addPreviewImages = (urls) => {
  const url = Array.isArray(urls) ? urls[0] : urls;
  showPreview(url);
};
window.__showPreview = showPreview;
window.__clearPreview = clearPreview;

/* ══════════ Top bar fade mask ══════════ */
/* Show the fade mask only once content actually scrolls under the top bar,
   otherwise it paints a dark horizontal band on a static page (the background
   looks cut in two). Sync on scroll plus touch events so throttled scroll
   events in some browsers don't leave the state stale. */
(function initTopbarFade() {
  const topbar = document.querySelector('.topbar');
  const feed = document.getElementById('feed');
  if (!topbar || !feed) return;

  let last = -1;
  const sync = () => {
    const y = feed.scrollTop;
    if (y === last) return;
    last = y;
    topbar.classList.toggle('scrolled', y > 4);
  };

  feed.addEventListener('scroll', sync, { passive: true });
  feed.addEventListener('touchmove', sync, { passive: true });
  feed.addEventListener('touchend', sync, { passive: true });
  window.addEventListener('resize', sync);
  /* Sending a message grows the content, which may change scroll position */
  const mo = new MutationObserver(sync);
  mo.observe(feed, { childList: true, subtree: true });

  sync();
})();

/* ══════════ Connection latency indicator ══════════ */
/* Measure real RTT with a same-origin request (the page is tiny; body is ignored).
   Three color tiers: < 120ms green / 120-350ms amber / > 350ms or failure red. */
const brandState = $('#brandState');
const bsText = brandState?.querySelector('.bs-text');

const LAT_GOOD = 120;
const LAT_FAIR = 350;

function paintLatency(ms) {
  if (!brandState || !bsText) return;
  if (ms === null) {
    brandState.dataset.state = 'poor';
    bsText.textContent = 'Offline';
    brandState.title = 'Connection failed';
    return;
  }
  const state = ms < LAT_GOOD ? 'good' : (ms < LAT_FAIR ? 'fair' : 'poor');
  brandState.dataset.state = state;
  bsText.textContent = Math.round(ms) + ' ms';
  brandState.title = `Latency ${Math.round(ms)} ms`;
}

async function pingLatency() {
  const t0 = performance.now();
  try {
    /* Use /api/status: it really probes the local Hermes health endpoint, so
       this number reflects whether/how fast the backend is alive, not the page RTT. */
    const data = await apiFetch('status');
    const rtt = performance.now() - t0;
    const backend = data.hermes || {};
    if (backend.ok === false) {
      paintLatency(null);
      return;
    }
    /* Take the larger of backend-reported time and network round trip; avoid an optimistic number */
    paintLatency(Math.max(rtt, backend.ms || 0));
  } catch (e) {
    paintLatency(null);
  }
}

pingLatency();
/* Refresh every 8s; refresh immediately when the page returns to the foreground */
setInterval(pingLatency, 8000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) pingLatency();
});

/* Exposed externally (a backend-measured latency can be pushed later) */
window.__setLatency = paintLatency;

/* ══════════ Session list (slides in from the left) ══════════ */
const sessions = $('#sessions');
const sessionsBackdrop = $('#sessionsBackdrop');
const sessionsList = $('#sessionsList');

let sOpen = false;

/* ───────────── Sessions (real Hermes session store) ─────────────
   The sidebar lists Hermes' own sessions; opening one loads real history and
   later messages continue it via --resume. A new chat starts as a draft and is
   bound to the Hermes session_id after the first reply. */

let serverSessions = [];   // from /api/sessions
let activeSid = null;      // current Hermes session id; null = new chat draft
let activeBk = newBk();    // Hermes session key for the draft (aipanel-xxxx)

function newBk() {
  const alphabet = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < 16; i += 1) s += alphabet[Math.floor(Math.random() * 16)];
  return 'aipanel-' + s;
}

function relTime(ms) {
  if (!ms) return '';
  const diff = Date.now() - ms;
  if (diff < 60e3) return 'Just now';
  if (diff < 3600e3) return Math.floor(diff / 60e3) + ' min ago';
  if (diff < 86400e3) return Math.floor(diff / 3600e3) + ' hr ago';
  if (diff < 7 * 86400e3) return Math.floor(diff / 86400e3) + ' d ago';
  const d = new Date(ms);
  return (d.getMonth() + 1) + '/' + d.getDate();
}

function renderSessions() {
  if (!sessionsList) return;
  sessionsList.innerHTML = '';

  /* Show a draft item at the top of a new, unsent chat. Otherwise tapping
     "New chat" leaves the sidebar unchanged and looks like a dead button. */
  if (!activeSid) {
    const draft = document.createElement('button');
    draft.className = 'session-item active draft';
    draft.type = 'button';
    draft.innerHTML = '<span class="si-text">New chat…</span><span class="si-time">Not sent</span>';
    sessionsList.appendChild(draft);
  }

  if (!serverSessions.length) {
    const d = document.createElement('div');
    d.className = 'sessions-empty';
    d.textContent = activeSid ? 'No chats yet' : '';
    if (d.textContent) sessionsList.appendChild(d);
    return;
  }
  serverSessions.forEach((s) => {
    const b = document.createElement('button');
    b.className = 'session-item' + (s.id === activeSid ? ' active' : '');
    b.type = 'button';
    b.dataset.id = s.id;
    b.innerHTML = `<span class="si-text">${esc(s.title || '(Untitled)')}</span>`
      + `<span class="si-time">${esc(relTime(s.at))}</span>`;
    b.addEventListener('click', () => switchSession(s.id));
    sessionsList.appendChild(b);
  });
}

async function loadSessions() {
  try {
    const data = await apiFetch('sessions');
    serverSessions = data.sessions || [];
  } catch (e) {
    serverSessions = [];
  }
  renderSessions();
}

function showWelcome() {
  msgList.innerHTML = '';
  addAI('What would you like to ask?', {
    title: 'Connected',
    rows: [['Backend', 'Hermes'], ['Session', activeSid ? 'Resumed' : 'New']],
  });
}

async function switchSession(id) {
  sessionsClose();
  if (id === activeSid) return;
  activeSid = id;
  renderSessions();

  msgList.innerHTML = '';
  sendQueue.length = 0;
  clearPreview();
  const tip = addTyping('Loading history');
  try {
    const data = await apiFetch('history?id=' + encodeURIComponent(id));
    tip.remove();
    const msgs = data.messages || [];
    if (!msgs.length) {
      addAI('This chat has no visible messages yet.');
      return;
    }
    msgs.forEach((m) => {
      if (m.role === 'user') addUser(m.text);
      else addAI(m.text);
    });
  } catch (e) {
    tip.remove();
    addAI('Failed to load history: ' + (e.message || e));
  }
}

function newSession() {
  activeSid = null;
  activeBk = newBk();
  msgList.innerHTML = '';
  sendQueue.length = 0;
  clearPreview();
  renderSessions();
  sessionsClose();
  showWelcome();
}

function sessionsOpen() {
  /* Don't exit early with `if (sOpen) return`: during a drag bounce sOpen may
     already be true, yet the panel still has to be restored to the open position. */
  sOpen = true;
  sessions.style.transform = '';
  sessions.classList.remove('dragging');
  sessions.classList.add('open');
  sessions.setAttribute('aria-hidden', 'false');
  sessionsBackdrop.classList.add('show');
}
function sessionsClose() {
  /* Same as above: must really close even during a drag bounce */
  sOpen = false;
  sessions.style.transform = '';
  sessions.classList.remove('dragging');
  sessions.classList.remove('open');
  sessions.setAttribute('aria-hidden', 'true');
  sessionsBackdrop.classList.remove('show');
}
/* Keep sOpen in sync with the DOM so gestures aren't swallowed after external class changes */
function sessionsIsOpen() {
  const actual = sessions.classList.contains('open');
  if (sOpen !== actual) sOpen = actual;
  return sOpen;
}

$('#btnNewChat')?.addEventListener('click', newSession);

/* Sign out: invalidate the session server-side, then return to login.
   Local chat history is cleared so the next person on this device sees nothing. */
$('#btnLogout')?.addEventListener('click', async () => {
  try {
    await apiFetch('logout', { method: 'POST' });
  } catch (e) { /* token already expired — still go to login */ }
  location.replace(BASE + 'login');
});
/* Tap outside the panel to close (the backdrop covers the rest of the screen) */
sessionsBackdrop?.addEventListener('click', sessionsClose);
/* Fallback: on devices the click is sometimes swallowed by gesture handling,
   so also treat a touch that starts on the backdrop and doesn't move as a tap */
let backdropTouch = null;
sessionsBackdrop?.addEventListener('touchstart', (e) => {
  const t = e.touches[0];
  backdropTouch = t ? { x: t.clientX, y: t.clientY } : null;
}, { passive: true });
sessionsBackdrop?.addEventListener('touchend', (e) => {
  if (!backdropTouch) return;
  const t = e.changedTouches[0];
  const moved = t ? Math.hypot(t.clientX - backdropTouch.x, t.clientY - backdropTouch.y) : 99;
  backdropTouch = null;
  if (moved < 12) sessionsClose();
}, { passive: true });

/* Swipe right from the left edge to reveal the list; when open, swipe left/right inside it to close */
let sPull = null;
const EDGE_W = 24;

function sStart(x, y) {
  /* Note: do NOT add an `if (pull) return` guard here. The drawer's pull is a
     different gesture object; if it wasn't cleared after an error it would
     block the session list forever ("can't swipe it out at all"). The two start
     zones don't overlap (the drawer's is the bottom composer). */

  if (sessionsIsOpen()) {
    /* Already open: allow a leftward swipe inside the panel (x < panel width) to close */
    const w = sessions.offsetWidth || 300;
    if (x <= w) {
      sPull = { x0: x, y0: y, dx: 0, moved: false, active: true, mode: 'close' };
    }
    return;
  }

  /* Only accept gestures starting at the left screen edge, so they don't clash with composer swipes */
  if (x > EDGE_W) return;
  sPull = { x0: x, y0: y, dx: 0, moved: false, active: true, mode: 'open' };
}

function sMove(x, y) {
  if (!sPull || !sPull.active) return;
  const dx = x - sPull.x0;
  const dy = Math.abs(y - sPull.y0);
  sPull.dx = dx;
  if (Math.abs(dx) > 6 || dy > 6) sPull.moved = true;

  const w = sessions.offsetWidth || 300;

  if (sPull.mode === 'open') {
    if (sessionsIsOpen()) return;
    /* Only mostly-horizontal movement moves the panel */
    if (dx > 6 && dx > dy * 1.1) {
      if (!sPull.dragging) {
        sPull.dragging = true;
        sessions.classList.add('dragging');
        sessionsBackdrop.classList.add('show');
        sessions.setAttribute('aria-hidden', 'false');
      }
      const visible = Math.min(w, dx);
      sessions.style.transform = `translate3d(${visible - w}px, 0, 0)`;
    }
  } else {
    /* mode === 'close': drag left, offset goes from 0 toward -w */
    if (dx < -6 && Math.abs(dx) > dy * 1.1) {
      if (!sPull.dragging) {
        sPull.dragging = true;
        sessions.classList.add('dragging');
      }
      const visible = Math.max(0, w + dx);
      sessions.style.transform = `translate3d(${visible - w}px, 0, 0)`;
    }
  }
}

function sEnd() {
  if (!sPull) return;
  const { dx, dragging, mode } = sPull;
  sPull.active = false;
  sPull = null;

  /* Clear the drag's inline transform first; it outranks the .open CSS rule
     and the panel would stop where the drag left it */
  sessions.classList.remove('dragging');
  sessions.style.transform = '';
  void sessions.offsetWidth;   /* force reflow so the CSS rules take over at once */

  if (!dragging) return;
  const w = sessions.offsetWidth || 300;

  if (mode === 'close') {
    /* Close if dragged left more than 26% of the width */
    if (dx < -w * 0.26) sessionsClose();
    else sessionsOpen();
    return;
  }

  if (dx > w * 0.34) sessionsOpen();
  else sessionsClose();
}

/* Listen on document (capture) so a start anywhere is seen, but only
   activate when x falls on the left edge */
function onDocTouchStart(e) {
  const t = e.touches[0];
  if (t) sStart(t.clientX, t.clientY);
}
function onDocTouchMove(e) {
  const t = e.touches[0];
  if (t) sMove(t.clientX, t.clientY);
}

document.addEventListener('touchstart', onDocTouchStart, { passive: true, capture: true });
document.addEventListener('touchmove', onDocTouchMove, { passive: true, capture: true });
document.addEventListener('touchend', () => sEnd(), { passive: true, capture: true });
document.addEventListener('touchcancel', () => sEnd(), { passive: true, capture: true });

/* Desktop: drag with the mouse from the left edge */
document.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'mouse') return;
  sStart(e.clientX, e.clientY);
});
document.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse' || !sPull) return;
  sMove(e.clientX, e.clientY);
});
document.addEventListener('pointerup', (e) => {
  if (e.pointerType !== 'mouse') return;
  sEnd();
});

/* ── Left-edge hot zone: preferred start for the gesture ──
   The document listeners above are the fallback. On iOS the composer veil's
   preventDefault can keep touchstart from reaching some document paths, so the
   left edge gets its own channel: a pointer in this thin strip is handled here
   without relying on document bubbling. */
const edgeSwipe = document.getElementById('edgeSwipe');
if (edgeSwipe) {
  const edgeTouch = (e) => {
    const t = e.touches ? e.touches[0] : e;
    if (!t) return;
    /* When the panel is open the edge layer yields (close via panel swipe or backdrop tap) */
    if (sessionsIsOpen()) return;
    sStart(t.clientX, t.clientY);
  };
  edgeSwipe.addEventListener('touchstart', edgeTouch, { passive: true });
  edgeSwipe.addEventListener('touchmove', (e) => {
    const t = e.touches[0];
    if (t) sMove(t.clientX, t.clientY);
  }, { passive: true });
  edgeSwipe.addEventListener('touchend', () => sEnd(), { passive: true });
  edgeSwipe.addEventListener('touchcancel', () => sEnd(), { passive: true });

  edgeSwipe.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse') return;
    edgeTouch(e);
  });
  edgeSwipe.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse' || !sPull) return;
    sMove(e.clientX, e.clientY);
  });
  edgeSwipe.addEventListener('pointerup', (e) => {
    if (e.pointerType !== 'mouse') return;
    sEnd();
  });
}

renderSessions();

/* ───────────────────────── Init ───────────────────────── */
/* No made-up data at startup: read /api/status and show the real backend state. */
async function seed() {
  let rows = [['Backend', 'Checking'], ['Hermes', 'Checking'], ['Session', 'Established']];
  try {
    const data = await apiFetch('status');
    const h = data.hermes || {};
    rows = [
      ['Backend', 'Connected'],
      ['Hermes', h.ok ? (h.version || 'Online') : 'Offline'],
      ['Response', (h.ms || 0) + ' ms'],
    ];
  } catch (e) {
    rows = [['Backend', 'Disconnected'], ['Hermes', 'Unknown'], ['Session', 'Established']];
  }
  addAI('Muscovado is ready. Type a message, or hold the input bar to speak.', {
    title: 'System status',
    rows,
  });
  /* Sidebar lists real Hermes sessions; opening one shows real history */
  await loadSessions();
}

/* Voice/input logic lives in composer.js; it calls send from here */
window.__sendMessage = send;

seed();

/* Disable double-tap zoom / pull-to-refresh (more stable on full-screen phones) */
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault());

/* Fully lock page zoom and scroll: pinch zoom, rubber-banding, iOS double-tap zoom */
document.addEventListener('wheel', (e) => {
  if (e.ctrlKey) e.preventDefault();                 // desktop Ctrl+wheel zoom
}, { passive: false });

/* Legacy iOS Safari gesture events */
['gesturestart', 'gesturechange', 'gestureend'].forEach((ev) => {
  document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
});

/* ── Globally block the loupe ────────────────────────────
   WebKit bug 296492: iOS's tap-and-hold loupe can't be disabled via CSS, only
   with JS. But the cost is severe: preventDefault on touchstart makes iOS treat
   the touch as "not a user gesture", so a synchronous focus() afterwards can't
   raise the keyboard. The composer must therefore be let through precisely —
   its loupe problem is handled separately by the veil. */
/* Scrollable containers / clickable panels: hitting one hands the touch back to
   the browser. Note the whole session panel must pass — the global touchstart
   preventDefault also cancels the following click on iOS, which is why
   "New chat" and "Sign out" in the panel were unclickable. */
const SCROLLABLE = '#feed, .drawer-body, .sessions';
const scrollHost = (el) => (el && el.closest ? el.closest(SCROLLABLE) : null);
const isInputZone = (el) => !!(el && el.closest && el.closest('#inputBar'));

document.addEventListener('touchstart', (e) => {
  const t = e.target;
  /* Composer: let the whole area through, or short taps can't raise the keyboard */
  if (isInputZone(t)) return;
  /* Scrollable containers: let through, or they can't scroll */
  if (scrollHost(t)) return;
  /* Everything else static: block the loupe (no keyboard here, so preventDefault is harmless) */
  e.preventDefault();
}, { passive: false });

/* Fix the whole page: only the feed and panel interiors may scroll.
   Note: don't set position:fixed on body — .app's 100dvh would then resolve
   against body and the layout collapses when the keyboard opens. Locking
   overflow is enough. */
document.documentElement.style.overflow = 'hidden';
document.body.style.overflow = 'hidden';

