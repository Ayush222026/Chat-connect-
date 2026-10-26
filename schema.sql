-- =====================================================================
-- ConnectChat — Supabase schema (PostgreSQL)
-- Run once in: Supabase Dashboard -> SQL Editor -> New query -> Run.
-- Safe to re-run (idempotent).
-- =====================================================================

-- ---------- TABLES ---------------------------------------------------

create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  username     text not null,
  display_name text not null default '',
  about        text not null default 'Hey there! I am using ConnectChat.',
  last_seen    timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  constraint profiles_username_format check (username ~ '^[a-z0-9_]{3,20}$'),
  constraint profiles_display_name_len check (char_length(display_name) <= 50),
  constraint profiles_about_len check (char_length(about) <= 140)
);
create unique index if not exists profiles_username_key on public.profiles (username);
create index if not exists profiles_username_prefix_idx on public.profiles (username text_pattern_ops);

-- One row per private chat. (user_a < user_b) guarantees one conversation per pair.
create table if not exists public.conversations (
  id         uuid primary key default gen_random_uuid(),
  user_a     uuid not null references public.profiles (id) on delete cascade,
  user_b     uuid not null references public.profiles (id) on delete cascade,
  created_by uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  cleared_a  timestamptz,   -- "delete chat for me": user_a no longer sees messages older than this
  cleared_b  timestamptz,   -- same for user_b
  constraint conversations_ordered check (user_a < user_b),
  constraint conversations_creator check (created_by in (user_a, user_b)),
  constraint conversations_pair_unique unique (user_a, user_b)
);
create index if not exists conversations_user_b_idx on public.conversations (user_b);

create table if not exists public.messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  sender_id       uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  body            text not null,
  created_at      timestamptz not null default now(),
  read_at         timestamptz,
  constraint messages_body_len check (char_length(btrim(body)) between 1 and 4000)
);
create index if not exists messages_conv_created_idx on public.messages (conversation_id, created_at desc);
create index if not exists messages_unread_idx on public.messages (conversation_id) where read_at is null;

-- ---------- HELPER FUNCTIONS (used by RLS policies) -------------------

create or replace function public.is_participant(conv uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.conversations c
    where c.id = conv and auth.uid() in (c.user_a, c.user_b)
  );
$$;

-- A message is visible to a participant if it is newer than their "cleared" time.
create or replace function public.can_see_message(conv uuid, ts timestamptz)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.conversations c
    where c.id = conv and (
      (c.user_a = auth.uid() and (c.cleared_a is null or ts > c.cleared_a)) or
      (c.user_b = auth.uid() and (c.cleared_b is null or ts > c.cleared_b))
    )
  );
$$;

-- ---------- NEW USER -> PROFILE ---------------------------------------

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare uname text;
begin
  uname := lower(coalesce(new.raw_user_meta_data ->> 'username', ''));
  if uname !~ '^[a-z0-9_]{3,20}$' or exists (select 1 from public.profiles where username = uname) then
    uname := 'user_' || substr(replace(new.id::text, '-', ''), 1, 12);
  end if;
  begin
    insert into public.profiles (id, username) values (new.id, uname);
  exception when unique_violation then
    insert into public.profiles (id, username)
    values (new.id, 'user_' || substr(replace(new.id::text, '-', ''), 1, 12));
  end;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- RPC FUNCTIONS (called from the app) -----------------------

-- Usable before login (signup form) to check a username.
create or replace function public.username_available(uname text)
returns boolean language sql stable security definer set search_path = public as $$
  select lower(uname) ~ '^[a-z0-9_]{3,20}$'
     and not exists (select 1 from public.profiles where username = lower(uname));
$$;

