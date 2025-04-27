import crypto from 'crypto';
import { handleTranscriptCompleted } from '../lib/recording-transcript';

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
      const secret = process.env.ZOOM_WEBHOOK_SECRET_TOKEN;
      
      if (!secret) {
        return new Response(JSON.stringify({ error: 'Server configuration error' }), { 
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const hashForValidation = crypto
        .createHmac('sha256', secret)
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
        
        // Respond immediately to Zoom to prevent retries
        // The actual processing will happen asynchronously
        const response = new Response(JSON.stringify({ status: 'success' }), { 
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });

        // Call handler asynchronously (fire and forget)
        handleTranscriptCompleted({ 
          object: {
            ...payload.payload.object,
            recording_files: payload.payload.object.recording_files
          }
        },
        payload.download_token // Pass the download token to the handler
        ).catch(error => {
          // Log errors from the async handler, but don't block the response
          console.error('Error in background transcript processing:', error);
        });

        return response; // Return the immediate response
        
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