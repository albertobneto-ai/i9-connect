-- i9 Connect — Schema
-- Postgres (Heroku)

CREATE TABLE IF NOT EXISTS connect_users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(60) UNIQUE NOT NULL,
  display_name VARCHAR(120) NOT NULL,
  password_hash VARCHAR(200) NOT NULL,
  role VARCHAR(30) DEFAULT 'member',
  status VARCHAR(20) DEFAULT 'offline',
  avatar_color VARCHAR(7) DEFAULT '#555555',
  last_seen TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS connect_channels (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  type VARCHAR(20) DEFAULT 'channel',
  is_private BOOLEAN DEFAULT FALSE,
  created_by INTEGER REFERENCES connect_users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS connect_channel_members (
  channel_id INTEGER REFERENCES connect_channels(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES connect_users(id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (channel_id, user_id)
);

CREATE TABLE IF NOT EXISTS connect_messages (
  id SERIAL PRIMARY KEY,
  channel_id INTEGER REFERENCES connect_channels(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES connect_users(id),
  content TEXT NOT NULL,
  type VARCHAR(20) DEFAULT 'text',
  reply_to INTEGER REFERENCES connect_messages(id),
  edited BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS connect_dm_channels (
  id SERIAL PRIMARY KEY,
  user1_id INTEGER REFERENCES connect_users(id),
  user2_id INTEGER REFERENCES connect_users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user1_id, user2_id)
);

CREATE TABLE IF NOT EXISTS connect_dm_messages (
  id SERIAL PRIMARY KEY,
  dm_channel_id INTEGER REFERENCES connect_dm_channels(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES connect_users(id),
  content TEXT NOT NULL,
  type VARCHAR(20) DEFAULT 'text',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS connect_notifications (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES connect_users(id),
  type VARCHAR(40) NOT NULL,
  title VARCHAR(200),
  content TEXT,
  source VARCHAR(40) DEFAULT 'system',
  read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS connect_calls (
  id SERIAL PRIMARY KEY,
  channel_id INTEGER,
  started_by INTEGER REFERENCES connect_users(id),
  call_type VARCHAR(20) DEFAULT 'audio',
  status VARCHAR(20) DEFAULT 'active',
  started_at TIMESTAMPTZ DEFAULT NOW(),
  ended_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS connect_call_participants (
  call_id INTEGER REFERENCES connect_calls(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES connect_users(id),
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  left_at TIMESTAMPTZ,
  PRIMARY KEY (call_id, user_id)
);

-- Default channels
INSERT INTO connect_channels (name, description, type) VALUES
  ('geral', 'Canal geral do projeto', 'channel'),
  ('arquitetura', 'Discussões de arquitetura Salesforce', 'channel'),
  ('deploys', 'Notificações de deploys e releases', 'channel'),
  ('bot-ia', 'Canal com assistente IA integrado', 'channel')
ON CONFLICT DO NOTHING;
