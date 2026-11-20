'use client';

const svg = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true, style: { flex: 'none' } };

export const Lock = ({ size = 14 }: { size?: number }) => (
  <svg {...svg} width={size} height={size}><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>
);
export const UndoIcon = () => <svg {...svg}><path d="M9 14 4 9l5-5" /><path d="M4 9h10a6 6 0 0 1 0 12h-3" /></svg>;
export const RedoIcon = () => <svg {...svg}><path d="m15 14 5-5-5-5" /><path d="M20 9H10a6 6 0 0 0 0 12h3" /></svg>;
export const Wand = () => <svg {...svg}><path d="m4 20 11-11" /><path d="m14 6 4 4" /><path d="M18 3v3M16.5 4.5h3M6 5v2M5 6h2M19 14v2M18 15h2" /></svg>;

export function UndoRedo({ canUndo, canRedo, undo, redo, className = '' }: { canUndo: boolean; canRedo: boolean; undo: () => void; redo: () => void; className?: string }) {
  return (
    <div className={`ed-undo ${className}`} role="group" aria-label="Undo and redo">
      <button type="button" className="btn sm" disabled={!canUndo} onClick={undo} aria-label="Undo" title="Undo (Ctrl or ⌘ + Z)"><UndoIcon /><span className="ed-wide" aria-hidden="true">Undo</span></button>
      <button type="button" className="btn sm" disabled={!canRedo} onClick={redo} aria-label="Redo" title="Redo (Shift + Ctrl or ⌘ + Z)"><RedoIcon /><span className="ed-wide" aria-hidden="true">Redo</span></button>
    </div>
  );
}
