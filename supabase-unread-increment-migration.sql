CREATE OR REPLACE FUNCTION increment_unread(p_conversation_id bigint, p_user_id uuid)
RETURNS void
LANGUAGE sql
AS $$
  UPDATE conversations
  SET unread_count = COALESCE(unread_count, 0) + 1
  WHERE id = p_conversation_id AND user_id = p_user_id;
$$;
