import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { Game } from './game/Game'
import '../index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Game />
    <App />
  </StrictMode>,
)
