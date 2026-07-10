import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@esfl/contracts'],
  // `next build` écrit dans un dossier séparé : un build de vérification
  // lancé pendant que `next dev` tourne ne corrompt plus son cache
  // (« Cannot find module ./vendor-chunks/… »). `next start` lit le même
  // distDir en production, Vercel gère.
  distDir: process.env.NODE_ENV === 'production' ? '.next-build' : '.next',
};

export default nextConfig;
