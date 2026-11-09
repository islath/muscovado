/* ════════════════════════════════════════════════════════════
   Composer touch handler (the iOS-critical logic)
   ────────────────────────────────────────────────────────────
   Problem: on touchend, iOS brings up the keyboard by itself if the
   touch ended on a focusable textarea. This happens after all JS events,
   so preventDefault / stopPropagation have no effect.

   Conclusion: the only reliable fix is to keep the textarea out of hit
   testing entirely while touching.
   - Idle:   textarea pointer-events: none  → the system can never reach it
   - Tap:    drop readOnly and focus, then re-arm interception next frame
   - Hold:   textarea is never touched, so no keyboard appears
   ════════════════════════════════════════════════════════════ */
'use strict';

(function initComposer() {
  const bar = document.getElementById('inputBar');
  const field = document.getElementById('field');
  const veil = document.getElementById('fieldVeil');
  const sendBtn = document.getElementById('sendBtn');
  const doSend = (t, v) => { if (window.__sendMessage) window.__sendMessage(t, v); };
  if (!bar || !field || !veil) return;

  const S = {
    holdDelay: 180,     // hold duration before recording starts
    tapMaxMs: 320,      // anything longer than this is never a tap
    cancelPx: 64,       // swipe-up cancel threshold
    mode: 'idle',       // idle | pressing | recording | typing
    startX: 0,
    startY: 0,
    startAt: 0,
    moved: false,
    cancelArmed: false,
    holdTimer: null,
    flashTimer: null,   // timer that auto-dismisses short HUD messages

    // Voice always uses server-side ASR (upload audio); 'off' = browser can't record
    asrMode: 'server',
    locked: true,       // true = textarea is excluded from hit testing
  };

  /* ── textarea hit-testing toggle ───────────────────── */
  function lockField() {
    if (S.locked) return;
    S.locked = true;
    field.style.pointerEvents = 'none';
    field.readOnly = true;
    bar.classList.remove('unlocked');
  }
  function unlockField() {
    if (!S.locked) return;
    S.locked = false;
    field.readOnly = false;
    field.style.pointerEvents = 'auto';
    bar.classList.add('unlocked');
  }

  /* ── Show the keyboard (only from a real tap) ──────── */
  function focusField() {
    unlockField();
    /* Must run in the synchronous stack of a user gesture; any setTimeout makes iOS refuse the keyboard */
    field.focus({ preventScroll: true });
    try {
      const len = field.value.length;
      field.setSelectionRange(len, len);
    } catch (e) {}
  }

  /* ── HUD and waveform ──────────────────────────────── */
  const hud = document.getElementById('voiceHud');
  const hudText = document.getElementById('vhText');
  const hudHint = document.getElementById('vhHint');
  const hudWave = document.getElementById('vhWave');

  const BARS = 22;
  const barEls = [];
  if (hudWave) {
    for (let i = 0; i < BARS; i++) {
      const b = document.createElement('i');
      hudWave.appendChild(b);
      barEls.push(b);
    }
  }
  let waveRaf = null;
  function startWave() {
    const t0 = performance.now();
    const loop = (t) => {
      const k = (t - t0) / 1000;
      barEls.forEach((b, i) => {
        const base = Math.sin(k * 5.2 + i * 0.62) * 0.5 + 0.5;
        const jitter = Math.sin(k * 13.7 + i * 1.9) * 0.22;
        b.style.height = (5 + Math.max(0, base + jitter) * 20).toFixed(1) + 'px';
      });
      waveRaf = requestAnimationFrame(loop);
    };
    waveRaf = requestAnimationFrame(loop);
  }
  function stopWave() {
    if (waveRaf) cancelAnimationFrame(waveRaf);
    waveRaf = null;
    barEls.forEach((b) => (b.style.height = '6px'));
  }


  function showHud() {
    if (!hud) return;
    hud.classList.add('show');
    hud.setAttribute('aria-hidden', 'false');
    startWave();
  }
  function hideHud() {
    if (!hud) return;
    hud.classList.remove('show', 'cancel');
    hud.setAttribute('aria-hidden', 'true');
    stopWave();
  }
  function setHudText(t, placeholder) {
    if (!hudText) return;
    if (placeholder) hudText.innerHTML = '<span class="placeholder">' + esc(t) + '</span>';
    else hudText.textContent = t;
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  const defaultHint = () => 'Release to send · swipe up to cancel';

  /* ── Start recording ───────────────────────────────── */
  function beginVoice() {
    if (S.mode === 'recording') return;
    S.mode = 'recording';
    S.cancelArmed = false;

    /* Lock the textarea while recording so the system can never focus it */
    lockField();
    try { field.blur(); } catch (e) {}
    try { document.getSelection().removeAllRanges(); } catch (e) {}

    bar.classList.add('recording');
    showHud();
    setHudText('Listening…', true);
    if (hudHint) hudHint.textContent = defaultHint();
    if (navigator.vibrate) navigator.vibrate(12);

    startServer();
  }


  /* ── Server-side recognition (local ASR) ───────────────
     Phone captures PCM → wraps it in WAV → uploads → asr_api on the host
     transcribes it with Paraformer.

     Why not MediaRecorder:
       On iOS, repeatedly constructing MediaRecorder on the same stream dies
       silently — the first few rounds work, then ondataavailable never fires
       ("it breaks after a few turns"). Its state machine and audio session
       are outside our control.
     So we capture PCM via WebAudio and wrap WAV ourselves: the capture graph
     is built once and recording is just a boolean, with no state machine. */

  const TARGET_RATE = 16000;      // asr_api also processes at 16k
  let audioCtx = null;
  let micStream = null;
  let srcNode = null;
  let procNode = null;
  let sinkNode = null;
  let pcmChunks = [];
  let capturing = false;

  function micLive() {
    return !!(micStream && micStream.getAudioTracks().some((t) => t.readyState === 'live'));
  }

  function releaseMic() {
    capturing = false;
    pcmChunks = [];
    if (srcNode) { try { srcNode.disconnect(); } catch (e) { /* already disconnected */ } srcNode = null; }
    if (procNode) { try { procNode.disconnect(); } catch (e) { /* already disconnected */ } procNode = null; }
    if (sinkNode) { try { sinkNode.disconnect(); } catch (e) { /* already disconnected */ } sinkNode = null; }
    if (micStream) {
      try { micStream.getTracks().forEach((t) => t.stop()); } catch (e) { /* already released */ }
      micStream = null;
    }
    if (audioCtx) {
      try { audioCtx.close(); } catch (e) { /* already closed */ }
      audioCtx = null;
    }
  }

  /* A always-open mic keeps the system recording indicator lit. Release it
     after 5 minutes idle; the chain is rebuilt on the next press (permission
     is already granted, so no prompt). */
  let idleTimer = null;
  function scheduleMicRelease() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!capturing) releaseMic();
    }, 5 * 60 * 1000);
  }

  window.addEventListener('pagehide', () => { clearTimeout(idleTimer); releaseMic(); });

  /* ── Permission and audio graph are separate concerns ──
     Permission: requested on page load (by design) so the prompt doesn't
     appear only when the user holds to talk.
     Graph: an AudioContext must be created inside the gesture that uses it.
     Creating it on page load is judged gesture-less and stays suspended
     permanently — even a resume() inside a later touch won't start it
     (reproduced locally).
     So we only grab the mic stream here and build the graph on press. */

  let permPromise = null;

  function requestMic(quiet) {
    if (micLive()) return Promise.resolve();
    if (permPromise) return permPromise;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return Promise.reject(new Error('Recording is not supported in this browser'));
    }
    permPromise = navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    })
      .then((stream) => { micStream = stream; })
      .catch((err) => {
        /* quiet: rejection on load is normal (iOS wants a gesture), stay silent */
        if (!quiet) {
          const name = (err && err.name) || '';
          if (name === 'NotAllowedError') flashHud('Microphone denied — check permissions');
          else if (name === 'NotFoundError') flashHud('No microphone available');
          else flashHud('Microphone unavailable');
        }
        throw err;
      })
      .finally(() => { permPromise = null; });
    return permPromise;
  }

  /* Diagnostics: see at a glance which stage is stuck */
  window.__micDebug = () => ({
    ctx: audioCtx ? audioCtx.state : 'none',
    live: micLive(),
    capturing,
    chunks: pcmChunks.length,
    samples: pcmChunks.reduce((n, c) => n + c.length, 0),
  });

  /* Legacy alias kept for old call sites */
  function primeMic(quiet) { return requestMic(quiet).catch(() => {}); }

  /* Request the mic as soon as the page opens */
  setTimeout(() => primeMic(true), 300);

  async function ensureCaptureChain() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error('WebAudio is not supported in this browser');

    if (!audioCtx) audioCtx = new AC();

    /* First make sure there is a live mic stream.
       getUserMedia must be the first await in this function: awaiting
       ctx.resume() first pushes the call outside the gesture and iOS rejects it. */
    if (!micLive()) {
      await requestMic(false);      // no prompt when already granted
    }

    /* Then make sure the graph is connected.
       Never gate this on if (!micLive()): when the stream was already obtained
       on load, micLive() is true on press, the graph is skipped, and the new
       AudioContext is empty — onaudioprocess never fires and the UI reports
       "no sound recorded" even though the user spoke. */
    if (!srcNode || !procNode || !sinkNode) {
      if (!micStream) throw new Error('No microphone stream');
      if (srcNode) { try { srcNode.disconnect(); } catch (e) {} }
      if (procNode) { try { procNode.disconnect(); } catch (e) {} }
      if (sinkNode) { try { sinkNode.disconnect(); } catch (e) {} }

      srcNode = audioCtx.createMediaStreamSource(micStream);
      procNode = audioCtx.createScriptProcessor(4096, 1, 1);
      procNode.onaudioprocess = (e) => {
        if (!capturing) return;
        pcmChunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      };
      /* ScriptProcessor only runs when connected to destination;
         route through a 0-gain node so the mic isn't played back. */
      sinkNode = audioCtx.createGain();
      sinkNode.gain.value = 0;
      srcNode.connect(procNode);
      procNode.connect(sinkNode);
      sinkNode.connect(audioCtx.destination);
    }


    /* Key: the context must be running on every recording.
       After the load-time pre-request, a phone call, or lock screen it may be
       suspended, and reusing a suspended context means onaudioprocess never
       fires (empty audio). */
    if (audioCtx.state !== 'running') {
      try { await audioCtx.resume(); } catch (e) { /* detected and reported below */ }
    }
    return audioCtx;
  }

  /* Simple linear downsampling — fine for speech and avoids uploading 48k raw data */
  function downsample(input, inRate, outRate) {
    if (inRate === outRate) return input;
    const ratio = inRate / outRate;
    const len = Math.max(1, Math.round(input.length / ratio));
    const out = new Float32Array(len);
    for (let i = 0; i < len; i += 1) {
      const start = Math.round(i * ratio);
      const end = Math.min(input.length, Math.round((i + 1) * ratio));
      let sum = 0;
      for (let j = start; j < end; j += 1) sum += input[j];
      out[i] = sum / Math.max(1, end - start);
    }
    return out;
  }

  function encodeWav(samples, sampleRate) {
    const buf = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buf);
    const put = (offset, str) => {
      for (let i = 0; i < str.length; i += 1) view.setUint8(offset + i, str.charCodeAt(i));
    };
    put(0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    put(8, 'WAVE');
    put(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);                 // PCM
    view.setUint16(22, 1, true);                 // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    put(36, 'data');
    view.setUint32(40, samples.length * 2, true);
    let off = 44;
    for (let i = 0; i < samples.length; i += 1) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      off += 2;
    }
    return new Blob([buf], { type: 'audio/wav' });
  }

  async function startServer() {
    pcmChunks = [];
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      flashHud('Recording is not supported in this browser');
      return;
    }
    try {
      if (permPromise) await permPromise;     // reuse the in-flight request from load/press
      let ctx = await ensureCaptureChain();
      if (S.mode !== 'recording') return;   // finger released while waiting for permission

      /* The context may still be suspended (just after a call, lock screen,
         or created gesture-lessly on load). Rebuilding once inside the same
         gesture usually fixes it — no need to make the user press again. */
      if (!ctx || ctx.state !== 'running') {
        releaseMic();
        ctx = await ensureCaptureChain();
        if (S.mode !== 'recording') return;
      }
      if (!ctx || ctx.state !== 'running') {
        flashHud('Mic not ready — press and hold again');
        return;
      }
      capturing = true;
    } catch (err) {
      const name = (err && err.name) || '';
      let hint = 'Microphone unavailable';
      if (name === 'NotAllowedError') hint = 'Microphone denied — check permissions';
      else if (name === 'NotFoundError') hint = 'No microphone available';
      flashHud(hint);
    }
  }

  function finishServer(commit) {
    capturing = false;
    const chunks = pcmChunks;
    pcmChunks = [];

    if (!commit) {
      hideHud();
      lockField();
      if (navigator.vibrate) navigator.vibrate([8, 40, 8]);
      return;
    }
    if (!chunks.length || !audioCtx) {
      hideHud();
      lockField();
      /* On first use the permission dialog may not be answered yet — no
         audio then is normal. Distinguish "not yet granted" from
         "granted but capture failed". */
      const noMic = !micLive();
      releaseMic();                        // the chain may be dead — drop it and rebuild
      flashHud(noMic ? 'Allow microphone access, then hold to speak again' : 'No audio captured — try again');
      return;
    }

    const rate = audioCtx.sampleRate || 48000;
    let total = 0;
    for (let i = 0; i < chunks.length; i += 1) total += chunks[i].length;
    const merged = new Float32Array(total);
    let pos = 0;
    for (let i = 0; i < chunks.length; i += 1) {
      merged.set(chunks[i], pos);
      pos += chunks[i].length;
    }

    const seconds = total / rate;
    if (seconds < 0.2) {
      hideHud();
      lockField();
      flashHud('Too short — hold and speak a bit longer');
      return;
    }

    const pcm16k = downsample(merged, rate, TARGET_RATE);
    const blob = encodeWav(pcm16k, TARGET_RATE);

    setHudText('Transcribing…', true);
    if (hudHint) hudHint.textContent = 'Recognizing';
    scheduleMicRelease();

    /* Show elapsed time so a stalled network looks like "waiting", not "frozen" */
    const t0 = Date.now();
    const ticker = setInterval(() => {
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      setHudText('Transcribing ' + secs + 's…', true);
    }, 200);

    (async () => {
      try {
        const data = await window.__transcribe(blob);
        const text = (data.text || '').trim();
        clearInterval(ticker);
        hideHud();
        lockField();
        if (text) doSend(text, true);
        else flashHud("Didn't catch that — say it again");
      } catch (err) {
        clearInterval(ticker);
        hideHud();
        lockField();
        flashHud((err && err.message) ? err.message : 'Recognition failed');
      }
    })();
  }

  /* Flash a short message in the HUD, then auto-dismiss it */
  function flashHud(msg) {
    setHudText(msg, true);
    if (hud) {
      hud.classList.add('show');
      hud.setAttribute('aria-hidden', 'false');
    }
    clearTimeout(S.flashTimer);
    S.flashTimer = setTimeout(() => hideHud(), 1700);
  }


  /* ── Stop recording ────────────────────────────────── */
  function endVoice(commit) {
    if (S.mode !== 'recording') return;
    S.mode = 'idle';

    bar.classList.remove('recording');

    /* Audio gets uploaded, so keep the HUD until transcription returns */
    if (S.asrMode !== 'off') {
      finishServer(commit);
      return;
    }

    /* Browser can't record: only show a hint, never send a fake message */
    hideHud();
    lockField();
    flashHud('Recording is not supported here — please type instead');
  }

  /* Capability probe: if the browser can record (WebAudio + getUserMedia +
     secure context) use server ASR; otherwise voice is off and only typing
     remains. No permission request here — requestMic handles that on load. */
  function probeASR() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (window.isSecureContext && AC && AC.prototype.createScriptProcessor
        && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      S.asrMode = 'server';
    } else {
      S.asrMode = 'off';
    }
  }

  /* ══════════ Gestures: handled in one place, no branching ══════════
     All touches land on the veil (the textarea is pointer-events:none when
     idle, so the system can't reach it), so there is no event race. */

  /* All transient flags live here so no reset gets forgotten */
  let suppressTap = false;

  function onStart(e) {
    /* Ignore new gestures while recording; in every other state (including
       leftover typing/pressing) force a reset, or a stale mode/startAt makes
       the held calculation wrong and tap detection fail. */
    if (S.mode === 'recording') return;

    /* Order matters: dismiss the keyboard first (the blur listener sets mode
       to idle), then set pressing — otherwise blur overwrites it. */
    if (document.activeElement === field) {
      try { field.blur(); } catch (err) {}
    }

    const t = e.touches ? e.touches[0] : e;
    S.startX = t.clientX;
    S.startY = t.clientY;
    S.startAt = Date.now();
    S.moved = false;
    S.mode = 'pressing';

    /* The mic must be requested here, still inside the gesture — not in holdTimer */
    primeMic();

    clearTimeout(S.holdTimer);
    S.holdTimer = setTimeout(() => {
      if (S.mode === 'pressing' && !S.moved) beginVoice();
    }, S.holdDelay);
  }

  function onMove(e) {
    if (S.mode === 'idle') return;
    const t = e.touches ? e.touches[0] : e;
    const dy = S.startY - t.clientY;
    const dx = Math.abs(t.clientX - S.startX);
    if (Math.abs(dy) > 10 || dx > 10) S.moved = true;

    if (S.mode === 'recording') {
      const armed = dy > S.cancelPx;
      if (armed !== S.cancelArmed) {
        S.cancelArmed = armed;
        if (hud) hud.classList.toggle('cancel', armed);
        if (hudHint) hudHint.textContent = armed ? 'Release to cancel' : defaultHint();
        if (armed && navigator.vibrate) navigator.vibrate(6);
      }
    } else if (S.moved) {
      /* Any movement cancels the long-press timer. On a clear vertical
         upward swipe (drawer gesture) abandon this gesture entirely, so
         recording doesn't start after 180ms and clash with "swipe up for panel". */
      clearTimeout(S.holdTimer);
      if (S.mode === 'pressing' && dy > 16 && dy > dx * 1.2) {
        S.mode = 'idle';
        suppressTap = true;
      }
    }
  }

  /* Called externally (drawer pull-up gesture): this touch is consumed —
     don't treat it as a tap/long-press for voice.
     Note: suppressTap must be declared before onMove/onEnd or it hits the TDZ. */
  window.__suppressNextTap = () => {
    suppressTap = true;
    clearTimeout(S.holdTimer);
    if (S.mode === 'pressing') S.mode = 'idle';
    setTimeout(() => { suppressTap = false; }, 60);
  };

  function onEnd(e) {
    clearTimeout(S.holdTimer);
    const held = Date.now() - S.startAt;
    const wasRecording = S.mode === 'recording';
    const moved = S.moved;
    S.moved = false;

    if (wasRecording) {
      endVoice(!S.cancelArmed);
      return;
    }

    S.mode = 'idle';

    /* Touch consumed by the drawer swipe: neither record nor show keyboard */
    if (suppressTap) return;

    /* Only a short press with no movement shows the keyboard; held > tapMaxMs is never a tap. */
    if (!moved && held < S.tapMaxMs) {
      focusField();
      S.mode = 'typing';
    }
  }

  /* Register: touch first (iOS), pointer as the desktop fallback */
  let usedTouch = false;
  veil.addEventListener('touchstart', (e) => {
    usedTouch = true;
    e.preventDefault();
    onStart(e);
  }, { passive: false });
  veil.addEventListener('touchmove', (e) => {
    e.preventDefault();
    onMove(e);
  }, { passive: false });
  veil.addEventListener('touchend', (e) => {
    e.preventDefault();          // stop the system from emitting a click / showing the keyboard on touchend
    onEnd(e);
  }, { passive: false });
  veil.addEventListener('touchcancel', () => {
    clearTimeout(S.holdTimer);
    if (S.mode === 'recording') endVoice(false);
    S.mode = 'idle';
    S.moved = false;
  }, { passive: false });

  bar.addEventListener('pointerdown', (e) => {
    if (usedTouch || e.pointerType !== 'mouse') return;
    if (e.button !== 0) return;
    onStart(e);
  });
  bar.addEventListener('pointermove', (e) => {
    if (usedTouch || e.pointerType !== 'mouse') return;
    onMove(e);
  });
  bar.addEventListener('pointerup', (e) => {
    if (usedTouch || e.pointerType !== 'mouse') return;
    onEnd(e);
  });

  /* Input state: unlock on focus, lock again on blur when empty */
  field.addEventListener('focus', () => {
    S.mode = 'typing';
    bar.classList.add('focused');
    unlockField();
  });
  field.addEventListener('blur', () => {
    bar.classList.remove('focused');
    if (S.mode === 'typing') S.mode = 'idle';
    if (!field.value) lockField();
  });

  /* Send button: fires directly, bypassing the veil */
  if (sendBtn) {
    sendBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      submit();
    });
  }

  function submit() {
    const v = field.value;
    if (!v.trim()) return;
    field.value = '';
    field.style.height = 'auto';
    bar.classList.remove('has-text');
    sendBtn.disabled = true;
    try { field.blur(); } catch (e) {}
    lockField();
    doSend(v, false);
  }

  field.addEventListener('input', () => {
    field.style.height = 'auto';
    field.style.height = Math.min(field.scrollHeight, 110) + 'px';
    const has = field.value.trim().length > 0;
    bar.classList.toggle('has-text', has);
    sendBtn.disabled = !has;
  });

  field.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });

  /* ── Move the composer up with the keyboard ──────────
     iOS Safari pitfall: the keyboard overlays the page, so neither
     window.innerHeight nor 100dvh changes — pure CSS can't follow it.
     The only reliable source is visualViewport.height / offsetTop.
     So write the real visible height to the --app-h CSS variable and size
     the layout with var(--app-h); the composer then sits on the keyboard's top edge. */
  const appEl = document.querySelector('.app');
  const vv = window.visualViewport;
  let baseHeight = 0;

  function syncViewport() {
    if (!appEl) return;
    /* Record the keyboard-less baseline height once, to detect a real keyboard */
    if (!baseHeight) baseHeight = window.innerHeight;

    /* Publish the composer's real height for the drawer so the card slides out
       flush with the input's top edge. Write only when the height actually
       changes, or any layout jitter would make the open card jump. */
    const composer = document.getElementById('composer');
    if (composer) {
      const h = Math.round(composer.getBoundingClientRect().height) || 84;
      const prev = parseFloat(document.documentElement.style.getPropertyValue('--composer-h')) || 0;
      if (Math.abs(h - prev) >= 1) {
        document.documentElement.style.setProperty('--composer-h', h + 'px');
      }
    }

    if (!vv) {
      appEl.style.setProperty('--app-h', window.innerHeight + 'px');
      return;
    }

    /* visualViewport.height is the real visible height, keyboard excluded */
    const h = Math.round(vv.height);

    /* Keyboard detection: focus is primary, height delta secondary. Using the
       delta alone misfires on Safari address-bar collapse or simulator viewport
       differences, locking the height to visualViewport.height and leaving a
       differently colored strip at the bottom. */
    const focused = document.activeElement === field;
    const shrunk = (baseHeight - h) > 120;
    const kbOpen = focused && shrunk;

    /* Key: with no keyboard do NOT lock the height to visualViewport.height.
       It changes as the Safari address bar shrinks/expands, and locking it
       leaves a strip at the bottom in a different color (iOS paints its own
       toolbar there). With no keyboard hand sizing back to CSS 100dvh so content
       reaches the physical screen edge. Use visualViewport only when the
       keyboard is open, or the composer would be hidden behind it. */
    if (!kbOpen) {
      appEl.style.removeProperty('--app-h');
    } else {
      appEl.style.setProperty('--app-h', h + 'px');
    }
    appEl.classList.toggle('kb-open', kbOpen);

    /* iOS scrolls the page up when the keyboard opens (offsetTop > 0); cancel it
       so the layout stays pinned to the top of the visual viewport */
    if (kbOpen && vv.offsetTop > 0) {
      window.scrollTo(0, 0);
    }
  }

  if (vv) {
    vv.addEventListener('resize', syncViewport);
    vv.addEventListener('scroll', syncViewport);
  }
  window.addEventListener('orientationchange', () => {
    baseHeight = 0;
    setTimeout(syncViewport, 260);
  });
  window.addEventListener('resize', () => {
    /* Recompute the baseline on desktop resize or rotation */
    if (!vv || !appEl.classList.contains('kb-open')) baseHeight = window.innerHeight;
    syncViewport();
  });

  /* Initial calibration plus delayed re-checks:
     on iOS, visualViewport.height right after load can still be a stale,
     unsettled value. Writing it to --app-h then pins the page at a shorter
     height forever, leaving a differently colored strip at the bottom. */
  syncViewport();
  [60, 200, 500, 1200].forEach((ms) => setTimeout(syncViewport, ms));
  window.addEventListener('load', () => setTimeout(syncViewport, 120));

  /* After the field is focused, re-sync once the keyboard animation ends and
     scroll the composer into view if needed. */
  field.addEventListener('focus', () => {
    [80, 250, 500].forEach((ms) => setTimeout(() => {
      syncViewport();
      /* Make sure the composer is in the visual viewport (not behind the keyboard) */
      const r = bar.getBoundingClientRect();
      if (vv && r.bottom > vv.height) {
        const delta = r.bottom - vv.height + 12;
        const feed = document.getElementById('feed');
        if (feed) feed.scrollTop += delta;
      }
    }, ms));
  });

  /* Initial lock: S.locked starts as true but the style was never written,
     so set locked false first, then call — ensuring pointer-events really hits the DOM. */
  S.locked = false;
  lockField();
  probeASR();

  /* Exposed externally (send is provided by app.js) */
  window.__composer = { S, focusField, lockField, unlockField, submit, syncViewport };
})();
