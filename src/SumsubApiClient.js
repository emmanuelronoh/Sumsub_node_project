import crypto from 'crypto';
import fetch from 'node-fetch';
import FormData from 'form-data';
import dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();
const DJANGO_API_BASE_URL = process.env.DJANGO_API_BASE_URL;

dotenv.config();

const SUMSUB_APP_TOKEN = process.env.SUMSUB_APP_TOKEN;
const SUMSUB_SECRET_KEY = process.env.SUMSUB_SECRET_KEY;
const SUMSUB_BASE_URL = process.env.SUMSUB_BASE_URL;
const SUMSUB_WEBHOOK_SECRET = process.env.SUMSUB_WEBHOOK_SECRET;

// Cache for storing verification statuses (replace with Redis in production)
const verificationCache = new Map();

function createSignature(url, method, data = null) {
    const ts = Math.floor(Date.now() / 1000);
    const signature = crypto.createHmac('sha256', SUMSUB_SECRET_KEY);
    signature.update(`${ts}${method.toUpperCase()}${url}`);

    if (data instanceof FormData) {
        signature.update(data.getBuffer());
    } else if (data) {
        signature.update(JSON.stringify(data));
    }

    return {
        'X-App-Access-Ts': ts,
        'X-App-Access-Sig': signature.digest('hex'),
        'X-App-Token': SUMSUB_APP_TOKEN,
        'Accept': 'application/json',
        'Content-Type': data instanceof FormData ? data.getHeaders()['content-type'] : 'application/json'
    };
}

async function sumsubRequest(url, method, body = null) {
    // Add URL validation
    if (!url) {
        throw new Error('Request URL cannot be empty');
    }

    const headers = createSignature(url, method, body);
    const options = {
        method,
        headers,
        timeout: 15000
    };

    if (body) {
        options.body = body instanceof FormData ? body : JSON.stringify(body);
    }

    try {
        const fullUrl = SUMSUB_BASE_URL + url;
        console.log(`Making SumSub request to: ${method} ${fullUrl}`);

        const response = await fetch(fullUrl, options);

        if (!response.ok) {
            let errorData;
            try {
                errorData = await response.json();
            } catch (e) {
                errorData = { description: await response.text() };
            }

            const error = new Error(`Sumsub API error: ${response.status} - ${errorData.description || 'Unknown error'}`);
            error.status = response.status;
            error.response = errorData;
            throw error;
        }

        return await response.json();
    } catch (error) {
        console.error(`Sumsub API request failed: ${method} ${url}`, {
            error: error.message,
            stack: error.stack
        });
        throw error;
    }
}

async function getWebSDKLink(levelName, userId, options = {}) {
    const url = `/resources/sdkIntegrations/levels/${encodeURIComponent(levelName)}/websdkLink`;
    const requestBody = {
        externalUserId: userId,
        ...options
    };

    console.log(`Creating WebSDK link for ${userId} with level ${levelName}`);
    const response = await sumsubRequest(url, 'POST', requestBody);

    // Cache the verification URL
    verificationCache.set(userId, {
        url: response.url,
        createdAt: new Date(),
        levelName,
        status: 'pending'
    });

    return response;
}

async function storeFailedWebhook(payload) {
    console.warn('Storing failed webhook for retry:', {
      type: payload.type,
      applicantId: payload.applicantId,
      timestamp: new Date().toISOString()
    });
    // TODO: Implement actual storage (e.g., save to database or queue)
    return Promise.resolve(); // Temporary fix
  }

async function resetUserProfile(userId) {
    if (!userId) {
        throw new Error('User ID is required for profile reset');
    }

    const url = `/resources/applicants/${encodeURIComponent(userId)}/reset`;
    const response = await sumsubRequest(url, 'POST');

    // Clear cache for this user
    verificationCache.delete(userId);

    return response;
}

async function checkUserStatus(userId) {
    const url = `/resources/applicants/-;externalUserId=${encodeURIComponent(userId)}/one`;
    const response = await sumsubRequest(url, 'GET');

    // Update cache with latest status
    if (verificationCache.has(userId)) {
        verificationCache.set(userId, {
            ...verificationCache.get(userId),
            status: response.reviewStatus || 'unknown',
            lastChecked: new Date()
        });
    }

    return response;
}

async function getApplicantDocs(userId) {
    const url = `/resources/applicants/-;externalUserId=${encodeURIComponent(userId)}/requiredIdDocsStatus`;
    return await sumsubRequest(url, 'GET');
}

