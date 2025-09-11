# Virtual Grünfeld

AI web application for conversing with Alfred Grünfeld's historical piano rendition of Schumann's *Träumerei* (1905).

## Overview

This application allows users to interact with a virtual pianist through natural language, requesting specific musical passages and variations (tempo changes, dynamic exaggeration, harmonic reductions). The system processes MEI (Music Encoding Initiative) and MPM (Musical Performance Markup) files to generate expressive audio renditions.

## Architecture

- **Backend**: Node.js/TypeScript with OpenAI Agents SDK
- **Frontend**: React with Material-UI and Verovio for score rendering
- **Data**: MEI scores and MPM performance files (filesystem-based)
- **Audio Pipeline**: MEI+MPM → MIDI → Audio synthesis

## Features

- Natural language conversation in German/English
- Musical location parsing ("Anfang bis Takt 3", "Auftakt zu Takt 2")
- Performance modifications (tempo, dynamics, rubato)
- Score highlighting with Verovio
- Audio playback with caching
- Harmonic reduction switching

## Project Structure

```
├── src/                    # Backend TypeScript code
│   ├── types.ts           # Core type definitions
│   ├── server.ts          # Express server
│   ├── agent/             # OpenAI Agent implementation
│   ├── tools/             # Musical processing tools
│   ├── api/               # REST API endpoints
│   └── utils/             # Utility functions
├── client/                # React frontend
│   ├── src/
│   │   ├── components/    # React components
│   │   ├── types/         # Frontend types
│   │   └── utils/         # API utilities
│   └── public/            # Static assets
├── assets/                # Musical data
│   ├── reconstruction/    # Full performance reconstruction
│   └── harmonic_reduction/ # Simplified harmonic version
└── renders/               # Generated audio/MIDI (gitignored)
```

## Quick Start

1. **Install dependencies**:
   ```bash
   npm install
   cd client && npm install && cd ..
   ```

2. **Set up environment**:
   ```bash
   cp .env.example .env
   # Edit .env with your OpenAI API key and tool paths
   ```

3. **Development**:
   ```bash
   npm run dev  # Starts both backend and frontend
   ```

4. **Build**:
   ```bash
   npm run build
   ```

## Implementation Status

This is a **skeleton implementation** based on the detailed specification. Current status:

### ✅ Completed
- Project structure and configuration
- Core type definitions
- Basic server setup with REST API
- Tool stubs for all specified functionality
- React frontend with chat interface
- Asset organization

### 🚧 Stub Implementations
- Natural language parsing (basic German phrases)
- MEI/MPM processing (placeholder logic)
- Audio rendering (creates dummy files)
- Score rendering (Verovio integration needed)

### ❌ Not Yet Implemented
- Actual MEI parsing and score-time calculations
- Real MPM modification via external tools
- Verovio score rendering integration
- Audio synthesis with FluidSynth/TiMidity
- OpenAI Agents SDK integration
- Proper session management

## Dependencies

For full functionality, the following external tools are required:

- **meico**: MEI to MIDI/MSM conversion
- **mpm-modifier**: MPM performance modification
- **FluidSynth**: MIDI to audio synthesis
- **FFmpeg**: Audio format conversion

## Environment Variables

See `.env.example` for required configuration:

- `OPENAI_API_KEY`: OpenAI API key for agent functionality
- `MEICO_BIN`: Path to meico application
- `MPM_MOD_BIN`: Path to MPM modifier tool
- `RENDER_AUDIO_FORMAT`: Output audio format (mp3/wav)

## License

MIT