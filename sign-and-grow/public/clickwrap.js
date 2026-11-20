/*
 * Sign&Grow click-to-agree, for a customer's own website. Paste:
 *   <script src="https://YOUR-SIGN-AND-GROW/clickwrap.js" data-agreement="SLUG" data-who="WHO" data-sig="SIG" async></script>
 * It puts the terms in a frame right after itself (or into the element whose id is in data-target), makes the frame
 * as tall as the terms, and fires the event "signgrow:accepted" on the frame (it bubbles to document) when the
 * visitor has accepted, with { agreement, acceptance, version } in event.detail.
 *
 * Treat that event as a hint for your page. Before you rely on an acceptance, ask your own server, which asks ours:
 * GET /api/clickwraps/{id}/status?person_id=... with your API key. The page around the frame cannot tick the box or
 * press the button with its own code, and never gets the visitor's receipt.
 */
(function () {
  var me = document.currentScript;
  if (!me || !me.src) return;
  var origin = new URL(me.src).origin;
  var slug = me.getAttribute('data-agreement');
  if (!slug) {
    console.error('Sign&Grow click-to-agree: add data-agreement="..." to the script tag. It is the last part of the address of your terms page.');
    return;
  }
  var q = 'embed=1';
  var who = me.getAttribute('data-who');
  var sig = me.getAttribute('data-sig');
  // WHO and SIG are the placeholders of the snippet: left as they are, the visitor types their own name and address.
  if (who && sig && who !== 'WHO' && sig !== 'SIG') q += '&who=' + encodeURIComponent(who) + '&sig=' + encodeURIComponent(sig);
  var f = document.createElement('iframe');
  f.src = origin + '/agree/' + encodeURIComponent(slug) + '?' + q;
  f.title = me.getAttribute('data-title') || 'Terms to accept';
  f.style.cssText = 'width:100%;height:520px;border:0;display:block;max-width:100%';
  var target = me.getAttribute('data-target') ? document.getElementById(me.getAttribute('data-target')) : null;
  if (target) target.appendChild(f);
  else me.parentNode.insertBefore(f, me.nextSibling);
  window.addEventListener('message', function (e) {
    // Only our own frame, and only this one, is listened to.
    if (e.origin !== origin || e.source !== f.contentWindow || !e.data || e.data.source !== 'signgrow-clickwrap') return;
    if (e.data.type === 'height') f.style.height = Math.max(240, Math.min(6000, Number(e.data.height) || 520)) + 'px';
    if (e.data.type === 'accepted')
      f.dispatchEvent(new CustomEvent('signgrow:accepted', { bubbles: true, detail: { agreement: slug, acceptance: String(e.data.acceptance || ''), version: Number(e.data.version) || null } }));
  });
})();
