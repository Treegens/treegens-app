import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from './Button';
import type { ButtonSize, ButtonVariant } from './Button';
import { IconButton } from './IconButton';
import { copyText } from './util';

export interface CopyButtonProps {
  /** the text placed on the clipboard */
  value: string;
  label?: string;
  copiedLabel?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** square icon button with the label as its accessible name */
  iconOnly?: boolean;
  block?: boolean;
  disabled?: boolean;
  onCopied?: () => void;
  className?: string;
}

/** Copies a link or snippet and confirms it in place for a moment. */
export function CopyButton({ value, label = 'Copy', copiedLabel = 'Copied', variant = 'secondary', size = 'md', iconOnly = false, block, disabled, onCopied, className }: CopyButtonProps) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<number>();

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = async () => {
    const ok = await copyText(value);
    setState(ok ? 'copied' : 'failed');
    if (ok) onCopied?.();
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), 1800);
  };

  const copied = state === 'copied';
  const text = copied ? copiedLabel : state === 'failed' ? 'Press Ctrl+C to copy' : label;
  const icon = copied ? <Check size={16} /> : <Copy size={16} />;

  return (
    <>
      {iconOnly ? (
        <IconButton
          label={text}
          icon={icon}
          variant={variant === 'primary' ? 'primary' : variant === 'secondary' ? 'secondary' : 'ghost'}
          size={size}
          disabled={disabled}
          onClick={copy}
          className={className}
        />
      ) : (
        <Button variant={variant} size={size} block={block} disabled={disabled} iconLeft={icon} onClick={copy} className={className}>
          {text}
        </Button>
      )}
      <span className="u-vh" role="status">
        {copied ? copiedLabel : ''}
      </span>
    </>
  );
}
