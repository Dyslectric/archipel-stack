-- A direct conversation its reader closed: it leaves their sidebar until something newer than
-- seq is said in it, or they reopen it. The messages stay.
CREATE TABLE closed_conversations (
  user_id TEXT NOT NULL REFERENCES users(id),
  peer TEXT NOT NULL,
  seq INTEGER NOT NULL,  -- the conversation's last message when it was closed
  PRIMARY KEY(user_id, peer)
);
PRAGMA user_version=19;
