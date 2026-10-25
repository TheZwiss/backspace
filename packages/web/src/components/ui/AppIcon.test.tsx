import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppIcon, getAppIconKey } from './AppIcon';

describe('AppIcon', () => {
  describe('getAppIconKey', () => {
    it('normalizes League of Legends variants', () => {
      expect(getAppIconKey('League of Legends', 'playing')).toBe('leagueoflegends');
      expect(getAppIconKey('lol', 'playing')).toBe('leagueoflegends');
      expect(getAppIconKey('英雄联盟', 'playing')).toBe('leagueoflegends');
    });

    it('normalizes other games', () => {
      expect(getAppIconKey('Valorant', 'playing')).toBe('valorant');
      expect(getAppIconKey('无畏契约', 'playing')).toBe('valorant');
      expect(getAppIconKey('Counter-Strike 2', 'playing')).toBe('counterstrike');
      expect(getAppIconKey('cs2', 'playing')).toBe('counterstrike');
      expect(getAppIconKey('Dota 2', 'playing')).toBe('dota2');
    });

    it('normalizes music players and tools', () => {
      expect(getAppIconKey('OBS Studio', 'streaming')).toBe('obs');
      expect(getAppIconKey('NetEase Cloud Music', 'listening')).toBe('cloudmusic');
      expect(getAppIconKey('网易云音乐', 'listening')).toBe('cloudmusic');
      expect(getAppIconKey('Spotify', 'listening')).toBe('spotify');
    });

    it('falls back to category when unknown', () => {
      expect(getAppIconKey('Random Game', 'playing')).toBe('generic-game');
      expect(getAppIconKey('Random Music', 'listening')).toBe('generic-music');
      expect(getAppIconKey('Random Stream', 'streaming')).toBe('generic-stream');
    });
  });

  describe('rendering', () => {
    it('renders vector icon for League of Legends', () => {
      const { container } = render(<AppIcon name="League of Legends" type="playing" size={20} />);
      const svg = container.querySelector('svg');
      expect(svg).toBeInTheDocument();
      expect(svg).toHaveAttribute('fill', '#C28F2C');
      expect(svg).toHaveAttribute('width', '20');
      expect(svg).toHaveAttribute('height', '20');
    });

    it('renders vector icon for OBS Studio', () => {
      const { container } = render(<AppIcon name="OBS Studio" type="streaming" size={16} />);
      const svg = container.querySelector('svg');
      expect(svg).toBeInTheDocument();
      expect(svg).toHaveAttribute('fill', '#E0E0E6');
    });
  });
});
