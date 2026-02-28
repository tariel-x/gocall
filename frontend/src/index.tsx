import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './styles.css';
import { fetchClientConfig } from './services/api';
import { setDebugEnabled } from './utils/debug';

const container = document.getElementById('root') as HTMLElement;
const root = ReactDOM.createRoot(container);

const renderApp = () => {
  root.render(
    <React.StrictMode>
      <BrowserRouter basename="/">
        <App />
      </BrowserRouter>
    </React.StrictMode>
  );
};

const bootstrap = async () => {
  try {
    const config = await fetchClientConfig();
    if (config?.debug) {
      setDebugEnabled(true, 'session');
    }
  } catch {
    // Ignore client config errors to avoid blocking the app.
  } finally {
    renderApp();
  }
};

void bootstrap();
