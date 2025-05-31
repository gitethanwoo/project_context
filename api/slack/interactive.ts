import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { WebClient } from '@slack/web-api';
import crypto from 'crypto';

// Initialize Supabase client
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''; // Use service role key for server-side operations
const supabase: SupabaseClient = createClient(supabaseUrl, supabaseKey);

// Initialize Slack client (optional, for sending ephemeral messages)
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

// Get Slack signing secret from environment variables
const slackSigningSecret = process.env.SLACK_SIGNING_SECRET;

// Function to verify Slack request signature - needs slight adjustment for standard Request
async function verifySlackRequest(request: Request): Promise<{ valid: boolean, bodyText: string }> {
    if (!slackSigningSecret) {
        console.error('SLACK_SIGNING_SECRET is not set.');
        return { valid: false, bodyText: '' };
    }

    // Clone the request to read the body without consuming it for later use
    const requestClone = request.clone();
    const signature = requestClone.headers.get('x-slack-signature');
    const timestamp = requestClone.headers.get('x-slack-request-timestamp');
    const bodyText = await requestClone.text(); // Read body once as text

    if (!signature || !timestamp) {
        console.warn('Missing Slack signature or timestamp headers.');
        return { valid: false, bodyText };
    }

    // Prevent replay attacks
    const fiveMinutesAgo = Math.floor(Date.now() / 1000) - (60 * 5);
    if (parseInt(timestamp, 10) < fiveMinutesAgo) {
        console.warn('Slack request timestamp is too old.');
        return { valid: false, bodyText };
    }

    const sigBasestring = `v0:${timestamp}:${bodyText}`;
    const calculatedSignature = `v0=${crypto
        .createHmac('sha256', slackSigningSecret)
        .update(sigBasestring, 'utf8')
        .digest('hex')}`;

     const valid = crypto.timingSafeEqual(Buffer.from(calculatedSignature, 'utf8'), Buffer.from(signature, 'utf8'));
     if (!valid) {
         console.warn('Slack signature verification failed.');
     }

    return { valid, bodyText };
}

// Use standard Request and Response here
export async function POST(request: Request) {

    // Verify the request signature first
    const { valid: isValidSlackRequest, bodyText } = await verifySlackRequest(request);
     if (!isValidSlackRequest) {
         // Use standard Response
         return new Response(JSON.stringify({ error: 'Invalid Slack signature' }), {
             status: 401,
             headers: { 'Content-Type': 'application/json' }
         });
     }

    try {
        // Need to parse the bodyText which contains the urlencoded form data
        // Use URLSearchParams for standard parsing
        const formData = new URLSearchParams(bodyText);
        const payloadStr = formData.get('payload');

        if (!payloadStr) {
             console.error('No payload found in Slack interactive request');
             return new Response(JSON.stringify({ error: 'Missing payload' }), {
                 status: 400,
                 headers: { 'Content-Type': 'application/json' }
             });
        }

        const payload = JSON.parse(payloadStr);

        // Check if it's a block action event (button click)
        if (payload.type === 'block_actions') {
            const deleteAction = payload.actions?.find((action: any) => action.action_id === 'delete_transcript');

            if (deleteAction) {
                const transcriptId = parseInt(deleteAction.value, 10);
                const userId = payload.user?.id;

                 if (isNaN(transcriptId)) {
                    console.error('Invalid transcript ID received:', deleteAction.value);
                     return new Response(JSON.stringify({ error: 'Invalid transcript ID' }), {
                         status: 400,
                         headers: { 'Content-Type': 'application/json' }
                     });
                 }

                console.log(`Received request to delete transcript ID: ${transcriptId} by user ${userId}`);

                // First, get the meeting topic before deletion for confirmation message
                const { data: transcriptData, error: fetchError } = await supabase
                    .from('transcripts')
                    .select('topic')
                    .eq('id', transcriptId)
                    .single();

                if (fetchError) {
                    console.error(`Error fetching transcript ${transcriptId}:`, fetchError);
                    if (userId && slack) {
                        await slack.chat.postEphemeral({
                            channel: payload.channel.id,
                            user: userId,
                            text: `Sorry, I couldn't find the transcript (ID: ${transcriptId}). It may have already been deleted.`
                        });
                    }
                    return new Response(JSON.stringify({ error: 'Transcript not found' }), {
                        status: 404,
                        headers: { 'Content-Type': 'application/json' }
                    });
                }

                const meetingTopic = transcriptData?.topic || 'Untitled Meeting';

                // Perform deletion in Supabase
                const { error: deleteError } = await supabase
                    .from('transcripts')
                    .delete()
                    .eq('id', transcriptId);

                if (deleteError) {
                    console.error(`Error deleting transcript ${transcriptId}:`, deleteError);
                     if (userId && slack) {
                        await slack.chat.postEphemeral({
                             channel: payload.channel.id,
                             user: userId,
                             text: `Sorry, I couldn't delete the transcript "${meetingTopic}" (ID: ${transcriptId}). Error: ${deleteError.message}`
                        });
                     }
                     return new Response(JSON.stringify({ error: 'Failed to delete transcript' }), {
                         status: 500,
                         headers: { 'Content-Type': 'application/json' }
                     });
                }

                console.log(`Successfully deleted transcript ID: ${transcriptId}`);

                // Send regular confirmation message (visible to everyone)
                 if (userId && slack) {
                    try {
                        await slack.chat.postMessage({
                            channel: payload.channel.id,
                            text: `✅ Meeting transcript "${meetingTopic}" has been successfully deleted from the knowledge base.`,
                            blocks: [
                                {
                                    type: 'section',
                                    text: {
                                        type: 'mrkdwn',
                                        text: `✅ Meeting transcript *"${meetingTopic}"* has been successfully deleted from the knowledge base.`
                                    }
                                }
                            ]
                        });
                        console.log(`Sent deletion confirmation for "${meetingTopic}" to channel ${payload.channel.id}`);
                    } catch (slackError) {
                        console.error('Error sending Slack confirmation:', slackError);
                    }
                 }

                // Respond to Slack immediately with 200 OK
                 return new Response(JSON.stringify({ ok: true }), {
                     status: 200,
                     headers: { 'Content-Type': 'application/json' }
                 });
            }
        }

         console.log('Received unhandled Slack interactive payload type:', payload.type);
         return new Response(JSON.stringify({ message: 'Action received but not handled' }), {
             status: 200, // Still acknowledge receipt
             headers: { 'Content-Type': 'application/json' }
         });

    } catch (error) {
        console.error('Error processing Slack interactive request:', error);
         return new Response(JSON.stringify({ error: 'Internal server error' }), {
             status: 500,
             headers: { 'Content-Type': 'application/json' }
         });
    }
}

// Modify GET handler to use standard Response
export async function GET() {
     return new Response(JSON.stringify({ message: 'Slack Interactive Endpoint is active. Use POST for actions.' }), {
         status: 200,
         headers: { 'Content-Type': 'application/json' }
     });
}
