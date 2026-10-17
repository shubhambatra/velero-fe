import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { LogViewer } from '@/components/log-viewer';
import { LineBuffer } from '@/lib/log-buffer';
import type { Snapshot } from '@/lib/log-session';

const ESC = '\u001b';

function snap(lines: string[], extra: Partial<Snapshot> = {}): Snapshot {
  return { lines, pending: '', dropped: 0, total: lines.length, ...extra };
}

function view(snapshot: Snapshot, props: { live?: boolean; text?: () => string } = {}) {
  const ui = (s: Snapshot) => (
    <LogViewer
      snapshot={s}
      live={props.live ?? true}
      text={props.text ?? (() => s.lines.join('\n'))}
      fileName="web-1_app.log"
      onClear={() => undefined}
    />
  );
  const result = render(ui(snapshot));
  return {
    ...result,
    update: (s: Snapshot) => {
      result.rerender(ui(s));
    },
  };
}

// jsdom has no layout: give the scroller a size and every row a height, as a browser would.
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.getAttribute('role') === 'log' ? 480 : 20;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 800 });
});
afterAll(() => {
  Reflect.deleteProperty(HTMLElement.prototype, 'offsetHeight');
  Reflect.deleteProperty(HTMLElement.prototype, 'offsetWidth');
});

const log = () => screen.getByRole('log', { name: 'Log output' });

describe('LogViewer', () => {
  it('shows lines, with colour from the log’s own codes and never as markup', () => {
    view(snap([`${ESC}[31mred${ESC}[0m plain`, '<b>not bold</b>']));
    const red = screen.getByText('red');
    expect(red.className).toMatch(/text-red/);
    expect(screen.getByText('<b>not bold</b>')).toBeInTheDocument();
    expect(log().querySelector('b')).toBeNull();
  });

  it('renders a window of a 50,000-line buffer, not all of it', () => {
    const b = new LineBuffer();
    b.push(Array.from({ length: 50_000 }, (_, i) => `line ${i.toString()}`).join('\n') + '\n');
    view(snap([...b.lines]));
    const rendered = log().querySelectorAll('[data-index]').length;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(200);
    expect(screen.getByText('50000 lines', { exact: false })).toBeInTheDocument();
  });

  it('pauses what is shown while lines keep arriving, then catches up', async () => {
    const user = userEvent.setup();
    const { update } = view(snap(['a', 'b']));
    await user.click(screen.getByRole('button', { name: 'Pause' }));
    update(snap(['a', 'b', 'c', 'd', 'e']));
    expect(screen.getByText('paused · 3 new')).toBeInTheDocument();
    expect(screen.queryByText('e')).toBeNull();
    expect(screen.getByRole('button', { name: 'Follow' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Resume' }));
    expect(screen.getByText('e')).toBeInTheDocument();
    expect(screen.queryByText(/paused/)).toBeNull();
  });

  it('turns Follow off when you scroll up, and back on from the button', async () => {
    const user = userEvent.setup();
    view(snap(Array.from({ length: 100 }, (_, i) => `l${i.toString()}`)));
    const follow = screen.getByRole('button', { name: 'Follow' });
    expect(follow).toHaveAttribute('aria-pressed', 'true');
    const el = log();
    Object.defineProperty(el, 'scrollHeight', { value: 2000, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: 480, configurable: true });
    Object.defineProperty(el, 'scrollTop', { value: 100, configurable: true });
    fireEvent.scroll(el);
    expect(follow).toHaveAttribute('aria-pressed', 'false');
    await user.click(screen.getByRole('button', { name: 'Jump to the newest line' }));
    expect(follow).toHaveAttribute('aria-pressed', 'true');
  });

  it('stays following while it is at the bottom', () => {
    view(snap(['a', 'b']));
    const el = log();
    Object.defineProperty(el, 'scrollHeight', { value: 500, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: 480, configurable: true });
    Object.defineProperty(el, 'scrollTop', { value: 20, configurable: true });
    fireEvent.scroll(el);
    expect(screen.getByRole('button', { name: 'Follow' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('searches the whole buffer, ignoring colour codes, and steps through matches', async () => {
    const user = userEvent.setup();
    view(snap(['start', `${ESC}[32mneedle one${ESC}[0m`, 'middle', 'a Needle two', 'end']));
    await user.type(screen.getByLabelText('Search the buffer'), 'NEEDLE');
    expect(screen.getByText('1 of 2')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next match' }));
    expect(screen.getByText('2 of 2')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next match' }));
    expect(screen.getByText('1 of 2')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Previous match' }));
    expect(screen.getByText('2 of 2')).toBeInTheDocument();
    await user.clear(screen.getByLabelText('Search the buffer'));
    await user.type(screen.getByLabelText('Search the buffer'), 'absent');
    expect(screen.getByText('No match')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next match' })).toBeDisabled();
  });

  it('switches between wrapped and unwrapped lines', async () => {
    const user = userEvent.setup();
    view(snap(['a very long line']));
    const row = () => log().querySelector('[data-index="0"]');
    expect(row()?.className).toMatch(/whitespace-pre-wrap/);
    await user.click(screen.getByRole('button', { name: 'Wrap lines' }));
    expect(row()?.className).toMatch(/whitespace-pre(?!-)/);
    expect(row()?.className).not.toMatch(/whitespace-pre-wrap/);
  });

  it('downloads the buffer as plain text under the container’s name', async () => {
    const user = userEvent.setup();
    let saved: Blob | undefined;
    const create = vi.fn((blob: Blob) => {
      saved = blob;
      return 'blob:x';
    });
    const revoke = vi.fn();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }));
    const names: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      names.push(this.download);
    });
    view(snap(['x']), { text: () => `${ESC}[31mred${ESC}[0m line\nsecond\n` });
    await user.click(screen.getByRole('button', { name: 'Download' }));
    expect(names).toEqual(['web-1_app.log']);
    expect(await saved?.text()).toBe('red line\nsecond\n');
    expect(revoke).toHaveBeenCalledWith('blob:x');
    click.mockRestore();
    vi.unstubAllGlobals();
  });

  it('says how many old lines were dropped', () => {
    view(snap(['a'], { dropped: 1234 }));
    expect(screen.getByRole('status')).toHaveTextContent(/oldest 1,234 lines were dropped/);
  });

  it('shows a line that has not ended yet', () => {
    view(snap(['a'], { pending: 'half a li' }));
    expect(screen.getByText('half a li')).toBeInTheDocument();
  });

  it('offers nothing to download or clear before there is a line', () => {
    view(snap([]));
    expect(screen.getByRole('button', { name: 'Download' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Clear' })).toBeDisabled();
    expect(within(log()).getByText('Nothing yet.')).toBeInTheDocument();
  });

  it('keeps a stable view across rerenders from the buffer', () => {
    const { update } = view(snap(['a']));
    act(() => {
      update(snap(['a', 'b']));
    });
    expect(screen.getByText('b')).toBeInTheDocument();
  });
});
