import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Стили, шрифты и локаль подключает точка входа: иначе в выход сборки они не попадут.
import './styles/fonts';
import './styles/tokens.css';
import './styles/base.css';
import './i18n';
import { App } from './App';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('В index.html нет элемента #root');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
