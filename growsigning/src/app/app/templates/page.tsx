'use client';
import { Fragment, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, useLoad, fmtDate, toast } from '@/components/ui';
import { Dialog } from '@/components/sender/Dialog';
import { MorePanel } from '@/components/sender/More';
import { useMe } from '@/components/AppShell';
// Working for a colleague: a template's More moves it to another member (src/server/shares.ts).
import { MoveDialog as MoveToColleague } from '@/components/sender/Colleagues';
import { MOVE_LABEL, mayMove } from '@/lib/shares';
import { ConfirmDialog } from '@/components/sender/dialogs';
import { fail } from '@/components/sender/feedback';
import { explain, looksLikeEmail } from '@/components/sender/lib';
import { joinNames } from '@/lib/envelopepage';
import { sendAnywayAsk, type BouncedAddress } from '@/lib/mailnews';
// Who can use and change each template, and the lock on its wording (src/server/tplroles.ts).
import { AccessDialog, AccessMarks } from '@/components/templates/WhoCanUse';
import { useTemplateDetails, draftNeedsDetails } from '@/components/sender/UseDetails';
// Ready-made templates: a list inside this page, opened on purpose (src/lib/starters/).
import { Starters, StartersInvite, StartersLink } from '@/components/templates/Starters';
import { useST, senderRich } from '@/components/senderLang';
import { WRITE_TEMPLATE_LINK } from '@/lib/writedoc';
import { AddTemplate, withTemplate, withoutTemplate, useTitle, useBody } from '@/components/templates/AddTemplate';

// With a waiver form for each state or client, one flat list stops working at about twenty. So the page has what
// the envelope list has: a search (every word has to be found in the name, the folder, a role or the document), a
// folder filter, and Move. Folders of templates belong to the team, like the templates themselves.
type View = { q: string; folder: string };
const STORE = 'sg.templates.view';
const PAGE = 200;

