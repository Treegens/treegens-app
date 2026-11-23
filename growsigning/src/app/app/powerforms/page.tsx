'use client';
import { useState } from 'react';
import Link from 'next/link';
import { api, useLoad, fmtDate, oops, toast } from '@/components/ui';
import { MoreMenu } from '@/components/sender/More';
import { FormLimits, formLimitLine } from '@/components/forms/FormLimits';
import { ShareLinkDialog } from '@/components/sender/ShareLink';
import { shareLinkShown } from '@/lib/sharename';
import { POWERFORM_OPEN_STARTS, POWERFORM_SHARED_OPEN_STARTS, POWERFORM_STARTS_PER_HOUR, POWERFORM_SHARED_STARTS_PER_HOUR } from '@/lib/policy';
import { useST, senderRich } from '@/components/senderLang';

export default function PowerForms() {
  const T = useST();
  const [tpls] = useLoad(() => api('/envelopes?kind=template'));
  const [data, reload] = useLoad(() => api('/powerforms'));
  const [tid, setTid] = useState('');
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);
  const [limits, setLimits] = useState<any>(null);
  // The form whose share link (growsigning.com/<name>) is being named or switched off (sender/ShareLink.tsx).
  const [sharing, setSharing] = useState<any>(null);
  const link = (slug: string) => `${window.location.origin}/f/${slug}`;

  return (
    <div className="stack">
      <div className="pagehead" style={{ marginBottom: 0 }}><div><h1 className="serif">{T('forms.title')}</h1><div className="muted">{T('forms.lede')}</div></div></div>
      <div className="card">
        <h2 style={{ marginBottom: 12 }}>{T('forms.make')}</h2>
        <div className="row wrap" style={{ alignItems: 'flex-end' }}>
          <label className="f grow" style={{ margin: 0, minWidth: 200 }}><span>{T('forms.template')}</span>
            <select value={tid} onChange={(e) => setTid(e.target.value)}>
              <option value="">{T('forms.choose')}</option>
              {/* A form sends in the name of the template's owner, so only that person and admins may publish it. */}
              {(tpls?.envelopes || []).filter((t: any) => t.may_change !== false).map((t: any) => <option key={t.id} value={t.id}>{t.subject || T('forms.untitled')}</option>)}
            </select>
          </label>
          <label className="f grow" style={{ margin: 0, minWidth: 200 }}><span>{T('forms.shown_name')}</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder={T('forms.shown_placeholder')} /></label>
          <button className="btn primary" disabled={!tid} onClick={() => api('/powerforms', { body: { template_id: tid, name, shared_device: shared } }).then(() => (toast(T('forms.made')), setName(''), setTid(''), setShared(false), reload())).catch(oops)}>{T('forms.create')}</button>
        </div>
        {(tpls?.envelopes || []).some((t: any) => t.may_change === false) && <p className="muted small" style={{ marginTop: 8, marginBottom: 0 }}>{T('forms.only_yours')}</p>}
        <label className="check" style={{ marginTop: 12, minHeight: 44 }}><input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} style={{ width: 20, height: 20 }} /> <span>{T('forms.shared')}</span></label>
        <p className="muted small" style={{ marginTop: 6, marginBottom: 0 }}>{T('forms.anyone')}</p>
        <details data-fold="">
          <summary className="set-fold">{T('forms.how')}</summary>
          <p className="muted small">{senderRich(T.lang, 'forms.how_body', { link: <a href="/help#cannot-send" target="_blank" rel="noreferrer">{T('forms.why_cannot')}</a> }, { open: POWERFORM_OPEN_STARTS, hour: POWERFORM_STARTS_PER_HOUR, shared_open: POWERFORM_SHARED_OPEN_STARTS, shared_hour: POWERFORM_SHARED_STARTS_PER_HOUR })}</p>
        </details>
      </div>
      <div className="card pad0">
        {data && data.powerforms.length === 0 ? <div className="empty"><h3>{T('forms.none')}</h3>{T('forms.none_body')}</div> : (
          <div className="tablewrap"><table className="t">
            <thead><tr><th>{T('forms.col_name')}</th><th>{T('forms.col_signed')}</th><th><span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>{T('forms.col_actions')}</span></th></tr></thead>
            {/* Signed is who finished. Started and not finished yet is shown under it, because those count against what the form can still take. */}
            <tbody>
              {(data?.powerforms || []).map((p: any) => {
                // Pausing, changing and deleting are for the person the template belongs to and for admins. Everyone
                // else is told whose it is instead of being shown lines that would be refused.
                const mine = p.may_change !== false;
                const lines = [
                  { key: 'open', label: T('forms.open'), href: `/f/${p.slug}`, newTab: true },
                  ...(mine ? [
                    { key: 'shared', label: p.shared_device ? T('forms.shared_yes') : T('forms.shared_no'), onPick: () => api(`/powerforms/${p.id}`, { method: 'PATCH', body: { shared_device: !p.shared_device } }).then(() => (toast(p.shared_device ? T('forms.now_ordinary') : T('forms.now_shared')), reload())).catch(oops) },
                    { key: 'share_link', label: T('sharelink.more'), onPick: () => setSharing(p) },
                    { key: 'limits', label: T('forms.limits'), onPick: () => setLimits(p) },
                    { key: 'pause', label: p.active ? T('forms.pause') : T('forms.resume'), onPick: () => api(`/powerforms/${p.id}`, { method: 'PATCH', body: { active: !p.active } }).then(reload).catch(oops) },
                    { key: 'delete', label: T('forms.delete'), danger: true, onPick: () => window.confirm(T('forms.delete_confirm')) && api(`/powerforms/${p.id}`, { method: 'DELETE' }).then(reload).catch(oops) },
                  ] : []),
                ];
                return (
                <tr key={p.id} data-item="form">
                  {/* Whose it is, when it was made and what a visitor goes through stand under the name, where a phone shows them without scrolling the table sideways. */}
                  {/* Under the template's name: whether the envelope each visitor starts reminds them (reminderText in src/lib/policy.ts). */}
                  <td><b>{p.name}</b><div className="muted small">{p.template || T('forms.template_deleted')}{p.shared_device ? T('forms.tag_shared') : ''}{p.active ? '' : T('forms.tag_paused')}{T('forms.made_on', { day: fmtDate(p.created_at) })}</div>
                    {/* Its readable address, the one Copy link and the QR code carry while it is on (sharelinks.ts). */}
                    {p.share_link?.active && <div className="muted small" style={{ overflowWrap: 'anywhere' }}>{shareLinkShown(p.share_link.url)}</div>}
                    {p.questions > 0 && <div className="muted small">{T('forms.questions', { count: p.questions })}</div>}
                    {p.unlabelled > 0 && <div className="muted small">{T('forms.unlabelled', { count: p.unlabelled })}</div>}
                    {p.reminders && <div className="muted small">{p.reminders} {T('forms.from_template')}</div>}
                    {formLimitLine(p) && <div className="muted small">{formLimitLine(p)}</div>}
                    {!mine && <div className="muted small">{T('forms.only_owner', { name: p.owner || T('forms.the_owner') })}</div>}
                  </td>
                  <td className="num">{p.signed}{p.open > 0 && <div className="muted small">{T('forms.filling_now', { count: p.open })}</div>}</td>
                  {/* The link the server gives is the public address (APP_URL), the one a printed code has to carry. */}
                  <td><div className="row wrap" style={{ gap: 4, justifyContent: 'flex-end' }}>
                    <button className="btn sm" style={{ minHeight: 44 }} aria-label={T('forms.copy_label', { name: p.name })} onClick={() => navigator.clipboard.writeText(p.url || link(p.slug)).then(() => toast(T('forms.copied')))}>{T('forms.copy')}</button>
                    <Link className="btn sm qr-tap" style={{ minHeight: 44 }} href={`/app/powerforms/${p.id}/qr`} aria-label={T('forms.qr_label', { name: p.name })}>{T('forms.qr')}</Link>
                    <MoreMenu kind="item" small label={T('forms.more_for', { name: p.name })} lines={lines} />
                  </div></td>
                </tr>
                );
              })}
            </tbody>
          </table></div>
        )}
      </div>
      {sharing && <ShareLinkDialog kind="form" id={sharing.id} onClose={() => setSharing(null)} onChanged={() => reload()} />}
      {limits && <FormLimits form={limits} onClose={() => setLimits(null)} onSaved={() => (setLimits(null), reload())} />}
    </div>
  );
}
