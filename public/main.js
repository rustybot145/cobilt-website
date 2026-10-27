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

  /* Waitlist quiz: email, name, where you're from → check your email → joined */
  const dialog = document.getElementById('join-dialog');
  const joinButtons = [...document.querySelectorAll('[data-join]')];
  const card = dialog.querySelector('.join-card');
  const steps = [...dialog.querySelectorAll('.step')];
  const dots = [...dialog.querySelectorAll('.join-steps i')];
  const back = dialog.querySelector('[data-back]');
  const next = dialog.querySelector('.join-next');
  const msg = dialog.querySelector('.join-msg');
  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  const STORE = 'cobilt-waitlist';
  const QUESTIONS = 3;
  const CHECK = 3;
  const DONE = 4;
  let step = 0;
  let joined = null;

  const checks = [
    (v) => EMAIL.test(v) || 'Enter an email like name@domain.com.',
    (v) => v.length >= 2 || 'Enter your name.',
    (v) => v.length >= 2 || 'Enter your city or country.',
  ];

  const LABELS = { [QUESTIONS - 1]: 'Join the waitlist', [CHECK]: 'Got it', [DONE]: 'Done' };

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
    dialog.classList.toggle('done', to === DONE);
    dots.forEach((d, i) => d.classList.toggle('on', i <= to));
    back.hidden = to === 0 || to >= CHECK;
    next.firstElementChild.textContent = LABELS[to] || 'Continue';
    msg.textContent = '';
    const input = steps[to].querySelector('input');
    if (input) setTimeout(() => input.focus({ preventScroll: true }), 60);
  }

  function showDone({ name, email, position }) {
    const first = name.split(/\s+/)[0];
    dialog.querySelector('[data-done-title]').textContent = `Joined. Welcome, ${first}.`;
    dialog.querySelector('[data-done-body]').textContent = `You're #${position} on the list.`;
    dialog.querySelector('[data-done-email]').textContent = email;
    go(DONE);
  }

  function rememberJoined(data) {
    joined = data;
    try { localStorage.setItem(STORE, JSON.stringify(joined)); } catch {}
    markJoined();
    showDone(joined);
  }

  function open() {
    if (joined) showDone(joined); else go(0);
    if (!dialog.open) dialog.showModal();
  }

  function close() {
    if (!dialog.open || dialog.classList.contains('closing')) return;
    dialog.classList.add('closing');
    setTimeout(() => { dialog.classList.remove('closing'); dialog.close(); }, reduced ? 0 : 240);
  }

  joinButtons.forEach((b) => b.addEventListener('click', open));
  dialog.querySelector('[data-close]').addEventListener('click', close);
  dialog.querySelector('[data-restart]').addEventListener('click', () => go(0, 'back'));
  back.addEventListener('click', () => go(step - 1, 'back'));
  dialog.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  dialog.addEventListener('click', (e) => { if (e.target === dialog) close(); });
  dialog.querySelectorAll('.step-input').forEach((el) => el.addEventListener('input', () => {
    el.classList.remove('bad'); msg.textContent = '';
  }));

  async function post(url, body) {
    // Hosted preview has no server: act like the email went out
    if (window.COBILT_PREVIEW) return { status: 'pending' };
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

  card.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (step >= CHECK) return close();

    const input = steps[step].querySelector('input');
    const ok = checks[step](input.value.trim());
    if (ok !== true) {
      msg.textContent = ok;
      input.classList.remove('bad'); void input.offsetWidth; input.classList.add('bad');
      return input.focus();
    }
    if (step < QUESTIONS - 1) return go(step + 1);

    const body = {
      email: card.email.value.trim(),
      name: card.name.value.trim(),
      location: card.location.value.trim(),
    };
    next.setAttribute('aria-busy', 'true');
    next.firstElementChild.textContent = 'Joining…';
    try {
      const result = await post('/api/waitlist', body);
      if (result.status === 'confirmed') {
        rememberJoined({ name: body.name, email: body.email, position: result.position });
      } else {
        dialog.querySelector('[data-check-email]').textContent = body.email;
        go(CHECK);
      }
    } catch (err) {
      next.firstElementChild.textContent = LABELS[QUESTIONS - 1];
      msg.textContent = errorText(err);
    } finally {
      next.removeAttribute('aria-busy');
    }
  });

  // Arriving from the confirm link in the email: /?confirm=<token>
  const token = new URLSearchParams(location.search).get('confirm');
  if (token) {
    history.replaceState(null, '', location.pathname + location.hash);
    post('/api/waitlist/confirm', { token })
      .then((data) => { rememberJoined(data); open(); })
      .catch((err) => {
        open();
        go(0);
        msg.textContent = errorText(err);
      });
  }
})();
