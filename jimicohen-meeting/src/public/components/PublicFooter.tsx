import type { PublicSite } from '../../../shared/types';
import { AppLink } from '../../lib/links';
import { useTheme } from '../../lib/theme';
import { isWebUrl, paragraphs } from '../lib/text';

export interface PublicFooterProps {
  site: PublicSite;
  /** preview mode: the credit is shown but is not a link */
  inert?: boolean;
}

function Glyph() {
  return (
    <svg className="pf-mark" viewBox="0 0 20 20" width="16" height="16" fill="none" aria-hidden="true">
      <rect x="2.5" y="4" width="15" height="13.5" rx="3.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M6.5 2.5v3M13.5 2.5v3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M7 11.2l2.2 2.2L13.2 9" stroke="var(--m-primary-text)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * What sits under every public card: the owner's footer note, the privacy link and a quiet
 * scheduling credit. The credit disappears when the theme hides branding.
 */
export function PublicFooter({ site, inert = false }: PublicFooterProps) {
  const { theme } = useTheme();
  const note = paragraphs(theme.texts.footerNote ?? '');
  const privacy = isWebUrl(site.booking.privacyUrl) ? site.booking.privacyUrl : null;
  const credit = `Scheduling by ${site.profile.name}`;
  if (!note.length && !privacy && theme.hideBranding) return null;

  return (
    <footer className="pf">
      {note.length ? (
        <div className="pf__note">
          {note.map((p, i) => (
            <p key={i}>{p}</p>
          ))}
        </div>
      ) : null}
      {privacy || !theme.hideBranding ? (
        <p className="pf__line">
          {/* A brand's credit is plain text: the owner's list of meetings is not the brand's home. */}
          {theme.hideBranding ? null : inert || site.brand ? (
            <span className="pf__credit">
              <Glyph />
              <span>{credit}</span>
            </span>
          ) : (
            <AppLink to="/" className="pf__credit">
              <Glyph />
              <span>{credit}</span>
            </AppLink>
          )}
          {privacy ? (
            <a className="pf__link" href={privacy} target="_blank" rel="noopener noreferrer">
              Privacy
            </a>
          ) : null}
        </p>
      ) : null}
    </footer>
  );
}
