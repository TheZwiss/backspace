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
          // Backgrounds (darkest → lightest) — Discord "Dark" theme
          'bg-floating':       '#080a0b',
          'bg-tertiary':       '#111214',
          'bg-server':         '#111214',
          'bg-user-area':      '#1a1b1e',
          'bg-secondary':      '#1e1f22',
          'bg-members':        '#1e1f22',
          'bg-home':           '#1a1d20',
          'bg-hover':          '#232428',
          'bg-primary':        '#232428',
          'bg-input':          '#2b2d31',
          'bg-surface':        '#2b2d31',
          'bg-surface-higher': '#313338',
          'bg-active':         '#313338',
          'bg-accent':         '#353840',
          'bg-overlay':        'rgba(0, 0, 0, 0.90)',

          // Text
          'text-primary':   '#ffffff',
          'text-normal':    '#dcdcdf',
          'text-secondary': '#c5c6ca',
          'text-muted':     '#abacb2',
          'text-header':    '#ffffff',
          'text-link':      '#76aff6',
          'text-positive':  '#73c48b',
          'text-warning':   '#faa900',
          'text-danger':    '#ff938e',

          // Channel/Interactive
          'channels-default':  '#999aa1',
          'interactive-muted': '#4e5058',

          // Brand
          'blurple':        '#5865f2',
          'blurple-hover':  '#4452bb',
          'blurple-active': '#3a48a3',

          // Status
          'green':      '#23a55a',
          'yellow':     '#f0b232',
          'red':        '#f23f43',
          'red-hover':  '#a9232e',

          // Notification badge
          'notification': '#da3e44',

          // Modifiers (semi-transparent — works on any background)
          'modifier-hover':    'rgba(255,255,255,0.08)',
          'modifier-active':   'rgba(255,255,255,0.16)',
          'modifier-selected': 'rgba(255,255,255,0.20)',
          'modifier-accent':   'rgba(255,255,255,0.12)',
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
