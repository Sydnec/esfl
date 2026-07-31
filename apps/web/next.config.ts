import type { NextConfig } from 'next';

const isProd = process.env.NODE_ENV === 'production';
const apiOrigin = process.env.NEXT_PUBLIC_API_URL ?? '';

// En-têtes de sécurité communs à toutes les routes. Le CSP n'est posé qu'en
// production : `next dev` a besoin d'`eval` et d'un websocket HMR que ces
// directives casseraient. Le front n'appelle que l'API (`apiOrigin`) — pour le
// fetch/SSE (connect-src) et les avatars (img-src).
const securityHeaders: { key: string; value: string }[] = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

if (isProd) {
  const csp = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    `img-src 'self' data: ${apiOrigin}`.trim(),
    "font-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    // 'unsafe-inline' requis par l'hydratation Next sans nonce. Un CSP strict à
    // base de nonce est une amélioration future (nécessite un middleware).
    "script-src 'self' 'unsafe-inline'",
    `connect-src 'self' ${apiOrigin}`.trim(),
  ].join('; ');
  securityHeaders.push({ key: 'Content-Security-Policy', value: csp });
}

const nextConfig: NextConfig = {
  transpilePackages: ['@esfl/contracts'],
  // `.next-build` isole les builds de vérification LOCAUX (`next build` lancé
  // pendant que `next dev` tourne) pour ne pas corrompre le cache `.next` du dev.
  // Mais Vercel s'attend à trouver la sortie dans `.next` : on y reste donc sur
  // Vercel (comme en dev). Seul un build prod local utilise `.next-build`.
  distDir: process.env.NODE_ENV === 'production' && !process.env.VERCEL ? '.next-build' : '.next',
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