-- Creates (or returns the existing) private conversation with another user.
create or replace function public.start_conversation(p_other uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_me uuid := auth.uid(); v_a uuid; v_b uuid; v_id uuid;
begin
  if v_me is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
  if p_other is null or p_other = v_me then raise exception 'Invalid user'; end if;
  if not exists (select 1 from public.profiles where id = p_other) then
    raise exception 'User not found';
  end if;
  if v_me < p_other then v_a := v_me; v_b := p_other; else v_a := p_other; v_b := v_me; end if;
  insert into public.conversations (user_a, user_b, created_by)
  values (v_a, v_b, v_me)
  on conflict (user_a, user_b) do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id from public.conversations where user_a = v_a and user_b = v_b;
  end if;
  return v_id;
end;
$$;

-- Marks the other person's messages in a conversation as read (read receipts).
create or replace function public.mark_read(p_conv uuid)
returns void language sql security definer set search_path = public as $$
  update public.messages
     set read_at = now()
   where conversation_id = p_conv
     and sender_id <> auth.uid()
     and read_at is null
     and public.is_participant(p_conv);
$$;

-- "Delete chat" for the calling user only. The other person keeps their copy.
create or replace function public.delete_conversation_for_me(p_conv uuid)
returns void language sql security definer set search_path = public as $$
  update public.conversations
     set cleared_a = case when user_a = auth.uid() then now() else cleared_a end,
         cleared_b = case when user_b = auth.uid() then now() else cleared_b end
   where id = p_conv and auth.uid() in (user_a, user_b);
$$;

create or replace function public.touch_last_seen()
returns void language sql security definer set search_path = public as $$
  update public.profiles set last_seen = now() where id = auth.uid();
$$;

-- Conversation list: other user, latest visible message, unread count.
-- SECURITY INVOKER, so RLS on messages/conversations still applies.
create or replace function public.get_my_conversations()
returns table (
  conv_id uuid, other_id uuid, other_username text, other_name text,
  other_last_seen timestamptz, last_body text, last_sender uuid,
  last_at timestamptz, last_read_at timestamptz, unread_count integer
)
language sql stable security invoker set search_path = public as $$
  select c.id, p.id, p.username, p.display_name, p.last_seen,
         lm.body, lm.sender_id, coalesce(lm.created_at, c.created_at), lm.read_at,
         coalesce(u.cnt, 0)
    from public.conversations c
    join public.profiles p
      on p.id = case when c.user_a = auth.uid() then c.user_b else c.user_a end
    left join lateral (
      select m.body, m.sender_id, m.created_at, m.read_at
        from public.messages m
       where m.conversation_id = c.id
       order by m.created_at desc limit 1
    ) lm on true
    left join lateral (
      select count(*)::int as cnt
        from public.messages m
       where m.conversation_id = c.id and m.sender_id <> auth.uid() and m.read_at is null
    ) u on true
   where auth.uid() in (c.user_a, c.user_b)
     and (
       lm.created_at is not null
       or (c.created_by = auth.uid()
           and (case when c.user_a = auth.uid() then c.cleared_a else c.cleared_b end) is null)
     )
   order by coalesce(lm.created_at, c.created_at) desc;
$$;

-- ---------- ROW LEVEL SECURITY ----------------------------------------

alter table public.profiles      enable row level security;
alter table public.conversations enable row level security;
alter table public.messages      enable row level security;

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated using (true);

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists conversations_select on public.conversations;
create policy conversations_select on public.conversations
  for select to authenticated using (auth.uid() in (user_a, user_b));
-- No insert/update/delete policies: conversations are only created/changed via the RPCs above.

drop policy if exists messages_select on public.messages;
create policy messages_select on public.messages
  for select to authenticated using (public.can_see_message(conversation_id, created_at));

drop policy if exists messages_insert on public.messages;
create policy messages_insert on public.messages
  for insert to authenticated
  with check (sender_id = auth.uid() and public.is_participant(conversation_id));

drop policy if exists messages_delete_own on public.messages;
create policy messages_delete_own on public.messages
  for delete to authenticated
  using (sender_id = auth.uid() and public.is_participant(conversation_id));
-- No update policy: read receipts go through mark_read(); message text can never be edited.

-- ---------- PRIVILEGES (defense in depth, explicit for all projects) ---

grant usage on schema public to anon, authenticated;

revoke all on public.profiles, public.conversations, public.messages from anon, authenticated;
grant select on public.profiles to authenticated;
grant update (username, display_name, about) on public.profiles to authenticated;
grant select on public.conversations to authenticated;
grant select, insert, delete on public.messages to authenticated;

revoke all on function
  public.is_participant(uuid), public.can_see_message(uuid, timestamptz),
  public.handle_new_user(), public.username_available(text),
  public.start_conversation(uuid), public.mark_read(uuid),
  public.delete_conversation_for_me(uuid), public.touch_last_seen(),
  public.get_my_conversations()
  from public, anon, authenticated;

grant execute on function public.is_participant(uuid)              to authenticated;
grant execute on function public.can_see_message(uuid, timestamptz) to authenticated;
grant execute on function public.start_conversation(uuid)          to authenticated;
grant execute on function public.mark_read(uuid)                   to authenticated;
grant execute on function public.delete_conversation_for_me(uuid)  to authenticated;
grant execute on function public.touch_last_seen()                 to authenticated;
grant execute on function public.get_my_conversations()            to authenticated;
grant execute on function public.username_available(text)          to anon, authenticated;

-- ---------- REALTIME --------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table public.messages;
  end if;
end $$;
