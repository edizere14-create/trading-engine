/** @type {import('next').NextConfig} */
const externalPackages = ['better-sqlite3'];
const nextMajor = Number.parseInt(require('next/package.json').version.split('.')[0], 10);

const nextConfig = nextMajor >= 15
  ? { serverExternalPackages: externalPackages }
  : {
    experimental: {
      serverComponentsExternalPackages: externalPackages,
    },
  };

module.exports = nextConfig;
