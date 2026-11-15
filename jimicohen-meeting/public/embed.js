/*!
 * Meeting embed. No dependencies, no inline handlers, no injected <style>: safe under a strict CSP.
 *
 *   Inline calendar (resizes itself to its content). The link inside is what shows where this
 *   script cannot run; it is taken out when the calendar goes in:
 *     <div data-meeting-url="https://example.com/meeting/intro"><a href="https://example.com/meeting/intro" data-meeting-fallback>Book a meeting</a></div>
 *
 *   Popup (closes with Escape, the close button or a click outside):
 *     <a href="https://example.com/meeting/intro" data-meeting-popup="https://example.com/meeting/intro">Book a meeting</a>
 *
 *   Optional attributes on either element:
 *     data-meeting-name, data-meeting-email   fill in the form
 *     data-meeting-title                      accessible name of the frame (default "Book a meeting")
 *     data-meeting-height                     starting height of an inline frame in px (default 680)
 *
 *   Events (bubble from the element, detail = { bookingId, start, end }):
 *     meeting:booked, meeting:rescheduled, meeting:cancelled
 *
 *   From code:  MeetingEmbed.open(url), MeetingEmbed.close(), MeetingEmbed.init(root)
 */
(function () {
  'use strict';

  var w = window;
  var d = document;
  if (w.MeetingEmbed && w.MeetingEmbed.loaded) return;

  var MIN_HEIGHT = 240;
  var MAX_HEIGHT = 6000;
  var Z = '2147483000';
  /** every frame we created: { frame, origin, host, onHeight } */
  var frames = [];
  var popup = null;

  // ───────────── helpers ─────────────

  function css(el, styles) {
    // CSSOM assignments are not "inline styles" to a CSP, unlike a style="" attribute.
    for (var key in styles) if (Object.prototype.hasOwnProperty.call(styles, key)) el.style.setProperty(key, styles[key]);
    return el;
  }

  function reducedMotion() {
    return !!(w.matchMedia && w.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  /** Only http(s) pages may be framed: a javascript: or data: URL in an attribute is ignored. */
  function frameUrl(value, el) {
    var url;
    try {
      url = new URL(String(value || ''), w.location.href);
    } catch (e) {
      return null;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    url.searchParams.set('embed', '1');
    var name = el && el.getAttribute('data-meeting-name');
    var email = el && el.getAttribute('data-meeting-email');
    if (name && !url.searchParams.has('name')) url.searchParams.set('name', name.slice(0, 120));
    if (email && !url.searchParams.has('email')) url.searchParams.set('email', email.slice(0, 254));
    // Campaign tags on the page that shows the calendar belong to the booking too.
    try {
      new URLSearchParams(w.location.search).forEach(function (v, k) {
        if (/^utm_[a-z0-9_]{1,40}$/i.test(k) && v && !url.searchParams.has(k)) url.searchParams.set(k, v.slice(0, 200));
      });
    } catch (e) {
      /* old browser: skip */
    }
    return url;
  }

  function makeFrame(url, title) {
    var frame = d.createElement('iframe');
    frame.title = title || 'Book a meeting';
    frame.setAttribute('allow', 'clipboard-write');
    frame.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    css(frame, { display: 'block', width: '100%', border: '0', background: 'transparent', 'color-scheme': 'normal' });
    frame.src = url.href;
    return frame;
  }

  function register(frame, url, host, onHeight) {
    var entry = { frame: frame, origin: url.origin, host: host, onHeight: onHeight };
    frames.push(entry);
    return entry;
  }

  function unregister(frame) {
    frames = frames.filter(function (entry) {
      return entry.frame !== frame;
    });
  }

  function text(v) {
    return typeof v === 'string' ? v.slice(0, 200) : undefined;
  }

  function announce(host, type, data) {
    var detail = { bookingId: text(data.bookingId), start: text(data.start), end: text(data.end) };
    var event;
    try {
      event = new CustomEvent(type, { bubbles: true, detail: detail });
    } catch (e) {
      event = d.createEvent('CustomEvent');
      event.initCustomEvent(type, true, false, detail);
    }
    (host && host.isConnected !== false ? host : d).dispatchEvent(event);
  }

  // ───────────── messages from our frames ─────────────

  w.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || typeof data !== 'object' || data.source !== 'meeting' || typeof data.type !== 'string') return;
    for (var i = 0; i < frames.length; i++) {
      var entry = frames[i];
      // Both checks matter: the message must come from the window we created AND from the
      // origin we loaded into it. Anything else on the page cannot resize or fire events.
      if (event.source !== entry.frame.contentWindow || event.origin !== entry.origin) continue;
      if (data.type === 'meeting:height') {
        var h = Number(data.height);
        if (isFinite(h) && h > 0) entry.onHeight(Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.ceil(h))));
      } else if (data.type === 'meeting:booked' || data.type === 'meeting:rescheduled' || data.type === 'meeting:cancelled') {
        announce(entry.host, data.type, data);
      } else if (data.type === 'meeting:escape') {
        // Escape pressed while the focus is inside the frame: the key itself never reaches this page.
        if (popup && popup.frame === entry.frame) closePopup();
      }
      return;
    }
  });

  // ───────────── inline ─────────────

  function mountInline(el) {
    if (el.__meetingFrame) return;
    var url = frameUrl(el.getAttribute('data-meeting-url'), el);
    if (!url) return;
    var start = parseInt(el.getAttribute('data-meeting-height') || '', 10);
    var frame = makeFrame(url, el.getAttribute('data-meeting-title'));
    frame.setAttribute('loading', 'lazy');
    frame.setAttribute('scrolling', 'no');
    css(frame, { height: (start >= MIN_HEIGHT && start <= MAX_HEIGHT ? start : 680) + 'px', overflow: 'hidden' });
    if (!reducedMotion()) css(frame, { transition: 'height 160ms ease' });
    register(frame, url, el, function (height) {
      frame.style.setProperty('height', height + 'px');
    });
    el.__meetingFrame = frame;
    // The plain link for pages where this script cannot run: the calendar takes its place.
    var children = el.children;
    for (var i = children.length - 1; i >= 0; i--) if (children[i].hasAttribute('data-meeting-fallback')) el.removeChild(children[i]);
    el.appendChild(frame);
  }

  function scan(root) {
    var scope = root && root.querySelectorAll ? root : d;
    var list = scope.querySelectorAll('[data-meeting-url]');
    for (var i = 0; i < list.length; i++) mountInline(list[i]);
    if (scope !== d && scope.hasAttribute && scope.hasAttribute('data-meeting-url')) mountInline(scope);
  }

  // ───────────── popup ─────────────

  function closeIcon() {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = d.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '20');
    svg.setAttribute('height', '20');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('aria-hidden', 'true');
    var path = d.createElementNS(ns, 'path');
    path.setAttribute('d', 'M6 6l12 12M18 6L6 18');
    svg.appendChild(path);
    return svg;
  }

  function sentinel(onFocus) {
    var el = d.createElement('span');
    el.tabIndex = 0;
    el.setAttribute('aria-hidden', 'true');
    css(el, { position: 'fixed', width: '1px', height: '1px', opacity: '0', 'pointer-events': 'none' });
    el.addEventListener('focus', onFocus);
    return el;
  }

  function closePopup() {
    var p = popup;
    if (!p) return;
    popup = null;
    d.removeEventListener('keydown', p.onKeyDown, true);
    d.removeEventListener('focusin', p.onFocusIn, true);
    unregister(p.frame);
    d.documentElement.style.setProperty('overflow', p.prevOverflow);
    if (!p.prevOverflow) d.documentElement.style.removeProperty('overflow');
    var remove = function () {
      if (p.overlay.parentNode) p.overlay.parentNode.removeChild(p.overlay);
    };
    if (reducedMotion()) remove();
    else {
      p.overlay.style.setProperty('opacity', '0');
      w.setTimeout(remove, 180);
    }
    if (p.trigger && typeof p.trigger.focus === 'function') {
      try {
        p.trigger.focus({ preventScroll: true });
      } catch (e) {
        p.trigger.focus();
      }
    }
  }

  function openPopup(value, trigger) {
    var url = frameUrl(value, trigger);
    if (!url) return false;
    if (popup) closePopup();

    var small = w.innerWidth < 640;
    var title = (trigger && trigger.getAttribute && trigger.getAttribute('data-meeting-title')) || 'Book a meeting';

    var overlay = css(d.createElement('div'), {
      position: 'fixed',
      inset: '0',
      top: '0',
      left: '0',
      width: '100%',
      height: '100%',
      'z-index': Z,
      display: 'flex',
      'flex-direction': 'column',
      'box-sizing': 'border-box',
      padding: small ? '56px 8px 16px' : '56px 24px 32px',
      background: 'rgba(8, 14, 11, 0.66)',
      'overflow-y': 'auto',
      'overscroll-behavior': 'contain',
      '-webkit-overflow-scrolling': 'touch',
      opacity: reducedMotion() ? '1' : '0',
      transition: 'opacity 160ms ease',
    });

    var dialog = css(d.createElement('div'), {
      position: 'relative',
      width: '100%',
      'max-width': '1040px',
      margin: 'auto',
      outline: 'none',
    });
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', title);
    dialog.tabIndex = -1;

    var close = css(d.createElement('button'), {
      position: 'absolute',
      top: '-48px',
      right: '0',
      display: 'flex',
      'align-items': 'center',
      'justify-content': 'center',
      width: '44px',
      height: '44px',
      padding: '0',
      border: '0',
      'border-radius': '50%',
      background: 'rgba(255, 255, 255, 0.14)',
      color: '#ffffff',
      cursor: 'pointer',
      font: 'inherit',
    });
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.appendChild(closeIcon());

    var loading = css(d.createElement('p'), {
      margin: '0',
      padding: '96px 16px',
      color: 'rgba(255, 255, 255, 0.82)',
      font: '500 15px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
      'text-align': 'center',
    });
    loading.setAttribute('role', 'status');
    loading.textContent = 'Loading the calendar';

    var frame = makeFrame(url, title);
    css(frame, { height: '0', 'border-radius': '20px', overflow: 'hidden' });
    var shown = false;
    var show = function (height) {
      if (!shown) {
        shown = true;
        if (loading.parentNode) loading.parentNode.removeChild(loading);
      }
      frame.style.setProperty('height', height + 'px');
    };
    register(frame, url, trigger && trigger.nodeType === 1 ? trigger : d, show);
    // A page that never reports its height (wrong URL, blocked) still becomes visible.
    frame.addEventListener('load', function () {
      w.setTimeout(function () {
        if (!shown) show(Math.max(MIN_HEIGHT, Math.min(720, w.innerHeight - 120)));
      }, 1200);
    });

    // Focus stays inside: two invisible stops wrap Tab around, and anything that lands outside comes back.
    var first = sentinel(function () {
      frame.focus();
    });
    var last = sentinel(function () {
      close.focus();
    });

    var onKeyDown = function (event) {
      if (event.key === 'Escape' || event.key === 'Esc') {
        event.stopPropagation();
        event.preventDefault();
        closePopup();
      }
    };
    var onFocusIn = function (event) {
      if (popup && !overlay.contains(event.target)) close.focus();
    };

    close.addEventListener('click', closePopup);
    var pressedOutside = false;
    overlay.addEventListener('mousedown', function (event) {
      pressedOutside = event.target === overlay;
    });
    overlay.addEventListener('click', function (event) {
      if (pressedOutside && event.target === overlay) closePopup();
      pressedOutside = false;
    });

    dialog.appendChild(close);
    dialog.appendChild(loading);
    dialog.appendChild(frame);
    overlay.appendChild(first);
    overlay.appendChild(dialog);
    overlay.appendChild(last);

    popup = {
      overlay: overlay,
      frame: frame,
      trigger: trigger && typeof trigger.focus === 'function' ? trigger : d.activeElement,
      prevOverflow: d.documentElement.style.getPropertyValue('overflow'),
      onKeyDown: onKeyDown,
      onFocusIn: onFocusIn,
    };
    d.documentElement.style.setProperty('overflow', 'hidden');
    d.body.appendChild(overlay);
    d.addEventListener('keydown', onKeyDown, true);
    d.addEventListener('focusin', onFocusIn, true);
    close.focus();
    w.requestAnimationFrame(function () {
      overlay.style.setProperty('opacity', '1');
    });
    return true;
  }

  // One listener for every trigger, present or future.
  d.addEventListener('click', function (event) {
    if (event.defaultPrevented || event.button > 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    var node = event.target;
    while (node && node.nodeType === 1 && !node.hasAttribute('data-meeting-popup')) node = node.parentNode;
    if (!node || node.nodeType !== 1) return;
    var value = node.getAttribute('data-meeting-popup') || node.getAttribute('href');
    if (openPopup(value, node)) event.preventDefault();
  });

  // ───────────── start ─────────────

  function start() {
    scan(d);
    if (!w.MutationObserver) return;
    new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var added = records[i].addedNodes;
        for (var j = 0; j < added.length; j++) if (added[j].nodeType === 1) scan(added[j]);
      }
    }).observe(d.documentElement, { childList: true, subtree: true });
  }

  w.MeetingEmbed = {
    loaded: true,
    /** look for new [data-meeting-url] elements inside `root` (default: the whole page) */
    init: scan,
    /** open a booking page in the popup */
    open: function (url) {
      return openPopup(url, null);
    },
    close: closePopup,
  };

  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', start);
  else start();
})();
