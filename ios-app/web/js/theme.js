// ===== THEME =====
function initTheme() {
  const t = localStorage.getItem('theme') || 'dark';
  document.documentElement.setAttribute('data-theme', t);
}
function setTheme(t) {
  localStorage.setItem('theme', t);
  document.documentElement.setAttribute('data-theme', t);
  document.getElementById('themeDark')?.classList.toggle('active', t === 'dark');
  document.getElementById('themeLight')?.classList.toggle('active', t === 'light');
}
initTheme();
