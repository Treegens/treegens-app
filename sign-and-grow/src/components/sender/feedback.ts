'use client';
import { toast } from '@/components/ui';
import { explain } from './lib';

/** Shows what went wrong as a toast, always with a next step. */
export const fail = (e: any, reassurance?: string) => toast(explain(e, reassurance), true);
