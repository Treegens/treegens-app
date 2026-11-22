'use client';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api, useLoad, fmtDate, oops, toast } from '@/components/ui';
import { TOPIC_LABEL, STATUS_FOR_OPERATOR, whenText } from '@/lib/support';
import { AttachedChat } from '@/components/HelpChat';

// Help requests, for the people who answer them. The queue is sorted by the time a person should have answered by,
// so the late ones lead. Opening a request shows everything written on it, the notes only operators see, what was
// done with who and when, and the account it is about. Every answer written here is emailed to the customer and
// kept with the request. Nothing is closed without one.

type Account = { id: string; name: string; trusted_at: string | null };
const FILTERS: [string, string][] = [['open', 'Waiting for us'], ['mine', 'Mine'], ['unowned', 'Nobody has it'], ['waiting', 'Waiting for the customer'], ['all', 'All']];
const EMPTY: Record<string, string> = { open: 'Nobody is waiting for us.', mine: 'You have no open requests.', unowned: 'Every open request has somebody on it.', waiting: 'We are not waiting for any customer.', all: 'No requests yet.' };
const plan = (p: string) => (p === 'seedling' ? 'free plan' : p === 'grove' ? 'monthly plan' : p);
const money = (cents: number, currency?: string) => (cents / 100).toLocaleString('en', { style: 'currency', currency: (currency || 'usd').toUpperCase() });
const WRITTEN: Record<string, string> = {
  own: 'Written by someone signed in under this address, which they have confirmed.',
  link: 'Written through the private link we emailed to this address, so by someone who has its mailbox.',
  signed_in_other: 'Written by someone who was signed in, but not under this address as a confirmed one. The answer goes to this address only.',
  not_signed_in: 'Written without signing in. Anyone can type any address into the form, so give out nothing about an account. A message marked "through the link" did come from this mailbox.',
};
const VIA: Record<string, string> = { form: 'typed into the help form', app: 'written while signed in', link: 'through the link in our email' };
// What became of the email to the customer, said as it is (the server answers `mail`): the mail server took it,
// there is no mail server, or it would not take it.
const mailSaid = (d: any, done: string, to: string) =>
  d.mail === 'failed' ? `Saved in the request, but the mail server did not take the email to ${to}. It is tried again by itself for about a day and a half, and whoever has the request is emailed if it still does not go. Check that the address is right.`
    : d.mail === 'outbox' ? 'Saved in the request. No mail server is set up here, so the email waits in the outbox and has not reached the customer.' : done;
// What an operator can write, and what each one does.
const KINDS: Record<string, { label: string; field: string; button: string; done: string }> = {
  answer: { label: 'An answer', field: 'Your answer. It is emailed to the customer as you write it.', button: 'Send the answer', done: 'Sent. The mail server took the email with your answer.' },
  ask: { label: 'A question to the customer', field: 'Your question. It is emailed to the customer, and the clock stops until they reply.', button: 'Send the question', done: 'Sent. The mail server took the email, and the clock is stopped until they reply.' },
  close: { label: 'A closing answer', field: 'The answer this request is closed with. It is emailed to the customer.', button: 'Send and close', done: 'Closed. The mail server took the email with the answer.' },
  note: { label: 'A note for operators', field: 'Your note. The customer never sees it.', button: 'Save the note', done: 'Note saved.' },
};

