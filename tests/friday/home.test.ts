import { expect, it } from 'vitest';
import { googleShortcuts } from '../../src/friday/client/home/FridayHome.js';

it('opens Gmail, Calendar and Drive in the account Friday is signed in to', () => {
  const urls = Object.fromEntries(
    googleShortcuts('prem@gmail.com').map(({ label, url }) => [label, url]),
  );
  expect(urls.Gmail).toBe(
    'https://mail.google.com/mail/u/?authuser=prem%40gmail.com',
  );
  expect(urls.Calendar).toBe(
    'https://calendar.google.com/calendar/r?authuser=prem%40gmail.com',
  );
  expect(urls.Drive).toBe(
    'https://drive.google.com/drive/my-drive?authuser=prem%40gmail.com',
  );
  expect(urls.YouTube).toBe('https://www.youtube.com/');
});

it('uses the plain addresses until the account is known', () => {
  expect(googleShortcuts(null).map(({ url }) => url)).toEqual([
    'https://mail.google.com/',
    'https://calendar.google.com/',
    'https://drive.google.com/',
    'https://www.youtube.com/',
  ]);
});
