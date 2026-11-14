import { useEffect, useRef } from 'react';

export interface ConfettiProps {
  /** colours to draw with, usually the theme's primary, accent and text */
  colors: string[];
  /** more pieces and a longer fall */
  lively?: boolean;
}

interface Piece {
  x: number;
  y: number;
  vx: number;
  vy: number;
  w: number;
  h: number;
  rot: number;
  vr: number;
  tilt: number;
  vt: number;
  color: string;
  round: boolean;
}

/**
 * One burst of confetti drawn on a canvas that covers its positioned parent.
 * Plays once and removes nothing from the layout. No library, no images.
 * The caller decides whether to render it at all (theme setting, reduced motion).
 */
export function Confetti({ colors, lively = false }: ConfettiProps) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    const palette = colors.filter(Boolean);
    if (!palette.length) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.scale(dpr, dpr);

    const count = Math.round((lively ? 150 : 90) * Math.min(1, Math.max(0.55, width / 640)));
    const originX = width / 2;
    const originY = Math.min(height * 0.3, 150);
    const pieces: Piece[] = Array.from({ length: count }, (_, i) => {
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.15;
      const speed = (lively ? 9 : 7.5) + Math.random() * (lively ? 9 : 7);
      const size = 5 + Math.random() * 6;
      return {
        x: originX + (Math.random() - 0.5) * 24,
        y: originY + (Math.random() - 0.5) * 12,
        vx: Math.cos(angle) * speed * (0.6 + Math.random() * 0.8),
        vy: Math.sin(angle) * speed,
        w: size,
        h: size * (0.45 + Math.random() * 0.5),
        rot: Math.random() * Math.PI * 2,
        vr: (Math.random() - 0.5) * 0.35,
        tilt: Math.random() * Math.PI * 2,
        vt: 0.08 + Math.random() * 0.14,
        color: palette[i % palette.length],
        round: i % 7 === 0,
      };
    });

    const duration = lively ? 3400 : 2600;
    const started = performance.now();
    let last = started;
    let frame = 0;

    const draw = (now: number) => {
      const elapsed = now - started;
      const dt = Math.min(2.2, (now - last) / 16.67);
      last = now;
      ctx.clearRect(0, 0, width, height);
      const fade = elapsed > duration - 700 ? Math.max(0, (duration - elapsed) / 700) : 1;
      for (const p of pieces) {
        p.vy += 0.24 * dt;
        p.vx *= Math.pow(0.985, dt);
        p.vy *= Math.pow(0.992, dt);
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.rot += p.vr * dt;
        p.tilt += p.vt * dt;
        if (p.y > height + 20) continue;
        ctx.save();
        ctx.globalAlpha = fade;
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        // Squash on one axis as the piece tumbles, which reads as a flutter.
        ctx.scale(1, Math.max(0.15, Math.abs(Math.cos(p.tilt))));
        ctx.fillStyle = p.color;
        if (p.round) {
          ctx.beginPath();
          ctx.arc(0, 0, p.w / 2.4, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        }
        ctx.restore();
      }
      if (elapsed < duration) frame = window.requestAnimationFrame(draw);
      else ctx.clearRect(0, 0, width, height);
    };
    frame = window.requestAnimationFrame(draw);

    return () => {
      window.cancelAnimationFrame(frame);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    };
    // One burst per mount: colour changes while it plays are ignored on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <canvas ref={ref} className="bw-confetti" aria-hidden="true" />;
}
