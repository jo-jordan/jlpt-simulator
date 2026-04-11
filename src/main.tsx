import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

;(window as Window & { __JLPT_SIMULATOR_BUILD__?: string }).__JLPT_SIMULATOR_BUILD__ = '2026-04-11-mime-fix'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
