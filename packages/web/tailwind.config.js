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
        surface: {
          base:     'var(--bg-base)',
          channel:  'var(--bg-channel)',
          chat:     'var(--bg-chat)',
          members:  'var(--bg-members)',
          elevated: 'var(--bg-elevated)',
          input:    'var(--bg-input)',
          overlay:  'var(--bg-overlay)',
        },
        border: {
          hard: 'var(--border-hard)',
          soft: 'var(--border-soft)',
        },
        accent: {
          mint:            'var(--accent-mint)',
          peach:           'var(--accent-peach)',
          lavender:        'var(--accent-lavender)',
          sky:             'var(--accent-sky)',
          amber:           'var(--accent-amber)',
          rose:            'var(--accent-rose)',
          coral:           'var(--accent-coral)',
          primary:         'var(--accent-primary)',
          'primary-hover': 'var(--accent-primary-hover)',
          'primary-active':'var(--accent-primary-active)',
        },
        txt: {
          primary:   'var(--text-primary)',
          secondary: 'var(--text-secondary)',
          tertiary:  'var(--text-tertiary)',
          message:   'var(--text-message)',
          link:      'var(--text-link)',
          positive:  'var(--text-positive)',
          warning:   'var(--text-warning)',
          danger:    'var(--text-danger)',
        },
        interactive: {
          hover:    'var(--interactive-hover)',
          active:   'var(--interactive-active)',
          selected: 'var(--interactive-selected)',
          muted:    'var(--interactive-muted)',
        },
        status: {
          online:  'var(--status-online)',
          idle:    'var(--status-idle)',
          dnd:     'var(--status-dnd)',
          offline: 'var(--status-offline)',
        },
        glass: {
          bg:        'var(--glass-bg)',
          border:    'var(--glass-border)',
          highlight: 'var(--glass-highlight)',
        },
        notification: 'var(--notification)',
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
