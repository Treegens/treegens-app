'use client';
// The page a website's visitors accept click-to-agree terms on, at /agree/<slug>. With ?embed=1 it is the same page
// inside a frame on the website (public/clickwrap.js): narrower, and it tells the page around it how tall it is and
// when the visitor has accepted. The rules are in src/server/clickwrap.ts, the words in src/lib/clickwrap.ts.
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { api, fmtDate, Leaf } from '@/components/ui';
import { PdfDoc } from '@/components/PdfDoc';
import { ClickwrapTerms } from '@/components/ClickwrapTerms';

const tell = (msg: Record<string, any>) => {
  // Only to a page around this frame, and never anything secret: the receipt stays in this frame.
  if (window.parent !== window) window.parent.postMessage({ source: 'signgrow-clickwrap', ...msg }, '*');
};

export default function Agree() {
  const { slug } = useParams<{ slug: string }>();
  const [q, setQ] = useState<URLSearchParams | null>(null);
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState('');
  const [ticked, setTicked] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [who, setWho] = useState({ name: '', email: '' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [done, setDone] = useState<any>(null);
  const [mailed, setMailed] = useState('');
  const [report, setReport] = useState(false);
  // Whether the browser says the button can be seen: true, false, or null where it cannot tell.
  const [visible, setVisible] = useState<boolean | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const go = useRef<HTMLDivElement>(null);
  const embed = !!q?.get('embed');

  const load = (params: URLSearchParams) => {
    setError('');
    api(`/public/agree/${slug}?${params.toString()}`).then(setData).catch((e) => setError(e.message));
  };
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    setQ(p);
    setReport(p.get('report') === '1');
    load(p);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  // Inside a frame: the page around it learns how tall the terms are, so it can make the frame fit.
  useEffect(() => {
    if (!embed) return;
    // The page itself is measured, not the document: a document is never shorter than its frame, so a frame that
    // was made tall would never shrink again after the visitor accepted.
    const main = document.querySelector('main');
    if (!main) return;
    const ro = new ResizeObserver(() => tell({ type: 'height', height: Math.ceil(main.getBoundingClientRect().height) + 2 }));
    ro.observe(main);
    return () => ro.disconnect();
  }, [embed]);

  // Terms that must be read to the end: the button waits until the box has been scrolled to its end. Terms that fit
  // without scrolling count as read to the end.
  const checkEnd = () => {
    const el = box.current;
    if (el && el.scrollTop + el.clientHeight >= el.scrollHeight - 8) setScrolled(true);
  };
  useEffect(() => {
    const t = setTimeout(checkEnd, 400);
    return () => clearTimeout(t);
  }, [data]);

  // Where the browser can tell (Chrome and Edge), a button that something on the page around the frame covers, or
  // makes see-through, cannot be pressed. Elsewhere this cannot be known, and the record says so.
  useEffect(() => {
    // The box around the button is watched, not the button: a button that waits is drawn see-through, and the browser
    // would count that as covered. Only a reading taken while the whole box is on the screen counts.
    const el = go.current;
    if (!el || typeof IntersectionObserver === 'undefined' || !('isVisible' in (window as any).IntersectionObserverEntry.prototype)) return;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting && e.intersectionRatio > 0.99) setVisible(!!(e as any).isVisible);
    }, { trackVisibility: true, delay: 100, threshold: [0, 1] } as any);
    io.observe(el);
    return () => io.disconnect();
  }, [data, done]);

  async function accept(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg('');
    let page: string | null = null;
    try {
      page = embed ? (window.location as any).ancestorOrigins?.[0] || document.referrer || null : document.referrer || null;
    } catch {}
    try {
      const r = await api(`/public/agree/${slug}/accept`, {
        body: { view: data.view, agree: ticked, scrolled: data.version.scroll ? scrolled : undefined, embed, page_url: page, unobscured: visible,
          who: q?.get('who') || undefined, sig: q?.get('sig') || undefined, ...(data.identity === 'typed' ? who : {}) },
      });
      setDone(r);
      tell({ type: 'accepted', acceptance: r.acceptance.id, version: r.acceptance.version });
    } catch (err: any) {
      setMsg(err.message);
      // The terms changed while the page was open, or it stood open too long: show the current ones.
      if (err.code === 'terms_changed' || err.code === 'view_old') (setTicked(false), setScrolled(false), q && load(q));
    } finally {
      setBusy(false);
    }
  }

  async function mailCopy(receipt: string) {
    try {
      const r = await api('/public/agree/receipt/email', { body: { receipt } });
      setMailed(r.sent || r.status === 'outbox' ? `A copy is on its way to ${r.to}.` : `We could not hand the email to the mail server yet. It is tried again by itself, so it may arrive later at ${r.to}.`);
    } catch (err: any) {
      setMailed(err.message);
    }
  }

  const v = data?.version;
  const finished = done || data?.already;
  const covered = visible === false;
  const blocked = !ticked || (v?.scroll && !scrolled) || covered || busy;

  return (
    <main className={`cw-page${embed ? ' cw-embed' : ''}`}>
      {error ? (
        <div className="card" role="alert"><h1 className="cw-title">These terms cannot be shown</h1><p style={{ marginTop: 8 }}>{error}</p></div>
      ) : !data ? (
        <div className="muted center" role="status">Loading the terms…</div>
      ) : data.closed ? (
        <div className="card" role="status"><h1 className="cw-title">These terms cannot be accepted here right now</h1><p style={{ marginTop: 8 }}>{data.text}</p></div>
      ) : (
        <div className="card">
          <div className="cw-head">
            {data.account.logo ? <img src={data.account.logo} alt="" /> : <Leaf color="#1f6f43" size={22} />}
            <span className="muted small">{data.account.name}</span>
          </div>
          <h1 className="cw-title serif">{v.title}</h1>
          <div className="muted small">Version {v.number}, published {fmtDate(v.published_at)}</div>
          {data.earlier && (
            <div className="notice warn" style={{ marginTop: 12 }}>
              You accepted version {data.earlier.version} on {fmtDate(data.earlier.at)}. These terms have changed since, so you are asked to accept them again.
              {data.earlier.changes.filter((c: any) => c.note).map((c: any) => <div key={c.number} style={{ marginTop: 4 }}>What changed in version {c.number}: {c.note}</div>)}
            </div>
          )}
          {/* The terms, in a box a keyboard can scroll (Tab to it, then the arrow keys). */}
          <div ref={box} className={`cw-terms${v.format === 'pdf' ? ' cw-pdf' : ''}`} tabIndex={0} role="region" aria-label={`The terms: ${v.title}`} onScroll={checkEnd}>
            {v.format === 'pdf' ? <PdfDoc url={v.pdf} maxWidth={720} onPages={() => setTimeout(checkEnd, 300)} /> : <ClickwrapTerms text={v.text} />}
          </div>
          {finished ? (
            <div className="cw-done" role="status" aria-live="polite">
              <div className="notice">{done?.already === false ? 'Recorded.' : 'You have accepted these terms.'} {done ? `You accepted version ${done.acceptance.version} on ${fmtDate(done.acceptance.at, true)}.` : `You accepted version ${data.already.version} on ${fmtDate(data.already.at, true)}.`} The reference of the record is {done?.acceptance.id || data.already.id}.</div>
              <div className="cw-actions">
                <a className="btn" href={`/api/public/agree/receipt/${done?.receipt || data.already.receipt}/certificate`}>Download your copy (PDF)</a>
                {(done ? done.email : data.already.email) && <button className="btn" type="button" onClick={() => mailCopy(done?.receipt || data.already.receipt)}>Email me a copy</button>}
              </div>
              {mailed && <p className="small" style={{ marginTop: 8 }} role="status">{mailed}</p>}
              <p className="cw-why">The copy holds the terms and everything the record says. Keep it: only this browser has the link to it.</p>
            </div>
          ) : (
            <form onSubmit={accept} noValidate>
              {/* Said before the click: what is recorded, what the record will show and what it will not. */}
              <div className="cw-recorded">
                <p>{data.recorded}</p>
                <p>{data.shows} {data.not}</p>
                <p>{data.law}</p>
              </div>
              {data.identity === 'website' ? (
                <p className="cw-as">You accept as <b>{[data.person.name, data.person.email].filter(Boolean).join(', ') || data.person.id}</b>, as {data.account.name} knows you. If that is not you, do not accept: go back and tell them.</p>
              ) : (
                <div className="cw-grid" style={{ gap: 10 }}>
                  <label className="f"><span>Your full name</span><input dir="auto" value={who.name} onChange={(e) => setWho({ ...who, name: e.target.value })} required autoComplete="name" /></label>
                  <label className="f"><span>Your email <span className="hint">(for a copy, if you ask for one)</span></span><input type="email" value={who.email} onChange={(e) => setWho({ ...who, email: e.target.value })} required autoComplete="email" /></label>
                </div>
              )}
              <label className="cw-tick"><input type="checkbox" checked={ticked} onChange={(e) => setTicked(e.target.checked)} /> <span>{v.checkbox}</span></label>
              {msg && <div className="notice err" role="alert" style={{ marginBottom: 10 }}>{msg}</div>}
              <div ref={go}><button className="btn primary cw-go" type="submit" disabled={!!blocked} aria-describedby="cw-why">{busy ? 'Recording…' : v.button}</button></div>
              <p id="cw-why" className="cw-why" aria-live="polite">
                {covered ? 'Something on the page around these terms covers this button, so it cannot be pressed. Tell the website, or open the terms on their own page.'
                  : v.scroll && !scrolled ? 'Scroll to the end of the terms to accept them.' : !ticked ? `Tick "${v.checkbox}" to accept.` : ''}
              </p>
            </form>
          )}
        </div>
      )}
      <ReportPage slug={slug} open={report} setOpen={setReport} />
      {!embed && <p className="cw-foot">Powered by Sign&Grow, where every dollar plants mangrove trees. <a href="/help">Get help</a></p>}
    </main>
  );
}

