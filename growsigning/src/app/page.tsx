import fs from 'node:fs';
import path from 'node:path';
import Link from 'next/link';
import { Mark } from '@/components/Brand';
import { PublicNav, PublicFooter, ImpactBand, ClosedNotice } from '@/components/Public';
import { PRICING, usd } from '@/lib/impact';
import { TREES_PER_SIGNATURE } from '@/lib/impactwords';
import { HomeSignature } from '@/components/HomeSignature';
import { HomeVideo } from '@/components/home/HomeVideo';
import { DeploymentHome } from '@/components/DeploymentHome';
import { isDeploymentBilling } from '@/lib/billingmode';
import { homeVideo, HOME_VIDEO_CAPTION, HOME_VIDEO_TEXT } from '@/lib/homevideo';
import { requestT } from '@/components/requestLang';

// The home page says one thing: every signature plants 5 trees. One button, three short points, and
// the video of the trees being counted, playing by itself with a pause button on it, beside a sheet whose signature
// writes itself and grows the leaf. Prices and their rules are on /pricing, what the product does on /features,
// and how the trees and the paper are counted on /impact.
//
// The video is a setting (HOME_VIDEO_URL, src/lib/homevideo.ts), read when the page is asked for.
export const dynamic = 'force-dynamic';

export default async function Landing() {
  const T = await requestT();
  // A server under a government agreement: nobody pays per signature there, so none of the consumer pitch applies.
  if (isDeploymentBilling()) return <DeploymentHome title={T('public.home.deployment_title')} />;
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
              <p className="home-kicker"><Mark size={28} tone="dark" label="" /> {T('public.home.kicker')}</p>
              <h1>{T.rich('public.home.h1', { trees: <em>{T('public.home.h1_trees', { count: String(TREES_PER_SIGNATURE) })}</em> })}</h1>
              {!video && <HomeSignature />}
              <p className="lead">{T('public.home.lead', { trees: String(TREES_PER_SIGNATURE) })}</p>
              <Link href="/signup" className="btn primary lg">{T('public.home.start')}</Link>
              <p className="muted small home-note">{T('public.home.note', { count: P.welcomeSignatures })}</p>
            </div>
            {video && (
              <figure className="home-video">
                <HomeVideo src={video.src} type={video.type} poster={video.poster} label={HOME_VIDEO_CAPTION} describedBy={video.poster === '/videos/tree-count.webp' ? 'home-video-text' : undefined} pauseLabel={T('public.home.pause_video')} playLabel={T('public.home.play_video')} openLabel={T('public.home.open_video')} />
                <HomeSignature />
                <figcaption>{HOME_VIDEO_CAPTION}</figcaption>
                {/* The longer description belongs to the video that ships with the product, so it is said only for that one. */}
                {video.poster === '/videos/tree-count.webp' && <p id="home-video-text" className="pub-vh">{HOME_VIDEO_TEXT}</p>}
              </figure>
            )}
          </section>
        </div>

        <ImpactBand />

        <section className="wrap section home-how" aria-labelledby="how-h">
          <h2 id="how-h" className="home-how-h">{T('public.home.how')}</h2>
          <ol className="home-points">
            <li><b>{T('public.home.send')}</b><span>{T('public.home.send_body')}</span></li>
            <li><b>{T('public.home.pay')}</b><span>{T.rich('public.home.pay_body', { link: <Link href="/pricing">{T('public.home.prices')}</Link> }, { price: usd(P.topUpUsd), monthly: usd(P.monthlyUsd), count: String(P.monthlySignatures) })}</span></li>
            <li><b>{T('public.home.trees')}</b><span>{T.rich('public.home.trees_body', { link: <Link href="/impact">{T('public.home.count')}</Link> })}</span></li>
          </ol>
          <p className="home-more"><Link href="/features">{T('public.home.everything')}</Link></p>
        </section>
      </main>
      <PublicFooter />
    </div>
  );
}
