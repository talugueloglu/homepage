(() => {
  'use strict';
  if (!window.fetch || !window.history?.pushState) return;
  const root = new URL('.', document.currentScript.src);
  const main = document.getElementById('text');
  const panel = main.querySelector('.panel');
  const headerLinks = document.querySelectorAll('.masthead a');
  const cache = new Map();
  let request = 0;
  let transition = null;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  async function fade(opacity, duration) {
    if (reducedMotion.matches || !panel.animate) return;
    const current = getComputedStyle(panel).opacity;
    transition?.cancel();
    const animation = panel.animate([{ opacity: current }, { opacity }], {
      duration, easing: 'cubic-bezier(.22,.61,.36,1)', fill: 'forwards'
    });
    transition = animation;
    await animation.finished.catch(() => {});
  }
  function revealCards() {
    if (reducedMotion.matches) return;
    panel.querySelectorAll('.post-list > li').forEach((card, i) => {
      if (!card.animate) return;
      card.animate([
        { opacity: 0, transform: 'translateY(18px)' },
        { opacity: 1, transform: getComputedStyle(card).transform }
      ], { duration: 650, delay: i * 85, easing: 'cubic-bezier(.16,1,.3,1)', fill: 'backwards' });
    });
  }
  history.scrollRestoration = 'manual';
  const key = value => {
    const url = new URL(value, location.href);
    url.hash = ''; url.search = '';
    url.pathname = url.pathname.replace(/\/index\.html$/, '/');
    return url.href;
  };
  const isPage = url => url.origin === root.origin && (
    key(url) === key(root) ||
    (url.pathname.startsWith(new URL('blogs/', root).pathname) &&
      (url.pathname.endsWith('/') || url.pathname.endsWith('.html')))
  );
  function snapshot(doc, url) {
    const content = doc.querySelector('#text .panel');
    if (!content || !doc.querySelector('.masthead')) throw new Error('Not a site page');
    const copy = content.cloneNode(true);
    for (const el of copy.querySelectorAll('[href], [src], [srcset]')) {
      for (const attribute of ['href', 'src']) {
        if (el.hasAttribute(attribute)) el.setAttribute(attribute, new URL(el.getAttribute(attribute), url).href);
      }
      if (el.hasAttribute('srcset')) {
        el.setAttribute('srcset', el.getAttribute('srcset').split(',').map(entry => {
          const [path, ...descriptor] = entry.trim().split(/\s+/);
          return [new URL(path, url).href, ...descriptor].join(' ');
        }).join(', '));
      }
    }
    return {
      html: copy.innerHTML,
      title: doc.title,
      description: doc.querySelector('meta[name="description"]')?.content || '',
      writing: doc.body.classList.contains('writing')
    };
  }
  // Persistent header links must stay valid after the address changes directories.
  for (const icon of document.querySelectorAll('link[rel~="icon"]')) icon.href = new URL(icon.getAttribute('href'), location.href).href;
  for (const link of headerLinks) link.href = new URL(link.getAttribute('href'), location.href).href;
  cache.set(key(location.href), Promise.resolve(snapshot(document, location.href)));
  history.replaceState({ ...history.state, scroll: [scrollX, scrollY] }, '', location.href);
  function load(url) {
    const id = key(url);
    if (!cache.has(id)) {
      const pending = fetch(url.href, { credentials: 'same-origin' }).then(async response => {
        if (!response.ok) throw new Error('Page unavailable');
        const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
        return snapshot(doc, response.url || url.href);
      }).catch(error => { cache.delete(id); throw error; });
      cache.set(id, pending);
    }
    return cache.get(id);
  }
  async function navigate(url, { pop = false, position = [0, 0] } = {}) {
    const token = ++request;
    main.setAttribute('aria-busy', 'true');
    try {
      const page = await load(url);
      if (token !== request) return;
      document.dispatchEvent(new CustomEvent('site:before-navigate'));
      await fade(0, 200);
      if (token !== request) return;
      if (!pop) {
        history.replaceState({ ...history.state, scroll: [scrollX, scrollY] }, '', location.href);
        history.pushState({ scroll: [0, 0] }, '', url.href);
      }
      panel.innerHTML = page.html;
      document.title = page.title;
      document.querySelector('meta[name="description"]')?.setAttribute('content', page.description);
      document.body.classList.toggle('writing', page.writing);
      for (const link of headerLinks) {
        link.removeAttribute('aria-current');
        if (link.closest('nav') && (link.classList.contains('writing-link') === page.writing)) {
          link.setAttribute('aria-current', page.writing && key(url) !== key(new URL('blogs/', root)) ? 'location' : 'page');
        }
      }
      window.scrollTo(...position);
      if (url.hash) document.getElementById(decodeURIComponent(url.hash.slice(1)))?.scrollIntoView();
      document.dispatchEvent(new CustomEvent('site:content-changed'));
      revealCards();
      await fade(1, 480);
      if (token !== request) return;
      transition?.cancel();
      transition = null;
      const heading = main.querySelector('h1');
      if (heading) {
        heading.setAttribute('tabindex', '-1');
        heading.focus({ preventScroll: true });
        heading.addEventListener('blur', () => heading.removeAttribute('tabindex'), { once: true });
      }
    } catch (error) {
      if (token === request) {
        transition?.cancel();
        transition = null;
        // The real HTML pages remain a fallback if a request fails.
        if (pop) location.reload(); else location.assign(url.href);
      }
    } finally {
      if (token === request) main.removeAttribute('aria-busy');
    }
  }
  document.addEventListener('click', event => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest('a[href]');
    if (!link || link.hasAttribute('download') || (link.target && link.target !== '_self')) return;
    const url = new URL(link.href, location.href);
    if (!isPage(url) || (url.hash && key(url) === key(location.href))) return;
    event.preventDefault();
    if (key(url) === key(location.href)) {
      ++request;
      transition?.cancel();
      transition = null;
      main.removeAttribute('aria-busy');
      return;
    }
    navigate(url);
  });
  window.addEventListener('popstate', event => navigate(new URL(location.href), { pop: true, position: event.state?.scroll || [0, 0] }));
  revealCards();
  for (const link of headerLinks) {
    const url = new URL(link.href);
    if (isPage(url) && key(url) !== key(location.href)) load(url).catch(() => {});
  }
})();
