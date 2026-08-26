# Enabling Spoken Feedback

The public version at [play.welte225.org](https://play.welte225.org) works without any setup — the virtual teacher listens to your playing and responds with an exaggerated corrective performance.

To additionally enable **spoken feedback** (the teacher comments on your playing with voice), you need to run a small local server that connects to OpenAI and ElevenLabs.

> Putting the teacher online for everyone, instead of running it yourself, is a different job — see [DEPLOYMENT.md](DEPLOYMENT.md).

## Prerequisites

- [Node.js](https://nodejs.org/) 22 or later (espressivo needs it)
- An [OpenAI API key](https://platform.openai.com/api-keys)
- An [ElevenLabs API key](https://elevenlabs.io/) (for text-to-speech)

## Setup

1. Clone this repository and espressivo, side by side. Everything expressive — the score
   conversion, the fit of your playing, the comparison and the rendering — runs on espressivo,
   and it is linked as `../meico-ts`:

   ```sh
   git clone https://github.com/pfefferniels/espressivo.git meico-ts
   git clone https://github.com/pfefferniels/virtual-gruenfeld.git
   (cd meico-ts && npm ci && npm run build)
   cd virtual-gruenfeld
   ```

2. Install server dependencies:

   ```sh
   npm install
   ```

3. Create a `.env` file in the project root with your API keys:

   ```
   OPENAI_API_KEY=sk-...
   ELEVENLABS_API_KEY=...
   ```

   `.env.example` lists everything else you can set — voice, language, models.

4. Build and start the server:

   ```sh
   npm run build:server
   npm start
   ```

   The server runs on port 3002 by default. You can change this with `PORT=4000 npm start`.
   Check it came up with `curl localhost:3002/health`.

## Pointing the app at your server

**The simplest option** is to run the whole app locally, which needs no configuration at all —
`npm run dev` serves the client on <http://localhost:3000> and it finds the teacher by itself.

To use **the public page** with **your local server** instead, tell that browser where the
server is. Open [play.welte225.org](https://play.welte225.org), open the developer console
(<kbd>F12</kbd>), and run this once:

```js
localStorage.TEACHER_URL = 'http://localhost:3002'
```

Reload. The Teacher Cue Mode selector appears in place of the "spoken feedback unavailable"
notice. The setting persists in that browser until you clear it with
`delete localStorage.TEACHER_URL`.

Two caveats:

- **Safari will refuse this.** An `https://` page is not allowed to call `http://localhost`
  there. Chrome and Firefox both exempt localhost from mixed-content blocking, so they are
  fine. In Safari, run the app locally instead.
- The deployed page no longer looks for a local server on its own. It used to, which meant
  every visitor's browser spent six seconds failing to reach a server that was not there.

## How it works

The local server receives a diff of your performance vs. the reference, asks an LLM to generate teaching commentary grounded in the piece's scholarly record, and synthesizes speech via ElevenLabs. The spoken cues are then scheduled alongside the teacher's corrective MIDI playback.

Your API keys never leave your machine — the browser talks to `localhost:3002`, which in turn calls the external APIs.
