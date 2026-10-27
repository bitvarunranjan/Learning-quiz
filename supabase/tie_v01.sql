-- Additive TIE v0.1 schema. Apply once through the Supabase migration tool.
-- Public wrappers are invokers; privileged implementations live in a private schema.
create schema tie_private;
revoke all on schema tie_private from public, anon, authenticated;
grant usage on schema tie_private to authenticated;

create table tie_private.lessons (
  id text primary key check (length(id) between 1 and 100),
  question_id uuid references public.questions(id),
  title text not null check (length(title) between 1 and 200),
  prompt text not null check (length(prompt) between 1 and 4000),
  answers text[] not null check (cardinality(answers) between 1 and 20),
  hint text not null check (length(hint) between 1 and 4000),
  explanation text not null check (length(explanation) between 1 and 4000),
  remediation text not null check (length(remediation) between 1 and 4000),
  approved boolean not null default false
);
create index tie_lessons_question_idx on tie_private.lessons(question_id);
alter table tie_private.lessons enable row level security;
create table tie_private.sessions (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  lesson_id text not null references tie_private.lessons(id),
  snapshot jsonb not null,
  attempts integer not null default 0,
  pending_correct boolean not null default false,
  mastered boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index tie_sessions_owner_idx on tie_private.sessions(user_id, created_at desc);
create index tie_sessions_lesson_idx on tie_private.sessions(lesson_id);
alter table tie_private.sessions enable row level security;
create table tie_private.requests (
  session_id uuid not null references tie_private.sessions(id) on delete cascade,
  request_id uuid not null,
  response_hash text not null,
  decision jsonb not null,
  primary key(session_id, request_id)
);
alter table tie_private.requests enable row level security;
-- Intentional default deny: clients cannot directly read or write these tables.
revoke all on all tables in schema tie_private from public, anon, authenticated;

create function tie_private.norm(value text) returns text
language sql immutable strict set search_path = '' as $$
  select btrim(regexp_replace(lower(normalize(value, NFKC)), '[[:space:]]+', ' ', 'g'));
$$;

create function tie_private.safe_message(message text, answers jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
declare answer text; needle text; haystack text; pos integer; offset_pos integer;
begin
  haystack := tie_private.norm(message);
  for answer in select jsonb_array_elements_text(answers) loop
    needle := tie_private.norm(answer);
    if needle is null or needle = '' then return false; end if;
    offset_pos := 1;
    loop
      pos := strpos(substr(haystack, offset_pos), needle);
      exit when pos = 0;
      pos := pos + offset_pos - 1;
      if (pos = 1 or substr(haystack, pos-1, 1) !~ '[[:alnum:]_]')
         and (pos+length(needle) > length(haystack)
              or substr(haystack, pos+length(needle), 1) !~ '[[:alnum:]_]') then
        return false;
      end if;
      offset_pos := pos + 1;
    end loop;
  end loop;
  return true;
end;
$$;

create function tie_private.decision(action text, message text, reason text,
  attempts integer, mastered boolean, answers jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select case when tie_private.safe_message(message, answers) then
    jsonb_build_object('action', action, 'message', message, 'reason', reason,
                       'attempt_count', attempts, 'mastered', mastered)
  else jsonb_build_object('action', 'blocked', 'message', '',
    'reason', 'answer_key_overlap', 'attempt_count', attempts, 'mastered', false) end;
$$;

create function tie_private.list_lessons() returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'title', l.title) order by l.id)
    from tie_private.lessons l where l.approved
    and (l.question_id is null or exists(select 1 from public.questions q where q.id=l.question_id and q.status in ('approved','published')))
    and tie_private.safe_message(l.title, to_jsonb(l.answers))
    and tie_private.safe_message(l.prompt, to_jsonb(l.answers))), '[]'::jsonb);
end;
$$;