async function verifyWebhookSignature(rawBody, receivedSignature, webhookSecret = SUMSUB_WEBHOOK_SECRET) {
    if (!webhookSecret) {
        console.warn('⚠️ Webhook verification skipped - no secret key set');
        return true;
    }

    if (!receivedSignature) {
        console.error('⚠️ Missing x-payload-digest header');
        throw new Error('Missing x-payload-digest header');
    }

    try {
        const payload = rawBody.toString();
        const computedDigest = crypto
            .createHmac('sha256', webhookSecret)
            .update(payload)
            .digest('hex');

        // Secure comparison
        const receivedBuffer = Buffer.from(receivedSignature, 'utf8');
        const computedBuffer = Buffer.from(computedDigest, 'utf8');

        if (receivedBuffer.length !== computedBuffer.length ||
            !crypto.timingSafeEqual(receivedBuffer, computedBuffer)) {
            console.error(`Signature verification failed:
                Received: ${receivedSignature}
                Computed: ${computedDigest}
            `);
            throw new Error('Invalid webhook signature');
        }

        return true;
    } catch (error) {
        console.error('Error during signature verification:', error);
        throw error;
    }
}


async function handleWebhookEvent(event) {
    console.log('Processing SumSub webhook event:', event.type);
    
    const { type, applicantId, reviewResult } = event;
    const externalUserId = applicantId.split(';externalUserId=')[1] || applicantId;
    
    // Forward the webhook event to Django API
    try {
        const response = await axios.post(`${DJANGO_API_BASE_URL}webhook/`, {
            type,
            applicantId,
            externalUserId,
            reviewStatus: reviewResult?.reviewStatus,
            reviewResult
        });

        console.log('Webhook forwarded successfully:', response.status);

        // Process the response and handle your business logic
        if (response.status === 200) {
            console.log('Event processed successfully by Django');

            // Cache the verification data for local processing or quick lookup
            const verificationData = {
                applicantId,
                externalUserId,
                eventType: type,
                status: reviewResult?.reviewStatus || 'unknown',
                receivedAt: new Date(),
                details: event
            };

            verificationCache.set(externalUserId, verificationData);

            // Process the event based on the type
            switch (type) {
                case 'applicantReviewed':
                    console.log(`Applicant ${externalUserId} reviewed with status: ${reviewResult?.reviewStatus}`);
                    // Add your business logic here for approved/rejected cases
                    if (reviewResult?.reviewStatus === 'completed') {
                        // Handle successful verification
                        console.log(`Verification completed for ${externalUserId}`);
                        // Additional logic for completed status (e.g., notify, update system, etc.)
                    } else if (reviewResult?.reviewStatus === 'rejected') {
                        // Handle rejected verification
                        console.log(`Verification rejected for ${externalUserId}`);
                        // Additional logic for rejected status (e.g., notify, log, etc.)
                    }
                    break;
                
                case 'applicantPending':
                    console.log(`Applicant ${externalUserId} is pending review`);
                    break;
                
                case 'applicantCreated':
                    console.log(`New applicant created: ${externalUserId}`);
                    break;
                
                case 'applicantOnHold':
                    console.log(`Applicant ${externalUserId} verification on hold`);
                    break;
                
                default:
                    console.log(`Unhandled event type: ${type}`);
            }

            return {
                status: 'processed',
                djangoResponse: response.data
            };
        }

    } catch (error) {
        console.error('Error forwarding webhook:', error.message);

        // Store the failed webhook event for retry
        await storeFailedWebhook({
            type,
            applicantId,
            externalUserId,
            reviewResult,
            timestamp: new Date().toISOString()
        });
        
        throw error; // rethrow the error so it can be handled upstream
    }
}



// SumsubApiClient.js
async function generate(userId, levelName = 'basic-kyc') {
    try {
        // First create verification record in Django
        const djangoResponse = await axios.post(
            `${DJANGO_API_BASE_URL}verifications/`,
            {
                user_id: userId,
                level_name: levelName
            },
            {
                headers: {
                    'Authorization': `Bearer ${process.env.DJANGO_SERVICE_TOKEN}`
                }
            }
        );

        const applicantId = djangoResponse.data.applicant_id;
        
        // Now get SumSub link with this applicantId
        const response = await getWebSDKLink(levelName, userId, {
            externalUserId: applicantId,  // Pass our internal ID to SumSub
            lang: 'en',
            fixedFlow: true
        });
        
        return response.url;
    } catch (error) {
        console.error("Error generating verification link:", error);
        throw error;
    }
}

async function reGenerate(userId, levelName = 'basic-kyc') {
    try {
        if (!userId) {
            throw new Error('User ID is required for regeneration');
        }

        console.log(`Attempting to regenerate verification for user: ${userId}`);

        // Reset existing verification first
        await resetUserProfile(userId);

        // Generate new link
        const response = await getWebSDKLink(levelName, userId);
        return response.url;
    } catch (error) {
        console.error("Error regenerating verification link:", error);
        throw error;
    }
}

// Additional utility functions
async function getVerificationStatus(userId) {
    if (verificationCache.has(userId)) {
        return verificationCache.get(userId);
    }
    return await checkUserStatus(userId);
}

async function getVerificationHistory(userId) {
    const url = `/resources/applicants/-;externalUserId=${encodeURIComponent(userId)}/status`;
    return await sumsubRequest(url, 'GET');
}

export {
    generate,
    reGenerate,
    verifyWebhookSignature,
    handleWebhookEvent,
    checkUserStatus,
    resetUserProfile,
    getApplicantDocs,
    getVerificationStatus,
    getVerificationHistory
};