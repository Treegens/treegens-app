import { STAMP_IS, STAMPS_PER_ACCOUNT, STAMP_DEFAULT_MM, STAMP_UPLOAD_MAX_BYTES, STAMP_UPLOADS_PER_LINK_HOUR } from '@/lib/stamps';

// "Can a company stamp or seal go next to a signature?" on /help: what a stamp is here, how it is made to look like
// ink, where it comes from, and what it is not. The rules and the words are in src/lib/stamps.ts and
// src/server/stamps.ts.
export function StampHelp() {
  return (
    <article className="pub-qa" id="stamps">
      <h3>Can a company stamp or seal go next to a signature?</h3>
      <p>Yes. In many countries a document is only accepted with the company&apos;s stamp or seal beside the signature, so a document can carry one. It is printed like ink from a rubber stamp, not as a picture pasted on top: the paper of the picture is taken away, it comes out in one ink (blue, red, purple, black or green) with the unevenness of a real stamp (one side pressed a little harder, small spots where the ink did not take, slightly rough edges) and a small tilt, and on the page and in the signed PDF the words printed under it show through it. A photo of your real stamp pressed on paper looks most like the real thing; a logo in several colours is printed in one ink with a thin gap where its colours meet.</p>
      <ul className="pub-list">
        <li><b>Your team&apos;s stamps.</b> Admins add them under Settings, Stamps and seals, up to {STAMPS_PER_ACCOUNT}: a name, a picture of the stamp and its real size. A round company seal is about 38 to 45 mm across, and a stamp field starts at {STAMP_DEFAULT_MM} mm. Everyone on the team can use them. Changing or deleting one never changes a document it is already on.</li>
        <li><b>Your own stamp on a document you send.</b> In step 2, place a <b>Stamp</b> field, choose <b>Me: one of my team&apos;s stamps</b> and pick the stamp. It is part of the document from the start, so once someone has signed, changing it means they sign again.</li>
        <li><b>A stamp from the person who signs.</b> Place a Stamp field for them, required or not, like a signature field. They put their stamp on when they sign: a design file or a photo of the stamp pressed on paper (PNG, JPEG or WebP, up to {STAMP_UPLOAD_MAX_BYTES / 1048576} MB), taken with their phone camera there and then if they like, or one of their own team&apos;s saved stamps when they are signed in at the address you sent it to. They see it on a page of text before they put it on, with the ink chosen for them, and can change the ink, how much counts as paper, the texture and the tilt. A second stamp field on the same document offers the stamp they just put on, so they make it once. A signing link can put on up to {STAMP_UPLOADS_PER_LINK_HOUR} pictures an hour, and nobody outside the document ever sees a picture they upload.</li>
        <li><b>The record.</b> The record of the document says who put which stamp where and when, and keeps a fingerprint of the picture. The signing record lists it under that person. The evidence pack has each stamp as a picture.</li>
        <li><b>Money.</b> A stamp is not a signature and uses none. Someone who only stamps counts like anyone else who signs.</li>
      </ul>
      <p><b>What it is not.</b> {STAMP_IS} It is not stamp duty either: a company stamp here pays no duty, and it is not an e-stamp certificate (India) or an e-meterai (Indonesia). Where a document needs those, add them as the first file of the document. Whether a stamp is needed, and whether a picture of one is accepted, depends on the country and on whoever receives the document.</p>
    </article>
  );
}
