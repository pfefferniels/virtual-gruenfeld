import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import path from 'path';

import { corsOptions } from './cors';
import { startHeartbeat } from './jev/client';
import { decideRoute } from './routes/decide';

const app = express();
app.use(cors(corsOptions()));
app.use(express.json({ limit: '256kb' }));
app.use(express.static('client/build'));

/** For the reverse proxy and for checking by hand that TLS reaches the process. */
app.get('/health', (_req, res) => {
    res.json({ ok: true });
});

app.post('/decide', (req, res) => {
    void decideRoute(req, res);
});

// Only meaningful when the server also hosts the client. In the deployment
// DEPLOYMENT.md describes, the client is on Cloudflare Pages and this never hits.
app.get('*', (req, res) => {
    const index = path.join(__dirname, '../client/build', 'index.html');
    res.sendFile(index, (err) => {
        if (err) res.status(404).json({ error: 'Not found.' });
    });
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
    // Opened before the first student plays: a cold socket costs 2.1–2.4 s against 0.5–0.7 s warm.
    startHeartbeat();
    console.log(`Virtual Grünfeld server running on port ${PORT}`);
    console.log(`CORS: ${process.env.TEACHER_CORS_ORIGIN || 'localhost only (TEACHER_CORS_ORIGIN unset)'}`);
    console.log(`Jev: ${process.env.TYPESAFE_API_KEY ? 'configured, connection warm' : 'no TYPESAFE_API_KEY — /decide will skip'}`);
});
