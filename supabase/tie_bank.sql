-- Apply after tie_v01.sql. Existing answer-key tables stay default-deny.
alter table public.questions alter column author_id drop not null;
alter table public.quizzes alter column author_id drop not null;
alter table public.questions add column source_key text unique;
alter table public.quizzes add column source_key text unique;
create index if not exists quiz_questions_question_idx on public.quiz_questions(question_id);
alter table tie_private.lessons add column stimulus_options jsonb not null default '[]';
alter table tie_private.lessons add column source_fingerprint text;
create table tie_private.publisher_allowlist(email text primary key check(email=lower(email)));
alter table tie_private.publisher_allowlist enable row level security;
revoke all on tie_private.publisher_allowlist from public, anon, authenticated;

create function tie_private.question_fingerprint(p_id uuid) returns text
language sql stable set search_path='' as $$
  select encode(sha256(convert_to(jsonb_build_array(q.prompt,q.options,q.correct_option,q.status)::text,'UTF8')),'hex')
  from public.questions q where q.id=p_id;
$$;
create function tie_private.lesson_available(p_id text, p_snapshot jsonb default null) returns boolean
language sql stable set search_path='' as $$
  select exists(select 1 from tie_private.lessons l where l.id=p_id and l.approved
    and (l.question_id is null or exists(select 1 from public.questions q
      where q.id=l.question_id and q.status in ('approved','published')
      and l.source_fingerprint=tie_private.question_fingerprint(q.id)))
    and (p_snapshot is null or p_snapshot->>'source_fingerprint' is not distinct from l.source_fingerprint));
$$;
create function tie_private.can_publish() returns boolean
language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  return exists(select 1 from public.profiles p where p.id=auth.uid() and p.role in ('teacher','admin'))
    or exists(select 1 from auth.users u join tie_private.publisher_allowlist a on a.email=lower(u.email)
      where u.id=auth.uid() and u.email_confirmed_at is not null);
end;
$$;
create function tie_private.list_quizzes() returns jsonb
language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  return coalesce((select jsonb_agg(to_jsonb(x) order by x.title,x.id) from (
    select q.id,q.title,count(*)::int as question_count
    from public.quizzes q join public.quiz_questions qq on qq.quiz_id=q.id
    join tie_private.lessons l on l.question_id=qq.question_id
    where q.status='published' and q.mode='practice' and tie_private.lesson_available(l.id)
    group by q.id,q.title
    having count(*)=(select count(*) from public.quiz_questions allq where allq.quiz_id=q.id))x),'[]'::jsonb);
