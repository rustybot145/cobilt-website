(() => {
  document.documentElement.classList.add('js');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  /* Nav background after scrolling */
  const nav = document.querySelector('.nav');
  const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 12);
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  /* Film: alone, then the crew. A clock that only runs while it's on screen. */
  const film = document.querySelector('[data-film]');
  if (film) {
    const scenes = [...film.querySelectorAll('.scene')];
    // Short scenes so there's no dead air: bubbles land early, the camera never stops moving
    const lengths = [4400, 5200];
    const total = lengths.reduce((a, b) => a + b, 0);
    let current = -1;
    let elapsed = 0;
    let last = null;
    let visible = false;

    const show = (i) => {
      current = i;
      scenes.forEach((s, j) => {
        s.classList.toggle('is-on', j === i);
        // Restart the scene's CSS animations from the top
        if (j === i) s.querySelectorAll('.scene-move, .say, .delivered').forEach((el) => {
          el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
        });
      });
    };

    if (reduced) {
      show(1);
    } else {
      show(0);
      film.classList.add('paused');
      new IntersectionObserver(([e]) => {
        visible = e.isIntersecting;
        film.classList.toggle('paused', !visible);
        last = null;
      }, { threshold: 0.3 }).observe(film);

      setInterval(() => {
        const now = performance.now();
        if (visible && !document.hidden) {
          if (last != null) elapsed = (elapsed + (now - last)) % total;
          last = now;
          const i = elapsed < lengths[0] ? 0 : 1;
          if (i !== current) show(i);
        } else {
          last = null;
        }
      }, 50);
    }
  }

  /* Reveal-once observer for the week ticks and the Bolt chat */
  function once(el, fn, threshold = 0.35) {
    if (!el) return;
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) { io.disconnect(); fn(); }
    }, { threshold });
    io.observe(el);
  }

  once(document.querySelector('.week'), () => document.querySelector('.week').classList.add('seen'), 0.25);
  document.querySelectorAll('[data-reveal]').forEach((el) => once(el, () => el.classList.add('in'), 0.2));
  once(document.querySelector('[data-path]'), () => document.querySelector('[data-path]').classList.add('go'), 0.4);
  once(document.querySelector('.cta'), () => document.querySelector('.cta').classList.add('struck'), 0.4);

  const chat = document.querySelector('[data-chat]');
  const typed = chat.querySelector('[data-typed]');
  const fullText = typed.textContent;
  if (!reduced) typed.textContent = '';
  once(chat, async () => {
    if (!reduced) {
      await wait(300);
      for (const ch of fullText) {
        typed.textContent += ch;
        await wait(ch === ' ' ? 45 : 28 + Math.random() * 40);
      }
      await wait(500);
    }
    chat.classList.add('typed', 'answered');
  });

  /* Waitlist quiz: email, name, country → 6-digit email code → "You're in" page */
  const dialog = document.getElementById('join-dialog');
  const joinButtons = [...document.querySelectorAll('[data-join]')];
  const card = dialog.querySelector('.join-card');
  const steps = [...dialog.querySelectorAll('.step')];
  const dots = [...dialog.querySelectorAll('.join-steps i')];
  const back = dialog.querySelector('[data-back]');
  const next = dialog.querySelector('.join-next');
  const msg = dialog.querySelector('.join-msg');
  const codeInput = dialog.querySelector('#join-code');
  const resendBtn = dialog.querySelector('[data-resend]');
  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  const STORE = 'cobilt-waitlist';
  const QUESTIONS = 3; // email, name, country
  const CODE = 3;
  const RESEND_SECONDS = 60;
  let step = 0;
  let joined = null;
  let signup = null; // { email, name, location } waiting for its code
  let resendTimer = null;

  const checks = [
    (v) => EMAIL.test(v) || 'Enter an email like name@domain.com.',
    (v) => v.length >= 2 || 'Enter your name.',
    (v) => v.length >= 2 || 'Choose your country.',
    (v) => /^\d{6}$/.test(v) || 'Enter the 6-digit code.',
  ];

  const LABELS = { [QUESTIONS - 1]: 'Join the waitlist', [CODE]: 'Confirm' };
  const BUSY = { [QUESTIONS - 1]: 'Sending code…', [CODE]: 'Checking…' };

  function markJoined() {
    joinButtons.forEach((b) => {
      b.classList.add('is-joined');
      b.firstElementChild.textContent = 'Joined';
      b.setAttribute('aria-label', "Joined. You're on the waitlist");
    });
  }

  try {
    joined = JSON.parse(localStorage.getItem(STORE) || 'null');
    if (joined) markJoined();
  } catch {}

  function go(to, dir = 'fwd') {
    steps.forEach((s, i) => {
      s.hidden = i !== to;
      s.classList.remove('fwd', 'back');
    });
    if (step !== to) { void steps[to].offsetWidth; steps[to].classList.add(dir); }
    step = to;
    dots.forEach((d, i) => d.classList.toggle('on', i <= to));
    back.hidden = to === 0 || to >= CODE;
    next.firstElementChild.textContent = LABELS[to] || 'Continue';
    msg.textContent = '';
    const input = steps[to].querySelector('.step-input');
    if (input) setTimeout(() => input.focus({ preventScroll: true }), 60);
  }

  // Save who joined (for the Joined buttons and the "You're in" page), then go there.
  function rememberJoined(data) {
    joined = data;
    const value = JSON.stringify(joined);
    try { localStorage.setItem(STORE, value); } catch {
      try { sessionStorage.setItem(STORE, value); } catch {}
    }
    markJoined();
    location.assign('/joined');
  }

  function startResendTimer() {
    clearInterval(resendTimer);
    let left = RESEND_SECONDS;
    const tick = () => {
      resendBtn.disabled = left > 0;
      resendBtn.textContent = left > 0 ? `Resend code in ${left}s` : 'Resend code';
      if (left-- <= 0) clearInterval(resendTimer);
    };
    tick();
    resendTimer = setInterval(tick, 1000);
  }

  function open() {
    if (joined) return location.assign('/joined');
    if (signup) go(CODE); else go(0);
    if (!dialog.open) dialog.showModal();
  }

  function close() {
    if (!dialog.open || dialog.classList.contains('closing')) return;
    dialog.classList.add('closing');
    setTimeout(() => { dialog.classList.remove('closing'); dialog.close(); }, reduced ? 0 : 240);
  }

  async function post(url, body) {
    // Hosted preview has no server: accept any 6-digit code
    if (window.COBILT_PREVIEW) {
      return url.endsWith('/verify') ? { name: signup.name, email: signup.email, position: 1 } : { status: 'pending' };
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Something went wrong. Try again.');
    return data;
  }

  const errorText = (err) => err.message === 'Failed to fetch'
    ? "Couldn't reach the server. Check your connection and try again."
    : err.message;

  function showError(input, text) {
    msg.textContent = text;
    input.classList.remove('bad'); void input.offsetWidth; input.classList.add('bad');
    input.focus();
  }

  // Ask for a code. Returns true once we're waiting on one.
  async function requestCode() {
    const result = await post('/api/waitlist', signup);
    if (result.status === 'confirmed') {
      rememberJoined({ name: signup.name, email: signup.email, position: result.position });
      signup = null;
      return false;
    }
    startResendTimer();
    return true;
  }

  async function busy(task) {
    next.setAttribute('aria-busy', 'true');
    next.firstElementChild.textContent = BUSY[step] || 'One sec…';
    const at = step;
    try { await task(); } catch (err) {
      showError(steps[step].querySelector('.step-input') || next, errorText(err));
    } finally {
      next.removeAttribute('aria-busy');
      if (step === at) next.firstElementChild.textContent = LABELS[step] || 'Continue';
    }
  }

  joinButtons.forEach((b) => b.addEventListener('click', open));
  dialog.querySelector('[data-close]').addEventListener('click', close);
  back.addEventListener('click', () => go(step - 1, 'back'));
  dialog.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  dialog.addEventListener('click', (e) => { if (e.target === dialog) close(); });
  dialog.querySelectorAll('.step-input').forEach((el) => el.addEventListener('input', () => {
    el.classList.remove('bad'); msg.textContent = '';
  }));

  dialog.querySelector('[data-restart]').addEventListener('click', () => {
    signup = null;
    codeInput.value = '';
    go(0, 'back');
  });

  resendBtn.addEventListener('click', () => busy(async () => {
    codeInput.value = '';
    if (await requestCode()) { msg.textContent = 'New code sent.'; codeInput.focus(); }
  }));

  // Digits only; submit as soon as all 6 are in (typed, pasted or autofilled)
  codeInput.addEventListener('input', () => {
    codeInput.value = codeInput.value.replace(/\D/g, '').slice(0, 6);
    if (codeInput.value.length === 6 && !next.hasAttribute('aria-busy')) card.requestSubmit();
  });

  // Country list, with the visitor's own country picked when the browser knows it
  const countrySelect = dialog.querySelector('#join-where');
  fetch('/countries.json').then((r) => r.json()).then((countries) => {
    let region = '';
    try { region = new Intl.Locale(navigator.language).maximize().region || ''; } catch {}
    countrySelect.append(...countries.map(([code, name]) => new Option(name, name, false, code === region)));
  }).catch(() => {});

  card.addEventListener('submit', (e) => {
    e.preventDefault();
    if (next.hasAttribute('aria-busy')) return;

    const input = steps[step].querySelector('.step-input');
    const ok = checks[step](input.value.trim());
    if (ok !== true) return showError(input, ok);

    if (step < QUESTIONS - 1) return go(step + 1);

    if (step === QUESTIONS - 1) {
      signup = {
        email: card.email.value.trim(),
        name: card.name.value.trim(),
        location: card.location.value,
      };
      return busy(async () => {
        if (await requestCode()) {
          dialog.querySelector('[data-check-email]').textContent = signup.email;
          codeInput.value = '';
          go(CODE);
        }
      });
    }

    // step === CODE
    busy(async () => {
      const data = await post('/api/waitlist/verify', { email: signup.email, code: codeInput.value });
      signup = null;
      clearInterval(resendTimer);
      rememberJoined(data);
    }).then(() => { if (step === CODE) codeInput.select(); });
  });
})();
