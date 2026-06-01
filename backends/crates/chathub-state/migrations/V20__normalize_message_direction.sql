-- Normalize cached message_direction values using sort_key's source direction segment.
-- sort_key format: {epochMs}:{sourceDirection}:{platformSeq}:{localMessageId}
-- source direction: 1 = sender/outgoing, 2 = customer/incoming, 3 = multi-device sync/outgoing.
UPDATE hub_conversation_messages
SET message_direction = CASE substr(
    sort_key,
    instr(sort_key, ':') + 1,
    instr(substr(sort_key, instr(sort_key, ':') + 1), ':') - 1
)
    WHEN '1' THEN 2
    WHEN '3' THEN 2
    WHEN '2' THEN 1
    ELSE message_direction
END
WHERE instr(sort_key, ':') > 0
  AND instr(substr(sort_key, instr(sort_key, ':') + 1), ':') > 0;
