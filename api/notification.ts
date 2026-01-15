import crypto from 'crypto';
import { handleTranscriptCompleted } from '../lib/recording-transcript';
import { waitUntil } from '@vercel/functions';

// Types for Zoom webhook payloads
interface ZoomWebhookPayload {
  event: string;
  payload: {
    plainToken?: string;
    object?: {
      id: string;
      uuid: string;
      host_id: string;
      account_id: string;
      topic: string;
      type: number;
      start_time: string;
      timezone: string;
      host_email: string;
      duration: number;
      recording_count?: number;
      recording_files?: Array<{
        id: string;
        meeting_id: string;
        recording_start: string;
        recording_end: string;
        file_type: string;
        file_size: number;
        play_url: string;
        download_url: string;
        status: string;
        recording_type: string;
      }>;
    };
  };
  download_token?: string;
}

export async function POST(request: Request) {
  const rawBody = await request.text();
  const webhookSecret = process.env.ZOOM_WEBHOOK_SECRET_TOKEN;
  const signature = request.headers.get('x-zm-signature');
  const timestamp = request.headers.get('x-zm-request-timestamp');

  if (!webhookSecret) {
    return new Response(JSON.stringify({ error: 'Server configuration error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (!signature || !timestamp) {
    return new Response(JSON.stringify({ error: 'Missing Zoom webhook signature headers' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const message = `v0:${timestamp}:${rawBody}`;
  const hashForVerify = crypto.createHmac('sha256', webhookSecret).update(message).digest('hex');
  const expectedSignature = `v0=${hashForVerify}`;
  const expectedBuffer = Buffer.from(expectedSignature);
  const signatureBuffer = Buffer.from(signature);
  const isValidSignature = expectedBuffer.length === signatureBuffer.length
    && crypto.timingSafeEqual(expectedBuffer, signatureBuffer);

  if (!isValidSignature) {
    return new Response(JSON.stringify({ error: 'Invalid Zoom webhook signature' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const payload = JSON.parse(rawBody) as ZoomWebhookPayload & { status?: string };

  // Debug logging - only essential info
  console.log('=== Zoom Webhook Received ===');
  console.log('Event:', payload.event);
  console.log('Status:', payload.status);
  if (payload.payload?.object) {
    console.log('Meeting:', {
      id: payload.payload.object.id,
      topic: payload.payload.object.topic,
      host: payload.payload.object.host_email,
      files: payload.payload.object.recording_files?.length || 0
    });
  }
  console.log('=== End Webhook Info ===');

  // Reject failed webhook attempts (status -1 or 500)
  if (payload.status === '-1' || payload.status === '500') {
    console.log(`Rejecting failed webhook attempt (status: ${payload.status})`);
    return new Response('Rejected failed webhook', { status: 200 });
  }

  try {
    // Handle Zoom's webhook verification challenge
    if (payload.event === 'endpoint.url_validation') {
      if (!payload.payload?.plainToken) {
        return new Response(JSON.stringify({ error: 'Invalid payload' }), { 
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const plainToken = payload.payload.plainToken;
      const hashForValidation = crypto
        .createHmac('sha256', webhookSecret)
        .update(plainToken)
        .digest('hex');

      return new Response(JSON.stringify({
        plainToken: plainToken,
        encryptedToken: hashForValidation
      }), { 
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Handle actual webhook events
    if (!payload.event || !payload.payload) {
      return new Response(JSON.stringify({ error: 'Invalid webhook payload' }), { 
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Handle different event types
    switch (payload.event) {
      case 'recording.transcript_completed':
        if (!payload.payload.object || !payload.payload.object.recording_files) {
          return new Response(JSON.stringify({ error: 'Invalid transcript payload' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        // Call handler and keep the function alive until it finishes
        waitUntil(
          handleTranscriptCompleted({
            object: {
              ...payload.payload.object,
              recording_files: payload.payload.object.recording_files
            }
          },
          payload.download_token // Pass the download token to the handler
          ).catch(error => {
            // Log errors from the async handler
            console.error('Error in background transcript processing:', error);
            // Optionally, you could add more robust error reporting here
          })
        );

        // Respond immediately to Zoom
        return new Response(JSON.stringify({ status: 'success' }), { 
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
        
      default:
        console.log('Unhandled event type:', payload.event);
        // Return success for unhandled events as well, just acknowledge receipt
        return new Response(JSON.stringify({ status: 'success - unhandled event' }), { 
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
    }

    // This point should ideally not be reached if all cases return a response
    // but as a fallback:
    /* 
    return new Response(JSON.stringify({ status: 'success - fallback' }), { 
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
    */
  } catch (error) {
    console.error('Error processing webhook:', error);
    return new Response(JSON.stringify({ 
      error: 'Internal server error',
      details: error instanceof Error ? error.message : 'Unknown error'
    }), { 
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
} 
