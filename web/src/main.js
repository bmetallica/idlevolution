import './app.css';
import App from './App.svelte';

// PWA: Service-Worker registrieren (Installierbarkeit + App-Shell-Fallback)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

export default new App({ target: document.getElementById('app') });
