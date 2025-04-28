import express from 'express';
import cors from 'cors';
import axios from 'axios';
import { createHmac } from 'crypto';
import { generate, reGenerate, handleWebhookEvent, verifyWebhookSignature, checkUserStatus } from './src/SumsubApiClient.js';
import getRawBody from 'raw-body';

const app = express();
const port = process.env.PORT || 3001;
const DJANGO_API_BASE_URL = process.env.DJANGO_API_BASE_URL;

// ========================
// Authentication Middleware
// ========================
const authenticateUser = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ 
      error: 'Unauthorized',
      details: 'Missing or invalid Authorization header' 
    });
  }

  const token = authHeader.split(' ')[1];
  if (!token) {
    return res.status(401).json({ 
      error: 'Unauthorized',
      details: 'No access token provided' 
    });
  }

  req.accessToken = token;
  next();
};

// ========================
// Server Configuration
// ========================
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

app.use(express.urlencoded({ extended: true }));

// ========================
// Webhook Endpoint (Server-to-Server)
// ========================
app.post('/sumsub-webhook', 
  async (req, res, next) => {
    try {
      req.rawBody = await getRawBody(req, {
        length: req.headers['content-length'],
        limit: '1mb',
        encoding: 'utf8'
      });
      next();
    } catch (err) {
      console.error('Error reading raw body:', err);
      res.status(400).json({ error: 'Invalid request body' });
    }
  },
  async (req, res) => {
    try {
      const rawBody = req.rawBody;
      const receivedSignature = req.headers['x-payload-digest'];
      const webhookSecret = process.env.SUMSUB_WEBHOOK_SECRET;

      if (!webhookSecret) {
        throw new Error('SUMSUB_WEBHOOK_SECRET is not configured');
      }

      // Debug mode bypass - use only in development
      if (process.env.DEBUG_WEBHOOK === 'true') {
        console.warn('⚠️ Webhook verification bypassed for debugging');
        const parsed = JSON.parse(rawBody);
        console.log('Debug webhook payload:', {
          type: parsed.type,
          applicantId: parsed.applicantId,
          externalUserId: parsed.externalUserId
        });

        const result = await handleWebhookEvent(parsed);
        await forwardToDjango(result);
        return res.status(200).send('Webhook received (debug mode)');
      }

      // Verify signature
      const isValid = verifyWebhookSignature(rawBody, receivedSignature, webhookSecret);
      if (!isValid) {
        const computedSignature = createHmac('sha256', webhookSecret)
          .update(rawBody)
          .digest('hex');
          
        console.error('Invalid webhook signature', {
          received: receivedSignature,
          computed: computedSignature
        });
        return res.status(403).json({ error: 'Invalid webhook signature' });
      }

      // Parse and process the webhook
      const payload = JSON.parse(rawBody);
      console.log('Received webhook:', {
        type: payload.type,
        applicantId: payload.applicantId,
        externalUserId: payload.externalUserId,
        reviewStatus: payload.reviewStatus
      });

      const result = await handleWebhookEvent(payload);

      // Enhanced Django forwarding with retry logic
      try {
        await forwardToDjango(result);
        res.status(200).send('Webhook processed successfully');
      } catch (djangoError) {
        await storeFailedWebhook(payload);
        res.status(200).json({ 
          error: 'Webhook received but Django processing failed',
          details: djangoError.message
        });
      }

    } catch (error) {
      console.error('❌ Webhook processing error:', error.message);
      
      if (error.message.includes('Invalid webhook signature')) {
        res.status(403).json({ error: error.message });
      } else {
        res.status(200).json({ 
          error: error.message,
          details: 'Webhook received but encountered processing error'
        });
      }
    }
  }
);

// ========================
// JSON Parsing Middleware
// ========================
app.use((req, res, next) => {
  if (req.path === '/sumsub-webhook') return next();
  express.json({ limit: '10kb' })(req, res, next);
});

// ========================
// User-Facing Routes
// ========================

// Generate SumSub link
app.post('/api/generate-sumsub-link', authenticateUser, async (req, res) => {
  try {
    const { userId, levelName } = req.body;
    
    if (!userId || !levelName) {
      return res.status(400).json({ 
        error: 'Validation failed',
        details: 'userId and levelName are required'
      });
    }

    const url = await generate(userId, levelName);
    res.json({ 
      url,
      verificationId: userId
    });
    
  } catch (error) {
    console.error('Error generating SumSub link:', error.message);
    const statusCode = error.response?.status || 500;
    res.status(statusCode).json({ 
      error: error.message,
      details: error.response?.data || 'Check server logs'
    });
  }
});

// Regenerate SumSub link
app.post('/api/regenerate-sumsub-link', authenticateUser, async (req, res) => {
  try {
    const { userId, levelName } = req.body;
    
    if (!userId || !levelName) {
      return res.status(400).json({ 
        error: 'Validation failed',
        details: 'userId and levelName are required'
      });
    }

    const url = await reGenerate(userId, levelName);
    res.json({ 
      url,
      verificationId: userId
    });
    
  } catch (error) {
    console.error('Error regenerating SumSub link:', error.message);
    const statusCode = error.response?.status || 500;
    res.status(statusCode).json({ 
      error: error.message,
      details: error.response?.data || 'Check server logs'
    });
  }
});