create function tie_private.start_session(p_session_id uuid, p_lesson_id text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare l tie_private.lessons; s tie_private.sessions; d jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if p_session_id is null or p_lesson_id is null or length(p_lesson_id) not between 1 and 100 then
    raise exception 'Invalid session or lesson' using errcode='22023';
  end if;
  -- Serializes starts for this learner, including retries and quota checks.
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text, 0));
  select * into s from tie_private.sessions where id=p_session_id;
  if found then
    if s.user_id <> auth.uid() or s.lesson_id <> p_lesson_id then
      raise exception 'Session unavailable' using errcode='42501';
    end if;
    -- Reopening never resets progress; use get_session for the latest decision.
    return tie_private.get_session(p_session_id);
  end if;
  select * into l from tie_private.lessons where id=p_lesson_id and approved
    and (question_id is null or exists(select 1 from public.questions q where q.id=question_id and q.status in ('approved','published')));
  if not found then raise exception 'Lesson unavailable' using errcode='22023'; end if;
  if (select count(*) from tie_private.sessions where user_id=auth.uid()) >= 100 then
    raise exception 'Session limit reached' using errcode='54000'; end if;
  d := tie_private.decision('diagnose', l.prompt, 'initial_diagnosis', 0, false, to_jsonb(l.answers));
  if d->>'action' = 'blocked' then return jsonb_build_object('session_id', null, 'decision', d); end if;
  insert into tie_private.sessions(id, user_id, lesson_id, snapshot)
    values (p_session_id, auth.uid(), l.id, to_jsonb(l));
  return jsonb_build_object('session_id', p_session_id, 'decision', d);
end;
$$;

