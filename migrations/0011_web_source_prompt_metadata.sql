ALTER TABLE line_message_batch_web_sources ADD COLUMN open_graph_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE line_message_batch_web_sources ADD COLUMN original_readable_text_chars INTEGER NOT NULL DEFAULT 0;
ALTER TABLE line_message_batch_web_sources ADD COLUMN extracted_text_length INTEGER NOT NULL DEFAULT 0;
ALTER TABLE line_message_batch_web_sources ADD COLUMN text_reduced INTEGER NOT NULL DEFAULT 0;
