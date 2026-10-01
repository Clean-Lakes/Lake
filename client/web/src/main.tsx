import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import '../../desktop/frontend/src/style.css'
import '../../desktop/frontend/src/App.css'
import './web.css'

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
