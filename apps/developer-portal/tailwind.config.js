/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './{src,app}/**/*.{ts,tsx,js,jsx,html}',
    '!./{src,app}/**/*.{stories,spec}.{ts,tsx,js,jsx,html}',
  ],
  theme: { extend: {} },
  plugins: [],
};
