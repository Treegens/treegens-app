import { Mark } from '@/components/Brand';

// The home page's one idea, drawn: a sheet of paper with a signature line. The signature writes itself on the line
// and the leaf of the logo grows out of its last stroke. Next to the tree counting video it reads as "sign here, and
// trees go in the ground". Pure drawing, hidden from screen readers (the headline already says it in words), with no
// words on it, so there is nothing to translate. The movement is CSS in src/app/styles/home.css and stops entirely
// for anyone who asks their system for less motion.
export function HomeSignature() {
  return (
    <div className="home-sig" aria-hidden="true">
      <span className="home-sig-lines">
        <i /><i /><i /><i />
      </span>
      <span className="home-sig-field">
        <svg viewBox="0 0 420 64" className="home-sig-ink" focusable="false">
          <path
            pathLength={1}
            d="M10 44 C 16 22, 34 6, 42 14 C 50 24, 26 50, 30 56 C 36 62, 54 34, 62 24 C 66 18, 70 24, 66 36 C 63 46, 70 50, 80 40 C 88 32, 94 26, 99 31 C 103 36, 95 44, 103 45 C 113 46, 120 20, 128 10 C 132 5, 136 11, 131 25 C 126 40, 120 54, 131 50 C 141 46, 147 30, 153 21 C 157 15, 160 22, 156 35 C 152 48, 162 51, 172 41 C 180 33, 187 31, 193 37 C 199 43, 207 43, 217 35 C 244 18, 300 32, 352 26 C 376 23, 394 20, 408 14"
          />
        </svg>
        <span className="home-sig-sprout">
          <Mark size={34} tone="light" label="" />
        </span>
      </span>
    </div>
  );
}
