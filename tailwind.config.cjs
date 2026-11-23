/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [__dirname + "/apps/admin/**/*.{html,tsx,ts}"],
  theme: { extend: { colors: { brand: { DEFAULT: "#4c2b7b", dark: "#3a1f60", accent: "#f47421" } } } },
  plugins: [],
};
