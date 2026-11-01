-- 飞书分身：会话记录、持久化上下文与 AI 会话洞察。
CREATE TABLE IF NOT EXISTS knowledge_bot_conversations(
  app_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  chat_type TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  last_at INTEGER NOT NULL,
  last_text TEXT NOT NULL DEFAULT '',
  needs_attention INTEGER NOT NULL DEFAULT 0,
  attention_kind TEXT NOT NULL DEFAULT '',
  attention_reason TEXT NOT NULL DEFAULT '',
  attention_at INTEGER,
  paused INTEGER NOT NULL DEFAULT 0,
  patient_id TEXT NOT NULL DEFAULT '',
  patient_name TEXT NOT NULL DEFAULT '',
  follow_up_at INTEGER,
  follow_up_note TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(app_id, chat_id)
);
CREATE INDEX IF NOT EXISTS knowledge_bot_conversations_last ON knowledge_bot_conversations(app_id, last_at);
CREATE TABLE IF NOT EXISTS knowledge_bot_turns(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  message_id TEXT NOT NULL DEFAULT '',
  sender_id TEXT NOT NULL DEFAULT '',
  sender_name TEXT NOT NULL DEFAULT '',
  direction TEXT NOT NULL CHECK(direction IN ('in','out')),
  text TEXT NOT NULL,
  sources TEXT NOT NULL DEFAULT '[]',
  flags TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT '',
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS knowledge_bot_turns_chat ON knowledge_bot_turns(app_id, chat_id, at);
CREATE INDEX IF NOT EXISTS knowledge_bot_turns_at ON knowledge_bot_turns(at);
CREATE TABLE IF NOT EXISTS knowledge_bot_contexts(
  key TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  turns TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS knowledge_bot_insights(
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  chat_id TEXT NOT NULL DEFAULT '',
  range_days INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS knowledge_bot_insights_created ON knowledge_bot_insights(app_id, created_at);
