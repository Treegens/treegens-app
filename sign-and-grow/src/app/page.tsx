import fs from 'node:fs';
import path from 'node:path';
import Link from 'next/link';
import { Mark } from '@/components/Brand';
import { PublicNav, PublicFooter, ImpactBand, ClosedNotice } from '@/components/Public';
import { PRICING, usd } from '@/lib/impact';
import { TREES_PER_SIGNATURE } from '@/lib/impactwords';
import { HomeSignature } from '@/components/HomeSignature';
import { homeVideo, HOME_VIDEO_CAPTION, HOME_VIDEO_TEXT } from '@/lib/homevideo';

// The home page says one thing: a signature that is paid for plants mangroves. One button, three short points, and
// the video of the trees being counted. Prices and their rules are on /pricing, what the product does on /features,
// and how the trees and the paper are counted on /impact.
//
// The video is a setting (HOME_VIDEO_URL, src/lib/homevideo.ts), read when the page is asked for.
export const dynamic = 'force-dynamic';

const sigs = (n: number) => `${n} signature${n === 1 ? '' : 's'}`;

export default function Landing() {
  const P = PRICING;
  // A file named under public/videos/ counts only when it is there, so a typing mistake gives no block instead of an empty player.
  const video = homeVideo(process.env, (sitePath) => fs.existsSync(path.join(process.cwd(), 'public', sitePath)));
  return (
    <div className="pub">
      <PublicNav />
      <main id="main">
        <ClosedNotice />
        <div className="home-stage">
          <section className={`hero home-hero${video ? '' : ' alone'}`}>
            <div className="home-copy">
              <p className="home-kicker"><Mark size={28} tone="dark" label="" /> Planted with Treegens</p>
              <h1>Every signature you pay for plants <em>{TREES_PER_SIGNATURE} mangroves.</em></h1>
              <HomeSignature />
              <p className="lead">GrowSigning is where documents get signed on screen. What customers pay, less card fees, goes to Treegens, whose planters put mangroves in the ground: {P.treesPerUsd} for every dollar.</p>
              <Link href="/signup" className="btn primary lg">Start free</Link>
              <p className="muted small home-note">{sigs(P.welcomeSignatures)} free to try it, no card needed. Free signatures plant no trees. The people you send to never pay and never need an account.</p>
            </div>
            {video && (
              <figure className="home-video">
                {/* Never plays by itself. With a poster, nothing of the file is fetched until someone presses play. */}
                <video controls muted playsInline preload={video.preload} poster={video.poster || undefined} width={960} height={540} aria-label={HOME_VIDEO_CAPTION} aria-describedby={video.poster === '/videos/tree-count.webp' ? 'home-video-text' : undefined}>
                  <source src={video.src} type={video.type} />
                  <a href={video.src}>Open the video</a>
                </video>
                <figcaption>{HOME_VIDEO_CAPTION}</figcaption>
                {/* The longer description belongs to the video that ships with the product, so it is said only for that one. */}
                {video.poster === '/videos/tree-count.webp' && <p id="home-video-text" className="pub-vh">{HOME_VIDEO_TEXT}</p>}
              </figure>
            )}
          </section>
        </div>

        <ImpactBand />

        <section className="wrap section home-how" aria-labelledby="how-h">
          <h2 id="how-h" className="home-how-h">How it works</h2>
          <ol className="home-points">
            <li><b>Send it.</b><span>Add your document, say who signs, press Send. They sign on a phone or a computer, with no account.</span></li>
            <li><b>Pay only for signatures that happen.</b><span>{usd(P.topUpUsd)} a signature, or {usd(P.monthlyUsd)} a month for {P.monthlySignatures}. No yearly contract. <Link href="/pricing">Prices and rules</Link>.</span></li>
            <li><b>The trees get planted, and counted.</b><span>What you pay, less card fees, goes to Treegens. Planters film what they plant, and Treegens counts the seedlings in the video. <Link href="/impact">How we count</Link>.</span></li>
          </ol>
          <p className="home-more"><Link href="/features">Everything GrowSigning does</Link></p>
        </section>
      </main>
      <PublicFooter />
    </div>
  );
}
