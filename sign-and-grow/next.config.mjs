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
    }];
  },
};
