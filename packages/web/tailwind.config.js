/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        discord: {
          'bg-primary': '#313338',
          'bg-secondary': '#2b2d31',
          'bg-tertiary': '#1e1f22',
          'bg-user-area': '#232428',
          'bg-floating': '#111214',
          'bg-overlay': 'rgba(0, 0, 0, 0.85)',
          'bg-input': '#383a40',
          'bg-accent': '#404249',
          'text-primary': '#f2f3f5',
          'text-normal': '#dbdee1',
          'text-secondary': '#b5bac1',
          'text-muted': '#949ba4',
          'text-link': '#00a8fc',
          'text-positive': '#23a559',
          'text-warning': '#f0b232',
          'text-danger': '#fa777c',
          'blurple': '#5865f2',
          'blurple-hover': '#4752c4',
          'green': '#23a559',
          'yellow': '#f0b232',
          'red': '#da373c',
          'red-hover': '#a12d31',
          'modifier-hover': '#35373c',
          'modifier-active': '#3b3d42',
          'modifier-selected': '#404249',
          'modifier-accent': 'hsla(0, 0%, 100%, 0.06)',
        },
      },
      boxShadow: {
        'header': '0 1px 0 rgba(4, 4, 5, 0.2), 0 1.5px 0 rgba(6, 6, 7, 0.05), 0 2px 0 rgba(4, 4, 5, 0.05)',
        'elevation-low': '0 1px 0 rgba(4, 4, 5, 0.2), 0 1.5px 0 rgba(6, 6, 7, 0.05), 0 2px 0 rgba(4, 4, 5, 0.05)',
        'elevation-high': '0 8px 16px rgba(0, 0, 0, 0.24)',
      },
      fontFamily: {
        sans: ['"gg sans"', 'Inter', 'Noto Sans', 'Helvetica Neue', 'Helvetica', 'Arial', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
