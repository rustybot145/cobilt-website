// "You're in" page: fills in the person's name, spot and email from what the
// waitlist quiz saved in this browser, and handles the Share button.
(() => {
  let joined = null;
  for (const store of [() => localStorage, () => sessionStorage]) {
    try { joined = JSON.parse(store().getItem('cobilt-waitlist') || 'null'); } catch {}
    if (joined) break;
  }

  if (joined?.name) {
    const first = joined.name.split(/\s+/)[0];
    document.querySelector('[data-title]').textContent = `You're in, ${first}.`;
    document.title = `You're in, ${first} | Cobilt`;
  }
  if (joined?.position) {
    document.querySelector('[data-spot]').textContent = `You're #${joined.position} on the Cobilt waitlist.`;
  }
  if (joined?.email) {
    const p = document.querySelector('[data-perk-email]');
    p.textContent = 'Free at launch. Saved to ';
    const b = document.createElement('b');
    b.textContent = joined.email;
    p.append(b, '.');
  }

  // Share: the phone's share sheet when there is one, otherwise copy the link
  const shareBtn = document.querySelector('[data-share]');
  const msg = document.querySelector('.share-msg');
  const url = `${location.origin}/`;
  shareBtn.addEventListener('click', async () => {
    if (navigator.share) {
      try { await navigator.share({ title: 'Cobilt', text: "Don't build alone. Join the Cobilt waitlist.", url }); return; } catch (err) {
        if (err.name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      msg.textContent = 'Link copied.';
    } catch {
      msg.textContent = `Share this link: ${url}`;
    }
  });
})();
