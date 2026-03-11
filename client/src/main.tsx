import ReactDOM from 'react-dom/client'
import { App } from './App.tsx'
import { PianoContextProvider } from './pianosound'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <PianoContextProvider>
    <App />
  </PianoContextProvider>
)
