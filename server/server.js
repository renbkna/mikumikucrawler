import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import rateLimit from 'express-rate-limit';

// Import our modular components
import { setupDatabase } from './config/database.js';
import { setupLogging } from './config/logger.js';
import { createApiRoutes } from './routes/api.js';
import { setupCrawlSocket } from './sockets/crawlSocket.js';

// Initialize core services
const logger = await setupLogging();
const dbPromise = setupDatabase();

// SETUP: Express, HTTP & Socket.IO
const app = express();
const server = http.createServer(app);
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

const io = new Server(server, {
  cors: {
    origin: FRONTEND_URL,
    methods: ['GET', 'POST'],
    credentials: true,
  },
  maxHttpBufferSize: 5e6, // 5MB
  pingTimeout: 60000,
});

// Middleware setup
app.use(
  cors({
    origin: FRONTEND_URL,
    credentials: true,
  })
);
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// Global rate limiter
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});
app.use(globalLimiter);

// Setup Socket.IO for crawling operations
const activeCrawls = setupCrawlSocket(io, dbPromise, logger);

// Setup API routes
const apiRoutes = createApiRoutes(dbPromise, logger, activeCrawls);
app.use('/api', apiRoutes);

// Legacy health endpoint (keeping for backward compatibility)
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    activeCrawls: activeCrawls.size,
    uptime: process.uptime(),
    memoryUsage: process.memoryUsage(),
  });
});

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  logger.info(`Advanced Miku Crawler Beam backend running on port ${PORT}`);
});

// Handle shutdown gracefully
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully');

  // Close all active crawl sessions
  for (const [_, session] of activeCrawls) {
    await session.stop();
  }

  // Close server
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});

export default app;
