'use client';
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { api, useLoad } from '@/components/ui';
import { Mark } from '@/components/Brand';
import { QrOwnPhone } from '@/components/QrOwnPhone';
// A form whose open role fills in fields asks them as questions first, then shows the document (ds-web-forms).
import { FormQuestions } from '@/components/webforms/FormQuestions';
import { FormReview } from '@/components/webforms/FormReview';
import { answersToKeep, startingAnswers, shownQuestions } from '@/lib/webforms';
import { t } from '@/lib/i18n';

// What this browser typed, kept here too (never on a shared device, where the next person would see it).
const KEEP = (slug: string) => `gs-form-${slug}`;
const readKept = (slug: string) => {
  try {
    return JSON.parse(window.localStorage.getItem(KEEP(slug)) || 'null');
  } catch {
    return null;
  }
};
const writeKept = (slug: string, v: any) => {
  try {
    if (v) window.localStorage.setItem(KEEP(slug), JSON.stringify({ ...v, at: Date.now() }));
    else window.localStorage.removeItem(KEEP(slug));
  } catch {
    /* private window: the server keeps them instead */
  }
};

export default function PowerForm() {
  const { slug } = useParams<{ slug: string }>();
  const [form, , error] = useLoad(() => api(`/public/powerforms/${slug}`), [slug]);
  const [f, setF] = useState({ name: '', email: '' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [queued, setQueued] = useState(false);
  const [step, setStep] = useState<'details' | 'questions' | 'review'>('details');
  const [answers, setAnswers] = useState<Record<string, any>>({});
  const [stamp, setStamp] = useState(0);
  const [kept, setKept] = useState(false);
  // Which shown question is on screen. Each step is an entry in the browser's history, so a phone's Back goes back
  // one question instead of leaving the form.
  const [at, setAt] = useState(0);
  // The answers the document on the review screen was drawn from, and the key that opens it: exactly these go on to
  // be signed, never answers the server did not draw.
  const [reviewed, setReviewed] = useState<{ answers: Record<string, string>; key: string } | null>(null);
  // Saves go one after another, so a slow early save never lands after the last one.
  const saving = useRef<Promise<unknown>>(Promise.resolve());
  const locale = typeof document !== 'undefined' ? document.documentElement.lang || 'en' : 'en';
  const asks = !!form?.questions?.length;

  // Answers from before come back: the server's copy for this browser first, then this device's own.
  useEffect(() => {
    if (!asks) return;
    const fresh = startingAnswers(form.questions, form.fields);
    let on = true;
    // On a shared device the person before must leave nothing behind for the next one.
    if (form.shared_device) {
      setAnswers(fresh);
      api(`/public/powerforms/${slug}/draft`, { method: 'DELETE' }).catch(() => {});
      return;
    }
    api(`/public/powerforms/${slug}/draft`).then((r) => {
      if (!on) return;
      const local = readKept(slug);
      const d = r.draft || (local && Date.now() - (local.at || 0) < 864e5 ? local : null);
      if (d && Object.keys(d.answers || {}).length) {
        setF({ name: d.name || '', email: d.email || '' });
        setAnswers({ ...fresh, ...d.answers });
        setKept(true);
      } else setAnswers(fresh);
    }).catch(() => on && setAnswers(fresh));
    return () => {
      on = false;
    };
  }, [asks, slug]); // eslint-disable-line react-hooks/exhaustive-deps

  // Kept on the server for this browser only, and on this device unless it is shared. A save between questions that
  // fails is said once and the person goes on: what they typed is still on the screen. The last save, before the
  // document, must work (toReview), because the document is drawn from it.
  function keep(a: Record<string, any>): Promise<{ answers: Record<string, string>; key: string } | { error: string }> {
    const body = { name: f.name, email: f.email, answers: answersToKeep(form.questions, form.fields, a) };
    if (!form.shared_device) writeKept(slug, body);
    const done = saving.current.then(() => api(`/public/powerforms/${slug}/draft`, { method: 'PUT', body }))
      .then((r: any) => ({ answers: body.answers, key: String(r?.review || '') }))
      .catch((err: any) => {
        const error = err?.status === 413 || err?.status === 429 ? err.message : t(locale, 'form.save_failed_review');
        if (err?.status === 413 || err?.status === 429) setMsg(error);
        return { error };
      });
    saving.current = done;
    return done;
  }

  async function toReview(a: Record<string, any>) {
    setMsg('');
    const r = await keep(a);
    if ('error' in r) return setMsg(r.error);
    setReviewed(r);
    setStamp(Date.now());
    go('review', 0);
    window.scrollTo(0, 0);
  }

  // A step forward is a new history entry; Back (on the page or the phone's own) goes to the entry before.
  function go(s: 'details' | 'questions' | 'review', i: number) {
    setStep(s);
    setAt(i);
    try {
      window.history.pushState({ wf: s, at: i }, '');
    } catch {
      /* no history: the page's own Back still works */
    }
  }
  function back() {
    setMsg('');
    if (window.history.state?.wf) window.history.back();
    else if (step === 'review') setStep('questions');
    else if (at > 0) setAt(at - 1);
    else setStep('details');
  }
  useEffect(() => {
    const pop = (e: PopStateEvent) => {
      setMsg('');
      const st = e.state?.wf;
      setStep(st === 'questions' || st === 'review' ? st : 'details');
      setAt(typeof e.state?.at === 'number' ? e.state.at : 0);
    };
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, []);

  async function sign() {
    setBusy(true);
    setMsg('');
    try {
      const r = await api(`/public/powerforms/${slug}/start`, { body: { ...f, answers: reviewed?.answers ?? answersToKeep(form.questions, form.fields, answers) } });
      writeKept(slug, null);
      if (r.url) form?.shared_device ? window.location.replace(r.url) : window.location.assign(r.url);
      else setQueued(true);
    } catch (err: any) {
      setMsg(err.message);
      setBusy(false);
    }
  }

  async function start(e: React.FormEvent) {
    e.preventDefault();
    if (asks) return void (keep(answers), setMsg(''), go('questions', 0));
    setBusy(true);
    setMsg('');
    try {
      const r = await api(`/public/powerforms/${slug}/start`, { body: f });
      // On a shared device the form page is replaced, not stacked: Back must never bring up what the person before
      // typed, and after "Start a new form for the next person" nothing of theirs is left in this tab's history.
      if (r.url) form?.shared_device ? window.location.replace(r.url) : window.location.assign(r.url);
      else setQueued(true);
    } catch (err: any) {
      setMsg(err.message);
      setBusy(false);
    }
  }

  return (
    <div className={step === 'review' ? undefined : 'authbox'} style={step === 'review' ? { maxWidth: 900, margin: '3vh auto', padding: '0 16px' } : undefined}>
      {error ? <div className="card center"><h2>This form is not available</h2><p className="muted" style={{ marginTop: 8 }}>It may have been paused or removed by its owner.</p></div>
        : !form ? <div className="muted center">Loading…</div>
        : form.closed ? <div className="card center"><h2>This form cannot take new signatures right now</h2><p className="muted" style={{ marginTop: 8 }}>Please contact whoever gave you the link.</p></div>
        : queued ? <div className="card center"><h2>Thank you</h2><p className="muted" style={{ marginTop: 8 }}>We will email {f.email} as soon as the document is ready for you to sign.</p></div>
        : step === 'questions' ? (
          <>
            <FormQuestions locale={locale} questions={form.questions} fields={form.fields} dateFormat={form.date_format} answers={answers} onAnswers={(a) => (setMsg(''), setAnswers(a))}
              at={at} onAt={(i) => go('questions', i)} onStep={keep} onBack={back} onDone={toReview} />
            {msg && <div className="notice err" role="alert" style={{ marginTop: 12 }}>{msg}</div>}
          </>
        ) : step === 'review' ? (
          <FormReview locale={locale} slug={slug} reviewKey={reviewed?.key || ''} stamp={stamp} busy={busy} msg={msg} onChange={back} onContinue={sign} />
        ) : (
          <form className="card" onSubmit={start}>
            <div className="row" style={{ marginBottom: 12 }}>
              {form.brand?.brand_logo ? <img src={form.brand.brand_logo} alt={form.brand.name} style={{ maxHeight: 36 }} /> : <Mark size={28} label="" />}
              <span className="muted small">{form.brand?.name}</span>
            </div>
            <h1 className="serif" style={{ fontSize: 24 }}>{form.name}</h1>
            <p className="muted" style={{ margin: '8px 0 16px' }}>{asks ? t(locale, 'form.details_asks', { count: shownQuestions(form.questions, form.fields, answers).length }) : 'Enter your details to review and sign. It takes a minute, and no paper is involved.'}</p>
            {/* A shared device must not offer the next person the names and addresses typed before: no autofill there. */}
            <label className="f"><span>Your full name</span><input dir="auto" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required autoComplete={form.shared_device ? 'off' : 'name'} autoFocus /></label>
            <label className="f"><span>Your email <span className="hint">(we send your signed copy here)</span></span><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required autoComplete={form.shared_device ? 'off' : 'email'} /></label>
            {msg && <div className="notice err" style={{ marginBottom: 12 }} role="alert">{msg}</div>}
            {asks && <p className="muted small" style={{ margin: '0 0 12px' }}>{t(locale, 'form.answers_fill')}</p>}
            {kept && <p className="muted small" role="status" style={{ margin: '0 0 12px' }}>{t(locale, 'form.kept')} <button type="button" className="btn sm ghost" style={{ minHeight: 44 }} onClick={() => (setAnswers(startingAnswers(form.questions, form.fields)), setF({ name: '', email: '' }), setKept(false), writeKept(slug, null), api(`/public/powerforms/${slug}/draft`, { method: 'DELETE' }).catch(() => {}))}>{t(locale, 'form.start_over')}</button></p>}
            <button className="btn primary" style={{ width: '100%' }} disabled={busy}>{busy ? 'Preparing your document…' : asks ? t(locale, 'form.next') : 'Continue to sign'}</button>
            {/* On a big screen (a tablet at a front desk): a code that opens this same form on the visitor's own phone. */}
            <QrOwnPhone slug={slug} name={form.name} />
          </form>
        )}
      <p className="muted small center" style={{ marginTop: 14 }}>{/* The tree clause only for an account that shows trees to its signers ('Trees on screens and emails'). */}
        {form?.trees ? 'Powered by GrowSigning, where every dollar plants mangrove trees.' : 'Powered by GrowSigning.'} <a href="/help?topic=signing#contact">Something not working? Get help</a></p>
    </div>
  );
}
