import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import path from 'path';

import { teacherAskRouter } from './routes/teacherAsk';
import { teacherStreamRouter } from './routes/teacherStream';

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('client/build'));

app.use(teacherStreamRouter);
// A 30s webm question is ~0.5MB base64, well inside the 10mb JSON limit above.
app.use(teacherAskRouter);

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../client/build', 'index.html'));
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
    console.log(`Virtual Grünfeld server running on port ${PORT}`);
});
