// Applies the saved theme before the first paint so dark mode never flashes
// white. Kept in sync with src/client/theme.ts, which handles later changes.
(function () {
  var preference = 'dark';
  try {
    preference = localStorage.getItem('opendots-theme') || 'dark';
  } catch (error) {}
  var dark =
    preference === 'dark' ||
    (preference !== 'light' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  // Friday's see-through windows (the notch, the task toast, the screen
  // overlay) must never paint the page's sky: their class is set before the
  // first paint, not when React mounts, or a reload shows a dark box.
  var see = { '#/notch': 'notch', '#/toast': 'toast', '#/overlay': 'overlay' }[
    location.hash
  ];
  if (see) document.documentElement.classList.add('friday-' + see + '-page');
})();
