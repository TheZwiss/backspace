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
          'bg-members': '#232428',
          'bg-hover': '#35373c',
          'bg-active': '#404249',
          'bg-input': '#383a40',
          'text-primary': '#f2f3f5',
          'text-secondary': '#b5bac1',
          'text-muted': '#949ba4',
          'blurple': '#5865f2',
          'blurple-hover': '#4752c4',
          'green': '#23a559',
          'yellow': '#f0b232',
          'red': '#da373c',
          'red-hover': '#a12d31',
        },
      },
      fontFamily: {
        sans: ['gg sans', 'Noto Sans', 'Helvetica Neue', 'Helvetica', 'Arial', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
