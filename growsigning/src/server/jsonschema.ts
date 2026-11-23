// A small JSON Schema (2020-12) checker for the keywords docs/schema/*.json use: type, const, enum, required,
// properties, items, pattern, minimum and local $ref. Enough to check a full export before it is written and before
// it is brought in, without a dependency. A keyword it does not know is ignored, so the schema says what it checks.
import fs from 'node:fs';
import path from 'node:path';

type Schema = Record<string, any>;

const typeOf = (v: any): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : typeof v);
const fits = (want: string, got: string) => want === got || (want === 'number' && got === 'integer');

/** Every place `value` breaks `schema`, as "path: what is wrong". Stops after `max` problems. */
export function checkSchema(schema: Schema, value: any, max = 20): string[] {
  const out: string[] = [];
  const resolve = (s: Schema): Schema => {
    if (typeof s?.$ref !== 'string') return s;
    const m = /^#\/\$defs\/([\w-]+)$/.exec(s.$ref);
    if (!m || !schema.$defs?.[m[1]]) throw new Error(`The schema points at ${s.$ref}, which it does not define.`);
    return resolve(schema.$defs[m[1]]);
  };
  const walk = (s0: Schema, v: any, at: string) => {
    if (out.length >= max) return;
    const s = resolve(s0);
    const got = typeOf(v);
    if (s.type) {
      const want = Array.isArray(s.type) ? s.type : [s.type];
      if (!want.some((t: string) => fits(t, got))) return void out.push(`${at || '(top)'}: is ${got}, and should be ${want.join(' or ')}`);
    }
    if ('const' in s && v !== s.const) out.push(`${at || '(top)'}: should be ${JSON.stringify(s.const)}`);
    if (Array.isArray(s.enum) && !s.enum.includes(v)) out.push(`${at || '(top)'}: "${String(v).slice(0, 40)}" is not one of ${s.enum.join(', ')}`);
    if (typeof s.pattern === 'string' && got === 'string' && !new RegExp(s.pattern).test(v)) out.push(`${at}: "${String(v).slice(0, 40)}" does not have the expected form`);
    if (typeof s.minimum === 'number' && (got === 'integer' || got === 'number') && v < s.minimum) out.push(`${at}: ${v} is below ${s.minimum}`);
    if (got === 'object') {
      for (const k of s.required || []) if (!(k in v)) out.push(`${at ? `${at}.` : ''}${k}: is missing`);
      for (const [k, sub] of Object.entries(s.properties || {})) if (k in v) walk(sub as Schema, v[k], at ? `${at}.${k}` : k);
    }
    if (got === 'array' && s.items) v.forEach((x: any, i: number) => walk(s.items, x, `${at}[${i}]`));
  };
  walk(schema, value, '');
  return out;
}

let cached: Schema | null = null;
/** The schema of a full export, read once from docs/schema (shipped next to the app, see the Dockerfile). */
export function exportSchema(): Schema {
  if (!cached) cached = JSON.parse(fs.readFileSync(path.resolve(/* turbopackIgnore: true */ process.cwd(), 'docs/schema/growsigning-export-v1.schema.json'), 'utf8'));
  return cached!;
}
