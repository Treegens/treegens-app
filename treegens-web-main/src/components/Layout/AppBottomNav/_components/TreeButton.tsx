import { PulseRings } from '@/components/ui/PulseRings'

/**
 * The tab bar's plant button. It breathes and sends out ripples so a
 * first-time planter sees where to start. A top-aligned inline-block with
 * the svg left inline, so the button sits exactly where the bare svg did
 * (a block wrapper drops it 6px).
 */
export const TreeButton = () => {
  return (
    <span className="relative inline-block align-top">
      {/* On the drawn circle (cx 45, cy 41, r 40), not the 90px box. */}
      <PulseRings className="left-[5px] top-px h-20 w-20" />
      <svg
        className="tg-breathe relative"
        style={{ transformOrigin: '45px 41px' }}
        width="90"
        height="90"
        viewBox="0 0 90 90"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <g filter="url(#filter0_dd_913_2477)">
          <circle cx="45" cy="41" r="40" fill="url(#paint0_linear_913_2477)" />
          <path
            d="M50.9459 26.0313C52.6303 27.4783 53.7404 29.4809 54.0753 31.6761H54.2875C56.3987 31.6761 58.4237 32.5148 59.9166 34.0077C61.4095 35.5006 62.2483 37.5255 62.2483 39.6368C62.2483 41.7481 61.4095 43.7729 59.9166 45.2659C58.4237 46.7588 56.3987 47.5975 54.2875 47.5975H35.7125C33.6012 47.5975 31.5764 46.7588 30.0835 45.2659C28.5905 43.7729 27.7518 41.7481 27.7518 39.6368C27.7518 37.5255 28.5905 35.5006 30.0835 34.0077C31.5764 32.5148 33.6012 31.6761 35.7125 31.6761C36.0473 29.4809 37.1575 27.4783 38.8419 26.0313C40.5263 24.5843 42.6733 23.7887 44.8939 23.7887C47.1145 23.7887 49.2615 24.5843 50.9459 26.0313Z"
            fill="#6B8C3B"
            stroke="#4D341E"
            strokeWidth="1.71"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M40.8075 39.6362L44.7879 43.6166V58.2113"
            stroke="#4D341E"
            strokeWidth="1.71"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M44.7878 43.6166L48.7682 39.6362"
            stroke="#4D341E"
            strokeWidth="1.71"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>
        <defs>
          <filter
            id="filter0_dd_913_2477"
            x="0"
            y="0"
            width="90"
            height="90"
            filterUnits="userSpaceOnUse"
            colorInterpolationFilters="sRGB"
          >
            <feFlood floodOpacity="0" result="BackgroundImageFix" />
            <feColorMatrix
              in="SourceAlpha"
              type="matrix"
              values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
              result="hardAlpha"
            />
            <feMorphology
              radius="2"
              operator="erode"
              in="SourceAlpha"
              result="effect1_dropShadow_913_2477"
            />
            <feOffset dy="2" />
            <feGaussianBlur stdDeviation="2" />
            <feColorMatrix
              type="matrix"
              values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.05 0"
            />
            <feBlend
              mode="normal"
              in2="BackgroundImageFix"
              result="effect1_dropShadow_913_2477"
            />
            <feColorMatrix
              in="SourceAlpha"
              type="matrix"
              values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
              result="hardAlpha"
            />
            <feMorphology
              radius="1"
              operator="erode"
              in="SourceAlpha"
              result="effect2_dropShadow_913_2477"
            />
            <feOffset dy="4" />
            <feGaussianBlur stdDeviation="3" />
            <feColorMatrix
              type="matrix"
              values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.1 0"
            />
            <feBlend
              mode="normal"
              in2="effect1_dropShadow_913_2477"
              result="effect2_dropShadow_913_2477"
            />
            <feBlend
              mode="normal"
              in="SourceGraphic"
              in2="effect2_dropShadow_913_2477"
              result="shape"
            />
          </filter>
          <linearGradient
            id="paint0_linear_913_2477"
            x1="45"
            y1="1"
            x2="45"
            y2="81"
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor="#D8E574" />
            <stop offset="0.0001" stopColor="#D3E165" />
            <stop offset="0.79745" stopColor="#B6BF56" />
            <stop offset="1" stopColor="#989C46" />
          </linearGradient>
        </defs>
      </svg>
    </span>
  )
}
