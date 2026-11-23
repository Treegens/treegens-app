'use client';
// A public form opened by its share link (growsigning.com/<name>): the same form as /f/<slug>, drawn by the same
// page, which is told its slug here instead of reading it from the address.
import { FormSlug } from '@/lib/formslug';
import PowerForm from '@/app/f/[slug]/page';

export function ShareForm({ slug }: { slug: string }) {
  return <FormSlug.Provider value={slug}><PowerForm /></FormSlug.Provider>;
}
