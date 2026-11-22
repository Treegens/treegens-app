/**
 * Ways to hand out a booking page: the plain link, a calendar that sits inside another web
 * page, and a button that opens the calendar in a popup. The two embed snippets load
 * /embed.js from the app's own origin (AdminBootstrap.embedBaseUrl), because the main domain
 * does not allow its pages to be framed.
 */
import { useContext, useId, useMemo, useState } from 'react';
import { AppWindow, ExternalLink, Link2, MousePointerClick } from 'lucide-react';
import { ButtonLink, CopyButton, Field, Input, Tabs, cx } from '../../ui';
import { displayUrl } from '../format';
import { AdminStateContext } from '../state';
import { CopyField } from './x/bits';
import '../../styles/adminx.css';
import '../../styles/adminbrands.css';

export interface SharePanelProps {
  /** absolute public URL to share, e.g. appUrl('/intro') */
  url: string;
  /** what is being shared, for headings and button labels */
  title?: string;
  /**
   * The short link that opens this meeting (jimicohen.com/pod), when there is one: the Link tab shares it, with
   * the full address under it. The embed codes keep the full address: short pages cannot be framed.
   */
  shortUrl?: string;
}

type Mode = 'link' | 'inline' | 'popup';

function trimSlash(s: string): string {
  return s.replace(/\/+$/, '');
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * The main site's host ("jimicohen.com") when embeds come from another origin. That is the case
 * exactly because the main site does not let other origins frame its pages or run their scripts,
 * so the embed code cannot work on that site's own pages. Null when both are the same origin.
 */
function mainSiteHost(publicUrl: string | undefined, embedBaseUrl: string | undefined): string | null {
  if (!publicUrl || !embedBaseUrl) return null;
  try {
    const main = new URL(publicUrl);
    return main.origin === new URL(embedBaseUrl).origin ? null : main.host;
  } catch {
    return null;
  }
}

/** The same page on the origin that may be framed, plus where embed.js lives. */
function embedTargets(url: string, publicUrl: string | undefined, embedBaseUrl: string | undefined): { frameUrl: string; scriptUrl: string } {
  const pub = publicUrl ? trimSlash(publicUrl) : null;
  const base = trimSlash(embedBaseUrl || publicUrl || '');
  if (pub && base && url.startsWith(pub)) return { frameUrl: base + url.slice(pub.length), scriptUrl: `${base}/embed.js` };
  // Outside the dashboard (or an unexpected URL): derive the app root from the URL itself.
  try {
    const u = new URL(url);
    const root = `${u.origin}${import.meta.env.BASE_URL.replace(/\/+$/, '')}`;
    return { frameUrl: url, scriptUrl: `${base || root}/embed.js` };
  } catch {
    return { frameUrl: url, scriptUrl: `${base}/embed.js` };
  }
}

export function SharePanel({ url, title, shortUrl }: SharePanelProps) {
  const admin = useContext(AdminStateContext);
  const [mode, setMode] = useState<Mode>('link');
  const [buttonText, setButtonText] = useState('Book a meeting');
  const textId = useId();

  const { frameUrl, scriptUrl } = useMemo(() => embedTargets(url, admin?.data.publicUrl, admin?.data.embedBaseUrl), [url, admin?.data.publicUrl, admin?.data.embedBaseUrl]);

  // The link inside the box is what shows where the script cannot run (a site that blocks it, or
  // scripts switched off). embed.js takes it out when it puts the calendar in.
  const inlineSnippet = `<div data-meeting-url="${escapeHtml(frameUrl)}"><a href="${escapeHtml(url)}" data-meeting-fallback>Book a meeting</a></div>\n<script src="${escapeHtml(scriptUrl)}" async></script>`;
  const popupSnippet = `<a href="${escapeHtml(url)}" data-meeting-popup="${escapeHtml(frameUrl)}">${escapeHtml(buttonText.trim() || 'Book a meeting')}</a>\n<script src="${escapeHtml(scriptUrl)}" async></script>`;
  const mainHost = mainSiteHost(admin?.data.publicUrl, admin?.data.embedBaseUrl);

  const what = title ? `"${title}"` : 'your booking page';

  return (
    <div className="sp">
      <Tabs<Mode>
        label="How to share"
        variant="pills"
        value={mode}
        onChange={setMode}
        tabs={[
          { id: 'link', label: 'Link', icon: <Link2 size={15} /> },
          { id: 'inline', label: 'On a web page', icon: <AppWindow size={15} /> },
          { id: 'popup', label: 'Popup button', icon: <MousePointerClick size={15} /> },
        ]}
      />

      {mode === 'link' ? (
        <div className="sp__pane">
          <p className="sp__lead">
            Send this link in an email, a message or your bio.{' '}
            {admin && admin.ownerHost?.google?.status !== 'ok' ? 'People pick a time. Connect Google Calendar to have it land on your calendar.' : 'People pick a time and it lands on your calendar.'}
          </p>
          <div className="sp__link">
            <a className="sp__url" href={shortUrl ?? url} target="_blank" rel="noopener noreferrer" title={shortUrl ?? url}>
              {displayUrl(shortUrl ?? url)}
            </a>
            <CopyButton value={shortUrl ?? url} label="Copy link" variant="primary" />
          </div>
          {shortUrl ? <p className="sp__full">Full link: {displayUrl(url)}</p> : null}
          <div className="sp__row">
            <ButtonLink href={shortUrl ?? url} external variant="ghost" size="sm" iconRight={<ExternalLink size={14} />}>
              Open the page
            </ButtonLink>
          </div>
          <details className="sp__more">
            <summary>Fill in details for someone</summary>
            <p>
              Add what you already know to the end of the link and the form starts filled in, for example <code>?name=Sam&amp;email=sam@example.com</code>. You can also preselect a length with <code>?duration=30</code> or a day with <code>?date=2026-12-03</code>.
            </p>
          </details>
        </div>
      ) : null}

      {mode === 'inline' ? (
        <div className="sp__pane">
          <p className="sp__lead">Paste this where the calendar should appear on your site. It fits the width it is given and grows and shrinks with its content, so there are no scrollbars.</p>
          <CopyField multiline label={`Embed code for ${what}`} value={inlineSnippet} copyLabel="Copy code" />
          {mainHost ? (
            <p className="sp__warn" role="note">
              Not for pages on {mainHost} itself: that site does not allow embedded calendars, so the code shows only a plain link there. Use the link from the Link tab on those pages.
            </p>
          ) : null}
          <ul className="sp__notes">
            <li>Works in any site builder that accepts custom HTML (Webflow, Squarespace, WordPress, Framer).</li>
            <li>The booking card keeps your design and sits on your page's own background.</li>
            <li>If the script cannot load, a plain link to your booking page shows instead.</li>
          </ul>
        </div>
      ) : null}

      {mode === 'popup' ? (
        <div className={cx('sp__pane')}>
          <p className="sp__lead">A link or button that opens the calendar on top of your page. It closes with the Escape key or a click outside.</p>
          <Field label="Text on the button" htmlFor={textId}>
            <Input id={textId} value={buttonText} maxLength={60} onChange={(e) => setButtonText(e.target.value)} />
          </Field>
          <CopyField multiline label={`Popup button code for ${what}`} value={popupSnippet} copyLabel="Copy code" />
          {mainHost ? (
            <p className="sp__warn" role="note">
              Not for pages on {mainHost} itself: that site does not allow embedded calendars, so the button only opens your booking page there. Use the plain link on those pages.
            </p>
          ) : null}
          <ul className="sp__notes">
            <li>Style the link like any other on your site, or add the attribute to a button you already have.</li>
            <li>If the script cannot load, the link simply opens your booking page.</li>
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export default SharePanel;
