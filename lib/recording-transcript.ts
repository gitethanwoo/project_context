import { WebClient } from '@slack/web-api';
import { generateSummaryWithRelevance } from './generate-summary';
import { cleanVTTTranscript } from './transcript-utils';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { generateComprehensiveAnalysis, extractParticipantsFromCleanedText } from './transcript-analysis';

// Initialize Supabase client
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''; // Use service role key for server-side operations
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

    // Check if this SPECIFIC meeting instance already exists in our database
    // Using both zoom_meeting_id AND zoom_meeting_uuid to differentiate between PMR instances
    let { data: existingMeeting, error: meetingCheckError } = await supabase
      .from('meetings')
      .select('id')
      .eq('zoom_meeting_id', object.id)
      .eq('zoom_meeting_uuid', object.uuid) // Add UUID check to identify unique meeting instances
      .single();

    // Log errors from meeting check, but treat expected 'no rows' (PGRST116) differently
    if (meetingCheckError) {
      if (meetingCheckError.code === 'PGRST116') {
        // This is expected when the meeting doesn't exist yet
        console.log(`Meeting check: No existing meeting found for id=${object.id}, uuid=${object.uuid}. Proceeding to create.`);
      } else {
        // Log other unexpected errors
        console.error('Supabase error checking for existing meeting:', meetingCheckError);
        // Potentially return here if the error is critical
      }
    }

    let meetingId: number | undefined;

    if (!existingMeeting) {
      // Create a new meeting record
      const { data: newMeeting, error: meetingError } = await supabase
        .from('meetings')
        .insert({
          zoom_meeting_id: object.id,
          zoom_meeting_uuid: object.uuid, // Store the UUID to identify this specific meeting instance
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
    
    // Double-check for duplicates before processing transcript
    if (meetingId) {
      const { data: finalCheck, error: finalCheckError } = await supabase
        .from('transcripts')
        .select('id')
        .eq('meeting_id', meetingId)
        .eq('recording_start', transcriptFile.recording_start)
        .eq('recording_end', transcriptFile.recording_end);
        
      // Log any error from the final transcript check
      if (finalCheckError) {
        console.warn('Supabase error during final transcript check:', finalCheckError);
        // Decide if we should return or continue; for now, let's continue
      }
        
      if (finalCheck && finalCheck.length > 0) {
        console.log(`Duplicate detected during final check for meeting "${object.topic}" - skipping processing`);
        return;
      }
    }

    // Process the transcript
    console.log(`Processing transcript for meeting "${object.topic}"...`);
    const rawTranscript = await downloadTranscriptWithRetry(transcriptFile.download_url, downloadToken);
    
    // Clean the VTT transcript
    const cleanedTranscript = cleanVTTTranscript(rawTranscript);
    
    // Generate summary
    console.log('Generating summary...');
    const { summary, isRelevant, reasoning } = await generateSummaryWithRelevance(cleanedTranscript);

    if (!isRelevant) {
      console.log('Transcript deemed NOT relevant (from summary call). Reason:', reasoning);
      return; // Skip DB insert and Slack DM
    }

    // -----------------------------
    // New: extract structured metadata (meeting type, participants, projects, clients)
    // -----------------------------
    console.log('Extracting metadata...');
    const extractedParticipants = extractParticipantsFromCleanedText(cleanedTranscript);
    const analysis = await generateComprehensiveAnalysis({
      summary,
      cleanedTranscript,
      participants: extractedParticipants,
    });

    // Save to database if we have a meeting ID
    if (meetingId) {
      const transcriptData = {
        meeting_id: meetingId,
        recording_start: transcriptFile.recording_start,
        recording_end: transcriptFile.recording_end,
        download_url: transcriptFile.download_url,
        transcript_status: 'completed',
        transcript_content: {
          raw: rawTranscript,
          cleaned: cleanedTranscript,
        },
        summary: summary, // Dedicated column for easier querying
        extracted_participants: extractedParticipants,
        is_relevant: isRelevant,
        relevance_reasoning: reasoning,
        meeting_type: analysis.meetingType,
        external_participants: analysis.identifiedExternalParticipants,
        projects: analysis.projects,
        clients: analysis.clients,
      };
      
      // Modify the insert to return the id of the new record
      const { data: insertedTranscript, error: insertError } = await supabase
        .from('transcripts')
        .insert(transcriptData)
        .select('id') // Add this line to get the id
        .single(); // We expect only one row
        
      if (insertError) {
        // If it's a unique constraint violation, it's simply a duplicate
        if (insertError.code === '23505') {
          console.log(`Duplicate transcript detected by database constraint for meeting "${object.topic}"`);
          return;
        }
        console.error('Error inserting transcript:', insertError);
        // If insertion fails, we can't send a delete button
        // Decide if we should still send the summary without the button or just return
        // For now, let's just log the error and proceed without a transcriptId
      } else if (insertedTranscript) {
        console.log(`Transcript saved to database for meeting "${object.topic}" with ID: ${insertedTranscript.id}`);
        // Store the ID for use in the button
        const transcriptId = insertedTranscript.id;

        // For testing: only send to ethan@servant.io and joe@servant.io etc.
        if (!['ethan@servant.io', 'joe@servant.io', 'jake@servant.io', 'arlene@servant.io', 'matt@servant.io'].includes(object.host_email)) {
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
            const fallbackText = `Here's a summary of your call
Meeting Name: ${object.topic || 'Untitled Meeting'}
Time: From ${startTime} to ${endTime}

${summary}

Note: Only you can see this as the meeting host. Please share with the channel for context!`;

            // Send message using blocks including the delete button
            await slack.chat.postMessage({
              channel: slackResponse.user.id,
              text: fallbackText, // Fallback text for notifications
              blocks: [
                {
                  type: 'section',
                  text: {
                    type: 'mrkdwn',
                    text: `*Meeting Summary: ${object.topic || 'Untitled Meeting'}*
*Time:* ${startTime} - ${endTime}

${summary}

_Note: Only you can see this as the meeting host. Please share with the channel for context!_`
                  }
                },
                {
                  type: 'actions',
                  elements: [
                    {
                      type: 'button',
                      text: {
                        type: 'plain_text',
                        text: 'Delete Transcript',
                        emoji: true
                      },
                      style: 'danger', // Make it red to indicate deletion
                      action_id: 'delete_transcript', // Matches the ID handled in interactive.ts
                      value: transcriptId.toString(), // Pass the transcript ID as the value
                      confirm: { // Add a confirmation dialog
                          title: {
                              type: "plain_text",
                              text: "Are you sure?"
                          },
                          text: {
                              type: "mrkdwn",
                              text: "This will permanently delete the transcript and its summary from the database. This action cannot be undone."
                          },
                          confirm: {
                              type: "plain_text",
                              text: "Yes, Delete It"
                          },
                          deny: {
                              type: "plain_text",
                              text: "Cancel"
                          }
                      }
                    }
                  ]
                }
              ]
            });

            console.log(`Summary and delete button sent to ${object.host_email} for transcript ID: ${transcriptId}`);
          } else {
            console.error('Could not find Slack user for email:', object.host_email);
          }
        } catch (error) {
          console.error('Error sending Slack message:', error);
        }
      } else {
         console.log('Transcript inserted but no ID returned, cannot send delete button.');
         // Decide how to handle this case - maybe send summary without button?
         // For now, just log and do nothing else.
      }
    } else {
        // Handle case where meetingId is undefined (e.g., meeting creation failed)
        // We can still send the summary, but without a transcript record or delete button
        console.log(`Meeting ID not found for meeting "${object.topic}", cannot save transcript or send delete button.`);
         // Optionally send the summary without DB interaction or button:
         /*
        // Look up user in Slack by email
        try {
          const slackResponse = await slack.users.lookupByEmail({ email: object.host_email });
          if (slackResponse.ok && slackResponse.user && slackResponse.user.id) {
            const startTime = formatTime(transcriptFile.recording_start);
            const endTime = formatTime(transcriptFile.recording_end);
            await slack.chat.postMessage({
              channel: slackResponse.user.id,
              text: `Here's a summary of your call (not saved):
Meeting Name: ${object.topic || 'Untitled Meeting'}
Time: From ${startTime} to ${endTime}

${summary}`
            });
             console.log(`Summary sent to ${object.host_email} (without saving transcript)`);
          } else {
             console.error('Could not find Slack user for email:', object.host_email);
          }
        } catch (error) {
           console.error('Error sending Slack message (unsaved transcript):', error);
        }
        */
    }
    
  } catch (error) {
    console.error('Error handling transcript:', error);
    throw error;
  }
} 