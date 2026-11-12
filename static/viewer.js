/* Shared full-screen carousel viewer (comfy-gallery + LoRA showcase boards).
 *
 *   CarouselViewer.open({
 *     count: 30,                       // total items
 *     start: 4,                        // index to open
 *     get: i => ({ src, caption, href, details }),   // may return a Promise
 *     onChange: i => {}, onClose: i => {},
 *   })
 *
 * src: full-resolution image. caption: text under the image ("N / total" is added).
 * actions: optional [{ html, title, onClick }] extra buttons in the top bar for this image.
 * href: optional "Full" link. details: optional (el, isCurrent) => void|Promise that fills the info panel.
 * Zoom: mouse wheel zooms around the pointer; a click anywhere (or a tap in the middle half) of the image to zoom in at that point, drag to pan, tap again to zoom out.
 * Paging: arrows, ←/→ keys, tap the left or right quarter (touch only), or drag the image sideways; the strip
 * follows the finger, so two neighbouring images can be seen side by side mid-drag.
 * CarouselViewer.refresh(newCount) re-shows the current position after the caller deleted an item.
 * Closing: ✕, Esc, drag down. Wraps at both ends. "i" toggles the info panel.
 * The info panel's top edge can be dragged anywhere between a thin strip and the full screen.
 */
