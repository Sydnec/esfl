import type { NextConfig } from 'next';

const isProd = process.env.NODE_ENV === 'production';
const apiOrigin = process.env.NEXT_PUBLIC_API_URL ?? '';

// Sans cette variable, `connect-src` et `img-src` se referment sur 'self' et le
// front déployé ne peut plus joindre l'API — panne totale, sans erreur au build.
// Garde limitée à Vercel : `next build` force NODE_ENV=production, y compris en
// CI et en build de vérification local, où la variable n'a pas à être définie.
if (isProd && process.env.VERCEL && !apiOrigin) {
  throw new Error(
    'NEXT_PUBLIC_API_URL est requise pour le build de production (CSP connect-src/img-src).',
  );
}

// Les logos d'équipes et les photos de joueurs ne passent pas par l'API : ils
// sont hotlinkés depuis les CDN des sources d'ingestion, et le CSP doit donc les
// autoriser explicitement. Brancher une source sans ajouter son hôte ici la fait
// tomber sur le placeholder à initiales de <Avatar>, silencieusement.
const IMAGE_HOSTS = [
  // Source principale, et de loin : 1360 des 1366 images en base. Wildcard
  // délibéré — l'hôte réel est `cdn-api.pandascore.co` et non le `cdn.` qu'on
  // suppose spontanément ; il ne figure nulle part dans le code, il arrive dans
  // le champ image_url du payload Pandascore.
  'https://*.pandascore.co',
  'https://lol.fandom.com', // Leaguepedia : Special:Filepath/… redirige (302) vers wikia
  'https://*.wikia.nocookie.net', // cible de cette redirection — le CSP réévalue l'hôte après le 302
  'https://cdn.communitydragon.org', // icônes de champions LoL
  'https://owcdn.net', // logos d'équipes VALORANT (VLR)
  'https://*.vlr.gg', // icônes d'agents VALORANT (repli quand le PNG local manque)
  'https://bo3.gg',
  'https://*.bo3.gg', // logos CS2 — le wildcard CSP ne couvre pas le domaine nu
];

// En-têtes de sécurité communs à toutes les routes. Le CSP n'est posé qu'en
// production : `next dev` a besoin d'`eval` et d'un websocket HMR que ces
// directives casseraient. Corollaire : une directive trop stricte ne se voit
// qu'une fois déployée. Le front n'appelle que l'API (`apiOrigin`) pour le
// fetch/SSE (connect-src) et les avatars utilisateurs (img-src) ; les autres
// images viennent des CDN listés ci-dessus.
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
    `img-src 'self' data: ${apiOrigin} ${IMAGE_HOSTS.join(' ')}`.replace(/\s+/g, ' ').trim(),
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
