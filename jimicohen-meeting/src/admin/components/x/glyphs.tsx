/**
 * Tiny line drawings for the design editor's option tiles (layout, calendar, time list, cards).
 * They use currentColor at a few opacities, so they follow the dashboard's light and dark palettes.
 */
import type { ReactNode } from 'react';
import type { Theme } from '../../../../shared/types';

const W = 64;
const H = 44;

function Frame({ children }: { children: ReactNode }) {
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} fill="none" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

const soft = { fill: 'currentColor', opacity: 0.16 } as const;
const mid = { fill: 'currentColor', opacity: 0.38 } as const;
const strong = { fill: 'currentColor', opacity: 0.9 } as const;

function MiniGrid({ x, y, cols = 5, rows = 3, size = 5, gap = 2.5 }: { x: number; y: number; cols?: number; rows?: number; size?: number; gap?: number }) {
  const cells = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const on = r === 1 && c === 2;
      cells.push(<rect key={`${r}-${c}`} x={x + c * (size + gap)} y={y + r * (size + gap)} width={size} height={size} rx={1.4} {...(on ? strong : soft)} />);
    }
  }
  return <>{cells}</>;
}

export function LayoutGlyph({ value }: { value: Theme['layout'] }) {
  if (value === 'split') {
    return (
      <Frame>
        <rect x={1} y={1} width={62} height={42} rx={5} stroke="currentColor" strokeOpacity={0.3} />
        <rect x={7} y={9} width={6} height={6} rx={3} {...mid} />
        <rect x={7} y={19} width={15} height={3} rx={1.5} {...strong} />
        <rect x={7} y={25} width={12} height={2} rx={1} {...soft} />
        <rect x={7} y={29} width={10} height={2} rx={1} {...soft} />
        <line x1={26.5} y1={6} x2={26.5} y2={38} stroke="currentColor" strokeOpacity={0.2} />
        <MiniGrid x={31} y={11} cols={4} rows={3} />
      </Frame>
    );
  }
  if (value === 'stacked') {
    return (
      <Frame>
        <rect x={1} y={1} width={62} height={42} rx={5} stroke="currentColor" strokeOpacity={0.3} />
        <rect x={7} y={7} width={5} height={5} rx={2.5} {...mid} />
        <rect x={15} y={7} width={20} height={3} rx={1.5} {...strong} />
        <rect x={15} y={12} width={14} height={2} rx={1} {...soft} />
        <line x1={6} y1={18.5} x2={58} y2={18.5} stroke="currentColor" strokeOpacity={0.2} />
        <MiniGrid x={7} y={23} cols={7} rows={2} size={5} gap={2.4} />
      </Frame>
    );
  }
  return (
    <Frame>
      <rect x={13} y={1} width={38} height={42} rx={5} stroke="currentColor" strokeOpacity={0.3} />
      <rect x={29} y={6} width={6} height={6} rx={3} {...mid} />
      <rect x={23} y={15} width={18} height={3} rx={1.5} {...strong} />
      <rect x={26} y={20} width={12} height={2} rx={1} {...soft} />
      <MiniGrid x={19} y={26} cols={4} rows={2} size={5} gap={2.2} />
    </Frame>
  );
}

export function CalendarGlyph({ value }: { value: Theme['calendarStyle'] }) {
  const cols = 6;
  const rows = 3;
  const cells = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = 5 + c * 9.4;
      const y = 7 + r * 11;
      const on = r === 1 && c === 3;
      const free = (r + c) % 2 === 0 || on;
      if (value === 'grid') {
        cells.push(
          <g key={`${r}-${c}`}>
            <rect x={x} y={y} width={8} height={9} rx={1.6} stroke="currentColor" strokeOpacity={on ? 0 : 0.28} {...(on ? strong : { fill: 'none' })} />
            <rect x={x + 2.5} y={y + 3.5} width={3} height={2} rx={1} fill="currentColor" opacity={on ? 0 : free ? 0.6 : 0.2} />
          </g>,
        );
      } else if (value === 'minimal') {
        cells.push(
          <g key={`${r}-${c}`}>
            <rect x={x + 2.2} y={y + 3} width={3.6} height={2.4} rx={1.2} fill="currentColor" opacity={free ? 0.75 : 0.2} />
            {on ? <rect x={x + 1} y={y + 7.4} width={6} height={1.6} rx={0.8} {...strong} /> : null}
          </g>,
        );
      } else {
        cells.push(
          <circle key={`${r}-${c}`} cx={x + 4} cy={y + 4.5} r={4} fill="currentColor" opacity={on ? 0.9 : free ? 0.22 : 0.07} />,
        );
      }
    }
  }
  return <Frame>{cells}</Frame>;
}

