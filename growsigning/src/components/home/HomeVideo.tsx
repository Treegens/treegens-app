'use client';

import { useEffect, useRef, useState } from 'react';
import { holdStill, type Connection } from './holdstill';

// The tree counting video on the home page. It plays by itself, muted and in a loop, the way a moving picture on a
// page is expected to, and a button on it pauses it (WCAG 2.2.2). It stays still on its poster, and nothing of the
// file is fetched, for anyone who asks their system for less motion, has asked to save data, or is on a slow
// connection: they press the same button to play it. It also stops while it is scrolled out of sight.

type Props = {
  src: string;
  type: string;
  poster: string | null;
  label: string;
  describedBy?: string;
  pauseLabel: string;
  playLabel: string;
  openLabel: string;
};

export function HomeVideo({ src, type, poster, label, describedBy, pauseLabel, playLabel, openLabel }: Props) {
  const ref = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  // What the person last chose with the button. It wins over everything else when the video scrolls back into sight:
  // paused stays paused, and a video they started themselves (on a slow connection, say) starts again.
  const chose = useRef<'play' | 'pause' | null>(null);

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    v.muted = true; // some browsers read only the property when they decide whether a video may start by itself
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    const connection = (navigator as Navigator & { connection?: Connection }).connection;
    const start = () => {
      if (chose.current === 'pause' || (chose.current !== 'play' && holdStill(reduce.matches, connection))) return;
      v.preload = 'auto';
      v.play().catch(() => setPlaying(false)); // a browser may still refuse (low power mode): the poster stays
    };
    const onMotion = () => (reduce.matches && chose.current !== 'play' ? v.pause() : start());
    reduce.addEventListener('change', onMotion);

    // Plays only while on screen.
    const seen = new IntersectionObserver(([e]) => (e.isIntersecting ? start() : v.pause()), { threshold: 0.2 });
    seen.observe(v);
    return () => {
      seen.disconnect();
      reduce.removeEventListener('change', onMotion);
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
    };
  }, []);

  const toggle = () => {
    const v = ref.current;
    if (!v) return;
    if (v.paused) {
      chose.current = 'play';
      v.preload = 'auto';
      v.play().catch(() => setPlaying(false));
    } else {
      chose.current = 'pause';
      v.pause();
    }
  };

  return (
    <div className={`home-video-frame${playing ? ' is-playing' : ''}`}>
      <video ref={ref} muted loop playsInline preload="none" poster={poster || undefined} width={960} height={540} aria-label={label} aria-describedby={describedBy}>
        <source src={src} type={type} />
      </video>
      <button type="button" className="home-video-toggle" onClick={toggle} aria-label={playing ? pauseLabel : playLabel} title={playing ? pauseLabel : playLabel}>
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
          {playing ? <path d="M8 5h3v14H8zM13 5h3v14h-3z" fill="currentColor" /> : <path d="M8 5.5v13l11-6.5z" fill="currentColor" />}
        </svg>
      </button>
      <noscript>
        <a className="home-video-open" href={src}>{openLabel}</a>
      </noscript>
    </div>
  );
}
