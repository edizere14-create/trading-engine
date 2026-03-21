/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{js,ts,jsx,tsx}',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        mono: ['"JetBrains Mono"', '"Fira Code"', 'Consolas', 'monospace'],
      },
      colors: {
        terminal: {
          bg: '#0a0a0a',
          surface: '#111111',
          border: '#1a1a1a',
          green: '#00ff41',
          red: '#ff3333',
          yellow: '#ffcc00',
          cyan: '#00ccff',
          dim: '#555555',
          text: '#cccccc',
        },
      },
    },
  },
  plugins: [],
};
