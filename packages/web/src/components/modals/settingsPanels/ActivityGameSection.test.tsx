import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../../../hooks/useWebSocket', () => ({ wsSendAll: vi.fn() }));
vi.mock('../../../api/client', () => ({ api: { gameIcons: { upload: vi.fn() } } }));

import { ActivityGameSection } from './ActivityGameSection';
import { useActivityStore } from '../../../stores/activityStore';

const setBindings = vi.fn(() => Promise.resolve());

function installDesktop(extra: Record<string, unknown> = {}) {
  (window as unknown as { backspace: unknown }).backspace = {
    listRunningPrograms: () => Promise.resolve([
      { label: 'Weird Game', process: 'Weird Game.exe' },
      { label: 'mygame', process: 'mygame' },
    ]),
    setManualGameBindings: setBindings,
    ...extra,
  };
}

const NAME_INPUT = 'Created manually';

beforeEach(() => {
  localStorage.clear();
  useActivityStore.getState().reset();
  setBindings.mockClear();
});
afterEach(() => {
  delete (window as unknown as { backspace?: unknown }).backspace;
});

describe('manual games on the desktop', () => {
  it('ties a game to the program picked from the running ones', async () => {
    installDesktop();
    render(<ActivityGameSection />);
    const select = await screen.findByLabelText('Program');
    await waitFor(() => expect(screen.getByRole('option', { name: 'Weird Game' })).toBeInTheDocument());

    const add = screen.getByRole('button', { name: 'Add' });
    expect(add).toBeDisabled(); // no program yet

    fireEvent.change(select, { target: { value: 'Weird Game.exe' } });
    expect(screen.getByLabelText(NAME_INPUT)).toHaveValue('Weird Game'); // the name defaults to the program
    fireEvent.change(screen.getByLabelText(NAME_INPUT), { target: { value: 'Weird' } });
    fireEvent.click(add);

    expect(setBindings).toHaveBeenCalledWith([{ name: 'Weird', process: 'Weird Game.exe' }]);
    expect(useActivityStore.getState().manualGames).toEqual([{ name: 'Weird', process: 'Weird Game.exe' }]);
    expect(screen.getByLabelText(NAME_INPUT)).toHaveValue(''); // ready for the next one
  });

  it('holds several games, each shown with its state, and removes one', () => {
    installDesktop();
    useActivityStore.getState().addManualGame('Weird', 'Weird Game.exe');
    useActivityStore.getState().addManualGame('Other', 'other.exe');
    useActivityStore.setState({ detectedActivities: [{ type: 'playing', name: 'Weird' }] });
    render(<ActivityGameSection />);
    expect(screen.getByLabelText('Name of Weird')).toHaveValue('Weird');
    expect(screen.getByText('running')).toBeInTheDocument();
    expect(screen.getByText('waiting for other.exe')).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0] as HTMLElement);
    expect(useActivityStore.getState().manualGames.map((g) => g.name)).toEqual(['Other']);
  });

  it('has no suggestion menu on the name field', () => {
    installDesktop();
    const { container } = render(<ActivityGameSection />);
    expect(screen.getByLabelText(NAME_INPUT)).not.toHaveAttribute('list');
    expect(container.querySelectorAll('datalist')).toHaveLength(0);
  });
});

