import { WebClient } from '@slack/web-api';
import { generateSummaryBasic } from './generate-summary';
import { cleanVTTTranscript } from './transcript-utils';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Initialize Supabase client
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
const supabase: SupabaseClient = createClient(supabaseUrl, supabaseKey);

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
  if (!downloadToken) {
    throw new Error('No download token provided in webhook');
  }

  let lastError;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // Add download token to URL
      const urlWithToken = `${downloadUrl}${downloadUrl.includes('?') ? '&' : '?'}access_token=${downloadToken}`;
      
      if (attempt > 0) {
        console.log(`Retry attempt ${attempt + 1}/${maxRetries}...`);
      }

      const response = await fetch(urlWithToken);

      if (!response.ok) {
        throw new Error(`Failed to download transcript: ${response.status} ${response.statusText}`);
      }

      const contentType = response.headers.get('content-type');
      const text = await response.text();

      // Check if we got HTML instead of transcript text
      if (contentType?.includes('text/html') || text.toLowerCase().includes('<!doctype html>')) {
        throw new Error('Invalid transcript response format');
      }

      return text;
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries - 1) {
        const waitTime = Math.pow(2, attempt) * 1000;
        await delay(waitTime);
      }
    }
  }

  throw lastError || new Error('Failed to download transcript after all retries');
}

function formatTime(isoString: string): string {
  const date = new Date(isoString);
  // Convert to EST (UTC-4)
  const estDate = new Date(date.getTime() - (4 * 60 * 60 * 1000));
  return `${estDate.toLocaleTimeString('en-US', { 
    hour: 'numeric',
    minute: '2-digit',
    hour12: true 
  })} EST`;
}

export async function handleTranscriptCompleted(payload: TranscriptPayload, downloadToken?: string) {
  try {
    const { object } = payload;
    
    // Find the transcript file
    const transcriptFile = object.recording_files.find(
      file => file.recording_type === 'audio_transcript'
    );

    if (!transcriptFile) {
      console.error('No transcript file found in payload');
      return;
    }

    // First, check if we already have a transcript with this recording time
    const { data: existingTranscripts } = await supabase
      .from('transcripts')
      .select('id')
      .eq('recording_start', new Date(transcriptFile.recording_start))
      .eq('recording_end', new Date(transcriptFile.recording_end));
      
    if (existingTranscripts && existingTranscripts.length > 0) {
      // We already processed this transcript
      console.log(`Skipping duplicate webhook for meeting "${object.topic}" - transcript already exists`);
      return;
    }
    
    // Check if this meeting already exists in our database
    let { data: existingMeeting } = await supabase
      .from('meetings')
      .select('id')
      .eq('zoom_meeting_id', object.id)
      .single();

    let meetingId: number | undefined;

    if (!existingMeeting) {
      // Create a new meeting record
      const { data: newMeeting, error: meetingError } = await supabase
        .from('meetings')
        .insert({
          zoom_meeting_id: object.id,
          zoom_user_id: object.host_id,
          topic: object.topic,
          start_time: new Date(object.start_time),
          duration: object.duration
        })
        .select('id')
        .single();

      if (meetingError) {
        console.error('Error creating meeting record:', meetingError);
        // Continue with process, as we still want to send the summary
      } else if (newMeeting) {
        meetingId = newMeeting.id;
      }
    } else {
      meetingId = existingMeeting.id;
    }

    // Process the transcript
    console.log(`Processing transcript for meeting "${object.topic}"...`);
    const rawTranscript = await downloadTranscriptWithRetry(transcriptFile.download_url, downloadToken);
    
    // Clean the VTT transcript
    const cleanedTranscript = cleanVTTTranscript(rawTranscript);
    
    // Generate summary
    console.log('Generating summary...');
    const summary = await generateSummaryBasic(cleanedTranscript);
    
    // Save to database if we have a meeting ID
    if (meetingId) {
      const transcriptData = {
        meeting_id: meetingId,
        recording_start: new Date(transcriptFile.recording_start),
        recording_end: new Date(transcriptFile.recording_end),
        file_type: transcriptFile.file_type,
        download_url: transcriptFile.download_url,
        transcript_status: 'completed',
        transcript_content: {
          raw: rawTranscript,
          cleaned: cleanedTranscript,
          summary: summary
        }
      };
      
      await supabase
        .from('transcripts')
        .insert(transcriptData);
        
      console.log(`Transcript saved to database for meeting "${object.topic}"`);
    }
    
    // For testing: only send to ethan@servant.io and joe@servant.io
    if (!['ethan@servant.io', 'joe@servant.io', 'jake@servant.io', 'arlene@servant.io'].includes(object.host_email)) {
      console.log('Skipping Slack message - not test user:', object.host_email);
      return;
    }
    
    // Look up user in Slack by email
    try {
      const slackResponse = await slack.users.lookupByEmail({
        email: object.host_email
      });
      
      if (slackResponse.ok && slackResponse.user && slackResponse.user.id) {
        const startTime = formatTime(transcriptFile.recording_start);
        const endTime = formatTime(transcriptFile.recording_end);
        
        await slack.chat.postMessage({
          channel: slackResponse.user.id,
          text: `Here's a summary of your call\nMeeting Name: ${object.topic || 'Untitled Meeting'}\nTime: From ${startTime} to ${endTime}\n\n${summary}\n\nNote: Only you can see this as the meeting host. Please share with the channel for context!`
        });
        
        console.log(`Summary sent to ${object.host_email}`);
      } else {
        console.error('Could not find Slack user for email:', object.host_email);
      }
    } catch (error) {
      console.error('Error sending Slack message:', error);
    }
    
  } catch (error) {
    console.error('Error handling transcript:', error);
    throw error;
  }
} 