-- PROPOSAL ONLY. Review and back up production D1 before executing.
-- Plants & Pours is correct and is deliberately retained unchanged.
-- The second event was generated from the Sunset Aperitivo flyer plus stale
-- Plants & Pours text. Correct the event to the flyer and detach the stale text.
BEGIN TRANSACTION;

UPDATE events
SET title = 'Sunset Aperitivo',
    event_date = '2026-08-06',
    start_time = NULL, -- fill from a human review of the original flyer if present
    price_thb = NULL,
    venue = 'Tops Food Hall / Tops Wine Cellar, Central Chidlom and Porto de Phuket',
    contact_email = NULL,
    contact_phone = NULL,
    wines_json = '[]',
    wine_regions_json = '[]',
    slug = 'sunset-aperitivo-tops-food-hall-tops-wine-cellar-2026-08-06'
WHERE id = 'line-625543530802577683:line-message-625543530802577683';

DELETE FROM event_assets
WHERE event_id = 'line-625543530802577683:line-message-625543530802577683'
  AND asset_id = 'line-text-625368206211023054';

INSERT INTO event_assets (
  event_id,intake_id,asset_id,asset_role,linked_at,source_type,
  source_message_id,text_content,is_public,r2_object_key,content_type
)
SELECT
  'line-625368218341212331:line-message-625368218341212331',
  'line-text-625368206211023054','line-text-625368206211023054','other',
  '2026-08-01T10:24:20.889Z','line_text','625368206211023054',
  text_content,0,NULL,NULL
FROM line_message_batch_texts
WHERE message_id = '625368206211023054'
ON CONFLICT(event_id,asset_id) DO NOTHING;

UPDATE line_text_contexts
SET linked_event_id = 'line-625368218341212331:line-message-625368218341212331'
WHERE message_id = '625368206211023054'
  AND linked_event_id = 'line-625543530802577683:line-message-625543530802577683';

COMMIT;

-- Post-repair verification (must return the Sunset image only):
SELECT e.id,e.title,e.event_date,e.venue,ea.asset_id,ea.source_type,ea.source_message_id
FROM events e JOIN event_assets ea ON ea.event_id=e.id
WHERE e.id IN (
  'line-625368218341212331:line-message-625368218341212331',
  'line-625543530802577683:line-message-625543530802577683'
)
ORDER BY e.id,ea.asset_id;
