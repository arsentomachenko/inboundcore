import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  // StrictMode disabled to prevent WebSocket double-connection issues in development
  // Re-enable before production deployment
  <App />
);

