# Enabling Spoken Feedback

The public version at [play.welte225.org](https://play.welte225.org) works without any setup — the virtual teacher listens to your playing and responds with an exaggerated corrective performance.

To additionally enable **spoken feedback** (the teacher comments on your playing with voice), you need to run a small local server that connects to OpenAI and ElevenLabs.

## Prerequisites

- [Node.js](https://nodejs.org/) 18 or later
- An [OpenAI API key](https://platform.openai.com/api-keys)
- An [ElevenLabs API key](https://elevenlabs.io/) (for text-to-speech)

## Setup

1. Clone this repository:

   ```sh
   git clone https://github.com/pfefferniels/virtual-gruenfeld.git
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

   Optional settings:

   ```
   ELEVENLABS_VOICE_ID=a4oYSRgmiY0auDgVfso5
   OUTPUT_LANGUAGE=German
   ```

4. Start the server:

   ```sh
   npm start
   ```

   The server runs on port 3002 by default. You can change this with `PORT=4000 npm start`.

5. Open [play.welte225.org](https://play.welte225.org). The page automatically detects the local server and enables spoken feedback with the Teacher Cue Mode selector.

## How it works

The local server receives a diff of your performance vs. the reference, asks an LLM to generate teaching commentary, and synthesizes speech via ElevenLabs. The spoken cues are then scheduled alongside the teacher's corrective MIDI playback.

Your API keys never leave your machine — the browser talks to `localhost:3002`, which in turn calls the external APIs.
