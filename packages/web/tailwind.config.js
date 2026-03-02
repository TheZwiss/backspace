/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        // ── AETHER DRIFT TOKENS ──
        // RGB-channel variables enable Tailwind opacity modifiers (e.g. bg-accent-rose/10)
        surface: {
          base:     'rgb(var(--bg-base) / <alpha-value>)',
          channel:  'rgb(var(--bg-channel) / <alpha-value>)',
          chat:     'rgb(var(--bg-chat) / <alpha-value>)',
          members:  'rgb(var(--bg-members) / <alpha-value>)',
          elevated: 'rgb(var(--bg-elevated) / <alpha-value>)',
          input:    'rgb(var(--bg-input) / <alpha-value>)',
          overlay:  'var(--bg-overlay)',
        },
        border: {
          hard: 'rgb(var(--border-hard) / <alpha-value>)',
          soft: 'rgb(var(--border-soft) / <alpha-value>)',
        },
        accent: {
          mint:            'rgb(var(--accent-mint) / <alpha-value>)',
          peach:           'rgb(var(--accent-peach) / <alpha-value>)',
          lavender:        'rgb(var(--accent-lavender) / <alpha-value>)',
          sky:             'rgb(var(--accent-sky) / <alpha-value>)',
          amber:           'rgb(var(--accent-amber) / <alpha-value>)',
          rose:            'rgb(var(--accent-rose) / <alpha-value>)',
          coral:           'rgb(var(--accent-coral) / <alpha-value>)',
          primary:         'rgb(var(--accent-primary) / <alpha-value>)',
          'primary-hover': 'rgb(var(--accent-primary-hover) / <alpha-value>)',
          'primary-active':'rgb(var(--accent-primary-active) / <alpha-value>)',
        },
        txt: {
          primary:   'rgb(var(--text-primary) / <alpha-value>)',
          secondary: 'rgb(var(--text-secondary) / <alpha-value>)',
          tertiary:  'rgb(var(--text-tertiary) / <alpha-value>)',
          message:   'rgb(var(--text-message) / <alpha-value>)',
          link:      'rgb(var(--text-link) / <alpha-value>)',
          positive:  'rgb(var(--text-positive) / <alpha-value>)',
          warning:   'rgb(var(--text-warning) / <alpha-value>)',
          danger:    'rgb(var(--text-danger) / <alpha-value>)',
        },
        interactive: {
          hover:    'var(--interactive-hover)',
          active:   'var(--interactive-active)',
          selected: 'var(--interactive-selected)',
          muted:    'rgb(var(--interactive-muted) / <alpha-value>)',
        },
        status: {
          online:  'rgb(var(--status-online) / <alpha-value>)',
          idle:    'rgb(var(--status-idle) / <alpha-value>)',
          dnd:     'rgb(var(--status-dnd) / <alpha-value>)',
          offline: 'rgb(var(--status-offline) / <alpha-value>)',
        },
        glass: {
          bg:        'var(--glass-bg)',
          border:    'var(--glass-border)',
          highlight: 'var(--glass-highlight)',
        },
        notification: 'rgb(var(--notification) / <alpha-value>)',
      },
      boxShadow: {
        'header': '0 1px 0 rgba(4, 4, 5, 0.2), 0 1.5px 0 rgba(6, 6, 7, 0.05), 0 2px 0 rgba(4, 4, 5, 0.05)',
        'elevation-low': '0 1px 0 rgba(4, 4, 5, 0.2), 0 1.5px 0 rgba(6, 6, 7, 0.05), 0 2px 0 rgba(4, 4, 5, 0.05)',
        'elevation-high': '0 8px 16px rgba(0, 0, 0, 0.24)',
        'glass': '0 2px 8px rgba(0,0,0,0.25), 0 8px 24px rgba(0,0,0,0.15), inset 0 1px 0 var(--glass-highlight)',
      },
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