function Detail({ id, operators, accountActions, changed, openOther }: { id: string; operators: { id: string; name: string; me: boolean }[]; accountActions?: (a: Account) => ReactNode; changed: (gone?: boolean) => void; openOther: (id: string) => void }) {
  const [t, setT] = useState<any>(null);
  const [missing, setMissing] = useState('');
  const [kind, setKind] = useState('answer');
  const [text, setText] = useState('');
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    setT(null);
    setMissing('');
    api(`/operator/support/${id}`).then((d) => live && setT(d.request)).catch((e) => live && setMissing(e?.message || 'This request could not be opened.'));
    return () => {
      live = false;
    };
  }, [id]);
  if (missing) return <div className="tk-open"><p className="notice warn" style={{ marginTop: 12 }}>{missing}</p></div>;
  if (!t) return <div className="tk-open"><p className="muted" style={{ marginTop: 12 }}>Opening the request</p></div>;

  const me = operators.find((o) => o.me);
  const closed = t.status === 'closed';
  const kinds = t.alert ? (closed ? ['note'] : ['note', 'close']) : closed ? ['note'] : ['answer', 'ask', 'close', 'note'];
  const k = kinds.includes(kind) ? kind : kinds[0];
  const what = t.alert && k === 'close' ? { label: 'A closing note', field: 'What was done about this alert. It stays with it, and nobody is emailed.', button: 'Save and close', done: 'Closed.' } : KINDS[k];
  // An answered request can be closed without writing again: the answer already given goes out with the closing.
  const mayBeEmpty = k === 'close' && !t.alert && t.status === 'answered';
  const act = (body: any, done: string, after?: () => void) => {
    if (busy) return;
    setBusy(true);
    api(`/operator/support/${id}`, { body })
      .then((d) => {
        toast(d.deleted ? `${mailSaid(d, done, t.email)} The request has now been deleted: its writer closed their account, and it was kept only until it was dealt with.` : mailSaid(d, done, t.email), d.mail === 'failed');
        after?.();
        if (d.deleted) return changed(true);
        setT(d.request);
        changed();
      })
      .catch(oops)
      .finally(() => setBusy(false));
  };
  const write = (e: FormEvent) => {
    e.preventDefault();
    act({ action: k, text: text.trim() }, what.done, () => setText(''));
  };
  const a = t.account;
  const pay = a?.last_payment;

  return (
    <div className="tk-open" id={`tk-${id}`}>
      <div className="tk-facts">
        {t.alert ? <div>The software filed this by itself. Nobody is waiting for an email about it: note what you did, and close it with a note.</div> : <div>{WRITTEN[t.written]}</div>}
        {/* The whole address the answers go to, which the row above may not have room for. Anyone can type a long one. */}
        {!t.alert && <div className="tk-address">From <b>{t.name || 'someone who gave no name'}</b>. Answers go to <b>{t.email}</b>.</div>}
        {!t.alert && t.mail && (t.mail.status === 'failed' || t.mail.bounced) && (
          <div className="notice warn">Our latest email about this request (&ldquo;{t.mail.subject}&rdquo;) {t.mail.bounced ? `came back from ${t.email}: ${t.mail.bounced}.` : `was not taken by the mail server${t.mail.error ? `: ${t.mail.error}` : ''}. ${t.mail.retrying ? 'It is tried again by itself.' : 'Nobody tries again.'}`} Check the address: if it is wrong, the customer cannot read anything we write here.</div>
        )}
        {!t.alert && <div>{t.login ? `A login exists for this address: ${t.login.name}, ${t.login.confirmed ? 'address confirmed' : 'address not confirmed'}${t.login.closing_at ? `, being closed on ${fmtDate(t.login.closing_at)}` : ''}.` : 'No login uses this address.'}</div>}
        {a ? (
          <div>
            Account <b>{a.name}</b> ({a.via === 'alert' ? 'the account this alert is about' : a.via === 'written_from' ? 'the one this was written from' : 'owned by the login under this address'}) ·{a.free_with ? `free with ${a.free_with}` : plan(a.plan)}
            {a.cancel_at ? `, ends ${fmtDate(a.cancel_at)}` : a.renews_at ? `, renews ${fmtDate(a.renews_at)}` : ''} · created {fmtDate(a.created_at)} · {a.suspended_at ? <b>sending is paused{a.suspended_reason ? `: ${a.suspended_reason}` : ''}</b> : 'not paused'}
            {a.dispute_at ? ' · payments off after a card dispute' : ''} · {a.trusted_at ? `trusted since ${fmtDate(a.trusted_at)}` : 'not trusted'} · {pay ? `last payment ${money(pay.amount_cents, pay.currency)} on ${fmtDate(pay.at)} (${pay.kind === 'topup' ? 'extra signatures' : 'monthly plan'})${pay.refunded_cents ? `, ${money(pay.refunded_cents, pay.currency)} of it refunded` : ''}` : 'no payment on record'}
            {accountActions && <span style={{ marginLeft: 8 }}>{accountActions(a)}</span>}
          </div>
        ) : <div className="muted">{t.alert ? 'This alert names no account of ours. The account and payment it is about, if any, are named in its text.' : 'No account goes with this request.'}</div>}
        {t.forget && <div className="notice warn">This person has closed their account since. The request was kept so it can be answered. Your answer is emailed to them, and then the request is deleted.</div>}
        {t.follows && <div>Continues request <button type="button" className="linklike" onClick={() => openOther(t.follows.id)}>{t.follows.reference}</button>, which was closed more than 30 days before.</div>}
        {t.envelope_id && <div>About envelope <span className="mono">{t.envelope_id}</span></div>}
        <div className="muted">Opened {whenText(t.at)}{t.first_reply_at ? ` · we first wrote back ${whenText(t.first_reply_at)}` : ''}{t.closed_at && closed ? ` · closed ${whenText(t.closed_at)}` : ''}</div>
      </div>

      {/* The chat with the helper that the writer chose to send along (components/HelpChat.tsx). */}
      {t.chat?.length > 0 && <AttachedChat lines={t.chat} />}
      <ol className="tk-thread" aria-label="Everything on this request, oldest first">
        {t.thread.map((m: any, i: number) =>
          m.kind === 'event' ? <li key={i} className="event">{m.by} · {m.body} · {whenText(m.at)}</li> : (
            <li key={i} className={m.kind}>
              <div className="rq-who"><b>{m.kind === 'customer' ? `${m.by || 'The customer'}${m.via ? `, ${VIA[m.via]}` : ''}` : m.kind === 'note' ? `${m.by}, note for operators only` : m.kind === 'question' ? `${m.by} asked the customer` : `${m.by} answered`}</b><span>{whenText(m.at)}</span></div>
              <p className="rq-body">{m.body}</p>
            </li>
          ))}
      </ol>

      <div className="tk-buttons" style={{ marginBottom: 12 }}>
        {t.owner?.id !== me?.id && <button type="button" className="btn sm primary" disabled={busy} onClick={() => act({ action: 'take' }, 'It is yours now.')}>{t.owner ? `Take it over from ${t.owner.name}` : 'Take it'}</button>}
        {operators.filter((o) => o.id !== t.owner?.id).length > 0 && (
          <>
            <select value={to} onChange={(e) => setTo(e.target.value)} aria-label="Hand this request to">
              <option value="">Hand it to</option>
              {operators.filter((o) => o.id !== t.owner?.id).map((o) => <option key={o.id} value={o.id}>{o.name}{o.me ? ' (you)' : ''}</option>)}
            </select>
            <button type="button" className="btn sm" disabled={busy || !to} onClick={() => act({ action: 'assign', to }, 'Handed over. They were told by email.', () => setTo(''))}>Hand over</button>
          </>
        )}
        {!t.alert && <button type="button" className="btn sm" disabled={busy} onClick={() => act({ action: 'priority', priority: t.priority === 'urgent' ? 'normal' : 'urgent' }, t.priority === 'urgent' ? 'Marked normal. The time already promised stays.' : 'Marked urgent.')}>{t.priority === 'urgent' ? 'Mark as not urgent' : 'Mark as urgent'}</button>}
        {closed && <button type="button" className="btn sm" disabled={busy} onClick={() => act({ action: 'reopen' }, 'Open again.')}>Open it again</button>}
        {!t.alert && !closed && t.written !== 'own' && t.written !== 'link' && !t.thread.slice(1).some((m: any) => m.kind === 'customer') && (
          <button type="button" className="btn sm danger" disabled={busy} onClick={() => window.confirm('Close this without an answer? Do this only when nobody at this address can have written it, such as an advert or a scam typed into the form. The address gets one short email that says it was closed and how to open it again. The email repeats nothing of what was typed.') && act({ action: 'spam' }, 'Closed. The address was told, without the text.')}>Nobody at this address wrote this</button>
        )}
      </div>

      <form className="tk-write" onSubmit={write}>
        {kinds.length > 1 && (
          <fieldset className="tk-kinds">
            <legend>What are you writing?</legend>
            {kinds.map((x) => <label key={x}><input type="radio" name={`kind-${id}`} checked={k === x} onChange={() => setKind(x)} /> {t.alert && x === 'close' ? 'A closing note' : KINDS[x].label}</label>)}
          </fieldset>
        )}
        <label className="f"><span>{what.field}{mayBeEmpty ? ' Leave it empty to close with the answer already given: that answer is sent again.' : ''}</span>
          <textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={5000} rows={5} required={!mayBeEmpty} />
        </label>
        <button className={`btn ${k === 'note' ? '' : 'primary'}`} disabled={busy}>{busy ? 'Working' : what.button}</button>
      </form>
    </div>
  );
}

