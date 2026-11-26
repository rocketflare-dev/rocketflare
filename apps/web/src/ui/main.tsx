import React from 'react'
import ReactDOM from 'react-dom/client'
// The self-hosted faces (OFL, variable): the body face and the code face. `--font-sans` /
// `--font-mono` in shared/theme-tokens.css name them; a rebrand swaps both lines together.
import '@fontsource-variable/ibm-plex-sans'
import '@fontsource-variable/jetbrains-mono'
import App from './App'
import './index.css'

const rootElement = document.getElementById('root')
if (!rootElement) {
  throw new Error('Root element not found')
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