export function SlotGlyph({ value }: { value: Theme['slotStyle'] }) {
  if (value === 'list') {
    return (
      <Frame>
        {[0, 1, 2].map((i) => (
          <rect key={i} x={12} y={5 + i * 12} width={40} height={9} rx={3} stroke="currentColor" strokeOpacity={i === 1 ? 0 : 0.3} {...(i === 1 ? strong : { fill: 'none' })} />
        ))}
      </Frame>
    );
  }
  if (value === 'grid') {
    return (
      <Frame>
        {[0, 1, 2].map((r) =>
          [0, 1].map((c) => {
            const on = r === 0 && c === 1;
            return <rect key={`${r}-${c}`} x={8 + c * 25} y={5 + r * 12} width={23} height={9} rx={3} stroke="currentColor" strokeOpacity={on ? 0 : 0.3} {...(on ? strong : { fill: 'none' })} />;
          }),
        )}
      </Frame>
    );
  }
  const chips = [
    { x: 5, y: 7, w: 16 },
    { x: 24, y: 7, w: 16, on: true },
    { x: 43, y: 7, w: 16 },
    { x: 5, y: 19, w: 16 },
    { x: 24, y: 19, w: 16 },
    { x: 43, y: 19, w: 16 },
    { x: 5, y: 31, w: 16 },
    { x: 24, y: 31, w: 16 },
  ];
  return (
    <Frame>
      {chips.map((c, i) => (
        <rect key={i} x={c.x} y={c.y} width={c.w} height={8} rx={4} {...(c.on ? strong : soft)} />
      ))}
    </Frame>
  );
}

export function CardGlyph({ value }: { value: Theme['cardStyle'] }) {
  const lines = (
    <>
      <rect x={18} y={13} width={16} height={3} rx={1.5} {...strong} />
      <rect x={18} y={20} width={28} height={2} rx={1} {...mid} />
      <rect x={18} y={25} width={22} height={2} rx={1} {...mid} />
    </>
  );
  if (value === 'flat') {
    return (
      <Frame>
        <rect x={11} y={6} width={42} height={32} rx={5} {...soft} />
        {lines}
      </Frame>
    );
  }
  if (value === 'bordered') {
    return (
      <Frame>
        <rect x={11} y={6} width={42} height={32} rx={5} stroke="currentColor" strokeOpacity={0.55} strokeWidth={1.2} />
        {lines}
      </Frame>
    );
  }
  if (value === 'elevated') {
    return (
      <Frame>
        <rect x={13} y={10} width={42} height={32} rx={5} fill="currentColor" opacity={0.2} />
        <rect x={11} y={6} width={42} height={32} rx={5} fill="var(--a-surface)" stroke="currentColor" strokeOpacity={0.18} />
        {lines}
      </Frame>
    );
  }
  return (
    <Frame>
      <circle cx={18} cy={12} r={10} fill="currentColor" opacity={0.3} />
      <circle cx={50} cy={34} r={8} fill="currentColor" opacity={0.2} />
      <rect x={11} y={6} width={42} height={32} rx={5} fill="var(--a-surface)" fillOpacity={0.55} stroke="currentColor" strokeOpacity={0.35} />
      {lines}
    </Frame>
  );
}
