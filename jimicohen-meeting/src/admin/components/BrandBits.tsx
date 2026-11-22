/**
 * Dashboard pieces for brands and short links: the chips on event cards and in the editor, "Your links" on
 * Home, the "Short links" card on Event types, and the offer to use another joint meeting for /pod.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, Link2 } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import type { BrandId, EventType } from '../../../shared/types';
import { errorMessage, setShortLink } from '../../lib/api';
import { storageGet, storageSet } from '../../lib/storage';
import { Button, ButtonLink, Checkbox, ConfirmDialog, CopyButton, Select, cx, useToast } from '../../ui';
import { BRAND_CHOICES, brandIconUrl, brandIdOf, brandName, coHostsMissing, podOffer, shortLinkRows, whoItBooks, type ShortLinkRow } from '../brands';
import { displayUrl, firstName, trimUrl } from '../format';
import { useAdmin } from '../state';
import '../../styles/adminbrands.css';

export function BrandChip({ id, className }: { id: BrandId; className?: string }) {
  return (
    <span className={cx('ab-chip', className)}>
      <img src={brandIconUrl(id)} alt="" width={14} height={14} className="ab-chip__logo" />
      {brandName(id)}
    </span>
  );
}

export function ShortChip({ label, className }: { label: string; className?: string }) {
  return (
    <span className={cx('ab-chip ab-chip--link', className)}>
      <Link2 size={12} aria-hidden="true" />
      {label}
    </span>
  );
}

// ───────────────────────── Home: Your links ─────────────────────────

const OFFER_KEY = 'mtg:admin:pod-offer-dismissed:';

function ShortRow({ row }: { row: ShortLinkRow }) {
  const { data, ownerHost } = useAdmin();
  const et = row.eventType;
  const brand = brandIdOf(et);
  let line: React.ReactNode;
  if (!et) {
    line = (
      <>
        Opens nothing right now.{' '}
        <Link className="adm-textlink" to="/admin/event-types#short-links">
          Choose a meeting
        </Link>
      </>
    );
  } else if (!et.active) {
    line = `${et.title} is paused, so this link is not taking bookings.`;
  } else {
    const who = whoItBooks(et, data.hosts, ownerHost.id);
    // "You and Ian, in the Eco Champions look." (DESIGN 6.1)
    const look = brand ? `, in the ${brandName(brand)} look.` : '';
    line = `${et.title}. ${look ? who.replace(/\.$/, look) : who}`;
  }
  // The /pod meeting with only the owner on it: say how it grows.
  const missing = et && row.name === 'pod' && et.active ? coHostsMissing(et, data.hosts) : [];
  const alone = et && row.name === 'pod' && et.active && et.hostIds.length === 1;
  return (
    <li className="ab-links__item">
      <div className="ab-links__top">
        <a className="ab-links__url u-truncate" href={row.url} target="_blank" rel="noopener noreferrer">
          {row.label}
        </a>
        {brand ? <BrandChip id={brand} /> : null}
        <span className="ab-links__actions">
          <CopyButton value={row.url} label="Copy" size="sm" variant="secondary" />
          <ButtonLink variant="ghost" size="sm" href={row.url} external iconRight={<ArrowUpRight size={14} />} aria-label={`Open ${row.label}`}>
            Open
          </ButtonLink>
        </span>
      </div>
      <p className="ab-links__line">{line}</p>
      {missing.length ? (
        <p className="ab-links__hint">
          {missing.length === 1 ? `${firstName(missing[0].name)} is` : `${missing.map((h) => firstName(h.name)).join(' and ')} are`} on your team but not on this meeting. Add them on
          its{' '}
          <Link className="adm-textlink" to={`/admin/event-types/${et!.id}?tab=hosts`}>
            Hosts tab
          </Link>
          .
        </p>
      ) : alone ? (
        <p className="ab-links__hint">
          Only you for now. Add your co-host on the{' '}
          <Link className="adm-textlink" to="/admin/team">
            Team
          </Link>{' '}
          page and it will only offer times when you are all free.
        </p>
      ) : null}
    </li>
  );
}

/** Home's "Your links": the short links and the main link, with what each opens. */
export function YourLinksCard() {
  const { data, ownerHost } = useAdmin();
  const rows = shortLinkRows(data);
  const main = trimUrl(data.publicUrl);
  const listed = data.eventTypes.filter((e) => e.active).slice(0, 4);
  return (
    <section className="adm-panel" aria-labelledby="home-share">
      <div className="adm-panel__head">
        <div>
          <h2 className="adm-panel__title" id="home-share">
            Your links
          </h2>
          <p className="adm-panel__desc">
            {ownerHost.google?.status === 'ok' ? 'Send one of these and people book straight into your calendar.' : 'Send one of these and people can book a time. Connect Google Calendar to have bookings go into your calendar.'}
          </p>
        </div>
      </div>
      <ul className="ab-links" role="list">
        {rows ? (
          rows.map((row) => <ShortRow key={row.name} row={row} />)
        ) : (
          <li className="ab-links__item">
            <p className="ab-links__line">Your short links are being set up. This takes up to two minutes after an update.</p>
          </li>
        )}
        <li className="ab-links__item">
          <div className="ab-links__top">
            <a className="ab-links__url u-truncate" href={main} target="_blank" rel="noopener noreferrer">
              {displayUrl(main)}
            </a>
            <span className="ab-links__actions">
              <CopyButton value={main} label="Copy" size="sm" variant="secondary" />
              <ButtonLink variant="ghost" size="sm" href={main} external iconRight={<ArrowUpRight size={14} />} aria-label={`Open ${displayUrl(main)}`}>
                Open
              </ButtonLink>
            </span>
          </div>
          <p className="ab-links__line">Every meeting you offer.</p>
          {listed.length ? (
            <ul className="adm-sharelist" role="list">
              {listed.map((et) => (
                <li key={et.id} className="adm-sharelist__item">
                  <span className="adm-dot" style={{ background: et.color || 'var(--a-primary)' }} aria-hidden="true" />
                  <Link to={`/admin/event-types/${et.id}`} className="adm-sharelist__title u-truncate">
                    {et.title}
                  </Link>
                  <span className="adm-sharelist__slug u-truncate">/{et.slug}</span>
                  <CopyButton value={`${main}/${et.slug}`} label={`Copy the link to ${et.title}`} iconOnly size="sm" variant="ghost" />
                </li>
              ))}
            </ul>
          ) : null}
        </li>
      </ul>
      <PodOffer />
      {rows ? (
        <Link className="adm-textlink ab-links__change" to="/admin/event-types#short-links">
          Change what these open
        </Link>
      ) : null}
    </section>
  );
}

