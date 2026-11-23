import type { MetadataRoute } from 'next';
import { webManifest } from '../lib/site.ts'; // relative, so tests/brand.test.ts can load this file under plain Node

// The web app manifest at /manifest.webmanifest, so a phone can add GrowSigning to its home screen with the brand icon
// (192, 512, and the maskable 512 that Android crops to a circle). The one manifest of the app: there is no
// public/manifest.webmanifest. Its contents are in src/lib/site.ts, where tests/brand.test.ts reads them.
export default function manifest(): MetadataRoute.Manifest {
  return webManifest();
}
