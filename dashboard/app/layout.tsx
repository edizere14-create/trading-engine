import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'EDDYI Trading Engine',
  description: 'Solana memecoin trading engine dashboard',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-terminal-bg antialiased">
        {children}
      </body>
    </html>
  );
}