/** DESIGN 5.5: another joint meeting the owner made, offered for /pod in one click. */
function PodOffer() {
  const { data, refresh } = useAdmin();
  const toast = useToast();
  const offer = useMemo(() => podOffer(data), [data]);
  const [hidden, setHidden] = useState<string[]>([]);
  const [asking, setAsking] = useState(false);
  if (!offer || hidden.includes(offer.id) || storageGet(`${OFFER_KEY}${offer.id}`) === '1') return null;
  const others = offer.hostIds.filter((id) => id !== data.site.ownerHostId).map((id) => firstName(data.hosts.find((h) => h.id === id)?.name ?? 'someone'));
  const withWhom = others.length === 1 ? others[0] : `${others.slice(0, -1).join(', ')} and ${others[others.length - 1]}`;
  const pod = shortLinkRows(data)?.find((r) => r.name === 'pod');
  const label = pod?.label ?? 'jimicohen.com/pod';
  const current = pod?.eventType?.title ?? 'Eco Champions conversation';
  return (
    <div className="ab-offer" role="group" aria-label="Another meeting for the pod link">
      <p className="ab-offer__text">
        You also have "{offer.title}", a joint meeting with {withWhom}. Use it for {label} instead?
      </p>
      <div className="ab-offer__actions">
        <Button variant="primary" size="sm" onClick={() => setAsking(true)}>
          Use {offer.title}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            storageSet(`${OFFER_KEY}${offer.id}`, '1');
            setHidden((h) => [...h, offer.id]);
          }}
        >
          Not now
        </Button>
      </div>
      <ConfirmDialog
        open={asking}
        onClose={() => setAsking(false)}
        title={`Use "${offer.title}" for ${label}?`}
        description={`${label} will open "${offer.title}", and its page, emails, texts and reminder calls will use the Eco Champions look from now on. People who already booked it keep the look they booked in. "${current}" stays, unlisted; you can delete it on Event types.`}
        confirmLabel="Use it"
        cancelLabel="Keep things as they are"
        onConfirm={async () => {
          try {
            await setShortLink('pod', offer.id, true);
            await refresh();
            toast.success(`${label} now opens "${offer.title}"`);
          } catch (e) {
            toast.error('The link was not changed', errorMessage(e));
            throw e;
          }
        }}
      />
    </div>
  );
}

// ───────────────────────── Event types: Short links ─────────────────────────

