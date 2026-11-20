/** @type {import('next').NextConfig} */
export default {
  serverExternalPackages: ['pdf-lib', '@pdf-lib/fontkit', 'nodemailer'],
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
