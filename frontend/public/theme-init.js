// Apply the saved (or system) colour theme before the first paint so the page
// never flashes the wrong theme. Mirrors src/theme.js. A separate file, not an
// inline script, because the Content-Security-Policy in vercel.json only runs
// scripts served from this site.
(function () {
  var theme = null;
  try { theme = window.localStorage.getItem('sp-theme'); } catch (e) { theme = null; }
  if (theme !== 'light' && theme !== 'dark') {
    try { theme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'; } catch (e) { theme = 'dark'; }
  }
  document.documentElement.setAttribute('data-theme', theme);
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'light' ? '#F2F5FA' : '#060B18');
})();