/** The "Short links" card above the event list: what each link opens, changed with a confirm. */
export function ShortLinksCard() {
  const { data } = useAdmin();
  const rows = shortLinkRows(data);
  const { hash } = useLocation();
  const ref = useRef<HTMLElement>(null);
  // "Change what these open" and "Short links" in the editor land here.
  useEffect(() => {
    if (hash === '#short-links') ref.current?.scrollIntoView({ block: 'start' });
  }, [hash]);
  return (
    <section ref={ref} className="adm-panel ab-shortlinks" id="short-links" aria-labelledby="short-links-title">
      <div className="adm-panel__head">
        <div>
          <h2 className="adm-panel__title" id="short-links-title">
            Short links
          </h2>
          <p className="adm-panel__desc">Easy addresses that open one meeting straight away, with no list to choose from.</p>
        </div>
      </div>
      {rows ? (
        <ul className="ab-links" role="list">
          {rows.map((row) => (
            <ShortLinkChooser key={row.name} row={row} />
          ))}
        </ul>
      ) : (
        <p className="ab-links__line">Your short links are being set up. This takes up to two minutes after an update.</p>
      )}
    </section>
  );
}

function ShortLinkChooser({ row }: { row: ShortLinkRow }) {
  const { data, refresh } = useAdmin();
  const toast = useToast();
  const [pending, setPending] = useState<string | null>(null);
  const [withLook, setWithLook] = useState(true);
  const chosen = pending ? (data.eventTypes.find((e) => e.id === pending) ?? null) : null;
  const linkLook = row.brandId;
  const lookDiffers = chosen ? brandIdOf(chosen) !== linkLook : false;
  const options = [
    ...data.eventTypes.map((e) => ({ value: e.id, label: `${e.title}${e.active ? '' : ' (paused)'}` })),
    { value: '', label: 'Nothing for now' },
  ];
  const close = () => setPending(null);
  const save = async () => {
    try {
      await setShortLink(row.name, pending === '' ? null : pending, pending !== '' && lookDiffers ? withLook : undefined);
      await refresh();
      toast.success(pending === '' ? `${row.label} is turned off` : `${row.label} now opens "${chosen?.title ?? ''}"`);
    } catch (e) {
      toast.error('The link was not changed', errorMessage(e));
      throw e;
    }
  };
  return (
    <li className="ab-links__item">
      <div className="ab-links__top ab-links__top--choose">
        <span className="ab-links__url u-truncate">{row.label}</span>
        <label className="ab-links__opens">
          <span className="ab-links__opens-label">Opens</span>
          <Select
            aria-label={`What ${row.label} opens`}
            size="sm"
            value={row.eventType?.id ?? ''}
            options={options}
            wrapperClassName="ab-links__select"
            onChange={(e) => {
              if (e.target.value === (row.eventType?.id ?? '')) return;
              setWithLook(true);
              setPending(e.target.value);
            }}
          />
        </label>
        <span className="ab-links__actions">
          <CopyButton value={row.url} label="Copy" size="sm" variant="secondary" />
          <ButtonLink variant="ghost" size="sm" href={row.url} external iconRight={<ArrowUpRight size={14} />} aria-label={`Open ${row.label}`}>
            Open
          </ButtonLink>
        </span>
      </div>
      <ConfirmDialog
        open={pending !== null}
        onClose={close}
        onConfirm={save}
        title={pending === '' ? `Turn off ${row.label}?` : `Move ${row.label}?`}
        description={
          pending === ''
            ? 'Visitors will see that it is not taking bookings right now.'
            : `It opens "${row.eventType?.title ?? 'nothing'}" now. After the move it opens "${chosen?.title ?? ''}".`
        }
        confirmLabel={pending === '' ? 'Turn it off' : 'Move it'}
        cancelLabel="Keep it"
      >
        {pending && lookDiffers ? (
          <Checkbox
            checked={withLook}
            onChange={setWithLook}
            label={linkLook ? `Use the ${brandName(linkLook)} look for ${chosen?.title} too. Link previews of ${row.label} always show ${brandName(linkLook)}.` : `Use your own look for ${chosen?.title} too.`}
          />
        ) : null}
      </ConfirmDialog>
    </li>
  );
}

/** The brand choice in the editor: the owner's own look, or a built-in brand. */
export function brandOptions(ownerName: string): { value: string; label: string }[] {
  return [{ value: '', label: `${ownerName} (your own look)` }, ...BRAND_CHOICES.map((b) => ({ value: b.id, label: b.name }))];
}

export function eventLook(et: Pick<EventType, 'brandId'>): BrandId | null {
  return brandIdOf(et);
}
