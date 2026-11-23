'use client';
// The slug of a public form when its page is not at /f/<slug>: a share link (growsigning.com/<name>) draws the same
// form page and says here which form it is. Empty at /f/<slug>, where the address says it.
import { createContext } from 'react';

export const FormSlug = createContext('');