// "Report this page", like "Report this email" in our signing emails. A person in the review queue reads it.
function ReportPage({ slug, open, setOpen }: { slug: string; open: boolean; setOpen: (b: boolean) => void }) {
  const [f, setF] = useState({ reason: 'phishing', detail: '', email: '' });
  const [sent, setSent] = useState('');
  if (!open) return <p className="cw-foot"><button type="button" className="cw-linkish" onClick={() => setOpen(true)}>Report this page</button> if it looks like a scam or is not what you expected.</p>;
  if (sent) return <p className="cw-foot" role="status">{sent}</p>;
  return (
    <form className="card cw-report" onSubmit={(e) => (e.preventDefault(), api(`/public/agree/${slug}/report`, { body: f }).then(() => setSent('Thank you. A person who reviews reports will look at this page.')).catch((err) => setSent(err.message)))}>
      <h2 style={{ fontSize: 17, marginBottom: 8 }}>Report this page</h2>
      <label className="f"><span>What is wrong</span>
        <select value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })}>
          <option value="phishing">It looks like a scam or asks for money</option>
          <option value="spam">I did not ask for this</option>
          <option value="not-for-me">It is not meant for me</option>
          <option value="other">Something else</option>
        </select>
      </label>
      <label className="f"><span>Anything else we should know <span className="hint">(optional)</span></span><textarea rows={3} value={f.detail} onChange={(e) => setF({ ...f, detail: e.target.value })} /></label>
      <label className="f"><span>Your email <span className="hint">(optional, if you want an answer)</span></span><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} autoComplete="email" /></label>
      <div className="row wrap"><button className="btn primary cw-go" style={{ width: 'auto' }}>Send the report</button><button type="button" className="btn ghost cw-go" style={{ width: 'auto' }} onClick={() => setOpen(false)}>Cancel</button></div>
    </form>
  );
}