describe('manual games in a browser', () => {
  it('takes just a name', () => {
    render(<ActivityGameSection />);
    expect(screen.queryByLabelText('Program')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(NAME_INPUT), { target: { value: 'Hades' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(useActivityStore.getState().manualGames).toEqual([{ name: 'Hades', process: null }]);
  });
});

describe('unrecognized Wine programs', () => {
  it('offers each one and adds it to the games with one click', async () => {
    installDesktop({ getUnknownWinePrograms: () => Promise.resolve([{ label: 'Mystery', process: 'Mystery.exe' }]) });
    render(<ActivityGameSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add to my games' }));
    expect(setBindings).toHaveBeenCalledWith([{ name: 'Mystery', process: 'Mystery.exe' }]);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Add to my games' })).not.toBeInTheDocument());
  });

  it('shows nothing when the desktop does not report any', async () => {
    installDesktop();
    render(<ActivityGameSection />);
    await screen.findByLabelText('Program');
    expect(screen.queryByText('Unrecognized Wine programs')).not.toBeInTheDocument();
  });
});

describe('your games: hide and order', () => {
  const games = [
    { type: 'playing', name: 'Game A' },
    { type: 'playing', name: 'Game B' },
    { type: 'playing', name: 'Game C' },
  ];
  const rowNames = () => screen.getAllByRole('listitem').map((li) => li.textContent ?? '');

  it('lists every detected game and moves one up or down', () => {
    useActivityStore.setState({ detectedActivities: games });
    render(<ActivityGameSection />);
    expect(screen.getByRole('button', { name: 'Move Game A up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Game C down' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Move Game C up' }));
    expect(useActivityStore.getState().gameOrder).toEqual(['game a', 'game c', 'game b']);
    expect(rowNames()[1]).toContain('Game C');

    fireEvent.click(screen.getByRole('button', { name: 'Move Game C up' }));
    expect(useActivityStore.getState().gameOrder).toEqual(['game c', 'game a', 'game b']);
  });

  it('hides a game and shows it again, also when it is no longer running', () => {
    useActivityStore.setState({ detectedActivities: games });
    render(<ActivityGameSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide Game B' }));
    expect(useActivityStore.getState().hiddenGames).toEqual(['game b']);

    act(() => useActivityStore.setState({ detectedActivities: [] }));
    fireEvent.click(screen.getByRole('button', { name: 'Show game b' }));
    expect(useActivityStore.getState().hiddenGames).toEqual([]);
  });
});

describe('renaming a detected game', () => {
  it('has no suggestion menu, and Clear brings the detected name back', () => {
    useActivityStore.setState({ detectedActivities: [{ type: 'playing', name: 'Stardew Valley' }] });
    render(<ActivityGameSection />);
    const input = screen.getByLabelText('Show Stardew Valley as');
    expect(input).not.toHaveAttribute('list');
    expect(screen.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: 'Farm' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set' }));
    expect(useActivityStore.getState().gameRenames).toEqual({ 'stardew valley': 'Farm' });

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(useActivityStore.getState().gameRenames).toEqual({});
    expect(screen.getByLabelText('Show Stardew Valley as')).toHaveValue('');
  });
});

describe('renaming a manual game', () => {
  it('renames it in place, keeping the program, and ignores a colliding name', () => {
    installDesktop();
    useActivityStore.getState().addManualGame('Weird', 'Weird Game.exe');
    useActivityStore.getState().addManualGame('Other', 'other.exe');
    setBindings.mockClear();
    render(<ActivityGameSection />);

    const input = screen.getByLabelText('Name of Weird');
    const save = input.closest('form')?.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(save).toBeDisabled(); // nothing changed yet

    fireEvent.change(input, { target: { value: 'Other' } }); // taken
    fireEvent.click(save);
    expect(useActivityStore.getState().manualGames.map((g) => g.name)).toEqual(['Weird', 'Other']);

    fireEvent.change(input, { target: { value: 'Renamed' } });
    fireEvent.click(save);
    expect(useActivityStore.getState().manualGames).toEqual([
      { name: 'Renamed', process: 'Weird Game.exe' },
      { name: 'Other', process: 'other.exe' },
    ]);
    expect(setBindings).toHaveBeenCalledWith([
      { name: 'Renamed', process: 'Weird Game.exe' },
      { name: 'Other', process: 'other.exe' },
    ]);
  });
});

describe('your games: drag to reorder', () => {
  const games = [
    { type: 'playing', name: 'Game A' },
    { type: 'playing', name: 'Game B' },
    { type: 'playing', name: 'Game C' },
  ];
  const dataTransfer = () => ({ setData: vi.fn(), setDragImage: vi.fn(), effectAllowed: '', dropEffect: '' });
  const handleOf = (name: string) => screen.getByLabelText(`Drag ${name} to change its priority`);
  const rowOf = (name: string) => handleOf(name).closest('li') as HTMLElement;

  /** jsdom has no layout: rows are 30px tall, stacked from the top. */
  function layOut() {
    ['Game A', 'Game B', 'Game C'].forEach((name, i) => {
      rowOf(name).getBoundingClientRect = () => ({ top: i * 30, height: 30, bottom: i * 30 + 30, left: 0, right: 100, width: 100, x: 0, y: i * 30, toJSON: () => ({}) });
    });
  }

  /** jsdom's drag events carry no coordinates: build them by hand. */
  function pointer(type: 'dragover' | 'drop', clientY: number) {
    const event = Object.assign(new Event(type, { bubbles: true, cancelable: true }), { clientY, dataTransfer: dataTransfer() });
    act(() => { document.body.dispatchEvent(event); });
  }

  function grab(name: string) {
    fireEvent.mouseDown(handleOf(name));
    fireEvent.dragStart(rowOf(name), { dataTransfer: dataTransfer() });
  }

  it('pulls a game up to wherever the pointer is, even far above the list', () => {
    useActivityStore.setState({ detectedActivities: games });
    render(<ActivityGameSection />);
    layOut();
    grab('Game C');
    pointer('dragover', -200);
    pointer('drop', -200);
    expect(useActivityStore.getState().gameOrder).toEqual(['game c', 'game a', 'game b']);
  });

  it('pulls a game down to the end from far below the list', () => {
    useActivityStore.setState({ detectedActivities: games });
    render(<ActivityGameSection />);
    layOut();
    grab('Game A');
    pointer('dragover', 900);
    pointer('drop', 900);
    expect(useActivityStore.getState().gameOrder).toEqual(['game b', 'game c', 'game a']);
  });

  it('lands the game at the last place over when only dragend arrives', () => {
    useActivityStore.setState({ detectedActivities: games });
    render(<ActivityGameSection />);
    layOut();
    grab('Game C');
    pointer('dragover', 35);
    fireEvent.dragEnd(rowOf('Game C'), { dataTransfer: { ...dataTransfer(), dropEffect: 'move' } });
    expect(useActivityStore.getState().gameOrder).toEqual(['game a', 'game c', 'game b']);
  });

  it('does not start a drag that was not grabbed by the handle', () => {
    useActivityStore.setState({ detectedActivities: games });
    render(<ActivityGameSection />);
    layOut();
    fireEvent.dragStart(rowOf('Game C'), { dataTransfer: dataTransfer() });
    pointer('dragover', 0);
    pointer('drop', 0);
    expect(useActivityStore.getState().gameOrder).toEqual([]);
  });

  it('does nothing when the drag is cancelled', () => {
    useActivityStore.setState({ detectedActivities: games });
    render(<ActivityGameSection />);
    layOut();
    grab('Game C');
    pointer('dragover', 0);
    fireEvent.dragEnd(rowOf('Game C'), { dataTransfer: { ...dataTransfer(), dropEffect: 'none' } });
    expect(useActivityStore.getState().gameOrder).toEqual([]);
  });
});

describe('removing a hidden manual game', () => {
  it('leaves no row behind to show again', () => {
    useActivityStore.getState().addManualGame('Hades');
    useActivityStore.getState().setGameHidden('Hades', true);
    render(<ActivityGameSection />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0] as HTMLElement);
    expect(screen.queryByRole('button', { name: /^Show/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Drag Hades/)).not.toBeInTheDocument();
  });
});

describe('removing a hidden manual game tied to a running program', () => {
  it('drops the row at once, with no Show button left', () => {
    installDesktop();
    useActivityStore.getState().addManualGame('synochat', 'synochat');
    useActivityStore.getState().setGameHidden('synochat', true);
    useActivityStore.setState({ detectedActivities: [{ type: 'playing', name: 'synochat' }] });
    render(<ActivityGameSection />);
    expect(screen.getByRole('button', { name: 'Show synochat' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.queryByRole('button', { name: /^Show/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/synochat/)).not.toBeInTheDocument();
  });
});
