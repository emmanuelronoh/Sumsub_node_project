import express from 'express';
import cors from 'cors';
import axios from 'axios';
import {
  generate,
  reGenerate,
  handleWebhookEvent,
  verifyWebhookSignature
} from './src/SumsubApiClient.js';

const app = express();
const port = process.env.PORT || 3001;
const DJANGO_API_BASE_URL = process.env.DJANGO_API_BASE_URL || 'http://localhost:8000/api';

// Webhook processing
app.post('/sumsub-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const rawBody = req.body;
    const receivedSignature = req.headers['x-payload-digest'];
    const webhookSecret = process.env.SUMSUB_WEBHOOK_SECRET;

    if (process.env.DEBUG_WEBHOOK === 'true') {
      console.warn('⚠️ Webhook verification bypassed for debugging');
      const parsed = JSON.parse(rawBody.toString());
      const result = await handleWebhookEvent(parsed);

      // Send to Django
      await axios.post(`${DJANGO_API_BASE_URL}/verifications/`, result);
      return res.status(200).send('Webhook received (debug mode)');
    }

    const isValid = await verifyWebhookSignature(rawBody, receivedSignature, webhookSecret);
    if (!isValid) {
      throw new Error('Invalid webhook signature');
    }

    const payload = JSON.parse(rawBody.toString());
    const result = await handleWebhookEvent(payload);

    // Send to Django
    await axios.post(`${DJANGO_API_BASE_URL}/verifications/`, result);
    
    res.status(200).send('Webhook received');
  } catch (error) {
    console.error('❌ Webhook error:', {
      message: error.message,
      stack: error.stack,
      headers: req.headers,
      body: req.body.toString?.() || req.body
    });
    res.status(400).json({
      error: error.message,
      details: 'Check server logs for more info'
    });
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Sumsub link generation
app.post('/api/generate-sumsub-link', async (req, res) => {
  try {
    const { userId, levelName } = req.body;
    const url = await generate(userId, levelName);
    res.json({ url });
  } catch (error) {
    console.error('Error generating SumSub link:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/regenerate-sumsub-link', async (req, res) => {
  try {
    const { userId, levelName } = req.body;
    const url = await reGenerate(userId, levelName);
    res.json({ url });
  } catch (error) {
    console.error('Error regenerating SumSub link:', error);
    res.status(500).json({ error: error.message });
  }
});

// Admin endpoints (proxy to Django)
app.get('/admin/verifications', async (req, res) => {
  try {
    const response = await axios.get(`${DJANGO_API_BASE_URL}/verifications/`);
    res.json({ verifications: response.data });
  } catch (error) {
    console.error('Error fetching verifications:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/admin/verifications/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const response = await axios.get(`${DJANGO_API_BASE_URL}/verifications/${userId}/`);
    res.json({ verification: response.data });
  } catch (error) {
    console.error('Error fetching verification:', error);
    res.status(500).json({ error: error.message });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy' });
});

app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
  console.log(`🔍 Webhook debug mode: ${process.env.DEBUG_WEBHOOK === 'true' ? 'ON' : 'OFF'}`);
  console.log(`🔒 Webhook endpoint: /sumsub-webhook`);
  console.log(`👨‍💼 Admin endpoints:`);
  console.log(`   - GET /admin/verifications`);
  console.log(`   - GET /admin/verifications/:userId`);
});
