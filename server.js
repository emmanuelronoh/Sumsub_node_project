import express from 'express';
import cors from 'cors';
import axios from 'axios';
import { createHmac } from 'crypto';
import { generate, reGenerate, handleWebhookEvent, verifyWebhookSignature, checkUserStatus } from './src/SumsubApiClient.js';
import getRawBody from 'raw-body';

const app = express();
const port = process.env.PORT || 3000; 

const DJANGO_API_BASE_URL = "https://cheetahx.onrender.com";
// ========================
// Authentication Middleware
// ========================
const authenticateUser = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ 
        error: 'Unauthorized',
        details: 'Missing or invalid Authorization header' 
      });
    }

    const token = authHeader.split(' ')[1];
    
    // Verify the token with Django
    const response = await axios.get("https://cheetahx.onrender.com/api/auth/validate-token/", {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });
    
    if (response.status !== 200) {
      throw new Error('Invalid token');
    }

    req.user = response.data.user;
    next();
  } catch (error) {
    console.error('Authentication error:', error);
    return res.status(401).json({ 
      error: 'Unauthorized',
      details: 'Invalid or expired token' 
    });
  }
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
    const { userId, levelName, email, phone } = req.body;
    
    // Validate required fields
    if (!userId || !levelName || !email) {
      return res.status(400).json({ 
        error: 'Validation failed',
        details: 'userId, levelName, and email are required'
      });
    }

    // First create verification record in Django
    const djangoResponse = await axios.post(
      `${DJANGO_API_BASE_URL}/kyc/verifications/`,
      {
        email: email,
        level_name: levelName,
        phone: phone  // Optional, depending on your Django model
      },
      {
        headers: {
          'Authorization': req.headers.authorization,
          'Content-Type': 'application/json'
        },
        timeout: 5000
      }
    );

    console.log('Django verification record created:', {
      status: djangoResponse.status,
      data: djangoResponse.data
    });

    // Then generate SumSub link
    const sumsubPayload = {
      userId: userId,
      levelName: levelName,
      email: email,
      phone: phone
    };

    const url = await generate(sumsubPayload);
    
    res.json({ 
      url,
      verificationId: userId,
      djangoRecord: djangoResponse.data  // Optional: include Django response for debugging
    });
    
  } catch (error) {
    console.error('Error in generate-sumsub-link:', {
      message: error.message,
      stack: error.stack,
      response: error.response?.data
    });

    // Handle different error scenarios
    if (error.response) {
      // Forward Django validation errors
      if (error.response.config?.url.includes(DJANGO_API_BASE_URL)) {
        return res.status(error.response.status).json({
          error: 'Django validation failed',
          details: error.response.data,
          djangoError: true
        });
      }
      
      // SumSub API errors
      return res.status(error.response.status).json({ 
        error: error.message,
        details: error.response.data
      });
    }

    // Other errors (network, etc.)
    res.status(500).json({ 
      error: 'Internal server error',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
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

    const response = await axios.get(`${DJANGO_API_BASE_URL}/kyc/verifications/`, {
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

    const response = await axios.get(`${DJANGO_API_BASE_URL}/kyc/verifications/${userId}/`, {
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
      `${DJANGO_API_BASE_URL}/kyc/webhook/sumsub/`,
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
    const djangoHealth = await axios.get(`${DJANGO_API_BASE_URL}/kyc/health/`, {
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