/**
 * The appearance switch, and the two things the ported component did not give us.
 *
 * The catalogue original (21st.dev 1216) is a `<div role="button" tabIndex={0}>` with `onClick` and
 * nothing else, so Enter and Space do not work it. That is the whole reason this repo's copy is a
 * real `<button>`, and a departure with no test is a departure waiting to be undone by someone
 * tidying up. The other is the accessible NAME: it has to stay still while the state moves, or a
 * screen reader announces the action and the state contradicting each other.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { ThemeToggle } from './ThemeToggle';
import { LocaleProvider } from '../lib/i18n/LocaleProvider';

const renderToggle = () => render(<LocaleProvider initialLocale="he"><ThemeToggle /></LocaleProvider>);
const control = () => screen.getByRole('button', { name: 'מצב כהה' });

beforeEach(() => {
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.themeSwap;
  window.localStorage.clear();
});

describe('ThemeToggle', () => {
  it('is a real button, so Enter and Space work it', async () => {
    const user = userEvent.setup();
    renderToggle();

    expect(control().tagName).toBe('BUTTON');

    control().focus();
    await user.keyboard('{Enter}');
    expect(document.documentElement.dataset.theme).toBe('dark');

    await user.keyboard(' ');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('keeps ONE accessible name while the state moves', async () => {
    const user = userEvent.setup();
    renderToggle();

    // Light: not pressed. The name says what the control is, never what pressing it would do.
    expect(control()).toHaveAttribute('aria-pressed', 'false');

    await user.click(control());

    // Dark: pressed — and findable by the SAME name, which is what voice control and any
    // name-based automation depend on.
    expect(control()).toHaveAttribute('aria-pressed', 'true');
  });

  it('says what the press will do in the tooltip, where a changing string is safe', async () => {
    const user = userEvent.setup();
    renderToggle();

    expect(control()).toHaveAttribute('title', 'מעבר למצב כהה');
    await user.click(control());
    expect(control()).toHaveAttribute('title', 'מעבר למצב בהיר');
  });

  it('reads the theme the pre-paint script already set rather than owning it', () => {
    document.documentElement.dataset.theme = 'dark';
    renderToggle();

    // The control never disagrees with the page it is sitting on: no second source of truth.
    expect(control()).toHaveAttribute('aria-pressed', 'true');
    expect(control()).toHaveAttribute('data-theme-state', 'dark');
  });
});
