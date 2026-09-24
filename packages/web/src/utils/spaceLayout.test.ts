import { describe, it, expect } from 'vitest';
import type { SpaceFolder } from '@backspace/shared';
import type { TaggedSpace } from '../stores/spaceStore';
import { resolveSpaceLayout, spacesInLayoutOrder } from './spaceLayout';

function space(id: string): TaggedSpace {
  return {
    id,
    name: id,
    icon: null,
    banner: null,
    avatarColor: null,
    ownerId: 'u',
    inviteCode: null,
    visibility: 'public',
    directoryListed: false,
    description: null,
    createdAt: 1,
    _instanceOrigin: '',
  };
}

function folder(id: string, spaceIds: string[]): SpaceFolder {
  return { id, userId: 'u', name: id, color: null, position: 0, spaceIds };
}

const ids = (spaces: TaggedSpace[]): string[] => spaces.map((s) => s.id);

describe('resolveSpaceLayout', () => {
  it('keeps store order when no layout is stored', () => {
    const layout = resolveSpaceLayout([space('a'), space('b')], null, []);
    expect(ids(spacesInLayoutOrder(layout))).toEqual(['a', 'b']);
  });

  it('follows the stored layout, folders in place, and appends spaces it does not mention', () => {
    const layout = resolveSpaceLayout(
      [space('a'), space('b'), space('c'), space('d')],
      [{ t: 's', id: 'c' }, { t: 'f', id: 'f1' }],
      [folder('f1', ['b', 'a'])],
    );
    expect(layout.map((item) => item.type)).toEqual(['space', 'folder', 'space']);
    expect(ids(spacesInLayoutOrder(layout))).toEqual(['c', 'b', 'a', 'd']);
  });

  it('drops entries whose space or folder is gone, and folders left empty', () => {
    const layout = resolveSpaceLayout(
      [space('a')],
      [{ t: 's', id: 'gone' }, { t: 'f', id: 'missing' }, { t: 'f', id: 'empty' }, { t: 's', id: 'a' }],
      [folder('empty', ['gone'])],
    );
    expect(layout).toEqual([{ type: 'space', space: space('a') }]);
  });
});
