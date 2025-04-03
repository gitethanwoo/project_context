import { WebClient } from '@slack/web-api';

interface TranscriptFile {
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
}

interface TranscriptPayload {
  object: {
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
    recording_files: TranscriptFile[];
  };
}

// Initialize Slack client
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

async function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function downloadTranscriptWithRetry(downloadUrl: string, downloadToken: string | undefined, maxRetries = 3): Promise<string> {
  console.log('Attempting to download transcript with:', {
    url: downloadUrl,
    hasDownloadToken: !!downloadToken
  });

  if (!downloadToken) {
    throw new Error('No download token provided in webhook');
  }

  let lastError;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // Add download token to URL
      const urlWithToken = `${downloadUrl}${downloadUrl.includes('?') ? '&' : '?'}access_token=${downloadToken}`;
      console.log(`Download attempt ${attempt + 1}, URL:`, urlWithToken);

      const response = await fetch(urlWithToken);

      console.log('Response status:', response.status);
      console.log('Response headers:', Object.fromEntries(response.headers.entries()));

      if (!response.ok) {
        throw new Error(`Failed to download transcript: ${response.status} ${response.statusText}`);
      }

      const contentType = response.headers.get('content-type');
      console.log('Content-Type:', contentType);

      const text = await response.text();
      console.log('Response preview:', text.substring(0, 200));

      // Check if we got HTML instead of transcript text
      if (contentType?.includes('text/html') || text.toLowerCase().includes('<!doctype html>')) {
        console.error('Received HTML instead of transcript text. URL might be expired or invalid.');
        throw new Error('Invalid transcript response format');
      }

      return text;
    } catch (error) {
      lastError = error;
      const waitTime = Math.pow(2, attempt) * 1000;
      console.log(`Attempt ${attempt + 1} failed:`, error);
      console.log(`Waiting ${waitTime}ms before retry...`);
      await delay(waitTime);
    }
  }

  throw lastError || new Error('Failed to download transcript after all retries');
}

export async function handleTranscriptCompleted(payload: TranscriptPayload, downloadToken?: string) {
  try {
    const { object } = payload;
    
    // Log the webhook payload for debugging
    console.log('Processing transcript webhook:', {
      meetingId: object.id,
      topic: object.topic,
      hostEmail: object.host_email,
      recordingFiles: object.recording_files.length,
      hasDownloadToken: !!downloadToken
    });
    
    // Find the transcript file
    const transcriptFile = object.recording_files.find(
      file => file.recording_type === 'audio_transcript'
    );

    if (!transcriptFile) {
      console.error('No transcript file found in payload');
      return;
    }

    console.log('Found transcript file:', {
      fileId: transcriptFile.id,
      meetingId: transcriptFile.meeting_id,
      fileType: transcriptFile.file_type,
      fileSize: transcriptFile.file_size,
      downloadUrl: transcriptFile.download_url
    });

    // Download the transcript with retry logic
    console.log('Attempting to download transcript...');
    const transcript = await downloadTranscriptWithRetry(transcriptFile.download_url, downloadToken);
    
    // For testing: only send to ethan@servant.io
    if (object.host_email !== 'ethan@servant.io') {
      console.log('Skipping Slack message - not test user:', object.host_email);
      return;
    }
    
    // Look up user in Slack by email
    try {
      const slackResponse = await slack.users.lookupByEmail({
        email: object.host_email
      });
      
      if (slackResponse.ok && slackResponse.user && slackResponse.user.id) {
        // Send DM to user
        await slack.chat.postMessage({
          channel: slackResponse.user.id,
          text: `Your meeting transcript for "${object.topic || 'Untitled Meeting'}" is ready!\n\n${transcript}`
        });
        
        console.log('Successfully sent transcript to user:', object.host_email);
      } else {
        console.error('Could not find Slack user for email:', object.host_email);
      }
    } catch (error) {
      console.error('Error sending Slack message:', error);
    }
    
  } catch (error) {
    console.error('Error handling transcript completed event:', error);
    throw error;
  }
} 