import React from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import App from './App';
import Admin from './pages/Admin';
import Companion from './pages/Companion';
import ZoomBridge from './pages/ZoomBridge';
import './styles/ui.css';

const router = createBrowserRouter([
  { path: '/', element: <App /> },
  { path: '/admin', element: <Admin /> },
  { path: '/companion', element: <Companion /> },
  { path: '/zoom', element: <ZoomBridge /> },
]);

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>
);