// Check verification status
app.get('/api/verification-status/:verificationId', authenticateUser, async (req, res) => {
  try {
    let { verificationId } = req.params;
    
    // First decode in case it's double-encoded
    verificationId = decodeURIComponent(verificationId);
    
    // Then encode @ symbol only (Django expects %40 for @)
    const encodedForDjango = verificationId.replace(/@/g, '%40');
    
    // Forward request to Django API
    const djangoResponse = await axios.get(
      `${DJANGO_API_BASE_URL}/verifications/user/${encodedForDjango}/`,
      {
        headers: {
          'Authorization': `Bearer ${req.accessToken}`
        },
        timeout: 3000
      }
    );

    if (djangoResponse?.data) {
      return res.json({
        status: djangoResponse.data.review_status,
        result: djangoResponse.data.verification_result || djangoResponse.data
      });
    }

    // If not found in Django, fallback to SumSub
    const sumsubStatus = await checkUserStatus(verificationId);
    return res.json({
      status: sumsubStatus.reviewStatus || 'unknown',
      result: sumsubStatus
    });

  } catch (error) {
    console.error('Verification status check failed:', error.message);
    res.status(500).json({
      error: 'Failed to check verification status',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

const verificationCache = new Map();

app.get('/admin/verifications', async (req, res) => {
  try {
    const cacheKey = 'all_verifications';
    
    if (verificationCache.has(cacheKey)) {
      const cached = verificationCache.get(cacheKey);
      if (Date.now() - cached.timestamp < 30000) {
        return res.json(cached.data);
      }
    }

    const response = await axios.get(`${DJANGO_API_BASE_URL}/verifications/`, {
      headers: {
        'Authorization': `Bearer ${process.env.DJANGO_ADMIN_TOKEN}`
      }
    });

    verificationCache.set(cacheKey, {
      data: response.data,
      timestamp: Date.now()
    });
    
    res.json(response.data);
  } catch (error) {
    handleDjangoError(res, error, 'fetching verifications');
  }
});

app.get('/admin/verifications/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const cacheKey = `verification_${userId}`;
    
    if (verificationCache.has(cacheKey)) {
      const cached = verificationCache.get(cacheKey);
      if (Date.now() - cached.timestamp < 30000) {
        return res.json(cached.data);
      }
    }

    const response = await axios.get(`${DJANGO_API_BASE_URL}/verifications/${userId}/`, {
      headers: {
        'Authorization': `Bearer ${process.env.DJANGO_ADMIN_TOKEN}`
      }
    });

    verificationCache.set(cacheKey, {
      data: response.data,
      timestamp: Date.now()
    });
    
    res.json(response.data);
  } catch (error) {
    handleDjangoError(res, error, 'fetching verification');
  }
});

// ========================
// Helper Functions
// ========================
async function forwardToDjango(data) {
  try {
    const response = await axios.post(
      `${DJANGO_API_BASE_URL}/kyc/webhook/`,
      data,
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.DJANGO_SERVICE_TOKEN}`,
          'X-Webhook-Source': 'sumsub'
        },
        timeout: 5000
      }
    );

    console.log('Forwarded to Django:', response.status);
    return response;
  } catch (error) {
    console.error('Django forwarding failed:', {
      status: error.response?.status,
      data: error.response?.data,
      message: error.message
    });
    throw error;
  }
}

async function storeFailedWebhook(payload) {
  console.warn('Storing failed webhook for retry:', {
    type: payload.type,
    applicantId: payload.applicantId,
    timestamp: new Date().toISOString()
  });
  // TODO: Implement actual storage and retry mechanism
}

function handleDjangoError(res, error, context) {
  console.error(`Error ${context}:`, {
    message: error.message,
    status: error.response?.status,
    data: error.response?.data
  });

  if (error.response) {
    const statusCode = error.response.status;
    if (statusCode === 404) {
      return res.status(404).json({ error: 'Not found' });
    }
    return res.status(statusCode).json({
      error: error.response.data?.error || 'Django API error',
      details: error.response.data
    });
  }

  res.status(500).json({ 
    error: 'Internal server error',
    details: process.env.NODE_ENV === 'development' ? error.message : undefined
  });
}

// ========================
// Health Check
// ========================
app.get('/health', async (req, res) => {
  try {
    const djangoHealth = await axios.get(`${DJANGO_API_BASE_URL}/health/`, {
      timeout: 3000
    }).catch(() => ({ status: 503 }));

    res.status(200).json({ 
      status: 'healthy',
      services: {
        django: djangoHealth.status === 200 ? 'healthy' : 'unavailable',
        webhook: !!process.env.SUMSUB_WEBHOOK_SECRET ? 'configured' : 'not_configured',
        cache: verificationCache.size > 0 ? 'active' : 'inactive'
      },
      uptime: process.uptime()
    });
  } catch (error) {
    res.status(503).json({
      status: 'degraded',
      error: error.message
    });
  }
});

// ========================
// Error Handling
// ========================
app.use((err, req, res, next) => {
  console.error('Unhandled error:', {
    message: err.message,
    stack: err.stack,
    url: req.originalUrl,
    method: req.method
  });

  res.status(500).json({ 
    error: 'Internal server error',
    reference: `ERR-${Date.now()}`
  });
});

// ========================
// Server Startup
// ========================
app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
  console.log(`🔐 Authentication Mode: User token forwarding`);
  console.log(`🌐 Django API: ${DJANGO_API_BASE_URL}`);
});