-- Administrative integration test. All fixtures/content changes roll back.
begin;
set local plpgsql.check_asserts=on;
do $$
declare u uuid:=gen_random_uuid(); educator uuid:=gen_random_uuid(); sid uuid:=gen_random_uuid();
  m1 uuid; m2 uuid; quizid uuid; lesson text; d jsonb; c jsonb; payload jsonb; before_count int; ownqid uuid;
begin
  insert into auth.users(id,aud,role,email) values(u,'authenticated','authenticated',u::text||'@example.invalid'),
    (educator,'authenticated','authenticated',educator::text||'@example.invalid');
  insert into public.profiles(id,role) values(u,'student'),(educator,'teacher') on conflict(id) do update set role=excluded.role;
  select id into strict m1 from public.questions where source_key='builtin:m1';
  select id into strict m2 from public.questions where source_key='builtin:m2';
  select id into strict quizid from public.quizzes where source_key='builtin:q1';
  assert not has_function_privilege('anon','public.tie_catalog()','execute'), 'anonymous catalog';
  assert not has_function_privilege('anon','public.tie_publish_bank(jsonb)','execute'), 'anonymous publisher';
  assert not has_table_privilege('authenticated','public.questions','select') or
    not exists(select 1 from pg_policies where schemaname='public' and tablename='questions' and cmd='SELECT'), 'raw keys remain denied';
  assert not has_table_privilege('authenticated','tie_private.publisher_allowlist','select'), 'publisher configuration private';
  assert not exists(select 1 from tie_private.lessons where question_id is not null and
    (not tie_private.safe_message(hint,to_jsonb(answers)) or not tie_private.safe_message(explanation,to_jsonb(answers))
      or not tie_private.safe_message(remediation,to_jsonb(answers)))), 'curated instructions do not reveal literal keys';
  perform set_config('request.jwt.claims',jsonb_build_object('sub',u,'role','authenticated','user_metadata',jsonb_build_object('role','admin'))::text,true);
  execute 'set local role authenticated';
  c:=public.tie_catalog();
  assert not (c->>'can_publish')::boolean, 'demo/JWT metadata is not publisher permission';
  assert jsonb_array_length(c->'quizzes')=3, 'three practice quizzes';
  assert not exists(select 1 from jsonb_array_elements(c->'quizzes') q where q->>'title'='Mathematics Timed Exam'), 'no exam tutoring';
  assert (select count(*) from jsonb_array_elements(c->'lessons') l where l->>'question_id' is not null)=8, 'eight approved bank lessons';
  d:=public.tie_quiz_questions(quizid);
  assert jsonb_array_length(d)=5 and d->0->>'question_id'=m1::text and d->1->>'question_id'=m2::text, 'published order';
  assert not (d->0 ? 'answers') and not (d->0 ? 'correct_option'), 'catalog redaction';
  lesson:='bank:'||m2::text;
  d:=public.tie_start(sid,lesson);
  assert d->'decision'->>'action'='diagnose' and jsonb_array_length(d->'options')=4, 'equation containing answer numeral is valid stimulus';
  assert not(d ? 'answers') and not(d ? 'snapshot') and not(d ? 'correct_option'), 'start redaction';
  d:=public.tie_submit(sid,'−9',gen_random_uuid()); assert d->>'action'='socratic_hint', 'bank hint';
  d:=public.tie_submit(sid,'0',gen_random_uuid()); assert d->>'reason'='verification_required', 'bank verification';
  d:=public.tie_submit(sid,'0',gen_random_uuid()); assert (d->>'mastered')::boolean, 'bank completion';
  d:=public.tie_get(sid); assert jsonb_array_length(d->'options')=4 and (d->'decision'->>'mastered')::boolean, 'bank resume';
  begin perform public.tie_publish_bank('{"questions":[],"quizzes":[]}'); raise exception 'Student published';
    exception when insufficient_privilege then null; end;
  execute 'reset role';
  update public.quizzes set status='draft' where id=quizid;
  execute 'set local role authenticated';
  begin perform public.tie_quiz_questions(quizid); raise exception 'Draft quiz served'; exception when invalid_parameter_value then null; end;
  execute 'reset role'; update public.quizzes set status='published' where id=quizid;
  update public.questions set status='draft' where id=m2;
  execute 'set local role authenticated';
  assert not exists(select 1 from jsonb_array_elements(public.tie_catalog()->'quizzes') q where q->>'id'=quizid::text), 'incomplete quiz hidden';
  begin perform public.tie_get(sid); raise exception 'Withdrawn question resumed'; exception when invalid_parameter_value then null; end;
  execute 'reset role'; update public.questions set status='approved',prompt=prompt||' Revised.' where id=m2;
  execute 'set local role authenticated';
  begin perform public.tie_submit(sid,'0',gen_random_uuid()); raise exception 'Stale grading'; exception when invalid_parameter_value then null; end;
  execute 'reset role'; update public.questions set prompt=replace(prompt,' Revised.','') where id=m2;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',educator,'role','authenticated')::text,true);
  execute 'set local role authenticated';
  assert public.tie_history()='[]'::jsonb, 'other learner history private';
  begin perform public.tie_get(sid); raise exception 'Other learner resumed'; exception when insufficient_privilege then null; end;
  assert (public.tie_catalog()->>'can_publish')::boolean, 'trusted educator allowed';
  payload:='{"questions":[{"id":"test-color","stem":"Choose the usual sky color.","options":["red","green","blue","white"],"correct":2,"explanation":"The usual sky color is blue.","subject":"Science","topic":"Light","difficulty":"easy","pathway":"school","status":"approved"}],"quizzes":[{"id":"test-quiz","title":"Color practice","mode":"practice","published":true,"questionIds":["test-color"]}]}';
  d:=public.tie_publish_bank(payload); assert d->>'questions'='1' and d->>'quizzes'='1', 'educator import';
  d:=public.tie_publish_bank(payload); assert d->>'questions'='1', 'idempotent reimport';
  execute 'reset role';
  assert (select count(*) from public.questions where author_id=educator)=1, 'no duplicate questions';
  assert (select count(*) from public.quizzes where author_id=educator)=1, 'no duplicate quizzes';
  select id into strict ownqid from public.questions where author_id=educator;
  execute 'set local role authenticated';
  -- An invalid late quiz rolls back the preceding new question insert as well.
  begin perform public.tie_publish_bank(jsonb_set(jsonb_set(payload,'{questions,0,id}','"rollback-question"'),'{quizzes,0,questionIds}','["missing"]'));
    raise exception 'Dangling quiz accepted'; exception when invalid_parameter_value then null; end;
  begin perform public.tie_publish_bank(null); raise exception 'Null payload accepted'; exception when invalid_parameter_value then null; end;
  begin perform public.tie_publish_bank(jsonb_set(payload,'{questions,0,status}','"pending"')); raise exception 'Pending question accepted'; exception when invalid_parameter_value then null; end;
  begin perform public.tie_publish_bank(jsonb_set(payload,'{questions,0,correct}','8')); raise exception 'Bad key accepted'; exception when invalid_parameter_value then null; end;
  begin perform public.tie_publish_bank(jsonb_set(payload,'{questions,0,options}','["blue","BLUE"]')); raise exception 'Duplicate options accepted'; exception when invalid_parameter_value then null; end;
  execute 'reset role';
  assert not exists(select 1 from public.questions where source_key='publisher:'||educator::text||':rollback-question'), 'atomic package rollback';
end;
$$;
select 'PASS: connected bank, publication controls, redaction, revisions and educator import' as verification;
rollback;
