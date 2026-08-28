CREATE TABLE download_history (
                    id TEXT PRIMARY KEY,
                    url TEXT NOT NULL,
                    title TEXT NOT NULL,
                    platform TEXT NOT NULL,
                    duration INTEGER,
                    thumbnail_url TEXT,
                    uploader TEXT,
                    status TEXT NOT NULL,
                    file_path TEXT,
                    file_size INTEGER,
                    created_at TEXT NOT NULL,
                    started_at TEXT,
                    completed_at TEXT,
                    error_message TEXT
                , output_state TEXT NOT NULL DEFAULT 'pending', output_ready_at TEXT, output_recovery_safe INTEGER NOT NULL DEFAULT 0, output_owner_id TEXT, output_lease_expires_at TEXT);

CREATE TABLE search_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    platform TEXT NOT NULL,
                    query TEXT NOT NULL,
                    searched_at TEXT NOT NULL
                );

CREATE TABLE task_queue (
                    id TEXT PRIMARY KEY,
                    status TEXT NOT NULL,
                    progress REAL NOT NULL DEFAULT 0,
                    downloaded_bytes INTEGER NOT NULL DEFAULT 0,
                    total_bytes INTEGER NOT NULL DEFAULT 0,
                    error_message TEXT NOT NULL DEFAULT '',
                    file_path TEXT NOT NULL DEFAULT '',
                    video_info_json TEXT NOT NULL,
                    options_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                , priority INTEGER NOT NULL DEFAULT 0, error_code TEXT NOT NULL DEFAULT '', queue_order INTEGER NOT NULL DEFAULT 0, group_id TEXT NOT NULL DEFAULT '', group_title TEXT NOT NULL DEFAULT '', playlist_index INTEGER NOT NULL DEFAULT 0);

CREATE TABLE telegram_delivery_queue (
                    id TEXT PRIMARY KEY,
                    task_id TEXT NOT NULL,
                    account_id TEXT NOT NULL,
                    target_chat_id TEXT NOT NULL,
                    target_chat_type TEXT NOT NULL,
                    target_chat_title TEXT NOT NULL DEFAULT '',
                    source_url TEXT NOT NULL DEFAULT '',
                    title TEXT NOT NULL DEFAULT '',
                    file_path TEXT NOT NULL,
                    file_size INTEGER NOT NULL,
                    file_mtime_ns TEXT NOT NULL,
                    media_kind TEXT NOT NULL,
                    status TEXT NOT NULL,
                    attempt_count INTEGER NOT NULL DEFAULT 0,
                    retry_sequence_count INTEGER NOT NULL DEFAULT 0,
                    request_attempt_charged INTEGER NOT NULL DEFAULT 0,
                    fallback_used INTEGER NOT NULL DEFAULT 0,
                    next_attempt_at TEXT,
                    lease_id TEXT,
                    lease_expires_at TEXT,
                    request_started_at TEXT,
                    last_error_code TEXT NOT NULL DEFAULT '',
                    last_error_message TEXT NOT NULL DEFAULT '',
                    telegram_message_id TEXT,
                    segment_manifest_json TEXT,
                    segment_next_index INTEGER NOT NULL DEFAULT 0,
                    segment_message_ids_json TEXT NOT NULL DEFAULT '[]',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    sent_at TEXT
                );

CREATE TABLE telegram_delivery_target_blocks (
                    account_id TEXT NOT NULL,
                    target_chat_id TEXT NOT NULL,
                    error_code TEXT NOT NULL,
                    error_message TEXT NOT NULL DEFAULT '',
                    blocked_at TEXT NOT NULL,
                    PRIMARY KEY(account_id, target_chat_id)
                );

CREATE INDEX idx_telegram_delivery_due ON telegram_delivery_queue(account_id, status, next_attempt_at, created_at);

CREATE UNIQUE INDEX uq_telegram_delivery_task ON telegram_delivery_queue(task_id);
