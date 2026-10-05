// Injected into book frames only by the debug host with ARALE_TAURI_SMOKE=1.
void (async () => {
  const post = data => parent.postMessage({ tag: 'arale-epub-smoke', ...data }, '*');
  post({ type: 'loading', href: location.href });
  try {
    await document.fonts.ready;
    post({ type: 'loading', stage: 'fonts-ready', href: location.href });
    await Promise.all([...document.images].map(image => image.complete ? undefined : new Promise(resolve => {
      image.addEventListener('load', resolve, { once: true }); image.addEventListener('error', resolve, { once: true });
    })));
    post({ type: 'loading', stage: 'images-ready', href: location.href });
    let isolated = false;
    try { void parent.document.body; } catch { isolated = true; }
    let ipcDenied = !window.__TAURI_INTERNALS__?.invoke;
    if (!ipcDenied) ipcDenied = await Promise.race([
      window.__TAURI_INTERNALS__.invoke('arale_invoke', { channel: 'library:updateMeta', args: [location.pathname.split('/')[1], { title: 'EPUB IPC ESCAPE' }] }).then(() => false, () => true),
      new Promise(resolve => setTimeout(() => resolve(true), 1500)),
    ]);
    const word = document.querySelector('#smoke-word');
    post({ type: 'ready', href: location.href, isolated, ipcDenied,
      images: [...document.images].map(image => ({ loaded: image.naturalWidth > 0 })),
      fontLoaded: [...document.fonts].some(font => font.family === 'SmokeEpub' && font.status === 'loaded'),
      cssLoaded: word && getComputedStyle(word).backgroundColor === 'rgb(1, 2, 3)',
      injected: !!window.__epubInjected,
    });
    window.addEventListener('message', event => {
      if (event.source !== parent || event.data?.tag !== 'arale-epub-smoke') return;
      if (event.data.type === 'escape') { document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})); return; }
      if (event.data.type === 'scroll') { window.scrollBy(0, 80); window.dispatchEvent(new Event('scroll')); return; }
      if (event.data.type === 'link') { document.querySelector('#smoke-link')?.click(); return; }
      if (!word?.firstChild) return;
      word.scrollIntoView();
      const range = document.createRange(); range.setStart(word.firstChild, 0); range.setEnd(word.firstChild, 1);
      if (event.data.type === 'selection') {
        const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      } else if (event.data.type === 'click') {
        const rect = range.getBoundingClientRect();
        word.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: rect.x + rect.width / 3, clientY: rect.y + rect.height / 2 }));
      }
    });
  } catch (error) { post({ type: 'error', error: String(error) }); }
})();