export function Tickets({ accountActions }: { accountActions?: (a: Account) => ReactNode }) {
  const [filter, setFilter] = useState('open');
  const [openId, setOpenId] = useState<string | null>(null);
  // A reference a customer reads out, an address, a name or a few words. The search looks through every request,
  // whatever its state, so it does not matter which tab is open.
  const [typed, setTyped] = useState('');
  const [term, setTerm] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setTerm(typed.trim()), 300);
    return () => clearTimeout(t);
  }, [typed]);
  const [q, reload, error] = useLoad<any>(() => api(`/operator/support?filter=${filter}${term ? `&q=${encodeURIComponent(term)}` : ''}`), [filter, term]);
  // The emails to operators link straight to one request: /app/operator?ticket=...
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('ticket');
    if (t) setOpenId(t);
  }, []);
  if (error) return null;
  const list: any[] = q?.requests || [];
  const detail = (id: string) => <Detail id={id} operators={q?.operators || []} accountActions={accountActions} openOther={setOpenId} changed={(gone) => (gone && setOpenId(null), reload())} />;
  const hours = (n: number) => `${n} hour${n === 1 ? '' : 's'}`;

  return (
    <div className="card pad0 tk">
      <div style={{ padding: '14px 16px 10px' }}>
        <h2>Help requests {q && <span className="muted" style={{ fontWeight: 400 }}>({q.counts.open} waiting for us{q.counts.late ? `, ${q.counts.late} late` : ''})</span>}</h2>
        <div className="muted small" style={{ marginTop: 4 }}>
          {q?.reply ? `Customers are told a person answers within ${hours(q.reply.hours)}, or ${hours(q.reply.urgent_hours)} when it is urgent, in real hours. ` : 'No response time is promised to customers, because no support address and no operators are set. '}
          Sorted by the time a person should have answered by. Answer here, not by email: only an answer written here reaches the customer&apos;s request and stops the clock.
        </div>
      </div>
      <div style={{ padding: '0 16px 10px' }}>
        <label className="f" style={{ margin: 0 }}><span>Find a request <span className="hint">(the reference a customer gives you, an email address, a name, or words from the message)</span></span>
          <input type="search" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="For example ABCD2345 or name@example.com" autoComplete="off" spellCheck={false} />
        </label>
        {term && <div className="muted small" style={{ marginTop: 6 }} role="status">{q ? `${list.length === 0 ? 'No request matches' : list.length === 1 ? 'One request matches' : `${list.length} requests match`} "${term}". The search looks through every request, open or closed. ` : 'Searching. '}<button type="button" className="linklike" onClick={() => setTyped('')}>Clear the search</button></div>}
      </div>
      {!term && (
      <div className="tk-filters" role="group" aria-label="Which requests to show">
        {FILTERS.map(([key, label]) => <button key={key} type="button" aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}{q ? ` (${q.counts[key]})` : ''}</button>)}
      </div>
      )}
      {openId && !list.some((r) => r.id === openId) && q && <div className="queue-item" style={{ padding: 0 }}><div className="muted small" style={{ padding: '10px 16px 0' }}>The request you opened is not in this list. <button type="button" className="linklike" onClick={() => setOpenId(null)}>Put it away</button></div>{detail(openId)}</div>}
      {!q && <div className="empty" style={{ padding: 24 }}>Loading</div>}
      {q && list.length === 0 && <div className="empty" style={{ padding: 24 }}>{term ? 'Nothing matches. Check the spelling of the reference: it is eight letters and numbers, and never holds 0, 1, I, L or O.' : EMPTY[filter]}</div>}
      {list.map((r) => (
        <div key={r.id} className="queue-item" style={{ padding: 0 }}>
          <button type="button" className="tk-row" aria-expanded={openId === r.id} aria-controls={`tk-${r.id}`} onClick={() => setOpenId(openId === r.id ? null : r.id)}>
            <span className="tk-line">
              <span>
                {r.late && <span className="tk-mark late">Late</span>}
                {r.priority === 'urgent' && <span className="tk-mark urgent">Urgent</span>}
                {r.alert && <span className="tk-mark alert">Alert</span>}
                <b>{r.alert ? 'Filed by the software' : `${r.name || 'Someone'} · ${r.email}`}</b>
              </span>
              <span className="muted small">{TOPIC_LABEL[r.topic] || r.topic} · ref {r.reference}</span>
            </span>
            <span className="tk-line small">
              <span style={r.late ? { color: 'var(--red)', fontWeight: 600 } : undefined}>
                {r.status !== 'open' ? STATUS_FOR_OPERATOR[r.status] : r.late ? `Should have been answered by ${whenText(r.due_at)}` : r.due_at ? `Answer by ${whenText(r.due_at)}` : r.alert ? `Filed ${whenText(r.at)}` : `No time was promised. Sent ${whenText(r.at)}`}
              </span>
              <span className="muted">{r.owner ? r.owner.name : 'Nobody has it'}</span>
            </span>
            <span className="tk-line small muted" style={{ overflowWrap: 'anywhere' }}>{r.message.length > 150 ? `${r.message.slice(0, 150)}...` : r.message}</span>
          </button>
          {openId === r.id && detail(r.id)}
        </div>
      ))}
    </div>
  );
}
