import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import path from 'path';
import { chatRouter } from './api/chat';
import { reconstructionsRouter } from './api/reconstructions';
import { rendersRouter } from './api/renders';
import { meiRouter } from './api/mei';
import { tokenRouter } from './api/token';
import { lessonRouter } from './api/lesson';

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('client/build')); // Serve React build

// API Routes
app.use('/api/chat', chatRouter);
app.use('/api/reconstructions', reconstructionsRouter);
app.use('/api/mei', meiRouter);
app.use('/renders', rendersRouter);
app.use('/token', tokenRouter);
app.use('/lesson', lessonRouter)

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// Serve React app for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/build', 'index.html'));
});

// Error handling middleware
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`Virtual Grünfeld server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
});

export default app;