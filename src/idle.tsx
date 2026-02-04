import React from 'react';
import ReactDOM from 'react-dom/client';
import { IdleWindow } from './components/IdleWindow';
import { logger } from './lib/logger';
import './index.css';

logger.debug('IDLE_ENTRY', 'idle.tsx loaded, creating React root...');

const rootElement = document.getElementById('root');
if (!rootElement) {
  logger.error('IDLE_ENTRY', 'Root element not found!');
} else {
  logger.debug('IDLE_ENTRY', 'Root element found, rendering IdleWindow...');
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <IdleWindow />
    </React.StrictMode>
  );
  logger.debug('IDLE_ENTRY', 'IdleWindow rendered');
}
