import { INSTALL_HELP_ID, NOT_IN_STORES, IPHONE_STEPS, ANDROID_STEPS, CANNOT, WHAT_IT_DOES, CLEANUP_HELP_ID, CLEANUP_HELP } from '@/lib/phoneapp';

// "Add GrowSigning to your home screen" on /help: the steps for iPhone and Android, what it is, and what it does not
// do. The line on Home on a phone opens this answer (src/components/InstallHint.tsx). Words in src/lib/phoneapp.ts.
export function HomeScreenHelp() {
  return (
    <article className="pub-qa" id={INSTALL_HELP_ID}>
      <h3>Can I add GrowSigning to my phone&apos;s home screen?</h3>
      <p>Yes. {NOT_IN_STORES} {WHAT_IT_DOES}</p>
      <p><b>On an iPhone or iPad:</b></p>
      <ol>{IPHONE_STEPS.map((s) => <li key={s}>{s}</li>)}</ol>
      <p><b>On Android:</b></p>
      <ol>{ANDROID_STEPS.map((s) => <li key={s}>{s}</li>)}</ol>
      <p><b>What it does not do:</b></p>
      <ul>{CANNOT.map((s) => <li key={s}>{s}</li>)}</ul>
    </article>
  );
}

/** "Why does my photo look different?": what the cleanup of a photographed page does, and the way back. */
export function PhotoCleanupHelp() {
  return (
    <article className="pub-qa" id={CLEANUP_HELP_ID}>
      <h3>Why does my photo of a page look different?</h3>
      <p>{CLEANUP_HELP}</p>
    </article>
  );
}
