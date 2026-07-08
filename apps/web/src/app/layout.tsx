import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'ESFL — Esport Fantasy League',
  description: 'Fantasy league esport multigaming : CS2, Valorant, LoL, Rocket League.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
