begin;
create schema requests_app;
revoke all on schema requests_app from public, anon, authenticated;

create table requests_app.tickets (
  number bigint generated always as identity primary key,
  request_key uuid not null unique,
  name text not null check (char_length(name) between 1 and 80),
  subject text not null check (char_length(subject) between 1 and 120),
  description text not null check (char_length(description) between 5 and 2000),
  code_hash text not null unique,
  ip_hash text not null,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null default clock_timestamp() + interval '30 minutes',
  chat_id bigint,
  status text not null default 'draft' check (status in ('draft','new','in_progress','done')),
  check ((chat_id is null) = (status = 'draft'))
);
create index on requests_app.tickets (created_at);
create index on requests_app.tickets (ip_hash, created_at);
create index on requests_app.tickets (chat_id, number desc);
create index on requests_app.tickets (status, number desc);

create table requests_app.updates (
  id bigint primary key,
  chat_id bigint not null,
  created_at timestamptz not null default clock_timestamp(),
  accepted boolean not null default true
);
create index on requests_app.updates (chat_id, created_at) where accepted;

create table requests_app.messages (
  id bigint generated always as identity primary key,
  ticket bigint not null references requests_app.tickets(number),
  update_id bigint not null unique references requests_app.updates(id),
  sender text not null check (sender in ('admin','client')),
  body text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default clock_timestamp()
);
create index on requests_app.messages (ticket, id desc);

create table requests_app.outbox (
  id bigint generated always as identity primary key,
  effect_key text not null unique,
  update_id bigint not null references requests_app.updates(id),
  chat_id bigint not null,
  payload jsonb not null,
  prompt_ticket bigint references requests_app.tickets(number),
  prompt_nonce uuid unique,
  retryable boolean not null default false,
  state text not null default 'pending' check (state in ('pending','processing','sent','failed')),
  attempts integer not null default 0,
  error_code text,
  not_before timestamptz not null default '-infinity',
  lease_token uuid,
  leased_until timestamptz,
  delivered_at timestamptz,
  check ((prompt_ticket is null) = (prompt_nonce is null)),
  check ((state = 'processing' and lease_token is not null and leased_until is not null)
      or (state <> 'processing' and lease_token is null and leased_until is null))
);
create index on requests_app.outbox (id) where state in ('pending','processing');
create index on requests_app.outbox (update_id) where state in ('pending','processing');
create index on requests_app.outbox (id desc) where state = 'failed' and retryable;

create table requests_app.prompts (
  chat_id bigint not null,
  message_id bigint not null,
  ticket bigint not null references requests_app.tickets(number),
  outbox_id bigint not null unique references requests_app.outbox(id),
  used_at timestamptz,
  primary key (chat_id, message_id)
);

alter table requests_app.tickets enable row level security;
alter table requests_app.messages enable row level security;
alter table requests_app.updates enable row level security;
alter table requests_app.outbox enable row level security;
alter table requests_app.prompts enable row level security;
revoke all on all tables in schema requests_app from public, anon, authenticated;
revoke all on all sequences in schema requests_app from public, anon, authenticated;
commit;
