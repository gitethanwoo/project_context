import crypto from 'crypto';
import { handleTranscriptCompleted } from './notification/handlers/recording-transcript';

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
  const payload = JSON.parse(rawBody) as ZoomWebhookPayload;

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
        await handleTranscriptCompleted({ 
          object: {
            ...payload.payload.object,
            recording_files: payload.payload.object.recording_files
          }
        });
        break;
        
      default:
        console.log('Unhandled event type:', payload.event);
    }

    return new Response(JSON.stringify({ status: 'success' }), { 
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
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