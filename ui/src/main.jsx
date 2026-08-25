import React from 'react';
import { createRoot } from 'react-dom/client';
import '../css/theme.css';
import '../css/app.css';
import App from './App.jsx';
import { readLaunchOptions } from '../js/launch.js';

// Launch options are resolved before the first render so a `--zone … --minimal`
// preview never flashes the full UI on the way to the chrome-free viewer.
readLaunchOptions()
  .catch(() => null)   // a launch line we can't read is not a reason for a blank window
  .then((launch) => {
    createRoot(document.getElementById('root')).render(<App launch={launch} />);
  });
