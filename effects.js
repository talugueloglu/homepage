(() => {
  'use strict';
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const main = document.querySelector('main');
  const bases = ['A', 'C', 'G', 'T'];
  const colors = ['#bc604d', '#3e8f9e', '#b28b26', '#8267b2'];
  const activeFlips = new Set();

  // Inline spans retain the original font, spacing and word wrapping.
  // Each letter keeps its real text for copying and assistive technology.
  function decorate() {
  for (const paragraph of main.querySelectorAll('p, li, h1, h2')) {
    if (paragraph.closest('[hidden]')) continue;
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) {
      if (!walker.currentNode.parentElement.closest('.dna-letter')) nodes.push(walker.currentNode);
    }
    for (const node of nodes) {
      const fragment = document.createDocumentFragment();
      for (const character of node.textContent) {
        if (!/\p{L}/u.test(character)) {
          fragment.append(character);
          continue;
        }
        const letter = document.createElement('span');
        letter.className = 'dna-letter';
        const original = document.createElement('span');
        original.className = 'letter-original';
        original.textContent = character;
        letter.append(original);
        fragment.append(letter);
      }
      node.replaceWith(fragment);
    }
  }
  }
  decorate();
  document.addEventListener('site:before-navigate', () => {
    for (const restore of [...activeFlips]) restore();
  });
  document.addEventListener('site:content-changed', () => {
    lastX = lastY = -1;
    decorate();
  });

  let lastX = -1, lastY = -1;
  main.addEventListener('pointermove', event => {
    // Layout changes must not trigger additional letters under a still cursor.
    if (event.clientX === lastX && event.clientY === lastY) return;
    lastX = event.clientX; lastY = event.clientY;
    if (event.pointerType === 'touch' || reducedMotion.matches || getSelection()?.toString()) return;
    const letter = event.target.closest('.dna-letter');
    if (!letter || letter.classList.contains('is-flipping')) return;

    const index = Math.floor(Math.random() * bases.length);
    const replacement = document.createElement('span');
    replacement.className = 'dna-replacement';
    replacement.setAttribute('aria-hidden', 'true');
    const turn = document.createElement('span');
    turn.className = 'dna-turn';
    const originalText = letter.querySelector('.letter-original').textContent;
    turn.textContent = originalText;
    replacement.append(turn);
    letter.append(replacement);
    letter.classList.add('is-flipping');

    // Exactly one visual glyph exists. Swap its text only while it is edge-on.
    // Cleanup is idempotent and has no timer that could affect a later flip.
    let animation;
    let restored = false;
    const restore = () => {
      if (restored) return;
      restored = true;
      animation?.cancel();
      replacement.remove();
      letter.classList.remove('is-flipping');
      activeFlips.delete(restore);
    };
    activeFlips.add(restore);
    const play = async (frames, duration) => {
      if (restored) throw new Error('Flip cancelled');
      const previous = animation;
      animation = turn.animate(frames, {
        duration, easing: 'cubic-bezier(.45,0,.55,1)', fill: 'forwards'
      });
      previous?.cancel();
      await animation.finished;
    };
    (async () => {
      try {
        await play([{transform:'rotateX(0deg)'},{transform:'rotateX(90deg)'}], 180);
        turn.textContent = bases[index];
        turn.style.color = colors[index];
        await play([
          {transform:'rotateX(-90deg)',offset:0},
          {transform:'rotateX(0deg)',offset:.45},
          {transform:'rotateX(0deg)',offset:1}
        ], 540);
        await play([{transform:'rotateX(0deg)'},{transform:'rotateX(90deg)'}], 180);
        turn.textContent = originalText;
        turn.style.color = '';
        await play([{transform:'rotateX(-90deg)'},{transform:'rotateX(0deg)'}], 180);
      } catch (error) {
        if (!restored) console.error('Letter flip failed', error);
      } finally {
        restore();
      }
    })();
  });
  reducedMotion.addEventListener('change', () => {
    if (reducedMotion.matches) for (const restore of [...activeFlips]) restore();
  });
})();
