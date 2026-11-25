import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useFileDropZone } from './useFileDropZone';

function Harness({ enabled, onDrop }: { enabled: boolean; onDrop: (dt: DataTransfer) => void }) {
  const [region, setRegion] = useState<HTMLElement | null>(null);
  const dragging = useFileDropZone(region, { enabled, onDrop });
  return (
    <div data-testid="region" ref={setRegion}>
      <span data-testid="child">child</span>
      <span data-testid="state">{dragging ? 'dragging' : 'idle'}</span>
    </div>
  );
}

const files = { types: ['Files'] };
const text = { types: ['text/plain'] };

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useFileDropZone', () => {
  it('tracks a file drag over the region and clears when it leaves', () => {
    render(<Harness enabled onDrop={vi.fn()} />);
    const region = screen.getByTestId('region');

    fireEvent.dragEnter(region, { dataTransfer: files });
    expect(screen.getByTestId('state')).toHaveTextContent('dragging');

    fireEvent.dragLeave(region, { dataTransfer: files });
    expect(screen.getByTestId('state')).toHaveTextContent('idle');
  });

  it('does not flicker when the pointer crosses a child', () => {
    render(<Harness enabled onDrop={vi.fn()} />);
    const region = screen.getByTestId('region');
    const child = screen.getByTestId('child');

    fireEvent.dragEnter(region, { dataTransfer: files });
    fireEvent.dragEnter(child, { dataTransfer: files });
    fireEvent.dragLeave(region, { dataTransfer: files });
    expect(screen.getByTestId('state')).toHaveTextContent('dragging');

    fireEvent.dragLeave(child, { dataTransfer: files });
    expect(screen.getByTestId('state')).toHaveTextContent('idle');
  });

  it('ignores drags that carry no files', () => {
    const onDrop = vi.fn();
    render(<Harness enabled onDrop={onDrop} />);
    const region = screen.getByTestId('region');

    fireEvent.dragEnter(region, { dataTransfer: text });
    expect(screen.getByTestId('state')).toHaveTextContent('idle');

    const notHandled = fireEvent.drop(region, { dataTransfer: text });
    expect(notHandled).toBe(true); // default not prevented
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('hands the DataTransfer to onDrop once, prevents the default and clears the state', () => {
    const onDrop = vi.fn();
    render(<Harness enabled onDrop={onDrop} />);
    const region = screen.getByTestId('region');
    const child = screen.getByTestId('child');

    fireEvent.dragEnter(region, { dataTransfer: files });
    const notPrevented = fireEvent.drop(child, { dataTransfer: files });

    expect(notPrevented).toBe(false);
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('state')).toHaveTextContent('idle');
  });

  it('attaches nothing while disabled', () => {
    const onDrop = vi.fn();
    render(<Harness enabled={false} onDrop={onDrop} />);
    const region = screen.getByTestId('region');

    fireEvent.dragEnter(region, { dataTransfer: files });
    const notPrevented = fireEvent.drop(region, { dataTransfer: files });

    expect(screen.getByTestId('state')).toHaveTextContent('idle');
    expect(notPrevented).toBe(true);
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('clears a drag that ends on the window (released outside, Escape)', () => {
    render(<Harness enabled onDrop={vi.fn()} />);
    fireEvent.dragEnter(screen.getByTestId('region'), { dataTransfer: files });
    expect(screen.getByTestId('state')).toHaveTextContent('dragging');

    act(() => {
      window.dispatchEvent(new Event('dragend'));
    });
    expect(screen.getByTestId('state')).toHaveTextContent('idle');
  });

  it('keeps the drag state for as long as the file is held over the region, even with no further events', () => {
    vi.useFakeTimers();
    render(<Harness enabled onDrop={vi.fn()} />);
    const region = screen.getByTestId('region');

    fireEvent.dragEnter(region, { dataTransfer: files });
    fireEvent.dragOver(region, { dataTransfer: files });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByTestId('state')).toHaveTextContent('dragging');

    fireEvent.dragLeave(region, { dataTransfer: files });
    expect(screen.getByTestId('state')).toHaveTextContent('idle');
  });
});
