-- Prevent duplicate transcript inserts for the same recording
CREATE UNIQUE INDEX IF NOT EXISTS transcripts_unique_recording_idx
ON transcripts (zoom_meeting_id, zoom_meeting_uuid, recording_start, recording_end);
