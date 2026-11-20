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
      // browser that sees frame-ancestors ignores X-Frame-Options, so only these pages may be framed, by any site.
      // What a frame can and cannot guarantee is said in src/lib/clickwrap.ts (EMBED_CAN, EMBED_CANNOT).
      source: '/agree/:path*',
      headers: [{ key: 'Content-Security-Policy', value: 'frame-ancestors *' }],
    }];
  },
};
