'use client';
import { fmtDate } from '@/components/ui';

// What the Verify page says about the digital seal inside a dropped file (POST /public/verify, `seal`, from
// sealForVerify in src/server/seal.ts). Nothing when the file carries no seal. The byte-for-byte answer above it stays
// the main answer; this only adds what the seal itself shows.
export function SealResult({ seal }: { seal: any }) {
  if (!seal) return null;
  const by = seal.name ? <>the certificate of <b>{seal.name}</b>{seal.issuer ? <>, issued by {seal.issuer}</> : null}</> : 'a certificate';
  // A time stamp is shown only when its service leads to a certificate this server was set up to trust: anyone can
  // add a time stamp to a file after it was sealed, so one that nothing vouches for is named and not shown.
  const when = seal.timestamp_at
    ? <> It carries a trusted time stamp: {fmtDate(seal.timestamp_at, true)}.</>
    : <>{seal.sealed_at ? <> Its time is the clock of the server that sealed it: {fmtDate(seal.sealed_at, true)}.</> : null}{seal.timestamp_unchecked ? <> It also carries a time stamp that this page has no way to check, so its time is not shown here.</> : null}</>;
  if (!seal.intact) {
    return (
      <div className="notice warn" style={{ marginTop: 12 }}>
        <b>Its digital seal does not hold.</b> The file carries a digital seal{seal.ours ? ' made by this server' : ''}, but {seal.why || 'it does not check out'}. So the file was changed after it was sealed, or put together around a seal taken from another file, or the seal itself is damaged. Do not rely on this file. Ask for the file exactly as it was emailed or downloaded.
      </div>
    );
  }
  if (!seal.whole_file) {
    return (
      <div className="notice warn" style={{ marginTop: 12 }}>
        <b>Something was saved into the file after its seal.</b> The digital seal holds for the part of the file it covers, made with {by}. After that, more was saved into the same file, for example a comment, a filled-in box or a turned page, by a PDF reader.
        {seal.sealed_part ? <> The sealed part is, byte for byte, the signed PDF of envelope <span className="mono">{seal.sealed_part.envelope_id}</span>, completed {fmtDate(seal.sealed_part.completed_at, true)}.</> : null}
        {' '}What was added is not covered by the seal. A PDF reader such as Acrobat can show the version as it was sealed, from its signature panel. Or ask for the file exactly as it was emailed.
      </div>
    );
  }
  if (!seal.ours) {
    return (
      <p className="small" style={{ margin: '10px 0 0' }}>
        <b>A digital seal that is not ours.</b> The file carries a digital seal that holds, made with {by}. It is not a certificate this server seals with, so this page cannot tell you whose it is or whether to trust it.
      </p>
    );
  }
  return (
    <p className="small" style={{ margin: '10px 0 0' }}>
      <b>Its digital seal holds too.</b> The file carries this server&apos;s digital seal, made with {by}, and nothing in it has changed since it was sealed.{when} A PDF reader that checks signatures can show the same without asking us. The seal is the server&apos;s, not a signature of the people who signed.
    </p>
  );
}
