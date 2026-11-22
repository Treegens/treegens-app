/** @type {import('next').NextConfig} */
export default {
  // Lets several dev servers run side by side on one checkout (each with its own NEXT_DIST_DIR).
  distDir: process.env.NEXT_DIST_DIR || '.next',
  serverExternalPackages: ['pdf-lib', '@pdf-lib/fontkit', 'nodemailer', 'pdfjs-dist'],
  poweredByHeader: false,
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'same-origin' },
        { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
      ],
    }, {
      // Click-to-agree terms are made to be shown in a frame on a customer's own website (public/clickwrap.js). A
      // browser that sees frame-ancestors ignores X-Frame-Options, so only these pages may be framed, by any site, and
      // only with ?embed=1: the page then records the acceptance as made through a frame. Without it a page framed
      // elsewhere would be recorded as our own page, so it may not be framed at all (the rule below).
      // What a frame can and cannot guarantee is said in src/lib/clickwrap.ts (EMBED_CAN, EMBED_CANNOT).
      source: '/agree/:path*',
      has: [{ type: 'query', key: 'embed', value: '1' }],
      headers: [{ key: 'Content-Security-Policy', value: 'frame-ancestors *' }],
    }, {
      source: '/agree/:path*',
      missing: [{ type: 'query', key: 'embed', value: '1' }],
      headers: [{ key: 'Content-Security-Policy', value: "frame-ancestors 'self'" }],
    }];
  },
};
