// The picture of the first time: a shoreline, and mangrove seedlings that rise one after another out of the water
// line and put out leaves. SVG and CSS only (src/app/styles/impact.css), about 2.5 seconds, nothing that flashes.
// With "reduce motion" switched on in the device it is a still picture of the end. It is decoration: screen readers
// are told the sentence next to it, never the picture.
//
// `trees` seedlings are drawn, one for each tree the signature plants (5). When it plants none, none is drawn (nothing
// was planted, so no tree is shown): the leaf of the logo stands on the shore instead.
import { MARK, TONES } from '@/lib/brandMark';

const WATER = 92; // the water line, in the picture's own units (320 by 132)
const W = 320;

export function Mangroves({ trees, go = true }: { trees: number; go?: boolean }) {
  const n = Math.max(0, Math.min(10, Math.round(trees)));
  const step = (W - 40) / Math.max(1, n - 1);
  return (
    <svg className={`imp-pic${go ? ' imp-go' : ''}`} viewBox="0 0 320 132" aria-hidden="true" focusable="false" preserveAspectRatio="xMidYMid meet">
      <rect width="320" height="132" rx="14" fill="#f6f3ec" />
      <circle className="imp-sun" cx="262" cy="34" r="15" fill="#ffd24a" />
      {n > 0 ? Array.from({ length: n }, (_, i) => {
        const x = n === 1 ? W / 2 : 20 + i * step;
        const tall = i % 2 ? 6 : 0;
        const top = 62 - tall;
        return (
          <g key={i} className="imp-tree" style={{ transformOrigin: `${x}px ${WATER}px`, animationDelay: `${i * 0.17}s` }}>
            <path d={`M${x} 84q-6 3 -7 9M${x} 84q6 3 7 9M${x} 88q-3 2 -3.5 5M${x} 88q3 2 3.5 5`} fill="none" stroke="#134a2c" strokeWidth="1.5" strokeLinecap="round" />
            <path d={`M${x} ${WATER}V${top}`} stroke="#1f6f43" strokeWidth="2.4" strokeLinecap="round" />
            <g className="imp-leaf" style={{ animationDelay: `${i * 0.17 + 0.45}s` }}>
              <ellipse cx={x - 6} cy={top + 9} rx="6.5" ry="3" fill="#6fb35f" transform={`rotate(-32 ${x - 6} ${top + 9})`} />
              <ellipse cx={x + 6} cy={top + 5} rx="6.5" ry="3" fill="#6fb35f" transform={`rotate(32 ${x + 6} ${top + 5})`} />
              <ellipse cx={x} cy={top - 5} rx="3" ry="6.5" fill="#9ed88f" />
            </g>
          </g>
        );
      }) : (
        <g className="imp-tree" style={{ transformOrigin: `160px ${WATER}px` }}>
          <g transform="translate(138 46) scale(0.69)">
            <path fill={TONES.light.lit} d={MARK.lit} />
            <path fill={TONES.light.shade} d={MARK.shade} />
          </g>
        </g>
      )}
      {/* The water in front of the stems, so each seedling comes up out of it. */}
      <path d="M0 92q20 -4 40 0t40 0t40 0t40 0t40 0t40 0t40 0t40 0V132H0z" fill="#9ed88f" opacity="0.55" />
      <path d="M0 104q20 -4 40 0t40 0t40 0t40 0t40 0t40 0t40 0t40 0V132H0z" fill="#6fb35f" opacity="0.45" />
      <path d="M0 132v-9q80 -7 160 -3t160 -2v14z" fill="#134a2c" />
    </svg>
  );
}
