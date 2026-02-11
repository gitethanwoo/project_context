import { supabase } from '../../lib/supabase';
import { client as slack, isValidSlackRequest } from '../../lib/slack-utils';

// Use standard Request and Response here
export async function POST(request: Request) {
    const rawBody = await request.clone().text();
    const validRequest = await isValidSlackRequest({ request, rawBody });
     if (!validRequest) {
         // Use standard Response
         return new Response(JSON.stringify({ error: 'Invalid Slack signature' }), {
             status: 401,
             headers: { 'Content-Type': 'application/json' }
         });
     }

    try {
        // Need to parse the raw body text which contains the urlencoded form data
        // Use URLSearchParams for standard parsing
        const formData = new URLSearchParams(rawBody);
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
            const deleteAction = payload.actions?.find((action: { action_id?: string }) => action.action_id === 'delete_transcript');

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