end;
$$;
create function tie_private.quiz_questions(p_quiz_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if not exists(select 1 from jsonb_array_elements(tie_private.list_quizzes()) q where q->>'id'=p_quiz_id::text) then
    raise exception 'Published practice quiz unavailable' using errcode='22023'; end if;
  return (select jsonb_agg(jsonb_build_object('id',l.id,'title',l.title,'question_id',l.question_id,
    'subject',q.subject,'topic',q.topic,'position',qq.position) order by qq.position,q.id)
    from public.quiz_questions qq join public.questions q on q.id=qq.question_id
    join tie_private.lessons l on l.question_id=q.id where qq.quiz_id=p_quiz_id and tie_private.lesson_available(l.id));
end;
$$;

create function tie_private.publish_bank(p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare item jsonb; quiz jsonb; instruction jsonb; qid uuid; quizid uuid; key text;
  idx integer; option_count integer; source_id text; member text; member_id uuid; position_idx integer;
  question_map jsonb := '{}'; ids text[] := '{}'; quiz_ids text[] := '{}'; published_count integer := 0;
  hint text; explanation text; remediation text; pathway text; difficulty integer;
begin
  if auth.uid() is null or not tie_private.can_publish() then
    raise exception 'An approved educator account is required to publish' using errcode='42501'; end if;
  if jsonb_typeof(p_payload) is distinct from 'object' or octet_length(p_payload::text)>1000000
    or jsonb_typeof(p_payload->'questions') is distinct from 'array' or jsonb_array_length(p_payload->'questions') not between 1 and 200
    or jsonb_typeof(p_payload->'quizzes') is distinct from 'array' or jsonb_array_length(p_payload->'quizzes')>50 then
    raise exception 'Invalid content package' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('publish:'||auth.uid()::text,0));
  insert into public.profiles(id,display_name) values(auth.uid(),'') on conflict(id) do nothing;
  for item in select * from jsonb_array_elements(p_payload->'questions') loop
    source_id := item->>'id';
    if source_id is null or length(btrim(source_id)) not between 1 and 100 or source_id=any(ids)
      or item->>'status' is distinct from 'approved'
      or jsonb_typeof(item->'stem') is distinct from 'string' or length(btrim(item->>'stem')) not between 1 and 4000
      or jsonb_typeof(item->'subject') is distinct from 'string' or length(btrim(item->>'subject')) not between 1 and 100
      or jsonb_typeof(item->'topic') is distinct from 'string' or length(btrim(item->>'topic')) not between 1 and 200
      or jsonb_typeof(item->'options') is distinct from 'array'
      or jsonb_typeof(item->'correct') is distinct from 'number' or (item->>'correct')!~'^[0-9]+$' then
      raise exception 'Invalid approved question' using errcode='22023'; end if;
    ids := array_append(ids,source_id);
    option_count := jsonb_array_length(item->'options'); idx := (item->>'correct')::int;
    if option_count not between 2 and 8 or idx<0 or idx>=option_count
      or exists(select 1 from jsonb_array_elements(item->'options') o
        where jsonb_typeof(o)<>'string' or length(btrim(o#>>'{}')) not between 1 and 1000)
      or (select count(distinct tie_private.norm(o#>>'{}')) from jsonb_array_elements(item->'options') o)<>option_count then
      raise exception 'Invalid or duplicate options' using errcode='22023'; end if;
    pathway := case item->>'pathway' when 'school' then 'school' when 'exam' then 'competitive'
      when 'competitive' then 'competitive' when 'skill' then 'skills' when 'skills' then 'skills' else null end;
    difficulty := case item->>'difficulty' when 'easy' then 1 when 'medium' then 3 when 'hard' then 5 else null end;
    if pathway is null or difficulty is null then raise exception 'Invalid pathway or difficulty' using errcode='22023'; end if;
    -- Reuse unchanged shipped content; a publisher cannot overwrite system rows through a forged ID.
    select id into qid from public.questions where source_key='builtin:'||source_id
      and prompt=item->>'stem' and options=item->'options' and correct_option=idx
      and subject=item->>'subject' and topic=item->>'topic' and status in ('approved','published');
    if not found then
      instruction := coalesce(item->'tutor','{}');
      hint := coalesce(instruction->>'hint','What information is given, and which option agrees with it?');
      explanation := coalesce(instruction->>'explanation','Work through the relevant definition or rule, then compare each option against the given conditions.');
      remediation := coalesce(instruction->>'remediation','Review the prerequisite concept, try a simpler example, then return to this question.');
      if length(btrim(hint)) not between 1 and 4000 or length(btrim(explanation)) not between 1 and 4000
        or length(btrim(remediation)) not between 1 and 4000
        or not tie_private.safe_message(hint,jsonb_build_array(item->'options'->>idx))
        or not tie_private.safe_message(explanation,jsonb_build_array(item->'options'->>idx))
        or not tie_private.safe_message(remediation,jsonb_build_array(item->'options'->>idx)) then
        raise exception 'Tutor instructions require answer-free reviewed text' using errcode='22023'; end if;
      key := 'publisher:'||auth.uid()::text||':'||source_id;
      insert into public.questions(author_id,source_key,pathway,subject,topic,difficulty,prompt,options,correct_option,explanation,status)
        values(auth.uid(),key,pathway,item->>'subject',item->>'topic',difficulty,item->>'stem',item->'options',idx,coalesce(item->>'explanation',''),'approved')
        on conflict(source_key) do update set pathway=excluded.pathway,subject=excluded.subject,topic=excluded.topic,
          difficulty=excluded.difficulty,prompt=excluded.prompt,options=excluded.options,correct_option=excluded.correct_option,
          explanation=excluded.explanation,status='approved' returning id into qid;
      insert into tie_private.lessons(id,question_id,title,prompt,answers,hint,explanation,remediation,approved,stimulus_options,source_fingerprint)
        values('bank:'||qid::text,qid,left(item->>'subject',100)||' · '||left(source_id,90),item->>'stem',array[item->'options'->>idx],
          hint,explanation,remediation,true,item->'options',tie_private.question_fingerprint(qid))
        on conflict(id) do update set title=excluded.title,prompt=excluded.prompt,answers=excluded.answers,hint=excluded.hint,
          explanation=excluded.explanation,remediation=excluded.remediation,approved=true,stimulus_options=excluded.stimulus_options,
          source_fingerprint=excluded.source_fingerprint;
    end if;
    question_map := question_map||jsonb_build_object(source_id,qid);
  end loop;
  for quiz in select * from jsonb_array_elements(p_payload->'quizzes') loop
    if quiz->'published' is distinct from 'true'::jsonb then continue; end if;
    source_id := quiz->>'id';
    if source_id is null or length(btrim(source_id)) not between 1 and 100 or source_id=any(quiz_ids)
      or jsonb_typeof(quiz->'title') is distinct from 'string' or length(btrim(quiz->>'title')) not between 1 and 200
      or coalesce(quiz->>'mode','') not in ('practice','exam') or jsonb_typeof(quiz->'questionIds') is distinct from 'array'
      or jsonb_array_length(quiz->'questionIds') not between 1 and 200 then
      raise exception 'Invalid published quiz' using errcode='22023'; end if;
    quiz_ids:=array_append(quiz_ids,source_id);
    if quiz->>'mode'='exam' and (jsonb_typeof(quiz->'duration') is distinct from 'number'
      or (quiz->>'duration')!~'^[0-9]+$' or (quiz->>'duration')::int<1) then
      raise exception 'Invalid exam duration' using errcode='22023'; end if;
    if exists(select 1 from jsonb_array_elements_text(quiz->'questionIds') m where not question_map ? m)
      or (select count(distinct m) from jsonb_array_elements_text(quiz->'questionIds') m)<>jsonb_array_length(quiz->'questionIds') then
      raise exception 'Quiz must reference distinct approved questions in this package' using errcode='22023'; end if;
    -- Unchanged built-in quizzes are reused; custom changes are owned by the publisher.
    select q.id into quizid from public.quizzes q where q.source_key='builtin:'||source_id and q.title=quiz->>'title'
      and q.mode=quiz->>'mode' and q.status='published'
      and (select jsonb_agg(qq.question_id::text order by qq.position) from public.quiz_questions qq where qq.quiz_id=q.id)=
        (select jsonb_agg(question_map->>m order by ord) from jsonb_array_elements_text(quiz->'questionIds') with ordinality t(m,ord));
    if not found then
      key:='publisher:'||auth.uid()::text||':'||source_id;
      insert into public.quizzes(author_id,source_key,title,mode,time_limit_seconds,status)
        values(auth.uid(),key,quiz->>'title',quiz->>'mode',case when quiz->>'mode'='exam' then (quiz->>'duration')::int else null end,'published')
        on conflict(source_key) do update set title=excluded.title,mode=excluded.mode,time_limit_seconds=excluded.time_limit_seconds,status='published'
        returning id into quizid;
      delete from public.quiz_questions where quiz_id=quizid;
      position_idx:=0;
      for member in select * from jsonb_array_elements_text(quiz->'questionIds') loop
        position_idx:=position_idx+1; member_id:=(question_map->>member)::uuid;
        insert into public.quiz_questions values(quizid,member_id,position_idx);
      end loop;
    end if;
    published_count:=published_count+1;
  end loop;
  return jsonb_build_object('questions',cardinality(ids),'quizzes',published_count);
end;
$$;

create unique index tie_lessons_question_unique on tie_private.lessons(question_id) where question_id is not null;
create or replace function tie_private.list_lessons() returns jsonb
language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id',l.id,'title',l.title,'question_id',l.question_id,
    'subject',q.subject,'topic',q.topic) order by q.subject nulls last,l.id)
    from tie_private.lessons l left join public.questions q on q.id=l.question_id
    where tie_private.lesson_available(l.id) and tie_private.safe_message(l.title,to_jsonb(l.answers))
    and (jsonb_array_length(l.stimulus_options)>0 or tie_private.safe_message(l.prompt,to_jsonb(l.answers)))),'[]'::jsonb);
end;
$$;

create or replace function tie_private.start_session(p_session_id uuid, p_lesson_id text) returns jsonb
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
  select * into l from tie_private.lessons where id=p_lesson_id and tie_private.lesson_available(id);
  if not found then raise exception 'Lesson unavailable' using errcode='22023'; end if;
  if (select count(*) from tie_private.sessions where user_id=auth.uid()) >= 100 then
    raise exception 'Session limit reached' using errcode='54000'; end if;
  d := tie_private.decision('diagnose', case when jsonb_array_length(l.stimulus_options)>0 then 'Choose an option. What reasoning supports it?' else l.prompt end, 'initial_diagnosis', 0, false, to_jsonb(l.answers));
  if d->>'action' = 'blocked' then return jsonb_build_object('session_id', null, 'decision', d); end if;
  insert into tie_private.sessions(id, user_id, lesson_id, snapshot)
    values (p_session_id, auth.uid(), l.id, to_jsonb(l));
  return tie_private.get_session(p_session_id);
end;
$$;

create or replace function tie_private.get_session(p_session_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s tie_private.sessions; d jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  select * into s from tie_private.sessions where id=p_session_id and user_id=auth.uid();
  if not found then raise exception 'Session unavailable' using errcode='42501'; end if;
  if not tie_private.lesson_available(s.lesson_id,s.snapshot) then
    raise exception 'Lesson unavailable or revised; start a new session' using errcode='22023'; end if;
  d := coalesce(s.snapshot->'latest_decision', tie_private.decision('diagnose', case when jsonb_array_length(coalesce(s.snapshot->'stimulus_options','[]'))>0 then 'Choose an option. What reasoning supports it?' else s.snapshot->>'prompt' end,
      'initial_diagnosis', 0, false, s.snapshot->'answers'));
  return jsonb_build_object('session_id', s.id, 'lesson_id', s.lesson_id,
    'prompt', s.snapshot->>'prompt', 'options',coalesce(s.snapshot->'stimulus_options','[]'), 'decision', d);
end;
$$;

create or replace function tie_private.submit_response(p_session_id uuid, p_response text, p_request_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s tie_private.sessions; old tie_private.requests; normalized_response text; correct boolean;
  action text; message text; reason text; d jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if p_response is null or length(p_response)>4000 or p_request_id is null then
    raise exception 'Invalid response or request ID' using errcode='22023'; end if;
  select * into s from tie_private.sessions where id=p_session_id and user_id=auth.uid() for update;
  if not found then raise exception 'Session unavailable' using errcode='42501'; end if;
  if not tie_private.lesson_available(s.lesson_id,s.snapshot) then
    raise exception 'Lesson unavailable or revised; start a new session' using errcode='22023'; end if;
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
create function public.tie_catalog() returns jsonb language sql security invoker set search_path='' as $$
  select jsonb_build_object('lessons',tie_private.list_lessons(),'quizzes',tie_private.list_quizzes(),'can_publish',tie_private.can_publish()); $$;
create function public.tie_quiz_questions(p_quiz_id uuid) returns jsonb language sql security invoker set search_path='' as $$
  select tie_private.quiz_questions(p_quiz_id); $$;
create function public.tie_publish_bank(p_payload jsonb) returns jsonb language sql security invoker set search_path='' as $$
  select tie_private.publish_bank(p_payload); $$;
revoke all on function tie_private.question_fingerprint(uuid),tie_private.lesson_available(text,jsonb),
  tie_private.can_publish(),tie_private.list_quizzes(),tie_private.quiz_questions(uuid),tie_private.publish_bank(jsonb)
  from public,anon,authenticated;
grant execute on function tie_private.can_publish(),tie_private.list_quizzes(),tie_private.quiz_questions(uuid),tie_private.publish_bank(jsonb) to authenticated;
revoke all on function public.tie_catalog(),public.tie_quiz_questions(uuid),public.tie_publish_bank(jsonb) from public,anon,authenticated;
grant execute on function public.tie_catalog(),public.tie_quiz_questions(uuid),public.tie_publish_bank(jsonb) to authenticated;
notify pgrst,'reload schema';

do $seed$
declare bank jsonb := $content${"questions": [{"id": "m1", "stem": "What are the roots of x² − 5x + 6 = 0?", "options": ["1 and 6", "2 and 3", "−2 and −3", "−1 and −6"], "correct": 1, "explanation": "(x − 2)(x − 3) = 0, so the roots are 2 and 3.", "subject": "Mathematics", "topic": "Quadratic Equations", "difficulty": "easy", "pathway": "school", "status": "approved", "tutor": {"hint": "Which pair has the required product and sum?", "explanation": "For a monic quadratic, compare the sum and product of candidate roots with the coefficients. Both relationships must agree.", "remediation": "Practice multiplying two binomials, then compare their middle and constant terms."}}, {"id": "m2", "stem": "For x² − 9 = 0, the sum of the real roots is:", "options": ["−9", "0", "3", "9"], "correct": 1, "explanation": "The roots are +3 and −3; their sum is 0.", "subject": "Mathematics", "topic": "Quadratic Equations", "difficulty": "easy", "pathway": "school", "status": "approved", "tutor": {"hint": "A difference of squares gives roots with opposite signs. How do opposite quantities combine?", "explanation": "Factoring a difference of squares gives a positive root and its negative counterpart. Combine both roots rather than using just one.", "remediation": "Review additive inverses using equal positive and negative quantities."}}, {"id": "m3", "stem": "The discriminant of 2x² − 4x + 3 = 0 is:", "options": ["−8", "8", "−4", "4"], "correct": 0, "explanation": "b² − 4ac = 16 − 24 = −8.", "subject": "Mathematics", "topic": "Quadratic Equations", "difficulty": "medium", "pathway": "school", "status": "approved", "tutor": {"hint": "Square the middle coefficient, then subtract the product involving the leading and constant coefficients.", "explanation": "The discriminant compares the square of the middle coefficient with four times the product of the other coefficients. Keep track of signs.", "remediation": "Write down each coefficient with its sign before applying the discriminant formula."}}, {"id": "m4", "stem": "If the roots of x² − 7x + k = 0 are 3 and 4, then k is:", "options": ["7", "10", "12", "14"], "correct": 2, "explanation": "The product of roots is k = 3 × 4 = 12.", "subject": "Mathematics", "topic": "Quadratic Equations", "difficulty": "medium", "pathway": "school", "status": "approved", "tutor": {"hint": "Which relationship connects the constant term with the product of the roots?", "explanation": "For a monic quadratic, the constant term equals the product of the roots. Use the given root values to check each candidate.", "remediation": "Expand a pair of linear factors and identify the constant term."}}, {"id": "m5", "stem": "Which equation has exactly one distinct real root?", "options": ["x² + 1 = 0", "x² − 4 = 0", "x² − 2x + 1 = 0", "x² − 5x + 6 = 0"], "correct": 2, "explanation": "(x − 1)² = 0 has a repeated real root.", "subject": "Mathematics", "topic": "Quadratic Equations", "difficulty": "hard", "pathway": "school", "status": "approved", "tutor": {"hint": "Look for an expression that is a perfect square.", "explanation": "A quadratic has one distinct real root when its two linear factors are identical. Compare the structure of each expression.", "remediation": "Review the expansion of a squared binomial and how a repeated factor behaves."}}, {"id": "p1", "stem": "Which House of the Indian Parliament is a continuing chamber?", "options": ["Lok Sabha", "Rajya Sabha", "Both Houses", "Neither House"], "correct": 1, "explanation": "The Rajya Sabha is not subject to dissolution.", "subject": "Indian Polity", "topic": "Parliament", "difficulty": "easy", "pathway": "exam", "status": "approved", "tutor": {"hint": "Which chamber uses staggered retirement rather than dissolving as a whole?", "explanation": "A continuing chamber keeps its institutional existence while a portion of its membership retires periodically. Distinguish that from dissolution.", "remediation": "Review the difference between dissolution of a chamber and retirement of individual members."}}, {"id": "p2", "stem": "A Money Bill can be introduced in:", "options": ["Either House", "Rajya Sabha only", "Lok Sabha only", "A joint sitting"], "correct": 2, "explanation": "A Money Bill can be introduced only in the Lok Sabha.", "subject": "Indian Polity", "topic": "Parliament", "difficulty": "medium", "pathway": "exam", "status": "approved", "tutor": {"hint": "Which chamber has primary responsibility for financial legislation?", "explanation": "Money Bills follow a special introduction procedure giving the directly elected House primacy. Distinguish introduction from later consideration.", "remediation": "Review the constitutional distinction between ordinary legislation and financial legislation."}}, {"id": "s1", "stem": "Which component commonly measures angular velocity in a drone?", "options": ["Gyroscope", "Barometer", "GPS receiver", "Magnetometer"], "correct": 0, "explanation": "A gyroscope measures angular velocity.", "subject": "Drone Technology", "topic": "Flight Control", "difficulty": "easy", "pathway": "skill", "status": "approved", "tutor": {"hint": "Think about a sensor that responds to rotation rather than pressure or position.", "explanation": "Angular velocity describes rotation per unit time. Distinguish rotational sensing from pressure, satellite position and magnetic heading.", "remediation": "Match each sensor category to the physical quantity it measures before choosing."}}], "quizzes": [{"id": "q1", "title": "Quadratic Equations Practice", "pathway": "school", "subject": "Mathematics", "topic": "Quadratic Equations", "mode": "practice", "duration": 0, "questionIds": ["m1", "m2", "m3", "m4", "m5"], "published": true}, {"id": "q2", "title": "Mathematics Timed Exam", "pathway": "school", "subject": "Mathematics", "topic": "Quadratic Equations", "mode": "exam", "duration": 180, "questionIds": ["m1", "m2", "m3", "m4", "m5"], "published": true}, {"id": "q3", "title": "UPSC Polity Practice", "pathway": "exam", "subject": "Indian Polity", "topic": "Parliament", "mode": "practice", "duration": 0, "questionIds": ["p1", "p2"], "published": true}, {"id": "q4", "title": "Drone Skills Practice", "pathway": "skill", "subject": "Drone Technology", "topic": "Flight Control", "mode": "practice", "duration": 0, "questionIds": ["s1"], "published": true}]}$content$::jsonb; item jsonb; quiz jsonb; qid uuid; quizid uuid; member text; n integer;
begin
  for item in select * from jsonb_array_elements(bank->'questions') loop
    insert into public.questions(source_key,author_id,pathway,subject,topic,difficulty,prompt,options,correct_option,explanation,status)
    values('builtin:'||(item->>'id'),null,case item->>'pathway' when 'exam' then 'competitive' when 'skill' then 'skills' else 'school' end,
      item->>'subject',item->>'topic',case item->>'difficulty' when 'easy' then 1 when 'hard' then 5 else 3 end,
      item->>'stem',item->'options',(item->>'correct')::int,item->>'explanation','approved') returning id into qid;
    insert into tie_private.lessons(id,question_id,title,prompt,answers,hint,explanation,remediation,approved,stimulus_options,source_fingerprint)
    values('bank:'||qid::text,qid,(item->>'subject')||' · '||(item->>'id'),item->>'stem',array[item->'options'->>(item->>'correct')::int],
      item->'tutor'->>'hint',item->'tutor'->>'explanation',item->'tutor'->>'remediation',true,item->'options',tie_private.question_fingerprint(qid));
  end loop;
  for quiz in select * from jsonb_array_elements(bank->'quizzes') loop
    insert into public.quizzes(source_key,author_id,title,mode,time_limit_seconds,status)
    values('builtin:'||(quiz->>'id'),null,quiz->>'title',quiz->>'mode',case when quiz->>'mode'='exam' then (quiz->>'duration')::int else null end,'published') returning id into quizid;
    n:=0;
    for member in select * from jsonb_array_elements_text(quiz->'questionIds') loop
      n:=n+1; select id into strict qid from public.questions where source_key='builtin:'||member;
      insert into public.quiz_questions values(quizid,qid,n);
    end loop;
  end loop;
end;
$seed$;