(function () {
  let root, viewport, track, slides, cap, pos, full, info, panel, sheet, opts, idx = 0, token = 0, busy = false;
  const SHEET_KEY = 'cv-sheet-h';      // panel height as a fraction of the viewer height
  const SHEET_MIN = 22;                // px: just the drag handle

  const wrap = n => ((n % opts.count) + opts.count) % opts.count;

  function build() {
    root = document.createElement('div');
    root.className = 'cv nodetails';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.tabIndex = -1;
    root.innerHTML = `
      <div class="cv-stage">
        <div class="cv-top">
          <button type="button" class="cv-btn cv-close" aria-label="Close">✕</button>
          <span class="cv-pos"></span>
          <span class="cv-actions"><span class="cv-extra"></span><button type="button" class="cv-btn cv-unzoom" aria-label="Reset zoom">⤢ Fit</button><a class="cv-btn cv-full" target="_blank" rel="noopener" title="Open original in a new tab" aria-label="Open original in a new tab"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5"/><path d="M12 10v2.5a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1H6"/></svg></a><button type="button" class="cv-btn cv-info" title="Show or hide details" aria-label="Show or hide details"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M10 2.5v11"/></svg></button></span>
        </div>
        <button type="button" class="cv-nav cv-prev" aria-label="Previous">‹</button>
        <div class="cv-viewport"><div class="cv-track">
          <div class="cv-slide"><img alt="" draggable="false"></div><div class="cv-slide"><img alt="" draggable="false"></div><div class="cv-slide"><img alt="" draggable="false"></div>
        </div></div>
        <p class="cv-cap"></p>
        <button type="button" class="cv-nav cv-next" aria-label="Next">›</button>
      </div>
      <aside class="cv-details"><div class="cv-handle" role="separator" aria-label="Drag to resize details"></div><div class="cv-body"></div></aside>`;
    document.body.appendChild(root);
    viewport = root.querySelector('.cv-viewport');
    track = root.querySelector('.cv-track');
    slides = [...root.querySelectorAll('.cv-slide img')];
    cap = root.querySelector('.cv-cap');
    pos = root.querySelector('.cv-pos');
    full = root.querySelector('.cv-full');
    info = root.querySelector('.cv-info');
    panel = root.querySelector('.cv-body');
    sheet = root.querySelector('.cv-details');

    root.querySelector('.cv-close').onclick = close;
    root.querySelector('.cv-prev').onclick = () => go(-1);
    root.querySelector('.cv-next').onclick = () => go(1);
    info.onclick = toggleInfo;
    root.querySelector('.cv-unzoom').onclick = () => unzoom(true);

    document.addEventListener('keydown', e => {
      if (!root.classList.contains('open')) return;
      if (e.key === 'ArrowRight') go(1);
      else if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === 'Escape') close();
      else if (e.key === 'i' && !info.hidden) toggleInfo();
    });

    dragImages();
    root.querySelector('.cv-stage').addEventListener('wheel', wheelZoom, { passive: false });
    dragSheet();
    window.addEventListener('resize', () => applySheet(sheetFrac()));
  }

  // ---------- image strip: prev | current | next, moved by the finger ----------
  function setTrack(px, animate) {
    track.style.transition = animate ? 'transform .28s cubic-bezier(.2,.7,.3,1)' : 'none';
    track.style.transform = `translate3d(calc(-33.3333% + ${px}px), 0, 0)`;
  }

  function setDown(px, animate) {
    viewport.style.transition = animate ? 'transform .25s ease, opacity .25s ease' : 'none';
    viewport.style.transform = px ? `translate3d(0, ${px}px, 0)` : '';
    viewport.style.opacity = px ? Math.max(0.3, 1 - px / 600) : '';
  }

  // Slide the strip one image over, then make the new image the middle one.
  function go(d) {
    if (busy || !opts) return;
    busy = true;
    setTrack(-d * viewport.clientWidth, true);
    setTimeout(() => { busy = false; show(idx + d); }, 280);
  }

  // ---------- click-to-zoom on the current image ----------
  const zoom = { on: false, s: 1, x: 0, y: 0 };
  function setZoom(animate) {
    const img = slides[1];
    img.style.transition = animate ? 'transform .22s ease' : 'none';
    img.style.transform = zoom.on ? `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.s})` : '';
    root.classList.toggle('zoomed', zoom.on);
  }
  function zoomAt(cx, cy) {
    const img = slides[1], r = img.getBoundingClientRect();
    // the picture's shown width inside the contain-fit box, so "full size" means 1 image pixel per screen pixel
    const shown = Math.min(r.width, r.height * img.naturalWidth / Math.max(1, img.naturalHeight));
    zoom.s = Math.max(2.5, img.naturalWidth / Math.max(1, shown));
    const px = cx - (r.left + r.width / 2), py = cy - (r.top + r.height / 2);
    zoom.x = -px * (zoom.s - 1); zoom.y = -py * (zoom.s - 1);   // keep the clicked point under the pointer
    zoom.on = true;
    setZoom(true);
  }
  // wheel zoom: keep the point under the pointer still while the scale changes
  function wheelZoom(e) {
    if (e.target.closest('button, a')) return;
    e.preventDefault();
    const r = slides[1].parentNode.getBoundingClientRect();
    const px = e.clientX - (r.left + r.width / 2), py = e.clientY - (r.top + r.height / 2);
    const s0 = zoom.on ? zoom.s : 1, s1 = Math.min(12, Math.max(1, s0 * Math.exp(-e.deltaY * 0.0015)));
    if (s1 <= 1.01) return unzoom(false);
    const ux = (px - (zoom.on ? zoom.x : 0)) / s0, uy = (py - (zoom.on ? zoom.y : 0)) / s0;
    Object.assign(zoom, { on: true, s: s1, x: px - s1 * ux, y: py - s1 * uy });
    setZoom(false);
  }

  function unzoom(animate) { zoom.on = false; zoom.s = 1; zoom.x = zoom.y = 0; setZoom(animate); }

  function dragImages() {
    const stage = root.querySelector('.cv-stage');
    let id = null, x0, y0, t0, mode, dx, dy, zx, zy;
    stage.addEventListener('pointerdown', e => {
      if (e.target.closest('button, a') || busy) return;
      if (id !== null) { cancel(); return; }        // second finger: leave it to pinch zoom
      id = e.pointerId; x0 = e.clientX; y0 = e.clientY; t0 = performance.now(); mode = null; dx = dy = 0;
      zx = zoom.x; zy = zoom.y;
    });
    stage.addEventListener('pointermove', e => {
      if (e.pointerId !== id) return;
      dx = e.clientX - x0; dy = e.clientY - y0;
      if (!mode && Math.hypot(dx, dy) > 8) {
        mode = zoom.on ? 'pan' : Math.abs(dx) > Math.abs(dy) ? 'h' : (dy > 0 ? 'v' : 'none');
        if (mode !== 'none') stage.setPointerCapture(id);
      }
      if (mode === 'pan') { zoom.x = zx + dx; zoom.y = zy + dy; setZoom(false); }
      else if (mode === 'h') setTrack(dx, false);
      else if (mode === 'v') setDown(Math.max(0, dy), false);
    });
    const end = e => {
      if (e.pointerId !== id) return;
      id = null;
      const w = viewport.clientWidth, v = Math.abs(dx) / Math.max(1, performance.now() - t0);
      if (!mode) {                                   // a tap: quarters page, the middle zooms in or out
        const r = stage.getBoundingClientRect(), x = (e.clientX - r.left) / r.width;
        const touch = e.pointerType !== 'mouse';       // quarter paging is for phones; a mouse click always zooms
        if (zoom.on) unzoom(true);
        else if (touch && x < 0.25) go(-1); else if (touch && x > 0.75) go(1);
        else if (e.target === slides[1]) zoomAt(e.clientX, e.clientY);
      } else if (mode === 'pan') {
        // panning ends where it is
      } else if (mode === 'h') {
        if (Math.abs(dx) > w * 0.35 || (v > 0.5 && Math.abs(dx) > 30)) go(dx < 0 ? 1 : -1);
        else setTrack(0, true);
      } else if (mode === 'v') {
        if (dy > 120) close(); else setDown(0, true);
      }
    };
    stage.addEventListener('pointerup', end);
    stage.addEventListener('pointercancel', e => { if (e.pointerId === id) cancel(); });
    function cancel() { id = null; setTrack(0, true); setDown(0, true); }
  }

  // ---------- info panel height, dragged by its top edge ----------
  function sheetFrac() {
    let f = 0.15;
    try { f = parseFloat(localStorage.getItem(SHEET_KEY)) || 0.15; } catch (e) {}
    return f;
  }

  function applySheet(f) {
    const H = root.clientHeight || window.innerHeight;
    sheet.style.height = Math.round(Math.min(H, Math.max(SHEET_MIN, f * H))) + 'px';
  }

  function dragSheet() {
    const handle = root.querySelector('.cv-handle');
    let id = null, y0, h0, moved;
    handle.addEventListener('pointerdown', e => {
      id = e.pointerId; y0 = e.clientY; h0 = sheet.getBoundingClientRect().height; moved = false;
      handle.setPointerCapture(id);
      sheet.style.transition = 'none';
    });
    handle.addEventListener('pointermove', e => {
      if (e.pointerId !== id) return;
      const dy = e.clientY - y0;
      if (Math.abs(dy) > 3) moved = true;
      const H = root.clientHeight;
      sheet.style.height = Math.min(H, Math.max(SHEET_MIN, h0 - dy)) + 'px';
    });
    const end = e => {
      if (e.pointerId !== id) return;
      id = null;
      const H = root.clientHeight;
      let f = sheet.getBoundingClientRect().height / H;
      if (!moved) f = f < 0.25 ? 0.3 : 0.15;         // a tap still flips between short and twice as tall
      sheet.style.transition = moved ? '' : 'height .2s ease, transform .25s ease, margin-right .25s ease';
      applySheet(f);
      try { localStorage.setItem(SHEET_KEY, String(f)); } catch (e) {}
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  function toggleInfo() {
    root.classList.toggle('nodetails');
    try { localStorage.setItem('cv-info', root.classList.contains('nodetails') ? '0' : '1'); } catch (e) {}
  }

  async function show(n) {
    idx = wrap(n);
    const my = ++token, count = opts.count;
    pos.textContent = `${idx + 1} / ${count}`;
    const it = await opts.get(idx);
    if (my !== token) return;
    unzoom(false);
    slides[1].src = it.src;
    slides[1].alt = it.caption || '';
    setTrack(0, false);
    cap.textContent = it.caption ? `${it.caption}  ·  ${idx + 1} / ${count}` : '';
    cap.hidden = !it.caption;
    full.href = it.href || it.src;
    const extra = root.querySelector('.cv-extra');
    extra.innerHTML = '';
    for (const a of it.actions || []) {
      const b = Object.assign(document.createElement('button'), { type: 'button', className: 'cv-btn', title: a.title || '', innerHTML: a.html });
      b.setAttribute('aria-label', a.title || '');
      b.onclick = a.onClick;
      extra.appendChild(b);
    }
    info.hidden = !it.details;
    sheet.hidden = !it.details;
    root.classList.toggle('has-details', !!it.details);
    if (it.details) {
      panel.innerHTML = '<span class="cv-muted">Loading…</span>';
      Promise.resolve(it.details(panel, () => my === token)).catch(() => {});
    }
    opts.onChange?.(idx);
    // neighbours sit just off screen so a drag reveals them immediately
    [[0, -1], [2, 1]].forEach(([s, d]) => {
      slides[s].removeAttribute('src');
      if (count < 2) return;
      Promise.resolve(opts.get(wrap(idx + d))).then(p => { if (p && my === token) slides[s].src = p.src; });
    });
  }

  function open(o) {
    if (!root) build();
    opts = o;
    let wantInfo = '1';
    try { wantInfo = localStorage.getItem('cv-info') ?? '1'; } catch (e) {}
    root.classList.toggle('nodetails', wantInfo !== '1');
    root.classList.add('open');
    setDown(0, false);
    applySheet(sheetFrac());
    document.documentElement.style.overflow = 'hidden';
    root.focus();
    show(o.start || 0);
  }

  function close() {
    root.classList.remove('open');
    slides.forEach(s => s.removeAttribute('src'));
    document.documentElement.style.overflow = '';
    opts.onClose?.(idx);
  }

  // after the caller removes the current item: same position now holds the next one
  function refresh(count) {
    opts.count = count;
    if (!count) return close();
    show(Math.min(idx, count - 1));
  }

  window.CarouselViewer = { open, close, refresh };
})();
