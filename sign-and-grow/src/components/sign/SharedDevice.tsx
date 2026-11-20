'use client';
import { StateCard } from '@/components/sign/parts';

// A public form filled in on a shared device (a tablet at a front desk). Both ways back to the form replace this
// page instead of adding to the tab's history, so Back never brings up what the person before signed, or their
// name and address. The form page itself is replaced the same way when a start opens (src/app/f/[slug]/page.tsx).
const goTo = (slug: string) => (e: React.MouseEvent<HTMLAnchorElement>) => {
  e.preventDefault();
  window.location.replace(`/f/${slug}`);
};

/** On the done screen of someone who came through a shared-device form: hand the device on with an empty form. */
export function NextPerson({ slug, email }: { slug: string; email: React.ReactNode }) {
  return (
    <StateCard tone="wait" title="Is this a shared device?">
      <p>Your copy is on its way to {email}, so you do not need this screen any more. Press the button before you hand the device on: it closes this page, so Back does not bring it up again, and opens an empty form for the next person.</p>
      <p className="small">If you opened your document in another tab or downloaded it on this device, close that tab or delete that file first.</p>
      <div className="row wrap sg-actions"><a className="btn primary lg" href={`/f/${slug}`} onClick={goTo(slug)}>Done. Start a new form for the next person</a></div>
    </StateCard>
  );
}

/**
 * A start of a public form that was cleared before it was finished (src/server/formstart.ts): left alone too long,
 * or past a deadline. Nobody is asked for more time. The visitor starts again, on an empty form, while the form
 * takes people (slug), or is told to contact whoever gave them the link.
 */
export function FormCleared({ slug }: { slug: string | null }) {
  return (
    <>
      <p>Forms that are left unfinished are cleared after a while, so they do not stand in anybody&apos;s way. Nothing was signed.</p>
      {slug ? (
        <>
          <p>To sign, start again. The new form opens empty: what you typed here is not carried over.</p>
          <div className="row wrap sg-actions"><a className="btn primary lg" href={`/f/${slug}`} onClick={goTo(slug)}>Start the form again</a></div>
        </>
      ) : <p>The form is not taking new people right now. Please contact whoever gave you the link.</p>}
    </>
  );
}
