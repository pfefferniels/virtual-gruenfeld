import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import path from 'path';

import { corsOptions } from './cors';
import { teacherAskRouter } from './routes/teacherAsk';
import { teacherStreamRouter } from './routes/teacherStream';

const app = express();
app.use(cors(corsOptions()));
app.use(express.json({ limit: '10mb' }));
app.use(express.static('client/build'));

app.use(teacherStreamRouter);
// A 30s webm question is ~0.5MB base64, well inside the 10mb JSON limit above.
app.use(teacherAskRouter);

/** For the reverse proxy and for checking by hand that TLS reaches the process. */
app.get('/health', (_req, res) => {
    res.json({ ok: true });
});

// Only meaningful when the server also hosts the client. In the deployment
// DEPLOYMENT.md describes, the client is on Cloudflare Pages and this never hits.
app.get('*', (req, res) => {
    const index = path.join(__dirname, '../client/build', 'index.html');
    res.sendFile(index, (err) => {
        if (err) res.status(404).json({ error: 'This server hosts the teacher API only.' });
    });
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
    console.log(`Virtual Grünfeld server running on port ${PORT}`);
    console.log(`CORS: ${process.env.TEACHER_CORS_ORIGIN || 'localhost only (TEACHER_CORS_ORIGIN unset)'}`);
});
