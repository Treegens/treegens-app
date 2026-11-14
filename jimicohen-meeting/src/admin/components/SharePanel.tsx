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

export interface SharePanelProps {
  /** absolute public URL to share, e.g. appUrl('/intro') */
  url: string;
  /** what is being shared, for headings and button labels */
  title?: string;
}

type Mode = 'link' | 'inline' | 'popup';

function trimSlash(s: string): string {
  return s.replace(/\/+$/, '');
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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

export function SharePanel({ url, title }: SharePanelProps) {
  const admin = useContext(AdminStateContext);
  const [mode, setMode] = useState<Mode>('link');
  const [buttonText, setButtonText] = useState('Book a meeting');
  const textId = useId();

  const { frameUrl, scriptUrl } = useMemo(() => embedTargets(url, admin?.data.publicUrl, admin?.data.embedBaseUrl), [url, admin?.data.publicUrl, admin?.data.embedBaseUrl]);

  const inlineSnippet = `<div data-meeting-url="${escapeHtml(frameUrl)}"></div>\n<script src="${escapeHtml(scriptUrl)}" async></script>`;
  const popupSnippet = `<a href="${escapeHtml(url)}" data-meeting-popup="${escapeHtml(frameUrl)}">${escapeHtml(buttonText.trim() || 'Book a meeting')}</a>\n<script src="${escapeHtml(scriptUrl)}" async></script>`;

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
          <p className="sp__lead">Send this link in an email, a message or your bio. People pick a time and it lands on your calendar.</p>
          <div className="sp__link">
            <a className="sp__url" href={url} target="_blank" rel="noopener noreferrer" title={url}>
              {displayUrl(url)}
            </a>
            <CopyButton value={url} label="Copy link" variant="primary" />
          </div>
          <div className="sp__row">
            <ButtonLink href={url} external variant="ghost" size="sm" iconRight={<ExternalLink size={14} />}>
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
          <ul className="sp__notes">
            <li>Works in any site builder that accepts custom HTML (Webflow, Squarespace, WordPress, Framer).</li>
            <li>The booking card keeps your design and sits on your page's own background.</li>
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