create function tie_private.get_session(p_session_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s tie_private.sessions; d jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  select * into s from tie_private.sessions where id=p_session_id and user_id=auth.uid();
  if not found then raise exception 'Session unavailable' using errcode='42501'; end if;
  if not exists(select 1 from tie_private.lessons l where l.id=s.lesson_id and l.approved
    and (l.question_id is null or exists(select 1 from public.questions q where q.id=l.question_id and q.status in ('approved','published')))) then
    raise exception 'Lesson unavailable' using errcode='22023'; end if;
  d := coalesce(s.snapshot->'latest_decision', tie_private.decision('diagnose', s.snapshot->>'prompt',
      'initial_diagnosis', 0, false, s.snapshot->'answers'));
  return jsonb_build_object('session_id', s.id, 'lesson_id', s.lesson_id,
    'prompt', s.snapshot->>'prompt', 'decision', d);
end;
$$;

create function tie_private.submit_response(p_session_id uuid, p_response text, p_request_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s tie_private.sessions; old tie_private.requests; normalized_response text; correct boolean;
  action text; message text; reason text; d jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if p_response is null or length(p_response)>4000 or p_request_id is null then
    raise exception 'Invalid response or request ID' using errcode='22023'; end if;
  select * into s from tie_private.sessions where id=p_session_id and user_id=auth.uid() for update;
  if not found then raise exception 'Session unavailable' using errcode='42501'; end if;
  if not exists(select 1 from tie_private.lessons l where l.id=s.lesson_id and l.approved
    and (l.question_id is null or exists(select 1 from public.questions q where q.id=l.question_id and q.status in ('approved','published')))) then
    raise exception 'Lesson unavailable' using errcode='22023'; end if;
  select * into old from tie_private.requests where session_id=s.id and request_id=p_request_id;
  if found then
    if old.response_hash <> encode(sha256(convert_to(p_response, 'UTF8')), 'hex') then raise exception 'Request ID conflict' using errcode='22023'; end if;
    return old.decision;
  end if;
  if (select count(*) from tie_private.requests where session_id=s.id) >= 200 then
    raise exception 'Response limit reached' using errcode='54000'; end if;
  normalized_response := tie_private.norm(p_response);
  if s.mastered then
    action := 'verification'; message := 'Practice complete.'; reason := 'already_mastered';
  elsif normalized_response = '' then
    action := 'diagnose'; message := 'Try a response, or describe where you are stuck.'; reason := 'empty_response';
  elsif normalized_response ~ '\m(ignore|disregard|override)\M.*\m(instructions|rules|policy)\M|\m(answer[ -]?key|system prompt|reveal the answer)\M' then
    action := 'blocked'; message := 'Please respond to the learning task.'; reason := 'instruction_override';
  else
    s.attempts := s.attempts + 1;
    select exists(select 1 from jsonb_array_elements_text(s.snapshot->'answers') a
      where tie_private.norm(a)=normalized_response) into correct;
    if correct then
      s.mastered := s.pending_correct; s.pending_correct := true;
      action := 'verification';
      message := case when s.mastered then 'Practice complete.' else 'Check your reasoning, then submit your response once more.' end;
      reason := case when s.mastered then 'confirmed_response' else 'verification_required' end;
    else
      s.pending_correct := false;
      if s.attempts=1 then action:='socratic_hint'; message:=s.snapshot->>'hint'; reason:='first_error';
      elsif s.attempts=2 then action:='explanation'; message:=s.snapshot->>'explanation'; reason:='repeated_error';
      else action:='remediation'; message:=s.snapshot->>'remediation'; reason:='prerequisite_practice'; end if;
    end if;
  end if;
  d := tie_private.decision(action, message, reason, s.attempts, s.mastered, s.snapshot->'answers');
  if d->>'reason' = 'answer_key_overlap' then
    s.pending_correct := false; s.mastered := false;
  end if;
  update tie_private.sessions set attempts=s.attempts, pending_correct=s.pending_correct,
    mastered=s.mastered, updated_at=now(), snapshot=jsonb_set(snapshot, '{latest_decision}', d) where id=s.id;
  insert into tie_private.requests values(s.id, p_request_id, encode(sha256(convert_to(p_response, 'UTF8')), 'hex'), d);
  return d;
end;
$$;

create function tie_private.history() returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  return coalesce((select jsonb_agg(to_jsonb(h)) from (
    select s.id as session_id, s.lesson_id, s.attempts as attempt_count, s.mastered, s.updated_at
    from tie_private.sessions s where s.user_id=auth.uid()
    order by s.updated_at desc, s.id limit 20) h), '[]'::jsonb);
end;
$$;
create function public.tie_history() returns jsonb language sql security invoker set search_path='' as $$
  select tie_private.history(); $$;

create function public.tie_lessons() returns jsonb language sql security invoker set search_path='' as $$
  select tie_private.list_lessons(); $$;
create function public.tie_start(p_session_id uuid, p_lesson_id text) returns jsonb language sql security invoker set search_path='' as $$
  select tie_private.start_session(p_session_id, p_lesson_id); $$;
create function public.tie_get(p_session_id uuid) returns jsonb language sql security invoker set search_path='' as $$
  select tie_private.get_session(p_session_id); $$;
create function public.tie_submit(p_session_id uuid, p_response text, p_request_id uuid) returns jsonb language sql security invoker set search_path='' as $$
  select tie_private.submit_response(p_session_id, p_response, p_request_id); $$;

revoke all on all functions in schema tie_private from public, anon, authenticated;
grant execute on function tie_private.list_lessons(), tie_private.start_session(uuid,text),
  tie_private.get_session(uuid), tie_private.submit_response(uuid,text,uuid), tie_private.history() to authenticated;
revoke all on function public.tie_lessons(), public.tie_start(uuid,text), public.tie_get(uuid), public.tie_submit(uuid,text,uuid), public.tie_history() from public, anon, authenticated;
grant execute on function public.tie_lessons(), public.tie_start(uuid,text), public.tie_get(uuid), public.tie_submit(uuid,text,uuid), public.tie_history() to authenticated;

-- Self-contained reviewed sample; no synthetic user, quiz, or attempt rows.
insert into tie_private.lessons(id,title,prompt,answers,hint,explanation,remediation,approved)
values ('addition-demo','Combining groups','What is two plus two?',array['4','four'],
  'Could you count two objects and then two more?',
  'Addition combines groups. Count each item once.',
  'Practice counting a small group of objects aloud.',true);
notify pgrst, 'reload schema';
