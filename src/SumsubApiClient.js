import crypto from 'crypto';
import fetch from 'node-fetch';
import FormData from 'form-data';
import dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();

const SUMSUB_APP_TOKEN = process.env.SUMSUB_APP_TOKEN;
const SUMSUB_SECRET_KEY = process.env.SUMSUB_SECRET_KEY;
const SUMSUB_BASE_URL = process.env.SUMSUB_BASE_URL;
const SUMSUB_WEBHOOK_SECRET = process.env.SUMSUB_WEBHOOK_SECRET;
const DJANGO_API_BASE_URL = process.env.DJANGO_API_BASE_URL;

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
    console.log('Processing SumSub webhook event:', {
        type: event.type,
        applicantId: event.applicantId,
        timestamp: new Date().toISOString()
    });

    const { type, applicantId, reviewResult = {}, inspectionId } = event;
    const externalUserId = applicantId.includes(';externalUserId=')
        ? applicantId.split(';externalUserId=')[1]
        : applicantId;

    // Enhanced payload construction
    const webhookPayload = {
        // Core identification fields
        type,
        applicantId,
        externalUserId,
        inspectionId,

        // Status information
        reviewStatus: reviewResult?.reviewStatus || 'pending',
        reviewResult,

        // Additional metadata
        levelName: reviewResult?.levelName || 'kyc_verification',
        createdAt: new Date().toISOString(),

        // Original event for debugging
        originalEvent: event
    };

    try {
        console.log('Forwarding webhook to Django with payload:', {
            type: webhookPayload.type,
            applicantId: webhookPayload.applicantId,
            reviewStatus: webhookPayload.reviewStatus
        });

        const response = await axios.post(
            `${DJANGO_API_BASE_URL}/kyc/webhook/sumsub/`, // Uses the env variable
            webhookPayload,

            {
                headers: {
                    'Authorization': `Bearer ${process.env.DJANGO_SERVICE_TOKEN}`,
                    'Content-Type': 'application/json',
                    'X-Webhook-Source': 'sumsub-node-proxy'
                },
                timeout: 40000 // 40 seconds timeout
            }
        );

        console.log('Webhook forwarded successfully. Django response:', {
            status: response.status,
            data: response.data
        });

        // Cache verification data with enhanced structure
        const verificationData = {
            ...webhookPayload,
            djangoResponse: response.data,
            processedAt: new Date().toISOString()
        };

        verificationCache.set(externalUserId, verificationData);
        console.log(`Cached verification data for ${externalUserId}`);

        // Enhanced event processing with better logging
        await processWebhookEvent(type, externalUserId, reviewResult?.reviewStatus, event);

        return {
            status: 'processed',
            djangoResponse: response.data,
            verificationData
        };

    } catch (error) {
        const errorDetails = {
            message: error.message,
            stack: error.stack,
            response: error.response?.data,
            payload: webhookPayload,
            timestamp: new Date().toISOString()
        };

        console.error('Webhook processing failed:', errorDetails);

        // Enhanced failed webhook storage
        await storeFailedWebhook({
            ...webhookPayload,
            error: errorDetails,
            retryCount: 0
        });

        // Throw enriched error
        const processingError = new Error(`Webhook processing failed: ${error.message}`);
        processingError.details = errorDetails;
        throw processingError;
    }
}

// Extracted event processor for better organization
async function processWebhookEvent(type, externalUserId, reviewStatus, originalEvent) {
    const logPrefix = `[${type.toUpperCase()}] ${externalUserId}`;

    try {
        console.log(`${logPrefix} - Processing event`);

        switch (type) {
            case 'applicantReviewed':
                console.log(`${logPrefix} - Review status: ${reviewStatus}`);

                if (reviewStatus === 'completed') {
                    await handleCompletedVerification(externalUserId, originalEvent);
                } else if (reviewStatus === 'rejected') {
                    await handleRejectedVerification(externalUserId, originalEvent);
                }
                break;

            case 'applicantPending':
                console.log(`${logPrefix} - Verification pending`);
                await handlePendingVerification(externalUserId, originalEvent);
                break;

            case 'applicantCreated':
                console.log(`${logPrefix} - New applicant created`);
                await handleNewApplicant(externalUserId, originalEvent);
                break;

            case 'applicantOnHold':
                console.log(`${logPrefix} - Verification on hold`);
                await handleOnHoldVerification(externalUserId, originalEvent);
                break;

            default:
                console.warn(`${logPrefix} - Unhandled event type`);
                await handleUnknownEvent(type, externalUserId, originalEvent);
        }

        console.log(`${logPrefix} - Event processed successfully`);
    } catch (error) {
        console.error(`${logPrefix} - Event processing failed:`, error);
        throw error;
    }
}

// Example handler functions (implement according to your needs)
async function handleCompletedVerification(userId, event) {
    // Add your business logic for completed verifications
    console.log(`Handling completed verification for ${userId}`);
    // Example: Notify user, update systems, etc.
}

async function handleRejectedVerification(userId, event) {
    // Add your business logic for rejected verifications
    console.log(`Handling rejected verification for ${userId}`);
    const reasons = event.reviewResult?.rejectLabels?.join(', ') || 'unknown';
    console.log(`Rejection reasons: ${reasons}`);
    // Example: Notify user, log rejection reasons, etc.
}

// Add this handler function to SumsubApiClient.js
async function handleNewApplicant(userId, event) {
    try {
        const response = await axios.post(
            `${DJANGO_API_BASE_URL}/kyc/verifications/initiate/`,
            { /* payload */ },
            {
                headers: {
                    'Authorization': `Bearer ${process.env.DJANGO_SERVICE_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        );
        
        if (response.status === 401) {
            throw new Error('Invalid Django service token - check .env configuration');
        }
        
        return response.data;
    } catch (error) {
        console.error(`Auth failed for ${userId}:`, {
            error: error.message,
            status: error.response?.status,
            data: error.response?.data
        });
        throw error;
    }
}
// Enhanced failed webhook storage
async function storeFailedWebhook(failedWebhook) {
    console.warn('Storing failed webhook for retry:', {
        type: failedWebhook.type,
        applicantId: failedWebhook.applicantId,
        timestamp: failedWebhook.timestamp
    });

    // Implement your storage logic here (database, queue, etc.)
    // Example pseudo-code:
    /*
    const storageResult = await failedWebhookQueue.add({
        ...failedWebhook,
        lastAttempt: new Date(),
        retryCount: (failedWebhook.retryCount || 0) + 1
    });
    */

    // For now, we'll just log it
    return { status: 'logged', webhook: failedWebhook };
}


// In your generate function
async function generate(userId, levelName = 'kyc_verification') {
    try {
        // Use format "user_123" as externalUserId
        const externalUserId = `user_${userId}`;
        
        const response = await getWebSDKLink(levelName, externalUserId, {
            lang: 'en',
            fixedFlow: true
        });
        return response.url;
    } catch (error) {
        console.error("Error generating verification link:", error);
        throw error;
    }
}

async function reGenerate(userId, levelName = 'kyc_verification') {
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