export default function Templates() {
  const router = useRouter();
  const T = useST();
  const [view, setView] = useState<View | null>(null);
  const [typed, setTyped] = useState('');
  const [moving, setMoving] = useState<any>(null);
  const [handing, setHanding] = useState<any>(null);
  const me = useMe();
  // On a team only, for the person a template belongs to or an admin (the same rule as the server's).
  // By the same rule as the server: a custom role that may change every template sees it too (mayMove, src/lib/shares.ts).
  const mayHand = (t: any) => mayMove(me, { kind: 'template', sender_id: t.sender_id });
  const [rules, setRules] = useState<any>(null);
  // Whose More is open: one row at a time, and closed every time the page opens.
  const [more, setMore] = useState('');
  const [ready, setReady] = useState(false);
  // /app/templates?ready=1 (from Help) opens the ready-made ones: once there are templates, the page itself offers
  // them only when a search finds none, so the way to Use stays as short as it was.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('ready') === '1') setReady(true);
  }, []);
  useEffect(() => {
    if (!more) return;
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape' || document.querySelector('[role="dialog"]')) return;
      setMore('');
      document.getElementById(`tpl-more-btn-${more}`)?.focus();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [more]);
  // The last search and folder are remembered, so using a template and coming back does not lose the place.
  useEffect(() => {
    let v: View = { q: '', folder: '' };
    try {
      const saved = JSON.parse(localStorage.getItem(STORE) || '{}') || {};
      v = { q: typeof saved.q === 'string' ? saved.q : '', folder: typeof saved.folder === 'string' ? saved.folder : '' };
    } catch {
      /* storage can be unavailable */
    }
    setView(v);
    setTyped(v.q);
  }, []);
  useEffect(() => {
    if (!view) return;
    try {
      localStorage.setItem(STORE, JSON.stringify(view));
    } catch {
      /* storage can be unavailable */
    }
  }, [view]);
  useEffect(() => {
    const t = setTimeout(() => setView((v) => (v && v.q !== typed.trim() ? { ...v, q: typed.trim() } : v)), 250);
    return () => clearTimeout(t);
  }, [typed]);
  const [data, reload, error] = useLoad<any>(
    () => (view ? api(`/envelopes?kind=template&q=${encodeURIComponent(view.q)}&folder=${encodeURIComponent(view.folder)}&limit=${PAGE}`) : Promise.resolve(null)),
    [view?.q, view?.folder],
  );
  // A remembered folder that no longer exists would hide every template with no way to see why.
  useEffect(() => {
    if (data && view?.folder && !data.folders.includes(view.folder)) setView({ ...view, folder: '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);
  const filtered = !!view && (view.q !== '' || view.folder !== '');
  const showAll = () => (setTyped(''), setView({ q: '', folder: '' }));
  const [use, setUse] = useState<any>(null);
  const [fill, setFill] = useState<Record<string, { name: string; email: string }>>({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [deleting, setDeleting] = useState<any>(null);
  // Set once the envelope exists but could not be sent yet.
  const [draftId, setDraftId] = useState('');
  // Addresses on it that bounced before (src/lib/mailnews.ts): said here, and the button becomes "Send anyway".
  const [dead, setDead] = useState<BouncedAddress[] | null>(null);
  // Details the account requires that the template does not fill in, asked for in the dialog (sender/UseDetails.tsx).
  const cf = useTemplateDetails(use?.id, !!draftId);

  async function start(t: any) {
    try {
      const { envelope } = await api(`/envelopes/${t.id}`);
      const open = envelope.recipients.filter((r: any) => !r.email);
      setFill(Object.fromEntries(open.map((r: any) => [r.id, { name: '', email: '' }])));
      setProblem('');
      setDraftId('');
      setDead(null);
      setUse({ ...envelope, open });
    } catch (e) {
      fail(e);
    }
  }
  async function create(send: boolean, anyway = false) {
    if (send && !draftId) {
      const gap = use.open.find((r: any) => !fill[r.id]?.name.trim() || !looksLikeEmail((fill[r.id]?.email || '').trim()));
      if (gap) return setProblem(T('templates.need_person', { who: gap.role_name || T('templates.every_person') }));
      const noDetail = cf.problem();
      if (noDetail) return setProblem(noDetail);
    }
    setBusy(true);
    setProblem('');
    let id = draftId;
    try {
      // Two steps on purpose. If sending is refused, the draft is still there, we know which one it is, and trying
      // again sends that same draft instead of quietly making another.
      if (!id) {
        id = (await api('/envelopes', { body: { ...useBody(use), recipients: fill, custom_fields: cf.pairs() } })).envelope.id as string;
        setDraftId(id);
      }
      if (!send) {
        toast(T('templates.draft_created'));
        return router.push(`/app/envelopes/${id}/edit`);
      }
      await api(`/envelopes/${id}/send`, { method: 'POST', body: { send_anyway: anyway } });
      // The document's page says "Sent." in its banner, and its way back is Templates.
      router.push(`/app/envelopes/${id}?sent=1&from=templates`);
    } catch (e: any) {
      if (e?.code === 'bounced_address' && !anyway) return setDead(e.data?.bounced || []);
      // A required detail has no value: the draft opens on that box, instead of a button that can only fail again.
      const fillIn = draftNeedsDetails(e, id);
      if (fillIn) return toast(fillIn.words), router.push(fillIn.href);
      setProblem(id ? T('templates.kept_as_draft', { why: explain(e) }) : explain(e));
    } finally {
      setBusy(false);
    }
  }

  const rows: any[] = data?.envelopes || [];
  return (
    <div className="sn">
      <div className="pagehead">
        <div><h1 className="serif">{T('templates.title')}</h1><div className="muted">{T('templates.lede')}</div></div>
        {/* With no template yet, the one filled button is "Create your first template" in the empty list below. */}
        {(rows.length > 0 || filtered || !data) && (
          <div className="rmt-headbtns">
            <Link href="/app/envelopes/new?kind=template" className="btn primary sn-newtpl">{T('templates.new')}</Link>
          </div>
        )}
      </div>
      {ready && <Starters onClose={() => setReady(false)} />}
      {/* Shown once there is something to look through, and kept while a search or a folder hides everything. */}
      {(rows.length > 0 || filtered || (data?.folders || []).length > 0) && (
        <div className="sn-filters" role="search">
          <div className="sn-search">
            <input type="search" placeholder={T('templates.search_placeholder')} value={typed} onChange={(e) => setTyped(e.target.value)} aria-label={T('templates.search_label')} />
            {typed && <button className="btn sm ghost" onClick={() => (setTyped(''), setView((v) => ({ ...(v || { folder: '' }), q: '' })))}>{T('templates.clear')}</button>}
          </div>
          {data && data.folders.length > 0 && (
            <select value={view?.folder || ''} onChange={(e) => setView((v) => ({ ...(v || { q: '' }), folder: e.target.value }))} aria-label={T('templates.folder')}>
              <option value="">{T('templates.all_folders')}</option>{[...data.folders].sort((a: string, b: string) => a.localeCompare(b)).map((f: string) => <option key={f}>{f}</option>)}
            </select>
          )}
        </div>
      )}
      <div className="sn-selbar" aria-live="polite">
        <span className="muted small">
          {!data || rows.length === 0 ? '' : T(rows.length === PAGE ? (filtered ? 'templates.count_page_match' : 'templates.count_page') : filtered ? 'templates.count_match' : 'templates.count', { count: rows.length })}
          
        </span>
      </div>
      <div className="card pad0">
        {error ? (
          <div className="empty" role="alert"><h3>{T('templates.load_failed')}</h3>{T('templates.load_failed_body')}<div style={{ marginTop: 14 }}><button className="btn" onClick={reload}>{T('templates.try_again')}</button></div></div>
        ) : !data ? (
          <div className="empty" role="status">{T('templates.loading')}</div>
        ) : rows.length === 0 && filtered ? (
          <div className="empty"><h3>{T('templates.nothing_matches')}</h3>{T(view?.q ? (view?.folder ? 'templates.no_fit_words_folder' : 'templates.no_fit_words') : view?.folder ? 'templates.no_fit_folder' : 'templates.no_fit', { q: view?.q || '', folder: view?.folder || '' })}<div className="rmt-headbtns rmt-nomatch"><button className="btn" onClick={showAll}>{T('templates.show_all')}</button>{!ready && <StartersLink onOpen={() => setReady(true)} />}</div></div>
        ) : rows.length === 0 && ready ? (
          // The list above is open: one quiet way to make your own instead, not a second main button.
          <div className="empty rmt-own"><Link href="/app/envelopes/new?kind=template">{T('starters.or_own')}</Link></div>
        ) : rows.length === 0 ? (
          <div className="empty"><h3>{T('templates.none_yet')}</h3>{T('templates.none_yet_body')}<div style={{ marginTop: 14 }}><Link href="/app/envelopes/new?kind=template" className="btn primary">{T('templates.first')}</Link></div><p className="small" style={{ margin: '10px 0 0' }} data-feature="ds-write-doc"><Link href="/app/envelopes/new?kind=template&write=1" style={{ display: 'inline-flex', alignItems: 'center', minHeight: 44 }}>{WRITE_TEMPLATE_LINK}</Link></p>{!ready && <StartersInvite onOpen={() => setReady(true)} />}</div>
        ) : (
          <div className="tablewrap"><table className="t sn-list">
            <thead><tr><th>{T('templates.col_template')}</th><th className="hide-sm">{T('templates.col_roles')}</th><th className="hide-sm">{T('templates.col_folder')}</th><th className="hide-sm">{T('templates.col_pages')}</th><th className="hide-sm">{T('templates.col_updated')}</th><th><span className="sn-vh">{T('templates.col_actions')}</span></th></tr></thead>
            <tbody>
              {rows.map((t) => {
                const name = t.subject || T('templates.untitled');
                const roles = t.recipients.map((r: any) => r.role_name || r.name).filter(Boolean).join(', ') || T('templates.no_roles');
                const fillable = t.recipients.some((r: any) => !r.email);
                const open = more === t.id;
                return (
                  <Fragment key={t.id}>
                  <tr data-item="template">
                    <td className="sn-main">
                      <b>{name}</b><AccessMarks access={t.access} />
                      <div className="muted small">{T('templates.by', { name: t.sender })}</div>
                      <div className="muted small sn-only-sm">{T(t.folder ? 'templates.row_sm_folder' : 'templates.row_sm', { roles, count: Number(t.pages), folder: t.folder || '' })}</div>
                    </td>
                    <td className="small hide-sm">{roles}</td>
                    <td className="hide-sm muted small">{t.folder || ''}</td>
                    <td className="hide-sm num">{t.pages}</td>
                    <td className="hide-sm muted small">{fmtDate(t.updated_at)}</td>
                    <td className="sn-rowactions">
                      <button className="btn sm" onClick={() => start(t)} aria-label={T('templates.use_label', { name })}>{T('templates.use')}</button>
                      <span id={`tpl-more-wrap-${t.id}`}><MorePanel label={T('templates.more_for', { name })} panelId={`tpl-more-${t.id}`} open={open} onToggle={() => setMore(open ? '' : t.id)} buttonRef={(el) => { if (el) el.id = `tpl-more-btn-${t.id}`; }} /></span>
                    </td>
                  </tr>
                  {open && (
                    <tr className="tpl-more-row">
                      <td colSpan={6}>
                        <div className="sn-rowmore" id={`tpl-more-${t.id}`} role="group" aria-label={T('templates.more_for', { name })}>
                          {fillable && <Link className="btn sm" href={`/app/bulk?template=${t.id}`} aria-label={T('templates.to_many_label', { name })}>{T('templates.to_many')}</Link>}
                          {t.may_change !== false && <Link className="btn sm" href={`/app/templates/${t.id}/edit`} aria-label={T('templates.edit_label', { name })}>{T('templates.edit')}</Link>}
                          {t.may_change !== false && <button className="btn sm ghost" onClick={() => setMoving(t)} aria-label={T('templates.move_label', { name })}>{T('templates.move_folder')}</button>}
                          {mayHand(t) && <button className="btn sm ghost" data-feature="ds-colleagues" onClick={() => setHanding(t)} aria-label={T('templates.colleague_label', { name })}>{MOVE_LABEL}</button>}
                          <button className="btn sm ghost tr-tap" onClick={() => setRules(t)} aria-label={T('templates.who_label', { name })}>{T('templates.who')}</button>
                          {(t.access?.may_delete ?? t.may_change) !== false && <button className="btn sm ghost danger" onClick={() => setDeleting(t)} aria-label={T('templates.delete_label', { name })}>{T('templates.delete')}</button>}
                        </div>
                      </td>
                    </tr>
                  )}
                  </Fragment>
                );
              })}
            </tbody>
          </table></div>
        )}
      </div>

      {use && (
        <Dialog title={T('templates.use_title', { name: useTitle(use) })} onClose={() => setUse(null)}>
          <form onSubmit={(e) => (e.preventDefault(), create(true, !!dead))}>
            {/* Nobody to fill in: say who it goes to, so Send now is never a surprise (a template saved from a sent document keeps its people). */}
            {use.open.length === 0 && <p>{senderRich(T.lang, 'templates.goes_to', { who: <b>{joinNames(use.recipients.filter((r: any) => r.email).map((r: any) => `${r.name || r.role_name || T('templates.someone')} (${r.email})`)) || T('templates.the_people')}</b> })}</p>}
            {use.open.map((r: any, i: number) => (
              <fieldset key={r.id} className="sn-rolefill">
                <legend>{r.role_name || T('templates.person_n', { n: String(i + 1) })}</legend>
                <label className="f"><span>{T('templates.full_name')}</span><input value={fill[r.id]?.name || ''} readOnly={!!draftId} onChange={(e) => (setProblem(''), setFill({ ...fill, [r.id]: { ...fill[r.id], name: e.target.value } }))} autoComplete="off" data-autofocus={i === 0 ? '' : undefined} /></label>
                <label className="f"><span>{T('templates.email')}</span><input type="email" value={fill[r.id]?.email || ''} readOnly={!!draftId} onChange={(e) => (setProblem(''), setFill({ ...fill, [r.id]: { ...fill[r.id], email: e.target.value } }))} autoComplete="off" /></label>
              </fieldset>
            ))}
            {/* Several templates in one document (AddTemplate.tsx): one quiet link, nothing until it is pressed. */}
            {!draftId && <AddTemplate use={use} rows={rows} onAdd={(more) => { const next = withTemplate(use, more); setFill({ ...Object.fromEntries(next.open.map((r: any) => [r.id, { name: '', email: '' }])), ...fill }); setUse(next); }}
              onRemove={(id) => { const next = withoutTemplate(use, id); setProblem(''); setFill(Object.fromEntries(next.open.map((r: any) => [r.id, fill[r.id] || { name: '', email: '' }]))); setUse(next); }} />}
            {cf.boxes}
            {problem && <div className="notice err" role="alert">{problem}</div>}
            {dead && <div className="notice warn" role="alert"><b>{sendAnywayAsk(dead).title}.</b> {sendAnywayAsk(dead).body} {T('templates.bounced_draft')}</div>}
            <div className="actions">
              <button type="button" className="btn" disabled={busy} onClick={() => create(false)}>{draftId ? T('templates.open_draft') : T('templates.review_first')}</button>
              <button type="submit" className="btn primary" disabled={busy}>{busy ? T('templates.working') : dead ? T('templates.send_anyway') : draftId ? T('templates.try_sending') : T('templates.send_now')}</button>
            </div>
          </form>
        </Dialog>
      )}

      {deleting && (
        <ConfirmDialog title={T('templates.delete_title')} confirmLabel={T('templates.delete_confirm')} onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await api(`/envelopes/${deleting.id}`, { method: 'DELETE' });
            toast(T('templates.deleted'));
            setDeleting(null);
            reload();
          }}>
          <p>{T('templates.delete_body', { name: deleting.subject || T('templates.untitled') })}</p>
        </ConfirmDialog>
      )}

      {handing && <MoveToColleague envelope={handing} onClose={() => setHanding(null)} onDone={() => (setHanding(null), toast(T('templates.moved_colleague')), reload())} />}
      {moving && <MoveTemplate template={moving} folders={data?.folders || []} onClose={() => setMoving(null)} onDone={() => (setMoving(null), reload())} />}
      {rules && <AccessDialog templateId={rules.id} name={rules.subject || T('templates.untitled')} onClose={() => setRules(null)} onSaved={() => reload()} />}
    </div>
  );
}

// The same dialog the envelope list has, for a template. The server lets the person a template belongs to and the
// admins move it (PATCH /api/envelopes/:id), and the folder is the team's: everyone who can use the template sees it.
function MoveTemplate({ template, folders, onClose, onDone }: { template: any; folders: string[]; onClose: () => void; onDone: () => void }) {
  const T = useST();
  const [name, setName] = useState(template.folder || '');
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      await api(`/envelopes/${template.id}`, { method: 'PATCH', body: { folder: name.trim() } });
      toast(name.trim() ? T('templates.moved_to', { folder: name.trim() }) : T('templates.out_of_folder'));
      onDone();
    } catch (e) {
      fail(e, T('templates.nothing_moved'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title={T('templates.move_title')} onClose={onClose}>
      <form onSubmit={(e) => (e.preventDefault(), save())}>
        <label className="f">
          <span>{T('templates.folder_for', { name: template.subject || T('templates.untitled') })} <span className="hint">{T('templates.folder_hint')}</span></span>
          <input value={name} onChange={(e) => setName(e.target.value)} list="sn-template-folders" maxLength={80} placeholder={T('templates.folder_placeholder')} data-autofocus="" autoComplete="off" aria-describedby="sn-template-folder-note" />
          <datalist id="sn-template-folders">{folders.map((f) => <option key={f} value={f} />)}</datalist>
        </label>
        <p className="muted small" id="sn-template-folder-note">{T('templates.folder_note')}</p>
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>{T('templates.cancel')}</button>
          <button type="submit" className="btn primary" disabled={busy}>{busy ? T('templates.moving') : T('templates.move')}</button>
        </div>
      </form>
    </Dialog>
  );
}
