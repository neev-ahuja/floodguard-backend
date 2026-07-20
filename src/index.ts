import express from 'express';
import session from 'express-session';
import cors from 'cors';
import helmet from 'helmet';
import { config, isUsingDefaultCredentials, isProduction } from './config';
import authRoutes from './routes/auth';
import adminRoutes from './routes/admin';
import citizenRoutes from './routes/citizen';
import webhookRoutes from './routes/webhook';

const app = express();

// Trust reverse proxies (Render, Vercel, Nginx, Cloudflare) to ensure HTTPS cookies are set
app.set('trust proxy', 1);

// Security Headers
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

// CORS Configuration - Allow all origins with credentials support
app.use(cors({
  origin: (origin, callback) => {
    // Dynamically reflect requesting origin to allow CORS for all origins (Vercel, localhost, ngrok, etc.)
    callback(null, origin || true);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-N8N-Webhook-Secret', 'Cookie', 'X-Requested-With'],
}));

// Parse body
app.use(express.json());

// Session Management
app.use(
  session({
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    name: 'connect.sid', // default session cookie name
    cookie: {
      httpOnly: true,
      secure: isProduction(), // Require HTTPS in production
      sameSite: isProduction() ? 'none' : 'lax', // None for cross-origin credentials, Lax for development
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    },
  })
);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'UP',
    timestamp: new Date().toISOString(),
    env: config.nodeEnv,
    defaultAdminInUse: isUsingDefaultCredentials()
  });
});

// Route mapping
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/citizen', citizenRoutes);
app.use('/api/webhook', webhookRoutes);

// 404 Route
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found.' });
});

// Global Error Handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('[SERVER ERROR]', err);
  res.status(500).json({ error: 'Internal Server Error' });
});

// Startup server
app.listen(config.port, () => {
  console.log(`===============================================`);
  console.log(` Flood Guard Server Running on Port ${config.port}`);
  console.log(` Environment: ${config.nodeEnv}`);
  console.log(` Frontend URL: ${config.frontendUrl}`);
  
  if (isUsingDefaultCredentials()) {
    console.warn(` [SECURITY WARNING] Default admin credentials are in use!`);
    console.warn(` Please configure ADMIN_PASSWORD_HASH for production.`);
  }
  
  console.log(`===============================================`);
});
